'use strict';

/**
 * Testy spójności SUB___ cen między kontekstami:
 * import → orderService → sumy → PDF → widok użytkownika (locals).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const orderService = require('../orderService');
const { calcSubTotals, resolveSubPricePdfView, buildPdfSendDataTotals } = require('../subPrices');
const { applySubPriceLocals } = require('../subPriceContext');
const { renderOrderPdfHtml } = require('../mailBot/pdfGenerator');
const {
  makeOrderItem,
  mockReq,
  SUB_SUMA_VISIBLE,
  SUB_SUMA_LOCKED,
  REGULAR_SUMA
} = require('./fixtures/subPriceOrder');

function enrichTotalPrice(orderItems, dbTotal) {
  const subTotals = calcSubTotals(orderItems);
  return {
    ...dbTotal,
    subVisible: subTotals.subVisible,
    subLocked: subTotals.subLocked
  };
}

test('totalPrice.subVisible/subLocked on page match calcSubTotals from raw order items', () => {
  const orderItems = [makeOrderItem(), makeOrderItem({ id: 2 })];
  const totalPrice = enrichTotalPrice(orderItems, { visible: '299.16', hidden: '250' });
  assert.equal(totalPrice.subVisible, parseFloat((390 * 2).toFixed(2)));
  assert.equal(totalPrice.subLocked, parseFloat((360 * 2).toFixed(2)));
});

test('client page context + PDF use the same SUB totals', async () => {
  const orderItems = [makeOrderItem()];
  const req = mockReq();
  const res = { locals: {} };

  applySubPriceLocals(req, res);

  const { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems);
  const totalPrice = enrichTotalPrice(orderItems, { visible: REGULAR_SUMA, hidden: '100' });
  const view = resolveSubPricePdfView(req, true);
  const pdfTotals = buildPdfSendDataTotals({
    isClientView: view.isClientView,
    showBoth: view.showBoth,
    orderItems,
    totalPrice,
    translate: (key) => key
  });

  assert.equal(res.locals.isClient, true);
  assert.equal(view.isClientView, true);
  assert.equal(totalPrice.subVisible, SUB_SUMA_VISIBLE);
  assert.equal(pdfTotals.total, `order.total_list_gross: ${totalPrice.subVisible}€`);
  assert.equal(pdfTotals.total_hidden, `order.total_hidden: ${totalPrice.subLocked}€ netto`);

  const html = renderOrderPdfHtml({
    orderDetails: {},
    cleanOrderItems,
    sendData: pdfTotals,
    clientView: true,
    showBoth: false,
    prices: true
  });
  assert.match(html, new RegExp(String(SUB_SUMA_VISIBLE)));
});

test('org owner without keychain: page locals + PDF both in SUB-only mode', async () => {
  const orderItems = [makeOrderItem()];
  const req = mockReq({ isOwner: true, orgId: 42, showSubParams: false });
  const res = { locals: {} };

  applySubPriceLocals(req, res);

  const view = resolveSubPricePdfView(req, true);
  assert.equal(res.locals.canViewSubPrices, true);
  assert.equal(res.locals.showSub, false);
  assert.equal(res.locals.showCatalogPrices, false);
  assert.equal(view.isClientView, true);
  assert.equal(view.showBoth, false);

  const { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems);
  const html = renderOrderPdfHtml({
    orderDetails: {},
    cleanOrderItems,
    sendData: buildPdfSendDataTotals({
      isClientView: true,
      showBoth: false,
      orderItems,
      totalPrice: { visible: REGULAR_SUMA, hidden: '100' },
      translate: (key) => key
    }),
    clientView: true,
    showBoth: false,
    prices: true
  });
  assert.match(html, new RegExp(String(SUB_SUMA_VISIBLE)));
  assert.doesNotMatch(html, new RegExp(REGULAR_SUMA.replace('.', '\\.')));
});

test('org owner with keychain: page showSub + PDF showBoth stay aligned', async () => {
  const orderItems = [makeOrderItem()];
  const req = mockReq({ isOwner: true, orgId: 42, showSubParams: true });
  const res = { locals: {} };

  applySubPriceLocals(req, res);

  const view = resolveSubPricePdfView(req, true);
  assert.equal(res.locals.showSub, true);
  assert.equal(res.locals.showCatalogPrices, true);
  assert.equal(view.showBoth, true);

  const pdfTotals = buildPdfSendDataTotals({
    isClientView: false,
    showBoth: true,
    orderItems,
    totalPrice: { visible: REGULAR_SUMA, hidden: '100' },
    translate: (key) => key
  });
  assert.equal(pdfTotals.total, `order.total: ${REGULAR_SUMA}€`);
  assert.equal(pdfTotals.total_hidden, `order.total_hidden: ${SUB_SUMA_LOCKED}€ netto`);
});
