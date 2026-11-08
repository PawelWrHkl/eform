'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStaffGuard, isBlockedForStaff } = require('../staffGuard');

function fakeRes() {
    const res = { locals: {}, statusCode: 200, body: null, view: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.render = (view, data) => { res.view = view; res.body = data; return res; };
    res.__ = (key) => key;
    return res;
}

function fakeReq({ user, context = null, path = '/orders', method = 'GET', html = false, query = {} } = {}) {
    return {
        method,
        path,
        originalUrl: path,
        query,
        xhr: false,
        accepts: (type) => html && type === 'html',
        session: { user, context_user: context }
    };
}

const staff = { userId: 10, ident: 'STAFF_ANNA', isStaff: true, isOwner: false, isAdmin: false };
const klientA = { userId: 7, ident: 'KLIENT_A', clientName: 'Klient A', organization: 'HKL' };

function guard({ allowed = true, error = null } = {}) {
    const calls = { access: [], cleared: 0, logs: [] };
    const middleware = createStaffGuard({
        staffAccess: {
            canAccessClient: async (staffId, clientId) => {
                calls.access.push([staffId, clientId]);
                if (error) throw error;
                return allowed;
            }
        },
        ownerService: { clearContextUser: (req) => { calls.cleared++; delete req.session.context_user; } },
        log: (...args) => calls.logs.push(args.join(' '))
    });
    return { middleware, calls };
}

async function run(middleware, req, res) {
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    return nextCalled;
}

test('trasy zablokowane dla biura: panel admina, grupy, ustawienia i hasła klienta, organizacja, faktury', () => {
    for (const path of [
        '/admin', '/admin/users', '/admin/order-corrections/open/5', '/group/panel', '/group/context/3',
        '/panel', '/panel/password', '/panel/pricelists/24/base', '/set-organization/5', '/set-last-user',
        '/user/edit-user', '/user/update-user', '/user/employees', '/user/employee/add', '/user/employee-panel',
        '/user/org-pwd', '/invoices', '/api/v1/invoices/orders/5/end-client', '/org/customers',
        '/orders/userOrders', '/orders/organization-orders', '/orders/clear-context'
    ]) {
        assert.equal(isBlockedForStaff(path), true, path);
    }
    assert.equal(isBlockedForStaff('/orders/search', { organization: 'true' }), true, 'wyszukiwarka całej organizacji');
});

test('trasy pracy za klienta zostają otwarte', () => {
    for (const path of [
        '/', '/staff', '/staff/api/clients', '/orders', '/orders/add-order', '/orders/order/5', '/orders/send/5',
        '/orders/copy/5', '/position/save', '/position/12/edit/', '/user/owner/', '/user/uid', '/user/name',
        '/address/list', '/recent-clients', '/context-user', '/administracja-nie-istnieje'
    ]) {
        assert.equal(isBlockedForStaff(path), false, path);
    }
    assert.equal(isBlockedForStaff('/orders/search', { organization: 'false' }), false);
    assert.equal(isBlockedForStaff('/orders/search', {}), false);
});

test('konto inne niż biuro przechodzi bez zmian (bez zapytań do bazy)', async () => {
    const { middleware, calls } = guard();
    const res = fakeRes();
    const next = await run(middleware, fakeReq({ user: { userId: 1, isAdmin: true, isOwner: true }, context: klientA, path: '/admin' }), res);
    assert.equal(next, true);
    assert.equal(calls.access.length, 0);
    assert.equal(res.locals.isStaff, undefined);
});

test('biuro na /admin: odmowa 403 (strona HTML dla GET, JSON dla fetch)', async () => {
    const { middleware } = guard();
    const html = fakeRes();
    assert.equal(await run(middleware, fakeReq({ user: staff, path: '/admin', html: true }), html), false);
    assert.equal(html.statusCode, 403);
    assert.equal(html.view, 'error.njk');

    const json = fakeRes();
    assert.equal(await run(middleware, fakeReq({ user: staff, path: '/set-organization/5', method: 'GET' }), json), false);
    assert.equal(json.statusCode, 403);
    assert.deepEqual(json.body, { success: false, message: 'staff.blocked' });
});

test('dozwolony klient: kontekst zostaje, pasek „Pracujesz dla" dostaje dane', async () => {
    const { middleware, calls } = guard({ allowed: true });
    const res = fakeRes();
    const req = fakeReq({ user: staff, context: { ...klientA } });
    assert.equal(await run(middleware, req, res), true);
    assert.deepEqual(calls.access, [[10, 7]]);
    assert.equal(req.session.context_user.ident, 'KLIENT_A');
    assert.deepEqual(res.locals.staffContext, { ident: 'KLIENT_A', clientName: 'Klient A', organization: 'HKL' });
});

test('admin odebrał klienta w trakcie sesji: kolejne żądanie czyści kontekst', async () => {
    const { middleware, calls } = guard({ allowed: false });
    const res = fakeRes();
    const req = fakeReq({ user: staff, context: { ...klientA }, path: '/orders/order/3000' });
    assert.equal(await run(middleware, req, res), true, 'żądanie idzie dalej — bez kontekstu, więc bramki zlecenia odmówią');
    assert.equal(calls.cleared, 1);
    assert.equal(req.session.context_user, undefined);
    assert.equal(res.locals.staffContext, null);
    assert.match(calls.logs[0], /brak dostępu do klienta KLIENT_A/);
});

test('błąd bazy przy sprawdzaniu dostępu: odmowa 503, kontekst nietknięty', async () => {
    const { middleware, calls } = guard({ error: new Error('ECONNREFUSED') });
    const res = fakeRes();
    const req = fakeReq({ user: staff, context: { ...klientA } });
    assert.equal(await run(middleware, req, res), false);
    assert.equal(res.statusCode, 503);
    assert.equal(calls.cleared, 0);
});
