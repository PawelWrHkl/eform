'use strict';

/**
 * E-faktury (ZUGFeRD, PDF/A-3 z XML) przez usługę Wiktorii — kontrakt
 * „EFOR_E-Rechnung_Kontrakt” v1.4 (14.11.2026, `wizualizacja efor/`).
 *
 * TRYB CIENIA (shadow): każda wystawiona faktura wystawcy z kluczem API idzie
 * `POST /v1/documents`. Usługa buduje e-fakturę ze znakiem wodnym „MUSTER”, sprawdza
 * ją (Mustang) i archiwizuje; NIC nie wysyła klientom. Poziom ≠ 2 usługa tylko
 * zapisuje do porównania z PROD (pkt 11). EFOR niczego w fakturze nie zmienia:
 * PDF, mail i FTP idą jak dotąd, a wynik e-faktury trafia do `invoice_event`
 * (`einvoice_*`) i do logu cyklu z listą HOLD-ów po polsku.
 *
 * Ta sama kolejka co FTP (`invoiceFtpExport.js`): cykl tła `services/prodStatusCycle.js`,
 * zdarzenia w `invoice_event`, limit na przebieg. Zmiana treści faktury (edycja,
 * przeliczona dzienna) = nowa wersja → wysyłka od nowa (`repository.findInvoicesForEinvoice`).
 *
 * TRYB LIVE celowo NIEDOSTĘPNY: wymaga przebudowy wystawiania (check → numer → POST,
 * kontrakt pkt 6.2), przechowywania pliku e-faktury jako PDF faktury (pkt 6.3) i noty
 * zamiast anulowania (pkt 6.5). `EINVOICE_MODE=live` = konfiguracja odrzucona.
 *
 * Konfiguracja (`.env`, domyślnie WYŁĄCZONE; klucze tylko w `.env.local`):
 *   EINVOICE_MODE=shadow              off | shadow
 *   EINVOICE_URL=http://192.168.0.21:5031
 *   EINVOICE_ENV=test                 dev | test | prod — `efor_env`, musi pasować do klucza
 *   EINVOICE_SINCE=2026-11-18         WYMAGANE: faktury wystawione od tego dnia
 *   EINVOICE_API_KEY_<IDENT>=…        klucz wystawcy, np. EINVOICE_API_KEY_LUXANGMBH,
 *                                     EINVOICE_API_KEY_HKL (poziom 1); bez klucza = nie wysyłamy
 *   EINVOICE_LEVELS_<IDENT>=1         opcjonalnie: tylko te poziomy tego wystawcy (domyślnie 1–4).
 *                                     HKL: `1` — kontrakt obejmuje HKL → organizacja, nie HKL → klient HKL
 *   EINVOICE_MAX_PER_RUN=10           bezpiecznik na przebieg (POST trwa 5–20 s)
 *   EINVOICE_TIMEOUT_MS=120000        na żądanie; kontrakt: co najmniej 120 s
 */

const defaultRepository = require('../db/repository');
const { AUTO_ACTOR } = require('../autoInvoicing');
const { collectivePeriod } = require('../invoiceFtpExport');
const { EinvoiceClient, EinvoiceTransportError, sha256, DEFAULT_TIMEOUT_MS } = require('./client');
const { buildPayload, ENVS } = require('./payload');
const { log: defaultLog } = require('../../../utils/logging');

const EinvoiceEvent = Object.freeze({
  /** 200 — e-faktura zbudowana, sprawdzona, w archiwum (w cieniu z „MUSTER”); w live też stan wysyłki. */
  READY: 'einvoice_ready',
  /** 200 `stored_for_comparison` — poziom ≠ 2 w cieniu: tylko do porównania z PROD. */
  STORED: 'einvoice_stored',
  /** 422 — HOLD: treść do poprawy w EFOR (lista po polsku w zdarzeniu). */
  HELD: 'einvoice_held',
  /** 409 — numer zajęty inną treścią, unieważniony albo istnieje w archiwum PROD. */
  CONFLICT: 'einvoice_conflict',
  /** Inny błąd tej faktury (400 schemat, 413, 500 po ponowieniach) — ponowienie, max `MAX_ATTEMPTS`. */
  FAILED: 'einvoice_failed'
});
const TERMINAL_EVENTS = Object.freeze([EinvoiceEvent.READY, EinvoiceEvent.STORED, EinvoiceEvent.HELD, EinvoiceEvent.CONFLICT]);
/** Wystawione dokumenty; `corrected` też — korekta nie unieważnia faktury pierwotnej. */
const SENDABLE_STATUSES = Object.freeze(['issued', 'paid', 'overdue', 'corrected']);
const ALL_LEVELS = Object.freeze([1, 2, 3, 4]);
const MAX_ATTEMPTS = 5;
const DEFAULT_MAX_PER_RUN = 10;
const MODES = Object.freeze(['off', 'shadow']);
const KEY_PREFIX = 'EINVOICE_API_KEY_';
const LEVELS_PREFIX = 'EINVOICE_LEVELS_';

/**
 * @param {Record<string, string|undefined>} [env]
 */
function readEinvoiceConfig(env = process.env) {
  const rawMode = String(env.EINVOICE_MODE || 'off').trim().toLowerCase();
  const enabled = rawMode !== 'off' && rawMode !== '';
  const problems = [];

  const rawSince = String(env.EINVOICE_SINCE || '').trim();
  const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSince) ? new Date(`${rawSince}T00:00:00Z`) : null;
  const since = sinceDate && !Number.isNaN(sinceDate.getTime()) && sinceDate.toISOString().slice(0, 10) === rawSince ? rawSince : null;
  const url = String(env.EINVOICE_URL || '').trim();
  const eforEnv = String(env.EINVOICE_ENV || '').trim().toLowerCase();
  const timeoutMs = Math.max(Number(env.EINVOICE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxPerRun = Number(env.EINVOICE_MAX_PER_RUN);

  /** ident wystawcy (WIELKIMI) → klucz */
  const keys = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(KEY_PREFIX) && String(value || '').trim()) keys[name.slice(KEY_PREFIX.length).toUpperCase()] = String(value).trim();
  }

  /** ident wystawcy → poziomy (domyślnie wszystkie) */
  const levels = {};
  for (const ident of Object.keys(keys)) {
    const raw = Object.entries(env).find(([name]) => name.startsWith(LEVELS_PREFIX) && name.slice(LEVELS_PREFIX.length).toUpperCase() === ident);
    if (!raw || !String(raw[1] || '').trim()) {
      levels[ident] = [...ALL_LEVELS];
      continue;
    }
    const list = String(raw[1]).split(',').map((v) => Number(v.trim()));
    if (list.every((n) => ALL_LEVELS.includes(n))) levels[ident] = [...new Set(list)];
    else if (enabled) problems.push(`${raw[0]}: poziomy ${ALL_LEVELS.join(',')} po przecinku (jest: „${raw[1]}”)`);
  }

  if (enabled) {
    if (rawMode === 'live') problems.push('EINVOICE_MODE=live: EFOR obsługuje na razie tylko tryb cienia (shadow) — live wymaga przebudowy wystawiania (kontrakt pkt 6.2–6.5)');
    else if (!MODES.includes(rawMode)) problems.push(`EINVOICE_MODE: dozwolone ${MODES.join(' | ')} (jest: „${rawMode}”)`);
    if (!since) problems.push(`EINVOICE_SINCE musi być datą RRRR-MM-DD (jest: „${rawSince}”)`);
    if (!/^https?:\/\/[^/\s]+$/.test(url.replace(/\/+$/, ''))) problems.push(`EINVOICE_URL: adres usługi, np. http://192.168.0.21:5031 (jest: „${url}”)`);
    if (!ENVS.includes(eforEnv)) problems.push(`EINVOICE_ENV: ${ENVS.join(' | ')} (jest: „${eforEnv}”)`);
    if (!Object.keys(keys).length) problems.push(`brak kluczy ${KEY_PREFIX}<IDENT> (w .env.local) — żaden wystawca nie ma dokąd wysyłać`);
  }

  return {
    enabled,
    active: enabled && problems.length === 0,
    mode: rawMode,
    url,
    env: eforEnv,
    since,
    keys,
    levels,
    timeoutMs,
    maxPerRun: Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : DEFAULT_MAX_PER_RUN,
    problems
  };
}

/**
 * Odpowiedź usługi → co zapisać (kontrakt pkt 5).
 *   `event`  zdarzenie do `invoice_event`; `null` = jeszcze w toku, wróci w następnym przebiegu
 *   `abort`  problem usługi albo klucza (401/403/503) — przerwij przebieg, nic nie zapisuj
 *
 * @param {{ httpStatus: number, body: any }} res
 * @returns {{ event: string|null, abort?: boolean, reason?: string }}
 */
function classifyResponse(res) {
  const body = res.body || {};
  // Usługa opisuje błąd w `errors` (400 schemat: [{ loc, msg }]), `detail` albo `error` (401: „api key missing”)
  const why = Array.isArray(body.errors)
    ? body.errors.map((e) => `${e.loc}: ${e.msg}`).join('; ')
    : (body.detail !== undefined ? body.detail : body.error);
  const suffix = why === undefined || why === null ? '' : `: ${typeof why === 'string' ? why : JSON.stringify(why).slice(0, 300)}`;
  switch (res.httpStatus) {
    case 200:
      return { event: body.status === 'stored_for_comparison' ? EinvoiceEvent.STORED : EinvoiceEvent.READY };
    case 202:
      return { event: null, reason: `w toku (${body.status || 'generating'})` };
    case 422:
      return { event: EinvoiceEvent.HELD };
    case 409:
      // „generuje się z inną treścią — spróbuj później” to stan przejściowy, reszta 409 jest trwała
      return body.state === 'generating'
        ? { event: null, reason: 'numer właśnie się generuje (409 generating)' }
        : { event: EinvoiceEvent.CONFLICT };
    case 401:
    case 403:
    case 503:
      return { event: null, abort: true, reason: `HTTP ${res.httpStatus}${suffix}` };
    default:
      return { event: EinvoiceEvent.FAILED, reason: `HTTP ${res.httpStatus}${suffix}` };
  }
}

/** Skrót odpowiedzi do zdarzenia: bez bajtów, z HOLD-ami po polsku do pokazania operatorowi. */
function eventPayload(res, requestSha) {
  const b = res.body || {};
  const issues = (list) => (Array.isArray(list) ? list.map((h) => ({ code: h.code, pl: h.pl })) : []);
  return {
    http: res.httpStatus,
    status: b.status || null,
    mode: b.mode || null,
    state: b.state || null,
    number: b.number || null,
    holds: issues(b.holds),
    warnings: issues(b.warnings),
    mustang: (b.validation && b.validation.mustang && b.validation.mustang.overall) || null,
    content_hash: b.content_hash || null,
    pdf_sha256: b.pdf_sha256 || null,
    xml_sha256: b.xml_sha256 || null,
    live_would_reject: b.live_would_reject || null,
    detail: b.errors || (b.detail === undefined ? (b.error === undefined ? null : b.error) : b.detail),
    request_sha256: requestSha
  };
}

/** Linia logu z wynikiem jednej faktury. */
function describeOutcome(event, payload) {
  const codes = (list) => list.map((h) => (h.pl ? `${h.code} — ${h.pl}` : h.code)).join('; ');
  if (event === EinvoiceEvent.HELD) return `HOLD: ${codes(payload.holds) || '(bez listy)'}`;
  if (event === EinvoiceEvent.CONFLICT) return `konflikt 409${payload.state ? ` (${payload.state})` : ''}${payload.number ? `, numer w usłudze ${payload.number}` : ''}`;
  if (event === EinvoiceEvent.STORED) return `zapisana do porównania z PROD${payload.live_would_reject ? ` (live: ${payload.live_would_reject})` : ''}`;
  const warn = payload.warnings.length ? `, ostrzeżenia: ${codes(payload.warnings)}` : '';
  return `${payload.status || 'ready'} (${payload.mode || '?'}, Mustang: ${payload.mustang || '?'})${warn}`;
}

/**
 * Jeden przebieg kolejki e-faktur.
 *
 * @param {{ dryRun?: boolean, config?: ReturnType<typeof readEinvoiceConfig>, deps?: { repository?: any, client?: any, log?: Function } }} [opts]
 */
async function runEinvoiceExport({ dryRun = false, config = readEinvoiceConfig(), deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const result = { done: [], failed: [], planned: [] };

  config.problems.forEach((p) => log(`[einvoice] konfiguracja: ${p}`));
  if (!config.active) {
    if (config.enabled) log('[einvoice] e-faktury NIE ruszyły — popraw konfigurację powyżej');
    return { ...result, skipped: config.enabled ? 'config' : 'disabled' };
  }

  const pending = await repository.findInvoicesForEinvoice({
    since: config.since,
    issuerLevels: Object.entries(config.levels).flatMap(([ident, list]) => list.map((level) => [ident, level])),
    statuses: [...SENDABLE_STATUSES],
    terminalEvents: [...TERMINAL_EVENTS],
    failedEvent: EinvoiceEvent.FAILED,
    maxAttempts: MAX_ATTEMPTS,
    limit: config.maxPerRun
  });
  const client = deps.client || new EinvoiceClient({ baseUrl: config.url, timeoutMs: config.timeoutMs, log });

  const record = async (row, eventType, payload) => {
    try {
      await repository.addInvoiceEvent({ invoiceId: row.id, eventType, actorPin: AUTO_ACTOR, payload });
    } catch (err) {
      // Ten sam POST jest bezpieczny — brak znacznika = powtórka w następnym przebiegu
      log(`[einvoice] UWAGA — faktura ${row.number}: nie zapisano wyniku (${err.message}); pójdzie ponownie`);
    }
  };

  for (const row of pending) {
    const label = `faktura ${row.number} (id ${row.id}, poziom ${row.level}, ${row.issuer_ident} → ${row.buyer_name})`;
    const key = config.keys[String(row.issuer_ident || '').toUpperCase()];
    if (!key) continue;

    let payload;
    try {
      const invoice = await repository.getInvoice(row.id);
      const sources = await repository.getEinvoiceSources(invoice);
      payload = buildPayload({ invoice, env: config.env, sources, period: collectivePeriod(row) });
    } catch (err) {
      result.failed.push({ invoiceId: row.id, number: row.number, error: err.message });
      log(`[einvoice] BŁĄD treści — ${label}: ${err.message} (próba ${Number(row.failures || 0) + 1}/${MAX_ATTEMPTS})`);
      if (!dryRun) await record(row, EinvoiceEvent.FAILED, { error: err.message });
      continue;
    }
    const requestSha = sha256(JSON.stringify(payload));

    if (dryRun) {
      result.planned.push({ invoiceId: row.id, number: row.number, issuer: row.issuer_ident, items: payload.items.length, request_sha256: requestSha });
      log(`[einvoice] DRY-RUN: wysłałbym — ${label}, ${payload.items.length} poz., ${payload.totals.gross} EUR`);
      continue;
    }

    let res;
    try {
      res = await client.submit(payload, key);
    } catch (err) {
      if (!(err instanceof EinvoiceTransportError)) throw err;
      result.failed.push({ error: err.message });
      log(`[einvoice] usługa niedostępna (${err.message}) — przebieg przerwany, ${label} i reszta wrócą w następnym`);
      break;
    }

    const outcome = classifyResponse(res);
    if (outcome.abort) {
      result.failed.push({ error: outcome.reason });
      log(`[einvoice] ${outcome.reason} — klucz, adres IP albo usługa; przebieg przerwany (${label})`);
      break;
    }
    if (!outcome.event) {
      log(`[einvoice] ${label}: ${outcome.reason} — sprawdzę w następnym przebiegu`);
      continue;
    }

    const summary = eventPayload(res, requestSha);
    if (outcome.reason) summary.error = outcome.reason;
    await record(row, outcome.event, summary);
    if (outcome.event === EinvoiceEvent.FAILED) {
      result.failed.push({ invoiceId: row.id, number: row.number, error: outcome.reason });
      log(`[einvoice] BŁĄD — ${label}: ${outcome.reason} (próba ${Number(row.failures || 0) + 1}/${MAX_ATTEMPTS})`);
    } else {
      result.done.push({ invoiceId: row.id, number: row.number, event: outcome.event, holds: summary.holds.map((h) => h.code) });
      log(`[einvoice] ${label} → ${describeOutcome(outcome.event, summary)}`);
    }
  }

  if (pending.length || result.failed.length) {
    log(`[einvoice] ${dryRun ? `DRY-RUN: do wysłania ${result.planned.length}` : `rozstrzygnięte ${result.done.length}, błędy ${result.failed.length}`}`
      + ` (${config.mode}, efor_env=${config.env}, faktury od ${config.since})`);
  }
  if (pending.length >= config.maxPerRun) log(`[einvoice] wyczerpany limit ${config.maxPerRun} na przebieg (EINVOICE_MAX_PER_RUN) — reszta w następnym`);
  return result;
}

module.exports = {
  EinvoiceEvent,
  TERMINAL_EVENTS,
  SENDABLE_STATUSES,
  MAX_ATTEMPTS,
  readEinvoiceConfig,
  classifyResponse,
  eventPayload,
  describeOutcome,
  runEinvoiceExport
};
