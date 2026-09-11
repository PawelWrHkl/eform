'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    isEligibleUser,
    resolvePortalDiscountForOrder,
    resolveCombinedDiscountForOrder,
    PORTAL_DISCOUNT_ORG_ID,
    PORTAL_DISCOUNT_START_DATE,
    PORTAL_DISCOUNT_PERCENT
} = require('../portalUsageDiscount');

/** Baza-atrapa: zwraca to, co podstawimy, i zapamiętuje zapytania. */
function fakeSelect(odpowiedzi) {
    const wywolania = [];
    const select = async (sql, params) => {
        wywolania.push({ sql, params });
        const kolejna = odpowiedzi.shift();
        if (kolejna instanceof Error) throw kolejna;
        return kolejna ?? [];
    };
    select.wywolania = wywolania;
    return select;
}

test('stałe reguły są tym, co ustalono z właścicielem', () => {
    assert.equal(PORTAL_DISCOUNT_ORG_ID, 5, 'LUXANGMBH');
    assert.equal(PORTAL_DISCOUNT_START_DATE, '2026-09-09');
    assert.equal(PORTAL_DISCOUNT_PERCENT, 1);
});

test('uprawnienie dyskwalifikuje KAŻDE zamówienie sprzed progu, nie tylko wysłane', async () => {
    // To nagroda dla NOWYCH klientów: jakikolwiek ślad aktywności przed progiem
    // (nawet porzucony szkic) wyklucza. Kryterium „tylko wysłane" dawało 1366
    // uprawnionych z 1385, czyli rabat dla 99% organizacji — nie o to chodziło.
    const select = fakeSelect([[{ id: 42 }]]);
    assert.equal(await isEligibleUser(42, { select }), true);

    const { sql, params } = select.wywolania[0];
    assert.match(sql, /created_date < \?/, 'liczy się data UTWORZENIA zamówienia');
    assert.doesNotMatch(sql, /sent_date/, 'sam brak wysyłki nie może uratować uprawnienia');
    assert.deepEqual(params, [42, PORTAL_DISCOUNT_ORG_ID, PORTAL_DISCOUNT_START_DATE]);
});

test('klient z jakimkolwiek zamówieniem sprzed progu nie dostaje rabatu', async () => {
    const select = fakeSelect([[]]); // zapytanie nic nie zwraca = nie kwalifikuje się
    assert.equal(await isEligibleUser(7, { select }), false);
});

test('brak użytkownika nie kwalifikuje i nie odpytuje bazy', async () => {
    const select = fakeSelect([]);
    assert.equal(await isEligibleUser(null, { select }), false);
    assert.equal(select.wywolania.length, 0);
});

test('błąd bazy nie blokuje formularza — brak rabatu, bez wyjątku', async () => {
    // ⚠️ Logger wstrzykiwany, nie podmieniany globalnie: serwis destrukturyzuje
    // `log` przy require, więc nadpisanie `logging.log` nic nie daje — a bez
    // wyciszenia ten test zaśmieca WSPÓLNY log środowiska (`config.logsDir`,
    // tu /mnt/eform/log/datadev) wpisem „baza padła", wyglądającym jak awaria.
    const wpisy = [];
    const select = fakeSelect([new Error('baza padła')]);
    assert.equal(await isEligibleUser(1, { select, log: (...a) => wpisy.push(a) }), false);
    assert.equal(wpisy.length, 1, 'błąd powinien zostać zalogowany, tylko nie do pliku');
});

test('zamówienie uprawnionego klienta dostaje 1 punkt procentowy', async () => {
    const select = fakeSelect([
        [{ user_id: 42 }],   // właściciel zamówienia
        [{ id: 42 }]         // kwalifikuje się
    ]);
    assert.equal(await resolvePortalDiscountForOrder(900, { select }), 1);
});

test('zamówienie klienta spoza reguły dostaje 0', async () => {
    const select = fakeSelect([[{ user_id: 8 }], []]);
    assert.equal(await resolvePortalDiscountForOrder(900, { select }), 0);
});

test('rabaty się SUMUJĄ w punktach procentowych, w jednym torze liczenia', async () => {
    // 15% rabatu klienta + 1% za serwis = 16% — jeden procent, jedno odliczenie.
    const select = fakeSelect([[{ user_id: 42 }], [{ id: 42 }]]);
    const wynik = await resolveCombinedDiscountForOrder(900, { select, resolveBase: async () => 15 });
    assert.deepEqual(wynik, { total: 16, base: 15, portalBonus: 1 });
});

test('bez rabatu klienta zostaje sam 1% za serwis', async () => {
    const select = fakeSelect([[{ user_id: 42 }], [{ id: 42 }]]);
    const wynik = await resolveCombinedDiscountForOrder(900, { select, resolveBase: async () => 0 });
    assert.deepEqual(wynik, { total: 1, base: 0, portalBonus: 1 });
});

test('suma rabatów nie przekracza 100%', async () => {
    const select = fakeSelect([[{ user_id: 42 }], [{ id: 42 }]]);
    const wynik = await resolveCombinedDiscountForOrder(900, { select, resolveBase: async () => 100 });
    assert.equal(wynik.total, 100);
});
