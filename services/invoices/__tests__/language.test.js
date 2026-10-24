'use strict';

/**
 * Język faktury wg kraju klienta (`core/language.js`, 2026-10-23) i klauzule
 * kraju wystawcy na fakturze w innym języku (`compliance.visibleClauses`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { invoiceLanguageFor, documentLanguage, DOCUMENT_LANGUAGES } = require('../core/language');
const { buildComplianceContext, visibleClauses } = require('../core/compliance');
const { TaxCategory } = require('../domain/constants');

test('język faktury wg kraju klienta: NL, PL, DE i AT, FR — swój język, cała reszta po angielsku', () => {
  assert.equal(invoiceLanguageFor('NL'), 'nl');
  assert.equal(invoiceLanguageFor('PL'), 'pl');
  assert.equal(invoiceLanguageFor('DE'), 'de');
  assert.equal(invoiceLanguageFor('AT'), 'de', 'Austria po niemiecku (właściciel, 2026-10-23)');
  assert.equal(invoiceLanguageFor('FR'), 'fr');
  for (const country of ['DK', 'CH', 'BE', 'GB', '', null, undefined]) {
    assert.equal(invoiceLanguageFor(country), 'en', String(country));
  }
  assert.equal(invoiceLanguageFor(' de '), 'de', 'kod z bazy bywa z odstępem albo małymi literami');
  assert.equal(invoiceLanguageFor('nl'), 'nl');
  assert.deepEqual(DOCUMENT_LANGUAGES, ['pl', 'en', 'de', 'nl', 'fr']);
});

test('jawny wybór z panelu wygrywa; puste („wg kraju klienta") albo nieznane — reguła', () => {
  assert.equal(documentLanguage('pl', 'NL'), 'pl');
  assert.equal(documentLanguage('FR', 'DE'), 'fr');
  assert.equal(documentLanguage('', 'NL'), 'nl');
  assert.equal(documentLanguage(undefined, 'DE'), 'de');
  assert.equal(documentLanguage('xx', 'DK'), 'en');
});

const ctx = (sellerCountry, buyerCountry, category, legalSettings = {}) => buildComplianceContext({
  seller: { country: sellerCountry, vatEuId: `${sellerCountry}123456789`, taxId: `${sellerCountry}123456789` },
  buyer: { country: buyerCountry },
  taxLines: [{ taxCategory: category, taxRate: category === TaxCategory.STANDARD ? 23 : 0 }],
  legalSettings,
  currency: 'EUR',
  localCurrency: 'EUR',
  deliveryDate: '2026-10-01'
});
const ids = (clauses) => clauses.map((c) => c.id);

test('klauzula WDT sprzedawcy z DE — po niemiecku tak, w innym języku nie (podstawa jest w adnotacji VAT)', () => {
  const de = ctx('DE', 'AT', TaxCategory.INTRA_EU_GOODS);
  assert.deepEqual(ids(de.clauses), ['de_wdt'], 'na dokumencie zapisana jest jak dotąd');
  assert.deepEqual(ids(visibleClauses(de, 'de')), ['de_wdt']);
  assert.deepEqual(ids(visibleClauses(de, 'en')), []);
  assert.deepEqual(ids(visibleClauses(de, 'nl')), []);

  // HKL → klient holenderski: bez polskiego zdania o WDT na fakturze po niderlandzku
  const pl = ctx('PL', 'NL', TaxCategory.INTRA_EU_GOODS);
  assert.deepEqual(ids(visibleClauses(pl, 'nl')), []);
  assert.deepEqual(ids(visibleClauses(pl, 'pl')), ['pl_wdt']);
});

test('klauzule bez odpowiednika w adnotacji VAT zostają w każdym języku', () => {
  const fr = ctx('FR', 'BE', TaxCategory.INTRA_EU_GOODS);
  assert.deepEqual(ids(visibleClauses(fr, 'en')), ['fr_late_penalty', 'fr_recovery_indemnity']);
  assert.deepEqual(ids(visibleClauses(fr, 'fr')), ['fr_wdt', 'fr_late_penalty', 'fr_recovery_indemnity']);

  const split = ctx('PL', 'PL', TaxCategory.STANDARD, { split_payment: true });
  assert.deepEqual(ids(visibleClauses(split, 'en')), ['pl_split_payment']);

  assert.deepEqual(visibleClauses(null, 'pl'), [], 'dokument sprzed v2 bez kontekstu');
});
