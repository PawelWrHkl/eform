'use strict';

/**
 * Funkcje dodatkowe pól — kolumna `EXTRAFUNC` w `param.txt`
 * (docs/EXTRAFUNC.md).
 *
 * ⚠️ REALNY PRZYPADEK: grupa 43, wersja 0.3.762 (datatest), parametr
 * `DLSZNUR` „WYDŁUŻONE SZNURKI STERUJĄCE" — `EXTRAFUNC=popup-input`, słownik
 * `N`/NIE, `Y`/TAK. Po wyborze TAK klient wpisuje w okienku liczbę całkowitą.
 *
 * Pilnowane tutaj:
 *  - parser komórki EXTRAFUNC (opcje, przecinek w nawiasie, `<NULL>`),
 *  - liczba trafia do `values[DLSZNUR___EXTRA]` (→ JSON dla fabryki) ORAZ do
 *    `option_description` („TAK: 120 cm" → tabele, PDF, maile),
 *  - `clearDisabledValues` NIE kasuje liczby przy każdym przeliczeniu,
 *    a kasuje ją, gdy parametr zostaje wyłączony,
 *  - pole = przycisk; okno: NIE zamyka i ustawia NIE, TAK odsłania pole liczby,
 *    niepoprawna liczba nie zamyka okna, anulowanie niczego nie zmienia.
 *
 * Moduły przeglądarkowe zbundlowane esbuildem i odpalone w JSDOM, jak
 * `priceChainDisabledParam.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'public', 'scripts', 'formTools');

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  cachedBundle = esbuild.buildSync({
    stdin: {
      contents: `
        export * from ${JSON.stringify(path.join(TOOLS, 'extraFunctions', 'index.js'))};
        export { parseStrictInteger, integerError } from ${JSON.stringify(path.join(TOOLS, 'extraFunctions', 'popupInput', 'integerValue.js'))};
        export { describeWithNumber, popupInputConfig } from ${JSON.stringify(path.join(TOOLS, 'extraFunctions', 'popupInput', 'popupInput.js'))};
        export { clearDisabledValues } from ${JSON.stringify(path.join(TOOLS, 'validateUtils.js'))};
      `,
      resolveDir: ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: '__extraFunctionsTest',
    write: false,
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  }).outputFiles[0].text;
  return cachedBundle;
}

function boot() {
  // Węzły czytane przez `base.js` — wciąga go łańcuch toast.js → formTools.js.
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="dynamic-form"></div>'
    + '<div id="node-div"></div><span id="env-info"></span><div class="overlay"></div>'
    + '<img class="logo"><div id="hourglass"></div><div id="config-number-info"></div><div id="user-info"></div>'
    + '</body></html>', { runScripts: 'outside-only' });
  const { window } = dom;
  // Klucz + zmienne: test sprawdza, KTÓRY komunikat poszedł, nie jego brzmienie z arkusza.
  window.t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  window.console.log = () => {};
  window.console.warn = () => {};
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
  window.eval(buildBundle());
  window.skipCountParams = [];
  window.tempGroupNumber = '43';
  return { window, api: window.__extraFunctionsTest };
}

/** Wiersz `DLSZNUR` z `/<datatest>/43/data/versions/0.3.762/pl/param.txt`. */
const DLSZNUR = (extrafunc = 'popup-input') => ({
  NAME: 'DLSZNUR',
  DESCRIPTION: 'WYDŁUŻONE SZNURKI STERUJĄCE',
  TYPE: '<NULL>',
  ENABLE: '=WSROD(MODEL,"VS2,VS2_M")',
  SOURCE: '<NULL>',
  SCRIPTS: '<NULL>',
  FORMULA: '<NULL>',
  EXTRAFUNC: extrafunc,
});

/** Słownik `DLSZNUR_*` z paramdict.txt tej samej wersji. */
const OPTIONS = {
  DLSZNUR: [
    { ROW_NUM: '1', VALUE: 'N', DESCRIPTION: 'NIE', ENABLE: null, INFO: null },
    { ROW_NUM: '2', VALUE: 'Y', DESCRIPTION: 'TAK', ENABLE: null, INFO: null },
  ],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function buildSelect(window) {
  const area = window.document.createElement('div');
  area.className = 'DLSZNUR-select-area';
  window.document.getElementById('dynamic-form').appendChild(area);
  const select = window.document.createElement('select');
  select.name = select.id = 'DLSZNUR';
  for (const [value, text] of [['', 'Wybierz'], ['N', 'N NIE'], ['Y', 'Y TAK']]) {
    select.appendChild(new window.Option(text, value));
  }
  area.appendChild(select);
  return select;
}

/**
 * Pole `popup-input` zbudowane jak w `generateForm`: lista z `createForm.js`,
 * słuchacz `change` z form.js (wpisuje wartość, odpala przeliczenie), potem `mount`.
 */
function mountField(window, api, values, extrafunc = 'popup-input') {
  const select = buildSelect(window);
  select.value = values.DLSZNUR || ''; // jak `fillFields` przy edycji
  const updates = [];
  select.addEventListener('change', () => {
    values[select.name] = select.value;
    updates.push(select.value);
  });
  const displayValues = new window.Map([['DLSZNUR', { option_value: values.DLSZNUR || '', option_description: '' }]]);
  api.activateExtraFunctions([DLSZNUR(extrafunc)], { requestUpdate() {} })
    .mount({ inputs: { DLSZNUR: select }, values, displayValues, allOptionsByParameter: OPTIONS });
  const button = window.document.getElementById('DLSZNUR__popup');
  return { select, button, updates, displayValues };
}

function openPrompt(window, button) {
  button.click();
  const dialog = window.document.querySelector('dialog.xf-prompt');
  assert.ok(dialog, 'klik w pole powinien otworzyć okno');
  return {
    dialog,
    yes: dialog.querySelector('[data-choice="yes"]'),
    no: dialog.querySelector('[data-choice="no"]'),
    amount: dialog.querySelector('.xf-prompt__amount'),
    input: dialog.querySelector('.xf-prompt__input'),
    error: dialog.querySelector('.xf-prompt__error'),
    submit: () => dialog.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })),
    cancel: () => dialog.querySelector('.xf-prompt__btn--ghost').click(),
  };
}

test('parser EXTRAFUNC: pusta komórka, sama nazwa, opcje, kilka funkcji', () => {
  const { api } = boot();
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(api.parseExtraFuncCell('<NULL>')), []);
  assert.deepEqual(plain(api.parseExtraFuncCell(undefined)), []);
  assert.deepEqual(plain(api.parseExtraFuncCell('popup-input\r')), [{ name: 'popup-input', options: {} }]);
  assert.deepEqual(
    plain(api.parseExtraFuncCell('popup-input(unit=cm|min=10|max=500|info=Od dołu, z zapasem), Inna_Funkcja')),
    [
      { name: 'popup-input', options: { unit: 'cm', min: '10', max: '500', info: 'Od dołu, z zapasem' } },
      { name: 'inna_funkcja', options: {} },
    ]);
});

test('parsowanie liczby: tylko całkowite, zakres', () => {
  const { api } = boot();
  assert.equal(api.parseStrictInteger(' 120 '), 120);
  for (const bad of ['', '1.5', '1,5', '1e3', '12cm', '-5']) {
    assert.equal(api.parseStrictInteger(bad), null, bad);
  }
  assert.equal(api.parseStrictInteger('-5', { allowNegative: true }), -5);
  assert.equal(api.integerError('0', { min: 1 }), 'form.popup_input.err_min {"min":1}');
  assert.equal(api.integerError('501', { min: 1, max: 500 }), 'form.popup_input.err_max {"max":500}');
  assert.equal(api.integerError('1,5', { min: 1 }), 'form.popup_input.err_int');
  assert.equal(api.integerError('250', { min: 1, max: 500 }), null);
});

test('nieznana funkcja w EXTRAFUNC nie wywraca formularza', () => {
  const { api } = boot();
  const controller = api.activateExtraFunctions([DLSZNUR('jeszcze-nie-ma')], { requestUpdate() {} });
  assert.equal(controller.size, 0);
});

test('sync bez DOM (formEngine): liczba w opisie, idempotentnie; NIE kasuje liczby', () => {
  const { window, api } = boot();
  api.activateExtraFunctions([DLSZNUR('popup-input(unit=cm)')], { requestUpdate() {} });
  const values = { DLSZNUR: 'Y', DLSZNUR___EXTRA: 120 };
  const displayValues = new window.Map([['DLSZNUR', { param_description: 'WYDŁUŻONE SZNURKI STERUJĄCE', option_value: 'Y', option_description: 'TAK' }]]);

  api.syncExtraFunctions({ values, displayValues, allOptionsByParameter: OPTIONS });
  api.syncExtraFunctions({ values, displayValues, allOptionsByParameter: OPTIONS });
  assert.equal(displayValues.get('DLSZNUR').option_description, 'TAK: 120 cm');
  assert.equal(values.DLSZNUR___EXTRA, 120);

  values.DLSZNUR = 'N';
  api.syncExtraFunctions({ values, displayValues, allOptionsByParameter: OPTIONS });
  assert.equal('DLSZNUR___EXTRA' in values, false, 'NIE = brak liczby w JSON-ie dla fabryki');
});

test('liczba zapisana jako tekst (localStorage/import) jest przyjmowana', () => {
  const { window, api } = boot();
  api.activateExtraFunctions([DLSZNUR()], { requestUpdate() {} });
  const values = { DLSZNUR: 'Y', DLSZNUR___EXTRA: '75' };
  const displayValues = new window.Map([['DLSZNUR', { option_value: 'Y', option_description: 'TAK' }]]);
  api.syncExtraFunctions({ values, displayValues, allOptionsByParameter: OPTIONS });
  assert.equal(displayValues.get('DLSZNUR').option_description, 'TAK: 75');
  assert.deepEqual(JSON.parse(JSON.stringify(api.validateExtraFunctions({ values }))), []);
});

test('walidacja zapisu: TAK bez liczby blokuje, NIE i TAK z liczbą przechodzą', () => {
  const { api } = boot();
  api.activateExtraFunctions([DLSZNUR()], { requestUpdate() {} });
  const issues = api.validateExtraFunctions({ values: { DLSZNUR: 'Y' } });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].param, 'DLSZNUR');
  assert.equal(api.validateExtraFunctions({ values: { DLSZNUR: 'N' } }).length, 0);
  assert.equal(api.validateExtraFunctions({ values: { DLSZNUR: 'Y', DLSZNUR___EXTRA: 3 } }).length, 0);
});

test('clearDisabledValues: liczba żyje z włączonym parametrem i znika z wyłączonym', () => {
  const { window, api } = boot();
  const displayValues = new window.Map([['DLSZNUR', { option_value: 'Y', option_description: 'TAK: 120' }]]);

  window.enabledParams = { DLSZNUR: true };
  const kept = { DLSZNUR: 'Y', DLSZNUR___DESCRIPTION: 'TAK', DLSZNUR___EXTRA: 120 };
  api.clearDisabledValues(kept, displayValues);
  assert.equal(kept.DLSZNUR___EXTRA, 120, 'przeliczenie formularza nie może kasować liczby');
  assert.equal('DLSZNUR___EXTRA___VISIBLE' in kept, false, 'bez śmieciowych kluczy w JSON-ie');

  window.enabledParams = {};
  const cleared = { DLSZNUR: 'Y', DLSZNUR___DESCRIPTION: 'TAK', DLSZNUR___EXTRA: 120 };
  api.clearDisabledValues(cleared, displayValues);
  assert.equal(cleared.DLSZNUR, '');
  assert.equal(cleared.DLSZNUR___EXTRA, '');
});

test('UI: pole jest przyciskiem, lista z wartością zostaje ukryta', () => {
  const { window, api } = boot();
  const { select, button } = mountField(window, api, { DLSZNUR: '' });
  assert.ok(select.classList.contains('xf-native-hidden'));
  assert.equal(button.textContent, 'form.check_word');
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
});

test('UI: NIE w oknie zamyka okno i ustawia NIE bez liczby', async () => {
  const { window, api } = boot();
  const values = { DLSZNUR: 'Y', DLSZNUR___EXTRA: 120 };
  const { select, button, updates } = mountField(window, api, values);
  const prompt = openPrompt(window, button);
  assert.equal(prompt.amount.hidden, false, 'przy zapisanym TAK pole liczby jest od razu odsłonięte');

  prompt.no.click();
  await flush();
  assert.equal(prompt.dialog.isConnected, false);
  assert.equal(select.value, 'N');
  assert.equal(values.DLSZNUR, 'N');
  assert.equal('DLSZNUR___EXTRA' in values, false);
  assert.deepEqual(updates, ['N'], 'wybór idzie przez zwykły `change` listy');
  assert.equal(button.textContent, 'NIE');
});

test('UI: TAK odsłania pole; zła liczba zostaje w oknie, poprawna trafia do values', async () => {
  const { window, api } = boot();
  const values = { DLSZNUR: '' };
  const { select, button, updates, displayValues } = mountField(window, api, values, 'popup-input(unit=cm|min=10|max=500)');
  const prompt = openPrompt(window, button);
  assert.equal(prompt.amount.hidden, true, 'pole liczby dopiero po TAK');

  prompt.yes.click();
  assert.equal(prompt.amount.hidden, false);
  assert.equal(prompt.yes.getAttribute('aria-checked'), 'true');

  prompt.input.value = '5';
  prompt.submit();
  await flush();
  assert.equal(prompt.error.textContent, 'form.popup_input.err_min {"min":10}');
  assert.ok(prompt.dialog.isConnected, 'niepoprawna liczba nie zamyka okna');

  prompt.input.value = '120';
  prompt.submit();
  await flush();
  assert.equal(prompt.dialog.isConnected, false);
  assert.equal(select.value, 'Y');
  assert.equal(values.DLSZNUR, 'Y');
  assert.equal(values.DLSZNUR___EXTRA, 120);
  assert.deepEqual(updates, ['Y']);

  // Przeliczenie po `change` kończy się na sync — buildValuesToDisplay dał „TAK".
  displayValues.set('DLSZNUR', { option_value: 'Y', option_description: 'TAK' });
  api.syncExtraFunctions({ values, displayValues, allOptionsByParameter: OPTIONS });
  assert.equal(displayValues.get('DLSZNUR').option_description, 'TAK: 120 cm');
  assert.equal(button.textContent, 'TAK: 120 cm');
});

test('UI: anulowanie okna niczego nie zmienia', async () => {
  const { window, api } = boot();
  const values = { DLSZNUR: 'N' };
  const { select, button, updates } = mountField(window, api, values);
  const prompt = openPrompt(window, button);
  prompt.yes.click();
  prompt.cancel();
  await flush();
  assert.equal(select.value, 'N');
  assert.equal(values.DLSZNUR, 'N');
  assert.deepEqual(updates, []);
  assert.equal(window.document.querySelector('dialog.xf-prompt'), null);
});

test('UI: błąd walidacji z ukrytej listy widać na przycisku', async () => {
  const { window, api } = boot();
  const { select, button } = mountField(window, api, { DLSZNUR: '' });
  select.classList.add('invalid-input');
  await flush();
  assert.ok(button.classList.contains('invalid-input'));
  select.classList.remove('invalid-input');
  await flush();
  assert.equal(button.classList.contains('invalid-input'), false);
});
