'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enableFormulaRefs,
  parseParamDefinitions,
  readFormParamDefs,
  isVisibilityTrustworthy,
  isHiddenParam,
  isPriceLikeName,
  clearHiddenParams
} = require('../paramVisibility');

// Real group 71 row (trimmed): DLUGOSC_STER is disabled for a list of models.
const PARAM_TXT = [
  'NAME\tDESCRIPTION\tTYPE\tPROC\tENABLE\tSOURCE\tFORMROW\tLISTROW',
  'MODEL\tMODEL\tdict\t<NULL>\t<NULL>\t<NULL>\t1\t1',
  'DLUGOSC_STER\tDŁUGOŚĆ STEROWANIA [MM]\tnumeric\t<NULL>\t=NOT(WSROD(MODEL,"AE10,BB24,DB30"))\t<NULL>\t1\t1',
  'SZEROKOSC\tSZEROKOŚĆ [MM]\tnumeric\t<NULL>\t=NOT(WSROD(SLOPE_TYPE,"T1,T2"))\t<NULL>\t1\t1',
  // Real group 71 row: no ENABLE formula, but FORMROW=0 — the form reports it as
  // ___VISIBLE:false while it carries the customer's own position note.
  'OPIS_POZYCJI\tOPIS_POZYCJI\t<NULL>\t<NULL>\t<NULL>\t<NULL>\t0\t0'
].join('\n');

test('enableFormulaRefs ignores functions and quoted option lists', () => {
  const refs = enableFormulaRefs('=NOT(WSROD(MODEL,"AE10,BB24,DB30"))');
  assert.deepEqual([...refs], ['MODEL']);
});

test('enableFormulaRefs returns nothing for an absent formula', () => {
  assert.equal(enableFormulaRefs('<NULL>').size, 0);
  assert.equal(enableFormulaRefs('').size, 0);
  assert.equal(enableFormulaRefs(undefined).size, 0);
});

test('parseParamDefinitions maps NAME to ENABLE and normalizes <NULL>', () => {
  const defs = parseParamDefinitions(PARAM_TXT);
  assert.equal(defs.size, 4);
  assert.equal(defs.get('MODEL').ENABLE, null);
  assert.equal(defs.get('OPIS_POZYCJI').FORMROW, '0');
  assert.match(defs.get('DLUGOSC_STER').ENABLE, /WSROD\(MODEL/);
  assert.equal(defs.get('DLUGOSC_STER').LISTROW, '1');
  assert.equal(parseParamDefinitions(null), null);
  assert.equal(parseParamDefinitions('NAME\tENABLE'), null);
});

test('readFormParamDefs falls back to pl when the order language has no param.txt', async () => {
  const reads = [];
  const fileScanner = {
    async readDataFile(group, lang, file) {
      reads.push(`${group}/${lang}/${file}`);
      return lang === 'pl' ? PARAM_TXT : null;
    }
  };
  const defs = await readFormParamDefs('71', 'nl', { fileScanner });
  assert.deepEqual(reads, ['71/nl/param.txt', '71/pl/param.txt']);
  assert.ok(defs.has('DLUGOSC_STER'));
});

test('a visibility verdict is trusted only when the ENABLE formula was computable', () => {
  const defs = parseParamDefinitions(PARAM_TXT);

  // MODEL was supplied → NOT(WSROD(MODEL,…)) really evaluated to false.
  assert.equal(isVisibilityTrustworthy('DLUGOSC_STER', defs, { MODEL: 'BB24' }), true);
  // MODEL missing/empty → the parser returned #NAME? and "disabled" is an artifact.
  assert.equal(isVisibilityTrustworthy('DLUGOSC_STER', defs, { MODEL: '' }), false);
  assert.equal(isVisibilityTrustworthy('DLUGOSC_STER', defs, {}), false);
  // SLOPE_TYPE is not part of the payload — exactly the JSDOM blind spot.
  assert.equal(isVisibilityTrustworthy('SZEROKOSC', defs, { MODEL: 'BB24' }), false);
  // No ENABLE formula at all / unknown param / no param.txt.
  assert.equal(isVisibilityTrustworthy('MODEL', defs, { MODEL: 'BB24' }), false);
  assert.equal(isVisibilityTrustworthy('DLUGSTER', defs, { MODEL: 'BB24' }), false);
  assert.equal(isVisibilityTrustworthy('DLUGOSC_STER', null, { MODEL: 'BB24' }), false);
});

test('clearHiddenParams blanks a disabled param with its description and alias', () => {
  const defs = parseParamDefinitions(PARAM_TXT);
  const values = {
    MODEL: 'BB24',
    DLUGOSC_STER: 800,
    DLUGOSC_STER___DESCRIPTION: 'KOORD',
    DLUGOSC_STER_ALIAS: '800MM',
    DLUGOSC_STER_ALIAS___DESCRIPTION: 'koord 800',
    DLUGOSC_STER___VISIBLE: false,
    MODEL___VISIBLE: true
  };

  const { values: out, cleared } = clearHiddenParams(values, {
    defs, inputValues: { MODEL: 'BB24' }
  });

  assert.deepEqual(cleared, ['DLUGOSC_STER']);
  assert.equal(out.DLUGOSC_STER, '');
  assert.equal(out.DLUGOSC_STER___DESCRIPTION, '');
  assert.equal(out.DLUGOSC_STER_ALIAS, '');
  assert.equal(out.DLUGOSC_STER_ALIAS___DESCRIPTION, '');
  assert.equal(out.DLUGOSC_STER___VISIBLE, false);
  assert.equal(out.MODEL, 'BB24');
  assert.equal(isHiddenParam(out, 'DLUGOSC_STER'), true);
  assert.equal(isHiddenParam(out, 'MODEL'), false);
});

test('clearHiddenParams keeps values whose disabled verdict is not trustworthy', () => {
  const defs = parseParamDefinitions(PARAM_TXT);
  const values = { SZEROKOSC: 650, SZEROKOSC___VISIBLE: false, MODEL: 'BB24' };
  const { cleared } = clearHiddenParams(values, { defs, inputValues: { MODEL: 'BB24' } });
  assert.deepEqual(cleared, []);
  assert.equal(values.SZEROKOSC, 650);
});

test('clearHiddenParams accepts the browser verdict for ENABLE-gated params (trustAll)', () => {
  const defs = parseParamDefinitions(PARAM_TXT);
  // The browser had the full form state, so SZEROKOSC's ENABLE really was false —
  // no need for the "were all referenced params supplied" check.
  const values = { SZEROKOSC: 650, SZEROKOSC___VISIBLE: false };
  const { cleared } = clearHiddenParams(values, { trustAll: true, defs });
  assert.deepEqual(cleared, ['SZEROKOSC']);
  assert.equal(values.SZEROKOSC, '');
});

test('clearHiddenParams never touches a param without an ENABLE formula (FORMROW=0)', () => {
  // Regression: order 2905/2920 — OPIS_POZYCJI is reported ___VISIBLE:false only
  // because FORMROW=0, and clearing it destroyed the customer's position note.
  const defs = parseParamDefinitions(PARAM_TXT);
  const values = {
    OPIS_POZYCJI: 'Duette 32mm, profielkleur MA creme; Mont.hg=2600',
    OPIS_POZYCJI___VISIBLE: false,
    MODEL: 'BB24',
    MODEL___VISIBLE: false,
    uid: 'abc',
    uid___VISIBLE: false
  };
  const { cleared } = clearHiddenParams(values, { trustAll: true, defs });
  assert.deepEqual(cleared, []);
  assert.match(values.OPIS_POZYCJI, /^Duette 32mm/);
  assert.equal(values.MODEL, 'BB24');   // MODEL has no ENABLE formula either
  assert.equal(values.uid, 'abc');      // not a form param at all
});

test('clearHiddenParams clears nothing when param.txt is unreadable', () => {
  const values = { DLUGOSC_STER: 800, DLUGOSC_STER___VISIBLE: false };
  const { cleared } = clearHiddenParams(values, { trustAll: true, defs: null });
  assert.deepEqual(cleared, []);
  assert.equal(values.DLUGOSC_STER, 800);
});

test('clearHiddenParams never blanks price params (they feed the totals)', () => {
  const values = {
    CENA: 276, CENA___VISIBLE: false,
    SUB___CENA: 300, SUB___CENA___VISIBLE: false,
    CENA_S: 'x', CENA_S___VISIBLE: false,
    POW: 1.2, POW___VISIBLE: false
  };
  const { cleared } = clearHiddenParams(values, { trustAll: true });
  assert.deepEqual(cleared, []);
  assert.equal(values.CENA, 276);
  assert.equal(values.SUB___CENA, 300);
  assert.equal(values.POW, 1.2);
  assert.equal(isPriceLikeName('CENA_KONCOWA'), true);
  assert.equal(isPriceLikeName('MODEL'), false);
});

test('IMPORT_KEEP_HIDDEN_PARAMS=1 disables clearing entirely', () => {
  const previous = process.env.IMPORT_KEEP_HIDDEN_PARAMS;
  process.env.IMPORT_KEEP_HIDDEN_PARAMS = '1';
  try {
    const values = { DLUGOSC_STER: 800, DLUGOSC_STER___VISIBLE: false };
    const { cleared } = clearHiddenParams(values, { trustAll: true });
    assert.deepEqual(cleared, []);
    assert.equal(values.DLUGOSC_STER, 800);
  } finally {
    if (previous === undefined) delete process.env.IMPORT_KEEP_HIDDEN_PARAMS;
    else process.env.IMPORT_KEEP_HIDDEN_PARAMS = previous;
  }
});
