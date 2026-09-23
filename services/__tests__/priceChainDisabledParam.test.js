'use strict';

/**
 * Łańcuch cenowy, gdy jeden z parametrów cenowych jest WYŁĄCZONY przez `ENABLE`.
 *
 * ⚠️ REALNY PRZYPADEK: grupa 14 (VERTIKAL). `param.txt` ma DWIE ceny HKL pod tą
 * samą etykietą i wyklucza je nawzajem:
 *
 *   CENAPASEK  ENABLE `=WSROD(KONFIGURACJA,"L")`        (konfiguracja „PASKI")
 *   CENA       ENABLE `=NOT(WSROD(KONFIGURACJA,"L"))`   (wszystkie pozostałe)
 *   CENA_SUMA  FORMULA `=IF(WSROD(KONFIGURACJA,"L"),CENAPASEK+…,CENA+…)`
 *
 * Przy `KONFIGURACJA="L"` cena liczyła się poprawnie tylko w `CENAPASEK`, a
 * `CENA_SUMA`, `SUMA_BRUTTO`, `CENA_KONCOWA` i `WARTOSC_KONCOWA` (oraz ich
 * bliźniaki `SUB___*`) pokazywały „Według cennika". Dwie niezależne przyczyny,
 * obie pilnowane tutaj:
 *
 *  1. `clearDisabledValues` czyścił wyłączoną `CENA` do `''`, a
 *     `hot-formula-parser` liczy OBIE gałęzie `IF` — pusty operand w gałęzi
 *     NIEUŻYWANEJ wywraca całą formułę na `#VALUE!`, `evaluateFormula` zwraca
 *     `false`, `calculateFromFormula` wpisuje 0.
 *  2. `checkIfPriceIsCorrect` widział `CENA == 0` i podmieniał cały blok cenowy
 *     na `t('form.pricelist_info')`, mimo policzonego `CENAPASEK`.
 *
 * Test uruchamia PRAWDZIWE moduły przeglądarkowe (`formTools/validateUtils.js`,
 * `formTools/pricesCalculator.js`, `formula.js`) — zbundlowane esbuildem i
 * odpalone w JSDOM, tak samo jak `clientDiscountInFinalValue.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VALIDATE = path.join(ROOT, 'public', 'scripts', 'formTools', 'validateUtils.js');
const PRICES = path.join(ROOT, 'public', 'scripts', 'formTools', 'pricesCalculator.js');

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  cachedBundle = esbuild.buildSync({
    stdin: {
      contents: `
        export { clearDisabledValues } from ${JSON.stringify(VALIDATE)};
        export { checkIfPriceIsCorrect, calculateFromFormula } from ${JSON.stringify(PRICES)};
      `,
      resolveDir: ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: '__priceChainTest',
    write: false,
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  }).outputFiles[0].text;
  return cachedBundle;
}

let cachedFormula = null;
/** `formula.js` + jego parser — ta sama para i kolejność co w `services/formEngine/jsdomEnv.js`. */
function buildFormulaHandler() {
  if (cachedFormula === null) {
    const parser = fs.readFileSync(
      path.join(ROOT, 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'), 'utf8');
    cachedFormula = parser + '\n;' + fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'formula.js'), 'utf8');
  }
  return cachedFormula;
}

/** Wiersze cenowe `param.txt` grupy 14 — przepisane 1:1 z `/<dataDir>/14/data/pl/param.txt`. */
const P = (NAME, extra) => Object.assign(
  { NAME, SCRIPTS: '<NULL>', FORMULA: '<NULL>', SOURCE: '<NULL>', ENABLE: '<NULL>' }, extra);

const PARAMS_GRUPY_14 = [
  P('KONFIGURACJA'), P('ILOSC'), P('RODZAJ'),
  P('CENAPASEK', { SCRIPTS: 'true', SOURCE: '/14/param-CENAPASEK-C.js', ENABLE: '=WSROD(KONFIGURACJA,"L")' }),
  P('CENA', { SCRIPTS: 'true', SOURCE: '/14/param-CENA-C.js', ENABLE: '=NOT(WSROD(KONFIGURACJA,"L"))' }),
  P('DOPLATA', { SCRIPTS: 'true', SOURCE: '/14/param-DOPLATA-C.js' }),
  P('DOPLATA_EL', { SCRIPTS: 'true', SOURCE: '/14/param-DOPLATA_EL-C.js', ENABLE: '=WSROD(RODZAJ,"EL")' }),
  P('CENA_RABAT', { SCRIPTS: 'true', SOURCE: '/14/param-CENA_RABAT-0.js', ENABLE: '=HASLO()' }),
  P('DOPLATA_EL_RABAT', { SCRIPTS: 'true', SOURCE: '/14/param-DOPLATA_EL_RABAT-0.js', ENABLE: '=AND(WSROD(RODZAJ,"EL"),HASLO())' }),
  // `SCRIPTS='true'`, ale trzyma TEKST (etykieta wyceny ze skryptu) — `FORMROW='0'`.
  P('OPIS_CENY', { SCRIPTS: 'true', SOURCE: '/14/param-CENA-C.js' }),
  P('CENA_SUMA', { FORMULA: '=IF(WSROD(KONFIGURACJA,"L"),CENAPASEK+DOPLATA+DOPLATA_EL,CENA+DOPLATA+DOPLATA_EL)' }),
  P('SUMA_BRUTTO', { FORMULA: '=CENA_SUMA*ILOSC' }),
  P('CENA_KONCOWA', {
    FORMULA: '=IF(WSROD(KONFIGURACJA,"L"),(CENAPASEK+DOPLATA)*(1-CENA_RABAT)+DOPLATA_EL*(1-DOPLATA_EL_RABAT),'
      + '(CENA+DOPLATA)*(1-CENA_RABAT)+DOPLATA_EL*(1-DOPLATA_EL_RABAT))'
  }),
  P('WARTOSC_KONCOWA', { FORMULA: '=CENA_KONCOWA*ILOSC' })
];

const WIERSZE_CENOWE = ['CENA_SUMA', 'SUMA_BRUTTO', 'CENA_KONCOWA', 'WARTOSC_KONCOWA'];

/**
 * Minimalna przeglądarka. `enabled`/`skipped` odwzorowują to, co zostawia
 * `applyParamVisibilityFromFormulas` po ewaluacji `ENABLE` — parametr ze
 * skryptem cenowym, którego `ENABLE` jest fałszywe, ląduje w `skipCountParams`.
 */
function makeWindow({ enabled, skipped }) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<div id="node-div"></div><span id="env-info"></span><div class="overlay"></div>'
    + '<img class="logo"><div id="hourglass"></div><div id="config-number-info"></div><div id="user-info"></div>'
    + '</body></html>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.t = (key) => (key === 'form.pricelist_info' ? 'Według cennika' : key);
  window.console.log = () => {};
  window.console.error = () => {};
  const noop = () => {};
  window.toastr = { success: noop, error: noop, warning: noop, info: noop, options: {}, clear: noop, remove: noop };
  window.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, body: { version: 'Testowa' } }),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new window.Blob([]))
  });
  window.eval(buildFormulaHandler());
  window.eval(buildBundle());
  window.subParams = [];
  window.lockedParams = [];
  window.manualParams = new Set();
  window.calculatedParams = new Set();
  window.vatEnabled = false;
  window.params = PARAMS_GRUPY_14;
  window.skipCountParams = [...skipped];
  window.enabledParams = {};
  for (const name of enabled) window.enabledParams[name] = true;
  return window;
}

function mkInput(window, id, value, visible) {
  const div = window.document.createElement('div');
  if (!visible) div.style.display = 'none';
  const el = window.document.createElement('input');
  el.id = id;
  el.value = String(value);
  div.appendChild(el);
  window.document.body.appendChild(div);
  return el;
}

/**
 * Jeden przebieg `updateFieldStates` w kolejności z `updateFieldsAndValues.js`:
 * `clearDisabledValues` → formuły → `checkIfPriceIsCorrect`.
 */
async function przelicz(window, values, widoczne) {
  const inputs = {};
  for (const name of ['CENAPASEK', 'CENA', 'DOPLATA', ...WIERSZE_CENOWE]) {
    inputs[name] = mkInput(window, name, values[name] ?? 0, widoczne.includes(name));
  }
  const displayValues = new window.Map();

  window.__priceChainTest.clearDisabledValues(values, displayValues);
  for (const name of WIERSZE_CENOWE) {
    const param = PARAMS_GRUPY_14.find(p => p.NAME === name);
    window.__priceChainTest.calculateFromFormula(param, values, inputs, displayValues, '14', {}, name, name);
  }
  window.__priceChainTest.checkIfPriceIsCorrect(values, inputs, displayValues);
  // `checkIfPriceIsCorrect` podmienia pola w `setTimeout(…, 150)`.
  await new Promise(resolve => setTimeout(resolve, 300));

  return inputs;
}

test('grupa 14, KONFIGURACJA="L": wyłączona CENA nie zeruje reszty bloku cenowego', async () => {
  const window = makeWindow({
    enabled: ['KONFIGURACJA', 'ILOSC', 'RODZAJ', 'CENAPASEK', 'DOPLATA', ...WIERSZE_CENOWE],
    // CENA (inna konfiguracja) i oba rabaty (HASLO) — wyłączone.
    skipped: ['CENA', 'CENA_RABAT', 'DOPLATA_EL_RABAT']
  });
  const values = {
    KONFIGURACJA: 'L', ILOSC: 1, RODZAJ: 'MAN',
    CENAPASEK: 55.5, CENA: 0, DOPLATA: 0, DOPLATA_EL: 0,
    CENA_RABAT: 0, DOPLATA_EL_RABAT: 0,
    CENA_SUMA: 0, SUMA_BRUTTO: 0, CENA_KONCOWA: 0, WARTOSC_KONCOWA: 0
  };

  const inputs = await przelicz(window, values, ['CENAPASEK', 'DOPLATA', ...WIERSZE_CENOWE]);

  assert.equal(values.CENA, 0, 'parametr liczony wraca na 0, nie na "" — inaczej psuje formuły');
  assert.equal(values.CENA_SUMA, 55.5, 'CENA_SUMA bierze CENAPASEK z pierwszej gałęzi IF');
  assert.equal(values.SUMA_BRUTTO, 55.5);
  assert.equal(values.CENA_KONCOWA, 55.5);
  assert.equal(values.WARTOSC_KONCOWA, 55.5);
  for (const name of WIERSZE_CENOWE) {
    assert.notEqual(inputs[name].value, 'Według cennika', `${name} nie może iść na "Według cennika"`);
  }
});

test('cena, która naprawdę wyszła zero, nadal idzie na „Według cennika"', async () => {
  // Konfiguracja inna niż „L" — liczy CENA, a skrypt zwrócił 0 (brak pozycji w cenniku).
  const window = makeWindow({
    enabled: ['KONFIGURACJA', 'ILOSC', 'RODZAJ', 'CENA', 'DOPLATA', ...WIERSZE_CENOWE],
    skipped: ['CENAPASEK', 'CENA_RABAT', 'DOPLATA_EL_RABAT']
  });
  const values = {
    KONFIGURACJA: 'F', ILOSC: 1, RODZAJ: 'MAN',
    CENAPASEK: 0, CENA: 0, DOPLATA: 0, DOPLATA_EL: 0,
    CENA_RABAT: 0, DOPLATA_EL_RABAT: 0,
    CENA_SUMA: 0, SUMA_BRUTTO: 0, CENA_KONCOWA: 0, WARTOSC_KONCOWA: 0
  };

  const inputs = await przelicz(window, values, ['CENA', 'DOPLATA', ...WIERSZE_CENOWE]);

  assert.equal(inputs.CENA.value, 'Według cennika', 'sygnał braku ceny musi zostać');
  assert.equal(inputs.CENA_SUMA.value, 'Według cennika');
});

test('parametr liczony trzymający TEKST (OPIS_CENY) nie dostaje zera', async () => {
  const window = makeWindow({
    enabled: ['KONFIGURACJA', 'ILOSC', 'RODZAJ', 'CENAPASEK', 'DOPLATA', ...WIERSZE_CENOWE],
    skipped: ['CENA', 'CENA_RABAT', 'DOPLATA_EL_RABAT', 'OPIS_CENY']
  });
  const values = {
    KONFIGURACJA: 'L', ILOSC: 1, RODZAJ: 'MAN',
    CENAPASEK: 55.5, CENA: 0, DOPLATA: 0, DOPLATA_EL: 0,
    CENA_RABAT: 0, DOPLATA_EL_RABAT: 0,
    OPIS_CENY: '(304(TCNDPG2))*1.045',
    CENA_SUMA: 0, SUMA_BRUTTO: 0, CENA_KONCOWA: 0, WARTOSC_KONCOWA: 0
  };

  await przelicz(window, values, ['CENAPASEK', 'DOPLATA', ...WIERSZE_CENOWE]);

  assert.equal(values.OPIS_CENY, '', 'opis wraca na puste, nie na 0');
  assert.equal(values.CENA, 0, 'a cena — na 0');
});
