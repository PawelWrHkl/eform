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

const { formatAmount, currencySuffix, currencyLocals, applyFactor } = require('../currency');
const { buildPdfSendDataTotals } = require('../subPrices');
const { pdfValueParts } = require('../../utils/pdfValueParts');

const ROOT = path.join(__dirname, '..', '..');

function makeEnv(dir) {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(dir), { autoescape: true });
  env.addGlobal('__', (key) => key);
  env.addGlobal('gk', (key) => key);
  env.addFilter('pdfValueParts', pdfValueParts);
  // Prawdziwy filtr (nunjucks-setup.js i środowiska PDF) — kwoty z dwoma miejscami.
  env.addFilter('applyFactor', applyFactor);
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
  assert.equal(formatAmount(7, undefined), '7.00€');
  assert.equal(formatAmount('1', 'XYZ'), '1.00€');
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
  assert.deepEqual(footerLines('order.njk', { ...OWNER, showCatalogPrices: false }), ['order.total_list_gross: 120.00 zł']);
});

test('order.njk, admin/owner, kłódka otwarta (w tabeli zwykłe i SUB___): obie sumy, rozróżnione', () => {
  assert.deepEqual(footerLines('order.njk', { ...OWNER, showCatalogPrices: true }),
    ['HKL order.total: 100.00 zł', 'order.total_list_gross: 120.00 zł']);
});

test('order.njk, klient z cenami SUB___: tylko suma SUB___', () => {
  assert.deepEqual(footerLines('order.njk', { isClient: true, hasSubPrices: true, showCatalogPrices: false }), ['order.total_list_gross: 120.00 zł']);
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
  assert.equal(klient[0], 'order.total_list_gross: 120.00 zł');
  const owner = footerLines('order_prices.njk', { ...OWNER, showCatalogPrices: true, prices: true });
  assert.deepEqual(owner.slice(0, 2), ['HKL order.total: 100.00 zł', 'order.total_list_gross: 120.00 zł']);
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
    { total: 'order.total: 100.00 zł', total_hidden_is_sub: true, total_hidden: 'order.total_hidden: 48.00 zł netto', total_sub: 'order.total_list_gross: 120.00 zł' });
  assert.equal('total_sub' in buildPdfSendDataTotals(base), false);
});

test('order_to_print_short.njk, showBoth: „HKL Razem” zwykła + „Razem” SUB___; grupa i widok klienta bez zmian', () => {
  const both = pdfValues(renderShortPrint({ prices: false, showBoth: true, ...currencyLocals('PLN') }));
  assert.ok(both.includes('100.00 zł') && both.includes('120.00 zł'), both.join(' | '));
  const html = renderShortPrint({ prices: false, showBoth: true, ...currencyLocals('PLN') }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(html, /HKL order\.total: 100\.00 zł order\.total_list_gross: 120.00 zł/);
  const group = renderShortPrint({ prices: false, showBoth: true, isGroup: true, ...currencyLocals('PLN') }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(group, /HKL order\.total/);
  assert.doesNotMatch(group, /order\.total: 120.00 zł/);
});

test('mailBot/order-pdf.njk: total_sub → „HKL Razem” + „Razem”; bez total_sub jak dotąd', () => {
  const render = (sendData) => mailEnv.render('order-pdf.njk', {
    orderDetails: { order_idx: 1 }, cleanOrderItems: [], logoPath: 'data:,', prices: true, sendData
  }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(render({ total: 'order.total: 100.00 zł', total_sub: 'order.total_list_gross: 120.00 zł' }), /HKL order\.total: 100\.00 zł order\.total_list_gross: 120.00 zł/);
  // `total_sub` zbudowany przed 2026-10-26 (stara etykieta) — kwota bez podwójnej etykiety.
  assert.match(render({ total: 'order.total: 100.00 zł', total_sub: 'order.total: 120.00 zł' }), /order\.total_list_gross: 120.00 zł/);
  const legacy = render({ total: 'order.total: 100.00 zł' });
  assert.match(legacy, /order\.total: 100\.00 zł/);
  assert.doesNotMatch(legacy, /HKL order\.total/);
});

// ─── VAT pod ukrytą sumą klienta (decyzja właściciela 2026-10-26) ───────────
// „GESAMTBETRAG LISTENPREIS BRUTTO” zamiast „Gesamtbetrag” przy sumie SUB___,
// a pod złotą sumą po rabacie (po kłódce): „VAT 19%: …” i „Brutto Betrag inkl.
// MwSt: …”, liczone od `subLocked` — w każdym wariancie stopki, wydruku i PDF.

const { computeVatTotals } = require('../subPrices');
// `subLocked` 110 przy 19% → VAT 20.90, brutto 130.90.
const VAT_TOTAL_PRICE = { ...TOTAL_PRICE, vatRate: 19, subVat: '20.90', subGross: '130.90' };
const VAT_LINES = ['order.total_vat 19%: 20.90 zł', 'order.total_gross_incl_vat: 130.90 zł'];

test('computeVatTotals: VAT od sumy (nie sumą zaokrągleń), brak stawki lub sumy → null', () => {
  assert.deepEqual(computeVatTotals(110, 19), { vat: '20.90', gross: '130.90' });
  assert.deepEqual(computeVatTotals('84.15', 19), { vat: '15.99', gross: '100.14' });
  assert.deepEqual(computeVatTotals(50, 0), { vat: '0.00', gross: '50.00' }, '0% (reverse charge) to prawdziwa stawka');
  assert.equal(computeVatTotals(110, null), null, 'VAT wyłączony');
  assert.equal(computeVatTotals(0, 19), null);
});

test('order_prices.njk po kłódce: klient i owner/admin — VAT i brutto zaraz pod złotą sumą klienta', () => {
  const klient = footerLines('order_prices.njk', { isClient: true, hasSubPrices: true, prices: true, totalPrice: VAT_TOTAL_PRICE });
  assert.deepEqual(klient, ['order.total_list_gross: 120.00 zł', 'order.total_hidden: 110.00 zł netto', ...VAT_LINES]);
  const owner = footerLines('order_prices.njk', { ...OWNER, showCatalogPrices: true, prices: true, totalPrice: VAT_TOTAL_PRICE });
  assert.deepEqual(owner.slice(-3), ['order.total_hidden: 110.00 zł netto', ...VAT_LINES]);
});

test('order.njk: VAT tylko przy odsłoniętej złotej sumie; bez stawki (VAT wyłączony) nic nie dochodzi', () => {
  const unlocked = footerLines('order.njk', { ...OWNER, showCatalogPrices: true, prices: true, totalPrice: VAT_TOTAL_PRICE });
  assert.deepEqual(unlocked.slice(-3), ['order.total_hidden: 110.00 zł netto', ...VAT_LINES]);
  const locked = footerLines('order.njk', { ...OWNER, showCatalogPrices: true, totalPrice: VAT_TOTAL_PRICE });
  assert.equal(locked.some((l) => l.includes('total_vat')), false, 'przed kłódką VAT-u nie ma');
  const off = footerLines('order_prices.njk', { isClient: true, hasSubPrices: true, prices: true });
  assert.equal(off.some((l) => /total_vat|total_gross_incl_vat/.test(l)), false);
});

// ─── Grupa-matka i konto podrzędne (decyzja właściciela 2026-10-27) ─────────
// Jak klient organizacji spoza HKL: ceny wg cennika zawsze, a pod kłódką
// „Pokaż cenę po rabacie” złoty wiersz i złote sumy — po rabacie netto, VAT, brutto.

const GROUP_ROLES = {
  'grupa-matka typu client': { isGroup: true, isGroupClientType: true },
  'grupa-matka typu shop': { isGroup: true },
  'konto podrzędne grupy client': { isGroupShop: true, isGroupClientType: true },
  'sklep grupy (shop)': { isGroupShop: true }
};
const GOLD_TOTALS = ['order.total_hidden: 110.00 zł netto', ...VAT_LINES];

test('stopka grupy: HKL Razem tylko u matki, Razem wg cennika zawsze, po kłódce złota suma po rabacie — bez VAT-u cen klienta', () => {
  for (const [name, role] of Object.entries(GROUP_ROLES)) {
    const head = [...(role.isGroup ? ['HKL order.total: 100.00 zł'] : []), 'order.total_list_gross: 120.00 zł'];
    const ctx = { ...role, hasSubPrices: true, totalPrice: VAT_TOTAL_PRICE };
    assert.deepEqual(footerLines('order.njk', ctx), head, `${name}: kłódka zamknięta`);
    // Grupa VAT-u cen klienta nie widzi nigdy (właściciel 2026-10-27) — sama suma po rabacie
    const gold = GOLD_TOTALS.slice(0, 1);
    assert.deepEqual(footerLines('order.njk', { ...ctx, discountPricesUnlocked: true }), [...head, ...gold], `${name}: kłódka otwarta`);
  }
});

test('stopka grupy: bez stawki VAT (VAT_ENABLED wyłączony) po kłódce zostaje sama suma po rabacie', () => {
  const lines = footerLines('order.njk', { isGroup: true, hasSubPrices: true, discountPricesUnlocked: true });
  assert.deepEqual(lines, ['HKL order.total: 100.00 zł', 'order.total_list_gross: 120.00 zł', 'order.total_hidden: 110.00 zł netto']);
});

const { attachGroupGoldValues } = require('../subPrices');

function groupItem(subParamValues) {
  return [{ ...CLEAN_ORDER_ITEMS[0], rows: [{ item: { id: 1, lockedParams: [], subParamValues, clientDiscountValues: [] }, row: { row1: {}, row2: {} } }] }];
}

test('attachGroupGoldValues: pozycja sprzed rozbicia — procent matki, wartość 1 szt. i wartość netto po rabacie', () => {
  const items = groupItem([
    { key: 'SUB___SUMA_BRUTTO', display: 'WARTOŚĆ BR.', value: '394.50', locked: false },
    { key: 'SUB___CENA_RABAT', display: 'RABAT', value: '60%', locked: true },
    { key: 'SUB___RABAT_KLIENTA', display: 'Rabat klienta', value: '45%', locked: true },
    { key: 'SUB___CENA_KONCOWA', display: 'CENA NETTO PO RABACIE', value: '72.33', locked: true },
    { key: 'SUB___WARTOSC_KONCOWA', display: 'WART. NET. PO RABACIE', value: '217.00', locked: true },
    // VAT zapisany przy pozycji — nie trafia do złotego wiersza
    { key: 'SUB___WARTOSC_VAT', display: 'VAT stary', value: '36.29', locked: true }
  ]);
  attachGroupGoldValues(items, { labels: { percent: 'Rabat klienta', unit: 'Cena po rabacie za szt. [PLN]', unitValue: 'Wartość 1 szt. po rabacie [PLN]', gross: 'Wartość netto po rabacie [PLN]' } });
  const gold = items[0].rows[0].item.groupGoldValues.map((e) => `${e.display}: ${e.value}`);
  assert.deepEqual(gold, ['Rabat klienta: 45%', 'Wartość 1 szt. po rabacie [PLN]: 72.33', 'Wartość netto po rabacie [PLN]: 217.00']);
});

test('attachGroupGoldValues: schemat z dopłatą (2026-10-27) — rabat, cena po rabacie, rabat na dopłatę, dopłata po rabacie, wartość 1 szt., × ilość', () => {
  const items = groupItem([
    { key: 'SUB___SUMA_BRUTTO', display: 'WARTOŚĆ BR.', value: '739.88', locked: false },
    { key: 'SUB___CENA_RABAT', display: 'RABAT', value: '0', locked: true },
    { key: 'SUB___RABAT_KLIENTA', display: 'Rabat klienta', value: '50%', locked: true },
    { key: 'SUB___CENA_PO_RABACIE', display: 'x', value: '141.6', locked: true },
    { key: 'SUB___RABAT_DOPLATY', display: 'x', value: '30%', locked: true },
    { key: 'SUB___DOPLATA_EL_RABAT', display: 'RABAT EL', value: '40%', locked: true },
    { key: 'SUB___DOPLATA_PO_RABACIE', display: 'x', value: '60.72', locked: true },
    { key: 'SUB___CENA_KONCOWA', display: 'CENA NETTO PO RABACIE', value: '202.32', locked: true },
    { key: 'SUB___WARTOSC_KONCOWA', display: 'WART. NET. PO RABACIE', value: '404.64', locked: true }
  ]);
  attachGroupGoldValues(items, { labels: {
    percent: 'Rabat klienta', unit: 'Cena po rabacie za szt. [EUR]', surchargePercent: 'Rabat na dopłatę',
    surcharge: 'Dopłata po rabacie [EUR]', unitValue: 'Wartość 1 szt. po rabacie [EUR]', gross: 'Wartość netto po rabacie [EUR]'
  } });
  assert.deepEqual(items[0].rows[0].item.groupGoldValues.map((e) => `${e.display}: ${e.value}`), [
    'Rabat klienta: 50%',
    'Cena po rabacie za szt. [EUR]: 141.6',
    'Rabat na dopłatę: 30%',
    'RABAT EL: 40%',
    'Dopłata po rabacie [EUR]: 60.72',
    'Wartość 1 szt. po rabacie [EUR]: 202.32',
    'Wartość netto po rabacie [EUR]: 404.64'
  ]);
});

test('attachGroupGoldValues: RABAT EL (parametr cennika) widoczny pod kłódką także w starych pozycjach; zerowy — nie', () => {
  const items = groupItem([
    { key: 'SUB___RABAT_KLIENTA', display: 'Rabat klienta', value: '60%', locked: true },
    { key: 'SUB___DOPLATA_EL_RABAT', display: 'RABAT EL', value: '40%', locked: true },
    { key: 'SUB___WARTOSC_KONCOWA', display: 'WART. NET. PO RABACIE', value: '640.00', locked: true }
  ]);
  attachGroupGoldValues(items, { labels: { percent: 'Rabat klienta', gross: 'Wartość netto po rabacie' } });
  assert.deepEqual(items[0].rows[0].item.groupGoldValues.map((e) => `${e.display}: ${e.value}`),
    ['Rabat klienta: 60%', 'RABAT EL: 40%', 'Wartość netto po rabacie: 640.00']);
  const zero = groupItem([{ key: 'SUB___DOPLATA_EL_RABAT', display: 'RABAT EL', value: '0%', locked: true }]);
  attachGroupGoldValues(zero, { clientPct: 0 });
  assert.deepEqual(zero[0].rows[0].item.groupGoldValues, [], 'RABAT EL 0% nic nie obniża — nie pokazujemy');
});

test('attachGroupGoldValues: rabat z konta, gdy pozycja go nie ma — NIE cennikowy SUB___CENA_RABAT', () => {
  const items = groupItem([
    { key: 'SUB___CENA_RABAT', display: 'RABAT', value: '60%', locked: true },
    { key: 'SUB___WARTOSC_KONCOWA', display: 'WART. NET. PO RABACIE', value: '70.00', locked: true }
  ]);
  attachGroupGoldValues(items, { clientPct: 45, labels: { percent: 'Rabat klienta', gross: 'Brutto po rabacie' } });
  assert.deepEqual(items[0].rows[0].item.groupGoldValues.map((e) => `${e.display}: ${e.value}`),
    ['Rabat klienta: 45%', 'Brutto po rabacie: 70.00']);
  // Brak ceny za sztukę w pozycji (stare zapisy) — nic nie dopisujemy zamiast niej.
});

test('attachGroupGoldValues: bez rabatu matki i bez wartości po rabacie — złoty wiersz pusty', () => {
  const items = groupItem([{ key: 'SUB___CENA_RABAT', display: 'RABAT', value: '60%', locked: true }]);
  attachGroupGoldValues(items, { clientPct: 0 });
  assert.deepEqual(items[0].rows[0].item.groupGoldValues, []);
});

test('order.njk, grupa: wiersz cennika zawsze, złoty wiersz po kłódce; VAT pozycji nigdzie, VAT tylko w sumie', () => {
  // `orderService` nie wpuszcza VAT-u pozycji do `subParamValues` — tak wygląda realny wynik.
  const items = groupItem([
    { key: 'SUB___SUMA_BRUTTO', display: 'WARTOŚĆ BR.', value: '394.50', locked: false },
    { key: 'SUB___WARTOSC_KONCOWA', display: 'WART. NET. PO RABACIE', value: '157.80', locked: true }
  ]);
  attachGroupGoldValues(items);
  const render = (ctx) => pagesEnv.render('order.njk', {
    orderDetails: { id: 1, order_idx: 7, status: 'active' }, cleanOrderItems: items, orderItems: [],
    totalPrice: VAT_TOTAL_PRICE, hidePrices: false, hasSubPrices: true, ...currencyLocals('PLN'), ...ctx
  });
  const table = (html) => html.slice(0, html.indexOf("id='total-container'"));
  for (const role of [{ isGroup: true, isGroupClientType: true }, { isGroupShop: true }]) {
    const locked = table(render(role));
    assert.match(locked, /WARTOŚĆ BR\.:<\/span>\s*<b class="sub-param-value">394\.50/, JSON.stringify(role));
    assert.doesNotMatch(locked, /sub-params-locked-row|WART\. NET\. PO RABACIE/, JSON.stringify(role));
    const open = render({ ...role, discountPricesUnlocked: true });
    const openTable = table(open);
    assert.match(openTable, /sub-params-locked-row/);
    assert.match(openTable, /sub-param-item gold">\s*<span class="sub-param-label">WART\. NET\. PO RABACIE:/, JSON.stringify(role));
    assert.doesNotMatch(open, /VAT \[%\]|WARTOŚĆ VAT|WARTOŚĆ BRUTTO \[PLN\]:<\/span>\s*<b class="sub-param-value">194/, 'VAT pozycji nie pokazujemy');
    assert.doesNotMatch(open, /<tr class="sub-params-row client-discount-row/, 'stary bursztynowy wiersz rabatu zniknął');
    // Grupa (matka i konto podrzędne) VAT-u cen klienta nie widzi nigdy, także po kłódce (właściciel 2026-10-27)
    assert.doesNotMatch(open, /order\.total_vat|order\.total_gross_incl_vat/, 'grupa bez VAT-u cen klienta');
  }
});

test('buildPdfSendDataTotals: `vatRate` dokłada total_vat/total_gross pod sumą klienta; bez stawki — nie', () => {
  const orderItems = [{ json_parameters_desc: [['SUB___SUMA_BRUTTO', { option_value: '120', listsum: true }], ['SUB___WARTOSC_KONCOWA', { option_value: '110', listsum: true, locked: true }]] }];
  const base = { orderItems, totalPrice: { visible: '100.00' }, translate: (k) => k, currency: 'PLN' };
  const client = buildPdfSendDataTotals({ ...base, isClientView: true, vatRate: 19 });
  assert.equal(client.total, 'order.total_list_gross: 120.00 zł');
  assert.equal(client.total_is_sub, true);
  assert.equal(client.total_vat, 'order.total_vat 19%: 20.90 zł');
  assert.equal(client.total_gross, 'order.total_gross_incl_vat: 130.90 zł');
  const both = buildPdfSendDataTotals({ ...base, showBoth: true, withSubTotal: true, vatRate: 19 });
  assert.equal(both.total_vat, 'order.total_vat 19%: 20.90 zł');
  assert.equal('total_vat' in buildPdfSendDataTotals({ ...base, isClientView: true }), false);
  // Ceny zwykłe (bez cen klienta w dokumencie) — złota suma to nie cena klienta, VAT-u nie dokładamy.
  assert.equal('total_vat' in buildPdfSendDataTotals({ ...base, totalPrice: { visible: '100.00', hidden: '90.00' }, vatRate: 19 }), false);
});

test('mailBot/order-pdf.njk i wydruk: wiersze VAT pod sumą po rabacie', () => {
  const sendData = {
    total: 'order.total_list_gross: 120.00 zł', total_is_sub: true, total_hidden_is_sub: true, total_hidden: 'order.total_hidden: 110.00 zł netto',
    total_vat: 'order.total_vat 19%: 20.90 zł', total_gross: 'order.total_gross_incl_vat: 130.90 zł'
  };
  const pdf = mailEnv.render('order-pdf.njk', {
    orderDetails: { order_idx: 1 }, cleanOrderItems: [], logoPath: 'data:,', prices: true, sendData
  }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(pdf, /order\.total_list_gross: 120.00 zł order\.total_hidden: 110.00 zł netto order\.total_vat 19%: 20\.90 zł order\.total_gross_incl_vat: 130\.90 zł/);

  const print = pagesEnv.render('order_to_print.njk', {
    orderDetails: { order_idx: 1 }, cleanOrderItems: [], prices: true, clientView: true,
    totalPrice: VAT_TOTAL_PRICE, ...currencyLocals('PLN')
  }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(print, /order\.total_list_gross: 120.00 zł .*order\.total_hidden: 110.00 zł netto order\.total_vat 19%: 20\.90 zł order\.total_gross_incl_vat: 130\.90 zł/);
});

// ─── Kłódka rabatu grupy (decyzja właściciela 2026-10-27) ───────────────────
// Bez rabatu konta podrzędnego (albo zamówienie wprost przez grupę) kłódki nie ma.

test('order.njk: kłódka „Pokaż cenę po rabacie” tylko gdy zlecenie ma rabat konta podrzędnego', () => {
  const render = (ctx) => pagesEnv.render('order.njk', {
    orderDetails: { id: 1, order_idx: 7, status: 'active' }, cleanOrderItems: CLEAN_ORDER_ITEMS, orderItems: [],
    totalPrice: TOTAL_PRICE, hidePrices: false, isGroup: true, ...ctx
  });
  assert.match(render({ groupDiscountLock: true }), /id="showDiscountPriceBtn"/);
  assert.doesNotMatch(render({ groupDiscountLock: false }), /showDiscountPriceBtn/);
  assert.doesNotMatch(render({}), /showDiscountPriceBtn/, 'bez flagi — bez kłódki');
});

// ─── Stopka w dwóch kolumnach (właściciel 2026-10-27) ───────────────────────
// Lewa kolumna = sumy cen zwykłych (P), prawa = sumy cen klienta SUB___ (N);
// gdy jest tylko jedna, nie ma pustej drugiej (CSS dosuwa ją do prawej).

function totalsColumns(html) {
  // Stopka strony (`.totals-split`) ma pierwszeństwo — order.njk zawiera też
  // ukryty wydruk z własną stopką (`.print-totals-split`).
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(html).window.document;
  const box = doc.querySelector('#total-container.totals-split') || doc.querySelector('#total-container');
  const col = (cls) => {
    const el = box && box.querySelector(`:scope > .totals-col--${cls}`);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  };
  return { regular: col('regular'), sub: col('sub') };
}

// Ten sam kontekst co `footerLines` — bez pozycji stopka zlecenia się nie renderuje.
const pageHtml = (template, context) => pagesEnv.render(template, {
  orderDetails: { id: 1, order_idx: 7, status: 'active' }, cleanOrderItems: CLEAN_ORDER_ITEMS,
  orderItems: [], totalPrice: TOTAL_PRICE, hidePrices: false, ...currencyLocals('PLN'), ...context
});

test('kolumny stopki order.njk: P po lewej, N (z ceną po rabacie i VAT-em) po prawej; jedna kolumna gdy jeden zestaw', () => {
  const owner = totalsColumns(pageHtml('order.njk', { ...OWNER, showCatalogPrices: true, prices: true, totalPrice: VAT_TOTAL_PRICE, ...currencyLocals('PLN') }));
  assert.match(owner.regular, /^HKL order\.total: 100\.00 zł/);
  assert.doesNotMatch(owner.regular, /total_list_gross|total_hidden/);
  assert.match(owner.sub, /^order\.total_list_gross: 120\.00 zł order\.total_hidden: 110\.00 zł netto order\.total_vat 19%/);
  const client = totalsColumns(pageHtml('order.njk', { isClient: true, hasSubPrices: true, totalPrice: TOTAL_PRICE, ...currencyLocals('PLN') }));
  assert.equal(client.regular, null, 'klient z cenami SUB___ — bez kolumny P');
  assert.match(client.sub, /order\.total_list_gross: 120\.00 zł/);
  const hkl = totalsColumns(pageHtml('order.njk', { isClient: true, totalPrice: TOTAL_PRICE, ...currencyLocals('PLN') }));
  assert.equal(hkl.sub, null, 'klient HKL — bez kolumny N');
  assert.match(hkl.regular, /order\.total: 100\.00 zł/);
});

test('kolumny stopki order_prices.njk: owner — P | N; klient bez cen SUB___ — suma i złota suma zwykła w kolumnie P', () => {
  const owner = totalsColumns(pageHtml('order_prices.njk', { ...OWNER, showCatalogPrices: true, prices: true, totalPrice: TOTAL_PRICE, ...currencyLocals('PLN') }));
  assert.match(owner.regular, /HKL order\.total: 100\.00 zł/);
  assert.match(owner.sub, /order\.total_list_gross: 120\.00 zł order\.total_hidden: 110\.00 zł netto/);
  const plain = totalsColumns(pageHtml('order_prices.njk', { prices: true, totalPrice: TOTAL_PRICE, ...currencyLocals('PLN') }));
  assert.equal(plain.sub, null);
  assert.match(plain.regular, /order\.total: 100\.00 zł order\.total_hidden: 90\.00 zł netto/);
});

test('kolumny PDF (mail) i wydruku: suma ukryta i VAT w kolumnie wg znaczników z buildPdfSendDataTotals', () => {
  const orderItems = [{ json_parameters_desc: [['SUB___SUMA_BRUTTO', { option_value: '120', listsum: true }], ['SUB___WARTOSC_KONCOWA', { option_value: '110', listsum: true, locked: true }]] }];
  const mail = (sendData) => totalsColumns(mailEnv.render('order-pdf.njk', { orderDetails: { order_idx: 1 }, cleanOrderItems: [], logoPath: 'data:,', prices: true, sendData }));
  const base = { orderItems, translate: (k) => k, currency: 'PLN', vatRate: 19 };
  // Ceny zwykłe + SUB___: P = HKL Razem, N = Razem wg cennika + po rabacie + VAT.
  const both = mail(buildPdfSendDataTotals({ ...base, showBoth: true, withSubTotal: true, totalPrice: { visible: '100.00' } }));
  assert.match(both.regular, /^HKL order\.total: 100\.00 zł$/);
  assert.match(both.sub, /^order\.total_list_gross: 120\.00 zł order\.total_hidden: 110\.00 zł netto order\.total_vat 19%/);
  // Zlecenie grupy: VAT liczony od cen zwykłych → do kolumny P.
  const group = mail(buildPdfSendDataTotals({ ...base, showBoth: true, totalPrice: { visible: '100.00', hidden: '90.00', vatBase: 90, vatBaseIsRegular: true } }));
  assert.match(group.regular, /order\.total_vat 19%: 17\.10 zł/);
  assert.doesNotMatch(group.sub || '', /total_vat/);
  // Widok klienta: wszystko w N, bez kolumny P.
  const client = mail(buildPdfSendDataTotals({ ...base, isClientView: true, totalPrice: { visible: '100.00' } }));
  assert.equal(client.regular, null);
  // Ceny zwykłe bez SUB___: suma i złota suma zwykła w P, bez kolumny N.
  const plain = mail(buildPdfSendDataTotals({ ...base, vatRate: null, totalPrice: { visible: '100.00', hidden: '90.00' } }));
  assert.equal(plain.sub, null);
  assert.match(plain.regular, /order\.total: 100\.00 zł order\.total_hidden: 90\.00 zł netto/);
  // Dokument bez cen nie dostaje wierszy VAT.
  const noPrice = mailEnv.render('order-pdf.njk', { orderDetails: { order_idx: 1 }, cleanOrderItems: [], logoPath: 'data:,', prices: true, withoutPrices: true,
    sendData: { total_vat: 'order.total_vat 19%: 20.90 zł', total_gross: 'order.total_gross_incl_vat 19%: 130.90 zł' } });
  assert.doesNotMatch(noPrice, /total_vat/);
  // Wydruk (krótki PDF) — owner z oboma zestawami.
  const print = totalsColumns(renderShortPrint({ prices: false, showBoth: true, ...currencyLocals('PLN') }));
  assert.match(print.regular, /HKL order\.total: 100\.00 zł/);
  assert.match(print.sub, /order\.total_list_gross: 120\.00 zł/);
});
