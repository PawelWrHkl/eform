'use strict';

/**
 * Płatności z księgowości → status faktury (szef 19.11.2026: „Efor będzie czytał z księgowości, czy
 * zapłacone — musi iść online”; statusy „otwarta” / „opłacona”). Źródło (decyzja Pawła 19.11): plik
 * automatu Wiktorii na FTP faktur, `<INVOICE_FTP_DIR>/platnosci.tsv` — odwrotność
 * `zafakturowane_pozycje.tsv`, z tymi samymi identyfikatorami faktury:
 *
 *   LEVEL  INVOICENO  ORGANIZATIONIDENT  PAIDAMOUNT  PAIDDATE
 *   1      26000002   LUXANGMBH          442.18      2026-11-20
 *
 *   PAIDAMOUNT — ile ŁĄCZNIE księgowość rozliczyła z fakturą (przelewy i kompensaty), w walucie faktury
 *                (kropka albo przecinek) — suma narastająca, nie pojedyncza wpłata;
 *   PAIDDATE   — data ostatniego wyciągu, RRRR-MM-DD. Plik może mieć wszystkie faktury albo tylko te
 *   z wpłatami; brak wiersza = bez zmian. ORGANIZATIONIDENT jak w pliku pozycji (26000009 jest u HKL i u Cozy).
 *   Tylko faktury HKL (LEVEL 1 i LEVEL 2 z ORGANIZATIONIDENT = HKL) — wpłat Cozy i Luxan GmbH księgowość
 *   nie zna (Wiktoria 20.11.2026); wiersz innego wystawcy jest pomijany jak nieznany.
 *
 * Każdy przebieg cyklu (co godzinę, PRZED przypomnieniami) czyta cały plik: zapłacono ≥ do zapłaty →
 * „opłacona” (data zapłaty z pliku); mniej → kwota przy fakturze, status bez zmian (częściowo zapłacona).
 * Opłaconej nie cofamy (maszyna stanów `core/statuses.js`) — tylko wpis w logu. Brak pliku = nic się nie dzieje.
 *
 * Konfiguracja: INVOICE_PAYMENTS_ENABLED=true (domyślnie wyłączone); konto i katalog jak faktur na FTP
 * (`readInvoiceFtpConfig`: FTP_HOST/USER/PASSWORD, INVOICE_FTP_DIR).
 */

const { Writable } = require('stream');
const defaultRepository = require('./db/repository');
const { readInvoiceFtpConfig, defaultConnect } = require('./invoiceFtpExport');
const { AUTO_ACTOR } = require('./autoInvoicing');
const { log: defaultLog } = require('../../utils/logging');

const PAYMENTS_FILE = 'platnosci.tsv';
const PAYMENT_EVENT = 'payment_synced';
const PAYMENTS_HEADER = ['LEVEL', 'INVOICENO', 'ORGANIZATIONIDENT', 'PAIDAMOUNT', 'PAIDDATE'];
const CENT = 0.005;

/** „1 234,56”, „1.234,56”, „1234.56” → 1234.56; zła wartość → NaN. */
function parseAmount(value) {
  let s = String(value || '').replace(/\s+/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) / 100 : NaN;
}

/**
 * @param {string|Buffer} text zawartość `platnosci.tsv`
 * @returns {{ rows: Array<{ level: number, number: string, organization: string, paid: number, date: string|null }>, errors: string[] }}
 */
function parsePaymentsTsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: [] };
  const head = lines[0].split('\t').map((h) => h.trim().toUpperCase());
  const missing = PAYMENTS_HEADER.filter((h) => !head.includes(h));
  if (missing.length) return { rows: [], errors: [`brak kolumn ${missing.join(', ')} w nagłówku`] };
  const rows = [];
  const errors = [];
  lines.slice(1).forEach((line, i) => {
    const cells = line.split('\t');
    const get = (h) => String(cells[head.indexOf(h)] ?? '').trim();
    const level = Number(get('LEVEL'));
    const paid = parseAmount(get('PAIDAMOUNT'));
    const date = get('PAIDDATE') || null;
    const bad = !get('INVOICENO') || !Number.isInteger(level) || Number.isNaN(paid)
      || (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) || (paid > 0 && !date);
    if (bad) errors.push(`wiersz ${i + 2}: „${line.trim()}”`);
    else rows.push({ level, number: get('INVOICENO'), organization: get('ORGANIZATIONIDENT').toUpperCase(), paid, date });
  });
  return { rows, errors };
}

/**
 * Co zmienić w bazie (czysta funkcja).
 *
 * @param {ReturnType<typeof parsePaymentsTsv>['rows']} rows
 * @param {Array<{ id: number, number: string, level: number, status: string, amount_due: number|string, paid_amount: number|string, organization_ident: string }>} invoices
 * @returns {{ updates: Array<{ id: number, number: string, fromStatus: string, status: string, paidAmount: number, paidAt: string|null }>, unknown: object[], warnings: string[] }}
 */
function planPayments(rows, invoices) {
  const byKey = new Map(invoices.map((i) => [`${Number(i.level)}|${i.number}|${String(i.organization_ident || '').toUpperCase()}`, i]));
  const updates = [];
  const unknown = [];
  const warnings = [];
  for (const row of rows) {
    const inv = byKey.get(`${row.level}|${row.number}|${row.organization}`);
    if (!inv) { unknown.push(row); continue; }
    if (!['issued', 'overdue', 'paid'].includes(inv.status)) continue;
    const due = Number(inv.amount_due);
    const already = Number(inv.paid_amount);
    if (inv.status === 'paid') {
      if (row.paid < due - CENT) warnings.push(`${inv.number}: w eFormie opłacona, w księgowości zapłacono ${row.paid.toFixed(2)} z ${due.toFixed(2)} — nie cofam`);
      continue;
    }
    if (row.paid >= due - CENT && due > 0) {
      updates.push({ id: Number(inv.id), number: inv.number, fromStatus: inv.status, status: 'paid', paidAmount: row.paid, paidAt: row.date });
    } else if (Math.abs(row.paid - already) >= CENT) {
      updates.push({ id: Number(inv.id), number: inv.number, fromStatus: inv.status, status: inv.status, paidAmount: row.paid, paidAt: row.paid > 0 ? row.date : null });
    }
  }
  return { updates, unknown, warnings };
}

/** Plik z FTP do pamięci; brak pliku → `null`. */
async function downloadFile(client, remotePath) {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  try {
    await client.downloadTo(sink, remotePath);
  } catch (err) {
    if (err && Number(err.code) === 550) return null;
    throw err;
  }
  return Buffer.concat(chunks);
}

/**
 * Jeden przebieg.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Object} [opts.deps] `{ repository, connect, log }` — podmiana w testach
 * @returns {Promise<{ skipped?: string, updated: object[], unknown: object[], errors: string[] }>}
 */
async function runPaymentSync({ dryRun = false, env = process.env, deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const result = { updated: [], unknown: [], errors: [] };
  if (String(env.INVOICE_PAYMENTS_ENABLED).toLowerCase() !== 'true') return { ...result, skipped: 'disabled' };
  const config = readInvoiceFtpConfig(env);
  if (!config.connection.host || !config.connection.user) {
    log('[invoices:payments] brak konta FTP (FTP_HOST/FTP_USER) — płatności nie wczytane');
    return { ...result, skipped: 'config' };
  }

  const remotePath = `${config.rootDir}/${PAYMENTS_FILE}`;
  const client = await (deps.connect || defaultConnect)(config);
  let buffer;
  try {
    buffer = await downloadFile(client, remotePath);
  } finally {
    client.close();
  }
  if (!buffer) return { ...result, skipped: 'no-file' };

  const { rows, errors } = parsePaymentsTsv(buffer);
  result.errors.push(...errors);
  const invoices = rows.length ? await repository.findInvoicesByNumbers([...new Set(rows.map((r) => r.number))]) : [];
  const plan = planPayments(rows, invoices);
  result.unknown = plan.unknown;
  plan.warnings.forEach((w) => log(`[invoices:payments] UWAGA — ${w}`));

  for (const u of plan.updates) {
    const label = `${u.number}: ${u.status === 'paid' ? `opłacona ${u.paidAt}` : `zapłacono ${u.paidAmount.toFixed(2)} (częściowo)`}`;
    if (dryRun) { log(`[invoices:payments] DRY-RUN: ${label}`); result.updated.push(u); continue; }
    if (await repository.applyPayment({ ...u, actorPin: AUTO_ACTOR, payload: { source: PAYMENTS_FILE, paid: u.paidAmount, date: u.paidAt } })) {
      result.updated.push(u);
      log(`[invoices:payments] ${label}`);
    }
  }
  if (errors.length) log(`[invoices:payments] pominięte złe wiersze ${remotePath}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5})` : ''}`);
  if (plan.unknown.length) log(`[invoices:payments] ${plan.unknown.length} wierszy bez faktury HKL w eFormie (np. ${plan.unknown.slice(0, 3).map((r) => `${r.level}/${r.number}/${r.organization}`).join(', ')})`);
  log(`[invoices:payments] ${dryRun ? 'DRY-RUN: ' : ''}${remotePath}: ${rows.length} wierszy, zmienione ${result.updated.length}`);
  return result;
}

module.exports = { PAYMENTS_FILE, PAYMENTS_HEADER, PAYMENT_EVENT, parseAmount, parsePaymentsTsv, planPayments, downloadFile, runPaymentSync };
