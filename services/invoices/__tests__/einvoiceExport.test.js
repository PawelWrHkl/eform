'use strict';

/**
 * Kolejka e-faktur (`einvoice/index.js`): konfiguracja z env, klasyfikacja odpowiedzi
 * usługi (kontrakt pkt 5) i przebieg na atrapach repozytorium i klienta — bez bazy i sieci.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EinvoiceEvent,
  TERMINAL_EVENTS,
  SENDABLE_STATUSES,
  readEinvoiceConfig,
  classifyResponse,
  runEinvoiceExport
} = require('../einvoice');
const { EinvoiceTransportError } = require('../einvoice/client');

const BASE_ENV = {
  EINVOICE_MODE: 'shadow',
  EINVOICE_URL: 'http://192.168.0.21:5031',
  EINVOICE_ENV: 'test',
  EINVOICE_SINCE: '2026-11-18',
  EINVOICE_API_KEY_LUXANGMBH: 'klucz-luxan',
  EINVOICE_API_KEY_HKL: 'klucz-hkl'
};

function invoiceFixture(id, overrides = {}) {
  return {
    id,
    level: 2,
    issuerType: 'organization',
    issuerId: 5,
    buyerType: 'user',
    buyerUserId: 873,
    documentType: 'invoice',
    number: `2026/0001${id}`,
    issueDate: '2026-11-18',
    saleDate: '2026-11-18',
    dueDate: '2026-12-02',
    currency: 'EUR',
    lang: 'de',
    seller: { name: 'Luxan GmbH', country: 'DE', vatEuId: 'DE814603367' },
    buyer: { name: 'Kunde GmbH', country: 'DE', vatEuId: 'DE123456789' },
    items: [{ position: 1, name: 'Plissee', unit: 'szt', quantity: 1, netAmount: 10000, taxCategory: 'standard', taxRate: 19, orderItemId: null, meta: {} }],
    taxLines: [{ taxCategory: 'standard', taxRate: 19, netAmount: 10000, taxAmount: 1900, grossAmount: 11900 }],
    totalNet: 10000,
    totalTax: 1900,
    totalGross: 11900,
    advanceSettled: 0,
    amountDue: 11900,
    ...overrides
  };
}

function rowFixture(id, overrides = {}) {
  return { id, number: `2026/0001${id}`, level: 2, issuer_type: 'organization', issuer_id: 5, issuer_ident: 'LUXANGMBH', order_id: 100 + id, buyer_name: 'Kunde GmbH', failures: 0, ...overrides };
}

const SOURCES = { issuer: { ident: 'LUXANGMBH', email: '' }, buyer: { ident: 'Kunde', email: null, phone: null }, paymentTermsDays: null, orders: [], orderItems: [], statuses: [], sendAddresses: [], corrected: null };

function fakeRepository(rows, invoices = {}) {
  const repo = {
    events: [],
    queries: [],
    findInvoicesForEinvoice: async (params) => { repo.queries.push(params); return rows; },
    getInvoice: async (id) => {
      if (invoices[id] instanceof Error) throw invoices[id];
      return invoices[id] || invoiceFixture(id);
    },
    getEinvoiceSources: async (invoice) => ({ ...SOURCES, issuer: { ident: invoice.level === 1 ? 'HKL' : 'LUXANGMBH', email: '' } }),
    addInvoiceEvent: async (e) => { repo.events.push(e); }
  };
  return repo;
}

/** Klient-atrapa: odpowiedzi po kolei (obiekt `{ httpStatus, body }` albo wyjątek). */
function fakeClient(responses) {
  const client = {
    calls: [],
    submit: async (payload, key) => {
      client.calls.push({ payload, key });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
  return client;
}

test('konfiguracja: domyślnie wyłączone; tryb cienia z kluczami per wystawca z env', () => {
  const off = readEinvoiceConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.active, false);
  assert.deepEqual(off.problems, []);

  const on = readEinvoiceConfig({ ...BASE_ENV, EINVOICE_API_KEY_LuxanGmbH_extra: '', EINVOICE_TIMEOUT_MS: '30000' });
  assert.equal(on.active, true, on.problems.join('; '));
  assert.deepEqual(on.keys, { LUXANGMBH: 'klucz-luxan', HKL: 'klucz-hkl' });
  assert.equal(on.timeoutMs, 120000, 'kontrakt: timeout co najmniej 120 s');
  assert.equal(on.maxPerRun, 10);
});

test('konfiguracja: EINVOICE_LEVELS_<IDENT> zawęża poziomy wystawcy (HKL tylko 1), zła lista = problem', () => {
  const cfg = readEinvoiceConfig({ ...BASE_ENV, EINVOICE_LEVELS_HKL: '1' });
  assert.equal(cfg.active, true);
  assert.deepEqual(cfg.levels, { LUXANGMBH: [1, 2, 3, 4], HKL: [1] });

  const bad = readEinvoiceConfig({ ...BASE_ENV, EINVOICE_LEVELS_HKL: '1,5' });
  assert.equal(bad.active, false);
  assert.match(bad.problems.join(' '), /EINVOICE_LEVELS_HKL/);
  // Wyłączone: błędna lista nie hałasuje w logu cyklu
  assert.deepEqual(readEinvoiceConfig({ ...BASE_ENV, EINVOICE_MODE: 'off', EINVOICE_LEVELS_HKL: 'x' }).problems, []);
});

test('konfiguracja: live odrzucony, braki wypisane, bez kluczy nie rusza', () => {
  const live = readEinvoiceConfig({ ...BASE_ENV, EINVOICE_MODE: 'live' });
  assert.equal(live.active, false);
  assert.match(live.problems.join(' '), /live/);

  const broken = readEinvoiceConfig({ EINVOICE_MODE: 'shadow', EINVOICE_SINCE: '2026-02-30', EINVOICE_URL: '192.168.0.21', EINVOICE_ENV: 'production' });
  assert.equal(broken.active, false);
  assert.equal(broken.problems.length, 4);
  assert.match(broken.problems.join(' '), /EINVOICE_SINCE.*EINVOICE_URL.*EINVOICE_ENV.*EINVOICE_API_KEY_/s);
});

test('klasyfikacja odpowiedzi (kontrakt pkt 5)', () => {
  assert.equal(classifyResponse({ httpStatus: 200, body: { status: 'ready' } }).event, EinvoiceEvent.READY);
  assert.equal(classifyResponse({ httpStatus: 200, body: { status: 'wyslana' } }).event, EinvoiceEvent.READY);
  assert.equal(classifyResponse({ httpStatus: 200, body: { status: 'stored_for_comparison' } }).event, EinvoiceEvent.STORED);
  assert.equal(classifyResponse({ httpStatus: 422, body: { status: 'held' } }).event, EinvoiceEvent.HELD);
  assert.equal(classifyResponse({ httpStatus: 409, body: { state: 'prod' } }).event, EinvoiceEvent.CONFLICT);
  assert.equal(classifyResponse({ httpStatus: 409, body: { state: 'generating' } }).event, null);
  assert.equal(classifyResponse({ httpStatus: 202, body: { status: 'generating' } }).event, null);
  assert.equal(classifyResponse({ httpStatus: 400, body: { detail: [{ loc: ['items', 0, 'unit'] }] } }).event, EinvoiceEvent.FAILED);
  assert.equal(classifyResponse({ httpStatus: 500, body: {} }).event, EinvoiceEvent.FAILED);
  for (const httpStatus of [401, 403, 503]) assert.equal(classifyResponse({ httpStatus, body: {} }).abort, true);
  // Prawdziwe odpowiedzi usługi: 400 schematu (19.11.2026) i brak klucza (18.11.2026)
  assert.equal(
    classifyResponse({ httpStatus: 400, body: { error: 'schema', errors: [{ loc: 'seller.email', msg: 'Input should be a valid string' }] } }).reason,
    'HTTP 400: seller.email: Input should be a valid string'
  );
  assert.equal(classifyResponse({ httpStatus: 401, body: { error: 'api key missing' } }).reason, 'HTTP 401: api key missing');
});

test('wyłączone: zero zapytań do bazy', async () => {
  const repo = fakeRepository([]);
  repo.findInvoicesForEinvoice = async () => { throw new Error('nie powinno pytać bazy'); };
  const result = await runEinvoiceExport({ config: readEinvoiceConfig({}), deps: { repository: repo, log: () => {} } });
  assert.equal(result.skipped, 'disabled');
});

test('przebieg: ready / HOLD / poziom 1 do porównania / 409 / 400 — każdy wynik zapisany, HOLD-y po polsku w logu', async () => {
  const rows = [rowFixture(1), rowFixture(2), rowFixture(3, { level: 1, issuer_type: 'manufacturer', issuer_id: 0, issuer_ident: 'HKL' }), rowFixture(4), rowFixture(5)];
  const repo = fakeRepository(rows, { 3: invoiceFixture(3, { level: 1, issuerType: 'manufacturer', issuerId: 0, buyerType: 'organization' }) });
  const client = fakeClient([
    { httpStatus: 200, body: { status: 'ready', mode: 'shadow', content_hash: 'c1', pdf_sha256: 'p1', xml_sha256: 'x1', warnings: [{ code: 'BUYER_EMAIL', pl: 'Brak adresu do faktur', en: '…' }], validation: { mustang: { overall: 'valid' } } } },
    { httpStatus: 422, body: { status: 'held', holds: [{ code: 'K_NO_VAT_ID', pl: '0 % WDT bez numeru VAT-UE nabywcy', en: '…' }] } },
    { httpStatus: 200, body: { status: 'stored_for_comparison', live_would_reject: 'LEVEL_UNSUPPORTED' } },
    { httpStatus: 409, body: { state: 'archived', number: '2026/00014' } },
    { httpStatus: 400, body: { detail: [{ loc: ['buyer', 'country'], msg: 'invalid' }] } }
  ]);
  const logs = [];
  const result = await runEinvoiceExport({ config: readEinvoiceConfig(BASE_ENV), deps: { repository: repo, client, log: (m) => logs.push(m) } });

  // Zapytanie kolejki: klucze → wystawcy, wszystkie poziomy, zdarzenia końcowe
  assert.deepEqual(repo.queries[0].issuerLevels, [
    ['LUXANGMBH', 1], ['LUXANGMBH', 2], ['LUXANGMBH', 3], ['LUXANGMBH', 4],
    ['HKL', 1], ['HKL', 2], ['HKL', 3], ['HKL', 4]
  ]);
  assert.deepEqual(repo.queries[0].terminalEvents, [...TERMINAL_EVENTS]);
  assert.deepEqual(repo.queries[0].statuses, [...SENDABLE_STATUSES]);
  assert.equal(repo.queries[0].since, '2026-11-18');

  // Klucz wystawcy i efor_env w treści
  assert.deepEqual(client.calls.map((c) => c.key), ['klucz-luxan', 'klucz-luxan', 'klucz-hkl', 'klucz-luxan', 'klucz-luxan']);
  assert.ok(client.calls.every((c) => c.payload.efor_env === 'test'));
  assert.equal(client.calls[2].payload.level, 1);

  assert.deepEqual(repo.events.map((e) => [e.invoiceId, e.eventType]), [
    [1, EinvoiceEvent.READY], [2, EinvoiceEvent.HELD], [3, EinvoiceEvent.STORED], [4, EinvoiceEvent.CONFLICT], [5, EinvoiceEvent.FAILED]
  ]);
  const ready = repo.events[0].payload;
  assert.equal(ready.pdf_sha256, 'p1');
  assert.equal(ready.mustang, 'valid');
  assert.match(ready.request_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(repo.events[1].payload.holds, [{ code: 'K_NO_VAT_ID', pl: '0 % WDT bez numeru VAT-UE nabywcy' }]);
  assert.match(repo.events[4].payload.error, /HTTP 400/);
  assert.ok(logs.some((l) => l.includes('HOLD: K_NO_VAT_ID — 0 % WDT bez numeru VAT-UE nabywcy')));
  assert.equal(result.done.length, 4);
  assert.equal(result.failed.length, 1);
});

test('401/403/503 albo brak sieci: przebieg przerwany, nic nie zapisane (to nie wina faktury)', async () => {
  for (const response of [{ httpStatus: 403, body: { detail: 'ip not allowed' } }, new EinvoiceTransportError('POST /v1/documents: ECONNREFUSED')]) {
    const repo = fakeRepository([rowFixture(1), rowFixture(2)]);
    const client = fakeClient([response, { httpStatus: 200, body: { status: 'ready' } }]);
    const logs = [];
    const result = await runEinvoiceExport({ config: readEinvoiceConfig(BASE_ENV), deps: { repository: repo, client, log: (m) => logs.push(m) } });
    assert.equal(client.calls.length, 1, 'po pierwszej awarii koniec przebiegu');
    assert.deepEqual(repo.events, []);
    assert.equal(result.failed.length, 1);
    assert.ok(logs.some((l) => /przerwany/.test(l)));
  }
});

test('w toku (202) i 409 generating: bez zdarzenia — wróci w następnym przebiegu', async () => {
  const repo = fakeRepository([rowFixture(1), rowFixture(2)]);
  const client = fakeClient([{ httpStatus: 202, body: { status: 'generating' } }, { httpStatus: 409, body: { state: 'generating' } }]);
  const result = await runEinvoiceExport({ config: readEinvoiceConfig(BASE_ENV), deps: { repository: repo, client, log: () => {} } });
  assert.deepEqual(repo.events, []);
  assert.equal(result.done.length + result.failed.length, 0);
});

test('błąd budowy treści: zdarzenie einvoice_failed bez wołania usługi, reszta idzie dalej', async () => {
  const repo = fakeRepository([rowFixture(1), rowFixture(2)], { 1: invoiceFixture(1, { currency: 'PLN' }) });
  const client = fakeClient([{ httpStatus: 200, body: { status: 'ready' } }]);
  const result = await runEinvoiceExport({ config: readEinvoiceConfig(BASE_ENV), deps: { repository: repo, client, log: () => {} } });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(repo.events.map((e) => [e.invoiceId, e.eventType]), [[1, EinvoiceEvent.FAILED], [2, EinvoiceEvent.READY]]);
  assert.match(repo.events[0].payload.error, /EUR/);
  assert.equal(result.failed[0].invoiceId, 1);
});

test('dry-run: lista do wysłania, bez usługi i bez zapisów', async () => {
  const repo = fakeRepository([rowFixture(1)]);
  const client = fakeClient([]);
  const result = await runEinvoiceExport({ dryRun: true, config: readEinvoiceConfig(BASE_ENV), deps: { repository: repo, client, log: () => {} } });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(repo.events, []);
  assert.equal(result.planned.length, 1);
  assert.equal(result.planned[0].items, 1);
});
