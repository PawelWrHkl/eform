'use strict';

/**
 * Baza VAT sumy zlecenia (services/subPrices.js attachSubVatTotals,
 * decyzja właściciela 2026-10-27): zlecenie GRUPY (matka i konto podrzędne)
 * liczy VAT od sumy zwykłej (P, `totalPrice.hidden`), a nie od ceny klienta
 * (N, `totalPrice.subLocked`). Zwykłe zlecenie klienta zostaje przy N.
 *
 * Warstwa bazy jest podmieniona w `require.cache` PRZED załadowaniem serwisów,
 * więc test nie łączy się z MySQL. VAT włączony zmienną środowiskową przed
 * załadowaniem `config.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.VAT_ENABLED = 'true';

const dbPath = require.resolve('../../db/db_helper.js');
let groupRow = null;
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        selectQuery: async (sql) => {
            if (sql.includes('group_user gu')) return groupRow ? [groupRow] : [];
            if (sql.includes('FROM `order` WHERE id')) return [{ user_id: 1, organization_id: 3 }];
            if (sql.includes('FROM `user` WHERE id')) return [{ country: 'PL' }];
            if (sql.includes('FROM organization WHERE id')) return [{ country: 'PL' }];
            return [];
        }
    }
};

const { attachSubVatTotals } = require('../subPrices');
const { resolveVatRateForOrder } = require('../vatCalculator');

test('zlecenie grupy: stawka i isGroup; VAT sumy od ceny zwykłej (hidden), nie od ceny klienta', async () => {
    groupRow = { role: 'group', group_country: 'PL', client_country: null };
    assert.deepEqual(await resolveVatRateForOrder(3262), { vatRate: 23, reason: 'domestic', isGroup: true });

    const totalPrice = { visible: '152.49', hidden: '152.49', subLocked: 157.8 };
    await attachSubVatTotals(totalPrice, 3262);
    assert.equal(totalPrice.vatBase, 152.49);
    assert.equal(totalPrice.subVat, '35.07');
    assert.equal(totalPrice.subGross, '187.56');
});

test('zwykłe zlecenie klienta: VAT nadal od ceny klienta (subLocked)', async () => {
    groupRow = null;
    const r = await resolveVatRateForOrder(3000);
    assert.equal(r.isGroup, false);

    const totalPrice = { visible: '100.00', hidden: '90.00', subLocked: 110 };
    await attachSubVatTotals(totalPrice, 3000);
    assert.equal(totalPrice.vatBase, 110);
    assert.equal(totalPrice.subVat, '25.30');
    assert.equal(totalPrice.subGross, '135.30');
});
