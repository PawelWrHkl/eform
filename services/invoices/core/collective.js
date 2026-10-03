'use strict';

/**
 * Fakturowanie niestandardowe klienta — faktura zbiorcza za okres.
 *
 * `user.invoice_schedule` (ustawia admin w /admin/users):
 *   puste    — standard: faktura za każde zlecenie zaraz po wysyłce (`!sent!`),
 *   weekly   — jedna faktura ze wszystkich zleceń wysłanych w tygodniu (pon–nd),
 *   monthly  — jedna faktura ze wszystkich zleceń wysłanych w miesiącu kalendarzowym.
 * Dotyczy faktur, w których ten użytkownik jest NABYWCĄ — poziom 2 (organizacja →
 * klient). Okres zlecenia wyznacza data wysyłki (`order.delivery_date`).
 *
 * Czysta logika bez I/O: okresy, ich zamknięcie i podział zleceń na faktury.
 */

const { toIsoDay, addDays } = require('./dates');

const SCHEDULES = Object.freeze(['weekly', 'monthly']);

/**
 * Ile pełnych dni po końcu okresu czekamy z fakturą. Status wysyłki z ostatniego
 * dnia okresu trafia do `status.txt` z opóźnieniem — faktura wystawiona tuż po
 * północy pominęłaby takie zlecenie i dla tego samego okresu powstałaby druga.
 * Tydzień zamyka się więc we wtorek, miesiąc drugiego dnia następnego miesiąca.
 */
const COLLECTIVE_GRACE_DAYS = 1;

/**
 * @param {unknown} value
 * @returns {'weekly'|'monthly'|null} `null` = standard (faktura za każde zlecenie)
 */
function normalizeSchedule(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return SCHEDULES.includes(v) ? v : null;
}

const pad = (n) => String(n).padStart(2, '0');
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Okres rozliczeniowy, do którego należy dzień.
 *
 * @param {Date|string} day        data wysyłki zlecenia
 * @param {'weekly'|'monthly'} schedule
 * @returns {{ schedule: string, key: string, start: string, end: string }}
 *          `key` np. `2026-09` albo `2026-W39` (tydzień ISO)
 */
function periodFor(day, schedule) {
  const d = utc(toIsoDay(day));
  if (schedule === 'monthly') {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    return {
      schedule,
      key: `${y}-${pad(m + 1)}`,
      start: `${y}-${pad(m + 1)}-01`,
      end: iso(new Date(Date.UTC(y, m + 1, 0)))
    };
  }
  if (schedule === 'weekly') {
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    // Numer tygodnia ISO liczy się od czwartku — tydzień należy do roku, w którym wypada czwartek
    const thursday = new Date(monday);
    thursday.setUTCDate(monday.getUTCDate() + 3);
    const year = thursday.getUTCFullYear();
    const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return { schedule, key: `${year}-W${pad(week)}`, start: iso(monday), end: iso(sunday) };
  }
  throw new Error(`Nieznany harmonogram fakturowania: ${schedule}`);
}

/**
 * Czy okres jest już zamknięty i można wystawić za niego fakturę.
 *
 * @param {{ end: string }} period
 * @param {string} todayIso
 * @param {number} [graceDays]
 * @returns {boolean}
 */
function isPeriodClosed(period, todayIso, graceDays = COLLECTIVE_GRACE_DAYS) {
  return toIsoDay(todayIso) > addDays(period.end, graceDays);
}

/**
 * Zlecenia czekające na fakturę zbiorczą → faktury do wystawienia.
 *
 * Jedna faktura = jeden klient + jeden sklep grupowy + jeden okres. Sklep
 * grupowy osobno, bo bywa osobnym nabywcą (własny NIP — `hierarchy.resolveParties`).
 * Zlecenia z okresów jeszcze otwartych czekają; zaległe z dawnych okresów
 * (np. sprzed włączenia automatu) dostają fakturę za SWÓJ okres — data sprzedaży
 * na fakturze musi odpowiadać okresowi dostaw.
 *
 * @param {Array<{ id: number, user_id: number, group_user_id?: number|null, delivery_date: Date|string, invoice_schedule: string }>} rows
 * @param {{ todayIso: string, graceDays?: number }} opts
 * @returns {Array<{ userId: number, userIdent: string|null, groupUserId: number|null, schedule: string, period: object, orderIds: number[] }>}
 */
function groupCollectiveCandidates(rows, { todayIso, graceDays = COLLECTIVE_GRACE_DAYS }) {
  const groups = new Map();
  for (const row of rows || []) {
    const schedule = normalizeSchedule(row.invoice_schedule);
    if (!schedule || !toIsoDay(row.delivery_date)) continue;
    const period = periodFor(row.delivery_date, schedule);
    if (!isPeriodClosed(period, todayIso, graceDays)) continue;
    const groupUserId = row.group_user_id ? Number(row.group_user_id) : null;
    const key = `${row.user_id}|${groupUserId || ''}|${period.key}`;
    if (!groups.has(key)) {
      groups.set(key, { userId: Number(row.user_id), userIdent: row.user_ident || null, groupUserId, schedule, period, orderIds: [] });
    }
    groups.get(key).orderIds.push(Number(row.id));
  }
  return [...groups.values()].sort((a, b) => (a.period.start < b.period.start ? -1 : a.period.start > b.period.start ? 1 : a.userId - b.userId));
}

module.exports = {
  SCHEDULES,
  COLLECTIVE_GRACE_DAYS,
  normalizeSchedule,
  periodFor,
  isPeriodClosed,
  groupCollectiveCandidates
};
