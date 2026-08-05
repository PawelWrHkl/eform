'use strict';

/**
 * Testy klienta VIES i reguły „różne kraje w UE ⇒ 0%".
 * Sieć jest wstrzykiwana — żaden test nie wychodzi do Komisji Europejskiej.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ViesClient, splitVatId, VIES_ENDPOINT } = require('../core/vies');
const { isIntraEuZeroRate, resolveTaxTreatment } = require('../core/taxRules');
const { TaxCategory } = require('../domain/constants');

/**
 * @param {any} body
 * @param {{ ok?: boolean, status?: number }} [opts]
 */
function fakeFetch(body, opts = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: opts.ok !== false,
      status: opts.status || 200,
      json: async () => body
    };
  };
  impl.calls = calls;
  return impl;
}

test('splitVatId: rozbija numer i normalizuje prefiks', () => {
  assert.deepEqual(splitVatId('DE123456789'), { countryCode: 'DE', vatNumber: '123456789' });
  assert.deepEqual(splitVatId('DE 123-456.789'), { countryCode: 'DE', vatNumber: '123456789' });
  assert.deepEqual(splitVatId('123456789', 'NL'), { countryCode: 'NL', vatNumber: '123456789' }, 'numer bez prefiksu + kraj nabywcy');
  assert.deepEqual(splitVatId('123456', 'GR'), { countryCode: 'EL', vatNumber: '123456' }, 'Grecja w VIES to EL');
  assert.equal(splitVatId('CH1234567', 'CH'), null, 'kraj poza UE');
  assert.equal(splitVatId(''), null);
});

test('VIES: poprawny numer daje verified', async () => {
  const fetchImpl = fakeFetch({ valid: true, name: 'TAPIJTCENTRUM NEDERLAND B.V.', address: 'Sportlaan 31' });
  const client = new ViesClient({ fetchImpl, log: () => {} });

  const result = await client.check('NL004148496B01', 'NL');
  assert.equal(result.valid, true);
  assert.equal(result.checked, true);
  assert.equal(result.name, 'TAPIJTCENTRUM NEDERLAND B.V.');
  assert.ok(result.checkedAt, 'zapisujemy moment sprawdzenia jako dowód należytej staranności');
  assert.equal(fetchImpl.calls[0].url, VIES_ENDPOINT);
  assert.deepEqual(fetchImpl.calls[0].body, { countryCode: 'NL', vatNumber: '004148496B01' });
});

test('VIES: numer nieznany w rejestrze', async () => {
  const client = new ViesClient({ fetchImpl: fakeFetch({ valid: false }), log: () => {} });
  const result = await client.check('DE999999999', 'DE');
  assert.equal(result.checked, true);
  assert.equal(result.valid, false);
});

test('VIES: wynik jest cache\'owany (drugie wywołanie bez zapytania)', async () => {
  const fetchImpl = fakeFetch({ valid: true });
  const client = new ViesClient({ fetchImpl, log: () => {} });
  await client.check('DE123456789', 'DE');
  await client.check('DE 123 456 789', 'DE');
  assert.equal(fetchImpl.calls.length, 1, 'ten sam numer po normalizacji trafia w cache');
});

test('VIES: awaria usługi nie rzuca i nie blokuje faktury', async () => {
  const client = new ViesClient({
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
    log: () => {}
  });
  const result = await client.check('DE123456789', 'DE');
  assert.equal(result.checked, false, 'checked=false znaczy „nie wiemy", nie „numer zły"');
  assert.equal(result.valid, false);
  assert.match(result.reason, /VIES niedostępny/);
});

test('VIES: HTTP 500 traktowany jako brak odpowiedzi', async () => {
  const client = new ViesClient({ fetchImpl: fakeFetch({}, { ok: false, status: 500 }), log: () => {} });
  const result = await client.check('DE123456789', 'DE');
  assert.equal(result.checked, false);
  assert.match(result.reason, /HTTP 500/);
});

test('VIES: timeout przerywa zapytanie', async () => {
  const client = new ViesClient({
    timeoutMs: 20,
    log: () => {},
    fetchImpl: (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })
  });
  const result = await client.check('DE123456789', 'DE');
  assert.equal(result.checked, false);
  assert.match(result.reason, /nie odpowiedział/);
});

test('VIES: numer poza UE nie idzie do usługi', async () => {
  const fetchImpl = fakeFetch({ valid: true });
  const client = new ViesClient({ fetchImpl, log: () => {} });
  const result = await client.check('CH1234567', 'CH');
  assert.equal(result.checked, false);
  assert.equal(fetchImpl.calls.length, 0, 'oszczędzamy zapytanie — Szwajcaria nie jest w VIES');
});

test('reguła 0%: para krajów z UE, różne → 0%', () => {
  assert.equal(isIntraEuZeroRate('PL', 'NL'), true);
  assert.equal(isIntraEuZeroRate('PL', 'PL'), false, 'ten sam kraj = sprzedaż krajowa');
  assert.equal(isIntraEuZeroRate('PL', 'CH'), false, 'CH poza UE = eksport');
  assert.equal(isIntraEuZeroRate('', 'NL'), false);
});

test('0% nie zależy od potwierdzenia w VIES — decyduje para krajów', () => {
  const seller = { name: 'HKL', country: 'PL' };
  const buyer = { name: 'TCN', country: 'NL', vatEuId: 'NL004148496B01' };

  const verified = resolveTaxTreatment({ seller, buyer, opts: { vatEuVerified: true } });
  const unverified = resolveTaxTreatment({ seller, buyer, opts: { vatEuVerified: false } });

  assert.equal(verified.taxRate, 0);
  assert.equal(unverified.taxRate, 0, 'brak potwierdzenia nie zmienia stawki');
  assert.equal(unverified.taxCategory, TaxCategory.INTRA_EU_GOODS);
  assert.match(unverified.notes.join(' '), /nie potwierdzono w VIES/, 'ale zostawia ostrzeżenie');
  assert.equal(verified.notes.length, 0);
});

test('0% także bez numeru VAT-UE w danych, z ostrzeżeniem', () => {
  const r = resolveTaxTreatment({
    seller: { name: 'HKL', country: 'PL' },
    buyer: { name: 'Klient', country: 'DE' }
  });
  assert.equal(r.taxRate, 0);
  assert.equal(r.taxCategory, TaxCategory.INTRA_EU_GOODS);
  assert.match(r.notes.join(' '), /bez numeru VAT-UE/);
});

test('InvoiceService: brak flagi w body ⇒ VIES jest odpytywany', async () => {
  const { InvoiceService } = require('../main');
  const calls = [];
  const service = new InvoiceService({
    log: () => {},
    vies: { check: async (vatId, country) => { calls.push({ vatId, country }); return { checked: true, valid: true, checkedAt: '2026-08-05T00:00:00.000Z' }; } }
  });

  const seller = { name: 'HKL', country: 'PL' };
  const buyer = { name: 'TCN', country: 'NL', vatEuId: 'NL004148496B01' };

  const auto = await service.verifyBuyerVatId(buyer, seller, { override: undefined });
  assert.equal(auto.verified, true);
  assert.equal(calls.length, 1, 'bez jawnej flagi weryfikacja musi się odpalić');

  // ⚠️ Regresja: kontroler wysyłał `vatEuVerified: false` dla każdego żądania,
  // co było traktowane jako ręczne nadpisanie i wyłączało VIES.
  const overridden = await service.verifyBuyerVatId(buyer, seller, { override: false });
  assert.equal(overridden.verified, false);
  assert.equal(calls.length, 1, 'jawne false pomija odpytanie usługi');

  const skipped = await service.verifyBuyerVatId(buyer, seller, { skip: true });
  assert.equal(skipped.checked, false);
  assert.equal(calls.length, 1);
});

test('InvoiceService: sprzedaż krajowa nie odpytuje VIES', async () => {
  const { InvoiceService } = require('../main');
  const calls = [];
  const service = new InvoiceService({ log: () => {}, vies: { check: async () => { calls.push(1); return { checked: true, valid: true }; } } });
  const r = await service.verifyBuyerVatId({ name: 'K', country: 'PL', vatEuId: 'PL1234567890' }, { name: 'HKL', country: 'PL' });
  assert.equal(calls.length, 0, 'PL→PL to sprzedaż krajowa — VIES nie dotyczy');
  assert.match(r.reason, /nie jest wewnątrzwspólnotowa/);
});

test('usługa wewnątrz UE → odwrotne obciążenie', () => {
  const r = resolveTaxTreatment({
    seller: { name: 'HKL', country: 'PL' },
    buyer: { name: 'TCN', country: 'NL', vatEuId: 'NL004148496B01' },
    opts: { isService: true, vatEuVerified: true }
  });
  assert.equal(r.taxCategory, TaxCategory.INTRA_EU_SERVICE);
  assert.equal(r.legalNoteKey, 'legal.reverse_charge');
});
