'use strict';

/**
 * Lustro ceny zwykłej do `SUB___` w `pricesCalculator.js calculateFromScript`
 * (CENA → SUB___CENA).
 *
 * Zgłoszenie 2026-10-09 (Luxan GmbH): w podglądzie zlecenia cena detaliczna
 * „LISTENPREIS" pokazywała 72.18 — cenę zakupu HKL — przy sumie 300.70
 * policzonej z prawdziwej ceny detalicznej 285. Skrypt `CENA` kopiował swój
 * wynik do `SUB___CENA`, mimo że ta ma WŁASNY skrypt cennika. Kopia ma działać
 * tylko dla grup, w których `SUB___` własnego skryptu nie ma.
 *
 * Test uruchamia PRAWDZIWY `calculateFromScript` + `loadScript` (esbuild, JSDOM)
 * z podstawionym skryptem cennika — tak jak priceSpecSwitch.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const PRICES = path.join(ROOT, 'public', 'scripts', 'formTools', 'pricesCalculator.js');
const CENA_URL = '/scripts/test/CENA.js';

class PriceScriptLoader extends ResourceLoader {
  fetch(url, options) {
    if (url.endsWith(CENA_URL)) {
      return Promise.resolve(Buffer.from('function f(input) { return { CENA: 72.18 }; }'));
    }
    return super.fetch(url, options);
  }
}

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  cachedBundle = esbuild.buildSync({
    stdin: { contents: `export { calculateFromScript } from ${JSON.stringify(PRICES)};`, resolveDir: ROOT, loader: 'js' },
    bundle: true, format: 'iife', globalName: '__mirrorTest', write: false,
    platform: 'browser', target: 'es2020', logLevel: 'silent'
  }).outputFiles[0].text;
  return cachedBundle;
}

/** Przeliczenie skryptu `CENA` przy `SUB___CENA` = 285 policzonym wcześniej. */
function calculateCena({ subHasScript }) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div><input id="CENA"><input id="SUB___CENA" value="285"></div></body></html>',
    { url: 'http://eform.local/', runScripts: 'dangerously', resources: new PriceScriptLoader() });
  const { window } = dom;
  const noop = () => {};
  window.t = (key) => key;
  window.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ success: true, body: {} }),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new window.Blob([]))
  });
  window.console.log = noop;
  window.console.error = noop;
  window.toastr = { success: noop, error: noop, warning: noop, info: noop, options: {}, clear: noop, remove: noop };
  window.params = [
    { NAME: 'CENA', LISTROW: '2', DESCRIPTION: 'HKL PREIS', SCRIPTS: 'true', SOURCE: CENA_URL },
    subHasScript
      ? { NAME: 'SUB___CENA', LISTROW: '2', DESCRIPTION: 'LISTENPREIS', SCRIPTS: 'true', SOURCE: '/scripts/test/SUB___CENA.js' }
      : { NAME: 'SUB___CENA', LISTROW: '2', DESCRIPTION: 'LISTENPREIS', SCRIPTS: '<NULL>' }
  ];
  window.skipCountParams = [];
  window.lockedParams = [];
  window.subParams = ['SUB___CENA'];
  window.eval(buildBundle());

  const doc = window.document;
  const inputs = { CENA: doc.getElementById('CENA'), SUB___CENA: doc.getElementById('SUB___CENA') };
  const values = { SUB___CENA: 285 };
  const displayValues = new Map([
    ['SUB___CENA', { param_description: 'LISTENPREIS', option_value: '285', locked: false, sub: true, row: '2' }]
  ]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('skrypt cennika nie zakończył liczenia')), 5000);
    window.__mirrorTest.calculateFromScript(
      window.params[0], values, inputs, displayValues, '71', {}, 'CENA', 'CENA',
      () => { clearTimeout(timer); resolve({ inputs, values, displayValues }); });
  }).finally(() => setImmediate(() => window.close()));
}

test('SUB___CENA z własnym skryptem: wynik skryptu CENA NIE nadpisuje ceny detalicznej', async () => {
  const { inputs, values, displayValues } = await calculateCena({ subHasScript: true });
  assert.equal(values.CENA, 72.18);
  assert.equal(values.SUB___CENA, 285);
  assert.equal(inputs.SUB___CENA.value, '285');
  assert.equal(displayValues.get('SUB___CENA').option_value, '285');
});

test('SUB___CENA bez własnego skryptu: dalej lustro ceny zwykłej (jak dotąd)', async () => {
  const { inputs, values, displayValues } = await calculateCena({ subHasScript: false });
  assert.equal(values.SUB___CENA, 72.18);
  assert.equal(inputs.SUB___CENA.value, '72.18');
  assert.equal(displayValues.get('SUB___CENA').option_value, '72.18');
});
