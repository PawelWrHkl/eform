'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePayloadAliases } = require('../aliasResolver');

// A form export added BUTKOLOR=C to group 20; translation_dictionary learns it
// only after syncGroup('20') — the resolver must sync and retry once by itself.
function dictAfterSync() {
  let synced = false;
  const syncCalls = [];
  return {
    syncCalls,
    deps: {
      async syncGroup(g) { syncCalls.push(g); synced = true; return { status: 'synced', entries: 1 }; },
      async resolveItemAliases(parameters, groupNumber) {
        const ok = synced || parameters.BUTKOLOR !== 'C';
        return {
          resolved: { ...parameters },
          errors: ok ? [] : [`Parametr "BUTKOLOR": wartość "C" nie znaleziona (grupa ${groupNumber})`]
        };
      }
    }
  };
}

test('unknown value: syncs the failing group once and accepts the item on retry', async () => {
  const { deps, syncCalls } = dictAfterSync();
  const items = [{ product: '20', parameters: { BUTKOLOR: 'C' } }, { product: '75', parameters: { X: '1' } }];
  const { items: out, errors } = await resolvePayloadAliases(items, null, deps);
  assert.deepEqual(errors, []);
  assert.deepEqual(syncCalls, ['20']);
  assert.equal(out[0].parameters.BUTKOLOR, 'C');
});

test('known values: no sync at all', async () => {
  const { deps, syncCalls } = dictAfterSync();
  const { errors } = await resolvePayloadAliases([{ product: '20', parameters: { BUTKOLOR: 'W' } }], null, deps);
  assert.deepEqual(errors, []);
  assert.deepEqual(syncCalls, []);
});

test('value missing from the form too: one sync, errors kept, hint that the dictionary is fresh', async () => {
  const syncCalls = [];
  const deps = {
    async syncGroup(g) { syncCalls.push(g); return { status: 'synced' }; },
    async resolveItemAliases(parameters) { return { resolved: parameters, errors: ['Parametr "BUTKOLOR": wartość "Q"'] }; }
  };
  const { errors } = await resolvePayloadAliases([{ product: '20', parameters: { BUTKOLOR: 'Q' } }], null, deps);
  assert.deepEqual(syncCalls, ['20']);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Item\[0\] \(group=20\)/);
  assert.match(errors[1], /zsynchronizowany/);
});

test('a failing sync does not crash the import — original errors stay', async () => {
  const deps = {
    async syncGroup() { throw new Error('db down'); },
    async resolveItemAliases(parameters) { return { resolved: parameters, errors: ['x'] }; }
  };
  const { errors } = await resolvePayloadAliases([{ product: '20', parameters: {} }], null, deps);
  assert.deepEqual(errors, ['Item[0] (group=20): x']);
});
