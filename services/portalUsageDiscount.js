/**
 * Dodatkowy rabat klienta („ekstra rabat") — doliczany punkt procentowy.
 *
 * Zasada (ustalona z właścicielem 2026-09-22):
 *  • wysokość rabatu bierze się WYŁĄCZNIE z kolumny `user.extra_rabat`
 *    (punkty procentowe: `1.00` = 1%, `2.50` = 2,5%),
 *  • rabat dostaje każdy klient z wartością > 0 — niezależnie od organizacji
 *    i historii zamówień,
 *  • uprawnionemu klientowi rabat należy się do KAŻDEGO zamówienia, nie tylko
 *    pierwszego.
 *
 * ⚠️ Reguła wyliczana z danych ZNIKŁA (do 2026-09-22: organizacja LUXANGMBH
 * `organization.id = 5` + brak zamówień utworzonych przed 2026-09-09 → stałe
 * 1%). Nie ma jej już nigdzie w kodzie: kto ma rabat i jak duży, decyduje wpis
 * w bazie. Dzięki temu rabat można nadać pojedynczemu klientowi dowolnej marki
 * i w dowolnej wysokości, bez zmiany kodu i bez wdrożenia.
 *
 * ⚠️ Kolumna wystartowała PUSTA (0.00) dla wszystkich — patrz
 * `migration_user_extra_rabat.sql`. Klienci, którzy dostawali 1% ze starej
 * reguły, tracą go do czasu ręcznego wpisania wartości.
 *
 * Jak łączy się z rabatem klienta grupy (`services/groupDiscount.js`):
 * **doliczamy punkty procentowe** do istniejącego rabatu (15% → 16%) i całość
 * idzie jednym torem liczenia — `window.clientDiscountPercent`. Dzięki temu nie
 * powstaje drugi, równoległy mechanizm rabatowy, który trzeba by utrzymywać
 * i który mógłby naliczyć się podwójnie.
 *
 * ⚠️ Osobno od liczenia: `pricesCalculator.applyClientDiscount()` dokłada
 * WIDOCZNY wiersz informacyjny z tłumaczonym opisem (`form.portal_usage_discount_label`),
 * bo sam rabat klienta jest ukryty pod kłódką, a ten dodatkowy ma być widoczny.
 * Wiersz jest informacją o składniku, nie drugim odliczeniem — kwota schodzi
 * raz, w połączonym procencie.
 */

'use strict';

const { selectQuery } = require('../db/core');
const { log } = require('../utils/logging');
const { resolveClientDiscountForOrder, resolveClientDiscountForPosition } = require('./groupDiscount');
const { isEnabled: isDiscountSwitchEnabled } = require('./portalUsageDiscountSwitch');

/** Kolumna niosąca wysokość rabatu (punkty procentowe). */
const EXTRA_DISCOUNT_COLUMN = 'extra_rabat';
/** Rabat nie może zjeść więcej niż całość ceny. */
const MAX_EXTRA_DISCOUNT_PERCENT = 100;

/**
 * Surowa wartość z bazy → punkty procentowe do liczenia.
 *
 * ⚠️ `DECIMAL` wraca ze sterownika jako STRING ('1.00'), więc bez `Number()`
 * doliczenie skleiłoby tekst zamiast dodać liczbę. NULL, śmieć i wartość ujemna
 * znaczą „brak rabatu" — błędny wpis ma nie naliczyć nic, a nie wywrócić
 * wycenę.
 *
 * @param {unknown} raw
 * @returns {number}
 */
function normalizeExtraDiscount(raw) {
    const percent = Number(raw);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    return Math.min(MAX_EXTRA_DISCOUNT_PERCENT, percent);
}

/**
 * Ile punktów procentowych ekstra rabatu ma TEN użytkownik.
 *
 * Jedno miejsce, w którym czyta się kolumnę — zmiana jednostki albo nazwy pola
 * dotyka wyłącznie tej funkcji.
 *
 * @param {number|string} userId
 * @returns {Promise<number>} 0, gdy klient rabatu nie ma
 */
async function getUserExtraDiscount(userId, deps = {}) {
    if (!userId) return 0;
    const select = deps.select || selectQuery;
    // Logger też przez `deps`: modul destrukturyzuje `log` przy require, wiec
    // podmiana `logging.log` z zewnatrz nic by nie dala — a test bledu bazy
    // zasmiecalby wspolny log srodowiska (config.logsDir).
    const zapisz = deps.log || log;
    try {
        const rows = await select(
            `SELECT \`${EXTRA_DISCOUNT_COLUMN}\` AS extra_rabat FROM \`user\` WHERE id = ?`,
            [userId]
        );
        return normalizeExtraDiscount(rows?.[0]?.extra_rabat);
    } catch (err) {
        // Brak informacji nie może zablokować formularza ani wysyłki — bez
        // rabatu wszystko działa jak dotąd.
        zapisz('[portalUsageDiscount] nie udało się odczytać ekstra rabatu:', err.message);
        return 0;
    }
}

/**
 * Czy TEN użytkownik ma ekstra rabat.
 *
 * Predykat nad `getUserExtraDiscount()` — zostaje, bo pytanie „czy klient jest
 * objęty rabatem" pada osobno od pytania „ile".
 *
 * @param {number|string} userId
 * @returns {Promise<boolean>}
 */
async function isEligibleUser(userId, deps = {}) {
    return (await getUserExtraDiscount(userId, deps)) > 0;
}

/** Właściciel zamówienia. */
async function getOrderUserId(orderId, deps = {}) {
    if (!orderId) return null;
    const select = deps.select || selectQuery;
    const zapisz = deps.log || log;
    try {
        const rows = await select('SELECT user_id FROM `order` WHERE id = ?', [orderId]);
        return rows?.[0]?.user_id ?? null;
    } catch (err) {
        zapisz('[portalUsageDiscount] nie udało się odczytać właściciela zamówienia:', err.message);
        return null;
    }
}

/**
 * @param {number|string} orderId
 * @returns {Promise<number>} punkty procentowe z `user.extra_rabat` albo 0
 */
async function resolvePortalDiscountForOrder(orderId, deps = {}) {
    // Jedyne miejsce, w którym rodzą się te punkty procentowe — i dlatego jedyne,
    // w którym pyta się o przełącznik admina. `resolvePortalDiscountForPosition`
    // i `resolveCombined*` idą tędy, więc wyłączenie gasi rabat wszędzie:
    // w formularzu, na ekranie edycji pozycji, w wycenie i na wydrukach.
    //
    // `getUserExtraDiscount()` zostaje CZYSTE — odpowiada na pytanie „ile ma
    // wpisane ten klient", które jest faktem o danych i nie zależy od tego, czy
    // akurat rozdajemy rabat. Wmieszanie przełącznika tam zafałszowałoby też
    // raporty i testy uprawnienia.
    const switchEnabled = deps.isSwitchEnabled ? deps.isSwitchEnabled() : isDiscountSwitchEnabled();
    if (!switchEnabled) return 0;

    const userId = await getOrderUserId(orderId, deps);
    return getUserExtraDiscount(userId, deps);
}

/** To samo, gdy znamy tylko pozycję (edycja pozycji). */
async function resolvePortalDiscountForPosition(positionId, deps = {}) {
    if (!positionId) return 0;
    const select = deps.select || selectQuery;
    const zapisz = deps.log || log;
    try {
        const rows = await select('SELECT order_id FROM order_item WHERE id = ?', [positionId]);
        const orderId = rows?.[0]?.order_id;
        return orderId ? resolvePortalDiscountForOrder(orderId, deps) : 0;
    } catch (err) {
        zapisz('[portalUsageDiscount] nie udało się odczytać zamówienia pozycji:', err.message);
        return 0;
    }
}

/**
 * Rabat łączny do wstrzyknięcia w formularz: rabat klienta grupy + ewentualny
 * ekstra rabat z `user.extra_rabat`.
 *
 * Zwraca też składniki, żeby formularz mógł pokazać osobny, widoczny wiersz o
 * ekstra rabacie — samo `total` nie niesie informacji, z czego się składa.
 *
 * ⚠️ `total` NIE jest przycinany do 100. Front odzyskuje z niego rabat klienta
 * (`total − portalBonus`), a od 2026-09-22 rabaty składają się przez MNOŻENIE,
 * nie dodawanie — przycięcie 101 do 100 zabierałoby po cichu punkt procentowy
 * rabatowi klienta (100% → 99%, czyli cena zamiast zera). Ujemna cena i tak nie
 * powstanie: `pricesCalculator` trzyma ją na zerze.
 *
 * @returns {Promise<{total:number, base:number, portalBonus:number}>}
 */
async function resolveCombinedDiscountForOrder(orderId, deps = {}) {
    const base = deps.resolveBase
        ? await deps.resolveBase(orderId)
        : await resolveClientDiscountForOrder(orderId);
    const portalBonus = await resolvePortalDiscountForOrder(orderId, deps);
    return { total: base + portalBonus, base, portalBonus };
}

/** Wariant dla ekranu edycji pozycji. */
async function resolveCombinedDiscountForPosition(positionId, deps = {}) {
    const base = deps.resolveBase
        ? await deps.resolveBase(positionId)
        : await resolveClientDiscountForPosition(positionId);
    const portalBonus = await resolvePortalDiscountForPosition(positionId, deps);
    return { total: base + portalBonus, base, portalBonus };
}

module.exports = {
    getUserExtraDiscount,
    normalizeExtraDiscount,
    isEligibleUser,
    resolvePortalDiscountForOrder,
    resolvePortalDiscountForPosition,
    resolveCombinedDiscountForOrder,
    resolveCombinedDiscountForPosition,
    EXTRA_DISCOUNT_COLUMN,
    MAX_EXTRA_DISCOUNT_PERCENT
};
