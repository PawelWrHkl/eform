'use strict';

/**
 * Rabat B2B — owner organizacji spoza HKL daje swojemu klientowi rabat w ofercie
 * (zgłoszenie KK 18.11.2026, decyzje właściciela z tego dnia):
 *  • **procent = punkty doliczane do rabatu z cennika** (`SUB___CENA_RABAT`) każdej
 *    pozycji: 70% + 3 = 73%, 55% + 3 = 58%. Per pozycja, bo cennik tego samego
 *    klienta różni się między grupami (Luxan: od 0% w gr. 73 do 70% u JC);
 *  • **kwota = równy procent pozycji**: przy zapisie zamieniana na procent wartości
 *    zlecenia po rabacie %. Po dodaniu/usunięciu pozycji procent zostaje, okno
 *    pokazuje nową kwotę, a ponowne „Zastosuj” liczy procent od nowa;
 *  • **per zlecenie** (szkic `active`), nadaje owner tej organizacji albo admin;
 *  • zlecenie konta podrzędnego grupy (`group_user_id`) ma rabat grupy — B2B go nie dotyczy.
 *
 * Ceny liczy WYŁĄCZNIE przeglądarka (`pricesCalculator.applyClientDiscount`, globale
 * `b2bDiscountPoints` / `b2bDiscountAmountPercent` z `resolveFormPricingForOrder`).
 * Tu tylko przechowanie, uprawnienia i zamiana kwoty na procent (podstawa:
 * zapisane `order_item.total_price_sub`).
 *
 * Przed migracją `migrations/add_order_b2b_discount.sql` zapytania z nowymi
 * kolumnami padają — `selectQuery` zwraca wtedy `false`, więc wszędzie wychodzi
 * „brak rabatu”, a okno nie pokazuje sekcji B2B.
 */

const HKL_ORG_ID = 3;
const EMPTY = Object.freeze({ points: 0, amount: 0, amountPct: 0 });
const MAX_POINTS = 100;

function resolveDeps(deps = {}) {
    return {
        select: deps.select || ((sql, params) => require('../db/core').selectQuery(sql, params)),
        update: deps.update || ((sql, params) => require('../db/core').updateQuery(sql, params)),
        withTransaction: deps.withTransaction || defaultTransaction,
        log: deps.log || require('../utils/logging').log
    };
}

async function defaultTransaction(fn) {
    const { pool } = require('../db/core');
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(async (sql, params) => {
            const [rows] = await conn.query(sql, params);
            return rows;
        });
        await conn.commit();
        return result;
    } catch (err) {
        try { await conn.rollback(); } catch { /* połączenie mogło już paść */ }
        throw err;
    } finally {
        conn.release();
    }
}

const ORDER_SQL = `SELECT o.id, o.status, o.group_user_id,
        o.b2b_discount_points, o.b2b_discount_amount, o.b2b_discount_amount_pct,
        u.id AS client_id, u.role AS client_role, u.ident AS client_ident,
        u.organization_id AS client_org_id, org.ident AS org_ident
    FROM \`order\` o
    JOIN \`user\` u ON u.id = o.user_id
    LEFT JOIN organization org ON org.id = u.organization_id
    WHERE o.id = ?`;

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};
const round = (v, digits) => parseFloat(Number(v).toFixed(digits));

/** Zwykłe konto organizacji spoza HKL, nie owner, nie grupa i nie zlecenie konta podrzędnego. */
function isEligible(row) {
    if (!row || row.group_user_id) return false;
    const orgId = Number(row.client_org_id);
    if (!orgId || orgId === HKL_ORG_ID) return false;
    if (row.client_role) return false;
    const ident = String(row.client_ident || '').toUpperCase();
    return !!ident && ident !== String(row.org_ident || '').toUpperCase();
}

function valuesOf(row) {
    return {
        points: num(row.b2b_discount_points),
        amount: num(row.b2b_discount_amount),
        amountPct: num(row.b2b_discount_amount_pct)
    };
}

/**
 * Kto może nadać rabat: admin (także w kontekście klienta) albo owner organizacji
 * klienta. ⚠️ `checkOrderOwnership` wpuszcza ownera do KAŻDEGO zlecenia, więc
 * organizację porównujemy tutaj.
 */
function canManage(sessionUser, row) {
    if (!sessionUser || !isEligible(row)) return false;
    if (sessionUser.isStaff || sessionUser.isEmployee || sessionUser.isGroup || sessionUser.isGroupShop) return false;
    if (sessionUser.isAdmin) return true;
    return !!sessionUser.isOwner && Number(sessionUser.orgId) === Number(row.client_org_id);
}

async function loadOrder(orderId, deps) {
    const d = resolveDeps(deps);
    const rows = await d.select(ORDER_SQL, [orderId]);
    return rows && rows[0] ? rows[0] : null;
}

/** Czy pokazać przycisk rabatu B2B (pasek zlecenia po kłódce). Błąd = nie pokazujemy. */
async function canManageOrder(orderId, sessionUser, deps = {}) {
    try {
        return canManage(sessionUser, await loadOrder(orderId, deps));
    } catch (err) {
        resolveDeps(deps).log('[b2bDiscount] sprawdzenie uprawnień nie powiodło się:', err.message);
        return false;
    }
}

/** Wartości rabatu do liczenia cen; zero, gdy zlecenie go nie dotyczy albo baza nie ma kolumn. */
async function resolveForOrder(orderId, deps = {}) {
    if (!orderId) return { ...EMPTY };
    try {
        const row = await loadOrder(orderId, deps);
        return isEligible(row) ? valuesOf(row) : { ...EMPTY };
    } catch (err) {
        resolveDeps(deps).log('[b2bDiscount] odczyt rabatu B2B nie powiódł się:', err.message);
        return { ...EMPTY };
    }
}

/**
 * Znacznik stanu rabatu, z którym formularz pozycji policzył ceny. Zapis pozycji
 * z innym znacznikiem jest odrzucany (routes/positions.js) — inaczej pozycja
 * otwarta w drugiej karcie zapisałaby się ze starym rabatem.
 */
function stampOf(values) {
    const v = values || EMPTY;
    return `${num(v.points)}|${num(v.amountPct)}`;
}

/** Liczba z formularza: przecinek albo kropka; puste = 0; śmieć = NaN. */
function parseInputNumber(raw) {
    if (raw === undefined || raw === null || raw === '') return 0;
    if (typeof raw === 'number') return raw;
    const text = String(raw).trim().replace(/\s/g, '').replace(',', '.');
    if (text === '') return 0;
    if (!/^-?\d+(\.\d+)?$/.test(text)) return NaN;
    return parseFloat(text);
}

/** @returns {{points:number, amount:number}|{error:string}} błąd = klucz tłumaczenia */
function validateInput(body) {
    const points = parseInputNumber(body && body.points);
    const amount = parseInputNumber(body && body.amount);
    if (!Number.isFinite(points) || points < 0 || points > MAX_POINTS) return { error: 'order.b2b_discount_points_invalid' };
    if (!Number.isFinite(amount) || amount < 0) return { error: 'order.b2b_discount_amount_invalid' };
    return { points: round(points, 2), amount: round(amount, 2) };
}

/**
 * Wartość zlecenia po rabacie % (bez rabatu kwotowego). Zapisane sumy pozycji
 * (`order_item.total_price_sub` = `SUB___WARTOSC_KONCOWA`) mają już w sobie
 * dotychczasowy rabat kwotowy — zdejmujemy go dzieleniem, bo to jeden równy mnożnik.
 */
function baseBeforeAmount(savedTotal, oldAmountPct) {
    const total = num(savedTotal);
    const pct = num(oldAmountPct);
    if (!(total > 0) || pct >= 100) return 0;
    return round(total / (1 - pct / 100), 2);
}

/** Kwota → procent od podstawy. `null` = kwota nie mieści się w wartości zlecenia. */
function amountToPercent(amount, base) {
    if (!(amount > 0)) return 0;
    if (!(base > 0) || amount >= base) return null;
    return round(amount / base * 100, 6);
}

async function savedSubTotal(query, orderId) {
    const rows = await query('SELECT COALESCE(SUM(total_price_sub), 0) AS total FROM order_item WHERE order_id = ?', [orderId]);
    return num(rows && rows[0] && rows[0].total);
}

/** Stawki rabatu z cennika w zleceniu („70% · 55%”) — punkt odniesienia w oknie. */
function listRatesOf(positions) {
    const parse = (raw) => {
        let v = raw;
        for (let i = 0; i < 2 && typeof v === 'string'; i++) {
            try { v = JSON.parse(v); } catch { return null; }
        }
        return v && typeof v === 'object' ? v : null;
    };
    const rates = new Set();
    for (const p of positions || []) {
        const values = parse(p.json_parameters);
        const rate = values ? parseFloat(values.SUB___CENA_RABAT) : NaN;
        if (Number.isFinite(rate)) rates.add(round(rate > 1 ? rate : rate * 100, 2));
    }
    return [...rates].sort((a, b) => b - a);
}

/** Dane okna „Rabat B2B dla klienta”. `canManage: false` = sekcji nie pokazujemy. */
async function getInfo(orderId, sessionUser, deps = {}) {
    const d = resolveDeps(deps);
    const row = await loadOrder(orderId, d);
    if (!canManage(sessionUser, row)) return { canManage: false };
    const values = valuesOf(row);
    const positions = await d.select('SELECT json_parameters, total_price_sub FROM order_item WHERE order_id = ?', [orderId]) || [];
    const base = baseBeforeAmount(positions.reduce((s, p) => s + num(p.total_price_sub), 0), values.amountPct);
    return {
        canManage: true,
        editable: row.status === 'active',
        ...values,
        // Kwota wpisana, ale jeszcze nie zamieniona na procent (przerwany zapis dwuetapowy).
        pending: values.amount > 0 && !(values.amountPct > 0),
        baseAfterPercent: base,
        currentAmount: round(base * values.amountPct / 100, 2),
        listRates: listRatesOf(positions)
    };
}

/**
 * Zapis rabatu. Zwraca `{ status, body }` gotowe do `res.status().json()`.
 *
 * Gdy w jednym zapisie zmieniają się punkty I jest kwota, podstawy kwoty jeszcze
 * nie ma (pozycje nie są przeliczone z nowymi punktami). Wtedy zapisujemy punkty
 * i kwotę bez procentu, a odpowiedź `needsSecondPass` każe przeglądarce przeliczyć
 * zlecenie i wysłać to samo jeszcze raz — drugi zapis zamieni kwotę na procent.
 */
async function save({ orderId, sessionUser, body }, deps = {}) {
    const d = resolveDeps(deps);
    const input = validateInput(body);
    if (input.error) return { status: 400, body: { success: false, messageKey: input.error } };

    return d.withTransaction(async (query) => {
        const rows = await query(`${ORDER_SQL} FOR UPDATE`, [orderId]);
        const row = rows && rows[0];
        if (!row) return { status: 404, body: { success: false, messageKey: 'order.b2b_discount_forbidden' } };
        if (!canManage(sessionUser, row)) return { status: 403, body: { success: false, messageKey: 'order.b2b_discount_forbidden' } };
        if (row.status !== 'active') return { status: 409, body: { success: false, messageKey: 'order.b2b_discount_locked' } };

        const old = valuesOf(row);
        const pointsChanged = input.points !== old.points;
        let amountPct = 0;
        let needsSecondPass = false;
        if (input.amount > 0) {
            if (pointsChanged) {
                needsSecondPass = true;
            } else {
                amountPct = amountToPercent(input.amount, baseBeforeAmount(await savedSubTotal(query, orderId), old.amountPct));
                if (amountPct === null) return { status: 400, body: { success: false, messageKey: 'order.b2b_discount_amount_too_high' } };
            }
        }

        const next = { points: input.points, amount: input.amount, amountPct };
        const changed = next.points !== old.points || next.amount !== old.amount || next.amountPct !== old.amountPct;
        if (changed) {
            await query(
                'UPDATE `order` SET b2b_discount_points = ?, b2b_discount_amount = ?, b2b_discount_amount_pct = ? WHERE id = ?',
                [next.points, next.amount, next.amountPct, orderId]
            );
            await query(
                `INSERT INTO order_b2b_discount_log
                    (order_id, changed_by_user_id, old_points, old_amount, old_amount_pct, new_points, new_amount, new_amount_pct)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [orderId, sessionUser.userId || null, old.points, old.amount, old.amountPct, next.points, next.amount, next.amountPct]
            );
        }
        return { status: 200, body: { success: true, changed, needsSecondPass, ...next } };
    });
}

/**
 * „Zamów ponownie” kopiuje pozycje razem z cenami po rabacie B2B — rabat idzie
 * z nimi, inaczej kopia pokazywałaby rabat bez jego ustawienia. Błąd (np. przed
 * migracją) = kopia bez rabatu, jak dotąd.
 */
async function copyToOrder(sourceOrderId, targetOrderId, deps = {}) {
    const d = resolveDeps(deps);
    await d.update(
        `UPDATE \`order\` t JOIN \`order\` s ON s.id = ?
         SET t.b2b_discount_points = s.b2b_discount_points,
             t.b2b_discount_amount = s.b2b_discount_amount,
             t.b2b_discount_amount_pct = s.b2b_discount_amount_pct
         WHERE t.id = ?`,
        [sourceOrderId, targetOrderId]
    );
}

module.exports = {
    resolveForOrder,
    getInfo,
    save,
    copyToOrder,
    stampOf,
    canManage,
    canManageOrder,
    isEligible,
    validateInput,
    baseBeforeAmount,
    amountToPercent,
    listRatesOf,
    HKL_ORG_ID
};
