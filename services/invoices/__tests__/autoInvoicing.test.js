'use strict';

/**
 * Automat faktur (`autoInvoicing.js`) — konfiguracja z env i przebieg na
 * atrapach repozytorium/serwisu (bez bazy i sieci).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readAutoInvoiceConfig, runAutoInvoicing, AUTO_ACTOR } = require('../autoInvoicing');
const { HKL_ORG_ID } = require('../core/pricing');

const quiet = () => {};
const ON = { invoicesEnabled: true };

test('konfiguracja: bez zmiennych automat jest wyłączony', () => {
  const cfg = readAutoInvoiceConfig({}, ON);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.active, false);
  assert.deepEqual(cfg.problems, []);
});

test('konfiguracja: włączony bez daty progowej NIE rusza', () => {
  const cfg = readAutoInvoiceConfig({ INVOICE_AUTOGEN_ENABLED: 'true' }, ON);
  assert.equal(cfg.active, false);
  assert.match(cfg.problems.join(' '), /INVOICE_AUTOGEN_SINCE/);
});

test('konfiguracja: nieistniejąca data (30 lutego) jest odrzucana', () => {
  const cfg = readAutoInvoiceConfig({ INVOICE_AUTOGEN_ENABLED: 'true', INVOICE_AUTOGEN_SINCE: '2026-02-30' }, ON);
  assert.equal(cfg.since, null);
  assert.equal(cfg.active, false);
});

test('konfiguracja: wyłączony moduł faktur blokuje automat', () => {
  const cfg = readAutoInvoiceConfig({ INVOICE_AUTOGEN_ENABLED: 'true', INVOICE_AUTOGEN_SINCE: '2026-10-01' }, { invoicesEnabled: false });
  assert.equal(cfg.active, false);
  assert.match(cfg.problems.join(' '), /INVOICES_ENABLED/);
});

test('konfiguracja: domyślnie poziom 2, wystawianie z numerem, limit 100', () => {
  const cfg = readAutoInvoiceConfig({ INVOICE_AUTOGEN_ENABLED: 'true', INVOICE_AUTOGEN_SINCE: '2026-10-01' }, ON);
  assert.equal(cfg.active, true);
  assert.deepEqual(cfg.levels, [2]);
  assert.equal(cfg.issue, true);
  assert.equal(cfg.maxPerRun, 100);
  assert.deepEqual(cfg.organizationIds, []);
});

test('konfiguracja: poziomy spoza 1–2 są pomijane z ostrzeżeniem, reszta działa', () => {
  const cfg = readAutoInvoiceConfig({
    INVOICE_AUTOGEN_ENABLED: 'true',
    INVOICE_AUTOGEN_SINCE: '2026-10-01',
    INVOICE_AUTOGEN_LEVELS: '2, 1, 3',
    INVOICE_AUTOGEN_ORGS: '3;5 x',
    INVOICE_AUTOGEN_ISSUE: 'false',
    INVOICE_AUTOGEN_MAX_PER_RUN: '20'
  }, ON);
  assert.deepEqual(cfg.levels, [1, 2]);
  assert.equal(cfg.active, true);
  assert.match(cfg.problems.join(' '), /pominięto: 3/);
  assert.deepEqual(cfg.organizationIds, [3, 5]);
  assert.equal(cfg.issue, false);
  assert.equal(cfg.maxPerRun, 20);
});

function config(overrides = {}) {
  return {
    ...readAutoInvoiceConfig({ INVOICE_AUTOGEN_ENABLED: 'true', INVOICE_AUTOGEN_SINCE: '2026-10-01' }, ON),
    ...overrides
  };
}

function order(id, extra = {}) {
  return { id, order_idx: String(id), organization_id: 5, user_ident: `U${id}`, ...extra };
}

/** Atrapa repozytorium: kandydaci per poziom + rejestr zapytań. */
function fakeRepository(candidatesByLevel, { existing = [] } = {}) {
  const queries = [];
  return {
    queries,
    findAutoInvoiceCandidates: async (params) => {
      queries.push(params);
      return (candidatesByLevel[params.level] || []).slice(0, params.limit);
    },
    hasLevelInvoice: async ({ orderId }) => existing.includes(orderId)
  };
}

function fakeService({ failFor = [] } = {}) {
  const calls = [];
  return {
    calls,
    createFromOrder: async (params) => {
      calls.push(params);
      if (failFor.includes(params.orderId)) throw new Error('Zamówienie ma zerową wartość netto');
      return { id: 900 + params.orderId, number: params.issue ? `2026/${params.orderId}` : null };
    }
  };
}

test('przebieg: wyłączony automat niczego nie szuka', async () => {
  const repository = fakeRepository({ 2: [order(1)] });
  const result = await runAutoInvoicing({ config: readAutoInvoiceConfig({}, ON), deps: { repository, service: fakeService(), log: quiet } });
  assert.equal(result.skipped, 'disabled');
  assert.deepEqual(repository.queries, []);
});

test('przebieg: wystawia fakturę z numerem jako AUTO, typ invoice', async () => {
  const repository = fakeRepository({ 2: [order(1), order(2)] });
  const service = fakeService();
  const result = await runAutoInvoicing({ config: config(), deps: { repository, service, log: quiet } });

  assert.deepEqual(result.created.map((c) => c.number), ['2026/1', '2026/2']);
  assert.deepEqual(service.calls[0], { orderId: 1, level: 2, documentType: 'invoice', issue: true, createdByPin: AUTO_ACTOR });
  assert.equal(repository.queries[0].since, '2026-10-01');
  // Poziom 2 nie wyklucza żadnej organizacji
  assert.equal(repository.queries[0].excludeOrganizationId, null);
});

test('przebieg: INVOICE_AUTOGEN_ISSUE=false → szkice bez numeru', async () => {
  const service = fakeService();
  const result = await runAutoInvoicing({
    config: config({ issue: false }),
    deps: { repository: fakeRepository({ 2: [order(1)] }), service, log: quiet }
  });
  assert.equal(service.calls[0].issue, false);
  assert.equal(result.created[0].number, null);
});

test('przebieg: dry-run tylko wypisuje kandydatów', async () => {
  const service = fakeService();
  const result = await runAutoInvoicing({
    dryRun: true,
    config: config(),
    deps: { repository: fakeRepository({ 2: [order(1)] }), service, log: quiet }
  });
  assert.equal(result.planned.length, 1);
  assert.deepEqual(service.calls, []);
});

test('przebieg: faktura wystawiona w międzyczasie ręcznie → pomijamy', async () => {
  const service = fakeService();
  const result = await runAutoInvoicing({
    config: config(),
    deps: { repository: fakeRepository({ 2: [order(1), order(2)] }, { existing: [1] }), service, log: quiet }
  });
  assert.equal(result.skippedExisting, 1);
  assert.deepEqual(service.calls.map((c) => c.orderId), [2]);
});

test('przebieg: błąd jednego zamówienia nie zatrzymuje pozostałych', async () => {
  const result = await runAutoInvoicing({
    config: config(),
    deps: { repository: fakeRepository({ 2: [order(1), order(2)] }), service: fakeService({ failFor: [1] }), log: quiet }
  });
  assert.deepEqual(result.failed.map((f) => f.orderId), [1]);
  assert.deepEqual(result.created.map((c) => c.orderId), [2]);
});

test('przebieg: poziom 1 wyklucza HKL, filtr organizacji przekazany do zapytania', async () => {
  const repository = fakeRepository({ 1: [order(1)] });
  await runAutoInvoicing({
    config: config({ levels: [1], organizationIds: [5] }),
    deps: { repository, service: fakeService(), log: quiet }
  });
  assert.equal(repository.queries[0].excludeOrganizationId, HKL_ORG_ID);
  assert.deepEqual(repository.queries[0].organizationIds, [5]);
});

test('przebieg: limit na przebieg obejmuje wszystkie poziomy łącznie', async () => {
  const repository = fakeRepository({ 1: [order(1), order(2)], 2: [order(3), order(4)] });
  const service = fakeService();
  await runAutoInvoicing({
    config: config({ levels: [1, 2], maxPerRun: 3 }),
    deps: { repository, service, log: quiet }
  });
  assert.deepEqual(service.calls.map((c) => [c.level, c.orderId]), [[1, 1], [1, 2], [2, 3]]);
  assert.equal(repository.queries[1].limit, 1);
});
