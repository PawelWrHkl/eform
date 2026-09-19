const ELECTRIC_EXTRA_DAYS = 5;
// Coupon ("kupon") fabrics have no real production lead time yet, so we show a
// fixed estimate until the actual time comes back from production.
const COUPON_PRODUCTION_DAYS = 14;
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/db_helper');
const { selectQuery } = require('../db/core');
const orderService = require('./orderService');

// Coupon fabrics are flagged in the KOLOR attribute file (the same source the
// form uses): a material whose INFO column contains "KUPON". This is the
// authoritative signal, so coupon detection works for existing positions too
// (independent of any client-side flag). Cached and refreshed on file change.
const KOLOR_ATTR_FILE = path.join(config.dataDir, 'data', 'paramdictattr-KOLOR-!storage!.txt');
let _couponCache = { mtimeMs: -1, set: new Set() };

function getCouponMaterials() {
    try {
        const stat = fs.statSync(KOLOR_ATTR_FILE);
        if (stat.mtimeMs === _couponCache.mtimeMs) return _couponCache.set;
        const raw = fs.readFileSync(KOLOR_ATTR_FILE, 'utf8');
        const set = new Set();
        const lines = raw.split(/\r?\n/);
        // line 0 is the header (MATERIAŁ / STAN / INFO)
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols.length < 3) continue;
            const material = (cols[0] || '').trim();
            const info = cols[2] || '';
            if (material && /KUPON/i.test(info)) set.add(material.toUpperCase());
        }
        _couponCache = { mtimeMs: stat.mtimeMs, set };
        return set;
    } catch (err) {
        return _couponCache.set;
    }
}

function normalizeMaterial(value) {
    return String(value == null ? '' : value).trim().replace(/~\d+$/, '').toUpperCase();
}

function isCoupon(jsonParams) {
    if (!jsonParams) return false;

    // 1) Explicit client flag (set by the form when a coupon fabric is picked).
    const flag = jsonParams.IS_KUPON;
    if (flag === '1' || flag === 1 || flag === true || String(flag).toLowerCase() === 'true') {
        return true;
    }

    // 2) Authoritative: the chosen KOLOR material is flagged "KUPON" in the
    //    attribute file. Handles pipe-separated multi-values and ~N suffixes.
    const kolor = jsonParams.KOLOR;
    if (!kolor) return false;
    const couponMaterials = getCouponMaterials();
    if (couponMaterials.size === 0) return false;
    return String(kolor).split('|').some((part) => couponMaterials.has(normalizeMaterial(part)));
}

function isElectric(jsonParams) {
    if (!jsonParams) return false;
    if (jsonParams.MOTOR && String(jsonParams.MOTOR).trim() !== '') return true;
    if (jsonParams.STEROWANIE_ELEKTRYCZNE && String(jsonParams.STEROWANIE_ELEKTRYCZNE).trim() !== '') return true;
    if (String(jsonParams.STEROWANIE).toUpperCase() === 'EL') return true;
    return false;
}

function isSlope(jsonParams) {
    if (!jsonParams) return false;
    if (jsonParams.WYMIAROWANIE_SLOPOW___VISIBLE === true) return true;
    const dodatki = String(jsonParams.DODATKI___DESCRIPTION || '').toUpperCase();
    return dodatki.includes('SLOPE') || dodatki.includes('SCHRÄG');
}

function computeItemProductionDays(item, productionTimes) {
    const jp = item.json_parameters || {};

    // Coupon fabric overrides the normal group/electric calculation with a fixed
    // 14-day estimate (placeholder until production returns the real lead time).
    if (isCoupon(jp)) {
        return COUPON_PRODUCTION_DAYS;
    }

    const groupData = productionTimes[item.asortment_group_number];
    if (!groupData) return null;

    let days = isSlope(jp) && groupData.slopeDays != null
        ? groupData.slopeDays
        : groupData.days;
    if (isElectric(jp)) {
        days += ELECTRIC_EXTRA_DAYS;
    }

    return days;
}

/**
 * Normalizuje `user.delivery_delay` do liczby dni.
 *
 * @param {number|string|null|undefined} value kolumna `user.delivery_delay` (int)
 * @returns {number} 0, gdy brak wartości albo wartość nienumeryczna
 */
function resolveDeliveryDelay(value) {
    const dni = Number(value);
    return Number.isFinite(dni) ? dni : 0;
}

/**
 * Dokłada indywidualne opóźnienie dostawy klienta do wyliczonych dni produkcji.
 *
 * ⚠️ Dotyczy WYŁĄCZNIE terminów liczonych z bazy (czasy grup asortymentowych
 * z `getGroupDeliveryTimes`). Statusy i daty pochodzące z `status.txt` są
 * faktami z produkcji — tam nic nie dodajemy. W widokach oba źródła są
 * rozdzielone: szacunek z bazy pokazuje się tylko, gdy nie ma jeszcze
 * `order.prod_status` (patrz `templates/orders_history.njk`).
 *
 * @param {number|null} days     wyliczone dni albo `null` (brak danych grupy)
 * @param {number} deliveryDelay dni z `user.delivery_delay`
 * @returns {number|null}
 */
function applyDeliveryDelay(days, deliveryDelay) {
    const dni = resolveDeliveryDelay(deliveryDelay);
    // Brak wyliczenia zostaje brakiem — bez opóźnienia nie zmyślamy terminu
    if (days == null || dni === 0) return days;
    // Nigdy poniżej zera, choćby kolumna zawierała wartość ujemną
    return Math.max(0, days + dni);
}

/**
 * Opóźnienie dostawy WŁAŚCICIELA zamówienia.
 * Liczy się właściciel, nie osoba przeglądająca — termin dotyczy jego dostawy.
 *
 * @param {number|string} orderId
 * @returns {Promise<number>}
 */
async function getOrderDeliveryDelay(orderId) {
    if (!orderId) return 0;
    try {
        const rows = await selectQuery(
            'SELECT u.delivery_delay FROM `order` o JOIN `user` u ON u.id = o.user_id WHERE o.id = ?',
            [orderId]
        );
        return resolveDeliveryDelay(rows && rows[0] && rows[0].delivery_delay);
    } catch (err) {
        console.error('getOrderDeliveryDelay error:', err.message);
        return 0;
    }
}

/**
 * @param {Array} cleanOrderItems
 * @param {Record<string, any>} productionTimes czasy grup z bazy
 * @param {number} [deliveryDelay=0] dni z `user.delivery_delay`
 */
function buildItemProductionDays(cleanOrderItems, productionTimes, deliveryDelay = 0) {
    const map = {};
    // RÓWNOLEGŁA mapa ze WSZYSTKIMI pozycjami — także tymi bez wyliczenia
    // (`null`). `itemProductionDays` celowo pomija `null` (szablony robią na nim
    // zwykły lookup), ale zapis do bazy musi wiedzieć o każdej pozycji, żeby
    // wyczyścić nieaktualny termin po zmianie konfiguracji.
    const allItems = {};
    let maxProdDays = 0;
    for (const table of cleanOrderItems) {
        for (const rowObj of table.rows) {
            const days = applyDeliveryDelay(
                computeItemProductionDays(rowObj.item, productionTimes),
                deliveryDelay
            );
            allItems[rowObj.item.id] = days == null ? null : days;
            if (days != null) {
                map[rowObj.item.id] = days;
                if (days > maxProdDays) maxProdDays = days;
            }
        }
    }
    // `maxProdDays` wychodzi już z opóźnieniem, bo każda pozycja je dostała —
    // dodawanie go tu drugi raz podwoiłoby termin.
    return { itemProductionDays: map, maxProdDays, allItemProductionDays: allItems };
}

module.exports = {
    computeItemProductionDays, buildItemProductionDays, ELECTRIC_EXTRA_DAYS, COUPON_PRODUCTION_DAYS,
    isCoupon, recalcAndSaveMaxProdDays,
    applyDeliveryDelay, resolveDeliveryDelay, getOrderDeliveryDelay
};

async function recalcAndSaveMaxProdDays(orderId) {
    try {
        const { orderDetails, orderItems } = await db.getOrderWithItems(orderId);
        if (!orderItems || orderItems.length === 0) {
            await db.updateMaxProdDays(orderId, 0);
            return 0;
        }
        const details = Array.isArray(orderDetails) ? orderDetails[0] : orderDetails;
        const orgId = details?.organization_id;
        const productionTimes = orgId ? await db.getGroupDeliveryTimes(orgId) : {};
        const { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems);
        // ⚠️ Zapisujemy termin JUŻ z opóźnieniem klienta: listy zamówień czytają
        // `order.max_prod_days` wprost z bazy i nie doliczają go ponownie.
        const deliveryDelay = await getOrderDeliveryDelay(orderId);
        const { maxProdDays, allItemProductionDays } = buildItemProductionDays(cleanOrderItems, productionTimes, deliveryDelay);
        await db.updateMaxProdDays(orderId, maxProdDays);
        // Termin per POZYCJA ląduje w `order_item.prod_days` — stąd bierze go JSON
        // zamówienia wysyłany na FTP (`services/sendOrderService.js`, klucz
        // `prod_days`). Liczymy dokładnie tę samą wartość, którą widzi klient
        // w wierszu „Termin produkcji", razem z jego `delivery_delay`.
        await db.updateItemsProdDays(allItemProductionDays);
        return maxProdDays;
    } catch (err) {
        console.error('recalcAndSaveMaxProdDays error:', err);
        return 0;
    }
}
