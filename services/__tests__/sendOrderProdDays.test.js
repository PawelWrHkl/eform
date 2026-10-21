/**
 * `prod_days` w JSON-ie zamówienia (services/sendOrderService.js).
 *
 * Produkcja (stan 2026-10-20) nie ma kolumny `order_item.prod_days` — wiersze
 * pozycji przychodzą bez tego pola, więc JSON wychodził z `prod_days: null`
 * u wszystkich, choć widok zlecenia pokazywał termin. Tor wysyłki podaje teraz
 * termin wyliczony w chwili wysyłki (`options.prodDays`), a kolumna jest
 * tylko zapasem.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderSender } = require('../sendOrderService');

const zamowienie = { id: 1, order_idx: 7, org_ident: 'HKL', user_ident: 'KLIENT' };
const opcjeSciezki = { orgIdent: 'HKL', userIdent: 'KLIENT' };

function pozycja(id, extra = {}) {
    return { id, asortment_group_number: '71', json_parameters: {}, parameters_short: {}, ...extra };
}

test('baza bez kolumny prod_days: termin z mapy wysyłki, null zostaje null', () => {
    const sender = new OrderSender({}, zamowienie, [pozycja(10), pozycja(11)], {
        ...opcjeSciezki,
        prodDays: { 10: 17, 11: null }
    });
    assert.deepEqual(sender.getData().items.map((i) => i.prod_days), [17, null]);
});

test('mapa ma pierwszeństwo przed kolumną', () => {
    const sender = new OrderSender({}, zamowienie, [pozycja(10, { prod_days: 5 })], {
        ...opcjeSciezki,
        prodDays: { 10: 22 }
    });
    assert.equal(sender.getData().items[0].prod_days, 22);
});

test('bez mapy (podgląd, PDF) — kolumna, string z MySQL-a zamieniony na liczbę', () => {
    const sender = new OrderSender({}, zamowienie, [pozycja(10, { prod_days: '12' }), pozycja(11)], opcjeSciezki);
    assert.deepEqual(sender.getData().items.map((i) => i.prod_days), [12, null]);
});

test('pozycja spoza mapy — zapas z kolumny', () => {
    const sender = new OrderSender({}, zamowienie, [pozycja(10, { prod_days: 8 })], {
        ...opcjeSciezki,
        prodDays: { 99: 30 }
    });
    assert.equal(sender.getData().items[0].prod_days, 8);
});
