'use strict';

/**
 * Język dokumentu wg kraju NABYWCY (decyzja właściciela 2026-10-23): klient
 * z Holandii dostaje fakturę po niderlandzku, z Polski po polsku, z Niemiec
 * i z Austrii po niemiecku, z Francji po francusku — cała reszta po angielsku.
 * Dotyczy etykiet, adnotacji VAT i maila z fakturą (słowniki `i18n/<język>.json`).
 *
 * Wcześniej o języku decydował profil wystawcy (domyślnie `pl`), więc np. faktura
 * Luxan GmbH dla niemieckiego klienta miała polskie etykiety i niemieckie klauzule.
 */

/** Języki z kompletnym słownikiem faktury — także lista w panelu („Język dokumentu"). */
const DOCUMENT_LANGUAGES = Object.freeze(['pl', 'en', 'de', 'nl', 'fr']);

const LANGUAGE_BY_BUYER_COUNTRY = Object.freeze({ NL: 'nl', PL: 'pl', DE: 'de', AT: 'de', FR: 'fr' });

/** Kraj spoza listy (DK, CH, BE…) — angielski. */
const FALLBACK_LANGUAGE = 'en';

/**
 * @param {string|null|undefined} country  kod ISO nabywcy
 * @returns {string}
 */
function invoiceLanguageFor(country) {
  return LANGUAGE_BY_BUYER_COUNTRY[String(country || '').trim().toUpperCase()] || FALLBACK_LANGUAGE;
}

/**
 * Jawny wybór (panel, API) wygrywa, o ile to obsługiwany język; puste albo nieznane
 * („wg kraju klienta") — reguła z kraju nabywcy.
 *
 * @param {string|null|undefined} requested
 * @param {string|null|undefined} buyerCountry
 * @returns {string}
 */
function documentLanguage(requested, buyerCountry) {
  const lang = String(requested || '').trim().toLowerCase();
  return DOCUMENT_LANGUAGES.includes(lang) ? lang : invoiceLanguageFor(buyerCountry);
}

module.exports = { DOCUMENT_LANGUAGES, LANGUAGE_BY_BUYER_COUNTRY, FALLBACK_LANGUAGE, invoiceLanguageFor, documentLanguage };
