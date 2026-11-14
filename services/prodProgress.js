/**
 * Postęp produkcji zlecenia z kolumny STATUSPROD pliku `status.txt`
 * (np. `11%Akcept.p.prod.`, `20%Wyc.sz-y/r-ki`, `100%Wyslane`, `Zafakturowane`).
 *
 * Zasada dla przycisków „Korekta” i „Anuluj” (Paweł + Wiktoria, 13.11.2026):
 *  • są tylko wtedy, gdy KAŻDA pozycja zlecenia ma NAJWYŻSZY % (w całej
 *    historii) poniżej `PROD_LOCK_PERCENT`,
 *  • statusy potrafią się cofać — jeśli choć raz pozycja miała ≥ 20%, blokada
 *    zostaje na stałe (historia: tabela `prod_status_history`,
 *    migrations/add_prod_status_history.sql),
 *  • status bez procentu („Got.do fakt.”, „Zafakturowane”, „Anulacja” = zlecenie
 *    anulowane przez produkcję) = blokada.
 * Admin i biuro korygują zawsze (services/orderCancellation.js `canCorrect`),
 * anulowanie obowiązuje wszystkich. Zastępuje dawne okno 24 h od wysłania.
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

/** Wiersze `parseStatusFile` → Map(klucz zlecenia → najwyższy %; Infinity = pozycja ze statusem bez %). */
function buildProgressIndex(rows) {
    const index = new Map();
    for (const row of rows || []) {
        const key = orderKey(row.ORGANIZATIONIDENT, row.USERIDENT, row.ORDERNO);
        const percent = prodPercent(row.STATUSPROD);
        const value = percent === null ? Infinity : percent;
        index.set(key, Math.max(index.has(key) ? index.get(key) : -Infinity, value));
    }
    return index;
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
            String(r.STATUSPROD ?? '').trim().slice(0, 100),
            prodPercent(r.STATUSPROD),
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
    if (!index.has(key) && String(order?.prod_status ?? '').trim()) return { allowed: false, percent };
    if (highest === -Infinity) return { allowed: true, percent: null };
    return { allowed: highest < PROD_LOCK_PERCENT, percent };
}

let cache = { file: null, mtimeMs: null, index: null };
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
        d.log('[prodProgress] ⚠️ nie zapisano historii STATUSPROD (brak tabeli prod_status_history? migrations/add_prod_status_history.sql) — decyzje tylko z bieżącego pliku');
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
        cache = { file: d.filePath, mtimeMs: stat.mtimeMs, index };
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

/** To samo dla wielu zleceń naraz (lista wysłanych) — jeden odczyt pliku i jedno zapytanie. */
async function clientMayChangeMany(orders, deps = {}) {
    const index = await loadIndex(deps);
    const history = index ? await loadHistory(orders, deps) : null;
    return (orders || []).map(order => decide(order, index, history?.get(orderKey(order?.org_ident, order?.user_ident, order?.order_idx)) || null));
}

/** Czy klient może jeszcze anulować / korygować to zlecenie. */
async function clientMayChange(order, deps = {}) {
    return (await clientMayChangeMany([order], deps))[0];
}

module.exports = {
    PROD_LOCK_PERCENT,
    prodPercent,
    orderKey,
    buildProgressIndex,
    historyRows,
    decide,
    recordHistory,
    loadIndex,
    clientMayChange,
    clientMayChangeMany
};
