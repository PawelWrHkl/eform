'use strict';

/**
 * Numery KSeF faktur HKL z księgowości (Wiktoria, mail 19.11.2026): plik automatu na FTP faktur,
 * `<INVOICE_FTP_DIR>/numery_ksef.tsv` — UTF-8, TAB, CRLF, nagłówek, ZAWSZE cały stan:
 *
 *   LEVEL  INVOICENO  ORGANIZATIONIDENT  INVOICEDATE  KSEFSTATUS  KSEFNUMBER  KSEFDATE  VERIFYURL  REASON
 *
 *   LEVEL, INVOICENO, ORGANIZATIONIDENT, INVOICEDATE — jak w `zafakturowane_pozycje.tsv`;
 *   KSEFSTATUS — ACCEPTED (numer nadany) / REJECTED (KSeF odrzucił; REASON = kod i opis) /
 *                WITHHELD (nie wysłane do KSeF; REASON = powód);
 *   KSEFNUMBER — drukowany pod kodem QR; KSEFDATE — chwila nadania (czas polski ze strefą);
 *   VERIFYURL  — link weryfikacyjny, z którego BEZ ZMIAN robimy kod QR na PDF.
 *   W pliku są tylko faktury HKL: poziom 1 i poziom 2 z ORGANIZATIONIDENT HKL.
 *
 * Stan trzymamy w dzienniku dokumentu (`invoice_event`: `ksef_accepted` / `ksef_rejected` /
 * `ksef_withheld`, w payloadzie numer, data, link, powód) — bez migracji. Nowe zdarzenie tylko przy
 * zmianie stanu; ACCEPTED jest ostateczny (numeru KSeF się nie cofa — inny stan w pliku = ostrzeżenie).
 * Faktura z ACCEPTED jest zablokowana do edycji, przebudowy i anulowania (`repository.getEditBlockers`
 * → `accepted`, wspólnie z e-fakturami live). Wiersz z datą faktury inną niż w eFormie jest pomijany
 * (ten sam numer w innej bazie to inna faktura — np. plik produkcji na bazie testowej).
 *
 * Wysyłka PDF do klienta tylko przy ACCEPTED (brak wiersza = czeka, REJECTED/WITHHELD = nie wysyłaj):
 * `INVOICE_KSEF_MAIL_GATE=true` w `invoiceMailer.js` (domyślnie wyłączone — Wiktoria włączy, gdy plik
 * będzie na FTP). Wczytywanie: `INVOICE_KSEF_ENABLED=true` (domyślnie wyłączone); konto i katalog jak
 * faktur na FTP (`readInvoiceFtpConfig`). Brak pliku = nic się nie dzieje.
 */

const defaultRepository = require('./db/repository');
const { readInvoiceFtpConfig, defaultConnect } = require('./invoiceFtpExport');
const { downloadFile } = require('./invoicePayments');
const { AUTO_ACTOR } = require('./autoInvoicing');
const { log: defaultLog } = require('../../utils/logging');

const KSEF_FILE = 'numery_ksef.tsv';
const KSEF_HEADER = ['LEVEL', 'INVOICENO', 'ORGANIZATIONIDENT', 'INVOICEDATE', 'KSEFSTATUS', 'KSEFNUMBER', 'KSEFDATE', 'VERIFYURL', 'REASON'];
const KsefStatus = Object.freeze({ ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED', WITHHELD: 'WITHHELD' });
/** Zdarzenie dziennika per stan; `ksef_accepted` czyta też blokada edycji (`repository.acceptedSql`). */
const KsefEvent = Object.freeze({ ACCEPTED: 'ksef_accepted', REJECTED: 'ksef_rejected', WITHHELD: 'ksef_withheld' });
const KSEF_EVENTS = Object.freeze(Object.values(KsefEvent));

/**
 * @param {string|Buffer} text zawartość `numery_ksef.tsv`
 * @returns {{ rows: Array<{ level: number, number: string, organization: string, invoiceDate: string, status: string, ksefNumber: string, ksefDate: string, verifyUrl: string, reason: string }>, errors: string[] }}
 */
function parseKsefTsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: [] };
  const head = lines[0].split('\t').map((h) => h.trim().toUpperCase());
  const missing = KSEF_HEADER.filter((h) => !head.includes(h));
  if (missing.length) return { rows: [], errors: [`brak kolumn ${missing.join(', ')} w nagłówku`] };
  const rows = [];
  const errors = [];
  lines.slice(1).forEach((line, i) => {
    const cells = line.split('\t');
    const get = (h) => String(cells[head.indexOf(h)] ?? '').trim();
    const row = {
      level: Number(get('LEVEL')),
      number: get('INVOICENO'),
      organization: get('ORGANIZATIONIDENT').toUpperCase(),
      invoiceDate: get('INVOICEDATE'),
      status: get('KSEFSTATUS').toUpperCase(),
      ksefNumber: get('KSEFNUMBER'),
      ksefDate: get('KSEFDATE'),
      verifyUrl: get('VERIFYURL'),
      reason: get('REASON')
    };
    const bad = !row.number || !Number.isInteger(row.level) || !/^\d{4}-\d{2}-\d{2}$/.test(row.invoiceDate)
      || !KsefStatus[row.status]
      // Numer i link to sens wiersza ACCEPTED — bez nich nie ma czego drukować ani czym blokować
      || (row.status === KsefStatus.ACCEPTED && (!row.ksefNumber || !/^https:\/\/\S+$/.test(row.verifyUrl)));
    if (bad) errors.push(`wiersz ${i + 2}: „${line.trim()}”`);
    else rows.push(row);
  });
  return { rows, errors };
}

/**
 * Co zapisać (czysta funkcja).
 *
 * @param {ReturnType<typeof parseKsefTsv>['rows']} rows
 * @param {Array<{ id: number, number: string, level: number, issue_date: string, organization_ident: string }>} invoices
 * @param {Map<number, { status: string, ksefNumber?: string, reason?: string }>} states obecny stan KSeF (ostatnie zdarzenie)
 * @returns {{ changes: Array<{ id: number, number: string, eventType: string, payload: object }>, unknown: object[], warnings: string[] }}
 */
function planKsef(rows, invoices, states) {
  const byKey = new Map(invoices.map((i) => [`${Number(i.level)}|${i.number}|${String(i.organization_ident || '').toUpperCase()}`, i]));
  const changes = [];
  const unknown = [];
  const warnings = [];
  for (const row of rows) {
    const inv = byKey.get(`${row.level}|${row.number}|${row.organization}`);
    if (!inv) { unknown.push(row); continue; }
    if (String(inv.issue_date) !== row.invoiceDate) {
      warnings.push(`${row.number}: data faktury w pliku ${row.invoiceDate}, w eFormie ${inv.issue_date} — inna faktura, pomijam`);
      continue;
    }
    const cur = states.get(Number(inv.id));
    if (cur && cur.status === KsefStatus.ACCEPTED) {
      if (row.status !== KsefStatus.ACCEPTED || row.ksefNumber !== cur.ksefNumber) {
        warnings.push(`${inv.number}: w eFormie przyjęta w KSeF (${cur.ksefNumber}), w pliku ${row.status} ${row.ksefNumber} — nie zmieniam`);
      }
      continue;
    }
    if (cur && cur.status === row.status && (cur.reason || '') === row.reason) continue;
    changes.push({
      id: Number(inv.id),
      number: inv.number,
      eventType: KsefEvent[row.status],
      payload: { source: KSEF_FILE, status: row.status, ksefNumber: row.ksefNumber, ksefDate: row.ksefDate, verifyUrl: row.verifyUrl, reason: row.reason, invoiceDate: row.invoiceDate }
    });
  }
  return { changes, unknown, warnings };
}

/**
 * Kod QR z linku weryfikacyjnego KSeF (bez zmian) jako `data:` SVG do wydruku.
 * `qrcode-generator` ładowany dopiero tutaj: bez pakietu (np. kontener bez `npm ci`) faktura
 * renderuje się dalej — bez kodu, z samym numerem KSeF.
 *
 * @param {string} url
 * @returns {string|null}
 */
function ksefQrDataUri(url) {
  let qrcode;
  try {
    qrcode = require('qrcode-generator');
  } catch {
    return null;
  }
  const qr = qrcode(0, 'M');
  qr.addData(String(url), 'Byte');
  qr.make();
  return `data:image/svg+xml;base64,${Buffer.from(qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true })).toString('base64')}`;
}

/**
 * Jeden przebieg (cykl tła, PRZED mailami — przyjęta faktura wychodzi w tym samym przebiegu).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Object} [opts.deps] `{ repository, connect, log }` — podmiana w testach
 * @returns {Promise<{ skipped?: string, changed: object[], unknown: object[], errors: string[] }>}
 */
async function runKsefSync({ dryRun = false, env = process.env, deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const result = { changed: [], unknown: [], errors: [] };
  if (String(env.INVOICE_KSEF_ENABLED).toLowerCase() !== 'true') return { ...result, skipped: 'disabled' };
  const config = readInvoiceFtpConfig(env);
  if (!config.connection.host || !config.connection.user) {
    log('[invoices:ksef] brak konta FTP (FTP_HOST/FTP_USER) — numery KSeF nie wczytane');
    return { ...result, skipped: 'config' };
  }

  const remotePath = `${config.rootDir}/${KSEF_FILE}`;
  const client = await (deps.connect || defaultConnect)(config);
  let buffer;
  try {
    buffer = await downloadFile(client, remotePath);
  } finally {
    client.close();
  }
  if (!buffer) return { ...result, skipped: 'no-file' };

  const { rows, errors } = parseKsefTsv(buffer);
  result.errors.push(...errors);
  const invoices = rows.length ? await repository.findInvoicesByNumbers([...new Set(rows.map((r) => r.number))]) : [];
  const states = invoices.length ? await repository.getKsefStates(invoices.map((i) => Number(i.id))) : new Map();
  const plan = planKsef(rows, invoices, states);
  result.unknown = plan.unknown;
  plan.warnings.forEach((w) => log(`[invoices:ksef] UWAGA — ${w}`));

  for (const c of plan.changes) {
    const p = c.payload;
    const label = `${c.number}: ${p.status}${p.ksefNumber ? ` ${p.ksefNumber}` : ''}${p.reason ? ` — ${p.reason}` : ''}`;
    if (dryRun) { log(`[invoices:ksef] DRY-RUN: ${label}`); result.changed.push(c); continue; }
    await repository.addInvoiceEvent({ invoiceId: c.id, eventType: c.eventType, actorPin: AUTO_ACTOR, payload: p });
    result.changed.push(c);
    log(`[invoices:ksef] ${label}`);
  }
  if (errors.length) log(`[invoices:ksef] pominięte złe wiersze ${remotePath}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5})` : ''}`);
  if (plan.unknown.length) log(`[invoices:ksef] ${plan.unknown.length} wierszy bez faktury w eFormie (np. ${plan.unknown.slice(0, 3).map((r) => `${r.level}/${r.number}/${r.organization}`).join(', ')})`);
  log(`[invoices:ksef] ${dryRun ? 'DRY-RUN: ' : ''}${remotePath}: ${rows.length} wierszy, zmienione ${result.changed.length}`);
  return result;
}

module.exports = { KSEF_FILE, KSEF_HEADER, KsefStatus, KsefEvent, KSEF_EVENTS, parseKsefTsv, planKsef, ksefQrDataUri, runKsefSync };
