'use strict';

/**
 * Maszyna stanów dokumentu. Status nie jest dowolnym stringiem — każda zmiana
 * przechodzi przez `assertTransition`, więc niemożliwe jest np. „odpłacenie"
 * faktury (`paid` → `draft`) albo anulowanie dokumentu już skorygowanego.
 *
 * Uzasadnienia biznesowe wybranych krawędzi:
 *  - `draft` → `cancelled`: szkic można porzucić, nie zostawia śladu w numeracji
 *    (numer nadajemy dopiero przy `issued`).
 *  - `issued` → `cancelled`: dopuszczalne wyłącznie dla dokumentu, który nie
 *    wszedł do obiegu; po wysłaniu do klienta poprawia się korektą, nie anulowaniem.
 *  - `paid` → `corrected`: zapłacona faktura też podlega korekcie (np. zwrot towaru).
 *  - `overdue` jest stanem pochodnym od `dueDate`, ale trzymamy go jawnie,
 *    żeby raporty nie musiały liczyć dat w SQL-u przy każdym zapytaniu.
 */

const { InvoiceStatus } = require('../domain/constants');

/** @type {Record<string, string[]>} */
const ALLOWED_TRANSITIONS = Object.freeze({
  [InvoiceStatus.DRAFT]: [InvoiceStatus.ISSUED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.ISSUED]: [InvoiceStatus.PAID, InvoiceStatus.OVERDUE, InvoiceStatus.CANCELLED, InvoiceStatus.CORRECTED],
  [InvoiceStatus.OVERDUE]: [InvoiceStatus.PAID, InvoiceStatus.CORRECTED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.PAID]: [InvoiceStatus.CORRECTED],
  [InvoiceStatus.CORRECTED]: [],
  [InvoiceStatus.CANCELLED]: []
});

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/**
 * @param {string} from
 * @param {string} to
 * @throws {Error} gdy przejście jest niedozwolone
 */
function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const allowed = (ALLOWED_TRANSITIONS[from] || []).join(', ') || '—';
    throw new Error(`Niedozwolona zmiana statusu faktury: ${from} → ${to}. Dozwolone z ${from}: ${allowed}`);
  }
}

/**
 * Czy dokument jest po terminie płatności. Wyliczane na podstawie daty, ale
 * zapis statusu robi wołający (np. cron) — ta funkcja nic nie mutuje.
 *
 * @param {{ status: string, dueDate: string }} invoice
 * @param {Date} [now]
 * @returns {boolean}
 */
function isOverdue(invoice, now = new Date()) {
  if (!invoice || invoice.status !== InvoiceStatus.ISSUED || !invoice.dueDate) return false;
  return new Date(`${invoice.dueDate}T23:59:59`) < now;
}

/**
 * Czy dokument jest księgowy (tworzy skutki podatkowe).
 * Proforma i szkic — nie.
 *
 * @param {{ documentType: string, status: string }} invoice
 * @returns {boolean}
 */
function isAccountingDocument(invoice) {
  if (!invoice) return false;
  if (invoice.documentType === 'proforma') return false;
  return invoice.status !== InvoiceStatus.DRAFT && invoice.status !== InvoiceStatus.CANCELLED;
}

/**
 * Dokument przyjęty przez system zewnętrzny (`repository.getEditBlockers().accepted`): e-faktura
 * ZUGFeRD w trybie live albo KSeF ACCEPTED. Treść i status pod tym numerem są zamrożone — bez edycji,
 * przebudowy i anulowania; poprawka = korekta (nota). Wiktoria 19.11.2026: „faktura przyjęta (ready)
 * albo wysłana nie może się zmienić pod tym samym numerem”.
 *
 * @param {string} label numer faktury do komunikatu
 * @returns {string}
 */
function acceptedLockMessage(label) {
  return `Faktura ${label} jest przyjęta przez system zewnętrzny (e-faktura / KSeF) — treści i statusu pod tym numerem nie wolno zmienić, popraw korektą`;
}

module.exports = { ALLOWED_TRANSITIONS, canTransition, assertTransition, isOverdue, isAccountingDocument, acceptedLockMessage };
