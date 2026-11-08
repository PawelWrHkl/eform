/**
 * Konto biura (`user.role = 'staff'`) — strona startowa, wyszukiwarka klientów
 * i wybór klienta, za którego biuro pracuje (`session.context_user`).
 * Dostęp do klientów: services/staffAccess.js; kontekst sprawdzany przy każdym
 * żądaniu w middleware/staffGuard.js.
 */

const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/loginMixture');
const staffAccess = require('../services/staffAccess');
const staffAudit = require('../services/staffAudit');
const ownerService = require('../services/owner');
const { log } = require('../utils/logging');

function requireStaff(req, res, next) {
    if (req.session.user?.isStaff) return next();
    if (req.method === 'GET' && req.accepts('html') && !req.xhr) return res.redirect('/user/no-permission');
    return res.status(403).json({ success: false });
}

router.use(requireLogin, requireStaff);

router.get('/', async (req, res) => {
    const filters = {
        client: String(req.query.client || '').trim(),
        status: String(req.query.status || ''),
        from: String(req.query.from || ''),
        to: String(req.query.to || ''),
        mine: req.query.mine === '1'
    };
    const withAudit = await staffAudit.supportsStaffAudit();
    let orders = [];
    let errorKey = null;
    try {
        orders = await staffAccess.listRecentOrders(req.session.user.userId, { ...filters, withAudit });
    } catch (err) {
        errorKey = staffAccess.isMissingTableError(err) ? 'staff.admin.migration_missing' : 'staff.admin.error_server';
        log(`[staff] lista zleceń ${req.session.user.ident}:`, err.message);
    }
    const audit = withAudit ? await staffAudit.getStaffAudit(orders.map((o) => o.id)) : {};
    res.render('staff/home.njk', {
        orders,
        audit,
        filters,
        statuses: staffAccess.ORDER_STATUSES,
        withAudit,
        errorKey
    });
});

router.get('/api/clients', async (req, res) => {
    try {
        const rows = await staffAccess.searchAllowedClients(req.session.user.userId, req.query.q, req.query.limit);
        return res.json({
            success: true,
            clients: rows.map((c) => ({
                ident: c.ident,
                name: c.client_name,
                pin: c.pin,
                city: c.city,
                organization: c.org_ident,
                isGroup: c.role === 'group'
            }))
        });
    } catch (err) {
        log(`[staff] wyszukiwarka klientów ${req.session.user.ident}:`, err.message);
        return res.status(500).json({ success: false, message: res.__('staff.admin.error_server') });
    }
});

/** Wybór klienta: kontrola dostępu, potem kontekst (+ lista ostatnich klientów). */
router.post('/context', async (req, res) => {
    const staff = req.session.user;
    const ident = String(req.body?.ident || '').trim();
    try {
        const client = await staffAccess.findAllowedClientByIdent(staff.userId, ident);
        if (!client) {
            log(`[staff] ${staff.ident}: odmowa kontekstu dla „${ident}" (brak dostępu)`);
            return res.status(403).json({ success: false, message: res.__('staff.client_denied') });
        }
        const ctx = await ownerService.setContextUserByIdent(req, client.ident);
        if (!ctx || ctx.userId !== client.id) {
            ownerService.clearContextUser(req);
            return res.status(403).json({ success: false, message: res.__('staff.client_denied') });
        }
        log(`[staff] ${staff.ident} pracuje dla ${ctx.ident} (${ctx.organization})`);
        return res.json({ success: true, client: { ident: ctx.ident, name: ctx.clientName, organization: ctx.organization } });
    } catch (err) {
        log(`[staff] ${staff.ident}: błąd wyboru klienta „${ident}":`, err.message);
        return res.status(500).json({ success: false, message: res.__('staff.admin.error_server') });
    }
});

router.post('/context/clear', (req, res) => {
    ownerService.clearContextUser(req);
    return res.json({ success: true });
});

module.exports = router;
