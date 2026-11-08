/**
 * Audyt pracy biura na zleceniu: `order.created_by_staff_id`, `order.updated_by_staff_id`
 * (migrations/add_order_staff_audit.sql). Widoczny tylko dla biura i admina —
 * nigdy w PDF-ach, mailach ani eksporcie FTP.
 *
 * Kolumny dochodzą migracją, więc ich obecność sprawdzamy w `information_schema`
 * (wynik trzymany 5 min): przed migracją zapis jest pomijany, a odczyt zwraca pustą
 * mapę — widoki działają jak dotąd, bez błędów w logu.
 */

const { log } = require('../utils/logging');

const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, value: false };

function query(sql, params) {
    const { pool } = require('../db/core');
    return pool.query(sql, params).then(([rows]) => rows);
}

async function supportsStaffAudit(deps = {}) {
    const run = deps.query || query;
    const now = Date.now();
    if (!deps.query && now - cache.at < CACHE_MS) return cache.value;
    let value = false;
    try {
        const rows = await run(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order'
               AND COLUMN_NAME IN ('created_by_staff_id', 'updated_by_staff_id')`
        );
        value = Number(rows?.[0]?.n) === 2;
    } catch (err) {
        log('[staffAudit] nie udało się sprawdzić kolumn audytu:', err.message);
    }
    if (!deps.query) cache = { at: now, value };
    return value;
}

/** Zlecenie założone przez konto biura (także kopia „Zamów ponownie"). */
async function markCreatedByStaff(orderId, staffUserId, deps = {}) {
    if (!orderId || !staffUserId || !(await supportsStaffAudit(deps))) return;
    try {
        await (deps.query || query)(
            'UPDATE `order` SET created_by_staff_id = ?, updated_by_staff_id = ? WHERE id = ?',
            [staffUserId, staffUserId, orderId]
        );
    } catch (err) {
        log(`[staffAudit] zapis autora zlecenia ${orderId} nie powiódł się:`, err.message);
    }
}

/** Ostatnia zmiana zlecenia lub jego pozycji przez konto biura. */
async function markUpdatedByStaff(orderId, staffUserId, deps = {}) {
    if (!orderId || !staffUserId || !(await supportsStaffAudit(deps))) return;
    try {
        await (deps.query || query)('UPDATE `order` SET updated_by_staff_id = ? WHERE id = ?', [staffUserId, orderId]);
    } catch (err) {
        log(`[staffAudit] zapis ostatniej zmiany zlecenia ${orderId} nie powiódł się:`, err.message);
    }
}

/**
 * `{ [orderId]: { createdBy, updatedBy } }` — nazwy kont biura dla listy zleceń
 * albo podglądu. Pusta mapa przed migracją albo przy błędzie.
 */
async function getStaffAudit(orderIds, deps = {}) {
    const ids = [...new Set((orderIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length || !(await supportsStaffAudit(deps))) return {};
    try {
        const rows = await (deps.query || query)(
            `SELECT o.id, c.client_name AS created_by, u.client_name AS updated_by
             FROM \`order\` o
             LEFT JOIN \`user\` c ON c.id = o.created_by_staff_id
             LEFT JOIN \`user\` u ON u.id = o.updated_by_staff_id
             WHERE o.id IN (?) AND (o.created_by_staff_id IS NOT NULL OR o.updated_by_staff_id IS NOT NULL)`,
            [ids]
        );
        const map = {};
        for (const r of rows || []) map[r.id] = { createdBy: r.created_by || null, updatedBy: r.updated_by || null };
        return map;
    } catch (err) {
        log('[staffAudit] odczyt audytu nie powiódł się:', err.message);
        return {};
    }
}

module.exports = { supportsStaffAudit, markCreatedByStaff, markUpdatedByStaff, getStaffAudit };
