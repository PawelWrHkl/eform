'use strict';

/**
 * Waluta w SUMACH zlecenia — stopka podglądu (`order.njk`, `order_prices.njk`
 * i dziedziczące: `order_sent*.njk`, korekty admina), wydruk
 * (`order_to_print.njk` / `order_to_print_short.njk`), PDF i mail
 * (`buildPdfSendDataTotals`, `mailBot/order-pdf.njk`).
 *
 * Zgłoszenie 2026-10-09: klient z walutą PLN widział opisy cen „[PLN]”, ale
 * w sekcji total wciąż „€”. Zasada: waluta klienta ZAMÓWIENIA
 * (services/currency.js), EUR wygląda dokładnie jak przed zmianą („100.00€”).
 *
 * Szablony renderowane własnym `nunjucks.Environment` — `nunjucks-setup.js`
 * importuje `server.js`, więc nie nadaje się do testów.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nunjucks = require('nunjucks');

const { formatAmount, currencySuffix, currencyLocals } = require('../currency');
const { buildPdfSendDataTotals } = require('../subPrices');
const { pdfValueParts } = require('../../utils/pdfValueParts');

const ROOT = path.join(__dirname, '..', '..');

function makeEnv(dir) {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(dir), { autoescape: true });
  env.addGlobal('__', (key) => key);
  env.addGlobal('gk', (key) => key);
  env.addFilter('pdfValueParts', pdfValueParts);
  env.addFilter('applyFactor', (value, factor) => ((!factor || factor === 1 || !value) ? value : (parseFloat(value) * factor).toFixed(2)));
  return env;
}

const pagesEnv = makeEnv(path.join(ROOT, 'templates'));
const mailEnv = makeEnv(path.join(ROOT, 'services', 'mailBot'));

const TOTAL_PRICE = { visible: '100.00', hidden: '90.00', subVisible: 120, subLocked: 110, afterClientDiscount: 105 };

/** Jedna pusta pozycja — stopka `#total-container` renderuje się tylko przy pozycjach. */
const CLEAN_ORDER_ITEMS = [{
  headers1: [], headers2: [], headerKeys1: [], headerKeys2: [], locked: [], sub: [],
  rows: [{ item: { id: 1, lockedParams: [], subParamValues: [], clientDiscountValues: [] }, row: { row1: {}, row2: {} } }]
}];

/** Teksty wierszy sum ze STOPKI strony (bez ukrytego wydruku `.pdf-val`). */
function pageTotals(template, context) {
  const html = pagesEnv.render(template, {
    orderDetails: { id: 1, order_idx: 7, status: 'active' },
    cleanOrderItems: CLEAN_ORDER_ITEMS,
    orderItems: [],
    totalPrice: TOTAL_PRICE,
    hidePrices: false,
    ...context
  });
  const start = html.indexOf("id='total-container'");
  assert.notEqual(start, -1, `${template}: brak #total-container`);
  const footer = html.slice(start, html.indexOf('send-order-actions', start) > -1 ? html.indexOf('send-order-actions', start) : undefined);
  return footer
    .split('\n')
    .map((line) => line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter((line) => /order\.total|value_after_discount/.test(line));
}

/** Gałęzie stopki w `order.njk` — po jednej na rolę / tryb cen. */
const ORDER_BRANCHES = {
  'HKL / zwykły klient': {},
  'klient z cenami SUB': { isClient: true, hasSubPrices: true },
  'grupa-matka typu client': { isGroupClientType: true, isGroup: true },
  'konto podrzędne grupy client': { isGroupClientType: true, isGroupShop: true },
  'sklep grupy (shop)': { isGroupShop: true },
  'owner/admin z przełącznikiem SUB, kłódka otwarta': { hasSubPriceToggle: true, showCatalogPrices: true, hasSubPrices: true, prices: true }
};

// ─── Formatowanie ───────────────────────────────────────────────────────────

test('formatAmount: EUR bez spacji jak dotąd, PLN ze spacją, nieznana = EUR', () => {
  assert.equal(formatAmount('103.93', 'EUR'), '103.93€');
  assert.equal(formatAmount('103.93', 'PLN'), '103.93 zł');
  assert.equal(formatAmount(7, undefined), '7€');
  assert.equal(formatAmount('1', 'XYZ'), '1€');
  assert.equal(currencySuffix('pln'), ' zł');
  assert.deepEqual(currencyLocals('PLN'), { priceCurrency: 'PLN', currencySymbol: 'zł', currencySuffix: ' zł' });
  assert.deepEqual(currencyLocals(null), { priceCurrency: 'EUR', currencySymbol: '€', currencySuffix: '€' });
});

// ─── PDF / mail ─────────────────────────────────────────────────────────────

test('buildPdfSendDataTotals: sumy PDF/maila w walucie klienta (wszystkie trzy gałęzie)', () => {
  const totalPrice = { visible: '100.00', hidden: '90.00' };
  const base = { orderItems: [], totalPrice, translate: (key) => key };

  const zwykly = buildPdfSendDataTotals({ ...base, currency: 'PLN' });
  assert.equal(zwykly.total, 'order.total: 100.00 zł');
  assert.equal(zwykly.total_hidden, 'order.total_hidden: 90.00 zł netto');

  const oba = buildPdfSendDataTotals({ ...base, showBoth: true, currency: 'PLN' });
  assert.equal(oba.total, 'order.total: 100.00 zł');

  // Gałąź klienta liczy sumy z pozycji — bez pozycji nie ma czego pokazać,
  // ale nie może też pojawić się „€”.
  const klient = buildPdfSendDataTotals({ ...base, isClientView: true, currency: 'PLN' });
  assert.equal(JSON.stringify(klient).includes('€'), false);
});

test('buildPdfSendDataTotals: bez waluty — dokładnie dawne napisy z „€”', () => {
  const sendData = buildPdfSendDataTotals({ orderItems: [], totalPrice: { visible: '100.00', hidden: '90.00' }, translate: (key) => key });
  assert.equal(sendData.total, 'order.total: 100.00€');
  assert.equal(sendData.total_hidden, 'order.total_hidden: 90.00€ netto');
});

// ─── Stopka podglądu zlecenia ───────────────────────────────────────────────

for (const [name, flags] of Object.entries(ORDER_BRANCHES)) {
  test(`order.njk, ${name}: sumy w PLN, bez „€”`, () => {
    const lines = pageTotals('order.njk', { ...flags, ...currencyLocals('PLN') });
    assert.ok(lines.length > 0, 'stopka ma choć jeden wiersz sumy');
    for (const line of lines) {
      assert.match(line, / zł( netto)?$/, line);
      assert.doesNotMatch(line, /€/, line);
    }
  });

  test(`order.njk, ${name}: EUR wygląda dokładnie jak przed zmianą`, () => {
    const eur = pageTotals('order.njk', { ...flags, ...currencyLocals('EUR') });
    const legacy = pageTotals('order.njk', flags);
    assert.deepEqual(eur, legacy);
    for (const line of eur) assert.match(line, /\d€( netto)?$/, line);
  });
}

test('order_prices.njk (widok z cenami, też order_sent_prices.njk): sumy w PLN', () => {
  for (const flags of [{}, { isClient: true, hasSubPrices: true }, { hasSubPriceToggle: true, hasSubPrices: true }]) {
    const lines = pageTotals('order_prices.njk', { ...flags, prices: true, ...currencyLocals('PLN') });
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.match(line, / zł( netto)?$/, line);
      assert.doesNotMatch(line, /€/, line);
    }
  }
});

test('base.njk podaje window.priceCurrency skryptom strony (rabat kwotowy, Excel)', () => {
  const render = (ctx) => pagesEnv.render('order.njk', {
    orderDetails: { id: 1 }, cleanOrderItems: CLEAN_ORDER_ITEMS, totalPrice: TOTAL_PRICE, ...ctx
  });
  assert.match(render(currencyLocals('PLN')), /<script>window\.priceCurrency = "PLN";<\/script>/);
  assert.match(render({}), /<script>window\.priceCurrency = null;<\/script>/);
});

// ─── Wydruk i PDF ───────────────────────────────────────────────────────────

function renderShortPrint(context) {
  return pagesEnv.render('order_to_print_short.njk', {
    orderDetails: { order_idx: 1 },
    orderItems: [],
    heads: [],
    cleanOrderItems: [],
    totalPrice: TOTAL_PRICE,
    sendData: {},
    ...context
  });
}

/** Teksty `.pdf-val` (kwoty) z wydruku. */
function pdfValues(html) {
  return [...html.matchAll(/<span class="pdf-val">([^<]*)<\/span>/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
}

test('order_to_print_short.njk: sumy i rabat kwotowy w PLN', () => {
  const zCenami = pdfValues(renderShortPrint({ prices: true, ...currencyLocals('PLN') }));
  assert.ok(zCenami.length > 0);
  for (const value of zCenami) assert.doesNotMatch(value, /€/, value);
  assert.ok(zCenami.some((v) => v === '100.00 zł'), zCenami.join(' | '));

  const rabat = pdfValues(renderShortPrint({
    prices: false,
    discountInfo: { type: 'value', discountValue: '10', result: '90.00' },
    ...currencyLocals('PLN')
  }));
  assert.ok(rabat.includes('10 zł'), rabat.join(' | '));
  assert.ok(rabat.includes('90.00 zł'), rabat.join(' | '));
});

test('order_to_print_short.njk: bez waluty — „€” jak dotąd', () => {
  const values = pdfValues(renderShortPrint({ prices: true }));
  assert.ok(values.includes('100.00€'), values.join(' | '));
  const rabat = pdfValues(renderShortPrint({ prices: false, discountInfo: { type: 'value', discountValue: '10', result: '90.00' } }));
  assert.ok(rabat.includes('10 €') && rabat.includes('90.00 €'), rabat.join(' | '));
});

test('mailBot/order-pdf.njk: rabat kwotowy w walucie klienta', () => {
  const render = (ctx) => pdfValues(mailEnv.render('order-pdf.njk', {
    orderDetails: { order_idx: 1 },
    cleanOrderItems: [],
    logoPath: 'data:image/png;base64,test',
    sendData: {},
    prices: false,
    discountInfo: { type: 'value', discountValue: '10', result: '90.00' },
    ...ctx
  }));
  const pln = render({ currencySymbol: 'zł' });
  assert.ok(pln.includes('10 zł') && pln.includes('90.00 zł'), pln.join(' | '));
  const legacy = render({});
  assert.ok(legacy.includes('10 €') && legacy.includes('90.00 €'), legacy.join(' | '));
});

// ─── Nagłówki tabeli pozycji ────────────────────────────────────────────────

const orderService = require('../orderService');
const { makeOrderItem, makeLegacyOrderItem } = require('./fixtures/subPriceOrder');

test('jsonTextBackToMap z walutą: opisy kwot z [€] zapisanym przed 2026-10-08 → [PLN], kłódki pasują do nagłówków', async () => {
  const items = [makeOrderItem({
    json_parameters_desc: [
      ['MODEL', { param_description: 'Model', option_value: 'H50', row: '1' }],
      ['CENA', { param_description: 'CENA HKL [€] netto', option_value: '10', row: '2' }],
      ['CENA_RABAT', { param_description: 'Rabat', option_value: '45%', row: '2' }],
      ['CENA_KONCOWA', { param_description: 'CENA NETTO PO RABACIE [€]', option_value: '5.5', row: '2', locked: true }],
      ['SUMA_BRUTTO', { param_description: 'WARTOŚĆ BR.[€]', option_value: '10', row: '2', listsum: true }],
      ['CENA_S', { param_description: 'CENA HKL [€] netto-spec', option_value: '10(PGE)', row: '2', locked: true }],
      ['SUB___CENA', { param_description: 'CENA DET. [€] netto', option_value: '20', row: '2' }],
      ['SUB___CENA_RABAT', { param_description: 'RABAT', option_value: '43%', row: '2', locked: true }]
    ]
  })];
  const { cleanOrderItems } = await orderService.jsonTextBackToMap(items, { currency: 'PLN' });
  const [table] = cleanOrderItems;
  const headers = [...table.headers1, ...table.headers2];

  assert.ok(headers.includes('CENA HKL netto [PLN]'), headers.join(' | '));
  assert.ok(headers.includes('WARTOŚĆ BR. [PLN]'), headers.join(' | '));
  assert.ok(headers.includes('CENA NETTO PO RABACIE [PLN]'));
  assert.ok(headers.includes('Rabat'), 'stawka rabatu bez waluty');
  assert.ok(headers.includes('Model'));
  assert.equal(headers.some((h) => h.includes('€')), false, headers.join(' | '));
  // Kłódka: zablokowana kolumna musi mieć DOKŁADNIE ten sam opis co nagłówek,
  // inaczej szablon by ją odsłonił.
  assert.ok(table.locked.includes('CENA NETTO PO RABACIE [PLN]'), table.locked.join(' | '));
  assert.deepEqual(table.rows[0].item.lockedParams.filter((l) => l.includes('NETTO')), ['CENA NETTO PO RABACIE [PLN]']);
  // Komórki wiersza są kluczowane tym samym opisem co nagłówek.
  assert.equal(table.rows[0].row.row2['CENA HKL netto [PLN]'], '10');
  assert.ok(table.headerKeys2.includes('CENA HKL netto [PLN]||CENA'), table.headerKeys2.join(' | '));
  // Wiersze SUB (ceny klienta) idą osobną listą — też z walutą klienta.
  const sub = table.rows[0].item.subParamValues;
  assert.equal(sub.find((e) => e.key === 'SUB___CENA').display, 'CENA DET. netto [PLN]');
  assert.equal(sub.find((e) => e.key === 'SUB___CENA_RABAT').display, 'RABAT');
});

test('jsonTextBackToMap bez waluty: opisy dokładnie jak zapisane (stare wywołania bez zmian)', async () => {
  const items = [makeOrderItem(), makeLegacyOrderItem()];
  const legacy = await orderService.jsonTextBackToMap(JSON.parse(JSON.stringify(items)));
  const headers = legacy.cleanOrderItems.flatMap((t) => [...t.headers1, ...t.headers2]);
  assert.ok(headers.includes('Cena katalogowa [€]'));
  assert.ok(headers.includes('Cena [€]'));

  const eur = await orderService.jsonTextBackToMap(JSON.parse(JSON.stringify(items)), { currency: 'EUR' });
  const eurHeaders = eur.cleanOrderItems.flatMap((t) => [...t.headers1, ...t.headers2]);
  assert.ok(eurHeaders.includes('Cena katalogowa [EUR]'), 'z walutą: stary [€] na końcu jako [EUR]');
});

// ─── Która suma (zgłoszenie 2026-10-09, A&A Lohne) ──────────────────────────
// Stopka = to, co widać w tabeli: ceny zwykłe i SUB___ → obie sumy
// („HKL Razem” = zwykłe, „Razem” = SUB___), same SUB___ → tylko SUB___.

function footerLines(template, context) {
  const html = pagesEnv.render(template, {
    orderDetails: { id: 1, order_idx: 7, status: 'active' },
    cleanOrderItems: CLEAN_ORDER_ITEMS,
    orderItems: [],
    totalPrice: TOTAL_PRICE,
    hidePrices: false,
    ...currencyLocals('PLN'),
    ...context
  });
  const start = html.indexOf("id='total-container'");
  const end = html.indexOf('send-order-actions', start);
  return html.slice(start, end > -1 ? end : undefined)
    .split('\n')
    .map((line) => line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter((line) => /order\.total|according_to_price|value_after_discount/.test(line));
}

const OWNER = { hasSubPriceToggle: true, hasSubPrices: true, viewAsOrganization: true };

test('order.njk, admin/owner, kłódka zamknięta (w tabeli tylko SUB___): tylko suma SUB___', () => {
  assert.deepEqual(footerLines('order.njk', { ...OWNER, showCatalogPrices: false }), ['order.total: 120 zł']);
});

test('order.njk, admin/owner, kłódka otwarta (w tabeli zwykłe i SUB___): obie sumy, rozróżnione', () => {
  assert.deepEqual(footerLines('order.njk', { ...OWNER, showCatalogPrices: true }),
    ['HKL order.total: 100.00 zł', 'order.total: 120 zł']);
});

test('order.njk, klient z cenami SUB___: tylko suma SUB___', () => {
  assert.deepEqual(footerLines('order.njk', { isClient: true, hasSubPrices: true, showCatalogPrices: false }), ['order.total: 120 zł']);
});

test('order.njk, klient bez cen SUB___ / klient HKL: tylko suma zwykła', () => {
  assert.deepEqual(footerLines('order.njk', { isClient: true, hasSubPrices: false }), ['order.total: 100.00 zł']);
  assert.deepEqual(footerLines('order.njk', {}), ['HKL order.total: 100.00 zł']);
});

test('order.njk, ceny SUB___ widoczne, ale suma SUB___ = 0: „Według cennika” w linii SUB___, zwykła zostaje', () => {
  const zero = { ...TOTAL_PRICE, subVisible: 0 };
  assert.deepEqual(footerLines('order.njk', { ...OWNER, showCatalogPrices: true, totalPrice: zero }),
    ['HKL order.total: 100.00 zł', 'order.according_to_price']);
  assert.deepEqual(footerLines('order.njk', { ...OWNER, showCatalogPrices: false, totalPrice: zero }), ['order.according_to_price']);
});

test('order_prices.njk: klient — suma SUB___ bez „HKL”; owner/admin — obie sumy przy kłódce', () => {
  const klient = footerLines('order_prices.njk', { isClient: true, hasSubPrices: true, prices: true });
  assert.equal(klient[0], 'order.total: 120 zł');
  const owner = footerLines('order_prices.njk', { ...OWNER, showCatalogPrices: true, prices: true });
  assert.deepEqual(owner.slice(0, 2), ['HKL order.total: 100.00 zł', 'order.total: 120 zł']);
  const ownerZero = footerLines('order_prices.njk', { ...OWNER, showCatalogPrices: false, prices: true, totalPrice: { ...TOTAL_PRICE, subVisible: 0 } });
  assert.equal(ownerZero[0], 'order.according_to_price');
});

// ─── Stare pozycje bez wierszy sum SUB___ ──────────────────────────────────

const { calcSubTotals } = require('../subPrices');

test('calcSubTotals: pozycja bez wierszy sum SUB___ w opisie — sumy z wartości (kształt pozycji 1283)', () => {
  const legacy = {
    json_parameters: { SUB___CENA: 172, SUB___SUMA_BRUTTO: 213.3, SUB___WARTOSC_KONCOWA: 85.32, SUMA_BRUTTO: 59.16 },
    json_parameters_desc: [
      ['CENA', { param_description: 'CENA DET. brutto [PLN]', option_value: '45.08', row: '2' }],
      ['SUMA_BRUTTO', { param_description: 'WARTOŚĆ BR. [PLN]', option_value: '59.16', row: '2', listsum: true }],
      ['WARTOSC_KONCOWA', { param_description: 'WART. NET. PO RABACIE [PLN]', option_value: '59.16', row: '2', listsum: true, locked: true }],
      ['SUB___CENA', { param_description: 'CENA DET. brutto [PLN]', option_value: '172', row: '2', sub: true }],
      ['SUB___CENA_RABAT', { param_description: 'RABAT', option_value: '60%', row: '2', locked: true, sub: true }]
    ]
  };
  assert.deepEqual(calcSubTotals([legacy]), { subVisible: 213.3, subLocked: 85.32 });
  // Wartości zapisane jako tekst JSON (podwójnie) — jak w części starych wierszy.
  assert.deepEqual(calcSubTotals([{ ...legacy, json_parameters: JSON.stringify(JSON.stringify(legacy.json_parameters)) }]),
    { subVisible: 213.3, subLocked: 85.32 });
});

test('calcSubTotals: pozycja Z wierszami sum SUB___ — liczone jak dotąd (wartości nie są czytane)', () => {
  const item = {
    json_parameters: { SUB___SUMA_BRUTTO: 999 },
    json_parameters_desc: [
      ['SUB___SUMA_BRUTTO', { option_value: '120', listsum: true }],
      ['SUB___WARTOSC_KONCOWA', { option_value: '48', listsum: true, locked: true }],
      ['SUMA_BRUTTO', { option_value: '100', listsum: true }]
    ]
  };
  assert.deepEqual(calcSubTotals([item]), { subVisible: 120, subLocked: 48 });
  // Pozycja bez żadnych cen SUB___ — nic nie dopisujemy.
  assert.deepEqual(calcSubTotals([{ json_parameters: { SUB___SUMA_BRUTTO: 5 }, json_parameters_desc: [['SUMA_BRUTTO', { option_value: '1', listsum: true }]] }]),
    { subVisible: 0, subLocked: 0 });
});

// ─── Wydruk i PDF: ta sama reguła ───────────────────────────────────────────

test('buildPdfSendDataTotals showBoth + withSubTotal: suma SUB___ obok zwykłej; bez flagi (grupy) jak dotąd', () => {
  const orderItems = [{ json_parameters_desc: [['SUB___SUMA_BRUTTO', { option_value: '120', listsum: true }], ['SUB___WARTOSC_KONCOWA', { option_value: '48', listsum: true, locked: true }]] }];
  const base = { showBoth: true, orderItems, totalPrice: { visible: '100.00' }, translate: (k) => k, currency: 'PLN' };
  assert.deepEqual(buildPdfSendDataTotals({ ...base, withSubTotal: true }),
    { total: 'order.total: 100.00 zł', total_hidden: 'order.total_hidden: 48 zł netto', total_sub: 'order.total: 120 zł' });
  assert.equal('total_sub' in buildPdfSendDataTotals(base), false);
});

test('order_to_print_short.njk, showBoth: „HKL Razem” zwykła + „Razem” SUB___; grupa i widok klienta bez zmian', () => {
  const both = pdfValues(renderShortPrint({ prices: false, showBoth: true, ...currencyLocals('PLN') }));
  assert.ok(both.includes('100.00 zł') && both.includes('120 zł'), both.join(' | '));
  const html = renderShortPrint({ prices: false, showBoth: true, ...currencyLocals('PLN') }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(html, /HKL order\.total: 100\.00 zł order\.total: 120 zł/);
  const group = renderShortPrint({ prices: false, showBoth: true, isGroup: true, ...currencyLocals('PLN') }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(group, /HKL order\.total/);
  assert.doesNotMatch(group, /order\.total: 120 zł/);
});

test('mailBot/order-pdf.njk: total_sub → „HKL Razem” + „Razem”; bez total_sub jak dotąd', () => {
  const render = (sendData) => mailEnv.render('order-pdf.njk', {
    orderDetails: { order_idx: 1 }, cleanOrderItems: [], logoPath: 'data:,', prices: true, sendData
  }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(render({ total: 'order.total: 100.00 zł', total_sub: 'order.total: 120 zł' }), /HKL order\.total: 100\.00 zł order\.total: 120 zł/);
  const legacy = render({ total: 'order.total: 100.00 zł' });
  assert.match(legacy, /order\.total: 100\.00 zł/);
  assert.doesNotMatch(legacy, /HKL order\.total/);
});
