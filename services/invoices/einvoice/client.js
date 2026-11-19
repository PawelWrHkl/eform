'use strict';

/**
 * Klient usługi e-faktur (ZUGFeRD) Wiktorii — kontrakt „EFOR_E-Rechnung_Kontrakt”
 * v1.4 (14.11.2026), pkt 3 i 5. Usługa: `http://192.168.0.21:5031` (agentai, tylko
 * LAN, bez TLS), klucz w nagłówku `X-Api-Key` (klucz = wystawca + tryb shadow/live
 * + lista IP po stronie usługi).
 *
 * Zasady z kontraktu, które ten plik pilnuje:
 *   - timeout ≥ 120 s (walidator Mustang to Java, zwykle 5–20 s),
 *   - ten sam POST z tą samą treścią jest bezpieczny → ponowienie przy 500/503
 *     i przy zerwanym połączeniu,
 *   - 202 (w kolejce / generuje się) → odpytywanie `Location`/`state_url`
 *     z `Retry-After`,
 *   - numer w URL-u w postaci „bezpiecznej”: `/` → `_`,
 *   - w logu tylko skrót treści (sha256), nigdy treść ani klucz.
 *
 * Klient NIE interpretuje statusów biznesowo (ready/held/…) — zwraca kod HTTP
 * i treść odpowiedzi, decyzję podejmuje `einvoice/index.js`.
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 120000;
/** Ile łącznie czekamy na dokument w stanie 202, zanim oddamy wynik „w toku”. */
const DEFAULT_MAX_POLL_MS = 180000;
const DEFAULT_RETRY_AFTER_S = 5;
/** Odstępy ponowień przy 500/503/awarii sieci (ten sam POST jest bezpieczny). */
const RETRY_DELAYS_MS = Object.freeze([5000, 15000]);

/** Błąd transportu: brak połączenia, timeout, 401/403/503 — problem usługi albo klucza, nie faktury. */
class EinvoiceTransportError extends Error {
  constructor(message, { httpStatus = null, body = null } = {}) {
    super(message);
    this.name = 'EinvoiceTransportError';
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

/** Numer faktury w URL-u: `2026/00017` → `2026_00017` (kontrakt pkt 3). */
function pathNumber(number) {
  return encodeURIComponent(String(number).replace(/\//g, '_'));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class EinvoiceClient {
  /**
   * @param {Object} opts
   * @param {string} opts.baseUrl            np. `http://192.168.0.21:5031`
   * @param {number} [opts.timeoutMs=120000] na jedno żądanie
   * @param {number} [opts.maxPollMs=180000] łączny czas odpytywania stanu 202
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {(msg: string) => void} [opts.log]
   * @param {number[]} [opts.retryDelaysMs]
   */
  constructor({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, maxPollMs = DEFAULT_MAX_POLL_MS, fetchImpl, sleep, log, retryDelaysMs = RETRY_DELAYS_MS }) {
    if (!/^https?:\/\/[^/]+/.test(String(baseUrl || ''))) throw new Error(`EinvoiceClient: zły adres usługi „${baseUrl}”`);
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxPollMs = maxPollMs;
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || sleepDefault;
    this.log = log || (() => {});
    this.retryDelaysMs = retryDelaysMs;
  }

  /**
   * Jedno żądanie. Awaria sieci i timeout → `EinvoiceTransportError`; każdy kod
   * HTTP wraca jako wynik (to wołający decyduje, co jest błędem).
   *
   * @returns {Promise<{ httpStatus: number, headers: Headers, body: any, buffer?: Buffer }>}
   */
  async request(method, path, { key, json, binary = false } = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = { Accept: binary ? '*/*' : 'application/json' };
    if (key) headers['X-Api-Key'] = key;
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    let res;
    try {
      res = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `brak odpowiedzi w ${Math.round(this.timeoutMs / 1000)} s`
        : (err && err.cause && err.cause.code) || (err && err.message) || String(err);
      throw new EinvoiceTransportError(`${method} ${path}: ${reason}`);
    }
    if (binary && res.ok) {
      return { httpStatus: res.status, headers: res.headers, body: null, buffer: Buffer.from(await res.arrayBuffer()) };
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    return { httpStatus: res.status, headers: res.headers, body: parsed };
  }

  /**
   * POST z ponowieniem przy 500/503/awarii sieci. 401/403 nie ponawiamy —
   * zły klucz albo IP nie naprawi się samo.
   */
  async postWithRetry(path, payload, key) {
    const digest = sha256(JSON.stringify(payload)).slice(0, 12);
    for (let attempt = 0; ; attempt++) {
      let res = null;
      let transportError = null;
      try {
        res = await this.request('POST', path, { key, json: payload });
      } catch (err) {
        if (!(err instanceof EinvoiceTransportError)) throw err;
        transportError = err;
      }
      const retriable = transportError || res.httpStatus === 500 || res.httpStatus === 503;
      if (!retriable || attempt >= this.retryDelaysMs.length) {
        if (transportError) throw transportError;
        return res;
      }
      const why = transportError ? transportError.message : `HTTP ${res.httpStatus}`;
      this.log(`[einvoice] ${path} treść ${digest}…: ${why} — ponowienie ${attempt + 1}/${this.retryDelaysMs.length}`);
      await this.sleep(this.retryDelaysMs[attempt]);
    }
  }

  /** `POST /v1/documents/check` — próba na sucho przed nadaniem numeru (`number: null`). */
  async check(payload, key) {
    return this.postWithRetry('/v1/documents/check', payload, key);
  }

  /**
   * `POST /v1/documents` — dokument z numerem. Przy 202 odpytuje stan, aż
   * przestanie być „w toku” albo minie `maxPollMs` (wtedy wraca ostatnie 202).
   */
  async submit(payload, key) {
    let res = await this.postWithRetry('/v1/documents', payload, key);
    let waited = 0;
    while (res.httpStatus === 202 && waited < this.maxPollMs) {
      const retryAfter = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S;
      const stateUrl = res.headers.get('location')
        || (res.body && res.body.state_url)
        || `/v1/documents?number=${encodeURIComponent(payload.number)}`;
      await this.sleep(retryAfter * 1000);
      waited += retryAfter * 1000;
      res = await this.request('GET', stateUrl, { key });
    }
    return res;
  }

  /** Stan dokumentu: po numerze albo po `invoice_id` + środowisku. */
  async getState({ number, invoiceId, eforEnv }, key) {
    const query = number
      ? `number=${encodeURIComponent(number)}`
      : `invoice_id=${encodeURIComponent(invoiceId)}&efor_env=${encodeURIComponent(eforEnv)}`;
    return this.request('GET', `/v1/documents?${query}`, { key });
  }

  /** Zarchiwizowany plik (`pdf` = PDF/A-3 z XML, `xml` = sam CII). 200 → `buffer`. */
  async getFile(number, kind, key) {
    if (kind !== 'pdf' && kind !== 'xml') throw new Error(`getFile: nieznany rodzaj „${kind}”`);
    return this.request('GET', `/v1/documents/${pathNumber(number)}/${kind}`, { key, binary: true });
  }

  /** Unieważnienie przed wysyłką; numer zostaje w EFOR. */
  async void(number, reason, key) {
    if (!String(reason || '').trim()) throw new Error('void: wymagany powód');
    return this.request('POST', `/v1/documents/${pathNumber(number)}/void`, { key, json: { reason: String(reason) } });
  }

  /** `GET /health` — publiczny (bez klucza): czy usługa i jej kolejki żyją. */
  async health() {
    return this.request('GET', '/health');
  }
}

module.exports = { EinvoiceClient, EinvoiceTransportError, pathNumber, sha256, DEFAULT_TIMEOUT_MS };
