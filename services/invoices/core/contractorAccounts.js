'use strict';

/**
 * Konto HKL do wpłaty dla nabywcy — z kartoteki księgowości (`data/hkl-contractor-accounts.json`,
 * generuje `scripts/importContractorAccounts.js` z „kontrahenci - nr kont bankowych.xlsx”).
 * Paweł 19.11.2026: „dla klientów HKL w fakturach generowanych automatycznie i w programie do
 * tworzenia i edycji faktur brać stąd numery kont bankowych — to obowiązek”.
 *
 * Dotyczy faktur, których wystawcą jest HKL. Dopasowanie po NIP nabywcy (bez kodu kraju i znaków).
 * Od 19.11 (Tomek) konto ma też contractors.txt (BANK_*, u płatnika albo klienta) — ma pierwszeństwo.
 * Nabywca spoza pliku → domyślne konto EUR ING + ostrzeżenie (decyzja 19.11). Konto liczy się przy
 * każdym druku: formatka HKL od 19.11 nie ma już kont, więc na fakturze jest jedno — to z pliku.
 */

const { isHklIssuer } = require('./pricing');

const DEFAULT_ACCOUNT = Object.freeze({ bankName: 'ING BANK ŚLĄSKI S.A.', iban: 'PL34 1050 1559 1000 0090 3311 9596', swift: 'INGBPLPW' });

/** „PL 851-319-43-09”, „NL869751876B01”, „8513194309” → „8513194309”, „869751876B01”. */
function normalizeTaxId(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^[A-Z]{2}(?=\d)/, '');
}

/** IBAN: suma kontrolna mod 97; polski NRB (26 cyfr) liczony jako `PL…`. */
function isValidIban(value) {
  let s = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (/^\d{26}$/.test(s)) s = `PL${s}`;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  let mod = 0;
  for (const ch of `${s.slice(4)}${s.slice(0, 4)}`) {
    for (const d of /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)) mod = (mod * 10 + Number(d)) % 97;
  }
  return mod === 1;
}

/** Zapis IBAN-u na fakturze: z kodem kraju, grupy po 4 (`56 1050 …` → `PL56 1050 …`). */
function formatIban(value) {
  let s = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (/^\d{26}$/.test(s)) s = `PL${s}`;
  return s.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Wartość z contractors.txt: „-” = brak (konwencja pliku z ERP). */
function cleanValue(value) {
  const s = String(value ?? '').trim();
  return s === '-' ? '' : s;
}

/**
 * Termin płatności z wiersza `user` (contractors.txt PAYMENT_DAYS → `user.payment_days`, Paweł 20.11.2026).
 * Brak kolumny (baza przed migracją), NULL albo śmieci → `null`, czyli termin z dalszych źródeł.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {number|null}
 */
function paymentDaysOf(row) {
  const v = row ? row.payment_days : null;
  return v === null || v === undefined || v === '' || !Number.isInteger(Number(v)) || Number(v) < 0 ? null : Number(v);
}

/**
 * Konto z wiersza `user` (kolumny bank_name / bank_account / swift z contractors.txt, 19.11.2026).
 * Błędny IBAN → `null` (lepiej plik księgowości albo konto domyślne niż zły numer).
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {{ bankName: string, iban: string, swift: string }|null}
 */
function accountFromContractor(row) {
  const iban = row ? cleanValue(row.bank_account) : '';
  if (!iban || !isValidIban(iban)) return null;
  return { bankName: cleanValue(row.bank_name), iban: formatIban(iban), swift: cleanValue(row.swift).replace(/\s+/g, '') };
}

let accounts = null;
function loadAccounts() {
  if (!accounts) {
    try {
      accounts = require('../data/hkl-contractor-accounts.json').accounts || {};
    } catch {
      accounts = {};
    }
  }
  return accounts;
}

/**
 * Kolejność: konto zapisane w fakturze przy wystawieniu (`compliance.paymentAccount` — z contractors.txt:
 * płatnika, potem klienta), konto z bazy podane przy budowaniu (`contractorAccount`), plik księgowości
 * po NIP, konto domyślne.
 *
 * @param {{ issuerType?: string, issuerId?: number, buyer?: { taxId?: string, vatEuId?: string }, compliance?: object, contractorAccount?: object|null }} invoice
 * @param {Record<string, object>} [table] podmiana w testach
 * @returns {{ bankName: string, iban: string, swift: string, matched: boolean }|null} `null` = wystawca nie HKL
 */
function hklPaymentAccount(invoice, table = loadAccounts()) {
  if (!invoice || !isHklIssuer(invoice.issuerType, invoice.issuerId)) return null;
  const known = (invoice.compliance && invoice.compliance.paymentAccount) || invoice.contractorAccount;
  if (known && known.iban) return { bankName: known.bankName || '', iban: known.iban, swift: known.swift || '', matched: true };
  const buyer = invoice.buyer || {};
  const hit = [buyer.vatEuId, buyer.taxId].map(normalizeTaxId).filter(Boolean).map((k) => table[k]).find(Boolean);
  return hit
    ? { bankName: hit.bankName, iban: hit.iban, swift: hit.swift, matched: true }
    : { ...DEFAULT_ACCOUNT, matched: false };
}

/** Ostrzeżenie (log automatu, edytor, formularz in blanco), gdy nabywca HKL nie ma konta w pliku. */
function paymentAccountWarning(invoice, table) {
  const account = hklPaymentAccount(invoice, table);
  if (!account || account.matched) return null;
  const buyer = invoice.buyer || {};
  return `Nabywca ${buyer.name || '—'} (NIP ${buyer.vatEuId || buyer.taxId || 'brak'}) bez konta w pliku księgowości `
    + `„kontrahenci - nr kont bankowych” — na fakturze domyślne konto ${DEFAULT_ACCOUNT.iban}.`;
}

/** Dokłada ostrzeżenie do kontekstu zgodności faktury (`compliance.warnings`) i zwraca kontekst. */
function withPaymentAccountWarning(context, invoice, table) {
  const warning = paymentAccountWarning(invoice, table);
  if (warning) context.warnings = [...(context.warnings || []), warning];
  return context;
}

module.exports = { DEFAULT_ACCOUNT, normalizeTaxId, isValidIban, formatIban, cleanValue, accountFromContractor, paymentDaysOf, hklPaymentAccount, paymentAccountWarning, withPaymentAccountWarning };
