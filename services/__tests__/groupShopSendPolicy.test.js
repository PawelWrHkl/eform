'use strict';

/**
 * Samodzielna wysyłka konta podrzędnego grupy (services/groupShopSendPolicy.js,
 * `group_user.send_order_policy`).
 *
 * Warstwa bazy jest podmieniona w `require.cache` PRZED załadowaniem serwisu,
 * więc test nie łączy się z MySQL.
 */

const test = require('node:test');
const assert = require('node:assert');

const dbPath = require.resolve('../../db/db_helper.js');
let policy = false;
let orderStatus = 'active';
const policyCalls = [];
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        getGroupUserSendOrderPolicy: async (id) => {
            policyCalls.push(id);
            if (policy instanceof Error) throw policy;
            return policy;
        },
        getOrderStatus: async () => orderStatus
    }
};

const { canGroupShopSendOrders, getGroupShopSendBlock } = require('../groupShopSendPolicy');

const shop = { isGroupShop: true, groupShopId: 41, userId: 3346 };
const parent = { isGroup: true, userId: 3346 };
const client = { userId: 7, ident: 'ryver' };

test('konto podrzędne: ustawienie czytane z bazy dla własnego group_user', async () => {
    policyCalls.length = 0;
    policy = true;
    assert.equal(await canGroupShopSendOrders(shop), true);
    assert.deepStrictEqual(policyCalls, [41]);

    policy = false;
    assert.equal(await canGroupShopSendOrders(shop), false);
});

test('inne sesje nigdy nie dostają zgody i nie pytają bazy', async () => {
    policyCalls.length = 0;
    policy = true;
    for (const user of [parent, client, null, undefined, { isGroupShop: true }]) {
        assert.equal(await canGroupShopSendOrders(user), false);
    }
    assert.deepStrictEqual(policyCalls, []);
});

test('błąd bazy = brak zgody (zachowanie sprzed przełącznika)', async () => {
    policy = new Error('Unknown column');
    assert.equal(await canGroupShopSendOrders(shop), false);
});

test('wysyłka: bez zgody 403, jak dotąd', async () => {
    policy = false;
    orderStatus = 'active';
    const block = await getGroupShopSendBlock(shop, 9001);
    assert.equal(block.status, 403);
    assert.match(block.message, /zatwierdzenia/);
});

test('wysyłka: ze zgodą aktywne zamówienie przechodzi', async () => {
    policy = true;
    orderStatus = 'active';
    assert.equal(await getGroupShopSendBlock(shop, 9001), null);
});

test('wysyłka: zamówienie czekające na zatwierdzenie zostaje w kolejce grupy', async () => {
    policy = true;
    orderStatus = 'pending_approval';
    const block = await getGroupShopSendBlock(shop, 9001);
    assert.equal(block.status, 409);
});

test('wysyłka: blokada nie dotyczy sesji innej niż konto podrzędne', async () => {
    policy = false;
    orderStatus = 'pending_approval';
    assert.equal(await getGroupShopSendBlock(parent, 9001), null);
    assert.equal(await getGroupShopSendBlock(client, 9001), null);
});
