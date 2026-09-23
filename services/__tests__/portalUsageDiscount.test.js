'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    getUserExtraDiscount,
    normalizeExtraDiscount,
    isEligibleUser,
    resolvePortalDiscountForOrder,
    resolvePortalDiscountForPosition,
    resolveCombinedDiscountForOrder,
    EXTRA_DISCOUNT_COLUMN,
    MAX_EXTRA_DISCOUNT_PERCENT
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

test('rabat czyta się z kolumny `user.extra_rabat` i z niczego więcej', async () => {
    // Do 2026-09-22 wysokość rabatu wynikała z reguły (organizacja 5 + brak
    // zamówień przed 2026-09-09 → stałe 1%). Teraz decyduje wyłącznie wpis
    // w bazie, więc zapytanie NIE MA prawa pytać o organizację ani o daty —
    // gdyby pytało, wróciłby stary, ukryty warunek.
    assert.equal(EXTRA_DISCOUNT_COLUMN, 'extra_rabat');

    const select = fakeSelect([[{ extra_rabat: '2.50' }]]);
    assert.equal(await getUserExtraDiscount(42, { select }), 2.5);

    const { sql, params } = select.wywolania[0];
    assert.match(sql, /extra_rabat/);
    assert.doesNotMatch(sql, /organization_id/, 'rabat nie zależy już od organizacji');
    assert.doesNotMatch(sql, /created_date|sent_date/, 'ani od historii zamówień');
    assert.deepEqual(params, [42]);
});

test('DECIMAL wraca ze sterownika jako STRING — musi zostać liczbą', async () => {
    // ⚠️ Bez `Number()` doliczenie skleiłoby tekst: 15 + '1.00' = '151.00'.
    const select = fakeSelect([[{ user_id: 42 }], [{ extra_rabat: '1.00' }]]);
    const wynik = await resolveCombinedDiscountForOrder(900, { select, resolveBase: async () => 15 });

    assert.deepEqual(wynik, { total: 16, base: 15, portalBonus: 1 });
    assert.strictEqual(typeof wynik.portalBonus, 'number');
});

test('brak wpisu, zero, NULL, ujemna i śmieć znaczą „bez rabatu"', async () => {
    for (const wartosc of [undefined, null, 0, '0.00', -5, 'abc']) {
        const select = fakeSelect([[{ extra_rabat: wartosc }]]);
        assert.equal(await getUserExtraDiscount(1, { select }), 0, `wartość ${JSON.stringify(wartosc)}`);
    }
    // Użytkownik, którego nie ma w bazie — zapytanie nic nie zwraca.
    assert.equal(await getUserExtraDiscount(1, { select: fakeSelect([[]]) }), 0);
});

test('błędny wpis nie zje całej ceny — rabat przycięty do 100', () => {
    assert.equal(normalizeExtraDiscount('999.99'), MAX_EXTRA_DISCOUNT_PERCENT);
    assert.equal(normalizeExtraDiscount(100), 100);
});

test('brak użytkownika nie kwalifikuje i nie odpytuje bazy', async () => {
    const select = fakeSelect([]);
    assert.equal(await getUserExtraDiscount(null, { select }), 0);
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
    assert.equal(await getUserExtraDiscount(1, { select, log: (...a) => wpisy.push(a) }), 0);
    assert.equal(wpisy.length, 1, 'błąd powinien zostać zalogowany, tylko nie do pliku');
});

test('`isEligibleUser` to predykat nad tą samą wartością', async () => {
    assert.equal(await isEligibleUser(42, { select: fakeSelect([[{ extra_rabat: '1.00' }]]) }), true);
    assert.equal(await isEligibleUser(42, { select: fakeSelect([[{ extra_rabat: '0.00' }]]) }), false);
});

test('zamówienie klienta z rabatem dostaje jego punkty procentowe', async () => {
    const select = fakeSelect([
        [{ user_id: 42 }],            // właściciel zamówienia
        [{ extra_rabat: '1.00' }]     // ile ma przyznane
    ]);
    assert.equal(await resolvePortalDiscountForOrder(900, { select }), 1);
});

test('zamówienie klienta bez wpisu dostaje 0', async () => {
    const select = fakeSelect([[{ user_id: 8 }], [{ extra_rabat: '0.00' }]]);
    assert.equal(await resolvePortalDiscountForOrder(900, { select }), 0);
});

test('ekran edycji pozycji idzie tą samą drogą, przez zamówienie', async () => {
    const select = fakeSelect([
        [{ order_id: 900 }],
        [{ user_id: 42 }],
        [{ extra_rabat: '1.00' }]
    ]);
    assert.equal(await resolvePortalDiscountForPosition(7302, { select }), 1);
});

test('rabaty się SUMUJĄ w punktach procentowych, w jednym torze liczenia', async () => {
    // 15% rabatu klienta + 1% ekstra = 16% — jeden procent, jedno odliczenie.
    const select = fakeSelect([[{ user_id: 42 }], [{ extra_rabat: '1.00' }]]);
    const wynik = await resolveCombinedDiscountForOrder(900, { select, resolveBase: async () => 15 });
    assert.deepEqual(wynik, { total: 16, base: 15, portalBonus: 1 });
});

test('bez rabatu klienta zostaje sam ekstra rabat — także ułamkowy', async () => {
    const select = fakeSelect([[{ user_id: 42 }], [{ extra_rabat: '2.50' }]]);
    const wynik = await resolveCombinedDiscountForOrder(900, { select, resolveBase: async () => 0 });
    assert.deepEqual(wynik, { total: 2.5, base: 0, portalBonus: 2.5 });
});

test('suma NIE jest przycinana do 100 — inaczej rabat klienta traciłby punkt', async () => {
    // ⚠️ Od 2026-09-22 rabaty składają się przez MNOŻENIE: front odzyskuje rabat
    // klienta jako `total − portalBonus`. Przycięcie 101 do 100 zrobiłoby ze
    // 100-procentowego rabatu klienta 99% — czyli cenę zamiast zera. Ujemna cena
    // i tak nie powstanie, `pricesCalculator` trzyma ją na zerze.
    const select = fakeSelect([[{ user_id: 42 }], [{ extra_rabat: '1.00' }]]);
    const wynik = await resolveCombinedDiscountForOrder(900, { select, resolveBase: async () => 100 });

    assert.deepEqual(wynik, { total: 101, base: 100, portalBonus: 1 });
});

// ── Przełącznik admina (services/portalUsageDiscountSwitch.js) ───────────────
// Wstrzykiwany przez `deps`, tak samo jak baza i logger — inaczej test zależałby
// od pliku stanu w `dataDir` wspólnym dla środowiska.

test('wyłączony przełącznik gasi rabat, nie pytając nawet bazy', async () => {
    const select = fakeSelect([]);
    const percent = await resolvePortalDiscountForOrder(1, { select, isSwitchEnabled: () => false });

    assert.strictEqual(percent, 0);
    assert.strictEqual(select.wywolania.length, 0, 'skoro rabatu nie ma, nie ma po co odpytywać bazy');
});

test('wyłączony przełącznik zostawia sam rabat klienta grupy', async () => {
    const { total, base, portalBonus } = await resolveCombinedDiscountForOrder(1, {
        select: fakeSelect([]),
        resolveBase: async () => 15,
        isSwitchEnabled: () => false
    });

    assert.strictEqual(portalBonus, 0);
    assert.strictEqual(base, 15);
    assert.strictEqual(total, 15, 'rabat klienta musi zostać nietknięty');
});

test('włączony przełącznik zachowuje się jak dotąd', async () => {
    const select = fakeSelect([[{ user_id: 42 }], [{ extra_rabat: '1.00' }]]);
    const percent = await resolvePortalDiscountForOrder(1, { select, isSwitchEnabled: () => true });

    assert.strictEqual(percent, 1);
});

// Przełącznik mówi „czy rozdajemy rabat", a nie „ile klient ma przyznane".
// Zmieszanie tych dwóch rzeczy zafałszowałoby raporty uprawnionych.
test('przełącznik NIE dotyka samego wpisu klienta', async () => {
    const select = fakeSelect([[{ extra_rabat: '1.00' }]]);
    assert.strictEqual(await getUserExtraDiscount(42, { select, isSwitchEnabled: () => false }), 1);
});
