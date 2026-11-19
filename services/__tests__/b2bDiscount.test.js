'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const b2b = require('../b2bDiscount');

/** Zlecenie zwykłego klienta Luxan (org 5), szkic, bez rabatu. */
function orderRow(overrides = {}) {
  return {
    id: 900, status: 'active', group_user_id: null,
    b2b_discount_points: '0.00', b2b_discount_amount: '0.00', b2b_discount_amount_pct: '0.000000',
    client_id: 667, client_role: null, client_ident: 'JC', client_org_id: 5, org_ident: 'LUXANGMBH',
    ...overrides
  };
}

const owner = { userId: 10, isOwner: true, orgId: 5 };

/** Transakcja na atrapie: kolejne odpowiedzi według początku zapytania, wszystkie wywołania zapisane. */
function fakeTx({ row = orderRow(), savedTotal = 0 } = {}) {
  const calls = [];
  const withTransaction = async (fn) => fn(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM `order` o')) return row ? [row] : [];
    if (sql.includes('SUM(total_price_sub)')) return [{ total: String(savedTotal) }];
    return { affectedRows: 1 };
  });
  return { withTransaction, calls };
}

test('kto nadaje: owner organizacji klienta i admin; nikt inny', () => {
  const row = orderRow();
  assert.equal(b2b.canManage(owner, row), true);
  assert.equal(b2b.canManage({ isAdmin: true, isOwner: true, orgId: 3 }, row), true, 'admin w kontekście klienta');
  assert.equal(b2b.canManage({ ...owner, orgId: 1 }, row), false, 'owner innej organizacji (Cozy)');
  assert.equal(b2b.canManage({ userId: 667, orgId: 5 }, row), false, 'sam klient');
  assert.equal(b2b.canManage({ ...owner, isStaff: true }, row), false, 'biuro');
  assert.equal(b2b.canManage({ ...owner, isEmployee: true }, row), false, 'pracownik');
  assert.equal(b2b.canManage({ ...owner, isGroup: true }, row), false, 'grupa');
  assert.equal(b2b.canManage(null, row), false);
});

test('komu: zwykłe konto organizacji spoza HKL — nie owner, nie grupa, nie zlecenie konta podrzędnego', () => {
  assert.equal(b2b.isEligible(orderRow()), true);
  assert.equal(b2b.isEligible(orderRow({ client_org_id: 3, org_ident: 'HKL' })), false, 'HKL nie ma cen SUB___');
  assert.equal(b2b.isEligible(orderRow({ client_ident: 'luxangmbh' })), false, 'konto ownera');
  assert.equal(b2b.isEligible(orderRow({ client_role: 'group' })), false);
  assert.equal(b2b.isEligible(orderRow({ group_user_id: 4 })), false, 'rabat grupy');
  assert.equal(b2b.isEligible(null), false);
  assert.equal(b2b.canManage({ isAdmin: true }, orderRow({ group_user_id: 4 })), false, 'admin też nie');
});

test('walidacja: przecinek i kropka, puste = 0, zakresy', () => {
  assert.deepEqual(b2b.validateInput({ points: '3,5', amount: '120.456' }), { points: 3.5, amount: 120.46 });
  assert.deepEqual(b2b.validateInput({}), { points: 0, amount: 0 });
  assert.equal(b2b.validateInput({ points: -1 }).error, 'order.b2b_discount_points_invalid');
  assert.equal(b2b.validateInput({ points: '101' }).error, 'order.b2b_discount_points_invalid');
  assert.equal(b2b.validateInput({ points: 'abc' }).error, 'order.b2b_discount_points_invalid');
  assert.equal(b2b.validateInput({ amount: '-5' }).error, 'order.b2b_discount_amount_invalid');
  assert.equal(b2b.validateInput({ amount: '1e3' }).error, 'order.b2b_discount_amount_invalid');
});

test('kwota → procent: podstawa bez dotychczasowego rabatu kwotowego, kwota nie większa od wartości', () => {
  assert.equal(b2b.baseBeforeAmount(900, 10), 1000, 'zapisane 900 to już 1000 po 10% rabatu kwotowego');
  assert.equal(b2b.baseBeforeAmount('500.00', 0), 500);
  assert.equal(b2b.amountToPercent(50, 1000), 5);
  assert.equal(b2b.amountToPercent(0, 1000), 0);
  assert.equal(b2b.amountToPercent(1000, 1000), null);
  assert.equal(b2b.amountToPercent(10, 0), null);
});

test('zapis: sam procent — UPDATE + wpis w historii (kto, przed, po)', async () => {
  const tx = fakeTx();
  const res = await b2b.save({ orderId: 900, sessionUser: owner, body: { points: '3' } }, { withTransaction: tx.withTransaction });
  assert.equal(res.status, 200);
  assert.deepEqual({ ...res.body }, { success: true, changed: true, needsSecondPass: false, points: 3, amount: 0, amountPct: 0 });
  const update = tx.calls.find((c) => c.sql.startsWith('UPDATE'));
  assert.deepEqual(update.params, [3, 0, 0, 900]);
  const log = tx.calls.find((c) => c.sql.includes('INSERT INTO order_b2b_discount_log'));
  assert.deepEqual(log.params, [900, 10, 0, 0, 0, 3, 0, 0]);
  assert.ok(tx.calls[0].sql.endsWith('FOR UPDATE'), 'wiersz zlecenia zablokowany na czas zapisu');
});

test('zapis: nowe punkty + kwota — najpierw punkty (needsSecondPass), drugi zapis zamienia kwotę na procent', async () => {
  const first = fakeTx();
  const res1 = await b2b.save({ orderId: 900, sessionUser: owner, body: { points: 3, amount: 50 } }, { withTransaction: first.withTransaction });
  assert.equal(res1.body.needsSecondPass, true);
  assert.equal(res1.body.amountPct, 0, 'podstawy kwoty jeszcze nie ma');
  assert.ok(!first.calls.some((c) => c.sql.includes('SUM(total_price_sub)')));

  // Po przeliczeniu: punkty już zapisane, pozycje warte 1000 (bez rabatu kwotowego).
  const second = fakeTx({ row: orderRow({ b2b_discount_points: '3.00', b2b_discount_amount: '50.00' }), savedTotal: 1000 });
  const res2 = await b2b.save({ orderId: 900, sessionUser: owner, body: { points: 3, amount: 50 } }, { withTransaction: second.withTransaction });
  assert.equal(res2.body.needsSecondPass, false);
  assert.equal(res2.body.amountPct, 5);
  assert.equal(res2.body.changed, true);
});

test('zapis: ponowne „Zastosuj” po zmianie pozycji liczy procent kwoty od nowa; bez zmian nic nie zapisuje', async () => {
  // Rabat kwotowy 50 przy 5% — po dodaniu pozycji zapisane 1900 to 2000 przed rabatem kwotowym.
  const row = orderRow({ b2b_discount_points: '3.00', b2b_discount_amount: '50.00', b2b_discount_amount_pct: '5.000000' });
  const tx = fakeTx({ row, savedTotal: 1900 });
  const res = await b2b.save({ orderId: 900, sessionUser: owner, body: { points: 3, amount: 50 } }, { withTransaction: tx.withTransaction });
  assert.equal(res.body.amountPct, 2.5);

  const same = fakeTx({ row, savedTotal: 950 });
  const res2 = await b2b.save({ orderId: 900, sessionUser: owner, body: { points: 3, amount: 50 } }, { withTransaction: same.withTransaction });
  assert.equal(res2.body.changed, false);
  assert.ok(!same.calls.some((c) => c.sql.startsWith('UPDATE') || c.sql.includes('INSERT')));
});

test('zapis: odmowy — klient 403, wysłane 409, kwota ponad wartość 400, zły procent 400 bez zapytań', async () => {
  const client = await b2b.save({ orderId: 900, sessionUser: { userId: 667, orgId: 5 }, body: { points: 3 } }, { withTransaction: fakeTx().withTransaction });
  assert.equal(client.status, 403);
  assert.equal(client.body.messageKey, 'order.b2b_discount_forbidden');

  const otherOrg = await b2b.save({ orderId: 900, sessionUser: { ...owner, orgId: 1 }, body: { points: 3 } }, { withTransaction: fakeTx().withTransaction });
  assert.equal(otherOrg.status, 403);

  for (const status of ['sent', 'correction', 'canceled', 'pending_approval']) {
    const res = await b2b.save({ orderId: 900, sessionUser: owner, body: { points: 3 } }, { withTransaction: fakeTx({ row: orderRow({ status }) }).withTransaction });
    assert.equal(res.status, 409, status);
  }

  const tooHigh = await b2b.save({ orderId: 900, sessionUser: owner, body: { amount: 2000 } }, { withTransaction: fakeTx({ savedTotal: 1000 }).withTransaction });
  assert.equal(tooHigh.status, 400);
  assert.equal(tooHigh.body.messageKey, 'order.b2b_discount_amount_too_high');

  const tx = fakeTx();
  const bad = await b2b.save({ orderId: 900, sessionUser: owner, body: { points: 'x' } }, { withTransaction: tx.withTransaction });
  assert.equal(bad.status, 400);
  assert.equal(tx.calls.length, 0);
});

test('odczyt do liczenia cen: wartości z bazy, zero gdy nie dotyczy albo baza bez kolumn', async () => {
  const select = async () => [orderRow({ b2b_discount_points: '3.00', b2b_discount_amount_pct: '4.500000' })];
  assert.deepEqual(await b2b.resolveForOrder(900, { select }), { points: 3, amount: 0, amountPct: 4.5 });
  assert.deepEqual(await b2b.resolveForOrder(900, { select: async () => [orderRow({ b2b_discount_points: '3', group_user_id: 4 })] }), { points: 0, amount: 0, amountPct: 0 });
  // selectQuery zwraca false przy błędzie SQL (np. przed migracją)
  assert.deepEqual(await b2b.resolveForOrder(900, { select: async () => false }), { points: 0, amount: 0, amountPct: 0 });
  assert.equal(b2b.stampOf({ points: 3, amountPct: 4.5 }), '3|4.5');
  assert.equal(b2b.stampOf(null), '0|0');
});

test('okno: stawki z cennika z zapisanych pozycji (także podwójnie zakodowany JSON), kwota bieżąca', async () => {
  const positions = [
    { json_parameters: JSON.stringify(JSON.stringify({ SUB___CENA_RABAT: 0.7 })), total_price_sub: '450.00' },
    { json_parameters: JSON.stringify({ SUB___CENA_RABAT: '0.55' }), total_price_sub: '450.00' },
    { json_parameters: 'zepsute', total_price_sub: '0' }
  ];
  const select = async (sql) => (sql.includes('FROM `order` o')
    ? [orderRow({ b2b_discount_points: '3.00', b2b_discount_amount: '100.00', b2b_discount_amount_pct: '10.000000' })]
    : positions);
  const info = await b2b.getInfo(900, owner, { select });
  assert.deepEqual(info.listRates, [70, 55]);
  assert.equal(info.baseAfterPercent, 1000, '900 zapisane po 10% rabatu kwotowego');
  assert.equal(info.currentAmount, 100);
  assert.equal(info.editable, true);
  assert.equal(info.pending, false);

  assert.deepEqual(await b2b.getInfo(900, { userId: 667, orgId: 5 }, { select }), { canManage: false });
});
