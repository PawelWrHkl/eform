'use strict';

/**
 * Normalizacja dat na format `YYYY-MM-DD`.
 *
 * ⚠️ Powód istnienia tego pliku: sterownik `mysql2` zwraca kolumny `DATE`/`DATETIME`
 * jako obiekty `Date`, a nie stringi. Skrót `String(value).slice(0, 10)` daje wtedy
 * `'Tue Aug 04'` (format `Date.prototype.toString`), co MySQL odrzuca przy zapisie
 * z komunikatem `Incorrect date value`. Każda data wchodząca do modułu i wychodząca
 * z niego przechodzi przez `toIsoDay`.
 *
 * ⚠️ Konwersja świadomie używa czasu LOKALNEGO (`getFullYear`, nie `getUTCFullYear`).
 * Aplikacja działa w `Europe/Warsaw`; użycie UTC przesuwałoby datę sprzedaży na
 * poprzedni dzień dla wszystkiego, co powstaje między 00:00 a 02:00 czasu lokalnego.
 */

/**
 * @param {Date|string|number|null|undefined} value
 * @returns {string} `YYYY-MM-DD` albo `''`, gdy wartości nie da się zinterpretować
 */
function toIsoDay(value) {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const raw = String(value).trim();
  // Już w dobrym formacie (ewentualnie z częścią czasową: `2026-08-05T10:00:00`)
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : toIsoDay(parsed);
}

/**
 * Dzisiejsza data w czasie lokalnym.
 * @param {Date} [now]
 * @returns {string}
 */
function todayIso(now = new Date()) {
  return toIsoDay(now);
}

/**
 * Data przesunięta o `days` dni. Arytmetyka w UTC na znormalizowanym dniu —
 * bezpieczna względem zmiany czasu (dodanie 14 dni nie zgubi doby na przełomie
 * marca/października).
 *
 * @param {Date|string} isoDay
 * @param {number} days
 * @returns {string}
 */
function addDays(isoDay, days) {
  const base = toIsoDay(isoDay);
  if (!base) return '';
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

module.exports = { toIsoDay, todayIso, addDays };
