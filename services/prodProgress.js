/**
 * Postęp produkcji zlecenia z kolumny MAXSTATUSPROD pliku `status.txt` — najwyższy
 * status, jaki pozycja osiągnęła w ERP (np. `11%Akcept.p.prod.`, `20%Wyc.sz-y/r-ki`,
 * `100%Wyslane`, `Anulacja`). Decyzja Pawła 16.11.2026: według MAXSTATUSPROD, nie
 * bieżącego STATUSPROD (ten bywa niższy, bo statusy się cofają). Plik bez tej
 * kolumny (starszy eksport) → STATUSPROD.
 *
 * Zasada dla przycisków „Korekta” i „Anuluj” (Paweł + Wiktoria, 13.11.2026):
 *  • są tylko wtedy, gdy KAŻDA pozycja zlecenia ma NAJWYŻSZY % (w całej
 *    historii) poniżej `PROD_LOCK_PERCENT`,
 *  • statusy potrafią się cofać — jeśli choć raz pozycja miała ≥ 20%, blokada
 *    zostaje na stałe (historia: tabela `prod_status_history`,
 *    migrations/add_prod_status_history.sql),
 *  • status bez procentu („Got.do fakt.”, „Zafakturowane”, „Anulacja” = zlecenie
 *    anulowane przez produkcję) = blokada,
 *  • zlecenie bez pozycji w pliku = blokada (Wiktoria 19.11.2026).
 * Admin i biuro korygują zawsze (services/orderCancellation.js `canCorrect`) — poza
 * zleceniem anulowanym przez produkcję (`canceled`: „Anulacja” na KAŻDEJ pozycji,
 * Wiktoria 17.11.2026); takie zlecenie cykl statusów sam oznacza jako anulowane
 * (services/prodStatus.js, Paweł 19.11.2026). Anulowanie obowiązuje wszystkich.
 */

'use strict';

const PROD_LOCK_PERCENT = 20;

/** `11%Akcept.p.prod.` → 11; brak procentu → null. */
function prodPercent(value) {
    const match = String(value ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*%/);
    return match ? Number(match[1].replace(',', '.')) : null;
}

function normOrderNo(orderNo) {
    return String(orderNo ?? '').trim().replace(/^0+(?=\d)/, '');
}

/** Klucz zlecenia: organizacja | klient | numer — jak w nazwie pliku `HKL_TCN_222.json`. */
function orderKey(orgIdent, userIdent, orderNo) {
    return [orgIdent, userIdent, normOrderNo(orderNo)].map(v => String(v ?? '').trim().toUpperCase()).join('|');
}

/** Status pozycji, według którego decydujemy: MAXSTATUSPROD, a bez niego STATUSPROD. */
function maxStatusProd(row) {
    return String(row?.MAXSTATUSPROD ?? '').trim() || String(row?.STATUSPROD ?? '').trim();
}

/** Wiersze `parseStatusFile` → Map(klucz zlecenia → najwyższy %; Infinity = pozycja ze statusem bez %). */
function buildProgressIndex(rows) {
    const index = new Map();
    for (const row of rows || []) {
        const key = orderKey(row.ORGANIZATIONIDENT, row.USERIDENT, row.ORDERNO);
        const percent = prodPercent(maxStatusProd(row));
        const value = percent === null ? Infinity : percent;
        index.set(key, Math.max(index.has(key) ? index.get(key) : -Infinity, value));
    }
    return index;
}

/**
 * Pozycja anulowana przez produkcję: BIEŻĄCY STATUSPROD „Anulacja” (MAXSTATUSPROD bywa
 * „Anulacja” przy pozycjach wysłanych — Ryver 239, 19.11.2026) albo STATUS „cancelled”
 * (Wiktoria poprosiła Tomka o osobny status 19.11.2026).
 */
function isCanceledRow(row) {
    return /^anulac/i.test(String(row?.STATUSPROD ?? '').trim()) || /^!?cancel/i.test(String(row?.STATUS ?? '').trim());
}

/**
 * Pozycje anulowane przez produkcję, per zlecenie z co najmniej jedną taką pozycją.
 *  • `positions` — numery pozycji, których WSZYSTKIE wiersze (podpozycje `1-1`, `1-2`) mają „Anulacja”,
 *  • `all` — każdy wiersz zlecenia w pliku anulowany.
 * Plik trzyma zakończone pozycje tylko 60 dni (Wiktoria 20.11.2026), więc samo `all` nie
 * oznacza anulowanego zlecenia — o tym decyduje `fullyCanceledOrderIds` po pozycjach w eFormie.
 * @returns {Map<string, { ids: [string, string, string], positions: Set<number>, all: boolean }>}
 */
function buildCanceledOrders(rows) {
    const { positionNumber } = require('./prodStatus');
    const orders = new Map();
    for (const row of rows || []) {
        const key = orderKey(row.ORGANIZATIONIDENT, row.USERIDENT, row.ORDERNO);
        if (!orders.has(key)) {
            orders.set(key, { ids: [String(row.ORGANIZATIONIDENT).trim(), String(row.USERIDENT).trim(), normOrderNo(row.ORDERNO)], byPos: new Map(), all: true });
        }
        const order = orders.get(key);
        const canceled = isCanceledRow(row);
        order.all = order.all && canceled;
        const pos = positionNumber(row.ORDERPOS);
        if (pos !== null) order.byPos.set(pos, (order.byPos.get(pos) ?? true) && canceled);
    }
    const result = new Map();
    for (const [key, { ids, byPos, all }] of orders) {
        const positions = new Set([...byPos].filter(([, canceled]) => canceled).map(([pos]) => pos));
        if (positions.size || all) result.set(key, { ids, positions, all });
    }
    return result;
}

/**
 * Id zleceń, w których KAŻDA pozycja w eFormie jest anulowana w pliku (pozycji z bazy nie ma w
 * pliku = nie anulujemy — KN_Wohnen_Neubrandenburg nr 16: wysłane 1–2 wypadły, zostały anulowane 3–4).
 * Numer pozycji jak w widoku (prodStatus.alignStatusesToItems): `orderpos`, bez niego kolejność.
 * @param {Array<{ id, org_ident, user_ident, order_idx, orderpos }>} itemRows pozycje zleceń, kolejno po `order_item.id`
 * @param {Map} canceledOrders wynik `buildCanceledOrders`
 * @returns {number[]}
 */
function fullyCanceledOrderIds(itemRows, canceledOrders) {
    const byOrder = new Map();
    for (const row of itemRows || []) {
        if (!byOrder.has(row.id)) byOrder.set(row.id, []);
        byOrder.get(row.id).push(row);
    }
    return [...byOrder].filter(([, items]) => {
        const positions = canceledOrders.get(orderKey(items[0].org_ident, items[0].user_ident, items[0].order_idx))?.positions;
        return !!positions && items.every((item, i) => positions.has(Number(item.orderpos) || i + 1));
    }).map(([id]) => id);
}

/** Wiersze pliku → wiersze `prod_status_history` (`db/statuses.js recordProdStatusHistory`). */
function historyRows(rows, seenAt) {
    return (rows || [])
        .filter(r => String(r.ORGANIZATIONIDENT ?? '').trim() && String(r.USERIDENT ?? '').trim() && normOrderNo(r.ORDERNO))
        .map(r => [
            String(r.ORGANIZATIONIDENT).trim().slice(0, 100),
            String(r.USERIDENT).trim().slice(0, 100),
            normOrderNo(r.ORDERNO).slice(0, 50),
            String(r.ORDERPOS ?? '').trim().slice(0, 50),
            maxStatusProd(r).slice(0, 100),
            prodPercent(maxStatusProd(r)),
            seenAt
        ]);
}

/**
 * Decyzja dla jednego zlecenia (czysta funkcja).
 *  - najwyższy znany % = max(plik teraz, historia); status bez % (teraz albo
 *    kiedykolwiek) = Infinity; wolno tylko przy < 20,
 *  - nie ma w pliku, ale `order.prod_status` jest → wypadło z okna pliku
 *    (stare zlecenie) → nie wolno,
 *  - nic nie wiadomo (ani w pliku, ani w historii, bez statusu produkcji) →
 *    produkcja jeszcze go nie ruszyła → wolno.
 * `index === null` (pliku nie da się odczytać) → nie wolno.
 *
 * @param {{ org_ident, user_ident, order_idx, prod_status? }} order
 * @param {Map|null} index  wynik `buildProgressIndex`
 * @param {{ max_percent, no_percent }|null} [history]  wiersz `getProdStatusHistoryMax`
 * @returns {{ allowed: boolean, percent: number|null }}
 */
function decide(order, index, history = null) {
    if (!index) return { allowed: false, percent: null };
    const key = orderKey(order?.org_ident, order?.user_ident, order?.order_idx);
    let highest = index.has(key) ? index.get(key) : -Infinity;
    if (history) {
        if (Number(history.no_percent) > 0) highest = Infinity;
        else if (history.max_percent !== null && history.max_percent !== undefined) highest = Math.max(highest, Number(history.max_percent));
    }
    const percent = Number.isFinite(highest) ? highest : null;
    // Bez pozycji w pliku stan produkcji jest nieznany → bez przycisków (Wiktoria 19.11.2026:
    // Neidhardt_Raumaus_SV nr 2 z 12.08 nigdy nie było w status.txt, a klient je anulował).
    if (!index.has(key)) return { allowed: false, percent };
    return { allowed: highest < PROD_LOCK_PERCENT, percent };
}

let cache = { file: null, mtimeMs: null, index: null, canceled: new Map() };
let historyWarned = false;

function resolveDeps(deps = {}) {
    return {
        fs: deps.fs || require('fs').promises,
        filePath: deps.filePath || require('./prodStatus').STATUS_FILE,
        // Baza ładowana dopiero przy użyciu (db/core otwiera pulę przy imporcie).
        get statusDb() { return deps.statusDb || require('../db/statuses.js'); },
        log: deps.log || require('../utils/logging').log,
        now: deps.now || (() => require('../utils/humanize_date.js').getDbTimestamp())
    };
}

/** Zapis historii; błąd (np. brak tabeli przed migracją) tylko w logu — raz na proces. */
async function recordHistory(rows, deps = {}) {
    const d = resolveDeps(deps);
    try {
        if (await d.statusDb.recordProdStatusHistory(historyRows(rows, d.now()))) return true;
    } catch (_) { /* jak niżej */ }
    if (!historyWarned) {
        historyWarned = true;
        d.log('[prodProgress] ⚠️ nie zapisano historii MAXSTATUSPROD (brak tabeli prod_status_history? migrations/add_prod_status_history.sql) — decyzje tylko z bieżącego pliku');
    }
    return false;
}

/** Indeks z pliku, przeliczany tylko po zmianie `mtime` (wtedy też zapis historii); `null` = pliku nie da się odczytać. */
async function loadIndex(deps = {}) {
    const d = resolveDeps(deps);
    try {
        const stat = await d.fs.stat(d.filePath);
        if (cache.file === d.filePath && cache.mtimeMs === stat.mtimeMs) return cache.index;
        const rows = require('./prodStatus').parseStatusFile(await d.fs.readFile(d.filePath, 'utf-8'));
        const index = buildProgressIndex(rows);
        cache = { file: d.filePath, mtimeMs: stat.mtimeMs, index, canceled: buildCanceledOrders(rows) };
        await recordHistory(rows, deps);
        return index;
    } catch (err) {
        d.log(`[prodProgress] nie można odczytać ${d.filePath}: ${err?.message || err} — klient nie anuluje ani nie koryguje`);
        return null;
    }
}

/** Historia dla zleceń → Map(klucz → wiersz); `null` = niedostępna (decyzja z samego pliku). */
async function loadHistory(orders, deps = {}) {
    const d = resolveDeps(deps);
    const keys = (orders || []).map(o => [String(o.org_ident ?? '').trim(), String(o.user_ident ?? '').trim(), normOrderNo(o.order_idx)]);
    let rows;
    try {
        rows = await d.statusDb.getProdStatusHistoryMax(keys);
    } catch (_) {
        rows = null;
    }
    if (!rows) return null;
    return new Map(rows.map(r => [orderKey(r.org_ident, r.user_ident, r.order_idx), r]));
}

/**
 * To samo dla wielu zleceń naraz (lista wysłanych) — jeden odczyt pliku i jedno zapytanie.
 * `canceled` = produkcja anulowała całe zlecenie (shortcut: tylko bieżący plik — zlecenie, które z niego
 * wypadło, tego znacznika nie ma; dołożyć historię, gdyby admin/biuro korygowali takie zlecenia).
 */
async function clientMayChangeMany(orders, deps = {}) {
    const index = await loadIndex(deps);
    const history = index ? await loadHistory(orders, deps) : null;
    return (orders || []).map(order => {
        const key = orderKey(order?.org_ident, order?.user_ident, order?.order_idx);
        return { ...decide(order, index, history?.get(key) || null), canceled: !!index && !!cache.canceled.get(key)?.all };
    });
}

/**
 * Numery pozycji zlecenia anulowanych w PROD — znacznik „Anulowane” na pozycji w podglądzie
 * (Wiktoria 20.11.2026: zlecenie anulowane częściowo).
 * shortcut: tylko bieżący status.txt (zakończone pozycje 60 dni, potem znacznik znika) — trwały zapis
 * po decyzji, co STATUS „cancelled” w position_statuses ma zrobić z automatem faktur.
 * @returns {Promise<Set<number>>}
 */
async function canceledPositions(order, deps = {}) {
    await loadIndex(deps);
    return cache.canceled.get(orderKey(order?.org_ident, order?.user_ident, order?.order_idx))?.positions || new Set();
}

/** Czy klient może jeszcze anulować / korygować to zlecenie. */
async function clientMayChange(order, deps = {}) {
    return (await clientMayChangeMany([order], deps))[0];
}

module.exports = {
    PROD_LOCK_PERCENT,
    prodPercent,
    maxStatusProd,
    orderKey,
    buildProgressIndex,
    buildCanceledOrders,
    fullyCanceledOrderIds,
    canceledPositions,
    historyRows,
    decide,
    recordHistory,
    loadIndex,
    clientMayChange,
    clientMayChangeMany
};
