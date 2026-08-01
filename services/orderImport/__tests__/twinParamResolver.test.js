'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTwinParameters, pickInputTwin } = require('../twinParamResolver');

// Mirrors group 39 / lang nl: one select twin with coded options, one (or two)
// free-input twins sharing the same description.
function dict39() {
  return {
    params: {
      DLUGOSC_STER: 'BEDIENINGSLENGTE [MM]',
      DLUGSTER: 'BEDIENINGSLENGTE [MM]',
      MODEL: 'MODEL'
    },
    paramdict: {
      DLUGOSC_STER: { EC100: 'EINDELOOS KOORD 1000MM', KG150: 'KETTING 1500MM' },
      MODEL: { U25MV: 'ULTIMATE 25mm' }
    }
  };
}

function fakeRepo(dict) {
  return { async getGroupTranslations() { return dict; } };
}

// `paramdict.txt` for group 39 declares a DLUGOSC_STER_VALUE column but none for
// DLUGSTER — that column list is what marks a twin as a genuine free input.
const declared39 = new Set(['DLUGOSC_STER', 'MODEL']);

function fakeScanner(header) {
  return { async readDataFile() { return header; } };
}

test('clears the select twin when the input twin already carries the value', async () => {
  const { parameters, notes } = await resolveTwinParameters(
    '39',
    { MODEL: 'U25MV', DLUGOSC_STER: 900, DLUGSTER: 900, DLUGOSC_STER___DESCRIPTION: 'x' },
    'nl',
    { dict: dict39(), declaredDictParams: declared39 }
  );

  assert.equal(parameters.DLUGOSC_STER, '');
  assert.equal(parameters.DLUGOSC_STER___DESCRIPTION, '');
  assert.equal(parameters.DLUGSTER, 900);
  assert.equal(notes.length, 1);
});

test('moves the value into the empty input twin', async () => {
  const { parameters } = await resolveTwinParameters(
    '39',
    { MODEL: 'U25MV', DLUGOSC_STER: '900', DLUGSTER: '' },
    'nl',
    { dict: dict39(), declaredDictParams: declared39 }
  );

  assert.equal(parameters.DLUGSTER, '900');
  assert.equal(parameters.DLUGOSC_STER, '');
});

test('leaves a valid selection untouched', async () => {
  const input = { MODEL: 'U25MV', DLUGOSC_STER: 'EC100', DLUGSTER: '' };
  const { parameters, notes } = await resolveTwinParameters('39', input, 'nl', { dict: dict39(), declaredDictParams: declared39 });

  assert.deepEqual(parameters, input);
  assert.deepEqual(notes, []);
});

test('copies an option key out of the input twin into the empty select twin', async () => {
  const { parameters } = await resolveTwinParameters(
    '39',
    { MODEL: 'U25MV', DLUGOSC_STER: '', DLUGSTER: 'KG150' },
    'nl',
    { dict: dict39(), declaredDictParams: declared39 }
  );

  assert.equal(parameters.DLUGOSC_STER, 'KG150');
  assert.equal(parameters.DLUGSTER, 'KG150');
});

test('does not touch params that have no twin', async () => {
  const dict = {
    params: { KOLOR: 'Kleur' },
    paramdict: { KOLOR: { CZARNY: 'Zwart' } }
  };
  const { parameters, notes } = await resolveTwinParameters(
    '39',
    { KOLOR: 'nieistniejacy' },
    'nl',
    { dict, declaredDictParams: new Set(['KOLOR']) }
  );

  assert.equal(parameters.KOLOR, 'nieistniejacy');
  assert.deepEqual(notes, []);
});

test('skips twin sets with more than one select', async () => {
  const dict = {
    params: { A_SEL: 'Same label', B_SEL: 'Same label', C_IN: 'Same label' },
    paramdict: { A_SEL: { X: 'x' }, B_SEL: { Y: 'y' } }
  };
  const { parameters } = await resolveTwinParameters(
    '9',
    { A_SEL: '900', C_IN: '' },
    'nl',
    { dict, declaredDictParams: new Set(['A_SEL', 'B_SEL']) }
  );

  assert.equal(parameters.A_SEL, '900');
  assert.equal(parameters.C_IN, '');
});

test('picks the closest-named empty input twin (pl: DLUGSTER over STEROWANIE)', async () => {
  const dict = {
    params: {
      DLUGOSC_STER: 'DŁUGOŚĆ STEROWANIA',
      DLUGSTER: 'DŁUGOŚĆ STEROWANIA',
      STEROWANIE: 'DŁUGOŚĆ STEROWANIA'
    },
    paramdict: { DLUGOSC_STER: { EC100: 'x' } }
  };
  const { parameters } = await resolveTwinParameters(
    '39',
    { DLUGOSC_STER: '900', DLUGSTER: '', STEROWANIE: '' },
    'pl',
    { dict, declaredDictParams: new Set(['DLUGOSC_STER']) }
  );

  assert.equal(parameters.DLUGSTER, '900');
  assert.equal(parameters.STEROWANIE, '');
  assert.equal(parameters.DLUGOSC_STER, '');
});

test('adds the input twin key when the payload omits it', async () => {
  const { parameters } = await resolveTwinParameters(
    '39',
    { DLUGOSC_STER: '900' },
    'nl',
    { dict: dict39(), declaredDictParams: declared39 }
  );

  assert.equal(parameters.DLUGSTER, '900');
  assert.equal(parameters.DLUGOSC_STER, '');
});

test('returns parameters unchanged when the dictionary read fails', async () => {
  const repo = { async getGroupTranslations() { throw new Error('db down'); } };
  const { parameters, notes } = await resolveTwinParameters(
    '39',
    { DLUGOSC_STER: '900' },
    'nl',
    { repo, declaredDictParams: declared39 }
  );

  assert.deepEqual(parameters, { DLUGOSC_STER: '900' });
  assert.deepEqual(notes, []);
});

test('reads the dictionary through the repo when no dict is injected', async () => {
  const { parameters } = await resolveTwinParameters(
    '39',
    { DLUGOSC_STER: 900, DLUGSTER: 900 },
    'nl',
    { repo: fakeRepo(dict39()), declaredDictParams: declared39 }
  );

  assert.equal(parameters.DLUGOSC_STER, '');
});

test('pickInputTwin prefers the longest shared prefix', () => {
  assert.equal(pickInputTwin(['STEROWANIE', 'DLUGSTER'], 'DLUGOSC_STER'), 'DLUGSTER');
});

test('does not treat an option-less but DECLARED dict param as an input twin', async () => {
  // Group 20: paramdict.txt declares RODZAJ_DACH_VALUE but ships zero option
  // rows, and RODZAJ_DACH shares its description with MODEL. An invalid MODEL
  // must still be rejected instead of being parked in RODZAJ_DACH.
  const dict = {
    params: { MODEL: 'MODEL', RODZAJ_DACH: 'MODEL' },
    paramdict: { MODEL: { DFC20: 'DFC 20' } }
  };
  const { parameters, notes } = await resolveTwinParameters(
    '20',
    { MODEL: 'NIEISTNIEJACY', RODZAJ_DACH: '' },
    'nl',
    { dict, declaredDictParams: new Set(['MODEL', 'RODZAJ_DACH']) }
  );

  assert.equal(parameters.MODEL, 'NIEISTNIEJACY');
  assert.equal(parameters.RODZAJ_DACH, '');
  assert.deepEqual(notes, []);
});

test('reads declared dict columns from the paramdict.txt header', async () => {
  const header = 'ROW_NUM\tMODEL_VALUE\tMODEL_DESCRIPTION\tDLUGOSC_STER_VALUE\t'
    + 'DLUGOSC_STER_DESCRIPTION\n1\tU25MV\tULTIMATE\tEC100\tKOORD\n';
  const { parameters } = await resolveTwinParameters(
    '39',
    { DLUGOSC_STER: '900', DLUGSTER: '' },
    'nl',
    { dict: dict39(), fileScanner: fakeScanner(header) }
  );

  assert.equal(parameters.DLUGSTER, '900');
  assert.equal(parameters.DLUGOSC_STER, '');
});

test('skips the fix when the paramdict header cannot be read', async () => {
  const { parameters, notes } = await resolveTwinParameters(
    '39',
    { DLUGOSC_STER: '900', DLUGSTER: '' },
    'nl',
    { dict: dict39(), fileScanner: { async readDataFile() { return null; } } }
  );

  assert.equal(parameters.DLUGOSC_STER, '900');
  assert.equal(parameters.DLUGSTER, '');
  assert.deepEqual(notes, []);
});

test('skips the fix when reading the paramdict header throws', async () => {
  const { parameters } = await resolveTwinParameters(
    '39',
    { DLUGOSC_STER: '900', DLUGSTER: '' },
    'nl',
    { dict: dict39(), fileScanner: { async readDataFile() { throw new Error('ENOENT'); } } }
  );

  assert.equal(parameters.DLUGOSC_STER, '900');
});
