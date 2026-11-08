'use strict';

/**
 * Zlecenia a konto biura: `checkOrderOwnership` (podgląd, edycja, wysyłka,
 * anulowanie, powielenie — wszystkie trasy z `:orderId`) i `hasOrderAccess`
 * (trasy `/position/*`). Zależności podmieniane na obiektach modułów.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const staffAccess = require('../../services/staffAccess');
const ownerService = require('../../services/owner');
const staffAudit = require('../../services/staffAudit');
const { checkOrderOwnership, hasOrderAccess } = require('../loginMixture');

const staff = { userId: 10, ident: 'STAFF_ANNA', isStaff: true, isOwner: false, isAdmin: false };

function stub(obj, name, fn) {
    const original = obj[name];
    obj[name] = fn;
    return () => { obj[name] = original; };
}

function fakeRes() {
    const res = new EventEmitter();
    res.locals = {};
    res.statusCode = 200;
    res.redirectedTo = null;
    res.redirect = (to) => { res.redirectedTo = to; return res; };
    return res;
}

function fakeReq({ user = staff, context = null, orderId = '3000', method = 'GET', url = '/orders/order/3000' } = {}) {
    return { method, originalUrl: url, params: { orderId }, session: { user, context_user: context } };
}

async function runCheck(req, res) {
    let nextArg = 'not-called';
    await checkOrderOwnership(req, res, (arg) => { nextArg = arg; });
    return nextArg;
}

test('zlecenie niedozwolonego klienta: odmowa na każdej trasie zlecenia, kontekst bez zmian', async (t) => {
    const restore = [
        stub(staffAccess, 'canAccessOrder', async () => null),
        stub(ownerService, 'setContextUserByIdent', async () => { throw new Error('nie powinno być wołane'); })
    ];
    t.after(() => restore.forEach((r) => r()));
    for (const [method, url] of [
        ['GET', '/orders/order/3000'], ['GET', '/orders/edit/3000'], ['POST', '/orders/send/3000'],
        ['POST', '/orders/order/3000/cancel'], ['POST', '/orders/copy/3000']
    ]) {
        const res = fakeRes();
        const req = fakeReq({ method, url, context: { userId: 7, ident: 'KLIENT_A' } });
        assert.equal(await runCheck(req, res), 'not-called', url);
        assert.equal(res.redirectedTo, '/user/no-permission', url);
        assert.equal(req.session.context_user.ident, 'KLIENT_A', 'odmowa nie przełącza klienta');
    }
});

test('zlecenie dozwolonego klienta: kontekst wyrównany do właściciela zlecenia, pasek odświeżony', async (t) => {
    const calls = [];
    const restore = [
        stub(staffAccess, 'canAccessOrder', async (staffId, orderId) => { calls.push([staffId, orderId]); return { userId: 8, ident: 'KLIENT_B' }; }),
        stub(ownerService, 'setContextUserByIdent', async (req, ident) => {
            req.session.context_user = { userId: 8, ident, clientName: 'Klient B', organization: 'HKL', orgId: 3 };
            return req.session.context_user;
        })
    ];
    t.after(() => restore.forEach((r) => r()));
    const res = fakeRes();
    const req = fakeReq({ context: { userId: 7, ident: 'KLIENT_A' } });
    assert.equal(await runCheck(req, res), undefined, 'next() bez błędu');
    assert.deepEqual(calls, [[10, '3000']]);
    assert.equal(req.session.context_user.ident, 'KLIENT_B');
    assert.deepEqual(res.locals.staffContext, { ident: 'KLIENT_B', clientName: 'Klient B', organization: 'HKL' });
});

test('dwa konta o tym samym identzie: kontekst trafił na inne konto niż właściciel → odmowa i czyszczenie', async (t) => {
    let cleared = 0;
    const restore = [
        stub(staffAccess, 'canAccessOrder', async () => ({ userId: 8, ident: 'MAX' })),
        stub(ownerService, 'setContextUserByIdent', async (req) => { req.session.context_user = { userId: 99, ident: 'MAX' }; return req.session.context_user; }),
        stub(ownerService, 'clearContextUser', (req) => { cleared++; delete req.session.context_user; })
    ];
    t.after(() => restore.forEach((r) => r()));
    const res = fakeRes();
    const req = fakeReq();
    assert.equal(await runCheck(req, res), 'not-called');
    assert.equal(res.redirectedTo, '/user/no-permission');
    assert.equal(cleared, 1);
});

test('audyt: udana zmiana zlecenia przez biuro zapisuje „ostatnio zmienił"; nieudana i kopia — nie', async (t) => {
    const marks = [];
    const restore = [
        stub(staffAccess, 'canAccessOrder', async () => ({ userId: 7, ident: 'KLIENT_A' })),
        stub(staffAudit, 'markUpdatedByStaff', async (orderId, staffId) => { marks.push([orderId, staffId]); })
    ];
    t.after(() => restore.forEach((r) => r()));
    const ctx = { userId: 7, ident: 'KLIENT_A' };

    const ok = fakeRes();
    assert.equal(await hasOrderAccess(fakeReq({ method: 'POST', url: '/position/save', context: ctx }), ok, 3000), true);
    ok.statusCode = 200;
    ok.emit('finish');

    const failed = fakeRes();
    await hasOrderAccess(fakeReq({ method: 'PATCH', url: '/position/edit/save', context: ctx }), failed, 3001);
    failed.statusCode = 403;
    failed.emit('finish');

    const copy = fakeRes();
    await hasOrderAccess(fakeReq({ method: 'POST', url: '/orders/copy/3002', context: ctx }), copy, 3002);
    copy.emit('finish');

    assert.deepEqual(marks, [[3000, 10]]);
});

test('hasOrderAccess: owner/admin bez zapytań, brak sesji = odmowa', async (t) => {
    const restore = [stub(staffAccess, 'canAccessOrder', async () => { throw new Error('nie powinno być wołane'); })];
    t.after(() => restore.forEach((r) => r()));
    assert.equal(await hasOrderAccess(fakeReq({ user: { userId: 1, isAdmin: true, isOwner: true } }), fakeRes(), 5), true);
    assert.equal(await hasOrderAccess({ session: {} }, fakeRes(), 5), false);
    assert.equal(await hasOrderAccess(fakeReq({ user: { isGroupShop: true } }), fakeRes(), 5), false, 'sklep grupy bez id konta');
});
