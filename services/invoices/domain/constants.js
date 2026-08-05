'use strict';

/**
 * Słowniki domenowe modułu fakturowania.
 *
 * Wszystkie wartości są zapisywane do bazy jako stringi (kolumny VARCHAR/ENUM-like),
 * więc każda z nich jest częścią kontraktu — nie zmieniaj istniejących kluczy,
 * dokładaj nowe. Etykiety dla użytkownika NIE są tutaj: idą przez i18n
 * (`services/invoices/i18n/*.json`), żeby jeden dokument dało się wystawić w PL,
 * a jego kopię dla kontrahenta w DE.
 */

/** Rodzaje dokumentów. Determinuje szablon numeracji i logikę rozliczeń. */
const DocumentType = Object.freeze({
  /** Proforma — nie jest dokumentem księgowym, nie tworzy obowiązku podatkowego. */
  PROFORMA: 'proforma',
  /** Zaliczkowa — do zamówień pod wymiar; rozlicza wpłatę przed dostawą. */
  ADVANCE: 'advance',
  /** Końcowa/rozliczeniowa — pomniejszona o wystawione wcześniej zaliczki. */
  FINAL: 'final',
  /** Zwykła faktura VAT (sprzedaż bez zaliczek). */
  INVOICE: 'invoice',
  /** Korygująca — wskazuje `corrected_invoice_id` i niesie różnice (delty). */
  CORRECTION: 'correction'
});

/**
 * Statusy dokumentu. Przejścia pilnuje `core/statuses.js` — status nie jest
 * dowolnym stringiem, tylko maszyną stanów (np. z `PAID` nie wracamy do `DRAFT`).
 */
const InvoiceStatus = Object.freeze({
  DRAFT: 'draft',
  ISSUED: 'issued',
  PAID: 'paid',
  OVERDUE: 'overdue',
  CANCELLED: 'cancelled',
  /** Skorygowana inną fakturą — pozostaje w obiegu, ale ma następcę. */
  CORRECTED: 'corrected'
});

/**
 * Kategoria podatkowa pozycji. To ONA, a nie sama stawka, decyduje o adnotacji
 * na dokumencie — 0% przy WDT i 0% przy eksporcie to dwa różne stany prawne,
 * mimo identycznej stawki.
 */
const TaxCategory = Object.freeze({
  /** Sprzedaż krajowa — stawka kraju sprzedawcy (23%, 8%, 5%…). */
  STANDARD: 'standard',
  /** Stawka obniżona (np. montaż w budownictwie objętym społecznym programem). */
  REDUCED: 'reduced',
  /** WDT — wewnątrzwspólnotowa dostawa towarów, 0% przy ważnym VAT-UE nabywcy. */
  INTRA_EU_GOODS: 'intra_eu_goods',
  /** Usługa B2B do UE — odwrotne obciążenie (art. 28b, reverse charge). */
  INTRA_EU_SERVICE: 'intra_eu_service',
  /** Eksport towarów poza UE — 0%. */
  EXPORT: 'export',
  /** Nie podlega opodatkowaniu w kraju sprzedawcy. */
  NOT_SUBJECT: 'np',
  /** Zwolnione przedmiotowo/podmiotowo. */
  EXEMPT: 'zw'
});

/** Kategorie o zerowej stawce — pomocnicze przy walidacji i podsumowaniu VAT. */
const ZERO_RATE_CATEGORIES = Object.freeze([
  TaxCategory.INTRA_EU_GOODS,
  TaxCategory.INTRA_EU_SERVICE,
  TaxCategory.EXPORT,
  TaxCategory.NOT_SUBJECT,
  TaxCategory.EXEMPT
]);

/**
 * Jednostki miary specyficzne dla branży dekoracji okiennych.
 * `PIECE` jest domyślną jednostką, gdy pozycji nie da się zakwalifikować inaczej.
 */
const Unit = Object.freeze({
  PIECE: 'szt',
  SQUARE_METER: 'm2',
  RUNNING_METER: 'mb',
  SET: 'kpl',
  SERVICE: 'usl',
  HOUR: 'godz'
});

/** Metody płatności — wpływają tylko na treść sekcji płatności w szablonie. */
const PaymentMethod = Object.freeze({
  TRANSFER: 'transfer',
  CASH: 'cash',
  CARD: 'card',
  COD: 'cod',
  PREPAID: 'prepaid'
});

/**
 * Adnotacje wymagane na dokumencie dla danej kategorii podatkowej.
 * Klucz i18n, nie gotowy tekst — pełne brzmienie siedzi w `i18n/*.json`.
 * PUNKT ROZSZERZENIA: nowa kategoria = nowy wpis tutaj + klucz w plikach i18n.
 */
const LEGAL_NOTE_KEYS = Object.freeze({
  [TaxCategory.INTRA_EU_GOODS]: 'legal.intra_eu_goods',
  [TaxCategory.INTRA_EU_SERVICE]: 'legal.reverse_charge',
  [TaxCategory.EXPORT]: 'legal.export',
  [TaxCategory.NOT_SUBJECT]: 'legal.not_subject',
  [TaxCategory.EXEMPT]: 'legal.exempt'
});

module.exports = {
  DocumentType,
  InvoiceStatus,
  TaxCategory,
  ZERO_RATE_CATEGORIES,
  Unit,
  PaymentMethod,
  LEGAL_NOTE_KEYS
};
