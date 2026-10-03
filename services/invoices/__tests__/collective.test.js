'use strict';

/**
 * Fakturowanie niestandardowe — faktura zbiorcza za tydzień/miesiąc
 * (`core/collective.js`, `InvoiceService.createCollective`, krok automatu).
 * Bez bazy i sieci.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { periodFor, isPeriodClosed, groupCollectiveCandidates, normalizeSchedule } = require('../core/collective');
const { runAutoInvoicing, readAutoInvoiceConfig, AUTO_ACTOR } = require('../autoInvoicing');

const quiet = () => {};

test('normalizeSchedule: tylko weekly/monthly, reszta = standard', () => {
  assert.equal(normalizeSchedule('Monthly'), 'monthly');
  assert.equal(normalizeSchedule(' weekly '), 'weekly');
  assert.equal(normalizeSchedule(''), null);
  assert.equal(normalizeSchedule('daily'), null);
  assert.equal(normalizeSchedule(null), null);
});

test('periodFor: miesiąc kalendarzowy (także luty i grudzień)', () => {
  assert.deepEqual(periodFor('2026-09-17', 'monthly'), { schedule: 'monthly', key: '2026-09', start: '2026-09-01', end: '2026-09-30' });
  assert.equal(periodFor('2028-02-10', 'monthly').end, '2028-02-29', 'rok przestępny');
  assert.equal(periodFor('2026-12-31', 'monthly').end, '2026-12-31');
  // mysql2 zwraca DATE jako obiekt Date o lokalnej północy
  assert.equal(periodFor(new Date(2026, 8, 30), 'monthly').key, '2026-09');
});

test('periodFor: tydzień poniedziałek–niedziela, numer ISO', () => {
  assert.deepEqual(periodFor('2026-10-01', 'weekly'), { schedule: 'weekly', key: '2026-W40', start: '2026-09-28', end: '2026-10-04' });
  assert.equal(periodFor('2026-10-04', 'weekly').start, '2026-09-28', 'niedziela należy do tygodnia od poniedziałku');
  // Przełom roku: 1 stycznia 2027 (piątek) należy do ostatniego tygodnia 2026
  assert.equal(periodFor('2027-01-01', 'weekly').key, '2026-W53');
  // 1 stycznia 2026 (czwartek) to już pierwszy tydzień 2026
  assert.equal(periodFor('2026-01-01', 'weekly').key, '2026-W01');
});

test('isPeriodClosed: dzień zapasu po końcu okresu', () => {
  const sept = periodFor('2026-09-10', 'monthly');
  assert.equal(isPeriodClosed(sept, '2026-09-30'), false);
  assert.equal(isPeriodClosed(sept, '2026-10-01'), false, 'statusy z ostatniego dnia mogą jeszcze dojść');
  assert.equal(isPeriodClosed(sept, '2026-10-02'), true);
  const week = periodFor('2026-10-01', 'weekly'); // 28.09–04.10
  assert.equal(isPeriodClosed(week, '2026-10-05'), false);
  assert.equal(isPeriodClosed(week, '2026-10-06'), true, 'tydzień zamyka się we wtorek');
});

test('groupCollectiveCandidates: klient + sklep grupowy + okres, otwarte okresy czekają', () => {
  const rows = [
    { id: 1, user_id: 7, user_ident: 'TCN', delivery_date: '2026-09-03', invoice_schedule: 'monthly' },
    { id: 2, user_id: 7, user_ident: 'TCN', delivery_date: '2026-09-28', invoice_schedule: 'monthly' },
    { id: 3, user_id: 7, user_ident: 'TCN', delivery_date: '2026-08-20', invoice_schedule: 'monthly' }, // zaległe z sierpnia
    { id: 4, user_id: 7, user_ident: 'TCN', group_user_id: 11, delivery_date: '2026-09-05', invoice_schedule: 'monthly' },
    { id: 5, user_id: 7, user_ident: 'TCN', delivery_date: '2026-10-01', invoice_schedule: 'monthly' }, // październik otwarty
    { id: 6, user_id: 9, user_ident: 'X', delivery_date: '2026-09-29', invoice_schedule: 'weekly' },
    { id: 7, user_id: 9, user_ident: 'X', delivery_date: '2026-09-30', invoice_schedule: 'standard' } // nieznany = pomijany
  ];
  const groups = groupCollectiveCandidates(rows, { todayIso: '2026-10-07' });
  assert.deepEqual(groups.map((g) => [g.userId, g.groupUserId, g.period.key, g.orderIds]), [
    [7, null, '2026-08', [3]],
    [7, null, '2026-09', [1, 2]],
    [7, 11, '2026-09', [4]],
    [9, null, '2026-W40', [6]]
  ]);
  assert.equal(groups[1].userIdent, 'TCN');
});

/* ------------------------------------------------------------------ */
/* InvoiceService.createCollective                                     */
/* ------------------------------------------------------------------ */

function source(orderId, { userId = 9, idx = String(orderId), prod = '!sent!', price = '100.00', groupUserId = null } = {}) {
  return {
    order: { id: orderId, organization_id: 3, order_idx: idx, status: 'sent', prod_status: prod, group_user_id: groupUserId, commision: `Zam ${idx}` },
    orderItems: [{ id: orderId * 10, total_price: price, json_parameters: { ILOSC: 1 } }],
    organization: { id: 3, name: 'HKL', country: 'PL' },
    user: { id: userId, client_name: 'Klient', country: 'PL' },
    groupShop: null
  };
}

function fakeRepository(sources) {
  const saved = [];
  return {
    saved,
    async getOrderInvoiceSource(id) { return sources[id] || null; },
    async getOrganizationProfile(id) {
      return { organizationId: id, orgCode: 'HKL', seller: { name: 'HKL', country: 'PL' }, localCurrency: 'PLN', defaultCurrency: 'EUR', defaultPaymentDays: 14, defaultLang: 'pl', templateCode: 'default', numberPatterns: {}, footerNotes: {} };
    },
    async getIssuerProfile() {
      return { issuerType: 'organization', issuerId: 3, level: 2, name: 'HKL', country: 'PL', taxId: '955', registryNumbers: {}, currency: 'EUR', localCurrency: 'PLN', paymentDays: 14, defaultLang: 'pl', templateCode: 'default', themeVars: {}, numberPattern: '{YYYY}/{NR:5}', legalSettings: {}, footerNotes: {} };
    },
    async getAllocatedQuantities() { return new Map(); },
    async getEndClient() { return null; },
    async getAdvanceInvoicesForOrder() { return []; },
    async createInvoice(invoice) { saved.push(invoice); return { id: 50, number: invoice.status === 'issued' ? '2026/00100' : null }; }
  };
}

function service(repository) {
  const { InvoiceService } = require('../main');
  return new InvoiceService({
    repository,
    log: quiet,
    vies: { check: async () => ({ checked: false, valid: false }) },
    currency: { getRate: async () => null },
    now: () => new Date(2026, 9, 2, 1, 0)
  });
}

const SEPT = { key: '2026-09', start: '2026-09-01', end: '2026-09-30' };

test('createCollective: jedna faktura z pozycji wszystkich zamówień, numer zamówienia przy pozycji', async () => {
  const repository = fakeRepository({ 1: source(1, { idx: '201' }), 2: source(2, { idx: '202', price: '50.00' }) });
  const result = await service(repository).createCollective({ orderIds: [1, 2], period: SEPT, createdByPin: AUTO_ACTOR });
  const inv = repository.saved[0];

  assert.equal(result.number, '2026/00100');
  assert.equal(inv.orderId, null, 'dokument dotyczy wielu zamówień');
  assert.equal(inv.orderRef, '201, 202');
  assert.equal(inv.saleDate, '2026-09-30', 'data sprzedaży = koniec okresu');
  assert.equal(inv.deliveryDate, '2026-09-30');
  assert.deepEqual(inv.items.map((i) => [i.orderItemId, i.orderNumber]), [[10, '201'], [20, '202']]);
  assert.equal(inv.totalNet, 15000);
  assert.match(inv.notes, /Faktura zbiorcza za okres .*Zamówienia: 201, 202/);
  assert.equal(inv.level, 2);
});

test('createCollective: zamówienia różnych klientów albo bez !sent! — odmowa bez zapisu', async () => {
  const mixed = fakeRepository({ 1: source(1), 2: source(2, { userId: 99 }) });
  await assert.rejects(service(mixed).createCollective({ orderIds: [1, 2], period: SEPT }), /jednego klienta/);
  const notShipped = fakeRepository({ 1: source(1), 2: source(2, { prod: '!production!' }) });
  await assert.rejects(service(notShipped).createCollective({ orderIds: [1, 2], period: SEPT }), /!sent!/);
  const otherShop = fakeRepository({ 1: source(1), 2: source(2, { groupUserId: 5 }) });
  await assert.rejects(service(otherShop).createCollective({ orderIds: [1, 2], period: SEPT }), /sklepu grupowego/);
  assert.deepEqual([...mixed.saved, ...notShipped.saved, ...otherShop.saved], []);
});

test('createCollective: długa lista zamówień mieści się w order_ref (64 znaki)', async () => {
  const sources = {};
  const ids = [];
  for (let i = 1; i <= 30; i++) { sources[i] = source(i, { idx: String(1000 + i) }); ids.push(i); }
  const repository = fakeRepository(sources);
  await service(repository).createCollective({ orderIds: ids, period: SEPT });
  const ref = repository.saved[0].orderRef;
  assert.ok(ref.length <= 64, ref);
  assert.equal(ref, '1001…1030 (30)');
});

test('createFromOrder bez zmian: pozycja bez numeru zamówienia (bierze nagłówek)', async () => {
  const repository = fakeRepository({ 1: source(1, { idx: '201' }) });
  await service(repository).createFromOrder({ orderId: 1, level: 2 });
  const inv = repository.saved[0];
  assert.equal(inv.orderId, 1);
  assert.equal(inv.orderRef, '201');
  assert.equal(inv.items[0].orderNumber, undefined);
});

/* ------------------------------------------------------------------ */
/* Krok automatu                                                       */
/* ------------------------------------------------------------------ */

function autoConfig() {
  return { ...readAutoInvoiceConfig({ INVOICE_AUTOGEN_ENABLED: 'true', INVOICE_AUTOGEN_SINCE: '2026-01-01' }, { invoicesEnabled: true }) };
}

function autoRepository(rows, { invoiced = [] } = {}) {
  return {
    async findAutoInvoiceCandidates() { return []; },
    async findCollectiveCandidates() { return rows; },
    async hasLevelInvoice({ orderId }) { return invoiced.includes(orderId); }
  };
}

test('automat: faktura zbiorcza za zamknięty okres, otwarty czeka', async () => {
  const calls = [];
  const svc = { createCollective: async (p) => { calls.push(p); return { id: 1, number: '2026/00200' }; } };
  const rows = [
    { id: 1, user_id: 7, user_ident: 'TCN', delivery_date: '2026-09-03', invoice_schedule: 'monthly' },
    { id: 2, user_id: 7, user_ident: 'TCN', delivery_date: '2026-09-29', invoice_schedule: 'monthly' },
    { id: 3, user_id: 7, user_ident: 'TCN', delivery_date: '2026-10-01', invoice_schedule: 'monthly' }
  ];
  const result = await runAutoInvoicing({
    config: autoConfig(),
    deps: { repository: autoRepository(rows), service: svc, log: quiet, now: () => new Date(2026, 9, 2, 1, 0) }
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].orderIds, [1, 2]);
  assert.equal(calls[0].period.key, '2026-09');
  assert.equal(calls[0].createdByPin, AUTO_ACTOR);
  assert.equal(result.created[0].collective, true);
});

test('automat: zamówienie zafakturowane w międzyczasie ręcznie wypada z faktury zbiorczej', async () => {
  const calls = [];
  const svc = { createCollective: async (p) => { calls.push(p); return { id: 1, number: 'X' }; } };
  const rows = [
    { id: 1, user_id: 7, delivery_date: '2026-09-03', invoice_schedule: 'monthly' },
    { id: 2, user_id: 7, delivery_date: '2026-09-04', invoice_schedule: 'monthly' }
  ];
  await runAutoInvoicing({
    config: autoConfig(),
    deps: { repository: autoRepository(rows, { invoiced: [1] }), service: svc, log: quiet, now: () => new Date(2026, 9, 5) }
  });
  assert.deepEqual(calls[0].orderIds, [2]);
});

test('automat: dry-run wypisuje faktury zbiorcze bez wystawiania', async () => {
  const svc = { createCollective: async () => { throw new Error('nie powinno'); } };
  const result = await runAutoInvoicing({
    dryRun: true,
    config: autoConfig(),
    deps: {
      repository: autoRepository([{ id: 1, user_id: 7, delivery_date: '2026-09-03', invoice_schedule: 'weekly' }]),
      service: svc,
      log: quiet,
      now: () => new Date(2026, 9, 5)
    }
  });
  assert.equal(result.planned.length, 1);
  assert.equal(result.planned[0].collective, true);
});
