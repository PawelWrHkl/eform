'use strict';

/**
 * Treść żądania usługi e-faktur (`einvoice/payload.js`) — format i pola z kontraktu
 * „EFOR_E-Rechnung_Kontrakt” v1.4 (pkt 4 i 11). Bez bazy i sieci.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPayload, amount, quantity, rate, sellerVatId, priceGroup, statusesByOrderItem } = require('../einvoice/payload');

/** Faktura Luxan GmbH → klient jak z `repository.getInvoice` (kwoty w centach) — przykład skrócony z kontraktu. */
function invoiceFixture(overrides = {}) {
  return {
    id: 128,
    organizationId: 5,
    level: 2,
    issuerType: 'organization',
    issuerId: 5,
    priceBasis: 'sub',
    buyerType: 'user',
    buyerUserId: 873,
    buyerGroupUserId: null,
    documentType: 'invoice',
    status: 'issued',
    number: '2026/00017',
    issueDate: '2026-10-19',
    saleDate: '2026-10-10',
    dueDate: '2026-11-02',
    deliveryDate: '2026-10-10',
    currency: 'EUR',
    lang: 'de',
    compliance: { sellerRegistry: [{ key: 'USTIDNR', value: 'DE814603367' }] },
    deliveryAddress: null,
    seller: { name: 'Luxan Krawczyk Sonnenschutzsysteme GmbH', taxId: 'DE814603367', vatEuId: null, street: 'Kreuzgraben 4', zip: '13156', city: 'Berlin', country: 'DE' },
    buyer: { name: 'Muster Raumausstattung GmbH', street: 'Beispielstraße 12', zip: '10115', city: 'Berlin', country: 'DE', vatEuId: 'DE123456789', taxId: 'DE123456789', email: 'login@muster.example' },
    viesCheckedAt: '2026-10-19T08:00:00.000Z',
    viesValid: true,
    paymentMethod: 'transfer',
    orderId: 2913,
    items: [{
      position: 1,
      name: 'Plissee EOS AO30',
      description: '1232×1480 mm · Modell AO30 · Farbe 2002-P20',
      unit: 'szt',
      quantity: 1,
      netAmount: 21480,
      taxCategory: 'standard',
      taxRate: 19,
      orderItemId: 70001,
      orderNumber: '1041',
      meta: { widthMm: 1232, heightMm: 1480, orderPosition: 1, priceSource: 'sub' }
    }],
    taxLines: [{ taxCategory: 'standard', taxRate: 19, netAmount: 21480, taxAmount: 4081, grossAmount: 25561 }],
    totalNet: 21480,
    totalTax: 4081,
    totalGross: 25561,
    advanceSettled: 0,
    amountDue: 25561,
    notes: 'Bitte vor 8 Uhr liefern (komentarz klienta z zamówienia)',
    ...overrides
  };
}

function sourcesFixture(overrides = {}) {
  return {
    issuer: { ident: 'LUXANGMBH', email: 'rechnung@luxan.de' },
    buyer: { ident: 'Muster_Raum', email: 'login@muster.example', phone: '+49 30 123' },
    paymentTermsDays: 14,
    orders: [{ id: 2913, order_idx: '1041', commision: 'Bauvorhaben Musterweg', delivery_date: '2026-10-16', send_address_id: null, user_ident: 'Muster_Raum' }],
    orderItems: [{ id: 70001, order_id: 2913, orderpos: 1, commision: 'Wohnzimmer links', json_parameters: JSON.stringify({ KOLOR_ALIAS___DESCRIPTION: '2002-P20 #2' }), order_idx: '1041', user_ident: 'Muster_Raum' }],
    statuses: [{ user_ident: 'Muster_Raum', order_idx: 1041, order_pos: '1', status: '!sent!', shipping_date: '2026-10-16' }],
    sendAddresses: [],
    corrected: null,
    ...overrides
  };
}

test('poziom 2: pełna treść zgodna z przykładem kontraktu (pkt 4)', () => {
  const payload = buildPayload({ invoice: invoiceFixture(), env: 'test', sources: sourcesFixture() });
  assert.deepEqual(payload, {
    schema_version: '1',
    source: 'efor',
    efor_env: 'test',
    invoice_id: 128,
    level: 2,
    issuer: { type: 'organization', id: 5, ident: 'LUXANGMBH' },
    document_type: 'invoice',
    number: '2026/00017',
    issue_date: '2026-10-19',
    sale_date: '2026-10-10',
    delivery_date: '2026-10-16',
    due_date: '2026-11-02',
    currency: 'EUR',
    lang: 'de',
    seller: {
      name: 'Luxan Krawczyk Sonnenschutzsysteme GmbH', street: 'Kreuzgraben 4', zip: '13156', city: 'Berlin', country: 'DE',
      vat_eu_id: 'DE814603367', tax_id: 'DE814603367', email: 'rechnung@luxan.de', ident: 'LUXANGMBH'
    },
    buyer: {
      name: 'Muster Raumausstattung GmbH', street: 'Beispielstraße 12', zip: '10115', city: 'Berlin', country: 'DE',
      vat_eu_id: 'DE123456789', tax_id: 'DE123456789', invoice_email: null, email: 'login@muster.example',
      phone: '+49 30 123', ident: 'Muster_Raum', source_type: 'user'
    },
    delivery_address: null,
    payment: { method: 'transfer', days: 14, skonto: null, mandate_ref: '' },
    orders: [{ order_id: 2913, order_idx: '1041', commission: 'Bauvorhaben Musterweg', user_ident: 'Muster_Raum' }],
    items: [{
      position: 1, order_idx: '1041', order_item_id: 70001, order_position: 1,
      name_de: 'Plissee EOS AO30', description_de: '1232×1480 mm · Modell AO30 · Farbe 2002-P20',
      quantity: '1', unit: 'szt', net_amount: '214.80', price_source: 'sub', tax_category: 'standard', tax_rate: '19',
      shipping_date: '2026-10-16', shipping_status: '!sent!', width_mm: 1232, height_mm: 1480,
      kom: 'Wohnzimmer links', hs_code: '', price_group: '2', user_ident: 'Muster_Raum'
    }],
    tax_lines: [{ tax_category: 'standard', tax_rate: '19', net_amount: '214.80', tax_amount: '40.81', gross_amount: '255.61' }],
    totals: { net: '214.80', tax: '40.81', gross: '255.61', advance_settled: '0.00', amount_due: '255.61' },
    vies: { checked_at: '2026-10-19T08:00:00.000Z', valid: true },
    corrected: null,
    notes_de: '',
    bonus_agreement: false
  });
});

test('formaty: kwoty z dwoma miejscami, ilości do trzech, stawki w procentach', () => {
  assert.equal(amount(1), '0.01');
  assert.equal(amount(0), '0.00');
  assert.equal(amount(-1230), '-12.30');
  assert.equal(amount(123456789), '1234567.89');
  assert.equal(quantity(2), '2');
  assert.equal(quantity(2.5), '2.5');
  assert.equal(quantity(1.23456), '1.235');
  assert.equal(quantity(0.1 + 0.2), '0.3');
  assert.equal(rate(19), '19');
  assert.equal(rate(0), '0');
  assert.throws(() => amount('abc'), /kwota/);
  assert.throws(() => quantity(undefined), /ilość/);
});

test('uwagi z zamówienia (invoice.notes) NIGDY nie idą do notes_de', () => {
  const payload = buildPayload({ invoice: invoiceFixture(), env: 'test', sources: sourcesFixture() });
  assert.equal(payload.notes_de, '');
  assert.ok(!JSON.stringify(payload).includes('Bitte vor 8 Uhr'));
});

test('VAT-UE sprzedawcy: vatEuId, a bez niego USt-IdNr. z wydruku; brak obu → null', () => {
  assert.equal(sellerVatId(invoiceFixture({ seller: { vatEuId: 'DE999' } })), 'DE999');
  assert.equal(sellerVatId(invoiceFixture()), 'DE814603367');
  assert.equal(sellerVatId(invoiceFixture({ compliance: null })), null);
});

test('numer: null tylko dla /check; „_” i nieznane znaki odrzucone; zły efor_env i waluta też', () => {
  assert.equal(buildPayload({ invoice: invoiceFixture(), env: 'test', sources: sourcesFixture(), number: null }).number, null);
  assert.equal(buildPayload({ invoice: invoiceFixture({ id: null }), env: 'prod', sources: sourcesFixture(), number: 'SHADOW-2913' }).invoice_id, null);
  assert.throws(() => buildPayload({ invoice: invoiceFixture({ number: '2026_00017' }), env: 'test', sources: sourcesFixture() }), /numer/);
  assert.throws(() => buildPayload({ invoice: invoiceFixture(), env: 'production', sources: sourcesFixture() }), /efor_env/);
  assert.throws(() => buildPayload({ invoice: invoiceFixture({ currency: 'PLN' }), env: 'test', sources: sourcesFixture() }), /EUR/);
});

test('termin płatności: z warunków klienta, a bez nich z dat faktury', () => {
  const fromTerms = buildPayload({ invoice: invoiceFixture(), env: 'test', sources: sourcesFixture({ paymentTermsDays: 30 }) });
  assert.equal(fromTerms.payment.days, 30);
  const fromDates = buildPayload({ invoice: invoiceFixture(), env: 'test', sources: sourcesFixture({ paymentTermsDays: null }) });
  assert.equal(fromDates.payment.days, 14);
});

test('data dostawy: surowa z zamówień (max), nigdy data sprzedaży; brak → null', () => {
  const none = buildPayload({ invoice: invoiceFixture(), env: 'test', sources: sourcesFixture({ orders: [{ ...sourcesFixture().orders[0], delivery_date: null }] }) });
  assert.equal(none.delivery_date, null);
});

test('adres dostawy: wspólny adres wysyłki zamówień, kraj bez obcinania („Austria” zostaje dla HOLD-u w usłudze)', () => {
  const order = { ...sourcesFixture().orders[0], send_address_id: 7 };
  const payload = buildPayload({
    invoice: invoiceFixture(),
    env: 'test',
    sources: sourcesFixture({ orders: [order], sendAddresses: [{ id: 7, name: 'Baustelle', street: 'Ring 1', zip: '1010', city: 'Wien', country: 'Austria' }] })
  });
  assert.deepEqual(payload.delivery_address, { name: 'Baustelle', street: 'Ring 1', zip: '1010', city: 'Wien', country: 'Austria' });

  // Różne adresy w zbiorczej → null (nie zgadujemy)
  const two = buildPayload({
    invoice: invoiceFixture(),
    env: 'test',
    sources: sourcesFixture({ orders: [order, { ...order, id: 2914, send_address_id: 8 }], sendAddresses: [{ id: 7 }, { id: 8 }] })
  });
  assert.equal(two.delivery_address, null);

  // Bez adresu wysyłki — adres odbiorcy z faktury
  const fromInvoice = buildPayload({
    invoice: invoiceFixture({ deliveryAddress: { name: 'Kunde', street: 'Weg 2', zip: '20095', city: 'Hamburg', country: 'DE' } }),
    env: 'test',
    sources: sourcesFixture()
  });
  assert.equal(fromInvoice.delivery_address.city, 'Hamburg');
});

test('statusy: po numerze pozycji i koncie klienta — cudzy klient z tym samym numerem zamówienia się nie przypina', () => {
  const orderItems = [
    { id: 1, orderpos: 1, order_idx: '7', user_ident: 'A' },
    { id: 2, orderpos: 2, order_idx: '7', user_ident: 'A' }
  ];
  const statuses = [
    { user_ident: 'A', order_idx: 7, order_pos: '1-1', status: '!sent!', shipping_date: '2026-11-02' },
    { user_ident: 'A', order_idx: 7, order_pos: '1-2', status: '!production!', shipping_date: null },
    { user_ident: 'B', order_idx: 7, order_pos: '2', status: '!sent!', shipping_date: '2026-11-03' }
  ];
  const map = statusesByOrderItem(orderItems, statuses);
  assert.equal(map.get(1).status, '!production!');
  assert.equal(map.has(2), false);
});

test('poziom 1 (dzienna HKL → organizacja): okres, user_ident per pozycja, pozycja bez statusu = niewysłana', () => {
  const invoice = invoiceFixture({
    id: 300, level: 1, issuerType: 'manufacturer', issuerId: 0, buyerType: 'organization', buyerUserId: null, orderId: null, priceBasis: 'base',
    items: [
      { ...invoiceFixture().items[0], position: 1, orderItemId: 10, orderNumber: '5', meta: { orderPosition: 1, priceSource: 'base' } },
      { ...invoiceFixture().items[0], position: 2, orderItemId: 20, orderNumber: '5', meta: { orderPosition: 1, priceSource: 'base' } }
    ]
  });
  const sources = sourcesFixture({
    issuer: { ident: 'HKL', email: '' },
    buyer: { ident: 'LUXANGMBH', email: null, phone: null },
    orders: [
      { id: 1, order_idx: '5', commision: 'K1', delivery_date: '2026-11-12', user_ident: 'Kunde_A' },
      { id: 2, order_idx: '5', commision: 'K2', delivery_date: '2026-11-13', user_ident: 'Kunde_B' }
    ],
    orderItems: [
      { id: 10, order_id: 1, orderpos: 1, commision: '', order_idx: '5', user_ident: 'Kunde_A' },
      { id: 20, order_id: 2, orderpos: 1, commision: '', order_idx: '5', user_ident: 'Kunde_B' }
    ],
    statuses: [{ user_ident: 'Kunde_A', order_idx: 5, order_pos: '1', status: '!sent!', shipping_date: '2026-11-12' }]
  });
  const payload = buildPayload({ invoice, env: 'prod', sources, period: ['2026-11-12', '2026-11-12'] });
  assert.equal(payload.level, 1);
  assert.deepEqual(payload.issuer, { type: 'manufacturer', id: 0, ident: 'HKL' });
  assert.equal(payload.period_from, '2026-11-12');
  assert.equal(payload.period_to, '2026-11-12');
  assert.equal(payload.delivery_date, '2026-11-13');
  assert.equal(payload.buyer.source_type, 'organization');
  assert.deepEqual(payload.items.map((i) => i.user_ident), ['Kunde_A', 'Kunde_B']);
  assert.deepEqual(payload.items.map((i) => [i.shipping_status, i.shipping_date]), [['!sent!', '2026-11-12'], ['', null]]);
  assert.deepEqual(payload.orders.map((o) => o.user_ident), ['Kunde_A', 'Kunde_B']);
});

test('bez okresu nie ma pól period_*; sklep grupy = source_type group_user; linia ręczna bez zamówienia', () => {
  const invoice = invoiceFixture({
    buyerGroupUserId: 44,
    items: [...invoiceFixture().items, { position: 2, name: 'Montage', description: '', unit: 'usl', quantity: 1, netAmount: 5000, taxCategory: 'standard', taxRate: 19, orderItemId: null, meta: { manual: true } }]
  });
  const payload = buildPayload({ invoice, env: 'test', sources: sourcesFixture(), period: ['', ''] });
  assert.equal('period_from' in payload, false);
  assert.equal(payload.buyer.source_type, 'group_user');
  assert.deepEqual(
    (({ order_idx, order_item_id, order_position, shipping_date, shipping_status, user_ident, kom }) => ({ order_idx, order_item_id, order_position, shipping_date, shipping_status, user_ident, kom }))(payload.items[1]),
    { order_idx: null, order_item_id: null, order_position: null, shipping_date: null, shipping_status: '', user_ident: null, kom: '' }
  );
});

test('korekta: blok corrected z numerem faktury pierwotnej; zwykła faktura → null', () => {
  const payload = buildPayload({
    invoice: invoiceFixture({ documentType: 'correction', number: 'KOR/2026/00001', correctionReason: 'Falscher Preis' }),
    env: 'test',
    sources: sourcesFixture({ corrected: { number: '2026/00017', issueDate: '2026-10-19', deliveryDate: '2026-10-16' } })
  });
  assert.deepEqual(payload.corrected, { number: '2026/00017', issue_date: '2026-10-19', delivery_date: '2026-10-16', reason: 'Falscher Preis' });
});

test('grupa cenowa z parametrów pozycji; zepsuty JSON → pusto', () => {
  assert.equal(priceGroup(JSON.stringify({ KOLOR_ALIAS___DESCRIPTION: 'Stoff #3' })), '3');
  assert.equal(priceGroup(JSON.stringify(JSON.stringify({ KOLOR_ALIAS___DESCRIPTION: '#A' }))), 'A');
  assert.equal(priceGroup('{zepsuty'), '');
  assert.equal(priceGroup(null), '');
});
