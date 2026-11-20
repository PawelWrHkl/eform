'use strict';

/**
 * Koszty transportu (`transport.js`): zapytanie dnia z status.txt, bramka faktur,
 * linie, biuro, ponowienia i alarmy (decyzje Pawła 20.11.2026). Bez sieci i bazy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../transport');
const { runAutoInvoicing, readAutoInvoiceConfig } = require('../autoInvoicing');

const MIN = 60 * 1000;
const HEADER = 'ORGANIZATIONIDENT\tUSERIDENT\tORDERNO\tORDERPOS\tSTATUS\tSHIPPINGDATE\tPARCELCODE\tSTATUSPROD\tMAXSTATUSPROD';
const row = (user, no, pos, day, parcel = 'UPS 1Z1', status = '!sent!', org = 'LuxanGmbH') => [org, user, no, pos, status, day, parcel, '100%', '100%'].join('\t');

const CONFIG = T.readTransportConfig({
  TRANSPORT_ENABLED: 'true', TRANSPORT_SINCE: '2026-11-20', TRANSPORT_API_URL: 'http://api', TRANSPORT_API_KEY: 'k',
  TRANSPORT_ALARM_TO: 'alarm@example.test', TRANSPORT_STATE_FILE: '/nie/uzywany'
});

test('numer tymczasowy sortuje się za prawdziwymi numerami (API wybiera najniższy jako tekst)', () => {
  const sorted = [T.tempInvoiceNo(5), '26004470', '2026/00031', 'FV/2026/11/3', 'KOR/2026/1'].sort();
  assert.equal(sorted.at(-1), T.tempInvoiceNo(5));
  assert.equal(T.isTempInvoiceNo(T.tempInvoiceNo(5)), true);
  assert.equal(T.isTempInvoiceNo('26004470'), false);
});

test('konfiguracja: domyślnie wyłączona; włączona wymaga daty, adresu i klucza; biuro = adres alarmu', () => {
  assert.equal(T.readTransportConfig({}).enabled, false);
  const bad = T.readTransportConfig({ TRANSPORT_ENABLED: 'true', TRANSPORT_SINCE: '2026-02-30' });
  assert.equal(bad.since, null);
  assert.match(bad.problems.join(' '), /TRANSPORT_SINCE/);
  assert.match(bad.problems.join(' '), /TRANSPORT_API_KEY/);
  assert.deepEqual(CONFIG.problems, []);
  assert.deepEqual(CONFIG.orgIdents, ['LUXANGMBH']);
  assert.equal(CONFIG.officeTo, 'alarm@example.test');
});

test('status.txt: tylko wysłane sztuki organizacji z numerem E-Form, przewoźnik bez zmian', () => {
  const rows = [
    { ORGANIZATIONIDENT: 'LuxanGmbH', USERIDENT: 'A', ORDERNO: '11', ORDERPOS: '1-2', STATUS: '!sent!', SHIPPINGDATE: '20.11.2026', PARCELCODE: 'DBSCHENKER 1775498160,DBSCHENKER 1775498' },
    { ORGANIZATIONIDENT: 'LuxanGmbH', USERIDENT: 'A', ORDERNO: '11', ORDERPOS: '2', STATUS: '!sent!', SHIPPINGDATE: '2026-11-20', PARCELCODE: 'BUS' },
    { ORGANIZATIONIDENT: 'LuxanGmbH', USERIDENT: 'A', ORDERNO: '11', ORDERPOS: '3', STATUS: '!production!', SHIPPINGDATE: '2026-11-25', PARCELCODE: 'BUS' },
    { ORGANIZATIONIDENT: 'LuxanGmbH', USERIDENT: 'JC', ORDERNO: 'EB26-101327', ORDERPOS: '1', STATUS: '!sent!', SHIPPINGDATE: '2026-11-20', PARCELCODE: 'DPD 1' },
    { ORGANIZATIONIDENT: 'HKL', USERIDENT: 'H', ORDERNO: '5', ORDERPOS: '1', STATUS: '!sent!', SHIPPINGDATE: '2026-11-20', PARCELCODE: 'UPS 1' }
  ];
  assert.deepEqual(T.shippedPieces(rows, ['LUXANGMBH']), [
    { userIdent: 'A', orderIdx: '11', pos: 1, day: '2026-11-20', carrier: 'DBSCHENKER' },
    { userIdent: 'A', orderIdx: '11', pos: 2, day: '2026-11-20', carrier: 'BUS' }
  ]);
});

test('pozycje dnia: sztuki → ilość, wartość dzielona proporcjonalnie, inv, płatnik, adres, rodzaj, ciąg dalszy', () => {
  const pieces = [
    { userIdent: 'A', orderIdx: '11', pos: 1, day: '2026-11-19', carrier: 'UPS' },
    { userIdent: 'A', orderIdx: '11', pos: 1, day: '2026-11-20', carrier: 'UPS' },
    { userIdent: 'A', orderIdx: '11', pos: 2, day: '2026-11-20', carrier: 'UPS' },
    { userIdent: 'B', orderIdx: '7', pos: 1, day: '2026-11-20', carrier: 'DPD' },
    { userIdent: 'B', orderIdx: '7', pos: 1, day: '2026-11-20', carrier: 'DPD' },
    { userIdent: 'X', orderIdx: '1', pos: 1, day: '2026-11-20', carrier: 'DPD' }
  ];
  const orders = new Map([
    ['A|11', { id: 101, order_idx: '11', commision: 'Kom 11', user_ident: 'A', paymaster_ident: 'A_Rech', country: 'de', zip: '50667', address_key: 'S9' }],
    ['B|7', { id: 102, order_idx: '7', commision: '', user_ident: 'B', paymaster_ident: '', country: 'AT', zip: '1010', address_key: '' }]
  ]);
  const items = new Map([
    ['101|1', { id: 1, name: 'Plissee', netMinor: 10000, pieces: 2 }],
    ['101|2', { id: 2, name: 'Schablone Plissee', netMinor: 3333, pieces: 1 }],
    ['102|1', { id: 3, name: 'Rollo', netMinor: 5000, pieces: 2 }]
  ]);
  const { positions, skipped } = T.buildDayPositions({ day: '2026-11-20', pieces, orders, items, issued: new Map([[3, '26004470']]) });
  assert.equal(skipped, 1, 'sztuka bez zlecenia E-Form');
  assert.deepEqual(positions.map((p) => [p.inv, p.order, p.client, p.country, p.address, p.kind, p.qty, p.net, p.continuation]), [
    [T.tempInvoiceNo(101), 'Kom 11', 'A_Rech', 'DE', 'S9', 'goods', 1, 50, true],
    [T.tempInvoiceNo(101), 'Kom 11', 'A_Rech', 'DE', 'S9', 'template_pickup', 1, 33.33, true],
    ['26004470', '7', 'B', 'AT', '', 'goods', 2, 50, false]
  ]);
  assert.equal(positions[0].orderno, 'EO/11');
  assert.equal(positions[0].ship_date, '2026-11-20');
  // Odcisk bez `inv`: wystawienie faktury nie wymusza nowej wyceny
  assert.equal(T.positionsHash(positions), T.positionsHash(positions.map((p) => ({ ...p, inv: '2026/1' }))));
  assert.notEqual(T.positionsHash(positions), T.positionsHash(positions.map((p) => ({ ...p, carrier: 'GEL' }))));
});

test('ponowienia i alarmy: 4xx od razu, 500 po trzeciej próbie, 503/timeout po 30 min', () => {
  const t0 = Date.UTC(2026, 10, 21, 0, 5);
  const r422 = T.planRetry(null, { http: 422, now: t0 });
  assert.deepEqual([r422.kind, r422.alarm, (r422.nextAt - t0) / MIN], ['request', true, 60]);
  assert.equal(T.planRetry(null, { http: 403, now: t0 }).kind, 'auth');

  let s = T.planRetry(null, { http: 500, now: t0 });
  const server = [[s.alarm, (s.nextAt - t0) / MIN]];
  s = T.planRetry(s, { http: 500, now: t0 + 5 * MIN }); server.push([s.alarm, (s.nextAt - t0) / MIN]);
  s = T.planRetry(s, { http: 500, now: t0 + 10 * MIN }); server.push([s.alarm, (s.nextAt - t0) / MIN]);
  assert.deepEqual(server, [[false, 5], [false, 10], [true, 25]]);

  let tr = null;
  let at = t0;
  const delays = [];
  for (let i = 0; i < 6; i++) {
    tr = T.planRetry(tr, { http: i % 2 ? 0 : 503, now: at });
    delays.push([(tr.nextAt - at) / MIN, tr.alarm]);
    at = tr.nextAt;
  }
  assert.deepEqual(delays, [[1, false], [2, false], [5, false], [10, false], [15, false], [15, true]], 'próby: 0, +1, +3, +8, +18, +33 min → alarm przy +33');
  assert.equal(T.planRetry(tr, { http: 422, now: at }).count, 1, 'inny rodzaj błędu = nowy licznik');
});

test('linie: tylko opłaty przypisane do numeru tymczasowego zleceń faktury, bez zer, bez dubli, MONTHLY raz', () => {
  const temp = T.tempInvoiceNo(101);
  const day = (d, charges) => ({ day: d, response: { rules_version: 'v4.2', charges }, positions: [{ order: 'Kom 11', client: 'A_Rech' }] });
  const days = [
    day('2026-11-20', [
      { invoice: temp, invoices: [temp], orders: ['Kom 11'], amount: '8.50', status: 'OK', rule: 'S3_DE_SMALL', text_de: 'Transportkosten Sendung 20.11.2026, Kom. Kom 11' },
      { invoice: temp, orders: ['Kom 12'], amount: '0.00', status: 'OK', text_de: '' },
      { invoice: temp, orders: ['Kom 13'], amount: null, status: 'PASS_THROUGH' },
      { invoice: temp, orders: ['Kom 14'], amount: null, status: 'UNRESOLVED' },
      { invoice: T.tempInvoiceNo(999), orders: ['Inne'], amount: '19.00', status: 'OK' },
      { invoice: temp, orders: ['Kom 11'], amount: '30.00', status: 'MONTHLY', text_de: 'Transportpauschale 11.2026' }
    ]),
    day('2026-11-23', [{ invoice: temp, orders: ['Kom 11'], amount: '30.00', status: 'MONTHLY', text_de: 'Transportpauschale 11.2026' }])
  ];
  const existing = { keys: new Set(), monthly: new Set(), byNumber: new Map() };
  const lines = T.linesForOrders({ orderIds: [101], days, existing });
  assert.deepEqual(lines.map((l) => [l.name, l.netAmount, l.quantity, l.taxAsGoods]), [
    ['Transportkosten Sendung 20.11.2026, Kom. Kom 11', 8.5, 1, true],
    ['Transportpauschale 11.2026', 30, 1, true]
  ]);
  assert.deepEqual(lines[0].meta.transport, {
    key: '2026-11-20|Kom 11', day: '2026-11-20', status: 'OK', rule: 'S3_DE_SMALL', amount: '8.50', orders: ['Kom 11'], invoices: [temp], rulesVersion: 'v4.2'
  });
  assert.equal(lines[1].meta.transport.monthly, 'A_Rech|2026-11');
  // Linia już na wystawionej fakturze (ponowne przeliczenie) i MONTHLY z tego miesiąca → nic
  const again = T.linesForOrders({ orderIds: [101], days, existing: { ...existing, keys: new Set(['2026-11-20|Kom 11']), monthly: new Set(['A_Rech|2026-11']) } });
  assert.deepEqual(again, []);
});

test('biuro: opłata przy wystawionej fakturze bez linii tej przesyłki i UNRESOLVED; z linią — pomijana', () => {
  const response = { charges: [
    { invoice: '26004435', invoices: ['26004435', T.tempInvoiceNo(5)], orders: ['Hofer'], amount: '8.50', status: 'OK' },
    { invoice: '2026/00031', orders: ['Kom 11', 'Kom 12'], amount: '8.50', status: 'OK' },
    { invoice: T.tempInvoiceNo(7), orders: ['Kom 7'], amount: null, status: 'UNRESOLVED' },
    { invoice: '26004436', orders: ['Zero'], amount: '0.00', status: 'OK' },
    { invoice: T.tempInvoiceNo(8), orders: ['Kom 8'], amount: '8.50', status: 'OK' }
  ] };
  const existing = { keys: new Set(), monthly: new Set(), byNumber: new Map([['2026/00031', [{ day: '2026-11-20', orders: ['Kom 12'] }]]]) };
  const items = T.officeItems({ day: '2026-11-20', response, positions: [], existing });
  assert.deepEqual(items.map((i) => [i.charge.invoice, i.reason]), [
    ['26004435', 'faktura 26004435 już wystawiona'],
    [T.tempInvoiceNo(7), 'brak kwoty (UNRESOLVED)']
  ]);
});

// --- sesja: atrapy bazy, API, poczty i pliku stanu ---------------------------------

function memoryStore() {
  let state = { days: {} };
  return { read: () => JSON.parse(JSON.stringify(state)), update(fn) { const s = this.read(); fn(s); state = s; return s; }, peek: () => state };
}

function fakeRepo({ issued = [], lines = [] } = {}) {
  const orders = [
    { id: 101, order_idx: '11', commision: 'Kom 11', user_id: 1, user_ident: 'A', org_ident: 'LUXANGMBH', country: 'DE', zip: '50667', address_key: '', paymaster_ident: '' },
    { id: 102, order_idx: '7', commision: 'Kom 7', user_id: 2, user_ident: 'B', org_ident: 'LUXANGMBH', country: 'AT', zip: '1010', address_key: '', paymaster_ident: '' },
    { id: 300, order_idx: '5', commision: '', user_id: 3, user_ident: 'H', org_ident: 'HKL', country: 'PL', zip: '00-001', address_key: '', paymaster_ident: '' }
  ];
  const calls = [];
  return {
    calls,
    getTransportOrders: async ({ orderIds = [], pairs = [] }) => {
      calls.push('orders');
      return orders.filter((o) => orderIds.includes(o.id) || pairs.some(([u, n]) => u === o.user_ident && n === o.order_idx));
    },
    getTransportItems: async (ids) => [
      { id: 1, order_id: 101, orderpos: 1, name: 'Plissee', amount: 1, total_price: 60, total_price_sub: 68.6, json_parameters: '{"ILOSC":"1"}' },
      { id: 2, order_id: 102, orderpos: 1, name: 'Rollo', amount: 1, total_price: 300, total_price_sub: 412, json_parameters: '{"ILOSC":"1"}' }
    ].filter((i) => ids.includes(i.order_id)),
    findIssuedTransportInvoices: async () => issued,
    findTransportLines: async () => lines
  };
}

function fakeApi(responses) {
  const requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { requests, fetchImpl };
}

const STATUS = [HEADER, row('A', '11', '1', '2026-11-20'), row('B', '7', '1', '2026-11-20', 'BUS'), row('H', '5', '1', '2026-11-20')].join('\n');

function session({ api, store = memoryStore(), repo = fakeRepo(), at = Date.UTC(2026, 10, 21, 0, 5), status = STATUS, mails = [] }) {
  return T.createTransportSession({
    config: CONFIG, repository: repo, store, log: () => {}, now: () => new Date(at),
    fetchImpl: api.fetchImpl, sendMail: async (m) => { mails.push(m); }, readStatusFile: async () => status
  });
}

const ok = (charges) => ({ status: 200, body: { rules_version: '2026-11-18.v4.2', charges, warnings: [] } });

test('sesja: zlecenie innej organizacji albo transport wyłączony — bez bramki i bez zapytań', async () => {
  const api = fakeApi([ok([])]);
  assert.deepEqual(await session({ api }).forOrders([300]), { wait: false, serviceItems: [] });
  const off = T.createTransportSession({ config: T.readTransportConfig({}), repository: {} });
  assert.deepEqual(await off.forOrders([101]), { wait: false, serviceItems: [] });
  assert.equal(api.requests.length, 0);
});

test('sesja: dzień wysyłki jeszcze trwa → faktura czeka', async () => {
  const api = fakeApi([ok([])]);
  const r = await session({ api, at: new Date('2026-11-20T15:00:00').getTime() }).forOrders([101]);
  assert.equal(r.wait, true);
  assert.match(r.reason, /2026-11-20 jeszcze się nie zamknął/);
  assert.equal(api.requests.length, 0);
});

test('sesja: jedno zapytanie na dzień ze wszystkimi sztukami organizacji, linia na fakturę numeru tymczasowego, odpowiedź zapamiętana', async () => {
  const temp = T.tempInvoiceNo(101);
  const api = fakeApi([ok([{ invoice: temp, invoices: [temp], orders: ['Kom 11'], amount: '8.50', status: 'OK', rule: 'S3_DE_SMALL', text_de: 'Transportkosten Sendung 20.11.2026, Kom. Kom 11' }])]);
  const store = memoryStore();
  const s = session({ api, store });
  const r = await s.forOrders([101]);
  assert.equal(r.wait, false);
  assert.deepEqual(r.serviceItems.map((l) => [l.name, l.netAmount]), [['Transportkosten Sendung 20.11.2026, Kom. Kom 11', 8.5]]);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, 'http://api/v1/transport/quote');
  assert.equal(api.requests[0].headers['X-Api-Key'], 'k');
  assert.deepEqual(api.requests[0].body.positions.map((p) => [p.inv, p.client, p.carrier, p.net, p.qty]), [
    [temp, 'A', 'UPS', 68.6, 1],
    [T.tempInvoiceNo(102), 'B', 'BUS', 412, 1]
  ], 'cena klienta (SUB), sztuki HKL poza zapytaniem, BUS bez zmian');
  // Drugie zlecenie tego dnia i kolejny przebieg: bez nowego zapytania
  assert.deepEqual((await s.forOrders([102])).serviceItems, []);
  assert.equal((await session({ api, store }).forOrders([101])).wait, false);
  assert.equal(api.requests.length, 1);
});

test('sesja: 422 → faktura czeka, alarm od razu z listą errors, kolejna próba za godzinę bez drugiego alarmu', async () => {
  const api = fakeApi([{ status: 422, body: { error: 'request', errors: ['positions[1].carrier: one of B, DHL, DPD, GEL, GLS, T, TB, UPS'] } }]);
  const store = memoryStore();
  const mails = [];
  const t0 = Date.UTC(2026, 10, 21, 0, 5);
  const r = await session({ api, store, mails, at: t0 }).forOrders([101]);
  assert.equal(r.wait, true);
  assert.match(r.reason, /HTTP 422/);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'alarm@example.test');
  assert.match(mails[0].subject, /Transport 20\.11\.2026: zapytanie odrzucone \(HTTP 422\)/);
  assert.match(mails[0].text, /positions\[1\]\.carrier: one of B, DHL/);
  assert.match(mails[0].text, /czekają/);

  assert.equal((await session({ api, store, mails, at: t0 + 30 * MIN }).forOrders([101])).wait, true);
  assert.equal(api.requests.length, 1, 'przed upływem godziny bez zapytania');
  await session({ api, store, mails, at: t0 + 61 * MIN }).forOrders([101]);
  assert.equal(api.requests.length, 2);
  assert.equal(mails.length, 1, 'ten sam błąd — bez drugiego alarmu');
  assert.deepEqual(session({ api, store, at: t0 + 200 * MIN }).dueDays(), ['2026-11-20']);
});

test('sesja: brak połączenia → ponowienia bez alarmu, alarm po 30 min, potem sukces', async () => {
  const down = new Error('connect ECONNREFUSED 192.168.0.21:5031');
  const temp = T.tempInvoiceNo(101);
  const api = fakeApi([down, down, down, down, down, down, ok([{ invoice: temp, orders: ['Kom 11'], amount: '19.00', status: 'OK', text_de: 'Transportkosten' }])]);
  const store = memoryStore();
  const mails = [];
  let at = Date.UTC(2026, 10, 21, 0, 5);
  let r;
  for (let i = 0; i < 7; i++) {
    r = await session({ api, store, mails, at }).forOrders([101]);
    if (!r.wait) break;
    at = store.peek().days['2026-11-20'].failure.nextAt;
  }
  assert.equal(r.wait, false);
  assert.equal(r.serviceItems[0].netAmount, 19);
  assert.equal(mails.length, 1, 'jeden alarm po 30 minutach');
  assert.match(mails[0].subject, /kalkulator nie odpowiada/);
  assert.equal(store.peek().days['2026-11-20'].failure, undefined, 'po sukcesie bez śladu porażki');
});

test('sesja: opłata przy fakturze już wystawionej bez linii → mail do biura, bez linii na nowej fakturze', async () => {
  const api = fakeApi([ok([{ invoice: '2026/00031', invoices: ['2026/00031', T.tempInvoiceNo(102)], orders: ['Kom 11', 'Kom 7'], amount: '8.50', status: 'OK', rule: 'S3_DE_SMALL', text_de: 'Transportkosten' }])]);
  const mails = [];
  const r = await session({ api, mails, repo: fakeRepo({ issued: [{ order_item_id: 1, number: '2026/00031' }] }) }).forOrders([102]);
  assert.deepEqual(r, { wait: false, serviceItems: [] });
  assert.equal(api.requests[0].body.positions[0].inv, '2026/00031');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /do doliczenia przez biuro \(1\)/);
  assert.match(mails[0].text, /faktura 2026\/00031 już wystawiona: 8\.50 EUR/);
});

test('automat: zlecenie czekające na transport nie blokuje innych, faktura z liniami dostaje je jako usługi', async () => {
  const queries = [];
  const candidates = [{ id: 1, order_idx: '1', user_ident: 'A' }, { id: 2, order_idx: '2', user_ident: 'B' }, { id: 3, order_idx: '3', user_ident: 'C' }];
  const repository = {
    findAutoInvoiceCandidates: async (p) => {
      queries.push({ level: p.level, limit: p.limit, exclude: p.excludeOrderIds || [] });
      return p.level === 2 ? candidates.filter((c) => !(p.excludeOrderIds || []).includes(c.id)).slice(0, p.limit) : [];
    },
    hasLevelInvoice: async () => false
  };
  const line = { name: 'Transportkosten', netAmount: 8.5, quantity: 1, taxAsGoods: true, meta: { transport: { key: 'k' } } };
  const transport = { forOrders: async ([id]) => (id === 1 ? { wait: true, reason: 'transport 2026-11-20: zapytanie odrzucone (HTTP 422)', serviceItems: [] } : { wait: false, serviceItems: id === 2 ? [line] : [] }) };
  const calls = [];
  const service = { createFromOrder: async (p) => { calls.push(p); return { id: p.orderId, number: `2026/${p.orderId}` }; } };
  const config = { ...readAutoInvoiceConfig({ INVOICE_AUTOGEN_ENABLED: 'true', INVOICE_AUTOGEN_SINCE: '2026-10-01', INVOICE_AUTOGEN_MAX_PER_RUN: '2' }, { invoicesEnabled: true }), levels: [2] };
  const logs = [];
  const result = await runAutoInvoicing({ config, deps: { repository, service, transport, log: (m) => logs.push(m) } });
  assert.deepEqual(calls.map((c) => [c.orderId, c.serviceItems || null]), [[2, [line]], [3, null]]);
  assert.deepEqual(result.waitingTransport.map((w) => w.orderId), [1]);
  assert.deepEqual(queries, [{ level: 2, limit: 2, exclude: [] }, { level: 2, limit: 1, exclude: [1, 2] }], 'czekające zwraca budżet, obsłużone znikają z kolejnej rundy');
  assert.ok(logs.some((l) => /czeka 1 — koszty transportu/.test(l)));
});

test('kraj i kod pocztowy z adresów wysyłki: nazwa → ISO-2, przedrostek kraju z kodu znika, nieznana nazwa bez zmian (wróci w 422)', () => {
  assert.deepEqual(['SCHWEIZ', 'Deutschland', 'at', 'Österreich', 'Atlantis'].map(T.isoCountry), ['CH', 'DE', 'AT', 'AT', 'ATLANTIS']);
  const { positions } = T.buildDayPositions({
    day: '2026-11-19',
    pieces: [{ userIdent: 'Schadegg', orderIdx: '471018', pos: 1, day: '2026-11-19', carrier: 'UPS' }],
    orders: new Map([['SCHADEGG|471018', { id: 9, order_idx: '471018', commision: '', user_ident: 'Schadegg', paymaster_ident: '', country: 'SCHWEIZ', zip: 'CH-9545', address_key: 'S709' }]]),
    items: new Map([['9|1', { id: 90, name: 'Plissee', netMinor: 11820, pieces: 1 }]]),
    issued: new Map()
  });
  assert.deepEqual([positions[0].country, positions[0].zip, positions[0].client], ['CH', '9545', 'Schadegg']);
});
