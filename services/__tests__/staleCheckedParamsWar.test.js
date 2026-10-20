'use strict';

/**
 * Okno slope nie przełączało typu po zmianie strony w edycji (zgłoszenie
 * 2026-10-19, grupa 39): SLOPE25, SLOPE_TYPE S1L_25 (`USTAW("WYMIAROWANIE_SLOPOW.TYP",
 * "WAR","TYP1")`) → duplikat → edycja → S1R_25 (`…"TYP19"`). Zaraz po zmianie
 * okno miało TYP19, ale po wyborze STRSTERSLOP (reset zależności każe go
 * wybrać od nowa) wracało do TYP1.
 *
 * Przyczyna: pętla `window.checkedParams` w `getProcedures` (validateUtils.js)
 * liczyła procedury z listy zbudowanej na końcu POPRZEDNIEGO przeliczenia, czyli
 * także starej opcji S1L_25. Jej `WAR` nadpisywał `window.constValues`, a
 * najbliższy `setWar` wpisywał TYP1 do okna. Od 2026-10-16 edycja startuje z
 * pełnym `checkedParams` (zakresy MIN/MAX po wczytaniu), więc w edycji trafiało
 * to zawsze przy pierwszej zmianie.
 *
 * Do tego zmiana typu ma czyścić wymiary w oknie (`SourceWindow.setTyp`) —
 * B/H1/H2 lewego slopa nie mogą przejść do prawego.
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
        export { getProcedures } from ${JSON.stringify(path.join(SCRIPTS, 'validateUtils.js'))};
        export { findParamFromValues } from ${JSON.stringify(path.join(SCRIPTS, 'formTools.js'))};
        export { SourceWindow } from ${JSON.stringify(path.join(SCRIPTS, 'slope.js'))};
      `,
      resolveDir: ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: '__staleCheckedTest',
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

const opt = (VALUE, PROC = '<NULL>') => ({ VALUE, DESCRIPTION: VALUE, ENABLE: '<NULL>', PROC });

// Wycinek grupy 39 (paramdict.txt) — procedury skrócone do WAR i zakresów.
const OPTIONS = {
  MODEL: [opt('SLOPE25', '=AND(USTAW("WYMIAROWANIE_SLOPOW.TYP","WAR","<NONE>"),USTAW("SZEROKOSC","MIN",300))')],
  SLOPE_TYPE: [
    opt('S1L_25', '=AND(USTAW("WYMIAROWANIE_SLOPOW.TYP","WAR","TYP1"),USTAW("SZEROKOSC","MAX",3000))'),
    opt('S1R_25', '=AND(USTAW("WYMIAROWANIE_SLOPOW.TYP","WAR","TYP19"),USTAW("SZEROKOSC","MAX",3000))')
  ],
  STRSTERSLOP: [opt('S1L_L'), opt('S1R_R')]
};

function setup() {
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

  // Okno slope — z `SourceWindow` liczy się tu tylko `setTyp`.
  const modal = { TYP: 'TYP1', setTyp(typ) { this.TYP = typ; } };
  const params = [
    P('MODEL'),
    P('SLOPE_TYPE', { DEPENDENCES: 'STRSTERSLOP,SZEROKOSC,WYMIAROWANIE_SLOPOW' }),
    P('STRSTERSLOP'),
    P('SZEROKOSC', { TYPE: 'numeric' }),
    Object.assign(P('WYMIAROWANIE_SLOPOW', { SOURCE: 'WYMIAROWANIE_SLOPOW' }), { modal })
  ];
  window.params = params;
  window.inputsValidators = {};
  window.inputsDefaults = {};
  window.constValues = {};
  window.checkedParams = {};

  const values = { MODEL: 'SLOPE25', SLOPE_TYPE: 'S1L_25', STRSTERSLOP: 'S1L_L', SZEROKOSC: 800, WYMIAROWANIE_SLOPOW: { TYP: 'TYP1' } };
  const { getProcedures, findParamFromValues } = window.__staleCheckedTest;
  const run = (name, value, tagName) =>
    getProcedures({}, OPTIONS, values, {}, name, value, tagName, new window.Map(), params);

  return { window, modal, values, run, findParamFromValues };
}

/** Jak koniec `generateForm(editFlag=true)` w form.js. */
function openEdit(ctx) {
  ctx.window.checkedParams = ctx.findParamFromValues(ctx.values, OPTIONS);
  ctx.run('', '', 'INPUT');
}

/** Jak `dialog-confirm` → `updateProcedure` z `resetDeps` (form.js). */
function chooseButton(ctx, name, value) {
  ctx.values[name] = value;
  ctx.run(name, value, 'BUTTON');
  ctx.window.checkedParams = ctx.findParamFromValues(ctx.values, OPTIONS);
}

test('edycja: zmiana S1L_25 → S1R_25 przestawia okno slope na TYP19 i kolejny wybór go nie cofa', () => {
  const ctx = setup();
  openEdit(ctx);

  chooseButton(ctx, 'SLOPE_TYPE', 'S1R_25');
  assert.equal(ctx.modal.TYP, 'TYP19');
  assert.notEqual(ctx.window.constValues['WYMIAROWANIE_SLOPOW.TYP'], 'TYP1',
    'procedura starej opcji S1L_25 nie może zostawić swojego WAR');

  // resetDependences → resetSelectValues: STRSTERSLOP do wybrania od nowa.
  ctx.values.STRSTERSLOP = '';
  ctx.window.checkedParams = {};
  chooseButton(ctx, 'STRSTERSLOP', 'S1R_R');
  assert.equal(ctx.modal.TYP, 'TYP19');
  assert.equal(ctx.values.WYMIAROWANIE_SLOPOW.TYP, 'TYP19');
});

test('edycja: zakresy z procedur zapisanych opcji nadal są odtwarzane po otwarciu', () => {
  const ctx = setup();
  openEdit(ctx);

  assert.equal(ctx.window.inputsValidators.MODEL?.SLOPE25?.SZEROKOSC?.MIN, 300);
  assert.equal(ctx.window.inputsValidators.SLOPE_TYPE?.S1L_25?.SZEROKOSC?.MAX, 3000);
});

function slopeWindow(ctx) {
  const win = new ctx.window.__staleCheckedTest.SourceWindow(1, () => {});
  win.data = { params: [
    { NAME: 'TYP', DESCRIPTION: 'TYP', ENABLE: '<NULL>' },
    { NAME: 'WYM_B', DESCRIPTION: 'B [mm]', ENABLE: '<NULL>' },
    { NAME: 'WYM_H1', DESCRIPTION: 'H1 [mm]', ENABLE: '<NULL>' }
  ] };
  win.createObject();
  return win;
}

test('okno slope: zapisana pozycja przy wczytaniu edycji zachowuje wymiary (ten sam typ)', () => {
  const win = slopeWindow(setup());
  // form.js buildHtml: Object.assign zapisanych wartości, potem setTyp tym samym typem.
  Object.assign(win.sourceValues, { TYP: 'TYP1', WYM_B: 800, WYM_H1: 1400 });
  win.setTyp('TYP1');
  assert.equal(win.sourceValues.WYM_B, 800);
  assert.equal(win.sourceValues.WYM_H1, 1400);
});

test('okno slope: zmiana typu czyści wymiary, ponowne ustawienie tego samego typu już nie', () => {
  const win = slopeWindow(setup());
  Object.assign(win.sourceValues, { TYP: 'TYP1', WYM_B: 800, WYM_H1: 1400 });
  win.sourceDisplayValues['B [mm]'] = '800';

  win.setTyp('TYP19');
  assert.equal(win.TYP, 'TYP19');
  assert.equal(win.sourceValues.TYP, 'TYP19');
  assert.equal(win.sourceValues.WYM_B, '');
  assert.equal(win.sourceValues.WYM_H1, '');
  assert.equal(win.sourceDisplayValues['B [mm]'], undefined);

  // Nowe wymiary, potem `setWar` przy kolejnym wyborze przycisku — ten sam typ.
  win.sourceValues.WYM_B = 900;
  win.setTyp('TYP19');
  assert.equal(win.sourceValues.WYM_B, 900);
});

test('wartość zapisana liczbą zamiast tekstem nie jest brana za nieaktualną', () => {
  const ctx = setup();
  OPTIONS.MONTAZ = [opt('2', '=USTAW("SZEROKOSC","MAX",2500)')];
  try {
    ctx.values.MONTAZ = '2';
    ctx.window.checkedParams = ctx.findParamFromValues(ctx.values, OPTIONS);
    ctx.values.MONTAZ = 2;
    ctx.run('', '', 'INPUT');
    assert.equal(ctx.window.inputsValidators.MONTAZ?.['2']?.SZEROKOSC?.MAX, 2500);
  } finally {
    delete OPTIONS.MONTAZ;
  }
});
