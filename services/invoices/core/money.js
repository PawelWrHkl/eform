'use strict';

/**
 * Arytmetyka pieniężna na liczbach całkowitych (grosze/centy).
 *
 * DLACZEGO: faktura musi się spinać co do grosza, a `0.1 + 0.2 !== 0.3` w IEEE 754.
 * Wszystkie obliczenia w module idą na minor units (`number` całkowity), a na
 * `DECIMAL(12,2)` / string konwertujemy dopiero na wyjściu.
 *
 * Zakres: Number.MAX_SAFE_INTEGER to ~90 mld PLN w groszach — z zapasem.
 */

/** Domyślna liczba miejsc po przecinku waluty. Wyjątki w `MINOR_UNITS`. */
const DEFAULT_DECIMALS = 2;

/** Waluty o innej liczbie miejsc po przecinku niż 2 (JPY, HUF w niektórych ujęciach). */
const MINOR_UNITS = Object.freeze({ JPY: 0, KRW: 0, ISK: 0 });

/**
 * @param {string} [currency]
 * @returns {number} liczba miejsc po przecinku dla waluty
 */
function decimalsFor(currency) {
  if (!currency) return DEFAULT_DECIMALS;
  const d = MINOR_UNITS[String(currency).toUpperCase()];
  return d === undefined ? DEFAULT_DECIMALS : d;
}

/**
 * Zaokrąglenie half-up (0.5 → w górę), a NIE bankers' rounding.
 * Tego wymagają polskie przepisy o zaokrąglaniu kwot podatku.
 * `Math.round` w JS zaokrągla -0.5 do -0 (czyli „w górę" w stronę zera),
 * dlatego liczby ujemne (korekty!) obsługujemy jawnie.
 *
 * @param {number} value
 * @returns {number}
 */
function roundHalfUp(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Konwersja kwoty „ludzkiej" (złote jako number/string) na minor units.
 * Akceptuje `1234.56`, `'1 234,56'`, `'1234.56 €'` — dane w eForm bywają stringami.
 *
 * @param {number|string|null|undefined} amount
 * @param {string} [currency]
 * @returns {number} kwota w minor units (0 dla wartości niepoliczalnych)
 */
function toMinor(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return 0;
  const factor = 10 ** decimalsFor(currency);
  if (typeof amount === 'number') {
    return Number.isFinite(amount) ? roundHalfUp(amount * factor) : 0;
  }
  const normalized = String(amount)
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? roundHalfUp(parsed * factor) : 0;
}

/**
 * Minor units → number w jednostkach głównych (do zapisu w DECIMAL i do JSON-a).
 * @param {number} minor
 * @param {string} [currency]
 * @returns {number}
 */
function toMajor(minor, currency) {
  const factor = 10 ** decimalsFor(currency);
  return roundHalfUp(minor) / factor;
}

/**
 * Mnożenie kwoty przez ilość (ilość bywa ułamkowa: 2.35 m²).
 * @param {number} minor
 * @param {number} quantity
 * @returns {number}
 */
function multiply(minor, quantity) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return 0;
  return roundHalfUp(minor * q);
}

/**
 * Procent kwoty (rabat, VAT). `percent` w punktach procentowych (23 = 23%).
 * @param {number} minor
 * @param {number} percent
 * @returns {number}
 */
function percentOf(minor, percent) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p === 0) return 0;
  return roundHalfUp((minor * p) / 100);
}

/**
 * Suma listy kwot.
 * @param {number[]} values
 * @returns {number}
 */
function sum(values) {
  return (values || []).reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
}

/**
 * Przeliczenie na inną walutę po zadanym kursie.
 * @param {number} minor
 * @param {number} rate  1 jednostka waluty źródłowej = `rate` jednostek docelowej
 * @param {string} [fromCurrency]
 * @param {string} [toCurrency]
 * @returns {number}
 */
function convert(minor, rate, fromCurrency, toCurrency) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return 0;
  const fromFactor = 10 ** decimalsFor(fromCurrency);
  const toFactor = 10 ** decimalsFor(toCurrency);
  return roundHalfUp((minor / fromFactor) * r * toFactor);
}

/**
 * Formatowanie do prezentacji (szablon Nunjucks, PDF).
 * Używa `Intl` z locale dokumentu — spacja nierozdzielająca jako separator tysięcy
 * dla `pl`, kropka dla `de` itd.
 *
 * @param {number} minor
 * @param {string} currency
 * @param {string} [locale]
 * @param {{ withSymbol?: boolean }} [opts]
 * @returns {string}
 */
function format(minor, currency, locale = 'pl', opts = {}) {
  const decimals = decimalsFor(currency);
  const value = toMajor(minor, currency);
  const formatter = new Intl.NumberFormat(locale, {
    style: opts.withSymbol ? 'currency' : 'decimal',
    currency: currency || 'PLN',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return formatter.format(value);
}

module.exports = {
  DEFAULT_DECIMALS,
  decimalsFor,
  roundHalfUp,
  toMinor,
  toMajor,
  multiply,
  percentOf,
  sum,
  convert,
  format
};
