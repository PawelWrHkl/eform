/**
 * Rabat klienta grupy (`group_user.discount_percent`).
 *
 * Grupa typu `client` (`user.group_type = 'client'`) nadaje rabat pojedynczemu
 * swojemu koncie podrzędnemu; rabat dotyczy zamówień TEGO konta i doliczany jest
 * po przeliczeniu ceny w formularzu pozycji
 * (`public/scripts/formTools/pricesCalculator.js` → `applyClientDiscount`).
 *
 * ⚠️ Rabat liczy się z konta podrzędnego przypisanego do ZAMÓWIENIA
 * (`order.group_user_id`), a nie z sesji: to samo zamówienie konfiguruje raz
 * klient, a raz grupa pracująca w jego kontekście (`services/groupContext.js`)
 * — cena musi w obu przypadkach wyjść identyczna.
 *
 * ⚠️ Tylko `group_type = 'client'`. Dla klasycznej grupy ze sklepami kolumna
 * zostaje zerem i nic nie zmienia — inaczej włączenie tej funkcji cicho
 * przeliczyłoby ceny istniejącym grupom (np. TCN).
 */

const { selectQuery } = require('../db/core');
const { isClientGroupType } = require('./groupType');
const { log } = require('../utils/logging');

/**
 * @param {number|string} orderId
 * @returns {Promise<number>} procent rabatu (0 gdy nie dotyczy)
 */
async function resolveClientDiscountForOrder(orderId) {
    if (!orderId) return 0;
    try {
        const rows = await selectQuery(
            `SELECT gu.discount_percent AS pct, u.group_type AS group_type, u.role AS role
             FROM \`order\` o
             JOIN group_user gu ON gu.id = o.group_user_id
             JOIN \`user\` u ON u.id = gu.user_id
             WHERE o.id = ?`,
            [orderId]
        );
        const row = rows && rows[0];
        if (!row) return 0;
        if (row.role !== 'group' || !isClientGroupType(row.group_type)) return 0;
        const pct = parseFloat(row.pct);
        return Number.isFinite(pct) && pct > 0 ? Math.min(100, pct) : 0;
    } catch (err) {
        // Brak informacji nie może zablokować formularza — bez rabatu wszystko
        // działa jak dotąd.
        log('[groupDiscount] nie udało się odczytać rabatu klienta:', err.message);
        return 0;
    }
}

/** To samo, ale gdy znamy tylko pozycję (edycja pozycji). */
async function resolveClientDiscountForPosition(positionId) {
    if (!positionId) return 0;
    try {
        const rows = await selectQuery('SELECT order_id FROM order_item WHERE id = ?', [positionId]);
        const orderId = rows?.[0]?.order_id;
        return orderId ? resolveClientDiscountForOrder(orderId) : 0;
    } catch (err) {
        log('[groupDiscount] nie udało się odczytać zamówienia pozycji:', err.message);
        return 0;
    }
}

module.exports = { resolveClientDiscountForOrder, resolveClientDiscountForPosition };
