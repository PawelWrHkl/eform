'use strict';

/**
 * Weryfikacja numeru VAT-UE w systemie VIES (Komisja Europejska).
 *
 * REST API: `POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number`
 * z ciałem `{ countryCode, vatNumber }`. Odpowiedź niesie `valid`, a przy
 * poprawnym numerze także `name`/`address` podatnika.
 *
 * ⚠️ VIES jest usługą zewnętrzną o kiepskiej dostępności (bywają przerwy
 * serwisowe krajowych rejestrów, limity zapytań). Dlatego klient:
 *  - **nigdy nie rzuca wyjątkiem** — zwraca `{ valid: false, checked: false, reason }`,
 *  - ma twardy timeout (`AbortController`), żeby nie blokować wystawienia faktury,
 *  - cache'uje wynik w pamięci procesu (numer VAT nie zmienia statusu co minutę).
 *
 * ⚠️ Stawka 0% NIE zależy w tym module od wyniku VIES — decyduje o niej para
 * krajów (patrz `core/taxRules.js`). Wynik VIES jest zapisywany na dokumencie
 * jako dowód należytej staranności: `invoice.buyer_vat_eu_verified`,
 * `vies_checked_at`, `vies_valid`.
 */

const { EU_MEMBER_COUNTRIES } = require('../../vatCalculator');
const { log: defaultLog } = require('../../../utils/logging');

const VIES_ENDPOINT = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
const DEFAULT_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Rozbija numer VAT-UE na prefiks kraju i część numeryczną.
 * ⚠️ Grecja występuje w VIES jako `EL`, a jako kod ISO kraju jako `GR` —
 * konwersja w obie strony musi być jawna, inaczej greckie numery zawsze wychodzą
 * jako niepoprawne.
 *
 * @param {string} vatId    np. `DE123456789`
 * @param {string} [country] kod ISO kraju nabywcy (fallback dla numeru bez prefiksu)
 * @returns {{ countryCode: string, vatNumber: string }|null}
 */
function splitVatId(vatId, country) {
  const raw = String(vatId || '').replace(/[\s.-]/g, '').toUpperCase();
  if (!raw) return null;

  let prefix = raw.slice(0, 2);
  let number = raw.slice(2);

  if (!/^[A-Z]{2}$/.test(prefix)) {
    // Numer bez prefiksu — bierzemy kraj z danych nabywcy
    const iso = String(country || '').toUpperCase().slice(0, 2);
    if (!iso) return null;
    prefix = iso === 'GR' ? 'EL' : iso;
    number = raw;
  }

  const isoPrefix = prefix === 'EL' ? 'GR' : prefix;
  if (!EU_MEMBER_COUNTRIES.has(isoPrefix)) return null;
  if (!number || number.length < 2) return null;

  return { countryCode: prefix, vatNumber: number };
}

class ViesClient {
  /**
   * @param {Object} [deps]
   * @param {typeof fetch} [deps.fetchImpl]
   * @param {(msg: string, ...rest: unknown[]) => void} [deps.log]
   * @param {number} [deps.timeoutMs]
   */
  constructor(deps = {}) {
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
    this.log = deps.log || defaultLog;
    this.timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
    /** @type {Map<string, { value: object, expiresAt: number }>} */
    this.cache = new Map();
  }

  /**
   * Sprawdza numer w VIES.
   *
   * @param {string} vatId
   * @param {string} [country] kod ISO kraju nabywcy
   * @returns {Promise<{ valid: boolean, checked: boolean, countryCode?: string, vatNumber?: string, name?: string, address?: string, reason?: string, checkedAt?: string }>}
   *          `checked: false` = nie udało się zapytać (offline, timeout, zły format).
   */
  async check(vatId, country) {
    const parts = splitVatId(vatId, country);
    if (!parts) {
      return { valid: false, checked: false, reason: 'Numer nie ma formatu numeru VAT-UE państwa członkowskiego' };
    }

    const cacheKey = `${parts.countryCode}${parts.vatNumber}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (typeof this.fetchImpl !== 'function') {
      return { valid: false, checked: false, reason: 'Brak implementacji fetch w tym środowisku' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(VIES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ countryCode: parts.countryCode, vatNumber: parts.vatNumber }),
        signal: controller.signal
      });

      if (!res.ok) {
        return { valid: false, checked: false, reason: `VIES HTTP ${res.status}`, ...parts };
      }

      const body = await res.json();
      /** @type {any} */
      const value = {
        valid: body?.valid === true,
        checked: true,
        countryCode: parts.countryCode,
        vatNumber: parts.vatNumber,
        name: body?.name && body.name !== '---' ? body.name : undefined,
        address: body?.address && body.address !== '---' ? body.address : undefined,
        checkedAt: new Date().toISOString()
      };
      this.cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (err) {
      const reason = err && err.name === 'AbortError'
        ? `VIES nie odpowiedział w ${this.timeoutMs} ms`
        : `VIES niedostępny: ${err && err.message ? err.message : 'nieznany błąd'}`;
      this.log(`[invoices] ${reason}`);
      // Świadomie NIE rzucamy — brak odpowiedzi VIES nie może blokować faktury.
      return { valid: false, checked: false, reason, ...parts };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { ViesClient, splitVatId, VIES_ENDPOINT, DEFAULT_TIMEOUT_MS };
