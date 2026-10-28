'use strict';

/**
 * VAT CEN ZWYKŁYCH (decyzja właściciela 2026-10-27): podstawa SUMA_BRUTTO
 * (mimo nazwy netto) = suma „HKL Razem”, w stopce „HKL Razem … netto”,
 * „VAT x%”, „Kwota brutto z VAT x%”. Osobny tor od VAT-u cen klienta SUB___.
 * Bez bazy: stawkę podmienia atrapa `vatCalculator`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..', '..');

// Atrapa stawki — zanim `subPrices` sięgnie po `vatCalculator` (require leniwy)
const vatCalculatorPath = require.resolve('../vatCalculator');
let stubRate = 23;
require.cache[vatCalculatorPath] = {
  id: vatCalculatorPath, filename: vatCalculatorPath, loaded: true,
  exports: { resolveRegularVatRateForOrder: async () => ({ vatRate: stubRate, reason: 'stub' }) }
};
const { attachRegularVatTotals } = require('../subPrices');

test('attachRegularVatTotals: VAT od sumy cen zwykłych (visible), SUB___ nietknięte; bez stawki nic', async () => {
  stubRate = 23;
  const tp = await attachRegularVatTotals({ visible: '152.49', hidden: '140.00', subLocked: 110, subVat: '20.90' }, 1);
  assert.equal(tp.regularVatRate, 23);
  assert.equal(tp.regularVat, '35.07');
  assert.equal(tp.regularGross, '187.56');
  assert.equal(tp.subVat, '20.90', 'VAT cen klienta bez zmian');

  stubRate = null;
  const off = await attachRegularVatTotals({ visible: '152.49' }, 1);
  assert.equal(off.regularVat, undefined, 'VAT wyłączony — brak wierszy');
  stubRate = 23;
  const zero = await attachRegularVatTotals({ visible: '0.00' }, 1);
  assert.equal(zero.regularVat, undefined, 'suma 0 („wg cennika”) — brak wierszy');
});

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
env.addGlobal('__', (key) => key);
env.addGlobal('gk', (key) => key);
env.addFilter('pdfValueParts', (v) => v);
env.addFilter('applyFactor', (value, factor) => ((!factor || factor === 1 || !value) ? value : (parseFloat(value) * factor).toFixed(2)));

const ITEMS = [{
  headers1: [], headers2: [], headerKeys1: [], headerKeys2: [], locked: [], sub: [],
  rows: [{ item: { id: 1, lockedParams: [], subParamValues: [], clientDiscountValues: [] }, row: { row1: {}, row2: {} } }]
}];
const REGULAR = { visible: '152.49', hidden: '152.49', regularVatRate: 23, regularVat: '35.07', regularGross: '187.56' };

function footer(template, context) {
  const html = env.render(template, {
    orderDetails: { id: 1, order_idx: 7, status: 'active' }, cleanOrderItems: ITEMS, orderItems: [],
    hidePrices: false, currencySuffix: '€', ...context
  });
  const start = html.indexOf("id='total-container'");
  const end = html.indexOf('send-order-actions', start);
  return html.slice(start, end > -1 ? end : undefined).split('\n')
    .map((l) => l.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter((l) => /order\.total/.test(l));
}

const LINES = ['HKL order.total: 152.49€ netto', 'order.total_vat 23%: 35.07€', 'order.total_gross_incl_vat 23%: 187.56€'];

test('stopka cen zwykłych: HKL Razem netto → VAT x% → brutto (order.njk i order_prices.njk)', () => {
  assert.deepEqual(footer('order.njk', { totalPrice: REGULAR }), LINES);
  assert.deepEqual(footer('order_prices.njk', { totalPrice: REGULAR }), [...LINES, 'order.total_hidden: 152.49€ netto'],
    'widok z odkrytymi cenami: złota suma ukryta pod blokiem VAT jak dotąd');
  assert.deepEqual(footer('order.njk', { isGroup: true, totalPrice: REGULAR }), LINES, 'grupa-matka: HKL Razem = ceny zakupu');
});

test('stopka cen zwykłych bez stawki (VAT wyłączony): sama suma, bez „netto”', () => {
  const off = { visible: '152.49', hidden: '152.49' };
  assert.deepEqual(footer('order.njk', { totalPrice: off }), ['HKL order.total: 152.49€']);
});

test('VAT cen zwykłych pozycji (VAT, WARTOSC_VAT, WARTOSC_BRUTTO) nie trafia do podglądu pozycji — tylko suma w stopce', async () => {
  const { jsonTextBackToMap, POSITION_VAT_KEYS } = require('../orderService');
  const desc = [
    ['MODEL', { param_description: 'MODEL', option_value: 'BB24', row: '1' }],
    ['SUMA_BRUTTO', { param_description: 'WARTOŚĆ', option_value: '100', row: '2', listsum: true }],
    ['VAT', { param_description: 'VAT', option_value: '23%', row: '2' }],
    ['WARTOSC_VAT', { param_description: 'WARTOŚĆ VAT', option_value: '23', row: '2' }],
    ['WARTOSC_BRUTTO', { param_description: 'WARTOŚĆ BRUTTO', option_value: '123', row: '2' }]
  ];
  const { cleanOrderItems } = await jsonTextBackToMap([{ id: 1, json_parameters_desc: JSON.stringify(JSON.stringify(desc)), group_name: 'G', asortment_group_number: 1 }]);
  const [table] = cleanOrderItems;
  const shown = JSON.stringify({ h1: table.headers1, h2: table.headers2, rows: table.rows.map((r) => r.row), sub: table.rows.map((r) => r.item.subParamValues) });
  assert.match(shown, /BB24/);
  assert.doesNotMatch(shown, /WARTOŚĆ VAT|WARTOŚĆ BRUTTO|"23%"/);
  for (const key of ['VAT', 'WARTOSC_VAT', 'WARTOSC_BRUTTO', 'SUB___VAT', 'SUB___WARTOSC_VAT', 'SUB___WARTOSC_BRUTTO']) {
    assert.ok(POSITION_VAT_KEYS.has(key), key);
  }
});
