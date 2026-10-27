'use strict';

/**
 * Stawka VAT zlecenia konta podrzędnego grupy (services/vatCalculator.js
 * `resolveGroupVatRateForOrder`, decyzja właściciela 2026-10-27): cena klienta
 * grupy to sprzedaż GRUPY-MATKI jej klientowi, więc liczy się kraj grupy
 * i kraj konta podrzędnego — nie kraj organizacji HKL, do której grupy należą.
 *
 * Warstwa bazy jest podmieniona w `require.cache` PRZED załadowaniem serwisu,
 * więc test nie łączy się z MySQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const dbPath = require.resolve('../../db/db_helper.js');
let row = null;
const queries = [];
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        selectQuery: async (sql, ...args) => {
            queries.push({ sql, args });
            return row ? [row] : [];
        }
    }
};

const { resolveGroupVatRateForOrder } = require('../vatCalculator');

test('grupa NL bez kraju konta podrzędnego — sprzedaż krajowa NL (21%), nie 0% jak HKL → grupa', async () => {
    row = { role: 'group', group_country: 'NL', client_country: null };
    assert.deepEqual(await resolveGroupVatRateForOrder(3186), { vatRate: 21, reason: 'domestic' });
});

test('grupa PL — 23%; konto podrzędne z innym krajem UE — 0% (WDT)', async () => {
    row = { role: 'group', group_country: 'PL', client_country: '' };
    assert.deepEqual(await resolveGroupVatRateForOrder(3262), { vatRate: 23, reason: 'domestic' });
    row = { role: 'group', group_country: 'PL', client_country: 'DE' };
    assert.deepEqual(await resolveGroupVatRateForOrder(3262), { vatRate: 0, reason: 'eu-reverse-charge' });
});

test('zlecenie bez konta podrzędnego albo nie-grupy — null (zostaje ogólna reguła)', async () => {
    row = null;
    assert.equal(await resolveGroupVatRateForOrder(1), null);
    row = { role: null, group_country: 'NL', client_country: null };
    assert.equal(await resolveGroupVatRateForOrder(1), null);
    const before = queries.length;
    assert.equal(await resolveGroupVatRateForOrder(undefined), null);
    assert.equal(queries.length, before, 'bez id zlecenia nie pyta bazy');
});
