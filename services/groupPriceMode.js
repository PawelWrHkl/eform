/**
 * Sposób wyceny klientów grupy typu `client` (`user.group_price_mode`).
 *
 * O trybie decyduje ADMIN (/admin/users), osobno dla każdej grupy:
 *  • `discount` (domyślny, dotychczasowe zachowanie) — konto podrzędne widzi
 *    ceny `SUB___` z rabatem `group_user.discount_percent`
 *    (services/groupDiscount.js),
 *  • `markup` — konto podrzędne widzi ceny ZWYKŁE (cenę zakupu grupy-matki)
 *    powiększone o narzut `group_user.markup_percent`. Rabat klienta wtedy NIE
 *    obowiązuje.
 *
 * ⚠️ Narzut nie tworzy nowej warstwy cen. Ceną klienta jest zawsze łańcuch
 * `SUB___*` (patrz PROJECT_OVERVIEW: „SUB___ to ZAWSZE cena klienta"), więc w
 * trybie narzutu formularz pozycji przepisuje do niego ceny zwykłe × (1 + narzut)
 * (`public/scripts/formTools/pricesCalculator.js` → `applyClientMarkup`). Dzięki
 * temu podgląd zamówienia, sumy, PDF, mail i faktura działają bez zmian — czytają
 * `SUB___` tak jak dotąd.
 *
 * ⚠️ Tryb i narzut czyta się z konta podrzędnego przypisanego do ZAMÓWIENIA
 * (`order.group_user_id`), a nie z sesji — ta sama zasada co przy rabacie:
 * pozycję konfiguruje raz klient, raz grupa w jego kontekście, a cena ma wyjść
 * identyczna.
 *
 * ⚠️ Kolumny dochodzą migracją `migrations/add_group_price_mode.sql`. Wszystkie
 * zapytania tego modułu są OSOBNE (nie dopisane do istniejących SELECT-ów):
 * `selectQuery` połyka błąd i zwraca `false`, więc przed migracją nieznana
 * kolumna wywróciłaby panel grupy albo naliczanie rabatu. Tak brak kolumny
 * znaczy po prostu „tryb rabatowy, narzut 0" — czyli zachowanie sprzed zmiany.
 */

'use strict';

const { selectQuery, updateQuery } = require('../db/core');
const { isClientGroupType } = require('./groupType');
const { log } = require('../utils/logging');

const PRICE_MODE_DISCOUNT = 'discount';
const PRICE_MODE_MARKUP = 'markup';

/** Narzut nie ma naturalnej górnej granicy jak rabat (100%) — to zapora na literówkę. */
const MAX_MARKUP_PERCENT = 1000;

const PRICE_MODE_OPTIONS = [
    { value: PRICE_MODE_DISCOUNT, label: 'Rabat od cen detalicznych (SUB___)' },
    { value: PRICE_MODE_MARKUP, label: 'Narzut na ceny zwykłe' }
];

/** Puste/nieznane = `discount`, bo istniejące grupy nie mogą zmienić wyceny przez brak wartości. */
function normalizePriceMode(value) {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return v === PRICE_MODE_MARKUP ? PRICE_MODE_MARKUP : PRICE_MODE_DISCOUNT;
}

function isMarkupMode(value) {
    return normalizePriceMode(value) === PRICE_MODE_MARKUP;
}

/**
 * Narzut klienta grupy: procent 0–MAX_MARKUP_PERCENT, dwa miejsca po przecinku.
 * Przyjmuje przecinek dziesiętny — jak `normalizeDiscountPercent` w db/group.js.
 */
function normalizeMarkupPercent(value) {
    const num = parseFloat(String(value ?? '').replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.min(MAX_MARKUP_PERCENT, Math.round(num * 100) / 100);
}

/**
 * Tryb wyceny grupy (konto `user` grupy-matki).
 * @returns {Promise<'discount'|'markup'>}
 */
async function getGroupPriceMode(userId, deps = {}) {
    if (!userId) return PRICE_MODE_DISCOUNT;
    const select = deps.select || selectQuery;
    const rows = await select('SELECT group_price_mode FROM `user` WHERE id = ?', [userId]);
    return normalizePriceMode(rows?.[0]?.group_price_mode);
}

/** @returns {Promise<boolean>} `false`, gdy zapis się nie udał (np. przed migracją). */
async function setGroupPriceMode(userId, mode, deps = {}) {
    const update = deps.update || updateQuery;
    const response = await update(
        'UPDATE `user` SET group_price_mode = ? WHERE id = ?',
        [normalizePriceMode(mode), userId]
    );
    return !!response;
}

/** Narzut jednego konta podrzędnego. */
async function getGroupUserMarkup(groupUserId, deps = {}) {
    if (!groupUserId) return 0;
    const select = deps.select || selectQuery;
    const rows = await select('SELECT markup_percent FROM group_user WHERE id = ?', [groupUserId]);
    return normalizeMarkupPercent(rows?.[0]?.markup_percent);
}

/** Narzuty wszystkich kont podrzędnych grupy: `{ [groupUserId]: procent }`. */
async function getGroupUserMarkupsByParentId(parentUserId, deps = {}) {
    if (!parentUserId) return {};
    const select = deps.select || selectQuery;
    const rows = await select('SELECT id, markup_percent FROM group_user WHERE user_id = ?', [parentUserId]);
    const map = {};
    for (const row of rows || []) map[row.id] = normalizeMarkupPercent(row.markup_percent);
    return map;
}

/** @returns {Promise<boolean>} `false`, gdy zapis się nie udał (np. przed migracją). */
async function setGroupUserMarkup(groupUserId, value, deps = {}) {
    const update = deps.update || updateQuery;
    const response = await update(
        'UPDATE group_user SET markup_percent = ? WHERE id = ?',
        [normalizeMarkupPercent(value), groupUserId]
    );
    return !!response;
}

const NO_MARKUP = Object.freeze({ mode: PRICE_MODE_DISCOUNT, markupPercent: 0 });

/**
 * Wycena klienta grupy dla ZAMÓWIENIA: tryb + narzut.
 *
 * Tryb `markup` zwracamy wyłącznie dla zamówienia konta podrzędnego grupy
 * `role = 'group'` i `group_type = 'client'` — przy grupie ze sklepami
 * (np. TCN) albo zwykłym kliencie nic się nie zmienia.
 *
 * @returns {Promise<{mode:'discount'|'markup', markupPercent:number}>}
 */
async function resolveClientPricingForOrder(orderId, deps = {}) {
    if (!orderId) return { ...NO_MARKUP };
    const select = deps.select || selectQuery;
    const zapisz = deps.log || log;
    try {
        const rows = await select(
            `SELECT u.group_price_mode AS mode, u.group_type AS group_type, u.role AS role,
                    gu.markup_percent AS markup
             FROM \`order\` o
             JOIN group_user gu ON gu.id = o.group_user_id
             JOIN \`user\` u ON u.id = gu.user_id
             WHERE o.id = ?`,
            [orderId]
        );
        const row = rows && rows[0];
        if (!row) return { ...NO_MARKUP };
        if (row.role !== 'group' || !isClientGroupType(row.group_type)) return { ...NO_MARKUP };
        if (!isMarkupMode(row.mode)) return { ...NO_MARKUP };
        return { mode: PRICE_MODE_MARKUP, markupPercent: normalizeMarkupPercent(row.markup) };
    } catch (err) {
        // Brak informacji nie może zablokować formularza — tryb rabatowy to
        // zachowanie sprzed zmiany.
        zapisz('[groupPriceMode] nie udało się odczytać trybu wyceny:', err.message);
        return { ...NO_MARKUP };
    }
}

module.exports = {
    PRICE_MODE_DISCOUNT,
    PRICE_MODE_MARKUP,
    PRICE_MODE_OPTIONS,
    MAX_MARKUP_PERCENT,
    normalizePriceMode,
    isMarkupMode,
    normalizeMarkupPercent,
    getGroupPriceMode,
    setGroupPriceMode,
    getGroupUserMarkup,
    getGroupUserMarkupsByParentId,
    setGroupUserMarkup,
    resolveClientPricingForOrder
};
