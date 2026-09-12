'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  orderHasSubPrices,
  calcSubTotals,
  resolveDiscountBaseTotal,
  resolveClientDiscountSummary,
  resolveItemClientDiscount,
  resolveSubPricePdfView,
  buildPdfSendDataTotals
} = require('../subPrices');
const {
  makeOrderItem,
  makeLegacyOrderItem,
  mockReq,
  SUB_SUMA_VISIBLE,
  SUB_SUMA_LOCKED,
  REGULAR_SUMA
} = require('./fixtures/subPriceOrder');

test('orderHasSubPrices returns true when subParamValues exist after parsing', async () => {
  const orderService = require('../orderService');
  const { cleanOrderItems } = await orderService.jsonTextBackToMap([makeOrderItem()]);
  assert.equal(orderHasSubPrices(cleanOrderItems), true);
});

test('orderHasSubPrices returns false for legacy orders without SUB___ params', async () => {
  const orderService = require('../orderService');
  const { cleanOrderItems } = await orderService.jsonTextBackToMap([makeLegacyOrderItem()]);
  assert.equal(orderHasSubPrices(cleanOrderItems), false);
});

test('calcSubTotals sums listsum SUB params with overwrite semantics per item', () => {
  const items = [makeOrderItem()];
  const totals = calcSubTotals(items);
  assert.equal(totals.subVisible, SUB_SUMA_VISIBLE);
  assert.equal(totals.subLocked, SUB_SUMA_LOCKED);
});

test('calcSubTotals aggregates multiple positions', () => {
  const items = [makeOrderItem(), makeOrderItem({ id: 2 })];
  const totals = calcSubTotals(items);
  assert.equal(totals.subVisible, parseFloat((390 * 2).toFixed(2)));
  assert.equal(totals.subLocked, parseFloat((360 * 2).toFixed(2)));
});

test('resolveSubPricePdfView — pure client sees SUB-only (clientView)', () => {
  const req = mockReq({ orgId: 42 });
  const view = resolveSubPricePdfView(req, true);
  assert.equal(view.isClientView, true);
  assert.equal(view.showBoth, false);
  assert.equal(view.isPureClient, true);
});

test('resolveSubPricePdfView — org owner without keychain sees SUB-only', () => {
  const req = mockReq({ isOwner: true, orgId: 42, showSubParams: false });
  const view = resolveSubPricePdfView(req, true);
  assert.equal(view.isClientView, true);
  assert.equal(view.showBoth, false);
  assert.equal(view.hasSubToggle, true);
});

test('resolveSubPricePdfView — org owner with keychain sees both price sets', () => {
  const req = mockReq({ isOwner: true, orgId: 42, showSubParams: true });
  const view = resolveSubPricePdfView(req, true);
  assert.equal(view.isClientView, false);
  assert.equal(view.showBoth, true);
});

test('resolveSubPricePdfView — admin with client context mirrors org owner', () => {
  const req = mockReq(
    { isAdmin: true, orgId: 3, showSubParams: true },
    { orgId: 42, ident: 'luxan', clientName: 'Luxan' }
  );
  const view = resolveSubPricePdfView(req, true);
  assert.equal(view.showBoth, true);
  assert.equal(view.isClientView, false);
});

test('resolveSubPricePdfView — HKL org (id 3) disables SUB modes', () => {
  const req = mockReq({ orgId: 3 });
  const view = resolveSubPricePdfView(req, true);
  assert.equal(view.isPureClient, false);
  assert.equal(view.isClientView, false);
  assert.equal(view.showBoth, false);
});

test('resolveSubPricePdfView — no SUB data keeps regular view', () => {
  const req = mockReq({ isOwner: true, orgId: 42, showSubParams: false });
  const view = resolveSubPricePdfView(req, false);
  assert.equal(view.isClientView, false);
  assert.equal(view.showBoth, false);
});

test('resolveSubPricePdfView — works outside NODE_ENV=test (production)', () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const req = mockReq({ orgId: 42 });
  const view = resolveSubPricePdfView(req, true);
  assert.equal(view.isClientView, true);
  assert.equal(view.isPureClient, true);
  process.env.NODE_ENV = prevEnv;
});

test('buildPdfSendDataTotals — client view uses SUB totals', () => {
  const totals = buildPdfSendDataTotals({
    isClientView: true,
    showBoth: false,
    orderItems: [makeOrderItem()],
    totalPrice: { visible: REGULAR_SUMA, hidden: '100' },
    translate: (key) => key
  });
  assert.equal(totals.total, `order.total: ${SUB_SUMA_VISIBLE}€`);
  assert.equal(totals.total_hidden, `order.total_hidden: ${SUB_SUMA_LOCKED}€ netto`);
});

test('buildPdfSendDataTotals — showBoth uses regular visible + SUB locked total', () => {
  const totals = buildPdfSendDataTotals({
    isClientView: false,
    showBoth: true,
    orderItems: [makeOrderItem()],
    totalPrice: { visible: REGULAR_SUMA, hidden: '100' },
    translate: (key) => key
  });
  assert.equal(totals.total, `order.total: ${REGULAR_SUMA}€`);
  assert.equal(totals.total_hidden, `order.total_hidden: ${SUB_SUMA_LOCKED}€ netto`);
});

test('buildPdfSendDataTotals — regular view uses order total from DB', () => {
  const totals = buildPdfSendDataTotals({
    isClientView: false,
    showBoth: false,
    orderItems: [makeOrderItem()],
    totalPrice: { visible: REGULAR_SUMA, hidden: '120' },
    translate: (key) => key,
    showGoldPrices: true
  });
  assert.equal(totals.total, `order.total: ${REGULAR_SUMA}€`);
  assert.equal(totals.total_hidden, 'order.total_hidden: 120€ netto');
});

test('buildPdfSendDataTotals — regular view without gold prices hides total_hidden (mail/HKL)', () => {
  const totals = buildPdfSendDataTotals({
    isClientView: false,
    showBoth: false,
    orderItems: [makeOrderItem()],
    totalPrice: { visible: REGULAR_SUMA, hidden: '120' },
    translate: (key) => key,
    showGoldPrices: false
  });
  assert.equal(totals.total, `order.total: ${REGULAR_SUMA}€`);
  assert.equal(totals.total_hidden, null);
});

test('resolveDiscountBaseTotal — HKL uses regular visible total', () => {
  const base = resolveDiscountBaseTotal(3, { visible: 500, sub: 300 }, { subVisible: 390 });
  assert.equal(base, 500);
});

test('resolveDiscountBaseTotal — non-HKL uses SUB subVisible', () => {
  const base = resolveDiscountBaseTotal(42, { visible: 500, sub: 300 }, { subVisible: 390 });
  assert.equal(base, 390);
});

test('resolveDiscountBaseTotal — non-HKL falls back to totals.sub when subTotals missing', () => {
  const base = resolveDiscountBaseTotal(42, { visible: 500, sub: 280 }, null);
  assert.equal(base, 280);
});

/**
 * Informacja o rabacie eForma do podsumowania PDF-a z cenami ukrytymi
 * (`print-button data-lock='true'`) — pod ilością sztuk.
 */
test('resolveClientDiscountSummary — bierze procent i opis z wiersza pozycji', () => {
  const item = {
    json_parameters_desc: JSON.stringify({
      SUB___WARTOSC_KONCOWA: { option_value: '112.07', locked: true, listsum: true },
      SUB___RABAT_KLIENTA: {
        option_value: '1%',
        param_description: '1% rabatu do zamówienia z tytułu korzystania z serwisu',
        locked: true
      }
    })
  };
  assert.deepEqual(resolveClientDiscountSummary([item]), {
    percent: '1%',
    label: '1% rabatu do zamówienia z tytułu korzystania z serwisu'
  });
});

test('resolveClientDiscountSummary — klucz sprzed 2026-08-21 (bez SUB___) też się liczy', () => {
  const item = {
    json_parameters_desc: JSON.stringify({
      RABAT_KLIENTA: { option_value: '15%', param_description: 'Rabat klienta' }
    })
  };
  assert.deepEqual(resolveClientDiscountSummary([item]), { percent: '15%', label: 'Rabat klienta' });
});

test('resolveClientDiscountSummary — zerowy i brakujący rabat dają null', () => {
  const zerowy = { json_parameters_desc: JSON.stringify({ SUB___RABAT_KLIENTA: { option_value: '0%' } }) };
  assert.equal(resolveClientDiscountSummary([zerowy]), null);
  assert.equal(resolveClientDiscountSummary([{ json_parameters_desc: '{}' }]), null);
  assert.equal(resolveClientDiscountSummary([]), null);
  assert.equal(resolveClientDiscountSummary(null), null);
});

/**
 * Rabat eForma per pozycja — trafia do JSON-a wysyłanego na FTP jako
 * `efor_rabat` (services/sendOrderService.js).
 */
test('resolveItemClientDiscount — czyta wiersz rabatu pozycji', () => {
  const item = {
    json_parameters_desc: JSON.stringify({
      SUB___RABAT_KLIENTA: { option_value: '1%', param_description: '1% za korzystanie z serwisu' }
    })
  };
  assert.deepEqual(resolveItemClientDiscount(item), {
    percent: '1%', value: 1, label: '1% za korzystanie z serwisu'
  });
});

test('resolveItemClientDiscount — bez wiersza schodzi do json_parameters', () => {
  // Ekrany bez wierszy rabatu (edit_form/admin_edit_form) nie tworzą wiersza,
  // ale `applyClientDiscount` zawsze zapisuje `RABAT_KLIENTA` w parametrach.
  const item = { json_parameters: JSON.stringify({ RABAT_KLIENTA: 16 }) };
  assert.deepEqual(resolveItemClientDiscount(item), { percent: '16%', value: 16, label: null });
});

test('resolveItemClientDiscount — brak rabatu i zero dają null (klucz nie wejdzie do JSON-a)', () => {
  assert.equal(resolveItemClientDiscount({ json_parameters: JSON.stringify({ RABAT_KLIENTA: 0 }) }), null);
  assert.equal(resolveItemClientDiscount({ json_parameters: '{}' }), null);
  assert.equal(resolveItemClientDiscount({}), null);
  assert.equal(resolveItemClientDiscount(null), null);
});

test('resolveItemClientDiscount — uszkodzony JSON nie wywraca wysyłki', () => {
  assert.equal(resolveItemClientDiscount({ json_parameters_desc: '{zepsute', json_parameters: '{zepsute' }), null);
});
