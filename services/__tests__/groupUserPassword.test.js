'use strict';

/**
 * Zmiana hasła konta podrzędnego grupy (db/group.js updateGroupUserPassword).
 *
 * Regresja z produkcji 2026-11-10 (Azra-1, PIN 71544-1): hash był nadpisywany,
 * a `plain` zostawało z założenia konta — panel grupy kopiował stare hasło.
 * Warstwa `db/core` podmieniona w `require.cache`, test nie łączy się z MySQL.
 */

const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');

const corePath = require.resolve('../../db/core.js');
const calls = [];
require.cache[corePath] = {
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: {
        selectQuery: async () => [],
        insertQuery: async () => [{}],
        updateQuery: async (query, params) => { calls.push({ query, params }); return true; },
        deleteQuery: async () => true
    }
};

const { updateGroupUserPassword } = require('../../db/group.js');

test('zmiana hasła zapisuje hash i plain razem', async () => {
    await updateGroupUserPassword(13, 'nowe1');
    assert.equal(calls.length, 1);
    const { query, params } = calls[0];
    assert.match(query, /SET password = \?, plain = \? WHERE id = \?/);
    assert.equal(params.length, 3);
    assert.ok(bcrypt.compareSync('nowe1', params[0]));
    assert.equal(params[1], 'nowe1');
    assert.equal(params[2], 13);
});
