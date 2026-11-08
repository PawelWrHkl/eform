/**
 * Konto biura (`user.role = 'staff'`) — bramka przy KAŻDYM żądaniu.
 *
 * 1. Kontekst klienta (`session.context_user`) jest honorowany przez
 *    `getCurrentUser` tylko dlatego, że tu sprawdzamy go za każdym razem:
 *    admin może odebrać klienta w trakcie sesji — wtedy kontekst znika
 *    i kolejne żądanie dotyczące jego zleceń kończy się odmową.
 * 2. Trasy, których biuro nie dostaje mimo zalogowania: ustawienia, hasła
 *    i pracownicy klienta, panel grupy, przełączanie organizacji, cenniki PDF,
 *    faktury, panel admina (ten blokuje też `requireAdmin`).
 *
 * Montowane w server.js przed `applySubPriceLocals` i routerami.
 */

const staffAccess = require('../services/staffAccess');
const ownerService = require('../services/owner');
const { log } = require('../utils/logging');

const BLOCKED_PREFIXES = [
    '/admin',
    '/group',
    '/panel',
    '/invoices',
    '/api/v1/invoices',
    '/org/customers',
    '/set-organization',
    '/set-last-user',
    '/user/edit-user',
    '/user/update-user',
    '/user/org-pwd',
    '/orders/userOrders',
    '/orders/organization-orders',
    '/orders/clear-context'
];

// Pracownicy klienta: /user/employee-panel, /user/employees, /user/employee/:id …
const BLOCKED_RAW_PREFIXES = ['/user/employee'];

function isBlockedForStaff(path, query = {}) {
    const p = String(path || '');
    if (BLOCKED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) return true;
    if (BLOCKED_RAW_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
    // Wyszukiwarka zleceń z `organization=true` przeszukuje całą organizację konta.
    return p === '/orders/search' && !!query.organization && query.organization !== 'false';
}

function deny(req, res, status, messageKey) {
    const message = typeof res.__ === 'function' ? res.__(messageKey) : messageKey;
    if (req.method === 'GET' && req.accepts('html') && !req.xhr) {
        return res.status(status).render('error.njk', { message });
    }
    return res.status(status).json({ success: false, message });
}

function createStaffGuard(deps = {}) {
    const access = deps.staffAccess || staffAccess;
    const owner = deps.ownerService || ownerService;
    const logFn = deps.log || log;

    return async function staffGuard(req, res, next) {
        const user = req.session?.user;
        if (!user?.isStaff) return next();
        res.locals.isStaff = true;

        if (isBlockedForStaff(req.path, req.query)) {
            return deny(req, res, 403, 'staff.blocked');
        }

        const ctx = req.session.context_user;
        if (ctx) {
            let allowed = false;
            try {
                allowed = await access.canAccessClient(user.userId, ctx.userId);
            } catch (err) {
                logFn(`[staff] ${user.ident}: nie udało się sprawdzić dostępu do ${ctx.ident}:`, err.message);
                return deny(req, res, 503, 'staff.access_check_failed');
            }
            if (!allowed) {
                logFn(`[staff] ${user.ident}: brak dostępu do klienta ${ctx.ident} — kontekst wyczyszczony (${req.method} ${req.originalUrl})`);
                owner.clearContextUser(req);
            }
        }

        // Okno pozycji (staff/positionDialog.js): formularz w trybie surowym, bez nawigacji strony.
        res.locals.rawMode = req.query?.raw === '1';

        const current = req.session.context_user;
        res.locals.staffContext = current
            ? { ident: current.ident, clientName: current.clientName, organization: current.organization }
            : null;
        return next();
    };
}

module.exports = { createStaffGuard, staffGuard: createStaffGuard(), isBlockedForStaff, BLOCKED_PREFIXES };
