'use strict';

/**
 * Bramki statusu (utils/orderStatusGuard.js) dla zlecenia ANULOWANEGO.
 * Anulowanie jest nieodwracalne: żadnej edycji, żadnej ponownej wysyłki —
 * także dla admina — a widok aktywnego zlecenia przekierowuje na podgląd.
 *
 * Warstwa bazy jest podmieniona w `require.cache` PRZED załadowaniem bramki,
 * więc test nie łączy się z MySQL.
 */

const test = require('node:test');
const assert = require('node:assert');

const dbPath = require.resolve('../../db/db_helper.js');
let currentStatus = 'canceled';
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        getOrderStatus: async () => currentStatus,
        getOrderCreatedByGroupUser: async () => null
    }
};

const guard = require('../orderStatusGuard');

const klient = { userId: 7, ident: 'ryver' };
const admin = { userId: 1, ident: 'admin', isAdmin: true, isOwner: true };

test('anulowane: edycja zablokowana dla klienta i dla admina, z przekierowaniem na podgląd', async () => {
    currentStatus = 'canceled';
    for (const user of [klient, admin]) {
        const block = await guard.getOrderMutationBlock(3100, user);
        assert.ok(block, `brak blokady dla ${user.ident}`);
        assert.equal(block.success, false);
        assert.match(block.message, /anulowane/i);
        assert.equal(block.redirect, '/orders/history/order/3100');
    }
});

test('anulowane: widok aktywnego zlecenia przekierowuje na podgląd', async () => {
    currentStatus = 'canceled';
    assert.deepStrictEqual(await guard.shouldRedirectFromActiveOrderView(3100, klient), { redirect: '/orders/history/order/3100' });
    assert.equal(await guard.isCanceledOrder(3100), true);
});

test('dotychczasowe statusy działają jak wcześniej', async () => {
    currentStatus = 'active';
    assert.equal(await guard.getOrderMutationBlock(3100, klient), null);
    assert.equal(await guard.shouldRedirectFromActiveOrderView(3100, klient), null);
    assert.equal(await guard.isCanceledOrder(3100), false);

    currentStatus = 'sent';
    assert.match((await guard.getOrderMutationBlock(3100, klient)).message, /wysłanego/);
    assert.deepStrictEqual(await guard.shouldRedirectFromActiveOrderView(3100, klient), { redirect: '/orders/history/order/3100' });

    currentStatus = 'correction';
    assert.equal(await guard.getOrderMutationBlock(3100, admin), null, 'admin koryguje');
    assert.ok(await guard.getOrderMutationBlock(3100, klient));
});
