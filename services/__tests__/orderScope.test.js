'use strict';
/** Zakres zleceń konta (services/orderScope.js) — wspólny dla asystenta i serwisu. */
const test = require('node:test');
const assert = require('node:assert');
const { scopeFromRequest, scopeWhere } = require('../orderScope');

function req(over = {}) {
	return { session: { user: { userId: 42, pin: 'P1', ident: 'TCN', isEmployee: true }, employee: { id: 9 }, employeePermissions: { can_see_all_orders: false }, ...over } };
}

test('scopeWhere: klient — swoje; pracownik — tylko utworzone przez siebie; sklep grupy — tylko swoje; alias dla tabeli zgłoszeń', () => {
	const client = { userId: 42, employeeId: null, groupUserId: null };
	assert.deepEqual(scopeWhere(client), { sql: 'o.user_id = ?', params: [42] });
	assert.deepEqual(scopeWhere({ ...client, employeeId: 7 }), { sql: 'o.user_id = ? AND o.employee_id = ?', params: [42, 7] });
	assert.deepEqual(scopeWhere({ ...client, groupUserId: 3 }), { sql: 'o.user_id = ? AND o.group_user_id = ?', params: [42, 3] });
	assert.deepEqual(scopeWhere({ ...client, employeeId: 7 }, 't'), { sql: 't.user_id = ? AND t.employee_id = ?', params: [42, 7] });
});

test('scopeFromRequest: pracownik bez „Wszystkie zamówienia” → swoje; z uprawnieniem → całość; owner/admin w kontekście → klient z kontekstu', () => {
	assert.equal(scopeFromRequest(req(), 'pl').employeeId, 9);
	assert.equal(scopeFromRequest(req({ employeePermissions: { can_see_all_orders: true } }), 'pl').employeeId, null);
	const owner = req({ user: { userId: 1, ident: 'HKL', isOwner: true }, employee: undefined, employeePermissions: undefined, context_user: { userId: 77, pin: 'C1', ident: 'TCN' } });
	const s = scopeFromRequest(owner, 'de');
	assert.equal(s.userId, 77);
	assert.equal(s.ident, 'HKL', 'ident = zalogowany, nie kontekst');
	assert.equal(s.lang, 'de');
	assert.equal(s.isOwner, true);
	assert.equal(typeof s.service, 'boolean');
	assert.equal(s.cancelCtx.contextUser.ident, 'TCN');
});

test('scopeFromRequest: konto podrzędne grupy ma groupUserId ze swojej sesji', () => {
	const shop = req({ user: { userId: 42, ident: 'TCN', isGroupShop: true, groupShopId: 3 }, employee: undefined, employeePermissions: undefined });
	const s = scopeFromRequest(shop, 'pl');
	assert.equal(s.groupUserId, 3);
	assert.equal(s.isGroupShop, true);
	assert.deepEqual(scopeWhere(s), { sql: 'o.user_id = ? AND o.group_user_id = ?', params: [42, 3] });
});
