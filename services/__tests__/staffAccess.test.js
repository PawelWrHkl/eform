'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const staffAccess = require('../staffAccess');

/** Atrapa bazy: zapisuje zapytania, zwraca kolejne odpowiedzi z kolejki (albo rzuca). */
function fakeDb(...responses) {
    const calls = [];
    const query = async (sql, params) => {
        calls.push({ sql, params });
        const next = responses.length ? responses.shift() : [];
        if (next instanceof Error) throw next;
        return next;
    };
    const txCalls = [];
    const withTransaction = async (fn) => fn(async (sql, params) => { txCalls.push({ sql, params }); return []; });
    return { deps: { query, withTransaction }, calls, txCalls };
}

test('canAccessClient: dostęp tylko przy trafieniu w bazie; puste/niepoprawne id bez zapytania', async () => {
    const yes = fakeDb([{ id: 5 }]);
    assert.equal(await staffAccess.canAccessClient(10, 5, yes.deps), true);
    assert.deepEqual(yes.calls[0].params, [5, 10], 'najpierw klient, potem konto biura');
    assert.match(yes.calls[0].sql, /staff_client_access/);
    assert.match(yes.calls[0].sql, /client_user_id IS NULL OR a\.client_user_id = u\.id/, 'organizacja = także przyszli klienci');

    const no = fakeDb([]);
    assert.equal(await staffAccess.canAccessClient(10, 6, no.deps), false);

    const none = fakeDb();
    assert.equal(await staffAccess.canAccessClient(null, 5, none.deps), false);
    assert.equal(await staffAccess.canAccessClient(10, 'abc', none.deps), false);
    assert.equal(none.calls.length, 0);
});

test('błąd bazy nie daje dostępu — wyjątek idzie do wywołującego (fail closed)', async () => {
    const broken = fakeDb(Object.assign(new Error('ER_NO_SUCH_TABLE'), { code: 'ER_NO_SUCH_TABLE' }));
    await assert.rejects(() => staffAccess.canAccessClient(10, 5, broken.deps));
    assert.equal(staffAccess.isMissingTableError({ code: 'ER_NO_SUCH_TABLE' }), true);
    assert.equal(staffAccess.isMissingTableError(new Error('x')), false);
});

test('canAccessOrder: właściciel zlecenia albo null; zlecenia kont podrzędnych grup poza zakresem', async () => {
    const hit = fakeDb([{ userId: 7, ident: 'KLIENT_A' }]);
    assert.deepEqual(await staffAccess.canAccessOrder(10, 3000, hit.deps), { userId: 7, ident: 'KLIENT_A' });
    assert.deepEqual(hit.calls[0].params, [3000, 10]);
    assert.match(hit.calls[0].sql, /o\.group_user_id IS NULL/);

    const miss = fakeDb([]);
    assert.equal(await staffAccess.canAccessOrder(10, 3001, miss.deps), null);
    assert.equal(await staffAccess.canAccessOrder(10, '1 OR 1=1', miss.deps), null);
});

test('findAllowedClientByIdent: dwa dozwolone konta o tym samym identzie = odmowa', async () => {
    const one = fakeDb([{ id: 7, ident: 'A' }]);
    assert.deepEqual(await staffAccess.findAllowedClientByIdent(10, ' A ', one.deps), { id: 7, ident: 'A' });
    assert.deepEqual(one.calls[0].params, ['A', 10]);

    const two = fakeDb([{ id: 7, ident: 'A' }, { id: 8, ident: 'A' }]);
    assert.equal(await staffAccess.findAllowedClientByIdent(10, 'A', two.deps), null);
});

test('searchAllowedClients: fraza po nazwie/identzie/PIN-ie/mieście, LIKE bez wzorców użytkownika, limit przycięty', async () => {
    const db = fakeDb([{ id: 1 }]);
    await staffAccess.searchAllowedClients(10, '50%_off', 500, db.deps);
    const { sql, params } = db.calls[0];
    assert.match(sql, /u\.client_name LIKE \? OR u\.ident LIKE \? OR u\.pin LIKE \? OR u\.city LIKE \?/);
    assert.deepEqual(params, [10, '%50\\%\\_off%', '%50\\%\\_off%', '%50\\%\\_off%', '%50\\%\\_off%', 50]);

    const empty = fakeDb([]);
    await staffAccess.searchAllowedClients(10, '', undefined, empty.deps);
    assert.deepEqual(empty.calls[0].params, [10, 20], 'pusta fraza: bez filtra, domyślny limit');
    assert.doesNotMatch(empty.calls[0].sql, /LIKE/);
});

test('listy klientów pomijają konta biura, adminów i demo (tylko klient bez roli albo grupa-matka)', () => {
    assert.match(staffAccess._internal.CLIENT_ROLE_SQL, /u\.role IS NULL OR u\.role = '' OR u\.role = 'group'/);
});

test('normalizeAccessInput: organizacja „wszyscy, także przyszli" albo lista klientów', () => {
    const ok = staffAccess.normalizeAccessInput({
        organizations: [
            { id: 3, allClients: true, clientIds: [1, 2] },
            { id: '5', allClients: false, clientIds: ['7', 7, 8] }
        ]
    });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.entries, [
        { organizationId: 3, allClients: true, clientIds: [] },
        { organizationId: 5, allClients: false, clientIds: [7, 8] }
    ]);

    assert.deepEqual(staffAccess.normalizeAccessInput({ organizations: [] }), { entries: [], errors: [] }, 'pusty zestaw = odebranie dostępu');
    assert.deepEqual(staffAccess.normalizeAccessInput({}).errors, ['staff.admin.error_payload']);
    assert.deepEqual(staffAccess.normalizeAccessInput({ organizations: [{ id: 3, clientIds: [] }] }).errors, ['staff.admin.error_org_without_clients']);
    assert.deepEqual(staffAccess.normalizeAccessInput({ organizations: [{ id: 3, clientIds: ['x'] }] }).errors, ['staff.admin.error_payload']);
    assert.deepEqual(staffAccess.normalizeAccessInput({ organizations: [{ id: 3, allClients: true }, { id: 3, allClients: true }] }).errors, ['staff.admin.error_payload']);
});

test('replaceStaffAccess: klient spoza organizacji odrzucony, bez zapisu', async () => {
    const db = fakeDb([{ id: 5 }], [{ id: 7, organization_id: 4 }]);
    const result = await staffAccess.replaceStaffAccess(10, [{ organizationId: 5, allClients: false, clientIds: [7] }], db.deps);
    assert.deepEqual(result, { ok: false, error: 'staff.admin.error_client_outside_org' });
    assert.equal(db.txCalls.length, 0);
});

test('replaceStaffAccess: podmiana całego zestawu w transakcji (DELETE + jeden INSERT)', async () => {
    const db = fakeDb([{ id: 3 }, { id: 5 }], [{ id: 7, organization_id: 5 }, { id: 8, organization_id: 5 }]);
    const result = await staffAccess.replaceStaffAccess(10, [
        { organizationId: 3, allClients: true, clientIds: [] },
        { organizationId: 5, allClients: false, clientIds: [7, 8] }
    ], db.deps);
    assert.deepEqual(result, { ok: true });
    assert.equal(db.txCalls.length, 2);
    assert.match(db.txCalls[0].sql, /^DELETE FROM staff_client_access WHERE staff_user_id = \?/);
    assert.deepEqual(db.txCalls[0].params, [10]);
    assert.deepEqual(db.txCalls[1].params, [[[10, 3, null], [10, 5, 7], [10, 5, 8]]]);
});

test('replaceStaffAccess: pusty zestaw tylko kasuje', async () => {
    const db = fakeDb();
    assert.deepEqual(await staffAccess.replaceStaffAccess(10, [], db.deps), { ok: true });
    assert.equal(db.txCalls.length, 1);
    assert.match(db.txCalls[0].sql, /^DELETE/);
});

test('getStaffAccess: wiersze → mapa organizacji', async () => {
    const db = fakeDb([
        { organization_id: 3, client_user_id: null },
        { organization_id: 5, client_user_id: 7 },
        { organization_id: 5, client_user_id: 8 }
    ]);
    assert.deepEqual(await staffAccess.getStaffAccess(10, db.deps), {
        3: { allClients: true, clientIds: [] },
        5: { allClients: false, clientIds: [7, 8] }
    });
});
