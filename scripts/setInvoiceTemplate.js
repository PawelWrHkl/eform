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
 *   --code        kod szablonu (domyślnie ident organizacji). ⚠️ NOWA formatka
 *                 (np. zmienione konto w stopce) = NOWY kod, np. LUXANGMBH_2027:
 *                 wystawione faktury pamiętają swój kod i renderują się dalej
 *                 na starej formatce. Nadpisanie kodu przestawia także je.
 *   --name        nazwa widoczna w panelu (domyślnie nazwa organizacji)
 *   --template    układ treści względem services/invoices/templates/ (domyślnie invoice-main.njk)
 *   --stylesheet  arkusz względem services/invoices/templates/ (domyślnie styles/invoice.css)
 *
 * ⚠️ Wymaga migracji `services/invoices/db/schema_v3.sql` (kolumny formatki).
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const repository = require('../services/invoices/db/repository');
const { BACKGROUNDS_DIR, TEMPLATES_DIR } = require('../services/invoices/render/renderer');
const { DEFAULT_TEMPLATE, normalizeTemplatePath, parsePageMargins } = require('../services/invoices/core/templates');
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
    if (value === undefined) return null;
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

function requireFile(baseDir, value, extension, label) {
    const rel = normalizeTemplatePath(value, extension);
    const abs = rel ? path.resolve(baseDir, rel) : null;
    if (!abs || !abs.startsWith(baseDir + path.sep)) throw new Error(`${label}: niedozwolona nazwa „${value}"`);
    if (!fs.existsSync(abs)) {
        const available = fs.existsSync(baseDir) ? fs.readdirSync(baseDir).filter((f) => f.endsWith(extension)).join(', ') : '—';
        throw new Error(`${label}: brak pliku ${abs} (dostępne: ${available || '—'})`);
    }
    return rel;
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
            `kod: ${r.template_code}`.padEnd(24),
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

    if (args.default) {
        if (!(await repository.upsertOrganizationProfile(org.id, { template_code: DEFAULT_TEMPLATE.code }))) {
            throw new Error('nie udało się zapisać profilu organizacji (szczegóły w logu)');
        }
        console.log(`${org.ident}: szablon domyślny (bez formatki) dla NOWYCH faktur`);
        return;
    }

    if (!args.background) throw new Error('podaj --background <plik.pdf> albo --default');
    const backgroundFile = requireFile(BACKGROUNDS_DIR, args.background, '.pdf', '--background');
    const templateFile = requireFile(TEMPLATES_DIR, args.template || DEFAULT_TEMPLATE.templateFile, '.njk', '--template');
    const stylesheet = requireFile(TEMPLATES_DIR, args.stylesheet || DEFAULT_TEMPLATE.stylesheet, '.css', '--stylesheet');
    const pageMargins = parseMarginsArg(args.margins);
    const code = String(args.code || org.ident).trim().toUpperCase();
    if (!/^[A-Z0-9_\-]{1,60}$/.test(code)) throw new Error(`--code: dozwolone A–Z, 0–9, _ i -, maks. 60 znaków (jest „${code}")`);

    try {
        await repository.upsertTemplate({
            code,
            name: args.name || org.name,
            templateFile,
            stylesheet,
            backgroundFile,
            pageMargins
        });
    } catch (err) {
        throw new Error(explainDbError(err));
    }
    if (!(await repository.upsertOrganizationProfile(org.id, { template_code: code }))) {
        throw new Error('nie udało się zapisać profilu organizacji (szczegóły w logu)');
    }
    console.log(`${org.ident} (id ${org.id}): szablon ${code} → formatka ${backgroundFile}, marginesy ${JSON.stringify(parsePageMargins(pageMargins))} mm`);
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
