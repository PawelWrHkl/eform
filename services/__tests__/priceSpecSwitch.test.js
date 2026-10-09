'use strict';

/**
 * Specyfikacja ceny `_S` sterowana z `.env` — `PRICE_SPEC_ENABLED`
 * (config.js `features.priceSpec` → `window.priceSpecEnabled` z base.njk
 * i jsdomEnv.js → `pricesCalculator.js calculateFromScript`).
 *
 * Do 2026-10-08 warunkiem była wersja z `/env` („≠ Produkcyjna"), przez co
 * `-spec` był widoczny na każdym środowisku testowym. Teraz brak zmiennej =
 * wyłączone, a wyłączona flaga chowa też wiersze `-spec` pozycji zapisanych
 * wcześniej (`services/orderService.js dropPriceSpecRows`).
 *
 * Część przeglądarkowa uruchamia PRAWDZIWY `calculateFromScript` + `loadScript`
 * (zbundlowane esbuildem, w JSDOM) z podstawionym skryptem cennika.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const PRICES = path.join(ROOT, 'public', 'scripts', 'formTools', 'pricesCalculator.js');

// ── config.js ─────────────────────────────────────────────────────────────
function readFlag(vars) {
  const env = { ...process.env };
  delete env.PRICE_SPEC_ENABLED;
  delete env.NODE_ENV;
  Object.assign(env, vars);
  const r = spawnSync(process.execPath,
    ['-e', "process.stdout.write(JSON.stringify(require('./config').features.priceSpec))"],
    { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('PRICE_SPEC_ENABLED true/on/1/tak włącza, niezależnie od NODE_ENV', () => {
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: 'true', NODE_ENV: 'prod' }), true);
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: ' ON ', NODE_ENV: 'prod' }), true);
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: '1' }), true);
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: 'tak', NODE_ENV: 'test' }), true);
});

test('PRICE_SPEC_ENABLED false/off/0, puste albo brak = wyłączone — także na NODE_ENV=test/dev', () => {
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: 'false', NODE_ENV: 'test' }), false);
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: 'off', NODE_ENV: 'dev' }), false);
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: '0', NODE_ENV: 'archive' }), false);
  assert.equal(readFlag({ PRICE_SPEC_ENABLED: '', NODE_ENV: 'test' }), false);
  for (const nodeEnv of ['dev', 'test', 'archive', 'prod']) assert.equal(readFlag({ NODE_ENV: nodeEnv }), false, nodeEnv);
  assert.equal(readFlag({}), false);
});

// ── pricesCalculator.js ───────────────────────────────────────────────────
const SCRIPT_URL = '/scripts/test/CENA-spec.js';
const SPEC_RAW = '(416(PG3))*1.1';

class PriceScriptLoader extends ResourceLoader {
  fetch(url, options) {
    if (url.endsWith(SCRIPT_URL)) {
      return Promise.resolve(Buffer.from(
        `function f(input) { return { CENA: 416, CENA_S: ${JSON.stringify(SPEC_RAW)} }; }`));
    }
    return super.fetch(url, options);
  }
}

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  const result = esbuild.buildSync({
    stdin: {
      contents: `export { calculateFromScript } from ${JSON.stringify(PRICES)};`,
      resolveDir: ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: '__specTest',
    write: false,
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  });
  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

/**
 * Jedno przeliczenie `CENA` skryptem cennika, który zwraca też `CENA_S`.
 * `savedRows` — wiersze `displayValues` przyniesione z zapisanej pozycji (edycja).
 */
function calculateCena(priceSpecEnabled, savedRows = []) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div><input id="CENA" name="CENA"></div></body></html>',
    { url: 'http://eform.local/', runScripts: 'dangerously', resources: new PriceScriptLoader() });
  const { window } = dom;
  window.t = (key) => key;
  window.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, body: {} }),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new window.Blob([]))
  });
  window.console.log = () => {};
  window.console.error = () => {};
  const noop = () => {};
  window.toastr = { success: noop, error: noop, warning: noop, info: noop, options: {}, clear: noop, remove: noop };
  if (priceSpecEnabled !== undefined) window.priceSpecEnabled = priceSpecEnabled;
  window.params = [{ NAME: 'CENA', LISTROW: '2', DESCRIPTION: 'Cena' }];
  window.skipCountParams = [];
  window.lockedParams = [];
  window.subParams = [];
  window.eval(buildBundle());

  const inputs = { CENA: window.document.getElementById('CENA') };
  const values = {};
  const displayValues = new Map(savedRows);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('skrypt cennika nie zakończył liczenia')), 5000);
    window.__specTest.calculateFromScript(
      { NAME: 'CENA', SOURCE: SCRIPT_URL, FORMAT: '' },
      values, inputs, displayValues, '71', {}, 'CENA', 'CENA',
      () => {
        clearTimeout(timer);
        resolve({ window, inputs, values, displayValues });
      });
  }).finally(() => setImmediate(() => window.close()));
}

test('priceSpecEnabled = true: powstaje ukryte pole CENA_S i zablokowany wiersz „Cena-spec"', async () => {
  const { window, inputs, values, displayValues } = await calculateCena(true);

  assert.equal(values.CENA, 416);
  assert.equal(values.CENA_S, SPEC_RAW);
  assert.ok(inputs.CENA_S, 'pole CENA_S');
  assert.equal(inputs.CENA_S.style.display, 'none');
  assert.equal(inputs.CENA_S.value, SPEC_RAW);

  const row = displayValues.get('CENA_S');
  assert.ok(row, 'wiersz CENA_S w displayValues');
  assert.equal(row.param_description, 'Cena-spec');
  assert.equal(row.option_value, '457.6, (PG3)');
  assert.equal(row.locked, true);
  assert.equal(row.row, '2');
  assert.ok(window.lockedParams.includes('CENA_S'));
});

test('priceSpecEnabled = false: wartość _S zostaje tylko w values — bez pola i bez wiersza', async () => {
  const { window, inputs, values, displayValues } = await calculateCena(false);

  assert.equal(values.CENA, 416);
  assert.equal(values.CENA_S, SPEC_RAW);
  assert.ok(displayValues.get('CENA'), 'sama cena liczy się dalej');
  assert.equal(inputs.CENA_S, undefined);
  assert.equal(window.document.getElementById('CENA_S'), null);
  assert.equal(displayValues.has('CENA_S'), false);
  assert.ok(!window.lockedParams.includes('CENA_S'));
});

test('brak window.priceSpecEnabled (strona bez base.njk) = wyłączone', async () => {
  const { inputs, displayValues } = await calculateCena(undefined);
  assert.equal(inputs.CENA_S, undefined);
  assert.equal(displayValues.has('CENA_S'), false);
});

test('priceSpecEnabled = false: wiersz „-spec" zapisanej pozycji znika przy przeliczeniu', async () => {
  const saved = [['CENA_S', { param_description: 'Cena-spec', option_value: '457.6, (PG3)', locked: true, row: '2' }]];
  const { displayValues } = await calculateCena(false, saved);
  assert.equal(displayValues.has('CENA_S'), false);
});

// ── services/orderService.js — pozycje już zapisane ──────────────────────
const SAVED_ROWS = [
  ['ILOSC', { param_description: 'ILOŚĆ', option_value: '1', option_description: '', locked: false, row: '1' }],
  ['CENA', { param_description: 'CENA', option_value: '416', option_description: '', locked: false, row: '2' }],
  ['CENA_S', { param_description: 'CENA-spec', option_value: '457.6, (PG3)', option_description: '', locked: true, row: '2' }],
  ['SUB___CENA', { param_description: 'CENA', option_value: '500', option_description: '', locked: false, sub: true, row: '2' }],
  ['SUB___CENA_S', { param_description: 'CENA-spec', option_value: '550, (PG3)', option_description: '', locked: true, sub: false, row: '2' }],
  // Parametr z końcówką `_S` bez ceny-rodzica w pozycji to nie specyfikacja.
  ['KOLOR_S', { param_description: 'KOLOR S', option_value: 'biały', option_description: '', locked: false, row: '1' }]
];

test('dropPriceSpecRows: usuwa <PARAM>_S stojące obok swojej ceny, nic poza tym', () => {
  const { dropPriceSpecRows } = require('../orderService');
  const rows = dropPriceSpecRows(new Map(SAVED_ROWS));
  assert.deepEqual([...rows.keys()], ['ILOSC', 'CENA', 'SUB___CENA', 'KOLOR_S']);
});

function renderSaved(flag) {
  const env = { ...process.env };
  delete env.PRICE_SPEC_ENABLED;
  if (flag !== undefined) env.PRICE_SPEC_ENABLED = flag;
  // Surowe `item.json_parameters_desc` jedzie z pozycją, ale szablony go nie
  // renderują (czytają je tylko formularze edycji — tam czyści przeliczenie),
  // więc sprawdzamy wyłącznie to, z czego budowany jest widok.
  const script = `
    require('./services/orderService').jsonTextBackToMap([{ id: 1, json_parameters_desc: ${JSON.stringify(JSON.stringify(SAVED_ROWS))} }])
      .then((r) => {
        for (const table of r.cleanOrderItems) for (const row of table.rows) delete row.item.json_parameters_desc;
        process.stdout.write(JSON.stringify(r.cleanOrderItems));
      });`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('jsonTextBackToMap: przy wyłączonej fladze wierszy „-spec" nie ma w podglądzie, PDF ani mailu', () => {
  for (const flag of [undefined, 'false']) {
    const out = renderSaved(flag);
    assert.ok(!out.includes('-spec'), `PRICE_SPEC_ENABLED=${flag}`);
    assert.ok(out.includes('457.6') === false && out.includes('550, (PG3)') === false);
    assert.ok(out.includes('biały'), 'zwykły parametr _S zostaje');
  }
});

test('jsonTextBackToMap: przy włączonej fladze wiersze „-spec" zostają', () => {
  const out = renderSaved('true');
  assert.ok(out.includes('CENA-spec'));
  assert.ok(out.includes('550, (PG3)'));
});
