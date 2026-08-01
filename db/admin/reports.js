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

/**
 * Build the shared WHERE clause used by every report aggregate so the
 * selected date range constrains all views identically.
 * Date comparisons run on DATE(o.created_date) — both ends inclusive.
 * @param {number[]|null} userIds
 * @param {string|null} dateFrom
 * @param {string|null} dateTo
 * @param {string} alias - table alias of `order`
 */
function buildOrderFilter(userIds, dateFrom, dateTo, alias = 'o') {
    const conditions = [`${alias}.status = 'sent'`];
    const params = [];

    if (userIds && userIds.length > 0) {
        conditions.push(`${alias}.user_id IN (${userIds.map(() => '?').join(',')})`);
        params.push(...userIds);
    }

    const from = normalizeDate(dateFrom);
    const to   = normalizeDate(dateTo);

    if (from) {
        conditions.push(`DATE(${alias}.created_date) >= ?`);
        params.push(from);
    }
    if (to) {
        conditions.push(`DATE(${alias}.created_date) <= ?`);
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
async function getReportClients(dateFrom = null, dateTo = null) {
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

    const query = `
        SELECT u.id, u.ident, u.client_name, u.organization_id, o.ident AS org_ident,
               COUNT(DISTINCT ord.id) AS order_count
        FROM user u
        LEFT JOIN organization o ON o.id = u.organization_id
        LEFT JOIN \`order\` ord ON ord.user_id = u.id AND ord.status = 'sent'${dateClause}
        WHERE (u.role IS NULL OR u.role NOT IN ('admin','owner','employee'))
          AND u.ident IS NOT NULL
        GROUP BY u.id, u.ident, u.client_name, u.organization_id, o.ident
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
async function getOrderStats(userIds, dateFrom, dateTo) {
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo);

    const query = `
        SELECT
            u.id            AS user_id,
            u.ident,
            u.client_name,
            u.organization_id,
            org.ident       AS org_ident,
            COUNT(DISTINCT o.id)                               AS order_count,
            COALESCE(SUM(
                CAST(TRIM(REPLACE(TRIM(SUBSTRING_INDEX(o.total_price, ':', -1)), '€', '')) AS DECIMAL(10,2))
            ), 0)                                              AS total_value,
            COALESCE(SUM(oi_agg.position_count), 0)            AS position_count
        FROM user u
        LEFT JOIN organization org ON org.id = u.organization_id
        INNER JOIN \`order\` o ON o.user_id = u.id
        LEFT JOIN (
            SELECT order_id, SUM(amount) AS position_count
            FROM order_item
            GROUP BY order_id
        ) oi_agg ON oi_agg.order_id = o.id
        ${where}
        GROUP BY u.id, u.ident, u.client_name, u.organization_id, org.ident
        ORDER BY total_value DESC
    `;
    return selectQuery(query, params);
}

/**
 * Get monthly order trend for selected clients.
 */
async function getMonthlyTrend(userIds, dateFrom, dateTo) {
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo);

    const query = `
        SELECT
            DATE_FORMAT(o.created_date, '%Y-%m') AS month,
            COUNT(DISTINCT o.id)                  AS order_count,
            COALESCE(SUM(
                CAST(TRIM(REPLACE(TRIM(SUBSTRING_INDEX(o.total_price, ':', -1)), '€', '')) AS DECIMAL(10,2))
            ), 0)                                  AS total_value,
            COALESCE(SUM(oi_agg.position_count), 0) AS position_count
        FROM \`order\` o
        LEFT JOIN (
            SELECT order_id, SUM(amount) AS position_count
            FROM order_item
            GROUP BY order_id
        ) oi_agg ON oi_agg.order_id = o.id
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
async function getGroupStats(userIds, dateFrom, dateTo) {
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo);

    const query = `
        SELECT
            COALESCE(d.name_pl, '—')             AS department_name,
            COALESCE(d.id, 0)                    AS department_id,
            COALESCE(pg.name_pl, oi.group_name, '—') AS group_name,
            pg.group_number,
            SUM(oi.amount)                       AS position_count,
            COALESCE(SUM(oi.total_price), 0)     AS total_value,
            COUNT(DISTINCT o.id)                 AS order_count,
            COUNT(DISTINCT o.user_id)            AS client_count
        FROM order_item oi
        JOIN \`order\` o ON o.id = oi.order_id
        LEFT JOIN product_group pg ON pg.group_number = oi.asortment_group_number
        LEFT JOIN department d ON d.id = pg.department_id
        ${where}
        GROUP BY
            COALESCE(d.id, 0),
            COALESCE(d.name_pl, '—'),
            pg.group_number,
            COALESCE(pg.name_pl, oi.group_name, '—')
        ORDER BY COALESCE(d.name_pl, '—') ASC, total_value DESC
    `;
    return selectQuery(query, params);
}

/**
 * Get position/value breakdown per department × client.
 * Returns one row per (department, client) combination.
 */
async function getDeptClientStats(userIds, dateFrom, dateTo) {
    const { where, params } = buildOrderFilter(userIds, dateFrom, dateTo);

    const query = `
        SELECT
            COALESCE(d.name_pl, '—')             AS department_name,
            COALESCE(d.id, 0)                    AS department_id,
            u.id                                 AS user_id,
            u.ident,
            u.client_name,
            SUM(oi.amount)                        AS position_count,
            COALESCE(SUM(oi.total_price), 0)      AS total_value,
            COUNT(DISTINCT o.id)                  AS order_count
        FROM order_item oi
        JOIN \`order\` o ON o.id = oi.order_id
        JOIN user u ON u.id = o.user_id
        LEFT JOIN product_group pg ON pg.group_number = oi.asortment_group_number
        LEFT JOIN department d ON d.id = pg.department_id
        ${where}
        GROUP BY
            COALESCE(d.id, 0),
            COALESCE(d.name_pl, '—'),
            u.id, u.ident, u.client_name
        ORDER BY COALESCE(d.name_pl, '—') ASC, total_value DESC
    `;
    return selectQuery(query, params);
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
    saveReportConfig,
    getReportConfigs,
    deleteReportConfig,
};
