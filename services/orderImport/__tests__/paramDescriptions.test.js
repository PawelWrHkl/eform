'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadClientDescriptions,
  seedParamDescriptions,
  ensureDescriptionKeys
} = require('../paramDescriptions');
const { parseParamDefinitions } = require('../paramVisibility');

const PARAM_TXT = [
  'NAME\tDESCRIPTION\tTYPE\tENABLE',
  'MODEL\tMODEL\tdict\t<NULL>',
  'KOLOR\tKOLOR\tdict\t<NULL>',
  'KOLOR_DODATKOWY\tKOLOR DODATKOWY\tdict\t<NULL>',
  'SZEROKOSC\tSZEROKOŚĆ [MM]\tnumeric\t<NULL>'
].join('\n');

function fakeConn(rows, captured = {}) {
  return {
    async query(sql, params) {
      captured.sql = sql;
      captured.params = params;
      return [rows];
    },
    async end() { captured.ended = true; }
  };
}

test('loadClientDescriptions returns the client collection keyed by param and value', async () => {
  const captured = {};
  const rows = [
    { parameter: 'KOLOR', value_col: '6877-W32', alias: '6877-W32', description: 'PG#1' },
    { parameter: 'KOLOR', value_col: '6992-W25', alias: '8919-W25', description: 'PG #0' },
    { parameter: 'KOLOR_DODATKOWY', value_col: '6877-W32', alias: '6877-W32', description: 'PG#1' },
    { parameter: 'KOLOR', value_col: '7938-W25', alias: null, description: null }
  ];

  const out = await loadClientDescriptions('71', 'HKL', 'TCN', {
    connect: async () => fakeConn(rows, captured)
  });

  // The collection is picked by joining paramdict_aliases_config — never guessed.
  assert.match(captured.sql, /JOIN paramdict_aliases_config/);
  assert.match(captured.sql, /UPPER\(pac\.collection\) = UPPER\(ca\.collection\)/);
  assert.deepEqual(captured.params, ['71', 'HKL', 'TCN']);
  assert.equal(captured.ended, true);

  assert.deepEqual(out.get('KOLOR').get('6877-W32'), { alias: '6877-W32', description: 'PG#1' });
  assert.deepEqual(out.get('KOLOR').get('6992-W25'), { alias: '8919-W25', description: 'PG #0' });
  assert.deepEqual(out.get('KOLOR').get('7938-W25'), { alias: '', description: '' });
  assert.equal(out.get('KOLOR_DODATKOWY').get('6877-W32').description, 'PG#1');
});

test('loadClientDescriptions returns an empty map without org/user context', async () => {
  let connected = false;
  const out = await loadClientDescriptions('71', '', 'TCN', {
    connect: async () => { connected = true; return fakeConn([]); }
  });
  assert.equal(out.size, 0);
  assert.equal(connected, false);
});

test('seedParamDescriptions takes the price group from client_aliases when the dictionary has none', () => {
  // Real case: order 272115, group 71 — translation_dictionary.description is NULL
  // for 6877-W32, the "PG#1" tag exists only in the ZONNELUX collection.
  const values = { MODEL: 'BB24', KOLOR: '6877-W32', SZEROKOSC: 910 };
  const clientDescriptions = new Map([
    ['KOLOR', new Map([['6877-W32', { alias: '6877-W32', description: 'PG#1' }]])]
  ]);

  const { seeded } = seedParamDescriptions(values, {
    paramdict: { MODEL: { BB24: 'BB 24' } },
    clientDescriptions,
    paramDefs: parseParamDefinitions(PARAM_TXT)
  });

  assert.equal(values.KOLOR___DESCRIPTION, 'PG#1');
  assert.equal(values.KOLOR_ALIAS, '6877-W32');
  assert.equal(values.KOLOR_ALIAS___DESCRIPTION, 'PG#1');
  assert.equal(values.MODEL___DESCRIPTION, 'BB 24');
  assert.deepEqual(seeded, ['MODEL=translation_dictionary', 'KOLOR=client_aliases']);
});

test('seedParamDescriptions prefers the translation dictionary over client aliases', () => {
  const values = { KOLOR: '3004-P20' };
  const clientDescriptions = new Map([
    ['KOLOR', new Map([['3004-P20', { alias: '2004-P20', description: 'PG #9' }]])]
  ]);

  seedParamDescriptions(values, {
    paramdict: { KOLOR: { '3004-P20': 'PG #0' } },
    clientDescriptions
  });

  assert.equal(values.KOLOR___DESCRIPTION, 'PG #0');
  // The alias branch still reflects what the client's own price list says.
  assert.equal(values.KOLOR_ALIAS, '2004-P20');
  assert.equal(values.KOLOR_ALIAS___DESCRIPTION, 'PG #9');
});

test('seedParamDescriptions never overwrites descriptions or aliases already present', () => {
  const values = {
    KOLOR: '6877-W32',
    KOLOR___DESCRIPTION: 'PG#7',
    KOLOR_ALIAS: 'WLASNY',
    KOLOR_ALIAS___DESCRIPTION: 'PG#8'
  };
  seedParamDescriptions(values, {
    paramdict: { KOLOR: { '6877-W32': 'PG #0' } },
    clientDescriptions: new Map([['KOLOR', new Map([['6877-W32', { alias: 'X', description: 'PG#1' }]])]])
  });
  assert.equal(values.KOLOR___DESCRIPTION, 'PG#7');
  assert.equal(values.KOLOR_ALIAS, 'WLASNY');
  assert.equal(values.KOLOR_ALIAS___DESCRIPTION, 'PG#8');
});

test('seedParamDescriptions falls back to the alias description from the payload', () => {
  const values = { KOLOR: '6877-W32' };
  seedParamDescriptions(values, {
    sourceValues: { KOLOR_ALIAS_DESCRIPTION: 'PG#1' }
  });
  assert.equal(values.KOLOR_ALIAS___DESCRIPTION, 'PG#1');
});

test('seedParamDescriptions skips empty values and no-selection sentinels', () => {
  const values = { DODATKI: '<NONE>', PROWADNICE: '', WYMIAR: { A: 1 } };
  seedParamDescriptions(values, {
    paramdict: { DODATKI: { '<NONE>': 'brak' } },
    clientDescriptions: new Map([['DODATKI', new Map([['<NONE>', { alias: 'x', description: 'PG#1' }]])]])
  });
  assert.equal(values.DODATKI___DESCRIPTION, '');     // key created, but no bogus description
  assert.equal(values.DODATKI_ALIAS, undefined);
  assert.equal(values.PROWADNICE___DESCRIPTION, '');
});

test('every declared param gets description keys so no formula hits #NAME?', () => {
  // hot-formula-parser evaluates both IF branches: a missing variable in the
  // untaken branch turns the whole price gate into false (→ price 0).
  const values = { MODEL: 'BB24', KOLOR: '6877-W32' };
  ensureDescriptionKeys(values, parseParamDefinitions(PARAM_TXT));

  for (const name of ['MODEL', 'KOLOR', 'KOLOR_DODATKOWY', 'SZEROKOSC']) {
    assert.equal(Object.prototype.hasOwnProperty.call(values, `${name}___DESCRIPTION`), true, name);
    assert.equal(Object.prototype.hasOwnProperty.call(values, `${name}_ALIAS___DESCRIPTION`), true, name);
  }
  assert.equal(values.KOLOR_DODATKOWY___DESCRIPTION, '');
});

test('ensureDescriptionKeys covers params present in values even without param.txt', () => {
  const values = { MODEL: 'BB24', KOLOR: '6877-W32' };
  ensureDescriptionKeys(values, null);
  assert.equal(values.MODEL___DESCRIPTION, '');
  assert.equal(values.KOLOR_ALIAS___DESCRIPTION, '');
  // Meta and alias keys must not spawn descriptions of their own.
  assert.equal(values.MODEL___DESCRIPTION___DESCRIPTION, undefined);
  assert.equal(values.KOLOR_ALIAS___DESCRIPTION___DESCRIPTION, undefined);
});
