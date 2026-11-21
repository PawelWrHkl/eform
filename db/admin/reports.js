const { selectQuery, updateQuery } = require('../core');
const { log } = require('../../utils/logging');
const { convertToSQLDate } = require('../../utils/humanize_date');

/**
 * Normalize an incoming date filter to a plain `YYYY-MM-DD` string.
 * Anything unparseable is dropped (treated as "no limit") so a malformed
 * value can never silently widen or break the range.
 */
function normalizeDate(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    return convertToSQLDate(raw.slice(0, 19).replace('T', ' '));
}

/** Kto jest „klientem” w raportach — ta sama reguła w liście klientów i w zakresie organizacji. */
function clientSql(alias) {
    return `(${alias}.role IS NULL OR ${alias}.role NOT IN ('admin','owner','employee')) AND ${alias}.ident IS NOT NULL`;
}

// Admin, widok „Całość” i trend: wartość z napisu `order.total_price` („Razem: 123€”) — jak dotąd.
const ORDER_LABEL_VALUE_SQL = "CAST(TRIM(REPLACE(TRIM(SUBSTRING_INDEX(o.total_price, ':', -1)), '€', '')) AS DECIMAL(10,2))";
const NAME_LANGS = ['pl', 'en', 'de', 'fr', 'nl'];

/**
 * Kwoty i nazwy zależne od zakresu raportu.
 * Admin (`scope` puste): dokładnie te same wyrażenia co przed 2026-11-20.
 * Organizacja: `scope.valueColumn` = kolumna `order_item` z ceną sprzedaży
 * (`total_price_sub` — cena klienta SUB___, HKL: `total_price`), `scope.purchase`
 * = dołącz „zakup od HKL” (`order_item.total_price`), `scope.lang` = język nazw grup/działów.
 * @param {{orgId?: number, valueColumn?: string, purchase?: boolean, lang?: string}} scope
 */
function scopeSql(scope = {}) {
    const col = ['total_price_sub', 'total_price'].includes(scope.valueColumn) ? scope.valueColumn : null;
    const lang = NAME_LANGS.includes(scope.lang) ? scope.lang : 'pl';
    const name = (t) => lang === 'pl' ? `${t}.name_pl` : `COALESCE(NULLIF(TRIM(${t}.name_${lang}), ''), ${t}.name_pl)`;
    return {
        orgId: scope.orgId ?? null,
        orderValue: col ? `oi_agg.${col === 'total_price' ? 'base' : 'sub'}_value` : ORDER_LABEL_VALUE_SQL,
        itemValue: `oi.${col || 'total_price'}`,
        orderPurchase: (scope.purchase ? ',\n            COALESCE(SUM(oi_agg.base_value), 0) AS purchase_value' : '')
            // Pozycje bez ceny klienta (sprzed cen SUB___) — w sprzedaży jako 0, raport o nich mówi.
            + (col === 'total_price_sub' ? ',\n            COALESCE(SUM(oi_agg.items_no_sub), 0) AS items_no_sub' : ''),
        itemPurchase: scope.purchase ? ',\n            COALESCE(SUM(oi.total_price), 0) AS purchase_value' : '',
        deptName: name('d'),
        groupName: name('pg'),
    };
}

// Sumy pozycji na zlecenie: liczba sztuk + obie warstwy cen (admin czyta tylko `position_count`).
const OI_AGG_SQL = `LEFT JOIN (
            SELECT order_id, SUM(amount) AS position_count,
                   SUM(total_price) AS base_value, SUM(total_price_sub) AS sub_value,
                   SUM(COALESCE(total_price_sub, 0) = 0) AS items_no_sub
            FROM order_item
            GROUP BY order_id
        ) oi_agg ON oi_agg.order_id = o.id`;

/**
 * Build the shared WHERE clause used by every report aggregate so the
 * selected date range constrains all views identically.
 * Date comparisons run on DATE(o.created_date) — both ends inclusive.
 * @param {number[]|null} userIds
 * @param {string|null} dateFrom
 * @param {string|null} dateTo
 * @param {string} alias - table alias of `order`
 */
function buildOrderFilter(userIds, dateFrom, dateTo, alias = 'o', orgId = null, opts = {}) {
    // `opts.offers`: raport ofert — zlecenia ze znacznikiem oferty (bez anulowanych), daty po dniu oferty.
    const conditions = [opts.offers
        ? `${alias}.offer_at IS NOT NULL AND ${alias}.status IN ('active','pending_approval','sent','correction')`
        : `${alias}.status = 'sent'`];
    const dateCol = opts.offers ? 'offer_at' : 'created_date';
    const params = [];

    if (userIds && userIds.length > 0) {
        conditions.push(`${alias}.user_id IN (${userIds.map(() => '?').join(',')})`);
        params.push(...userIds);
    }

    // Raport organizacji (`/org/reports`): każdy agregat zawężony w SQL do klientów
    // tej organizacji — niezależnie od tego, jakie `userIds` przyszły z przeglądarki.
    if (orgId != null) {
        conditions.push(`${alias}.user_id IN (SELECT su.id FROM user su WHERE su.organization_id = ? AND ${clientSql('su')})`);
        params.push(orgId);
    }

    const from = normalizeDate(dateFrom);
    const to   = normalizeDate(dateTo);

    if (from) {
        conditions.push(`DATE(${alias}.${dateCol}) >= ?`);
        params.push(from);
    }
    if (to) {
        conditions.push(`DATE(${alias}.${dateCol}) <= ?`);
        params.push(to);
    }

    return { where: 'WHERE ' + conditions.join(' AND '), params };
}

/**
 * Get all clients (users with role = null or 'client') for admin report filtering.
 * The order counter respects the same date range as the report itself, so the
 * sidebar never advertises orders that fall outside the selected period.
 * @param {string|null} dateFrom
 * @param {string|null} dateTo
 */
async function getReportClients(dateFrom = null, dateTo = null, orgId = null) {
    const params = [];
    let dateClause = '';

    const from = normalizeDate(dateFrom);
    const to   = normalizeDate(dateTo);

    if (from) {
        dateClause += ' AND DATE(ord.created_date) >= ?';
        params.push(from);
    }
    if (to) {
        dateClause += ' AND DATE(ord.created_date) <= ?';
        params.push(to);
    }

    let orgClause = '';
    if (orgId != null) {
        orgClause = ' AND u.organization_id = ?';
        params.push(orgId);
    }

    const query = `
        SELECT u.id, u.ident, u.client_name, u.organization_id, u.role, o.ident AS org_ident,
               u.currency, o.currency AS org_currency,
               COUNT(DISTINCT ord.id) AS order_count
        FROM user u
        LEFT JOIN organization o ON o.id = u.organization_id
        LEFT JOIN \`order\` ord ON ord.user_id = u.id AND ord.status = 'sent'${dateClause}
        WHERE ${clientSql('u')}${orgClause}
        GROUP BY u.id, u.ident, u.client_name, u.organization_id, u.role, o.ident, u.currency, o.currency
        ORDER BY order_count DESC, u.ident ASC
    `;
    return selectQuery(query, params);
}

/**
 * Get order statistics per client.
 * @param {number[]|null} userIds - null means all clients
 * @param {string|null} dateFrom  - ISO date string
 * @param {string|null} dateTo    - ISO date string
 */
async function getOrderStats(userIds, dateFrom, dateTo, scope = {}) {
    const q = scopeSql(scope);
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo, 'o', q.orgId);

    const query = `
        SELECT
            u.id            AS user_id,
            u.ident,
            u.client_name,
            u.organization_id,
            org.ident       AS org_ident,
            COUNT(DISTINCT o.id)                               AS order_count,
            COALESCE(SUM(${q.orderValue}), 0)                  AS total_value,
            COALESCE(SUM(oi_agg.position_count), 0)            AS position_count${q.orderPurchase}
        FROM user u
        LEFT JOIN organization org ON org.id = u.organization_id
        INNER JOIN \`order\` o ON o.user_id = u.id
        ${OI_AGG_SQL}
        ${where}
        GROUP BY u.id, u.ident, u.client_name, u.organization_id, org.ident
        ORDER BY total_value DESC
    `;
    return selectQuery(query, params);
}

/**
 * Get monthly order trend for selected clients.
 */
async function getMonthlyTrend(userIds, dateFrom, dateTo, scope = {}) {
    const q = scopeSql(scope);
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo, 'o', q.orgId);

    const query = `
        SELECT
            DATE_FORMAT(o.created_date, '%Y-%m') AS month,
            COUNT(DISTINCT o.id)                  AS order_count,
            COALESCE(SUM(${q.orderValue}), 0)     AS total_value,
            COALESCE(SUM(oi_agg.position_count), 0) AS position_count${q.orderPurchase}
        FROM \`order\` o
        ${OI_AGG_SQL}
        ${where}
        GROUP BY DATE_FORMAT(o.created_date, '%Y-%m')
        ORDER BY month ASC
    `;
    return selectQuery(query, params);
}

/**
 * Save a report config for a given admin user.
 */
async function saveReportConfig(adminUserId, config) {
    const existing = await selectQuery('SELECT report_configs FROM user WHERE id = ?', [adminUserId]);
    const raw = existing && existing[0] ? existing[0].report_configs : null;
    const configs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);

    // Prevent duplicate names — replace if same name, otherwise add
    const filtered = configs.filter(c => c.name !== config.name);
    filtered.unshift({ ...config, savedAt: new Date().toISOString() });

    const trimmed = filtered.slice(0, 20);
    await updateQuery('UPDATE user SET report_configs = ? WHERE id = ?', [JSON.stringify(trimmed), adminUserId]);
    return trimmed;
}

/**
 * Get saved report configs for a given admin user.
 */
async function getReportConfigs(adminUserId) {
    const rows = await selectQuery('SELECT report_configs FROM user WHERE id = ?', [adminUserId]);
    const raw = rows && rows[0] ? rows[0].report_configs : null;
    return Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
}

/**
 * Get position/value breakdown per department and product group.
 * Uses canonical names from product_group/department tables (PL).
 */
async function getGroupStats(userIds, dateFrom, dateTo, scope = {}) {
    const q = scopeSql(scope);
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo, 'o', q.orgId);

    const query = `
        SELECT
            COALESCE(${q.deptName}, '—')             AS department_name,
            COALESCE(d.id, 0)                    AS department_id,
            COALESCE(${q.groupName}, oi.group_name, '—') AS group_name,
            pg.group_number,
            SUM(oi.amount)                       AS position_count,
            COALESCE(SUM(${q.itemValue}), 0)     AS total_value,
            COUNT(DISTINCT o.id)                 AS order_count,
            COUNT(DISTINCT o.user_id)            AS client_count${q.itemPurchase}
        FROM order_item oi
        JOIN \`order\` o ON o.id = oi.order_id
        LEFT JOIN product_group pg ON pg.group_number = oi.asortment_group_number
        LEFT JOIN department d ON d.id = pg.department_id
        ${where}
        GROUP BY
            COALESCE(d.id, 0),
            COALESCE(${q.deptName}, '—'),
            pg.group_number,
            COALESCE(${q.groupName}, oi.group_name, '—')
        ORDER BY COALESCE(${q.deptName}, '—') ASC, total_value DESC
    `;
    return selectQuery(query, params);
}

/**
 * Get position/value breakdown per department × client.
 * Returns one row per (department, client) combination.
 */
async function getDeptClientStats(userIds, dateFrom, dateTo, scope = {}) {
    const q = scopeSql(scope);
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo, 'o', q.orgId);

    const query = `
        SELECT
            COALESCE(${q.deptName}, '—')             AS department_name,
            COALESCE(d.id, 0)                    AS department_id,
            u.id                                 AS user_id,
            u.ident,
            u.client_name,
            SUM(oi.amount)                        AS position_count,
            COALESCE(SUM(${q.itemValue}), 0)      AS total_value,
            COUNT(DISTINCT o.id)                  AS order_count${q.itemPurchase}
        FROM order_item oi
        JOIN \`order\` o ON o.id = oi.order_id
        JOIN user u ON u.id = o.user_id
        LEFT JOIN product_group pg ON pg.group_number = oi.asortment_group_number
        LEFT JOIN department d ON d.id = pg.department_id
        ${where}
        GROUP BY
            COALESCE(d.id, 0),
            COALESCE(${q.deptName}, '—'),
            u.id, u.ident, u.client_name
        ORDER BY COALESCE(${q.deptName}, '—') ASC, total_value DESC
    `;
    return selectQuery(query, params);
}

/**
 * Zlecenia pojedynczo (klient, dzień, wartość) — wejście dla „klientów do odzyskania”.
 * Ten sam filtr i ta sama wartość co `getOrderStats`.
 */
async function getClientOrderDays(userIds, dateFrom, dateTo, scope = {}) {
    const q = scopeSql(scope);
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo, 'o', q.orgId);

    const query = `
        SELECT o.user_id, DATE_FORMAT(o.created_date, '%Y-%m-%d') AS day,
               COALESCE(${q.orderValue}, 0) AS total_value
        FROM \`order\` o
        ${OI_AGG_SQL}
        ${where}
        ORDER BY o.user_id, o.created_date
    `;
    return selectQuery(query, params);
}

/**
 * Oferty (`order.offer_at`, services/orderOffer.js) z zakresu dat liczonego po dniu oferty.
 * Wartość = ta sama kolumna co „Sprzedaż” (`scope.valueColumn`). Wołać tylko, gdy kolumna istnieje.
 */
async function getOffers(userIds, dateFrom, dateTo, scope = {}) {
    const q = scopeSql(scope);
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo, 'o', q.orgId, { offers: true });

    const query = `
        SELECT o.id, o.user_id, o.status, o.order_idx, o.commision,
               DATE_FORMAT(o.offer_at, '%Y-%m-%d') AS offer_day,
               COALESCE(${q.orderValue}, 0) AS total_value
        FROM \`order\` o
        ${OI_AGG_SQL}
        ${where}
        ORDER BY o.offer_at
    `;
    return selectQuery(query, params);
}

/** Organizacja raportu: nagłówek strony `/org/reports` i walidacja `?org=` admina. */
async function getOrganization(orgId) {
    const rows = await selectQuery('SELECT id, ident, name, currency FROM organization WHERE id = ?', [orgId]);
    return rows && rows[0] ? rows[0] : null;
}

/**
 * Delete a saved report config by name.
 */
async function deleteReportConfig(adminUserId, configName) {
    const rows = await selectQuery('SELECT report_configs FROM user WHERE id = ?', [adminUserId]);
    const raw = rows && rows[0] ? rows[0].report_configs : null;
    const configs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    const updated = configs.filter(c => c.name !== configName);
    await updateQuery('UPDATE user SET report_configs = ? WHERE id = ?', [JSON.stringify(updated), adminUserId]);
    return updated;
}

module.exports = {
    getReportClients,
    getOrderStats,
    getMonthlyTrend,
    getGroupStats,
    getDeptClientStats,
    getClientOrderDays,
    getOffers,
    getOrganization,
    buildOrderFilter,
    scopeSql,
    saveReportConfig,
    getReportConfigs,
    deleteReportConfig,
};
