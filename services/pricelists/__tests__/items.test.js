'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../scriptModel');
const { buildItems, baseContext } = require('../index');
const { createRealm } = require('../../formEngine/scriptRunner');

const realm = createRealm();
const evaluate = (f, v) => realm.evaluate(f, v);

// Dwie dopłaty w formacie emitera: stała przy silniku i stała przy modelu „slope” (warunek na opisie).
const SCRIPT = [
  'function f(arg){',
  'const obj = JSON.parse(arg);',
  'var DOPLATA=0;',
  'var DOPLATA_S="";',
  'var n=0;',
  'var v=0;',
  'var M07=0;',
  'v=0;',
  'n=0;',
  'if(evaluateFormula(\'ZAWIERA(MOTOR,"M07")\',obj))n=n+1;',
  'v=55.5;',
  'M07=v*n;',
  'if(M07!=0){if(DOPLATA_S!="")DOPLATA_S+="+";DOPLATA_S+=""+M07+"(M07)";}',
  'var SL=0;',
  'v=0;',
  'n=0;',
  'if(evaluateFormula(\'AND(WSROD(MONTAZ,"MPT"),ZAWIERA(MODEL___DESCRIPTION,"slope"))\',obj))n=n+1;',
  'v=12;',
  'SL=v*n;',
  'if(SL!=0){if(DOPLATA_S!="")DOPLATA_S+="+";DOPLATA_S+=""+SL+"(SL)";}',
  'DOPLATA=M07+SL;',
  'return {"DOPLATA":DOPLATA,"DOPLATA_S":DOPLATA_S};',
  '}',
  ''
].join('\r\n');

test('buildItems: dopłata dostaje swój wybór mimo pustego formularza (silnik, opis modelu)', () => {
  const model = sm.parseScript(SCRIPT);
  const params = { MOTOR: { DEFAULT: '' }, MONTAZ: { DEFAULT: 'SPSCH' }, MODEL: { DEFAULT: 'VS2' } };
  const options = {
    MOTOR: [{ VALUE: 'M07', DESCRIPTION: 'Somfy' }],
    MONTAZ: [{ VALUE: 'SPSCH' }, { VALUE: 'MPT' }],
    MODEL: [{ VALUE: 'VS2', DESCRIPTION: 'o stałym naciągu' }, { VALUE: 'VS4_L', DESCRIPTION: 'Slope' }, { VALUE: 'VS5_L', DESCRIPTION: 'Slope' }]
  };
  const notes = [];
  // Pusty formularz ma '' lub DEFAULT w każdym polu — przed 10.11 dopłaty liczyły się wtedy na 0.
  const items = buildItems({ model, sections: model.sections, params, options, base: baseContext('uid', params), increase: { f: 1, fr: -1 }, evaluate, notes });
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName.M07.amount, 55.5);
  assert.equal(byName.SL.amount, 12);
  assert.deepEqual(byName.SL.filters.find((f) => f.param === 'MODEL').options, ['VS4_L', 'VS5_L']);
  assert.equal(notes.filter((n) => n.kind === 'item-always-zero').length, 0);
});

test('clausesOf: OR z WSROD na jednym polu = jeden filtr (75: kolor systemu), mieszany OR zostaje surowy', () => {
  const { clausesOf } = require('../conditions');
  const [c] = clausesOf('OR(WSROD(KOLOR_SYSTE,"W_M"),WSROD(KOLOR_SYSTE,"W_MP"))');
  assert.equal(c.kind, 'filter');
  assert.equal(c.param, 'KOLOR_SYSTE');
  assert.equal(c.list, 'W_M,W_MP');
  assert.equal(clausesOf('OR(WSROD(A,"1"),WSROD(B,"2"))')[0].kind, 'raw');
  assert.equal(clausesOf('OR(WSROD(A,"1"),NOT(WSROD(A,"2")))')[0].kind, 'raw');
});
