'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTransactionalDeps } = require('../transactionalDb');

/** Records every query; `respond(sql, params)` supplies the mysql2-style result. */
function fakeConn(respond = () => [{ insertId: 3200 }]) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return respond(sql, params);
    }
  };
}

const ORDER_ARGS = ['CM-1', null, 3559, 'hi', 77, 0, null, null, null];

test('insertNewOrder without orderIdx leaves order_idx to the trigger', async () => {
  const conn = fakeConn();
  const id = await makeTransactionalDeps(conn).orders.insertNewOrder(...ORDER_ARGS);

  assert.equal(id, 3200);
  assert.doesNotMatch(conn.queries[0].sql, /order_idx/);
  assert.equal(conn.queries[0].params.length, 11);
});

test('insertNewOrder with orderIdx stores it and marks it external', async () => {
  const conn = fakeConn();
  await makeTransactionalDeps(conn).orders.insertNewOrder(...ORDER_ARGS, { orderIdx: '272905' });

  const { sql, params } = conn.queries[0];
  assert.match(sql, /group_user_id,\s*order_idx,\s*order_idx_external\)/);
  assert.match(sql, /\?,\?,1\)$/);
  assert.equal(params.length, 12);
  assert.equal(params[11], '272905');
  // Placeholders and params must line up, or MySQL shifts every column.
  assert.equal((sql.match(/\?/g) || []).length, params.length);
});

test('findOrderByIdx looks the number up for this client', async () => {
  const conn = fakeConn(() => [[{ id: 3195, status: 'sent' }]]);
  const found = await makeTransactionalDeps(conn).orders.findOrderByIdx(3559, '272905');

  assert.deepEqual(found, { id: 3195, status: 'sent' });
  assert.match(conn.queries[0].sql, /WHERE user_id = \? AND order_idx = \?/);
  assert.deepEqual(conn.queries[0].params, [3559, '272905']);

  const none = await makeTransactionalDeps(fakeConn(() => [[]])).orders.findOrderByIdx(3559, '1');
  assert.equal(none, null);
});

test('getOrderNo reads the number the order got', async () => {
  const conn = fakeConn(() => [[{ order_idx: '307' }]]);
  assert.equal(await makeTransactionalDeps(conn).orders.getOrderNo(3200), '307');
});

test('hasExternalOrderIdxColumn re-checks a missing column and caches a present one', async () => {
  let present = false;
  const conn = fakeConn(() => [present ? [{ 1: 1 }] : []]);
  const { orders } = makeTransactionalDeps(conn);

  assert.equal(await orders.hasExternalOrderIdxColumn(), false);
  assert.equal(await orders.hasExternalOrderIdxColumn(), false);
  assert.equal(conn.queries.length, 2);

  present = true;
  assert.equal(await orders.hasExternalOrderIdxColumn(), true);
  assert.equal(await orders.hasExternalOrderIdxColumn(), true);
  assert.equal(conn.queries.length, 3);
});
