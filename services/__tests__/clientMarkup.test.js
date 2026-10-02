'use strict';

/**
 * Narzut klienta grupy (`user.group_price_mode = 'markup'`) w formularzu pozycji
 * — `pricesCalculator.js applyClientMarkup`, wołane z `applyClientDiscount`.
 *
 * Klient grupy rozliczanej narzutem widzi ceny ZWYKŁE powiększone o narzut, a nie
 * ceny `SUB___` z rabatem. Ponieważ ceną klienta w całej aplikacji jest łańcuch
 * `SUB___*`, narzut przepisuje do niego ceny zwykłe × (1 + narzut) — reszta
 * (podgląd, sumy, PDF, faktura) czyta `SUB___` jak dotąd.
 *
 * Test uruchamia PRAWDZIWE moduły przeglądarkowe (zbundlowane esbuildem, w JSDOM)
 * — tak samo jak services/__tests__/clientDiscountInFinalValue.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const PRICES = path.join(ROOT, 'public', 'scripts', 'formTools', 'pricesCalculator.js');
const FORM = path.join(ROOT, 'public', 'scripts', 'form.js');

let cachedFormula = null;
function buildFormulaHandler() {
  if (cachedFormula === null) {
    const parser = fs.readFileSync(
      path.join(ROOT, 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'), 'utf8');
    cachedFormula = parser + '\n;' + fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'formula.js'), 'utf8');
  }
  return cachedFormula;
}

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  const result = esbuild.buildSync({
    stdin: {
      contents: `
        export { applyClientDiscount, applyClientMarkup } from ${JSON.stringify(PRICES)};
        export { getTotal } from ${JSON.stringify(FORM)};
      `,
      resolveDir: ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: '__markupTest',
    write: false,
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  });
  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

function makeWindow({
  clientPriceMode = 'markup',
  clientMarkupPercent = 0,
  clientDiscountPercent = 0,
  portalUsageDiscountPercent = 0,
  body = ''
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: 'outside-only' });
  const { window } = dom;
  const slownik = { 'form.portal_usage_discount_label': '{percent}% rabatu za korzystanie z serwisu' };
  window.t = (key, vars) => {
    const value = slownik[key] || key;
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (ph, nazwa) =>
      Object.prototype.hasOwnProperty.call(vars, nazwa) ? String(vars[nazwa]) : ph);
  };
  window.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, body: { version: 'Testowa' } }),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new window.Blob([]))
  });
  window.console.log = () => {};
  window.console.error = () => {};
  const noop = () => {};
  window.toastr = { success: noop, error: noop, warning: noop, info: noop, options: {}, clear: noop, remove: noop };
  window.vatEnabled = false;
  window.subParams = [];
  window.lockedParams = [];
  window.clientPriceMode = clientPriceMode;
  window.clientMarkupPercent = clientMarkupPercent;
  window.clientDiscountPercent = clientDiscountPercent;
  window.portalUsageDiscountPercent = portalUsageDiscountPercent;
  window.eval(buildFormulaHandler());
  window.eval(buildBundle());
  window.params = [];
  window.formInputs = {};
  return window;
}

/**
 * Pozycja grupy 73 (kształt łańcucha z `param.txt`, kwoty z pozycji 7202 klienta
 * Lipki): cena zwykła 101.93 + dopłata 8.40, cena detaliczna 410 + 41 z rabatem
 * cennikowym 60% / 30%.
 */
function valuesFixture({ ilosc = 3, cena = 101.93, doplata = 8.4, rabat = 0 } = {}) {
  const cenaSuma = parseFloat((cena + doplata).toFixed(2));
  const cenaKoncowa = parseFloat(((cena + doplata) * (1 - rabat)).toFixed(2));
  return {
    ILOSC: ilosc,
    CENA: cena,
    DOPLATA: doplata,
    CENA_SUMA: cenaSuma,
    SUMA_BRUTTO: parseFloat((cenaSuma * ilosc).toFixed(2)),
    CENA_RABAT: rabat,
    DOPLATA_RABAT: 0,
    CENA_KONCOWA: cenaKoncowa,
    WARTOSC_KONCOWA: parseFloat((cenaKoncowa * ilosc).toFixed(2)),
    SUB___CENA: 410,
    SUB___DOPLATA: 41,
    SUB___CENA_SUMA: 451,
    SUB___SUMA_BRUTTO: 451 * ilosc,
    SUB___CENA_RABAT: 0.6,
    SUB___DOPLATA_RABAT: 0.3,
    SUB___CENA_KONCOWA: 192.7,
    SUB___WARTOSC_KONCOWA: parseFloat((192.7 * ilosc).toFixed(2))
  };
}

function row(option_value, extra = {}) {
  return { param_description: '', option_value: String(option_value), option_description: '', row: '2', ...extra };
}

function displayValuesFixture(window, v) {
  const dv = new window.Map();
  dv.set('ILOSC', row(v.ILOSC, { row: '1' }));
  dv.set('CENA', row(v.CENA, { param_description: 'CENA HKL [€] netto' }));
  dv.set('CENA_SUMA', row(v.CENA_SUMA));
  dv.set('SUMA_BRUTTO', row(v.SUMA_BRUTTO, { listsum: true }));
  dv.set('CENA_RABAT', row(`${Math.round(v.CENA_RABAT * 100)}%`, { locked: true }));
  dv.set('CENA_KONCOWA', row(v.CENA_KONCOWA, { locked: true }));
  dv.set('WARTOSC_KONCOWA', row(v.WARTOSC_KONCOWA, { locked: true, listsum: true }));
  dv.set('SUB___CENA', row(v.SUB___CENA, { sub: true, param_description: 'CENA DET. [€] netto' }));
  dv.set('SUB___DOPLATA', row(v.SUB___DOPLATA, { sub: true }));
  dv.set('SUB___CENA_SUMA', row(v.SUB___CENA_SUMA, { sub: true }));
  dv.set('SUB___SUMA_BRUTTO', row(v.SUB___SUMA_BRUTTO, { sub: true, listsum: true }));
  dv.set('SUB___CENA_RABAT', row('60%', { sub: true, locked: true }));
  dv.set('SUB___DOPLATA_RABAT', row('30%', { sub: true, locked: true }));
  dv.set('SUB___CENA_KONCOWA', row(v.SUB___CENA_KONCOWA, { sub: true, locked: true }));
  dv.set('SUB___WARTOSC_KONCOWA', row(v.SUB___WARTOSC_KONCOWA, { sub: true, locked: true, listsum: true }));
  return dv;
}

test('narzut 30%: łańcuch SUB___ = ceny zwykłe × 1.3, rabaty skopiowane, wartości = cena × ilość', () => {
  const window = makeWindow({ clientMarkupPercent: 30 });
  const values = valuesFixture({ ilosc: 3 });
  const dv = displayValuesFixture(window, values);

  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA, 132.51);          // 101.93 × 1.3
  assert.equal(values.SUB___DOPLATA, 10.92);        // 8.40 × 1.3
  assert.equal(values.SUB___CENA_SUMA, 143.43);     // 110.33 × 1.3
  assert.equal(values.SUB___CENA_KONCOWA, 143.43);  // rabat zwykły 0%
  // Wartości pozycji idą za ceną jednostkową (faktura mnoży ją przez ilość).
  assert.equal(values.SUB___SUMA_BRUTTO, 430.29);
  assert.equal(values.SUB___WARTOSC_KONCOWA, 430.29);
  // Rabaty cennikowe to procent — kopiowane z cen zwykłych, nie mnożone.
  assert.equal(values.SUB___CENA_RABAT, 0);
  assert.equal(values.SUB___DOPLATA_RABAT, 0);
  assert.equal(dv.get('SUB___CENA_RABAT').option_value, '0%');

  // Te same liczby w wierszach widoku — z nietkniętymi flagami.
  assert.equal(dv.get('SUB___CENA').option_value, '132.51');
  assert.equal(dv.get('SUB___WARTOSC_KONCOWA').option_value, '430.29');
  assert.equal(dv.get('SUB___WARTOSC_KONCOWA').listsum, true);
  assert.equal(dv.get('SUB___WARTOSC_KONCOWA').locked, true);
  assert.equal(dv.get('SUB___CENA').param_description, 'CENA DET. [€] netto');

  // Ceny zwykłe (cena zakupu grupy-matki) nietknięte.
  assert.equal(values.CENA, 101.93);
  assert.equal(values.WARTOSC_KONCOWA, 330.99);
  assert.equal(dv.get('CENA').option_value, '101.93');

  // Sumy do zapisu: katalogowa bez zmian, klienta = wartość po narzucie.
  const totals = window.__markupTest.getTotal(dv);
  assert.equal(totals.total, 330.99);
  assert.equal(totals.total_hidden, 330.99);
  assert.equal(totals.total_sub, 430.29);

  // Brak wiersza rabatu klienta — w trybie narzutu rabatu nie ma.
  assert.equal(dv.has('SUB___RABAT_KLIENTA'), false);
});

test('narzut przy rabacie cennikowym ceny zwykłej: łańcuch się zgadza (250 × 0.6 = 150)', () => {
  const window = makeWindow({ clientMarkupPercent: 25 });
  const values = valuesFixture({ ilosc: 1, cena: 200, doplata: 0, rabat: 0.4 });
  const dv = displayValuesFixture(window, values);

  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA, 250);
  assert.equal(values.SUB___CENA_RABAT, 0.4);
  assert.equal(dv.get('SUB___CENA_RABAT').option_value, '40%');
  assert.equal(values.SUB___CENA_KONCOWA, 150);
  assert.equal(values.SUB___WARTOSC_KONCOWA, 150);
  assert.equal(window.__markupTest.getTotal(dv).total_sub, 150);
});

test('narzut 0% = klient widzi dokładnie ceny zwykłe', () => {
  const window = makeWindow({ clientMarkupPercent: 0 });
  const values = valuesFixture({ ilosc: 2 });
  const dv = displayValuesFixture(window, values);

  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA, 101.93);
  assert.equal(values.SUB___CENA_SUMA, 110.33);
  assert.equal(values.SUB___WARTOSC_KONCOWA, 220.66);
  assert.equal(window.__markupTest.getTotal(dv).total_sub, 220.66);
});

test('idempotencja: trzy przeliczenia pod rząd dają tę samą cenę', () => {
  const window = makeWindow({ clientMarkupPercent: 30 });
  const values = valuesFixture({ ilosc: 3 });
  const dv = displayValuesFixture(window, values);

  for (let i = 0; i < 3; i++) window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 143.43);
  assert.equal(values.SUB___WARTOSC_KONCOWA, 430.29);
  assert.equal(window.__markupTest.getTotal(dv).total_sub, 430.29);
});

test('tryb rabatowy: narzut nic nie robi, nawet gdy wysokość narzutu przyszła', () => {
  const window = makeWindow({ clientPriceMode: 'discount', clientMarkupPercent: 30 });
  const values = valuesFixture({ ilosc: 3 });
  const dv = displayValuesFixture(window, values);

  assert.equal(window.__markupTest.applyClientMarkup(values, dv), false);
  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA, 410);
  assert.equal(values.SUB___CENA_KONCOWA, 192.7);
  assert.equal(dv.get('SUB___CENA').option_value, '410');
});

test('ekstra rabat (user.extra_rabat) w trybie narzutu schodzi z ceny PO narzucie', () => {
  // Serwer w trybie narzutu przysyła sam ekstra rabat (rabat klienta grupy = 0).
  const window = makeWindow({ clientMarkupPercent: 30, clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const values = valuesFixture({ ilosc: 3 });
  const dv = displayValuesFixture(window, values);

  window.__markupTest.applyClientDiscount(values, dv);

  // 143.43 × 0.99 = 141.9957 → 142.00; × 3 = 426.00
  assert.equal(values.SUB___CENA_KONCOWA, 142);
  assert.equal(values.SUB___WARTOSC_KONCOWA, 426);
  assert.equal(window.__markupTest.getTotal(dv).total_sub, 426);
  // Widoczne ceny przed rabatem — po narzucie, nie detaliczne.
  assert.equal(dv.get('SUB___CENA_SUMA').option_value, '143.43');
  assert.equal(dv.get('SUB___RABAT_KLIENTA').option_value, '1%');
});

test('po przełączeniu z rabatu na narzut: stary wiersz rabatu klienta znika z pozycji', () => {
  const window = makeWindow({ clientMarkupPercent: 30 });
  const values = valuesFixture({ ilosc: 1 });
  const dv = displayValuesFixture(window, values);
  dv.set('SUB___RABAT_KLIENTA', row('60%', { sub: true, locked: true }));

  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(dv.has('SUB___RABAT_KLIENTA'), false);
  assert.equal(values.SUB___CENA_KONCOWA, 143.43);
});

test('bliźniak wyłączony: wiersz ceny detalicznej nie zostaje w widoku klienta', () => {
  const window = makeWindow({ clientMarkupPercent: 30 });
  const values = valuesFixture({ ilosc: 1 });
  delete values.DOPLATA;
  const dv = displayValuesFixture(window, values);

  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(dv.has('SUB___DOPLATA'), false);
  assert.equal(values.SUB___CENA, 132.51);
});

test('specyfikacja ceny detalicznej (SUB___*_S) znika, specyfikacja ceny zwykłej zostaje', () => {
  const window = makeWindow({ clientMarkupPercent: 30 });
  const values = valuesFixture({ ilosc: 1 });
  const dv = displayValuesFixture(window, values);
  dv.set('CENA_S', row('127.41, (PG1)', { locked: true }));
  dv.set('SUB___CENA_S', row('409.5, (PG1)', { locked: true }));

  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(dv.has('SUB___CENA_S'), false);
  assert.equal(dv.get('CENA_S').option_value, '127.41, (PG1)');
});

test('pola formularza dostają ceny po narzucie (to, co widzi konfigurujący)', () => {
  const window = makeWindow({
    clientMarkupPercent: 30,
    body: '<input id="SUB___CENA_SUMA" value="451"><input id="SUB___CENA_RABAT" value="60%"><input id="CENA_RABAT" value="0%">'
  });
  const values = valuesFixture({ ilosc: 1 });
  const dv = displayValuesFixture(window, values);

  window.__markupTest.applyClientDiscount(values, dv);

  assert.equal(window.document.getElementById('SUB___CENA_SUMA').value, '143.43');
  assert.equal(window.document.getElementById('SUB___CENA_RABAT').value, '0%');
});
