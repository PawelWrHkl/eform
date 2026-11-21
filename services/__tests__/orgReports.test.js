'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const r = require('../orgReports');
const { buildOrderFilter, scopeSql } = require('../../db/admin/reports');

test('resolveReportOrg: organizacja tylko z sesji ownera, ?org= tylko admin', () => {
	const owner = { isOwner: true, orgId: 1 };
	assert.deepEqual(r.resolveReportOrg(owner, { org: '5' }), { orgId: 1, readOnly: false }, 'owner ignoruje ?org=');
	assert.deepEqual(r.resolveReportOrg({ isAdmin: true, isOwner: true, orgId: 3 }, { org: '5' }), { orgId: 5, readOnly: true });
	assert.equal(r.resolveReportOrg({ isAdmin: true, isOwner: true, orgId: 3 }, {}).status, 400);
	assert.equal(r.resolveReportOrg({ isAdmin: true }, { org: '5; DROP' }).orgId, 5, 'parseInt ucina śmieci');
	assert.equal(r.resolveReportOrg({ isAdmin: true }, { org: '-1' }).status, 400);
	assert.equal(r.resolveReportOrg(null).status, 401);
	for (const u of [
		{ isOwner: false, orgId: 1 },                          // klient
		{ isOwner: false, isEmployee: true, orgId: 1 },        // pracownik
		{ isOwner: false, isGroup: true, orgId: 3 },           // konto grupy
		{ isOwner: false, isGroupShop: true, orgId: 3 },       // sklep grupy
		{ isOwner: false, isStaff: true, orgId: 3 },           // biuro
		{ isOwner: true, isStaff: true, orgId: 3 },            // biuro z identem organizacji
		{ isOwner: true, orgId: null },                        // owner bez organizacji
	]) assert.equal(r.resolveReportOrg(u, { org: '1' }).status, 403, JSON.stringify(u));
});

test('scopeUserIds: przecięcie z klientami organizacji, pusty wybór = wszyscy MOI', () => {
	const mine = [10, 11, 12];
	assert.equal(r.scopeUserIds(null, mine, 3), null, 'nic nie wybrano → warunek SQL organizacji');
	assert.equal(r.scopeUserIds([], mine, 3), null);
	assert.deepEqual(r.scopeUserIds([], mine, 5), mine, 'filtr waluty: pusty wybór = moi w tej walucie, nie null');
	assert.deepEqual(r.scopeUserIds([11, 999, 12], mine, 3), [11, 12], 'cudze id wypadają');
	assert.deepEqual(r.scopeUserIds([999, 1000], mine, 3), [], 'same cudze id = nikt, nigdy „wszyscy”');
	assert.deepEqual(r.scopeUserIds(['11', 'x', 11.5, 11], mine, 3), [11]);
	assert.equal(r.scopeUserIds('11,12', mine, 3), null, 'napis zamiast tablicy = brak wyboru');
	assert.deepEqual(r.scopeUserIds([1], [], 0), [], 'organizacja bez klientów');
});

test('buildOrderFilter: warunek organizacji w SQL, admin bez zmian', () => {
	const admin = buildOrderFilter([1, 2], '2026-01-01', '2026-01-31');
	assert.equal(admin.where, "WHERE o.status = 'sent' AND o.user_id IN (?,?) AND DATE(o.created_date) >= ? AND DATE(o.created_date) <= ?");
	assert.deepEqual(admin.params, [1, 2, '2026-01-01', '2026-01-31']);

	const org = buildOrderFilter(null, null, null, 'o', 5);
	assert.match(org.where, /o\.user_id IN \(SELECT su\.id FROM user su WHERE su\.organization_id = \? AND/);
	assert.deepEqual(org.params, [5]);
	const both = buildOrderFilter([7], null, '2026-02-01', 'o', 1);
	assert.deepEqual(both.params, [7, 1, '2026-02-01'], 'kolejność parametrów = kolejność warunków');
});

test('scopeSql: admin = dotychczasowe wyrażenia, organizacja = ceny z pozycji', () => {
	const a = scopeSql();
	assert.match(a.orderValue, /SUBSTRING_INDEX\(o\.total_price/);
	assert.equal(a.itemValue, 'oi.total_price');
	assert.equal(a.orderPurchase, '');
	assert.equal(a.deptName, 'd.name_pl');
	const o = scopeSql({ orgId: 5, valueColumn: 'total_price_sub', purchase: true, lang: 'de' });
	assert.equal(o.orderValue, 'oi_agg.sub_value');
	assert.equal(o.itemValue, 'oi.total_price_sub');
	assert.match(o.orderPurchase, /oi_agg\.base_value/);
	assert.match(o.deptName, /d\.name_de/);
	assert.equal(scopeSql({ valueColumn: 'x; DROP', lang: 'xx' }).deptName, 'd.name_pl', 'tylko znane kolumny i języki');
	assert.equal(scopeSql({ valueColumn: 'total_price' }).orderValue, 'oi_agg.base_value');
});

function fakeDb(clients) {
	const calls = [];
	const rec = (name, ret) => async (...args) => { calls.push({ name, args }); return ret; };
	return {
		calls,
		getReportClients: rec('getReportClients', clients),
		getOrderStats: rec('getOrderStats', [{ user_id: 10, ident: 'A', total_value: '100.00', order_count: 2, position_count: 3 }]),
		getMonthlyTrend: rec('getMonthlyTrend', []),
		getGroupStats: rec('getGroupStats', [{ group_number: '04', group_name: 'Plisy', department_name: 'D', total_value: 100 }]),
		getDeptClientStats: rec('getDeptClientStats', []),
		getClientOrderDays: rec('getClientOrderDays', []),
	};
}

const CLIENTS = [
	{ id: 10, ident: 'A', currency: 'EUR', org_currency: null, order_count: 2 },
	{ id: 11, ident: 'B', currency: null, org_currency: null, order_count: 0 },
	{ id: 12, ident: 'C', currency: 'PLN', org_currency: null, order_count: 1 },
];
const base = { orgId: 1, lang: 'nl', dateFrom: '2026-01-01', dateTo: '2026-01-31', today: '2026-11-20' };

test('buildOrgReport: każde zapytanie z organizacją z sesji, cudze id odfiltrowane', async () => {
	const db = fakeDb(CLIENTS);
	const out = await r.buildOrgReport({ ...base, userIds: [10, 999], currency: 'EUR' }, { db });
	assert.equal(db.calls[0].args[2], 1, 'lista klientów z organizacji 1');
	const queries = db.calls.slice(1);
	assert.equal(queries.length, 8, 'stats, trend, grupy, działy, poprzedni okres, rok wcześniej, 12 mies., sezonowość');
	for (const c of queries) {
		assert.deepEqual(c.args[0], [10], `${c.name}: tylko moi klienci`);
		assert.equal(c.args[3].orgId, 1, `${c.name}: warunek organizacji`);
		assert.equal(c.args[3].valueColumn, 'total_price_sub');
		assert.equal(c.args[3].purchase, false, 'kłódka zamknięta');
		assert.equal(c.args[3].lang, 'nl');
	}
	assert.equal(out.currency, 'EUR');
	assert.deepEqual(out.currencies, ['EUR', 'PLN']);
	assert.equal(out.kpi.current.sales, 100);
	assert.deepEqual(out.kpi.ranges.prev, { dateFrom: '2025-12-01', dateTo: '2025-12-31' });
});

test('buildOrgReport: pusty wybór przy kilku walutach = moi klienci tej waluty; same cudze = pusto bez SQL', async () => {
	let db = fakeDb(CLIENTS);
	await r.buildOrgReport({ ...base, userIds: [], currency: 'PLN' }, { db });
	assert.deepEqual(db.calls[1].args[0], [12]);

	db = fakeDb(CLIENTS);
	const out = await r.buildOrgReport({ ...base, userIds: [777, 888] }, { db });
	assert.equal(db.calls.length, 1, 'tylko lista klientów, żadnego agregatu');
	assert.deepEqual(out.stats, []);
	assert.deepEqual(out.abc, { clients: [], groups: [] });

	db = fakeDb(CLIENTS.slice(0, 2));
	await r.buildOrgReport({ ...base, userIds: null, currency: 'XXX' }, { db });
	assert.equal(db.calls[1].args[0], null, 'jedna waluta, nic nie wybrano → null + warunek organizacji');
	assert.equal(db.calls[1].args[3].orgId, 1);
});

test('buildOrgReport: kłódka → zakup od HKL; organizacja HKL ma jedną warstwę', async () => {
	let db = fakeDb(CLIENTS);
	await r.buildOrgReport({ ...base, unlocked: true }, { db });
	assert.equal(db.calls[1].args[3].purchase, true);
	db = fakeDb(CLIENTS);
	const out = await r.buildOrgReport({ ...base, orgId: 3, unlocked: true }, { db });
	assert.equal(db.calls[1].args[3].valueColumn, 'total_price');
	assert.equal(db.calls[1].args[3].purchase, false);
	assert.equal(out.unlocked, false);
});

test('comparisonRanges / totalsOf', () => {
	assert.equal(r.comparisonRanges(null, '2026-01-01'), null);
	assert.deepEqual(r.comparisonRanges('2024-03-01', '2024-03-31'), {
		prev: { dateFrom: '2024-01-30', dateTo: '2024-02-29' },
		yoy: { dateFrom: '2023-03-01', dateTo: '2023-03-31' },
	});
	const t = r.totalsOf([
		{ total_value: '100.10', order_count: 2, position_count: 5, purchase_value: '60' },
		{ total_value: '50', order_count: 1, position_count: 1, purchase_value: '20' },
	]);
	assert.deepEqual(t, { sales: 150.1, orders: 3, positions: 6, avgOrder: 50.03, clients: 2, purchase: 80, margin: 70.1 });
	assert.equal(r.totalsOf([{ total_value: 1, order_count: 1 }]).purchase, undefined, 'bez kłódki brak zakupu');
	assert.equal(r.totalsOf([], true).purchase, 0, 'kłódka otwarta, pusty okres → 0');
});

test('winbackClients: ≥3 zlecenia, przerwa > 2× mediana i ≥ 45 dni, sort po obrocie', () => {
	const rows = [
		// A: co 30 dni, ostatnie 2026-06-01 → 172 dni > max(60,45) → do odzyskania
		{ user_id: 1, day: '2026-04-02', total_value: 100 }, { user_id: 1, day: '2026-05-02', total_value: 100 }, { user_id: 1, day: '2026-06-01', total_value: 100 },
		// B: co 10 dni, ostatnie 30 dni temu → 30 < 45 (minimum) → nie
		{ user_id: 2, day: '2026-10-01', total_value: 5 }, { user_id: 2, day: '2026-10-11', total_value: 5 }, { user_id: 2, day: '2026-10-21', total_value: 5 },
		// C: tylko 2 zlecenia → nie
		{ user_id: 3, day: '2026-01-01', total_value: 900 }, { user_id: 3, day: '2026-02-01', total_value: 900 },
		// D: 3 zlecenia jednego dnia → brak odstępu → nie
		{ user_id: 4, day: '2026-01-05', total_value: 1 }, { user_id: 4, day: '2026-01-05', total_value: 1 }, { user_id: 4, day: '2026-01-05', total_value: 1 },
		// E: większy obrót, też uśpiony → pierwszy na liście
		{ user_id: 5, day: '2026-01-10', total_value: 500 }, { user_id: 5, day: '2026-02-10', total_value: 500 }, { user_id: 5, day: '2026-03-10', total_value: 500 },
	];
	const out = r.winbackClients(rows, '2026-11-20');
	assert.deepEqual(out.map((w) => w.user_id), [5, 1]);
	assert.deepEqual(out[1], { user_id: 1, orders: 3, value: 300, last_order: '2026-06-01', typical_gap: 30, days_since: 172 });
});

test('abcClassify: A do 80%, B do 95%, C reszta; pierwszy zawsze A', () => {
	const out = r.abcClassify([
		{ key: 'x', value: 50 }, { key: 'y', value: 30 }, { key: 'z', value: 15 }, { key: 'w', value: 5 }, { key: 'zero', value: 0 },
	]);
	assert.deepEqual(out.map((o) => o.cls), ['A', 'A', 'B', 'C']);
	assert.equal(out[3].cumulative, 1);
	assert.deepEqual(r.abcClassify([{ key: 'big', value: 99 }, { key: 's', value: 1 }]).map((o) => o.cls), ['A', 'C']);
});

// ── Raport ofert (order.offer_at) ─────────────────────────────────

test('buildOrderFilter offers: znacznik oferty bez anulowanych, daty po dniu oferty; domyślnie bez zmian', () => {
	const f = buildOrderFilter([10], '2026-11-01', '2026-11-30', 'o', 1, { offers: true });
	assert.equal(f.where, "WHERE o.offer_at IS NOT NULL AND o.status IN ('active','pending_approval','sent','correction') AND o.user_id IN (?) "
		+ 'AND o.user_id IN (SELECT su.id FROM user su WHERE su.organization_id = ? AND (su.role IS NULL OR su.role NOT IN (\'admin\',\'owner\',\'employee\')) AND su.ident IS NOT NULL) '
		+ 'AND DATE(o.offer_at) >= ? AND DATE(o.offer_at) <= ?');
	assert.deepEqual(f.params, [10, 1, '2026-11-01', '2026-11-30']);
	assert.equal(buildOrderFilter(null, null, null, 'o', 1, {}).where.startsWith("WHERE o.status = 'sent'"), true);
});

test('offersReport: otwarte, wysłane (konwersja), bez ruchu > 14 dni z odnośnikiem tylko dla ownera', () => {
	const rows = [
		{ id: 1, user_id: 10, status: 'active', order_idx: 7, commision: 'Kowalski', offer_day: '2026-11-01', total_value: '100.50' }, // 19 dni
		{ id: 2, user_id: 10, status: 'active', order_idx: 8, commision: '', offer_day: '2026-11-06', total_value: '10' },          // 14 dni — jeszcze nie
		{ id: 3, user_id: 11, status: 'sent', order_idx: 9, commision: 'X', offer_day: '2026-10-01', total_value: '200' },
		{ id: 4, user_id: 11, status: 'correction', order_idx: 10, commision: 'Y', offer_day: '2026-10-02', total_value: '50' },
		{ id: 5, user_id: 11, status: 'pending_approval', order_idx: 11, commision: 'Z', offer_day: '2026-09-01', total_value: '5' }, // otwarta, nie „bez ruchu”
	];
	const clients = new Map([[10, { ident: 'A', client_name: 'Alfa' }]]);
	const out = r.offersReport(rows, '2026-11-20', { clients, links: true });
	assert.deepEqual(out.total, { count: 5, value: 365.5 });
	assert.deepEqual(out.sent, { count: 2, value: 250 });
	assert.deepEqual(out.open, { count: 3, value: 115.5 });
	assert.deepEqual(out.staleTotal, { count: 1, value: 100.5 });
	assert.equal(out.rate, 0.4);
	assert.deepEqual(out.stale, [{ id: 1, order_idx: 7, commision: 'Kowalski', ident: 'A', client_name: 'Alfa', offer_day: '2026-11-01', days: 19, value: 100.5, href: '/orders/order/1' }]);
	assert.equal(r.offersReport(rows, '2026-11-20', { clients }).stale[0].href, undefined, 'podgląd admina: bez odnośnika');
	assert.deepEqual(r.offersReport([], '2026-11-20').rate, 0);
});

test('buildOrgReport: oferty tylko z kolumną offer_at, z organizacją z sesji', async () => {
	let db = fakeDb(CLIENTS);
	let out = await r.buildOrgReport({ ...base, currency: 'EUR' }, { db });
	assert.equal(out.offers, null, 'bez hasOfferColumn (produkcja bez migracji) = brak sekcji');
	assert.equal(db.calls.some((c) => c.name === 'getOffers'), false, 'i żadnego zapytania o oferty');

	db = { ...fakeDb(CLIENTS) };
	db.getOffers = async (...args) => { db.calls.push({ name: 'getOffers', args }); return [{ id: 1, user_id: 10, status: 'active', order_idx: 1, offer_day: '2026-01-02', total_value: 3 }]; };
	out = await r.buildOrgReport({ ...base, userIds: [10, 999], currency: 'EUR', readOnly: true }, { db, hasOfferColumn: async () => true });
	const call = db.calls.find((c) => c.name === 'getOffers');
	assert.deepEqual(call.args.slice(0, 3), [[10], '2026-01-01', '2026-01-31'], 'ten sam wybór i zakres co raport');
	assert.equal(call.args[3].orgId, 1);
	assert.equal(call.args[3].valueColumn, 'total_price_sub', 'ta sama kolumna co „Sprzedaż”');
	assert.equal(out.offers.open.count, 1);
	assert.equal(out.offers.stale[0].href, undefined, 'admin ?org= — bez odnośnika');

	db = fakeDb(CLIENTS);
	out = await r.buildOrgReport({ ...base, userIds: [777] }, { db, hasOfferColumn: async () => true });
	assert.equal(out.offers.total.count, 0, 'same cudze id: puste oferty, bez SQL');
});
