/**
 * Rabat 1% za korzystanie z serwisu — nowi klienci LUXANGMBH.
 *
 * Zasada (ustalona z właścicielem 2026-09-09):
 *  • dotyczy WYŁĄCZNIE organizacji LUXANGMBH (`organization.id = 5`),
 *  • klient jest „nowy”, gdy **nie ma ŻADNEGO zamówienia utworzonego przed
 *    2026-09-09** (`order.created_date`) — ani wysłanego, ani szkicu.
 *
 *    ⚠️ Kryterium zmienione świadomie 2026-09-10. Pierwsza wersja liczyła tylko
 *    zamówienia WYSŁANE, co dawało 1366 uprawnionych z 1385 (99% organizacji) —
 *    bo do puli wchodziło 25 klientów, którzy portalu już używali przed progiem,
 *    tylko nie dokończyli zamówienia. To był rabat dla prawie wszystkich, a ma
 *    być **nagroda dla nowych**, więc każdy ślad aktywności przed progiem
 *    dyskwalifikuje.
 *
 *    ⚠️ `user.first_login_at` NIE nadaje się na kryterium, choć wygląda idealnie:
 *    jest NULL dla 1347 z 1385 klientów tej organizacji, w tym dla klienta ABC,
 *    który realnie złożył zamówienie 10.09 — bo zamówienia składa grupa
 *    pracująca w kontekście klienta (`services/groupContext.js`), więc konto
 *    klienta nigdy się nie loguje.
 *
 *    ⚠️ Liczba „uprawnionych” (1341) to konta, które MOGŁYBY dostać rabat, nie
 *    ci, którzy go dostają: 1340 z nich nigdy nic nie zamówiło. Rabat
 *    materializuje się dopiero przy zamówieniu — a wtedy jest to faktycznie
 *    pierwsze zamówienie tego klienta, po progu.
 *  • uprawnionemu klientowi rabat należy się do KAŻDEGO zamówienia, nie tylko
 *    pierwszego.
 *
 * Jak łączy się z rabatem klienta grupy (`services/groupDiscount.js`):
 * **doliczamy punkt procentowy** do istniejącego rabatu (15% → 16%) i całość
 * idzie jednym torem liczenia — `window.clientDiscountPercent`. Dzięki temu nie
 * powstaje drugi, równoległy mechanizm rabatowy, który trzeba by utrzymywać
 * i który mógłby naliczyć się podwójnie.
 *
 * ⚠️ Osobno od liczenia: `pricesCalculator.applyClientDiscount()` dokłada
 * WIDOCZNY wiersz informacyjny z tłumaczonym opisem (`form.portal_usage_discount_label`),
 * bo sam rabat klienta jest ukryty pod kłódką, a ten 1% ma być widoczny.
 * Wiersz jest informacją o składniku, nie drugim odliczeniem — kwota schodzi
 * raz, w połączonym procencie.
 */

'use strict';

const { selectQuery } = require('../db/core');
const { log } = require('../utils/logging');
const { resolveClientDiscountForOrder, resolveClientDiscountForPosition } = require('./groupDiscount');
const { isEnabled: isDiscountSwitchEnabled } = require('./portalUsageDiscountSwitch');

/** Organizacja objęta rabatem (LUXANGMBH). */
const PORTAL_DISCOUNT_ORG_ID = 5;
/** Od tego dnia liczy się „zaczął zamawiać”. */
const PORTAL_DISCOUNT_START_DATE = '2026-09-09';
/** Ile punktów procentowych dokładamy. */
const PORTAL_DISCOUNT_PERCENT = 1;

/**
 * Czy TEN użytkownik jest nowym klientem LUXANGMBH.
 *
 * Jedno miejsce z regułą — zmiana progu albo kryterium (wysłane/utworzone)
 * dotyka wyłącznie tej funkcji.
 *
 * @param {number|string} userId
 * @returns {Promise<boolean>}
 */
async function isEligibleUser(userId, deps = {}) {
    if (!userId) return false;
    const select = deps.select || selectQuery;
    // Logger też przez `deps`: modul destrukturyzuje `log` przy require, wiec
    // podmiana `logging.log` z zewnatrz nic by nie dala — a test bledu bazy
    // zasmiecalby wspolny log srodowiska (config.logsDir).
    const zapisz = deps.log || log;
    try {
        const rows = await select(
            `SELECT u.id
               FROM \`user\` u
              WHERE u.id = ?
                AND u.organization_id = ?
                AND NOT EXISTS (
                      SELECT 1 FROM \`order\` o
                       WHERE o.user_id = u.id
                         AND o.created_date < ?
                    )`,
            [userId, PORTAL_DISCOUNT_ORG_ID, PORTAL_DISCOUNT_START_DATE]
        );
        return !!(rows && rows.length);
    } catch (err) {
        // Brak informacji nie może zablokować formularza ani wysyłki — bez
        // rabatu wszystko działa jak dotąd.
        zapisz('[portalUsageDiscount] nie udało się sprawdzić uprawnienia:', err.message);
        return false;
    }
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
 * @returns {Promise<number>} 1 albo 0 (punkty procentowe)
 */
async function resolvePortalDiscountForOrder(orderId, deps = {}) {
    // Jedyne miejsce, w którym rodzi się ten punkt procentowy — i dlatego jedyne,
    // w którym pyta się o przełącznik admina. `resolvePortalDiscountForPosition`
    // i `resolveCombined*` idą tędy, więc wyłączenie gasi rabat wszędzie:
    // w formularzu, na ekranie edycji pozycji, w wycenie i na wydrukach.
    //
    // `isEligibleUser()` zostaje CZYSTE — odpowiada na pytanie „czy ten klient
    // spełnia regułę", które jest faktem o danych i nie zależy od tego, czy
    // akurat rozdajemy rabat. Wmieszanie przełącznika tam zafałszowałoby też
    // raporty i testy uprawnienia.
    const switchEnabled = deps.isSwitchEnabled ? deps.isSwitchEnabled() : isDiscountSwitchEnabled();
    if (!switchEnabled) return 0;

    const userId = await getOrderUserId(orderId, deps);
    return (await isEligibleUser(userId, deps)) ? PORTAL_DISCOUNT_PERCENT : 0;
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
 * 1% za korzystanie z serwisu.
 *
 * Zwraca też składniki, żeby formularz mógł pokazać osobny, widoczny wiersz o
 * 1% — samo `total` nie niesie informacji, z czego się składa.
 *
 * @returns {Promise<{total:number, base:number, portalBonus:number}>}
 */
async function resolveCombinedDiscountForOrder(orderId, deps = {}) {
    const base = deps.resolveBase
        ? await deps.resolveBase(orderId)
        : await resolveClientDiscountForOrder(orderId);
    const portalBonus = await resolvePortalDiscountForOrder(orderId, deps);
    return { total: Math.min(100, base + portalBonus), base, portalBonus };
}

/** Wariant dla ekranu edycji pozycji. */
async function resolveCombinedDiscountForPosition(positionId, deps = {}) {
    const base = deps.resolveBase
        ? await deps.resolveBase(positionId)
        : await resolveClientDiscountForPosition(positionId);
    const portalBonus = await resolvePortalDiscountForPosition(positionId, deps);
    return { total: Math.min(100, base + portalBonus), base, portalBonus };
}

module.exports = {
    isEligibleUser,
    resolvePortalDiscountForOrder,
    resolvePortalDiscountForPosition,
    resolveCombinedDiscountForOrder,
    resolveCombinedDiscountForPosition,
    PORTAL_DISCOUNT_ORG_ID,
    PORTAL_DISCOUNT_START_DATE,
    PORTAL_DISCOUNT_PERCENT
};
