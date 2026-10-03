#!/usr/bin/env node
/**
 * Formatka faktur (papier firmowy w PDF) dla organizacji — zapis w bazie.
 *
 * Jedno polecenie robi dwie rzeczy, które razem wskazują plik:
 *   1. wiersz `invoice_template` (kod = ident organizacji): `background_file`,
 *      `page_margins`, układ treści (`template_file`/`stylesheet`, domyślnie wspólny),
 *   2. `invoice_organization_profile.template_code` = ten kod.
 * Przed zapisem sprawdza, że plik istnieje w `img/invoice-background/` — literówka
 * nie może cicho przestawić faktur na wydruk bez formatki.
 *
 * Użycie:
 *   node scripts/setInvoiceTemplate.js --list
 *   node scripts/setInvoiceTemplate.js LUXANGMBH --background LUXANGMBH.pdf --margins 24,12,27,12
 *   node scripts/setInvoiceTemplate.js 1 --background COZY.pdf --margins 20,12,22,12 --code COZY
 *   node scripts/setInvoiceTemplate.js LUXANGMBH --default         organizacja wraca do szablonu domyślnego
 *
 *   <ORG>         ident (`organization.ident`, bez rozróżniania wielkości liter) albo id
 *   --margins     góra,prawo,dół,lewo w mm — miejsce na treść między pasami formatki
 *   --code        jawny kod szablonu (domyślnie ident organizacji). Bez niego
 *                 zmiana formatki, gdy obecny kod mają już wystawione faktury,
 *                 tworzy sama nową wersję (`LUXANGMBH_202610021015`) — wystawione
 *                 faktury drukują się dalej na swojej formatce. Jawny `--code`
 *                 istniejącego kodu nadpisuje go także dla nich.
 *   --name        nazwa widoczna w panelu (domyślnie nazwa organizacji)
 *   --template    układ treści względem services/invoices/templates/ (domyślnie invoice-main.njk)
 *   --stylesheet  arkusz względem services/invoices/templates/ (domyślnie styles/invoice.css)
 *
 * ⚠️ Wymaga migracji `services/invoices/db/schema_v3.sql` (kolumny formatki).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const repository = require('../services/invoices/db/repository');
const { assignOrganizationTemplate } = require('../services/invoices/templateAssignment');
const { parsePageMargins } = require('../services/invoices/core/templates');
const { selectQuery, closePool } = require('../db/core');

function parseArgs(argv) {
    const out = { positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--list' || arg === '--default') out[arg.slice(2)] = true;
        else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
        else out.positional.push(arg);
    }
    return out;
}

async function findOrganization(ref) {
    const rows = /^\d+$/.test(ref)
        ? await selectQuery('SELECT id, ident, name FROM organization WHERE id = ?', [Number(ref)])
        : await selectQuery('SELECT id, ident, name FROM organization WHERE UPPER(ident) = UPPER(?)', [ref]);
    return rows && rows[0] ? rows[0] : null;
}

function parseMarginsArg(value) {
    if (value === undefined) return undefined;
    const parts = String(value).split(',').map((v) => Number(v.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
        throw new Error(`--margins: oczekiwane 4 liczby w mm „góra,prawo,dół,lewo", jest „${value}"`);
    }
    const [top, right, bottom, left] = parts;
    const margins = parsePageMargins({ top, right, bottom, left });
    if (margins.top !== top || margins.right !== right || margins.bottom !== bottom || margins.left !== left) {
        throw new Error(`--margins: wartość poza zakresem (0–120 mm): „${value}"`);
    }
    return margins;
}

/** Brak kolumn formatki = migracja nie była uruchomiona — komunikat zamiast surowego błędu SQL. */
function explainDbError(err) {
    if (err && (err.code === 'ER_BAD_FIELD_ERROR' || /Unknown column/.test(err.message))) {
        return 'w bazie nie ma kolumn formatki — uruchom najpierw migrację services/invoices/db/schema_v3.sql';
    }
    return err && err.message ? err.message : String(err);
}

async function list() {
    const rows = await repository.listOrganizationTemplates();
    for (const r of rows) {
        const margins = r.page_margins ? JSON.stringify(typeof r.page_margins === 'string' ? JSON.parse(r.page_margins) : r.page_margins) : '';
        console.log([
            String(r.organization_id).padStart(3),
            String(r.ident).padEnd(20),
            `kod: ${r.template_code}`.padEnd(32),
            r.background_file ? `formatka: ${r.background_file} ${margins}` : 'bez formatki',
            r.code ? '' : '(brak wiersza invoice_template → domyślny)'
        ].join('  '));
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.list) return list();

    const [orgRef] = args.positional;
    if (!orgRef) throw new Error('podaj organizację (ident albo id) albo --list');
    const org = await findOrganization(orgRef);
    if (!org) throw new Error(`nie ma organizacji „${orgRef}"`);
    if (!args.default && !args.background) throw new Error('podaj --background <plik.pdf> albo --default');

    const result = await assignOrganizationTemplate({
        organizationId: org.id,
        backgroundFile: args.default ? null : args.background,
        pageMargins: parseMarginsArg(args.margins),
        templateFile: args.template,
        stylesheet: args.stylesheet,
        code: args.code !== undefined ? String(args.code).trim().toUpperCase() : undefined,
        name: args.name
    });

    if (!result.changed) {
        console.log(`${org.ident}: bez zmian (szablon ${result.code})`);
    } else if (result.code === 'default') {
        console.log(`${org.ident}: szablon domyślny (bez formatki) dla NOWYCH faktur`);
    } else {
        console.log(`${org.ident} (id ${org.id}): szablon ${result.code} → formatka ${args.background}`
            + (result.versioned ? ` — NOWA WERSJA (faktury wystawione na ${result.previousCode} zachowują tamtą formatkę)` : ''));
    }
    console.log('Dotyczy faktur wystawionych od teraz; wystawione mają zapisany swój kod szablonu.');
}

main()
    .then(() => { process.exitCode = 0; })
    .catch((err) => {
        console.error(`BŁĄD: ${explainDbError(err)}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        try { await closePool(); } catch { /* pula mogła już być zamknięta */ }
    });
