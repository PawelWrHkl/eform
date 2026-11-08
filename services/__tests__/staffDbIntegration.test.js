'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise.js');

test('moduły biura korzystają z połączenia udostępnianego przez db/core', async (t) => {
    const calls = [];
    let failInsert = false;
    const conn = {
        async beginTransaction() { calls.push('begin'); },
        async query(sql) {
            calls.push(sql);
            if (failInsert && sql.startsWith('INSERT')) throw new Error('insert failed');
            return [{ affectedRows: 1 }];
        },
        async commit() { calls.push('commit'); },
        async rollback() { calls.push('rollback'); },
        release() { calls.push('release'); }
    };
    const pool = {
        async query(sql) {
            calls.push(sql);
            if (sql.includes('information_schema')) return [[{ n: 2 }]];
            if (sql.includes('FROM organization')) return [[{ id: 3 }]];
            return [[{ organization_id: 3, client_user_id: null }]];
        },
        async getConnection() { return conn; }
    };
    t.mock.method(mysql, 'createPool', () => pool);

    // Prawdziwy adapter db/core; atrapa zastępuje wyłącznie sterownik MySQL.
    const access = require('../staffAccess');
    const audit = require('../staffAudit');
    assert.deepEqual(await access.getStaffAccess(10), {
        3: { allClients: true, clientIds: [] }
    });

    const entries = [{ organizationId: 3, allClients: true, clientIds: [] }];
    assert.deepEqual(await access.replaceStaffAccess(10, entries), { ok: true });
    assert.ok(calls.some((sql) => sql.startsWith('DELETE FROM staff_client_access')));
    assert.ok(calls.some((sql) => sql.startsWith('INSERT INTO staff_client_access')));
    assert.deepEqual(calls.slice(-2), ['commit', 'release']);

    failInsert = true;
    await assert.rejects(access.replaceStaffAccess(10, entries), /insert failed/);
    assert.deepEqual(calls.slice(-2), ['rollback', 'release']);

    assert.equal(await audit.supportsStaffAudit(), true);
    await audit.markCreatedByStaff(20, 10);
    assert.ok(calls.some((sql) => sql.startsWith('UPDATE `order` SET created_by_staff_id')));
});
