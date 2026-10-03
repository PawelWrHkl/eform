'use strict';

/**
 * Odbiorca końcowy: osoba prywatna nie ma numerów firmowych (`core/endClient.js`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEndClientData } = require('../core/endClient');

test('osoba prywatna: NIP, NIP UE i numery rejestrowe są czyszczone', () => {
  const out = normalizeEndClientData({
    client_type: 'person', name: 'Jan Kowalski', tax_id: '1234567890', vat_eu_id: 'PL1234567890',
    registry_numbers: { REGON: '123456789' }, city: 'Szczecin'
  });
  assert.equal(out.tax_id, null);
  assert.equal(out.vat_eu_id, null);
  assert.equal(out.registry_numbers, null);
  assert.equal(out.name, 'Jan Kowalski');
  assert.equal(out.city, 'Szczecin');
});

test('firma: dane bez zmian', () => {
  const data = { client_type: 'company', tax_id: '1234567890', registry_numbers: { REGON: '1' } };
  assert.equal(normalizeEndClientData(data), data);
});

test('aktualizacja bez pola client_type nie rusza numerów', () => {
  const data = { city: 'Berlin' };
  assert.deepEqual(normalizeEndClientData(data), { city: 'Berlin' });
});

test('wejście nie jest modyfikowane w miejscu', () => {
  const data = { client_type: 'person', tax_id: '1' };
  normalizeEndClientData(data);
  assert.equal(data.tax_id, '1');
});
