'use strict';

/**
 * Maska cen na czas liczenia (createForm.js `maskPriceValuesDuringCalc` /
 * `revealPriceValuesWhenSettled` / `unmaskPriceValues`).
 *
 * Zgłoszenie 2026-10-09: przy liczeniu cen w formularzu na ułamek sekundy
 * widać inne (pośrednie) ceny, zanim pokażą się właściwe. Maska schodziła
 * w chwili opróżnienia kolejki, choć jedna zmiana pola odpala kilka przeliczeń
 * pod rząd. Teraz ceny odsłaniają się dopiero, gdy liczenie się skończyło
 * i od sekundy żadna wartość się nie zmieniła.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const CREATE_FORM = path.join(ROOT, 'public', 'scripts', 'formTools', 'createForm.js');

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  cachedBundle = esbuild.buildSync({
    stdin: {
      contents: `export { maskPriceValuesDuringCalc, revealPriceValuesWhenSettled, unmaskPriceValues } from ${JSON.stringify(CREATE_FORM)};`,
      resolveDir: ROOT, loader: 'js'
    },
    bundle: true, format: 'iife', globalName: '__maskTest', write: false,
    platform: 'browser', target: 'es2020', logLevel: 'silent'
  }).outputFiles[0].text;
  return cachedBundle;
}

function makeForm() {
  const dom = new JSDOM(
    // #env-info/#node-div: getEnv.js (wciągany przez bundle) dotyka ich przy ładowaniu.
    '<!doctype html><html><body><div id="node-div"><span id="env-info"></span></div>'
      + '<input id="CENA"><input id="SZEROKOSC"><input id="WARTOSC_BRUTTO"></body></html>',
    { runScripts: 'outside-only' });
  const { window } = dom;
  const noop = () => {};
  window.t = (key) => key;
  // Maska nie używa sieci; moduły z bundla (base.js, getEnv.js) przy starcie
  // pobierają dane nagłówka i wpisują je w elementy, których tu nie ma —
  // fetch, który nigdy się nie kończy, zatrzymuje te efekty uboczne.
  window.fetch = () => new Promise(() => {});
  window.console.log = noop;
  window.console.error = noop;
  window.toastr = { success: noop, error: noop, warning: noop, info: noop, options: {}, clear: noop, remove: noop };
  window.lockedParams = [];
  window.subParams = [];
  window.eval(buildBundle());
  const doc = window.document;
  const params = [{ NAME: 'CENA', LISTROW: '2' }, { NAME: 'SZEROKOSC', LISTROW: '1' }];
  const inputs = { CENA: doc.getElementById('CENA'), SZEROKOSC: doc.getElementById('SZEROKOSC') };
  const masked = (id) => doc.getElementById(id).classList.contains('price-value-masked');
  return { window, api: window.__maskTest, params, inputs, masked };
}

const wait = (window, ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
// Okno zamykamy po chwili — moduły z bundla kończą jeszcze swoje fetch-e.
const close = (window) => setTimeout(() => window.close(), 50);

test('maska obejmuje pola cenowe i pola VAT/rabatu z form.js, nie rusza zwykłych parametrów', () => {
  const { api, params, inputs, masked, window } = makeForm();
  api.maskPriceValuesDuringCalc(params, inputs);
  assert.equal(masked('CENA'), true);
  assert.equal(masked('WARTOSC_BRUTTO'), true, 'pole spoza params (form.js buildVatFields)');
  assert.equal(masked('SZEROKOSC'), false);
  api.unmaskPriceValues(params, inputs);
  assert.equal(masked('CENA'), false);
  assert.equal(masked('WARTOSC_BRUTTO'), false);
  close(window);
});

test('odsłonięcie dopiero, gdy od sekundy żadna cena się nie zmieniła', async () => {
  const { api, params, inputs, masked, window } = makeForm();
  api.maskPriceValuesDuringCalc(params, inputs);
  api.revealPriceValuesWhenSettled(params, inputs);
  await wait(window, 600);
  assert.equal(masked('CENA'), true, '0.6 s po liczeniu cena dalej zakryta');
  await wait(window, 600);
  assert.equal(masked('CENA'), false, 'po ~1.2 s bez zmian — odsłonięta');
  close(window);
});

test('zmiana wartości w trakcie czekania zeruje odliczanie sekundy', async () => {
  const { api, params, inputs, masked, window } = makeForm();
  api.maskPriceValuesDuringCalc(params, inputs);
  api.revealPriceValuesWhenSettled(params, inputs);
  await wait(window, 700);
  inputs.CENA.value = '300.70';                         // spóźniony wpis skryptu / „Według cennika"
  await wait(window, 700);
  assert.equal(masked('CENA'), true, '0.7 s po ostatniej zmianie — dalej zakryta');
  await wait(window, 500);
  assert.equal(masked('CENA'), false, '~1.2 s po ostatniej zmianie — odsłonięta');
  close(window);
});

test('kolejne liczenie cofa sygnał końca — bez mignięcia liczb pośrednich', async () => {
  const { api, params, inputs, masked, window } = makeForm();
  api.maskPriceValuesDuringCalc(params, inputs);
  api.revealPriceValuesWhenSettled(params, inputs);     // koniec 1. liczenia
  await wait(window, 300);
  api.maskPriceValuesDuringCalc(params, inputs);        // 2. liczenie z tej samej zmiany pola
  window.isCalculating = true;
  await wait(window, 1300);
  assert.equal(masked('CENA'), true, 'w trakcie 2. liczenia ceny zakryte mimo ciszy');
  window.isCalculating = false;
  api.revealPriceValuesWhenSettled(params, inputs);
  await wait(window, 1200);
  assert.equal(masked('CENA'), false);
  close(window);
});

test('pole, w które użytkownik właśnie wpisuje, nie jest zakrywane', () => {
  const { api, params, inputs, masked, window } = makeForm();
  inputs.CENA.focus();
  api.maskPriceValuesDuringCalc(params, inputs);
  assert.equal(masked('CENA'), false);
  assert.equal(masked('WARTOSC_BRUTTO'), true);
  api.unmaskPriceValues(params, inputs);
  close(window);
});
