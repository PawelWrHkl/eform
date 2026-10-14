'use strict';

/**
 * „Kopiowanie linii gubi parametry" — Ryver 2026-10-12 (oferta 351, verticale;
 * wcześniej rzymskie). Klient kopiuje pozycję przyciskiem „wczytaj ostatnią
 * konfigurację" na stronie nowej pozycji (main.js), a nie „duplikuj".
 *
 *  1. form.js `generateForm` wołał `applySubPriceFieldVisibility` na
 *     `window.formValues`/`formInputs` POPRZEDNIEGO formularza strony (dział z
 *     jedną grupą zawsze najpierw buduje pusty) — `clearDisabledValues` kasował
 *     `option_value` w opisach nowej pozycji (tabela/PDF: „-"). Tę część
 *     odtwarza symulacja w przeglądarce; tu pilnujemy skutków ubocznych:
 *  2. `fillFields` — opis bez `option_value` (już zapisane pozycje,
 *     `localStorage` klientów): select dostawał `parseFloat("B2")` = NaN.
 *  3. `validateAllFieldsOnSubmit` — przycisk z atrapą `'ffff'`/`"undefined"`
 *     w DOM przechodził walidację mimo pustej wartości w `values`.
 *  4. `resetDependences` — zakres liczbowy z `findAllValidatorsForInput(...)[0]`
 *     (często zestaw innego pola) kasował poprawną szerokość przy zmianie MODEL,
 *     a późny reset zjadał cyfry wpisywane w międzyczasie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'public', 'scripts', 'formTools');

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  cachedBundle = esbuild.buildSync({
    stdin: {
      contents: `
        export { validateAllFieldsOnSubmit } from ${JSON.stringify(path.join(SCRIPTS, 'validateUtils.js'))};
        export { resetDependences, snapshotDependences } from ${JSON.stringify(path.join(SCRIPTS, 'updateFieldsAndValues.js'))};
        export { fillFields } from ${JSON.stringify(path.join(SCRIPTS, 'createForm.js'))};
      `,
      resolveDir: ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: '__copiedPositionTest',
    write: false,
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  }).outputFiles[0].text;
  return cachedBundle;
}

let cachedFormula = null;
function buildFormulaHandler() {
  if (cachedFormula === null) {
    const parser = fs.readFileSync(
      path.join(ROOT, 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'), 'utf8');
    cachedFormula = parser + '\n;' + fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'formula.js'), 'utf8');
  }
  return cachedFormula;
}

const P = (NAME, extra) => Object.assign(
  { NAME, DESCRIPTION: NAME, SCRIPTS: '<NULL>', FORMULA: '<NULL>', SOURCE: '<NULL>', ENABLE: '<NULL>', LISTROW: '1' }, extra);

// Wycinek grupy 14 (VERTIKAL) i 59 (H50) — tyle, ile potrzeba do scenariuszy.
const PARAMS = [
  P('KONFIGURACJA'),
  P('MODEL', { DEPENDENCES: 'SZEROKOSC,WYSOKOSC,PROTEKCJA' }),
  P('PASEK', { ENABLE: '=WSROD(KONFIGURACJA,"S,Sslope")' }),
  P('SZEROKOSC', { TYPE: 'numeric' }),
  P('WYSOKOSC', { TYPE: 'numeric' }),
  P('PROTEKCJA'),
  P('DLUGOSC_STER', { TYPE: 'numeric' }),
  P('BLENDA'),
  P('KOLOR'),
  P('WYMIAROWANIE_SLOPOW', { SOURCE: 'WYMIAROWANIE_SLOPOW' }),
  P('POW', { FORMULA: '=SZEROKOSC*WYSOKOSC/1000000' })
];

const OPTIONS = {
  KONFIGURACJA: [{ VALUE: 'S', DESCRIPTION: 'RAIL', ENABLE: '<NULL>', ROW_NUM: 1 }],
  MODEL: [{ VALUE: '1R', DESCRIPTION: 'Controle en slatpakket rechts', ENABLE: '<NULL>', ROW_NUM: 1 }],
  PASEK: [
    { VALUE: 'B1', DESCRIPTION: '50MM', ENABLE: '<NULL>', ROW_NUM: 1 },
    { VALUE: 'B2', DESCRIPTION: '89MM', ENABLE: '<NULL>', ROW_NUM: 2 }
  ],
  PROTEKCJA: [{ VALUE: 'NO_PROT', DESCRIPTION: 'ZONDER LAMELOVERSTEK', ENABLE: '<NULL>', ROW_NUM: 1 }],
  BLENDA: [{ VALUE: '<NONE>', DESCRIPTION: 'OHNE', ENABLE: '<NULL>', ROW_NUM: 1 }, { VALUE: 'IDD', DESCRIPTION: 'IDD', ENABLE: '<NULL>', ROW_NUM: 2 }]
};

function makeWindow() {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<div id="node-div"></div><span id="env-info"></span><div class="overlay"></div>'
    + '<img class="logo"><div id="hourglass"></div><div id="config-number-info"></div><div id="user-info"></div>'
    + '</body></html>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.t = (key) => key;
  window.console.log = () => {};
  window.console.warn = () => {};
  window.console.error = () => {};
  const noop = () => {};
  window.toastr = { success: noop, error: noop, warning: noop, info: noop, options: {}, clear: noop, remove: noop };
  window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.eval(buildFormulaHandler());
  window.eval(buildBundle());
  window.params = PARAMS;
  window.subParams = [];
  window.lockedParams = [];
  window.manualParams = new Set();
  window.calculatedParams = new Set();
  window.enabledParams = {};
  window.inputFlags = {};
  window.inputsValidators = {};
  window.afterSend = false;
  window.checkedParams = {};
  return window;
}

function inField(window, el) {
  const div = window.document.createElement('div');
  div.appendChild(el);
  window.document.body.appendChild(div);
  return el;
}

function mkButton(window, name, domValue, text = 'form.check_word') {
  const btn = window.document.createElement('button');
  btn.type = 'button';
  btn.id = name;
  btn.name = name;
  btn.textContent = text;
  if (domValue !== null) btn.value = domValue;
  return inField(window, btn);
}

function mkSelect(window, name, chosen) {
  const select = window.document.createElement('select');
  select.id = name;
  select.name = name;
  select.appendChild(new window.Option('form.check_option', ''));
  for (const opt of OPTIONS[name] || []) {
    const o = new window.Option(`${opt.VALUE} ${opt.DESCRIPTION}`, opt.VALUE);
    o.id = `${opt.ROW_NUM}-${name}`;
    select.appendChild(o);
  }
  select.value = chosen;
  return inField(window, select);
}

function mkInput(window, name, value) {
  const input = window.document.createElement('input');
  input.type = 'number';
  input.id = name;
  input.name = name;
  input.value = String(value);
  return inField(window, input);
}

// ── walidacja przy zapisie ────────────────────────────────────────────────

test('walidacja: przycisk z atrapą "ffff" i pustą wartością nie przechodzi', () => {
  const window = makeWindow();
  window.enabledParams = { BLENDA: true };
  const inputs = { BLENDA: mkButton(window, 'BLENDA', 'ffff') };

  window.__copiedPositionTest.validateAllFieldsOnSubmit(inputs, { BLENDA: '' });

  assert.equal(window.inputFlags.BLENDA, false, 'pusty KOOF musi zablokować zapis (Ryver, zlecenie 266)');
});

test('walidacja: parametr brakujący w zapisanej pozycji ("undefined" w DOM) nie przechodzi', () => {
  const window = makeWindow();
  window.enabledParams = { PROTEKCJA: true };
  const inputs = { PROTEKCJA: mkButton(window, 'PROTEKCJA', 'undefined') };

  window.__copiedPositionTest.validateAllFieldsOnSubmit(inputs, {});

  assert.equal(window.inputFlags.PROTEKCJA, false);
});

test('walidacja: wybrany przycisk, "<NONE>" i podformularz przechodzą', () => {
  const window = makeWindow();
  window.enabledParams = { BLENDA: true, PROTEKCJA: true, WYMIAROWANIE_SLOPOW: true };
  const inputs = {
    BLENDA: mkButton(window, 'BLENDA', 'IDD'),
    PROTEKCJA: mkButton(window, 'PROTEKCJA', '<NONE>'),
    WYMIAROWANIE_SLOPOW: mkButton(window, 'WYMIAROWANIE_SLOPOW', '[object Object]')
  };

  window.__copiedPositionTest.validateAllFieldsOnSubmit(inputs, {
    BLENDA: 'IDD', PROTEKCJA: '<NONE>', WYMIAROWANIE_SLOPOW: { TYP: 'TYP1' }
  });

  assert.equal(window.inputFlags.BLENDA, true);
  assert.equal(window.inputFlags.PROTEKCJA, true);
  assert.equal(window.inputFlags.WYMIAROWANIE_SLOPOW, true);
});

test('walidacja: select pokazuje opcję, ale wartość do zapisu jest pusta — blokada', () => {
  const window = makeWindow();
  window.enabledParams = { PASEK: true };
  const inputs = { PASEK: mkSelect(window, 'PASEK', 'B2') };

  window.__copiedPositionTest.validateAllFieldsOnSubmit(inputs, { PASEK: '' });

  assert.equal(window.inputFlags.PASEK, false);
});

// ── reset zależności po wyborze w dialogu ─────────────────────────────────

function modelChangeState(window, szerokosc) {
  // Pierwszy pasujący zestaw walidatorów należy do INNEGO pola — dokładnie
  // tak, jak bywało w przeglądarce (kolejność zależy od tego, która procedura
  // odpaliła pierwsza).
  window.inputsValidators = {
    KONFIGURACJA: { S: { DLUGOSC_STER: { MIN: 100, MAX: 6000 } } },
    MODEL: { '1R': { SZEROKOSC: { MIN: 500, MAX: 6900 }, WYSOKOSC: { MIN: 300, MAX: 5000 } } }
  };
  const values = { KONFIGURACJA: 'S', MODEL: '1R', SZEROKOSC: szerokosc, WYSOKOSC: '', PROTEKCJA: 'NO_PROT' };
  const inputs = {
    SZEROKOSC: mkInput(window, 'SZEROKOSC', szerokosc),
    WYSOKOSC: mkInput(window, 'WYSOKOSC', ''),
    PROTEKCJA: mkButton(window, 'PROTEKCJA', 'NO_PROT', 'NO_PROT - ZONDER LAMELOVERSTEK')
  };
  const display = new window.Map([['SZEROKOSC', { param_description: 'BREEDTE', option_value: String(szerokosc) }]]);
  return { values, inputs, display };
}

test('reset po zmianie MODEL: szerokość w zakresie zostaje, choć pierwszy walidator jest innego pola', () => {
  const window = makeWindow();
  const { values, inputs, display } = modelChangeState(window, 1780);

  window.__copiedPositionTest.resetDependences([PARAMS, display], 'MODEL', inputs, values, OPTIONS);

  assert.equal(values.SZEROKOSC, 1780);
  assert.equal(inputs.SZEROKOSC.value, '1780');
  assert.equal(values.PROTEKCJA, 'NO_PROT', 'opcja słownikowa wciąż dozwolona — zostaje');
});

test('reset po zmianie MODEL: szerokość spoza nowego zakresu nadal jest kasowana', () => {
  const window = makeWindow();
  const { values, inputs, display } = modelChangeState(window, 300);

  window.__copiedPositionTest.resetDependences([PARAMS, display], 'MODEL', inputs, values, OPTIONS);

  assert.equal(values.SZEROKOSC, '');
});

test('reset: liczba zapisana tekstem przez USTAW(…,"DOM",…) też jest liczbą', () => {
  const window = makeWindow();
  const { values, inputs, display } = modelChangeState(window, '1780');

  window.__copiedPositionTest.resetDependences([PARAMS, display], 'MODEL', inputs, values, OPTIONS);

  assert.equal(values.SZEROKOSC, '1780');
});

test('reset: nie kasuje cyfr wpisywanych po wyborze, zanim skończyło się liczenie', () => {
  const window = makeWindow();
  const { values, inputs, display } = modelChangeState(window, 1780);
  const atSelection = window.__copiedPositionTest.snapshotDependences(PARAMS, 'MODEL', values);
  // Użytkownik zaczął wpisywać 910: Backspace, „9"…
  values.SZEROKOSC = 9;
  inputs.SZEROKOSC.value = '9';

  window.__copiedPositionTest.resetDependences([PARAMS, display], 'MODEL', inputs, values, OPTIONS, atSelection);

  assert.equal(values.SZEROKOSC, 9, 'wpisywana wartość należy do użytkownika');
  assert.equal(inputs.SZEROKOSC.value, '9');
});

// ── otwarcie kopii z uszkodzonym opisem ───────────────────────────────────

test('fillFields: select z opisem bez option_value pokazuje zapisaną opcję i naprawia opis', () => {
  const window = makeWindow();
  window.enabledParams = { PASEK: true };
  const inputs = { PASEK: mkSelect(window, 'PASEK', 'B2') };
  const display = new window.Map([['PASEK', { param_description: 'STOFBREEDTE', locked: false, sub: false, row: '1' }]]);

  window.__copiedPositionTest.fillFields(display, inputs, { PASEK: 'B2', PASEK___DESCRIPTION: '89MM' });

  assert.equal(inputs.PASEK.value, 'B2', 'zamiast NaN i pustego selecta');
  assert.equal(display.get('PASEK').option_value, 'B2', 'tabela zlecenia i PDF pokażą B2, nie „-"');
  assert.equal(display.get('PASEK').option_description, '89MM');
});

test('fillFields: przycisk z opisem bez option_value pokazuje wartość (z aliasem klienta)', () => {
  const window = makeWindow();
  window.enabledParams = { BLENDA: true, KOLOR: true };
  const inputs = { BLENDA: mkButton(window, 'BLENDA', 'IDD'), KOLOR: mkButton(window, 'KOLOR', '4202-127') };
  const display = new window.Map([
    ['BLENDA', { param_description: 'KOOF', row: '1' }],
    ['KOLOR', { param_description: 'STOFF', row: '1' }]
  ]);

  window.__copiedPositionTest.fillFields(display, inputs, {
    BLENDA: 'IDD', BLENDA___DESCRIPTION: 'IDD',
    KOLOR: '4202-127', KOLOR_ALIAS: '1535-127', KOLOR_ALIAS___DESCRIPTION: 'PG #1'
  });

  assert.equal(inputs.BLENDA.textContent, 'IDD - IDD');
  assert.equal(display.get('KOLOR').option_value, '1535-127', 'jak buildValuesToDisplay: alias klienta');
  assert.equal(display.get('KOLOR').option_description, 'PG #1');
});

test('fillFields: "<NONE>" dostaje pusty option_value i opis z values', () => {
  const window = makeWindow();
  window.enabledParams = { BLENDA: true };
  const inputs = { BLENDA: mkButton(window, 'BLENDA', '<NONE>') };
  const display = new window.Map([['BLENDA', { param_description: 'KOOF', row: '1' }]]);

  window.__copiedPositionTest.fillFields(display, inputs, { BLENDA: '<NONE>', BLENDA___DESCRIPTION: 'OHNE' });

  assert.equal(display.get('BLENDA').option_value, '');
  assert.equal(display.get('BLENDA').option_description, 'OHNE');
});

test('fillFields: nie dorabia opisu polom ukrytym ani liczonym', () => {
  const window = makeWindow();
  window.enabledParams = { POW: true };
  const inputs = { PASEK: mkSelect(window, 'PASEK', ''), POW: mkSelect(window, 'POW', '') };
  const display = new window.Map([
    ['PASEK', { param_description: 'STOFBREEDTE', row: '1' }],
    ['POW', { param_description: 'POW', row: '1' }]
  ]);

  window.__copiedPositionTest.fillFields(display, inputs, { PASEK: 'B2', POW: 1.2 });

  assert.equal('option_value' in display.get('PASEK'), false, 'PASEK nie jest włączony');
  assert.equal('option_value' in display.get('POW'), false, 'POW jest liczony formułą');
});
