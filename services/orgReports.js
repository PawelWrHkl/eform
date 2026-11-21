/**
 * Raporty organizacji (`/org/reports`, flaga ORG_REPORTS) — raport admina
 * (`/admin/reports`) zawężony do klientów JEDNEJ organizacji.
 *
 * Bezpieczeństwo (rdzeń modułu):
 *  - organizacja pochodzi WYŁĄCZNIE z sesji ownera; admin może podejrzeć dowolną
 *    przez `?org=<id>` (tylko odczyt). Body i query innych ról są ignorowane,
 *  - `userIds` z przeglądarki i z zapisanych konfiguracji są przecinane z klientami
 *    tej organizacji (`scopeUserIds`), a każde zapytanie SQL dostaje dodatkowo
 *    warunek organizacji (`db/admin/reports.js buildOrderFilter`, `scope.orgId`),
 *  - pusty wybór = wszyscy MOI klienci, nigdy cała baza; same cudze id = pusto.
 *
 * Ceny (sprawdzone 2026-11-20 na zrzucie produkcji, faktury vs pozycje):
 *  - „Sprzedaż” = `order_item.total_price_sub` (cena klienta SUB___, netto po
 *    rabatach = stopka „Razem po rabacie” i faktura organizacja → klient);
 *    organizacja HKL (id 3) ma jedną warstwę: `order_item.total_price`,
 *  - „Zakup od HKL” = `order_item.total_price` (= faktura HKL → organizacja),
 *    tylko po otwarciu kłódki (`session.user.showSubParams`, jak w podglądzie zlecenia),
 *  - waluta: z klienta (`currency.pickCurrency`), jedna waluta na raport — EUR i PLN
 *    nigdy się nie sumują.
 */

'use strict';

const { pickCurrency, currencySymbol } = require('./currency');

const HKL_ORG_ID = 3;
const DAY = 86400000;

/**
 * Kto ogląda raport której organizacji.
 * @returns {{orgId: number, readOnly: boolean} | {status: number}}
 */
function resolveReportOrg(user, query = {}) {
	if (!user) return { status: 401 };
	if (user.isAdmin) {
		const id = Number.parseInt(query.org, 10);
		return Number.isInteger(id) && id > 0 ? { orgId: id, readOnly: true } : { status: 400 };
	}
	const owner = user.isOwner && !user.isStaff && !user.isEmployee && !user.isGroup && !user.isGroupShop;
	const orgId = Number(user.orgId);
	if (!owner || !Number.isInteger(orgId) || orgId <= 0) return { status: 403 };
	return { orgId, readOnly: false };
}

/**
 * Wybór klientów po stronie serwera.
 * @param {unknown} requested  `userIds` z żądania (dowolne śmieci)
 * @param {number[]} allowedIds klienci organizacji w walucie raportu
 * @param {number} allCount     liczba wszystkich klientów organizacji
 * @returns {number[]|null} null = wszyscy klienci organizacji (warunek SQL wystarcza), [] = nikt
 */
function scopeUserIds(requested, allowedIds, allCount) {
	const allowed = new Set(allowedIds.map(Number));
	const req = (Array.isArray(requested) ? requested : []).map(Number).filter(Number.isInteger);
	if (!req.length) return allowed.size === allCount ? null : [...allowed];
	return [...new Set(req.filter((id) => allowed.has(id)))];
}

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const parseDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? Date.parse(`${s}T00:00:00Z`) : NaN);

function shiftYear(day, years) {
	const d = new Date(parseDay(day));
	d.setUTCFullYear(d.getUTCFullYear() + years);
	return iso(d);
}

/** Poprzedni okres tej samej długości i ten sam okres rok wcześniej; null bez pełnego zakresu. */
function comparisonRanges(dateFrom, dateTo) {
	const from = parseDay(dateFrom);
	const to = parseDay(dateTo);
	if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
	const days = Math.round((to - from) / DAY) + 1;
	return {
		prev: { dateFrom: iso(from - days * DAY), dateTo: iso(from - DAY) },
		yoy: { dateFrom: shiftYear(dateFrom, -1), dateTo: shiftYear(dateTo, -1) },
	};
}

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Kafelki KPI z wierszy `getOrderStats` (jeden wiersz = jeden klient z zamówieniami).
 * `withPurchase` — kłódka otwarta: zakup i marża także przy pustym okresie (0, nie brak kafelka).
 */
function totalsOf(stats, withPurchase = false) {
	const rows = Array.isArray(stats) ? stats : [];
	const t = rows.reduce((a, r) => ({
		sales: a.sales + num(r.total_value),
		orders: a.orders + num(r.order_count),
		positions: a.positions + num(r.position_count),
		purchase: a.purchase + num(r.purchase_value),
		noSub: a.noSub + num(r.items_no_sub),
	}), { sales: 0, orders: 0, positions: 0, purchase: 0, noSub: 0 });
	const hasPurchase = withPurchase || rows.some((r) => r.purchase_value !== undefined);
	return {
		sales: round2(t.sales),
		orders: t.orders,
		positions: t.positions,
		avgOrder: t.orders ? round2(t.sales / t.orders) : 0,
		clients: rows.filter((r) => num(r.order_count) > 0).length,
		...(t.noSub ? { itemsWithoutClientPrice: t.noSub } : {}),
		...(hasPurchase ? { purchase: round2(t.purchase), margin: round2(t.sales - t.purchase) } : {}),
	};
}

function median(values) {
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Klienci do odzyskania: ≥3 zlecenia w ostatnich 12 mies., a od ostatniego minęło
 * więcej niż 2× ich mediana odstępu (co najmniej 45 dni). Odstępy liczone między
 * różnymi dniami zamówień. Sortowanie po obrocie z 12 miesięcy.
 * @param {{user_id:number, day:string, total_value:any}[]} rows  zlecenia z 12 mies.
 * @param {string} today YYYY-MM-DD
 */
function winbackClients(rows, today) {
	const byClient = new Map();
	for (const r of rows || []) {
		const c = byClient.get(r.user_id) || { orders: 0, value: 0, days: new Set() };
		c.orders += 1;
		c.value += num(r.total_value);
		c.days.add(r.day);
		byClient.set(r.user_id, c);
	}
	const now = parseDay(today);
	const out = [];
	for (const [userId, c] of byClient) {
		if (c.orders < 3) continue;
		const days = [...c.days].map(parseDay).sort((a, b) => a - b);
		if (days.length < 2) continue;
		const gaps = days.slice(1).map((d, i) => Math.round((d - days[i]) / DAY));
		const typicalGap = median(gaps);
		const last = days[days.length - 1];
		const since = Math.round((now - last) / DAY);
		if (since <= Math.max(2 * typicalGap, 45)) continue;
		out.push({ user_id: userId, orders: c.orders, value: round2(c.value), last_order: iso(last), typical_gap: Math.round(typicalGap), days_since: since });
	}
	return out.sort((a, b) => b.value - a.value);
}

/**
 * Analiza ABC (Pareto): A = pierwsze 80% sprzedaży, B = kolejne 15%, C = reszta.
 * Pozycja należy do klasy według udziału skumulowanego PRZED nią — pierwsza
 * pozycja jest zawsze A, nawet gdy sama ma > 80%.
 * @returns {{key:any, label:string, value:number, share:number, cumulative:number, cls:'A'|'B'|'C'}[]}
 */
function abcClassify(items) {
	const rows = (items || []).filter((i) => num(i.value) > 0).sort((a, b) => num(b.value) - num(a.value));
	const total = rows.reduce((s, i) => s + num(i.value), 0);
	let cum = 0;
	return rows.map((i) => {
		const before = total ? cum / total : 0;
		cum += num(i.value);
		const cls = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
		return { ...i, value: round2(num(i.value)), share: total ? num(i.value) / total : 0, cumulative: total ? cum / total : 0, cls };
	});
}

const OFFER_STALE_DAYS = 14;
const SENT_STATUSES = new Set(['sent', 'correction']);

/**
 * Raport ofert (`order.offer_at`, services/orderOffer.js) z wierszy `db.getOffers`
 * (oferty z zakresu dat, bez anulowanych). Wysłane = 'sent'/'correction', otwarte = reszta
 * ('active', 'pending_approval'); bez ruchu = otwarta 'active' z dniem oferty sprzed > 14 dni.
 * @param {{id:number, user_id:number, status:string, order_idx:any, commision:string, offer_day:string, total_value:any}[]} rows
 * @param {string} today YYYY-MM-DD
 * @param {{clients?: Map<number, object>, links?: boolean}} opts  links = owner (podgląd admina bez odnośników)
 */
function offersReport(rows, today, { clients = new Map(), links = false } = {}) {
	const now = parseDay(today);
	const out = { total: { count: 0, value: 0 }, sent: { count: 0, value: 0 }, open: { count: 0, value: 0 }, staleTotal: { count: 0, value: 0 }, stale: [] };
	const add = (k, v) => { out[k].count += 1; out[k].value += v; };
	for (const r of rows || []) {
		const v = num(r.total_value);
		add('total', v);
		if (SENT_STATUSES.has(r.status)) { add('sent', v); continue; }
		add('open', v);
		const days = Math.round((now - parseDay(r.offer_day)) / DAY);
		if (r.status !== 'active' || !(days > OFFER_STALE_DAYS)) continue;
		add('staleTotal', v);
		const c = clients.get(r.user_id) || {};
		out.stale.push({
			id: r.id, order_idx: r.order_idx, commision: r.commision || '', ident: c.ident || '', client_name: c.client_name || '',
			offer_day: r.offer_day, days, value: round2(v), ...(links ? { href: `/orders/order/${r.id}` } : {}),
		});
	}
	for (const k of ['total', 'sent', 'open', 'staleTotal']) out[k].value = round2(out[k].value);
	out.rate = out.total.count ? out.sent.count / out.total.count : 0;
	out.staleDays = OFFER_STALE_DAYS;
	return out;
}

/** Waluta każdego klienta (ta sama reguła co ceny klienta: user → organizacja → EUR). */
function withCurrency(clients) {
	return (clients || []).map((c) => ({ ...c, cur: pickCurrency(c.currency, c.org_currency) }));
}

/** Waluty organizacji, najczęstsza pierwsza. */
function currenciesOf(clients) {
	const counts = new Map();
	for (const c of clients) counts.set(c.cur, (counts.get(c.cur) || 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

/**
 * Pełny raport organizacji. `db` = `db/admin/reports.js` (w testach atrapa),
 * `hasOfferColumn` = services/orderOffer.js — bez kolumny `offer_at` raport ofert to null.
 * @param {object} p
 * @param {number} p.orgId        z `resolveReportOrg`, nigdy z żądania
 * @param {boolean} p.unlocked    kłódka otwarta → zakup od HKL i marża
 * @param {string} p.lang
 * @param {unknown} p.userIds
 * @param {string|null} p.dateFrom
 * @param {string|null} p.dateTo
 * @param {unknown} p.currency
 * @param {string} p.today        YYYY-MM-DD
 * @param {boolean} p.readOnly    podgląd admina — oferty bez odnośników do zleceń
 */
async function buildOrgReport(p, { db, hasOfferColumn = async () => false }) {
	const clients = withCurrency(await db.getReportClients(p.dateFrom, p.dateTo, p.orgId) || []);
	const currencies = currenciesOf(clients);
	const currency = currencies.includes(String(p.currency || '').toUpperCase()) ? String(p.currency).toUpperCase() : (currencies[0] || pickCurrency());
	const allowed = clients.filter((c) => c.cur === currency).map((c) => c.id);
	const ids = scopeUserIds(p.userIds, allowed, clients.length);
	const isHkl = Number(p.orgId) === HKL_ORG_ID;
	const unlocked = !!p.unlocked && !isHkl;
	const scope = { orgId: p.orgId, valueColumn: isHkl ? 'total_price' : 'total_price_sub', purchase: unlocked, lang: p.lang };
	const meta = { currency, currencySymbol: currencySymbol(currency), currencies, unlocked, isHkl };
	const clientCounts = clients.map((c) => ({ id: c.id, order_count: c.order_count }));
	const withOffers = await hasOfferColumn();

	if (Array.isArray(ids) && ids.length === 0) {
		return { ...meta, stats: [], trend: [], groups: [], deptClients: [], clientCounts, kpi: { current: totalsOf([], unlocked) }, winback: [], seasonality: [], abc: { clients: [], groups: [] }, offers: withOffers ? offersReport([], p.today) : null };
	}

	const ranges = comparisonRanges(p.dateFrom, p.dateTo);
	const yearAgo = shiftYear(p.today, -1);
	const [stats, trend, groups, deptClients, prev, yoy, days12, seasonality, offerRows] = await Promise.all([
		db.getOrderStats(ids, p.dateFrom, p.dateTo, scope),
		db.getMonthlyTrend(ids, p.dateFrom, p.dateTo, scope),
		db.getGroupStats(ids, p.dateFrom, p.dateTo, scope),
		db.getDeptClientStats(ids, p.dateFrom, p.dateTo, scope),
		ranges ? db.getOrderStats(ids, ranges.prev.dateFrom, ranges.prev.dateTo, scope) : null,
		ranges ? db.getOrderStats(ids, ranges.yoy.dateFrom, ranges.yoy.dateTo, scope) : null,
		db.getClientOrderDays(ids, iso(parseDay(yearAgo) + DAY), p.today, scope),
		// Sezonowość (miesiąc × rok): cała historia, niezależnie od zakresu dat.
		db.getMonthlyTrend(ids, null, null, scope),
		withOffers ? db.getOffers(ids, p.dateFrom, p.dateTo, scope) : null,
	]);

	const byId = new Map(clients.map((c) => [c.id, c]));
	const winback = winbackClients(days12 || [], p.today).map((w) => ({ ...w, ident: byId.get(w.user_id)?.ident || '', client_name: byId.get(w.user_id)?.client_name || '' }));

	const groupTotals = new Map();
	for (const g of groups || []) {
		const key = `${g.group_number ?? ''}|${g.group_name}`;
		const cur = groupTotals.get(key) || { key, label: g.group_name, dept: g.department_name, value: 0 };
		cur.value += num(g.total_value);
		groupTotals.set(key, cur);
	}

	return {
		...meta,
		stats: stats || [],
		trend: trend || [],
		groups: groups || [],
		deptClients: deptClients || [],
		clientCounts,
		kpi: {
			current: totalsOf(stats, unlocked),
			...(ranges ? { prev: totalsOf(prev, unlocked), yoy: totalsOf(yoy, unlocked), ranges } : {}),
		},
		winback,
		seasonality: seasonality || [],
		abc: {
			clients: abcClassify((stats || []).map((s) => ({ key: s.user_id, label: s.ident, name: s.client_name, value: s.total_value }))),
			groups: abcClassify([...groupTotals.values()]),
		},
		offers: withOffers ? offersReport(offerRows || [], p.today, { clients: byId, links: !p.readOnly }) : null,
	};
}

module.exports = {
	HKL_ORG_ID,
	resolveReportOrg,
	scopeUserIds,
	comparisonRanges,
	totalsOf,
	winbackClients,
	abcClassify,
	offersReport,
	withCurrency,
	currenciesOf,
	buildOrgReport,
};
