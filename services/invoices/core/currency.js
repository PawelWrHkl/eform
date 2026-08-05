'use strict';

/**
 * Kursy walut dla faktur w walucie obcej.
 *
 * Reguła podatkowa (PL): do przeliczenia kwot na fakturze stosuje się średni kurs
 * NBP z **ostatniego dnia roboczego poprzedzającego** dzień powstania obowiązku
 * podatkowego (datę sprzedaży). Dlatego `getRate` nie pyta o „dzisiejszy kurs",
 * tylko cofa się od podanej daty i bierze pierwszą opublikowaną tabelę.
 *
 * API NBP: https://api.nbp.pl/api/exchangerates/rates/a/{waluta}/{data}/?format=json
 *  - tabela A = kursy średnie,
 *  - brak tabeli w dany dzień (weekend/święto) → HTTP 404, cofamy się o dobę.
 *
 * Sieć jest wstrzykiwana (`fetchImpl`) — testy jednostkowe nie wychodzą na zewnątrz,
 * a podmiana NBP na EBC to napisanie drugiego providera, nie przeróbka modułu.
 *
 * @typedef {import('../domain/types').ExchangeRate} ExchangeRate
 */

const { log } = require('../../../utils/logging');

/** Ile dni wstecz maksymalnie szukamy tabeli (długie święta + zapas). */
const MAX_LOOKBACK_DAYS = 10;

/** Czas życia wpisu w cache (ms). Kursy historyczne są niezmienne, ale
 *  trzymanie ich w nieskończoność w pamięci procesu nie ma sensu. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * @param {Date} date
 * @returns {string} `YYYY-MM-DD`
 */
function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {string} isoDate
 * @param {number} days
 * @returns {string}
 */
function shiftDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/**
 * Provider kursów NBP (tabela A).
 * PUNKT ROZSZERZENIA: druga implementacja z tym samym interfejsem
 * (`fetchRate(currency, isoDate) => Promise<{rate, date, source}|null>`)
 * wystarczy, żeby wpiąć EBC albo własną tabelę kursów organizacji.
 */
class NbpRateProvider {
  /**
   * @param {Object} [deps]
   * @param {typeof fetch} [deps.fetchImpl]
   */
  constructor(deps = {}) {
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
  }

  /**
   * @param {string} currency ISO 4217, np. `EUR`
   * @param {string} isoDate  `YYYY-MM-DD`
   * @returns {Promise<{ rate: number, date: string, source: string }|null>}
   *          `null`, gdy w danym dniu nie ma tabeli (weekend/święto).
   */
  async fetchRate(currency, isoDate) {
    const url = `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(currency.toLowerCase())}/${isoDate}/?format=json`;
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`NBP API HTTP ${res.status} dla ${currency} ${isoDate}`);
    const body = await res.json();
    const entry = body && Array.isArray(body.rates) ? body.rates[0] : null;
    if (!entry || !Number.isFinite(Number(entry.mid))) {
      throw new Error(`NBP API: brak kursu mid dla ${currency} ${isoDate}`);
    }
    return { rate: Number(entry.mid), date: entry.effectiveDate || isoDate, source: `NBP:${entry.no || 'A'}` };
  }
}

class CurrencyConverter {
  /**
   * @param {Object} [deps]
   * @param {{ fetchRate: (c: string, d: string) => Promise<{rate:number,date:string,source:string}|null> }} [deps.provider]
   * @param {(msg: string, ...rest: unknown[]) => void} [deps.log]
   */
  constructor(deps = {}) {
    this.provider = deps.provider || new NbpRateProvider();
    this.log = deps.log || log;
    /** @type {Map<string, { value: ExchangeRate, expiresAt: number }>} */
    this.cache = new Map();
  }

  /**
   * Kurs do przeliczenia `from` → `to` na potrzeby dokumentu z datą `saleDate`.
   *
   * ⚠️ Obsługiwany kierunek to waluta obca → waluta lokalna sprzedawcy (`PLN`),
   * bo tak działa tabela NBP. Dla `from === to` zwraca kurs 1 bez odpytywania sieci.
   *
   * @param {string} from      waluta dokumentu (`EUR`)
   * @param {string} to        waluta lokalna (`PLN`)
   * @param {string} saleDate  `YYYY-MM-DD` — data sprzedaży, NIE data kursu
   * @returns {Promise<ExchangeRate>}
   */
  async getRate(from, to, saleDate) {
    const fromC = String(from || '').toUpperCase();
    const toC = String(to || '').toUpperCase();

    if (!fromC || !toC || fromC === toC) {
      return { from: fromC || toC, to: toC || fromC, rate: 1, date: saleDate, source: 'identity' };
    }
    if (toC !== 'PLN') {
      throw new Error(`CurrencyConverter: obsługiwane jest wyłącznie przeliczenie na PLN (żądano ${fromC}→${toC}). Podepnij własny provider dla innych walut lokalnych.`);
    }

    const cacheKey = `${fromC}|${toC}|${saleDate}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // Ostatni dzień roboczy PRZED datą sprzedaży — stąd start od -1.
    let cursor = shiftDays(saleDate, -1);
    for (let i = 0; i < MAX_LOOKBACK_DAYS; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- świadomie sekwencyjnie: szukamy pierwszej opublikowanej tabeli wstecz
      const hit = await this.provider.fetchRate(fromC, cursor);
      if (hit) {
        /** @type {ExchangeRate} */
        const value = { from: fromC, to: toC, rate: hit.rate, date: hit.date, source: hit.source };
        this.cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      }
      cursor = shiftDays(cursor, -1);
    }

    throw new Error(`Brak kursu ${fromC}/${toC} w tabelach NBP w oknie ${MAX_LOOKBACK_DAYS} dni przed ${saleDate}`);
  }
}

module.exports = { CurrencyConverter, NbpRateProvider, toIsoDate, shiftDays, MAX_LOOKBACK_DAYS };
