'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const orderService = require('../../orderService');
const { renderOrderPdfHtml } = require('../pdfGenerator');
const { buildPdfSendDataTotals, resolveSubPricePdfView } = require('../../subPrices');
const nunjucks = require('nunjucks');
const confLang = require('../conf');
const path = require('path');
const {
  makeOrderItem,
  mockReq,
  SUB_CENA_VISIBLE,
  SUB_CENA_LOCKED,
  REGULAR_CENA,
  REGULAR_SUMA,
  SUB_SUMA_VISIBLE,
  SUB_SUMA_LOCKED
} = require('../../__tests__/fixtures/subPriceOrder');

async function buildPdfContext(reqOverrides = {}, contextUser = null, showSubParams = false) {
  const orderItems = [makeOrderItem()];
  const { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems);
  const req = mockReq({ ...reqOverrides, showSubParams }, contextUser);
  const view = resolveSubPricePdfView(req, true);
  const sendData = buildPdfSendDataTotals({
    isClientView: view.isClientView,
    showBoth: view.showBoth,
    orderItems,
    totalPrice: { visible: REGULAR_SUMA, hidden: '100' },
    translate: (key) => key
  });
  return { cleanOrderItems, view, sendData };
}

function renderShortPrintHtml({
  cleanOrderItems,
  sendData,
  totalPrice,
  clientView,
  showBoth,
  prices = true,
  lang = 'pl'
}) {
  const i18n = confLang(lang);
  const __ = (key) => i18n.__(key, { locale: lang });
  const env = nunjucks.configure(path.join(process.cwd(), 'templates'), {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true
  });
  env.addGlobal('__', __);
  const { pdfValueParts } = require('../../../utils/pdfValueParts');
  env.addFilter('pdfValueParts', pdfValueParts);
  return env.render('order_to_print_short.njk', {
    orderDetails: { order_idx: 1 },
    orderItems: [],
    heads: [],
    cleanOrderItems,
    total: {},
    photoFile: null,
    logoPath: null,
    prices,
    sendData,
    totalPrice,
    maxProdDays: 0,
    clientView,
    showBoth,
    hasSubPrices: true
  });
}

function assertSubPricesInHtml(html, { visibleSub, lockedSub, regularCena, regularSuma }) {
  if (visibleSub) {
    assert.match(html, new RegExp(visibleSub.replace('.', '\\.')));
  } else {
    assert.doesNotMatch(html, new RegExp(SUB_CENA_VISIBLE.replace('.', '\\.')));
  }
  if (lockedSub) {
    assert.match(html, new RegExp(lockedSub.replace('.', '\\.')));
  }
  if (regularCena) {
    assert.match(html, new RegExp(regularCena.replace('.', '\\.')));
  } else {
    assert.doesNotMatch(html, new RegExp(`price-label[^<]*Cena katalogowa[\\s\\S]*${REGULAR_CENA.replace('.', '\\.')}`));
  }
  if (regularSuma !== undefined && regularSuma !== null) {
    assert.match(html, new RegExp(String(regularSuma).replace('.', '\\.')));
  }
}

test('PDF client view shows SUB line prices and hides regular row-2 prices', async () => {
  const { cleanOrderItems, view, sendData } = await buildPdfContext();
  assert.equal(view.isClientView, true);

  const html = renderOrderPdfHtml({
    orderDetails: { commision: 'Test' },
    cleanOrderItems,
    sendData,
    clientView: view.isClientView,
    showBoth: view.showBoth,
    prices: true,
    showGoldPrices: true
  });

  assertSubPricesInHtml(html, {
    visibleSub: SUB_CENA_VISIBLE,
    lockedSub: SUB_CENA_LOCKED,
    regularCena: null
  });
  assert.match(html, new RegExp(String(SUB_SUMA_VISIBLE)));
  assert.doesNotMatch(html, new RegExp(REGULAR_CENA.replace('.', '\\.')));
});

test('PDF org owner with keychain (showBoth) shows regular and SUB prices', async () => {
  const { cleanOrderItems, view, sendData } = await buildPdfContext(
    { isOwner: true, orgId: 42 },
    null,
    true
  );
  assert.equal(view.showBoth, true);

  const html = renderOrderPdfHtml({
    orderDetails: { commision: 'Test' },
    cleanOrderItems,
    sendData,
    clientView: view.isClientView,
    showBoth: view.showBoth,
    prices: true,
    showGoldPrices: true
  });

  assertSubPricesInHtml(html, {
    visibleSub: SUB_CENA_VISIBLE,
    lockedSub: SUB_CENA_LOCKED,
    regularCena: REGULAR_CENA
  });
  assert.match(html, new RegExp(String(REGULAR_SUMA)));
});

test('PDF totals match page logic for client vs showBoth modes', async () => {
  const orderItems = [makeOrderItem()];

  const clientReq = mockReq();
  const clientView = resolveSubPricePdfView(clientReq, true);
  const clientTotals = buildPdfSendDataTotals({
    isClientView: clientView.isClientView,
    showBoth: clientView.showBoth,
    orderItems,
    totalPrice: { visible: REGULAR_SUMA, hidden: '100' },
    translate: (key) => key
  });

  const ownerReq = mockReq({ isOwner: true, orgId: 42, showSubParams: true });
  const ownerView = resolveSubPricePdfView(ownerReq, true);
  const ownerTotals = buildPdfSendDataTotals({
    isClientView: ownerView.isClientView,
    showBoth: ownerView.showBoth,
    orderItems,
    totalPrice: { visible: REGULAR_SUMA, hidden: '100' },
    translate: (key) => key
  });

  assert.equal(clientTotals.total, `order.total_list_gross: ${SUB_SUMA_VISIBLE}€`);
  assert.equal(clientTotals.total_hidden, `order.total_hidden: ${SUB_SUMA_LOCKED}€ netto`);
  assert.equal(ownerTotals.total, `order.total: ${REGULAR_SUMA}€`);
  assert.equal(ownerTotals.total_hidden, `order.total_hidden: ${SUB_SUMA_LOCKED}€ netto`);
});

test('PDF and orderService expose the same SUB values for each position', async () => {
  const orderItems = [makeOrderItem()];
  const { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems);
  const subFromTable = cleanOrderItems[0].rows[0].item.subParamValues
    .filter((e) => !e.locked)
    .map((e) => e.value);

  const html = renderOrderPdfHtml({
    orderDetails: {},
    cleanOrderItems,
    sendData: {},
    clientView: true,
    showBoth: false,
    prices: true
  });

  for (const value of subFromTable) {
    assert.match(html, new RegExp(String(value).replace('.', '\\.')));
  }
});

test('short PDF client view shows SUB line prices and hides regular row-2 prices', async () => {
  const { cleanOrderItems, view, sendData } = await buildPdfContext();
  const html = renderShortPrintHtml({
    cleanOrderItems,
    sendData,
    totalPrice: {
      visible: REGULAR_SUMA,
      hidden: '100',
      subVisible: SUB_SUMA_VISIBLE,
      subLocked: SUB_SUMA_LOCKED
    },
    clientView: view.isClientView,
    showBoth: view.showBoth
  });

  assert.equal(view.isClientView, true);
  assertSubPricesInHtml(html, {
    visibleSub: SUB_CENA_VISIBLE,
    lockedSub: SUB_CENA_LOCKED,
    regularCena: null
  });
  assert.doesNotMatch(html, new RegExp(REGULAR_CENA.replace('.', '\\.')));
  assert.match(html, new RegExp(String(SUB_SUMA_VISIBLE)));
  assert.doesNotMatch(html, new RegExp(String(REGULAR_SUMA).replace('.', '\\.')));
});

test('PDF z cenami: VAT per pozycja (SUB___VAT*) nigdzie nie wychodzi — ani dla klienta, ani dla grupy', async () => {
  // Decyzja właściciela 2026-10-27: VAT jest tylko w sumie zlecenia. `orderService`
  // odrzuca wiersze SUB___VAT* z `subParamValues`, więc PDF ich nie ma niezależnie od roli.
  const vatRows = [
    ['SUB___VAT', { param_description: 'MWST [%]', option_value: '19%', row: '2', locked: true, sub: true }],
    ['SUB___WARTOSC_VAT', { param_description: 'MWST-BETRAG [€]', option_value: '24.84', row: '2', locked: true, sub: true }],
    ['SUB___WARTOSC_BRUTTO', { param_description: 'BRUTTOWERT [€]', option_value: '155.56', row: '2', locked: true, sub: true }]
  ];
  const item = makeOrderItem();
  item.json_parameters_desc = [...item.json_parameters_desc, ...vatRows];
  const { cleanOrderItems } = await orderService.jsonTextBackToMap([item]);
  const render = (hideClientVat) => renderOrderPdfHtml({
    orderDetails: {}, cleanOrderItems, sendData: {}, clientView: true, prices: true, hideClientVat
  });

  for (const hideClientVat of [false, true]) {
    const html = render(hideClientVat);
    assert.doesNotMatch(html, /MWST|BRUTTOWERT|VAT \[%\]/, `hideClientVat=${hideClientVat}`);
    assert.match(html, new RegExp(String(SUB_SUMA_LOCKED)), 'reszta złotych cen klienta zostaje');
  }
});
