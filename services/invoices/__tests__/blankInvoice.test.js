'use strict';

/**
 * Faktura in blanco / refaktura (`InvoiceService.createBlank`, `POST /api/v1/invoices/blank`)
 * i numer szkicu z serii wystawcy (`InvoiceService.issue`) — 2026-11-16, refaktura transportu
 * Cozy → FENIX.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { InvoiceService } = require('../main');

const COZY_PROFILE = {
  issuerType: 'organization', issuerId: 1, level: 2, name: 'MaizonCozy B.V.', taxId: 'NL866455139B01', vatEuId: 'NL866455139B01',
  street: 'Stoofweg 7a', zip: '4681 RK', city: 'Nieuw-Vossemeer', country: 'NL', email: '', phone: '', registryNumbers: {},
  currency: 'EUR', localCurrency: 'EUR', paymentDays: 14, templateCode: 'COZY', numberPattern: '{YY}{NR:6}', legalSettings: {}
};

function fakeRepository() {
  const repo = {
    saved: [],
    async getIssuerProfile() { return COZY_PROFILE; },
    async getOrganizationProfile(id) {
      if (Number(id) === 1) return { organizationId: 1, orgCode: 'Cozy', templateCode: 'COZY', localCurrency: 'EUR', defaultPaymentDays: 14, defaultPaymentMethod: 'transfer', seller: {} };
      if (Number(id) === 2) return { organizationId: 2, orgCode: 'FENIX', seller: { name: 'FENIX Sonnenschutz UG', taxId: 'DE293796843', street: 'Str. 1', zip: '10115', city: 'Berlin', country: 'DE', email: '', phone: '' } };
      return null;
    },
    async createInvoice(invoice, opts) { repo.saved.push({ invoice, opts }); return { id: 77, number: opts.assignNumber ? '26000009' : null }; }
  };
  return repo;
}

const service = (repository) => new InvoiceService({
  repository,
  log: () => {},
  vies: { check: async () => ({ checked: false, valid: false }) },
  currency: { getRate: async () => { throw new Error('bez sieci w teście'); } },
  now: () => new Date('2026-11-16T10:00:00Z')
});

test('in blanco: refaktura transportu Cozy → FENIX (organizacja) — usługa, seria Cozy, adnotacja po niemiecku, szkic bez numeru', async () => {
  const repo = fakeRepository();
  const result = await service(repo).createBlank({
    issuerOrganizationId: 1,
    buyer: { type: 'organization', id: 2 },
    items: [{ name: 'Transportkosten', description: 'Spedition 12.11', quantity: 2, unit: 'usl', unitPriceNet: 62.75, isService: true }],
    rebillSource: 'DHL 4711',
    notes: 'Danke',
    skipVies: true
  });
  assert.equal(result.id, 77);
  assert.equal(result.number, null);
  const { invoice, opts } = repo.saved[0];
  assert.equal(opts.assignNumber, false);
  assert.equal(invoice.status, 'draft');
  assert.equal(invoice.numberPattern, '{YY}{NR:6}');
  assert.equal(invoice.issuerType, 'organization');
  assert.equal(invoice.issuerId, 1);
  assert.equal(invoice.organizationId, 1);
  assert.equal(invoice.orderId, null);
  assert.equal(invoice.priceBasis, 'manual');
  assert.equal(invoice.buyerType, 'organization');
  assert.equal(invoice.buyer.name, 'FENIX Sonnenschutz UG');
  assert.equal(invoice.lang, 'de', 'język według kraju nabywcy');
  assert.equal(invoice.orderName, 'Weiterberechnung');
  assert.equal(invoice.notes, 'Weiterberechnung von Kosten: DHL 4711. Danke');
  assert.equal(invoice.templateCode, 'COZY');
  assert.equal(invoice.totalNet, 12550, '2 × 62,75 EUR w groszach');
  assert.equal(invoice.items[0].quantity, 2);
  assert.equal(invoice.items[0].unit, 'usl');
  assert.equal(invoice.items[0].meta.isService, true);
  assert.equal(invoice.items[0].taxRate, 0, 'usługa NL → DE dla firmy: odwrotne obciążenie');
});

test('in blanco: nabywca wpisany ręcznie, wystawienie od razu; bez kraju albo z zerową kwotą — odmowa', async () => {
  const repo = fakeRepository();
  const ok = await service(repo).createBlank({
    issuerOrganizationId: 1,
    buyer: { type: 'manual', name: 'Klant BV', country: 'nl', street: 'Weg 1', zip: '1000 AA', city: 'Amsterdam' },
    items: [{ name: 'Reparatie', quantity: 1, unitPriceNet: 100, isService: true }],
    issue: true,
    skipVies: true
  });
  assert.equal(ok.number, '26000009');
  assert.equal(repo.saved[0].opts.assignNumber, true);
  assert.equal(repo.saved[0].invoice.buyerType, 'manual');
  assert.equal(repo.saved[0].invoice.buyer.country, 'NL');
  assert.equal(repo.saved[0].invoice.notes, '', 'zwykła faktura in blanco bez adnotacji refaktury');
  assert.equal(repo.saved[0].invoice.items[0].taxRate, 21, 'krajowa NL: 21 %');

  await assert.rejects(() => service(fakeRepository()).createBlank({
    issuerOrganizationId: 1, buyer: { type: 'manual', name: 'Bez kraju' }, items: [{ name: 'X', quantity: 1, unitPriceNet: 1 }], skipVies: true
  }), /Brak nazwy albo kraju nabywcy/);
  await assert.rejects(() => service(fakeRepository()).createBlank({
    issuerOrganizationId: 1, buyer: { type: 'organization', id: 2 }, items: [{ name: 'X', quantity: 1, unitPriceNet: 0 }], skipVies: true
  }), /dodatnią wartość netto/);
  await assert.rejects(() => service(fakeRepository()).createBlank({
    issuerOrganizationId: 99, buyer: { type: 'organization', id: 2 }, items: [{ name: 'X', quantity: 1, unitPriceNet: 1 }], skipVies: true
  }).catch((e) => { throw e; }), /nie istnieje/);
});

test('issue(): szkic faktury z wystawcą dostaje numer z SERII WYSTAWCY (Cozy 26000008), korekta — stary licznik', async () => {
  const calls = { issuer: [], legacy: [], updates: [] };
  const draft = (documentType) => ({ id: 5, status: 'draft', documentType, issuerType: 'organization', issuerId: 1, level: 2, organizationId: 1, issueDate: '2026-11-16' });
  let current = draft('invoice');
  const repo = {
    async getInvoice() { return current; },
    async getOrganizationProfile() { return { orgCode: 'Cozy', numberPatterns: { invoice: '{YY}{NR:6}' } }; },
    async getIssuerProfile() { return COZY_PROFILE; },
    async allocateIssuerSequence(p) { calls.issuer.push(p); return 8; },
    async allocateSequence(p) { calls.legacy.push(p); return 3; },
    async updateStatus(id, patch) { calls.updates.push(patch); return true; }
  };
  const result = await service(repo).issue(5, { actorPin: 'admin' });
  assert.equal(result.number, '26000008');
  assert.deepEqual(calls.issuer, [{ issuerType: 'organization', issuerId: 1, level: 2, year: 2026 }]);
  assert.equal(calls.legacy.length, 0);

  current = draft('correction');
  const corr = await service(repo).issue(5, {});
  assert.equal(calls.legacy.length, 1, 'korekta zostaje przy swoim liczniku');
  assert.match(corr.number, /^KOR\/2026\/11\/3$/);
});

test('POST /blank: walidacja żądania (granica zaufania)', () => {
  const { parseBlankRequest } = require('../http/routes');
  const good = parseBlankRequest({
    issuerOrganizationId: '1',
    buyer: { type: 'manual', name: ' FENIX ', country: 'de', vatEuId: 'de 293 796 843' },
    items: [{ name: 'Transport', quantity: '1.5', unitPriceNet: '125.50', unit: 'usl', isService: true }],
    paymentDays: '30', lang: 'de', rebill: true, rebillSource: 'DHL 4711'
  });
  assert.deepEqual(good.errors, []);
  assert.equal(good.params.buyer.name, 'FENIX');
  assert.equal(good.params.buyer.country, 'DE');
  assert.equal(good.params.buyer.vatEuId, 'DE293796843');
  assert.equal(good.params.items[0].quantity, 1.5);
  assert.equal(good.params.paymentDays, 30);
  assert.equal(good.params.rebillSource, 'DHL 4711');
  assert.equal(parseBlankRequest({ ...good, rebill: false, issuerOrganizationId: 1, buyer: { type: 'organization', id: 2 }, items: good.params.items }).params.rebillSource, null);

  const bad = parseBlankRequest({
    buyer: { type: 'manual', name: '', country: 'Deutschland' },
    items: [{ name: '', quantity: 0, unitPriceNet: 1.234 }],
    paymentDays: 400, saleDate: '16.11.2026'
  });
  for (const msg of ['Wybierz wystawcę', 'Podaj nazwę nabywcy', 'Kraj nabywcy', 'Pozycja 1: brak nazwy', 'Pozycja 1: ilość', 'Pozycja 1: cena', 'Nieprawidłowa data: saleDate', 'Termin płatności']) {
    assert.ok(bad.errors.some((e) => e.startsWith(msg)), `brak błędu: ${msg} (są: ${bad.errors.join(' | ')})`);
  }
  assert.ok(parseBlankRequest({ issuerOrganizationId: 1, buyer: { type: 'x' }, items: [] }).errors.includes('Faktura musi mieć od 1 do 100 pozycji'));
});

test('in blanco: podsumowanie bez zapisu — kwoty per stawka, nota prawna w języku dokumentu, orientacyjny numer z licznika', async () => {
  const repo = fakeRepository();
  repo.peekIssuerSequence = async (p) => { repo.peek = p; return 8; };
  const s = await service(repo).previewBlank({
    issuerOrganizationId: 1, buyer: { type: 'organization', id: 2 },
    items: [{ name: 'Transportkosten', quantity: 1, unit: 'usl', unitPriceNet: 185.4, isService: true }, { name: 'Montage', quantity: 2, unitPriceNet: 50, isService: true }]
  });
  assert.equal(repo.saved.length, 0, 'podgląd niczego nie zapisuje');
  assert.deepEqual(repo.peek, { issuerType: 'organization', issuerId: 1, level: 2, year: 2026 });
  assert.equal(s.expectedNumber, '26000009');
  assert.equal(s.lang, 'de');
  assert.deepEqual(s.totals, { net: 285.4, tax: 0, gross: 285.4 });
  assert.equal(s.taxLines.length, 1);
  assert.equal(s.taxLines[0].taxCategory, 'intra_eu_service');
  assert.ok(s.taxLines[0].legalNote.length > 10, 'nota o odwrotnym obciążeniu');
  assert.deepEqual(s.items.map((i) => i.net), [185.4, 100]);
});

test('in blanco: szkic pamięta dane formularza (compliance.blank) do wznowienia i „nowa na podstawie”', async () => {
  const repo = fakeRepository();
  await service(repo).createBlank({
    issuerOrganizationId: 1, buyer: { type: 'organization', id: 2 }, paymentDays: 30,
    items: [{ name: 'X', quantity: 1, unitPriceNet: 10, isService: true }], rebillSource: 'DHL 1', notes: 'Danke', skipVies: true
  });
  assert.deepEqual(repo.saved[0].invoice.compliance.blank, { rebillSource: 'DHL 1', notes: 'Danke', paymentDays: 30, buyer: { type: 'organization', id: 2 } });
  assert.equal(repo.saved[0].invoice.dueDate, '2026-12-16');
});

test('POST /blank: błędy z kodem przy polu (panel tłumaczy blank_err_<kod>)', () => {
  const { parseBlankRequest } = require('../http/routes');
  const r = parseBlankRequest({
    issuerOrganizationId: 1,
    buyer: { type: 'manual', name: 'X', country: 'DE', vatEuId: '12345', email: 'zły' },
    items: [{ name: 'A', quantity: '1,5', unitPriceNet: '10,00' }, { name: '', quantity: 1, unitPriceNet: 1 }]
  });
  assert.deepEqual(r.fieldErrors, [
    { field: 'b_vatEuId', code: 'buyer_vat' },
    { field: 'b_email', code: 'buyer_email' },
    { field: 'items.1.name', code: 'item_name' }
  ]);
  assert.equal(r.params.items[0].quantity, 1.5, 'przecinek dziesiętny');
  assert.equal(r.params.items[0].unitPriceNet, 10);
});
