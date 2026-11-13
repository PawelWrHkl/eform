/**
 * POP-02: adres klienta końcowego sprawdzany przed zapisem (services/sendAddress.js).
 * Złe przypadki = adresy A&A, które w 10–11.2026 przeszły do PROD bez kontroli.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSendAddress } = require('../sendAddress');

const ok = { name: 'Hermann Ballé', street: 'Uferstraße 27', zip: '50996', city: 'Köln', country: 'de', phone: '0201/453629', email: '' };

test('poprawny adres DE i NL przechodzi, pola są przycięte', () => {
    assert.deepEqual(normalizeSendAddress({ ...ok, zip: '36341 ', city: ' Lauterbach' }).errors, []);
    assert.equal(normalizeSendAddress({ ...ok, zip: '36341 ' }).value.zip, '36341');
    assert.deepEqual(normalizeSendAddress({ ...ok, zip: '2635 DL', city: 'Den Hoorn', country: 'nl', phone: '+31 15 767 6001' }).errors, []);
});

test('błędy z danych A&A są odrzucane', () => {
    assert.deepEqual(normalizeSendAddress({ ...ok, zip: 'Mülheim', city: '45470' }).errors, ['zip', 'city']);
    assert.deepEqual(normalizeSendAddress({ ...ok, zip: '01735397982', city: '' }).errors, ['city', 'zip']);
    assert.deepEqual(normalizeSendAddress({ ...ok, zip: 'Hannover' }).errors, ['zip']);
});

test('wymagane: nazwa, ulica, kod, miasto, kraj; telefon i e-mail opcjonalne, ale poprawne', () => {
    assert.deepEqual(normalizeSendAddress({}).errors, ['name', 'street', 'zip', 'city', 'country']);
    assert.deepEqual(normalizeSendAddress({ ...ok, phone: 'brak' }).errors, ['phone']);
    assert.deepEqual(normalizeSendAddress({ ...ok, email: 'a@b' }).errors, ['email']);
});

test('długi adres: do limitu kolumny bez ucinania, ponad limit = błąd, nie obcięcie', () => {
    const street = 'S'.repeat(255);
    const r = normalizeSendAddress({ ...ok, street, phone: '+49 0123 4567 8901 2345' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.street, street);
    assert.deepEqual(normalizeSendAddress({ ...ok, street: street + 'x' }).errors, ['street']);
});

test('znacznik wysyłki neutralnej domyślnie wyłączony', () => {
    assert.equal(normalizeSendAddress(ok).value.neutral, false);
    assert.equal(normalizeSendAddress({ ...ok, neutral: true }).value.neutral, true);
    assert.equal(normalizeSendAddress({ ...ok, neutral: 'false' }).value.neutral, false);
});
