'use strict';

/**
 * POP-02: adres dostawy / klienta końcowego od zapisu do JSON-a dla PROD.
 *
 * Regresja z produkcji (A&A Lohne, zlecenia 8, 23, 37): `send_address.phone`
 * ma tam VARCHAR(12), INSERT padał, `insertQuery` połykał błąd, a zlecenie
 * zapisywało się BEZ adresu wysyłki i jechało na adres hurtownika.
 * `db/core` podmieniony w `require.cache` — test nie łączy się z MySQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const corePath = require.resolve('../../db/core.js');
let calls = [];
let fake = {};
const record = (kind) => async (query, params) => {
    calls.push({ kind, query, params });
    return fake[kind] ? fake[kind](query, params) : (kind === 'insert' ? [{ insertId: 501 }] : kind === 'select' ? [] : { affectedRows: 1 });
};
require.cache[corePath] = {
    id: corePath, filename: corePath, loaded: true,
    exports: {
        selectQuery: record('select'), insertQuery: record('insert'), updateQuery: record('update'),
        deleteQuery: async () => true, connetToDb: async () => ({})
    }
};

const orders = require('../../db/orders.js');
const address = require('../../db/address.js');
const { OrderSender } = require('../sendOrderService');

const endClient = { name: 'Ingrid Simet', street: 'Eppleweg 1', zip: '85635', city: 'Höhenkirchen-Siegertsbrunn', country: 'de', phone: '+49 178 1685567', email: '' };
const reset = (f = {}) => { calls = []; fake = f; };
const neutralUpdates = () => calls.filter((c) => c.kind === 'update' && /neutral_shipping/.test(c.query));

test('INSERT adresu padł (telefon dłuższy niż kolumna) → null, a nie zlecenie bez adresu', async () => {
    reset({ insert: async () => false });
    assert.equal(await orders.insertSendAddress(endClient), null);
});

test('adres bez znacznika przed migracją: kolumny neutral_shipping nie dotykamy', async () => {
    reset({ select: async () => [{ id: 501, street: 'Eppleweg 1' }] });
    assert.equal(await orders.insertSendAddress({ ...endClient, neutral: false }), 501);
    assert.equal(neutralUpdates().length, 0);
});

test('wysyłka neutralna: znacznik zapisany; brak kolumny = błąd, nie cichy zapis', async () => {
    reset();
    assert.equal(await orders.insertSendAddress({ ...endClient, neutral: true }), 501);
    assert.deepEqual(neutralUpdates()[0].params, [1, 501]);

    reset({ update: async (q) => (/neutral_shipping/.test(q) ? false : { affectedRows: 1 }) });
    assert.equal(await orders.insertSendAddress({ ...endClient, neutral: true }), null);
});

test('edycja: nieudany zapis adresu wysyłki zwraca false (trasa odpowie błędem)', async () => {
    reset({
        select: async (q) => (/SELECT send_address_id/.test(q) ? [{ send_address_id: 77 }] : []),
        update: async (q) => (/JOIN send_address/.test(q) ? false : { affectedRows: 1 })
    });
    assert.equal(await orders.updateOrderDetails(10, '', 'kom', null, null, endClient), false);
});

function exportFor(flags, details, sendRow) {
    reset({
        select: async (q) => {
            if (/FROM order_item/.test(q)) return [{ id: 1, asortment_group_number: '71', json_parameters: {}, parameters_short: {}, comment: '' }];
            if (/SELECT send_address_id, delivery_address_id/.test(q)) return [flags];
            if (/FROM send_address WHERE id/.test(q)) return [sendRow];
            return [{ ...details }];
        }
    });
    return orders.getOrderDataToSend(5).then(({ orderDetails, orderItems }) =>
        new OrderSender({}, orderDetails, orderItems, { orgIdent: 'LUXAN_EWA_KRAWCZYK', userIdent: 'A&A Lohne' }).getData());
}

const account = { id: 5, order_idx: 3, org_ident: 'LUXAN_EWA_KRAWCZYK', user_ident: 'A&A Lohne', user_street: 'Twelsiek 5', user_zip: '32584', user_city: 'Löhne', user_country: 'DE' };

test('(b) klient końcowy + wysyłka neutralna → osobne pola w JSON-ie', async () => {
    const data = await exportFor({ send_address_id: 9, delivery_address_id: null }, { ...account, ...endClient, address: undefined }, { id: 9, neutral_shipping: 1 });
    assert.equal(calls.some((c) => /join send_address s on s.id = o.send_address_id/.test(c.query)), true);
    assert.equal(data.neutralShipping, true);
    assert.equal(data.name, 'Ingrid Simet');
    assert.equal(data.city, 'Höhenkirchen-Siegertsbrunn');
    assert.equal(data.userStreet, 'Twelsiek 5');
    assert.equal(data.comment, undefined);
});

test('(c) długi adres przechodzi do JSON-a bez ucinania', async () => {
    const street = 'Straße der Pioniere 33, Hinterhaus, 3. OG, Eingang über den Hof links neben der Garage, '.repeat(3).slice(0, 255);
    const data = await exportFor({ send_address_id: 9, delivery_address_id: null }, { ...account, ...endClient, street }, { id: 9, neutral_shipping: 0 });
    assert.equal(data.address, street);
    assert.equal(data.address.length, 255);
    assert.equal(data.neutralShipping, false);
});

test('(a) klient z dwoma adresami: zlecenie z adresem dostawy, konto = adres fakturowy', async () => {
    const data = await exportFor({ send_address_id: null, delivery_address_id: 4 },
        { ...account, user_ident: 'Wonen', user_street: 'Hoornsewal 1', name: 'Joost Wonen', street: 'Hoog Harnasch 36', zip: '2635 DL', city: 'Den Hoorn', country: 'NL' }, null);
    assert.equal(calls.some((c) => /join delivery_address da on da.id = o.delivery_address_id/.test(c.query)), true);
    assert.equal(data.address, 'Hoog Harnasch 36');
    assert.equal(data.userStreet, 'Hoornsewal 1');
    assert.equal(data.neutralShipping, false);
});

test('domyślny adres dostawy: jeden na klienta, bez zaznaczenia bez zapisu', async () => {
    reset();
    assert.equal(await address.setDefaultDeliveryAddress(6432, 4, false), true);
    assert.equal(calls.length, 0);
    assert.equal(await address.setDefaultDeliveryAddress(6432, 4, true), true);
    assert.match(calls[0].query, /SET is_default = \(id = \?\) WHERE user_id = \?/);
    assert.deepEqual(calls[0].params, [4, 6432]);
    assert.equal(await address.setDefaultDeliveryAddress(6432, 4, false, true), true);
    assert.match(calls[1].query, /SET is_default = 0 WHERE id = \? AND user_id = \?/);
});
