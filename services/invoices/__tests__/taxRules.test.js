'use strict';

/**
 * Testy reguł podatkowych: krajowa / obniżona / WDT / reverse charge / eksport.
 * Stawki pochodzą z `services/vatCalculator.js` — te testy pilnują DECYZJI,
 * nie samych liczb.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTaxTreatment, looksLikeVatEuId, normalizeCountry } = require('../core/taxRules');
const { TaxCategory } = require('../domain/constants');

const PL = { name: 'HKL', country: 'PL', taxId: '1234567890' };
const DE_B2B = { name: 'Kunde GmbH', country: 'DE', vatEuId: 'DE123456789' };
const CH = { name: 'Schweiz AG', country: 'CH' };

test('sprzedaż krajowa PL → PL: stawka podstawowa 23%', () => {
  const r = resolveTaxTreatment({ seller: PL, buyer: { ...PL, name: 'Klient' } });
  assert.equal(r.taxCategory, TaxCategory.STANDARD);
  assert.equal(r.taxRate, 23);
  assert.equal(r.legalNoteKey, null, 'sprzedaż krajowa nie wymaga adnotacji prawnej');
});

test('montaż krajowy w PL: stawka obniżona 8% z ostrzeżeniem o warunkach', () => {
  const r = resolveTaxTreatment({ seller: PL, buyer: { ...PL }, opts: { isInstallation: true } });
  assert.equal(r.taxCategory, TaxCategory.REDUCED);
  assert.equal(r.taxRate, 8);
  assert.match(r.notes.join(' '), /społecznym programem mieszkaniowym/);
});

test('WDT: towar do UE B2B z numerem potwierdzonym w VIES → 0%', () => {
  const r = resolveTaxTreatment({ seller: PL, buyer: DE_B2B, opts: { vatEuVerified: true } });
  assert.equal(r.taxCategory, TaxCategory.INTRA_EU_GOODS);
  assert.equal(r.taxRate, 0);
  assert.equal(r.legalNoteKey, 'legal.intra_eu_goods');
});

test('reverse charge: usługa do UE B2B z potwierdzonym numerem', () => {
  const r = resolveTaxTreatment({ seller: PL, buyer: DE_B2B, opts: { vatEuVerified: true, isService: true } });
  assert.equal(r.taxCategory, TaxCategory.INTRA_EU_SERVICE);
  assert.equal(r.legalNoteKey, 'legal.reverse_charge');
});

test('UE bez potwierdzenia VIES: nadal 0%, ale z ostrzeżeniem', () => {
  // Decyzja projektowa: o stawce decyduje para krajów (jak w vatCalculator.js),
  // a VIES jest dowodem należytej staranności, nie warunkiem stawki.
  const r = resolveTaxTreatment({ seller: PL, buyer: DE_B2B, opts: { vatEuVerified: false } });
  assert.equal(r.taxCategory, TaxCategory.INTRA_EU_GOODS);
  assert.equal(r.taxRate, 0);
  assert.match(r.notes.join(' '), /nie potwierdzono w VIES/);
});

test('UE bez numeru VAT-UE: 0% z ostrzeżeniem o brakującym numerze', () => {
  const r = resolveTaxTreatment({ seller: PL, buyer: { name: 'Hans', country: 'DE' } });
  assert.equal(r.taxRate, 0);
  assert.equal(r.taxCategory, TaxCategory.INTRA_EU_GOODS);
  assert.match(r.notes.join(' '), /bez numeru VAT-UE/);
});

test('eksport poza UE (CH): 0% z adnotacją eksportową', () => {
  const r = resolveTaxTreatment({ seller: PL, buyer: CH });
  assert.equal(r.taxCategory, TaxCategory.EXPORT);
  assert.equal(r.taxRate, 0);
  assert.equal(r.legalNoteKey, 'legal.export');
});

test('sprzedaż krajowa w Szwajcarii: stawka krajowa CH, nie eksport', () => {
  const r = resolveTaxTreatment({ seller: { name: 'CH GmbH', country: 'CH' }, buyer: CH });
  assert.equal(r.taxCategory, TaxCategory.STANDARD);
  assert.equal(r.taxRate, 8.1, 'VAT jest podatkiem krajowym — CH ma własną stawkę mimo braku członkostwa w UE');
});

test('ręczne nadpisanie stawki (np. przy korekcie)', () => {
  const r = resolveTaxTreatment({ seller: PL, buyer: DE_B2B, opts: { forcedRate: 5 } });
  assert.equal(r.taxRate, 5);
  assert.match(r.notes.join(' '), /nadpisana ręcznie/);
});

test('brak kraju sprzedawcy nie wysadza kalkulacji — kategoria "np"', () => {
  const r = resolveTaxTreatment({ seller: { name: 'X' }, buyer: DE_B2B });
  assert.equal(r.taxCategory, TaxCategory.NOT_SUBJECT);
  assert.equal(r.taxRate, 0);
});

test('walidacja formatu numeru VAT-UE', () => {
  assert.equal(looksLikeVatEuId('DE123456789', 'DE'), true);
  assert.equal(looksLikeVatEuId('DE 123 456 789', 'DE'), true, 'spacje i myślniki są ignorowane');
  assert.equal(looksLikeVatEuId('PL1234567890', 'DE'), false, 'prefiks musi zgadzać się z krajem');
  assert.equal(looksLikeVatEuId('EL123456789', 'GR'), true, 'Grecja w VIES występuje jako EL');
  assert.equal(looksLikeVatEuId('CH123456', 'CH'), false, 'CH nie jest w UE');
  assert.equal(looksLikeVatEuId('', 'DE'), false);
});

test('normalizacja kodu kraju', () => {
  assert.equal(normalizeCountry(' pl '), 'PL');
  assert.equal(normalizeCountry('Polska'), 'PO', 'obcinamy do 2 znaków — wejście musi być kodem ISO');
  assert.equal(normalizeCountry(null), '');
});
