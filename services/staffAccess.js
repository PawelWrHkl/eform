/**
 * Konta biura (`user.role = 'staff'`) — do których klientów mają dostęp.
 *
 * Jedno źródło prawdy dla wszystkich bramek: kontekst klienta (middleware/staffGuard.js),
 * zlecenia (`checkOrderOwnership`, trasy `/position/*`), wyszukiwarka klientów
 * i lista zleceń biura (routes/staff.js) oraz panel admina („Dostęp biura").
 *
 * Tabela `staff_client_access` (migrations/add_staff_client_access.sql):
 *   • `client_user_id IS NULL` — wszyscy klienci organizacji, także założeni później;
 *   • `client_user_id = id`    — jeden klient.
 * Klient = konto z pustą rolą albo grupa-matka (`role = 'group'`). Konta podrzędne
 * grup to wiersze `group_user`, a nie `user`, więc na listach ich nie ma; zleceń
 * kont podrzędnych (`order.group_user_id`) biuro nie widzi (decyzja właściciela 4).
 *
 * ⚠️ Każdy błąd bazy = brak dostępu (wyjątek leci do wywołującego, który odmawia).
 * Zależności wstrzykiwane — testy działają bez MySQL-a.
 */

const STAFF_ROLE = 'staff';

/** Konta, które biuro może obsługiwać: klient bez roli albo grupa-matka. */
const CLIENT_ROLE_SQL = "(u.role IS NULL OR u.role = '' OR u.role = 'group')";

/** Dostęp konta biura (pierwszy `?`) do klienta `u`. */
const ACCESS_SQL = `EXISTS (
    SELECT 1 FROM staff_client_access a
    WHERE a.staff_user_id = ?
      AND a.organization_id = u.organization_id
      AND (a.client_user_id IS NULL OR a.client_user_id = u.id)
)`;

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_CLIENT_IDS = 5000;

function resolveDeps(deps = {}) {
    const resolved = { ...deps };
    if (!resolved.query) {
        resolved.query = async (sql, params) => {
            const { pool } = require('../db/core');
            const [rows] = await pool.query(sql, params);
            return rows;
        };
    }
    if (!resolved.withTransaction) {
        resolved.withTransaction = async (fn) => {
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
        };
    }
    return resolved;
}

function isStaffSession(sessionUser) {
    return !!(sessionUser && sessionUser.isStaff);
}

function toId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/** `%`, `_` i `\` z frazy użytkownika mają znaczyć siebie, a nie wzorzec LIKE. */
function likePattern(q) {
    return `%${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function isMissingTableError(err) {
    return !!err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);
}

async function canAccessClient(staffUserId, clientUserId, deps) {
    const staffId = toId(staffUserId);
    const clientId = toId(clientUserId);
    if (!staffId || !clientId) return false;
    const { query } = resolveDeps(deps);
    const rows = await query(
        `SELECT u.id FROM \`user\` u WHERE u.id = ? AND ${CLIENT_ROLE_SQL} AND ${ACCESS_SQL} LIMIT 1`,
        [clientId, staffId]
    );
    return Array.isArray(rows) && rows.length > 0;
}

/**
 * Dozwolony klient po identzie (wybór z wyszukiwarki / ostatnich klientów).
 * Ident w `user` nie jest unikalny — przy dwóch dozwolonych trafieniach odmawiamy,
 * zamiast zgadywać, za kogo biuro będzie pracować.
 */
async function findAllowedClientByIdent(staffUserId, ident, deps) {
    const staffId = toId(staffUserId);
    const wanted = String(ident || '').trim();
    if (!staffId || !wanted) return null;
    const { query } = resolveDeps(deps);
    const rows = await query(
        `SELECT u.id, u.ident, u.client_name, u.organization_id, o.ident AS org_ident
         FROM \`user\` u JOIN organization o ON o.id = u.organization_id
         WHERE u.ident = ? AND ${CLIENT_ROLE_SQL} AND ${ACCESS_SQL}
         LIMIT 2`,
        [wanted, staffId]
    );
    return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

/**
 * Właściciel zlecenia, jeśli biuro ma do niego dostęp; inaczej `null`.
 * Zlecenia kont podrzędnych grup (`group_user_id`) są poza zakresem biura.
 */
async function canAccessOrder(staffUserId, orderId, deps) {
    const staffId = toId(staffUserId);
    const id = toId(orderId);
    if (!staffId || !id) return null;
    const { query } = resolveDeps(deps);
    const rows = await query(
        `SELECT u.id AS userId, u.ident
         FROM \`order\` o JOIN \`user\` u ON u.id = o.user_id
         WHERE o.id = ? AND o.group_user_id IS NULL AND ${CLIENT_ROLE_SQL} AND ${ACCESS_SQL}
         LIMIT 1`,
        [id, staffId]
    );
    return Array.isArray(rows) && rows.length ? { userId: rows[0].userId, ident: rows[0].ident } : null;
}

/** Wyszukiwarka klientów biura: nazwa, ident, PIN, miasto. Pusta fraza = pierwsi klienci alfabetycznie. */
async function searchAllowedClients(staffUserId, q, limit, deps) {
    const staffId = toId(staffUserId);
    if (!staffId) return [];
    const max = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const phrase = String(q || '').trim().slice(0, 100);
    const { query } = resolveDeps(deps);
    const params = [staffId];
    let filter = '';
    if (phrase) {
        const like = likePattern(phrase);
        filter = 'AND (u.client_name LIKE ? OR u.ident LIKE ? OR u.pin LIKE ? OR u.city LIKE ?)';
        params.push(like, like, like, like);
    }
    params.push(max);
    const rows = await query(
        `SELECT u.id, u.ident, u.pin, u.client_name, u.city, u.role, o.ident AS org_ident, o.name AS org_name
         FROM \`user\` u JOIN organization o ON o.id = u.organization_id
         WHERE ${CLIENT_ROLE_SQL} AND ${ACCESS_SQL} ${filter}
         ORDER BY u.client_name, u.ident
         LIMIT ?`,
        params
    );
    return Array.isArray(rows) ? rows : [];
}

/** Z listy identów (np. „ostatni klienci" z `user.recent_clients`) zostają tylko dozwolone. */
async function filterAllowedIdents(staffUserId, idents, deps) {
    const staffId = toId(staffUserId);
    const list = [...new Set((idents || []).map((i) => String(i || '').trim()).filter(Boolean))];
    if (!staffId || !list.length) return [];
    const { query } = resolveDeps(deps);
    const rows = await query(
        `SELECT u.ident, u.client_name, o.ident AS org_ident
         FROM \`user\` u JOIN organization o ON o.id = u.organization_id
         WHERE u.ident IN (?) AND ${CLIENT_ROLE_SQL} AND ${ACCESS_SQL}`,
        [list, staffId]
    );
    return Array.isArray(rows) ? rows : [];
}

const ORDER_STATUSES = ['active', 'sent', 'canceled', 'pending_approval', 'correction'];
const ORDER_LIST_LIMIT = 100;

/**
 * Ostatnie zlecenia dozwolonych klientów (strona startowa biura).
 * Filtry: `client` (ident), `status`, `from`/`to` (RRRR-MM-DD, data założenia),
 * `mine` — tylko założone przez to konto (wymaga kolumn audytu: `withAudit`).
 */
async function listRecentOrders(staffUserId, filters = {}, deps) {
    const staffId = toId(staffUserId);
    if (!staffId) return [];
    const { query } = resolveDeps(deps);
    const where = [CLIENT_ROLE_SQL, ACCESS_SQL, 'o.group_user_id IS NULL'];
    const params = [staffId];
    const client = String(filters.client || '').trim();
    if (client) { where.push('u.ident = ?'); params.push(client); }
    if (ORDER_STATUSES.includes(filters.status)) { where.push('o.status = ?'); params.push(filters.status); }
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (isDate(filters.from)) { where.push('o.created_date >= ?'); params.push(`${filters.from} 00:00:00`); }
    if (isDate(filters.to)) { where.push('o.created_date < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(filters.to); }
    if (filters.mine && filters.withAudit) { where.push('o.created_by_staff_id = ?'); params.push(staffId); }
    params.push(ORDER_LIST_LIMIT);
    const rows = await query(
        `SELECT o.id, o.order_idx, o.commision, o.status,
                DATE_FORMAT(o.created_date, '%d.%m.%Y %H:%i') AS created_label,
                u.ident, u.client_name, org.ident AS org_ident
         FROM \`order\` o
         JOIN \`user\` u ON u.id = o.user_id
         JOIN organization org ON org.id = u.organization_id
         WHERE ${where.join(' AND ')}
         ORDER BY o.id DESC
         LIMIT ?`,
        params
    );
    return Array.isArray(rows) ? rows : [];
}

/* ------------------------------------------------------------------ */
/* Panel admina                                                        */
/* ------------------------------------------------------------------ */

/** `{ [organizationId]: { allClients, clientIds[] } }` — zapisany dostęp konta biura. */
async function getStaffAccess(staffUserId, deps) {
    const staffId = toId(staffUserId);
    if (!staffId) return {};
    const { query } = resolveDeps(deps);
    const rows = await query(
        'SELECT organization_id, client_user_id FROM staff_client_access WHERE staff_user_id = ?',
        [staffId]
    );
    const byOrg = {};
    for (const row of rows || []) {
        const entry = byOrg[row.organization_id] || (byOrg[row.organization_id] = { allClients: false, clientIds: [] });
        if (row.client_user_id == null) entry.allClients = true;
        else entry.clientIds.push(row.client_user_id);
    }
    return byOrg;
}

/** Klienci organizacji do zaznaczania w panelu admina (bez kont biura, adminów i demo). */
async function listOrganizationClients(organizationId, deps) {
    const orgId = toId(organizationId);
    if (!orgId) return [];
    const { query } = resolveDeps(deps);
    const rows = await query(
        `SELECT u.id, u.ident, u.pin, u.client_name, u.city, u.role
         FROM \`user\` u
         WHERE u.organization_id = ? AND ${CLIENT_ROLE_SQL}
         ORDER BY u.client_name, u.ident`,
        [orgId]
    );
    return Array.isArray(rows) ? rows : [];
}

/**
 * Walidacja zestawu z panelu. Wejście: `{ organizations: [{ id, allClients, clientIds }] }`.
 * Klucze błędów to klucze tłumaczeń (`staff.admin.error_*`).
 */
function normalizeAccessInput(body) {
    const errors = [];
    const entries = [];
    const list = Array.isArray(body?.organizations) ? body.organizations : null;
    if (!list) return { entries, errors: ['staff.admin.error_payload'] };

    const seenOrgs = new Set();
    let clientCount = 0;
    for (const item of list) {
        const organizationId = toId(item?.id);
        if (!organizationId || seenOrgs.has(organizationId)) {
            errors.push('staff.admin.error_payload');
            continue;
        }
        seenOrgs.add(organizationId);
        const allClients = item.allClients === true || item.allClients === 'true';
        const rawIds = Array.isArray(item.clientIds) ? item.clientIds : [];
        const clientIds = allClients ? [] : [...new Set(rawIds.map(toId))];
        if (clientIds.some((id) => id == null)) {
            errors.push('staff.admin.error_payload');
            continue;
        }
        if (!allClients && !clientIds.length) {
            errors.push('staff.admin.error_org_without_clients');
            continue;
        }
        clientCount += clientIds.length;
        entries.push({ organizationId, allClients, clientIds });
    }
    if (clientCount > MAX_CLIENT_IDS) errors.push('staff.admin.error_payload');
    return { entries: errors.length ? [] : entries, errors: [...new Set(errors)] };
}

/**
 * Podmiana CAŁEGO zestawu dostępu konta biura w jednej transakcji.
 * Klienci muszą należeć do wskazanej organizacji i być klientami (nie biuro/admin/demo).
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function replaceStaffAccess(staffUserId, entries, deps) {
    const staffId = toId(staffUserId);
    if (!staffId) return { ok: false, error: 'staff.admin.error_payload' };
    const { query, withTransaction } = resolveDeps(deps);

    const orgIds = entries.map((e) => e.organizationId);
    if (orgIds.length) {
        const orgs = await query('SELECT id FROM organization WHERE id IN (?)', [orgIds]);
        if ((orgs || []).length !== orgIds.length) return { ok: false, error: 'staff.admin.error_payload' };
    }
    const clientIds = entries.flatMap((e) => e.clientIds);
    if (clientIds.length) {
        const rows = await query(
            `SELECT u.id, u.organization_id FROM \`user\` u WHERE u.id IN (?) AND ${CLIENT_ROLE_SQL}`,
            [clientIds]
        );
        const orgOf = new Map((rows || []).map((r) => [r.id, r.organization_id]));
        for (const entry of entries) {
            if (entry.clientIds.some((id) => orgOf.get(id) !== entry.organizationId)) {
                return { ok: false, error: 'staff.admin.error_client_outside_org' };
            }
        }
    }

    const values = entries.flatMap((e) => (e.allClients
        ? [[staffId, e.organizationId, null]]
        : e.clientIds.map((id) => [staffId, e.organizationId, id])));

    await withTransaction(async (tx) => {
        await tx('DELETE FROM staff_client_access WHERE staff_user_id = ?', [staffId]);
        if (values.length) {
            await tx('INSERT INTO staff_client_access (staff_user_id, organization_id, client_user_id) VALUES ?', [values]);
        }
    });
    return { ok: true };
}

module.exports = {
    STAFF_ROLE,
    isStaffSession,
    isMissingTableError,
    canAccessClient,
    findAllowedClientByIdent,
    canAccessOrder,
    searchAllowedClients,
    filterAllowedIdents,
    listRecentOrders,
    ORDER_STATUSES,
    getStaffAccess,
    listOrganizationClients,
    normalizeAccessInput,
    replaceStaffAccess,
    _internal: { likePattern, CLIENT_ROLE_SQL, ACCESS_SQL }
};
