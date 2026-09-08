'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveScriptFile } = require('../deployedScript');

test('resolveScriptFile: SCRIPTS column names the variant directly', () => {
  const resolved = resolveScriptFile({
    groupNumber: '75', paramName: 'CENA', scriptsField: 'A'
  });
  assert.deepEqual(resolved, { file: 'param-CENA-A.js' });
});

test('resolveScriptFile: a multiplier token is kept verbatim, not reassembled', () => {
  // `Cmul1.40` and `Cmul1.4` are different filenames — only the original text
  // is certain, so the raw token has to survive.
  assert.deepEqual(
    resolveScriptFile({ groupNumber: '73', paramName: 'CENA', scriptsField: 'Cmul1.40' }),
    { file: 'param-CENA-Cmul1.40.js' }
  );
});

test('resolveScriptFile: SUB___ params resolve to their own script file', () => {
  assert.deepEqual(
    resolveScriptFile({ groupNumber: '71', paramName: 'SUB___CENA', scriptsField: 'J' }),
    { file: 'param-SUB___CENA-J.js' }
  );
});

test("resolveScriptFile: 'true'/<NULL> mean 'ask the client mapping', not a variant", () => {
  // No such client anywhere in prod.txt, so the client mapping yields nothing
  // and the caller is told so instead of being handed a guessed filename.
  for (const scriptsField of ['true', '<NULL>', undefined]) {
    const resolved = resolveScriptFile({
      groupNumber: '73', lang: 'pl', orgIdent: 'NIE_MA_TAKIEJ_ORG', userIdent: 'NIE_MA', paramName: 'CENA', scriptsField
    });
    assert.equal(resolved, null, `scriptsField=${scriptsField}`);
  }
});

const { factorFromLabel } = require('../deployedScript');

test('factorFromLabel: reads the per-customer surcharge the script declares', () => {
  // Real label from group 71 param-CENA-K.js with a uid that is in its table.
  assert.equal(factorFromLabel('(304(TCNDPG2))*1.045'), 1.045);
});

test('factorFromLabel: no surcharge means no factor', () => {
  assert.equal(factorFromLabel('304(TCNDPG2)'), 1);
  assert.equal(factorFromLabel('62.4(PG2)'), 1);
  assert.equal(factorFromLabel(''), 1);
  assert.equal(factorFromLabel(undefined), 1);
});

test('factorFromLabel: a section name ending in a digit is not mistaken for a factor', () => {
  assert.equal(factorFromLabel('70(AU20)'), 1);
});
