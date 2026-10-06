/**
 * Narzędzia Eforka — wgląd w dane konta klienta, WYŁĄCZNIE DO ODCZYTU.
 *
 * Model (czat: Responses API function calling; głos: Realtime przez sideband)
 * prosi o dane, a serwer wykonuje zapytanie w ZAKRESIE zalogowanego konta —
 * tym samym, który stosuje portal na listach zleceń:
 *   • klient / owner w kontekście klienta → zlecenia tego klienta,
 *   • pracownik bez „Wszystkie zamówienia” → tylko zlecenia, które sam utworzył,
 *   • konto podrzędne grupy (albo grupa w kontekście sklepu) → tylko zlecenia sklepu.
 * Identyfikator zlecenia od modelu jest zawsze sprawdzany w tym zakresie.
 *
 * ⚠️ Świadomie bez cen, adresów, e-maili i komentarzy (dane osobowe klientów
 * końcowych) — do OpenAI idzie minimum potrzebne do odpowiedzi; ceny klient
 * widzi pod odnośnikiem do zlecenia. Akcje zapisu robi klient sam (przycisk
 * akcji w czacie woła istniejące endpointy portalu z ich własną kontrolą).
 *
 * Odnośniki w odpowiedzi: `[[page:klucz]]`, `[[order:ID]]`, `[[action:copy:ID]]`
 * — `resolveRefs` zamienia je na adresy/etykiety albo usuwa, gdy klucz jest
 * nieznany albo zlecenie spoza zakresu.
 */

'use strict';

const { selectQuery } = require('../../db/core');
const ownerService = require('../owner');
const { getActiveGroupShopId } = require('../groupContext');
const { parseSpeditionNumbers } = require('../prodStatus');
const orderCancellation = require('../orderCancellation');
const labels = require('./labels');
const knowledge = require('./knowledge');
const pages = require('./pages');
const { log } = require('../../utils/logging');

const MAX_LIST = 10;

// ── zakres konta ──────────────────────────────────────────────────────────
/**
 * Zakres danych dla żądania. Wołać PO `loadEmployeePermissions` (świeże uprawnienia).
 */
function scopeFromRequest(req, lang) {
	const u = (req.session && req.session.user) || {};
	const current = ownerService.getCurrentUser(req) || {};
	const perms = req.session.employeePermissions || null;
	const isEmployee = !!u.isEmployee;
	const features = require('../../config').features || {};
	return {
		userId: Number(current.userId) || null,
		pin: current.pin || null,
		// „Moje Importy” (routes/orders.js GET /import-log) patrzą na zalogowanego, nie na kontekst.
		ident: u.ident || u.userIdent || null,
		lang,
		isEmployee,
		isGroup: !!(u.isGroup || (req.session.context_user && req.session.context_user.isGroup)),
		isGroupShop: !!u.isGroupShop,
		isOwner: !!u.isOwner,
		// Pracownik bez „Wszystkie zamówienia” widzi tylko swoje — jak lista „Wysłane zlecenia”.
		employeeId: isEmployee && !(perms && perms.can_see_all_orders) ? (req.session.employee && req.session.employee.id) || -1 : null,
		groupUserId: getActiveGroupShopId(req) || null,
		invoices: !!features.invoices && !u.isGroupShop,
		cancelCtx: {
			sessionUser: u,
			sessionEmployee: req.session.employee,
			employeePermissions: perms,
			contextUser: req.session.context_user
		}
	};
}

function scopeWhere(scope) {
	const clauses = ['o.user_id = ?'];
	const params = [scope.userId];
	if (scope.employeeId !== null && scope.employeeId !== undefined) { clauses.push('o.employee_id = ?'); params.push(scope.employeeId); }
	if (scope.groupUserId) { clauses.push('o.group_user_id = ?'); params.push(scope.groupUserId); }
	return { sql: clauses.join(' AND '), params };
}

// ── formatowanie ──────────────────────────────────────────────────────────
const KIND_BY_STATUS = { active: 'offer', pending_approval: 'offer_pending_approval', sent: 'sent', canceled: 'canceled' };

function day(value) {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function productionLabel(order, resolve) {
	if (order.status !== 'sent') return null;
	if (!order.prod_status) return resolve('order.status_order_sent') || 'Zamówienie przyjęte';
	return resolve(order.prod_status) || order.prod_status;
}

function parcels(order) {
	return parseSpeditionNumbers(order.spedition_numbers).filter(Boolean).map((p) => (p.carrier && p.carrier !== 'N/A' ? `${p.carrier} ${p.code}` : p.code));
}

function summarize(order, resolve) {
	const kind = KIND_BY_STATUS[order.status] || order.status;
	const out = {
		ref: `[[order:${order.id}]]`,
		number: order.order_idx != null ? String(order.order_idx) : String(order.id),
		name: String(order.commision || '').slice(0, 80),
		kind,
		created: day(order.created_date),
		sent: day(order.sent_date)
	};
	if (kind === 'sent') {
		out.production_status = productionLabel(order, resolve);
		out.shipping_date = day(order.delivery_date);
		const p = parcels(order);
		out.parcels = p.slice(0, 5);
		if (!out.shipping_date && order.max_prod_days) out.estimated_production_days = Number(order.max_prod_days);
	}
	if (order.cancelDeadlineLabel) out.can_cancel_until = order.cancelDeadlineLabel;
	// Znacznik przycisku „Skopiuj zlecenie” (resolveRefs → potwierdzana akcja w czacie).
	out.copy = `[[action:copy:${order.id}]]`;
	return out;
}

// ── definicje narzędzi ────────────────────────────────────────────────────
const DEFINITIONS = {
	find_orders: {
		description: 'Wyszukuje zlecenia i oferty zalogowanego konta (po numerze lub nazwie, rodzaju i datach wysłania). Zwraca numer, nazwę, rodzaj, daty, status produkcji, termin wysyłki, numery przesyłek, termin anulowania i znacznik odnośnika [[order:ID]]. Bez cen.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Fragment numeru lub nazwy zlecenia; pusty = wszystkie.' },
				kind: { type: 'string', enum: ['any', 'offer', 'sent', 'canceled'], description: 'offer = niewysłane, sent = wysłane, canceled = anulowane.' },
				sent_from: { type: ['string', 'null'], description: 'Data wysłania od (RRRR-MM-DD) albo null.' },
				sent_to: { type: ['string', 'null'], description: 'Data wysłania do (RRRR-MM-DD) albo null.' },
				limit: { type: 'integer', description: 'Ile wyników (1–10).' }
			},
			required: ['query', 'kind', 'sent_from', 'sent_to', 'limit'],
			additionalProperties: false
		}
	},
	get_order: {
		description: 'Szczegóły jednego zlecenia zalogowanego konta: pozycje (pomieszczenie, produkt, status, data wysyłki, przesyłka), termin anulowania i odnośniki. order_id = ID z wyników find_orders (z [[order:ID]]). Bez cen.',
		parameters: {
			type: 'object',
			properties: { order_id: { type: 'integer' } },
			required: ['order_id'],
			additionalProperties: false
		}
	},
	get_account_overview: {
		description: 'Podsumowanie konta: liczba ofert, zleceń czekających na zatwierdzenie, wysłanych (w tym z ostatnich 30 dni), anulowanych, ostatnie wysłane zlecenie oraz uprawnienia pracownika (jeśli pisze pracownik).',
		parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
	},
	get_delivery_times: {
		description: 'Orientacyjne czasy produkcji (w dniach) dla produktów konta — te same co na stronie „Czas dostawy”.',
		parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
	},
	list_employees: {
		description: 'Pracownicy konta klienta (imię, nazwisko, login, ostatnie logowanie, uprawnienia). Tylko dla konta klienta, nie dla pracownika.',
		parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
	},
	list_catalogs: {
		description: 'Katalogi PDF udostępnione temu kontu (nazwa pliku, rozmiar) ze znacznikiem bezpośredniego pobrania [[catalog:N]]. Pusta lista = brak katalogów do pobrania.',
		parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
	},
	get_pending_approvals: {
		description: 'Konto grupy (centrala): zamówienia sklepów czekające na zatwierdzenie — numer, nazwa, sklep, data utworzenia i znacznik [[order:ID]].',
		parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
	},
	get_import_log: {
		description: 'Ostatnie automatyczne importy zamówień z plików (strona „Moje Importy”): plik, wynik (ok/błąd), utworzone zlecenie [[order:ID]], liczba pozycji, data i treść błędu.',
		parameters: {
			type: 'object',
			properties: { only_errors: { type: 'boolean', description: 'true = tylko importy zakończone błędem.' } },
			required: ['only_errors'],
			additionalProperties: false
		}
	}
};

const WHEN = {
	list_employees: (s) => !s.isEmployee && !s.isGroupShop,
	list_catalogs: (s) => pages.allowed('catalogs', s),
	get_pending_approvals: (s) => !!s.isGroup
};

function available(scope) {
	return Object.keys(DEFINITIONS).filter((name) => !WHEN[name] || WHEN[name](scope || {}));
}

/** Definicje dla Responses API (czat). */
function responsesTools(scope) {
	return available(scope).map((name) => ({ type: 'function', name, description: DEFINITIONS[name].description, parameters: DEFINITIONS[name].parameters, strict: true }));
}

/** Definicje dla Realtime (głos) — bez `strict`. */
function realtimeTools(scope) {
	return available(scope).map((name) => ({ type: 'function', name, description: DEFINITIONS[name].description, parameters: DEFINITIONS[name].parameters }));
}

const SERVER_TOOLS = new Set(Object.keys(DEFINITIONS));

// ── wykonanie ─────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES_BY_KIND = { any: ['active', 'pending_approval', 'sent', 'canceled'], offer: ['active', 'pending_approval'], sent: ['sent'], canceled: ['canceled'] };

async function findOrders(args, scope, d) {
	const kind = STATUSES_BY_KIND[args.kind] ? args.kind : 'any';
	const statuses = STATUSES_BY_KIND[kind];
	const limit = Math.max(1, Math.min(MAX_LIST, Number(args.limit) || 5));
	const where = scopeWhere(scope);
	const clauses = [where.sql, `o.status IN (${statuses.map(() => '?').join(',')})`];
	const params = [...where.params, ...statuses];
	const q = String(args.query || '').trim().slice(0, 60);
	if (q) {
		const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		clauses.push('(o.commision LIKE ? OR o.order_idx LIKE ?)');
		params.push(like, like);
	}
	if (DATE_RE.test(args.sent_from || '')) { clauses.push('DATE(o.sent_date) >= ?'); params.push(args.sent_from); }
	if (DATE_RE.test(args.sent_to || '')) { clauses.push('DATE(o.sent_date) <= ?'); params.push(args.sent_to); }
	const rows = await d.select(
		`SELECT o.id, o.commision, o.created_date, o.sent_date, o.status, o.order_idx, o.prod_status,
		        o.delivery_date, o.spedition_numbers, o.max_prod_days
		   FROM \`order\` o
		  WHERE ${clauses.join(' AND ')}
		  ORDER BY COALESCE(o.sent_date, o.created_date) DESC, o.id DESC
		  LIMIT ?`,
		[...params, limit + 1]
	) || [];
	const list = rows.slice(0, limit);
	await d.attachCancelDeadlines(list.filter((o) => o.status === 'sent'), scope.cancelCtx);
	const resolve = d.resolver(scope.lang);
	return { orders: list.map((o) => summarize(o, resolve)), more: rows.length > limit };
}

async function loadOwnOrder(orderId, scope, d) {
	const id = Number(orderId);
	if (!Number.isInteger(id) || id <= 0) return null;
	const where = scopeWhere(scope);
	const rows = await d.select(
		`SELECT o.id, o.commision, o.created_date, o.sent_date, o.status, o.order_idx, o.prod_status,
		        o.delivery_date, o.spedition_numbers, o.max_prod_days, u.ident AS user_ident
		   FROM \`order\` o JOIN \`user\` u ON u.id = o.user_id
		  WHERE o.id = ? AND ${where.sql}
		  LIMIT 1`,
		[id, ...where.params]
	);
	return (rows && rows[0]) || null;
}

async function getOrder(args, scope, d) {
	const order = await loadOwnOrder(args.order_id, scope, d);
	if (!order) return { error: 'not_found', note: 'Nie ma takiego zlecenia na tym koncie (albo konto go nie widzi).' };
	const resolve = d.resolver(scope.lang);
	const items = await d.select(
		`SELECT orderpos, name, commision, department, group_name FROM order_item WHERE order_id = ? ORDER BY orderpos LIMIT 40`,
		[order.id]
	) || [];
	const statuses = order.status === 'sent' && order.order_idx != null
		? await d.select('SELECT order_pos, status, shipping_date, parcel_code FROM position_statuses WHERE user_ident = ? AND order_idx = ?', [order.user_ident, String(order.order_idx)]) || []
		: [];
	const byPos = new Map(statuses.map((s) => [String(s.order_pos), s]));
	const out = summarize(order, resolve);
	out.positions = items.map((it) => {
		const s = byPos.get(String(it.orderpos)) || byPos.get(`${it.orderpos}-1`) || null;
		const p = { position: it.orderpos, room: String(it.name || it.commision || '').slice(0, 60), product: [it.department, it.group_name].filter(Boolean).join(' / ') };
		if (s) {
			p.status = resolve(s.status) || s.status;
			if (s.shipping_date) p.shipping_date = day(s.shipping_date);
			if (s.parcel_code) p.parcel = String(s.parcel_code).slice(0, 60);
		}
		return p;
	});
	if (order.status === 'sent') {
		const info = await d.cancellationInfo(order.id, scope.cancelCtx);
		if (info) out.cancel = { possible: !!info.cancelable, until: info.deadlineLabel || null, this_account_can_cancel: !!info.canCancel };
	}
	return out;
}

async function accountOverview(args, scope, d) {
	const where = scopeWhere(scope);
	const rows = await d.select(
		`SELECT o.status, COUNT(*) AS n,
		        SUM(o.status = 'sent' AND o.sent_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS last30
		   FROM \`order\` o WHERE ${where.sql} GROUP BY o.status`,
		where.params
	) || [];
	const count = (s) => Number((rows.find((r) => r.status === s) || {}).n || 0);
	const sentRow = rows.find((r) => r.status === 'sent') || {};
	const last = await d.select(
		`SELECT o.id, o.commision, o.created_date, o.sent_date, o.status, o.order_idx, o.prod_status, o.delivery_date, o.spedition_numbers, o.max_prod_days
		   FROM \`order\` o WHERE ${where.sql} AND o.status = 'sent' ORDER BY o.sent_date DESC LIMIT 1`,
		where.params
	) || [];
	const out = {
		offers: count('active'),
		waiting_for_approval: count('pending_approval'),
		sent_total: count('sent'),
		sent_last_30_days: Number(sentRow.last30 || 0),
		canceled: count('canceled'),
		last_sent: last[0] ? summarize(last[0], d.resolver(scope.lang)) : null
	};
	const perms = scope.cancelCtx.employeePermissions;
	if (scope.isEmployee && perms) {
		out.your_permissions = { send_orders: !!perms.can_send_orders, see_prices: !!perms.can_see_prices, see_all_orders: !!perms.can_see_all_orders };
	}
	return out;
}

async function deliveryTimes(args, scope, d) {
	const rows = scope.pin ? (await d.deliveryTimes(scope.pin)) || [] : [];
	const resolve = d.resolver(scope.lang);
	return { products: rows.map((r) => ({ product: resolve(r.product_code) || r.product_code, days: Number(r.lead_time) || r.lead_time })) };
}

async function listEmployees(args, scope, d) {
	if (scope.isEmployee || scope.isGroupShop) return { error: 'not_available' };
	const rows = await d.select(
		'SELECT name, surname, login, last_login, can_send_orders, can_see_prices, can_see_all_orders FROM employee WHERE user_id = ? ORDER BY surname, name LIMIT 50',
		[scope.userId]
	) || [];
	return {
		employees: rows.map((e) => ({
			name: [e.name, e.surname].filter(Boolean).join(' '),
			login: e.login,
			last_login: e.last_login ? day(e.last_login) : null,
			send_orders: e.can_send_orders === 1,
			see_prices: e.can_see_prices === 1,
			see_all_orders: e.can_see_all_orders === 1
		}))
	};
}

async function listCatalogs(args, scope, d) {
	const files = (scope.pin ? await d.catalogs(scope.pin) : null) || [];
	return {
		catalogs: files.slice(0, 30).map((f, i) => ({ name: String(f.name), size_kb: Math.round((Number(f.size) || 0) / 1024), download: `[[catalog:${i + 1}]]` })),
		page: '[[page:catalogs]]'
	};
}

async function pendingApprovals(args, scope, d) {
	if (!scope.isGroup) return { error: 'not_available' };
	const rows = (await d.select(
		`SELECT o.id, o.order_idx, o.commision, o.created_date, gu.name AS shop_name, gu.ident AS shop_ident
		   FROM \`order\` o JOIN group_user gu ON gu.id = o.group_user_id
		  WHERE gu.user_id = ? AND o.user_id = ? AND o.status = 'pending_approval'
		  ORDER BY o.id DESC LIMIT ?`,
		[scope.userId, scope.userId, MAX_LIST + 1]
	)) || [];
	return {
		orders: rows.slice(0, MAX_LIST).map((o) => ({
			number: o.order_idx != null ? String(o.order_idx) : null,
			name: String(o.commision || '').slice(0, 60),
			shop: String(o.shop_name || o.shop_ident || '').slice(0, 60),
			created: day(o.created_date),
			ref: `[[order:${o.id}]]`
		})),
		more: rows.length > MAX_LIST,
		page: '[[page:group_pending]]'
	};
}

async function importLog(args, scope, d) {
	if (!scope.ident) return { imports: [] };
	const rows = (await d.select(
		`SELECT file_name, status, order_id, items_count, error_message, created_at
		   FROM import_log WHERE user_ident = ?${args.only_errors === true ? " AND status <> 'success'" : ''}
		  ORDER BY created_at DESC LIMIT ?`,
		[scope.ident, MAX_LIST]
	)) || [];
	return {
		imports: rows.map((r) => ({
			file: String(r.file_name || '').slice(0, 80),
			ok: r.status === 'success',
			order: r.order_id ? `[[order:${Number(r.order_id)}]]` : null,
			items: Number(r.items_count) || 0,
			at: r.created_at ? `${day(r.created_at)} ${new Date(r.created_at).toTimeString().slice(0, 5)}` : null,
			error: r.error_message ? String(r.error_message).replace(/\s+/g, ' ').slice(0, 240) : null
		})),
		page: '[[page:import_log]]'
	};
}

const RUNNERS = {
	find_orders: findOrders,
	get_order: getOrder,
	get_account_overview: accountOverview,
	get_delivery_times: deliveryTimes,
	list_employees: listEmployees,
	list_catalogs: listCatalogs,
	get_pending_approvals: pendingApprovals,
	get_import_log: importLog
};

function defaultDeps(deps = {}) {
	return {
		select: deps.select || selectQuery,
		attachCancelDeadlines: deps.attachCancelDeadlines || ((orders, ctx) => orderCancellation.attachCancelDeadlines(orders, ctx).catch(() => orders)),
		cancellationInfo: deps.cancellationInfo || ((id, ctx) => orderCancellation.getCancellationInfo(id, ctx).catch(() => null)),
		deliveryTimes: deps.deliveryTimes || ((pin) => require('../../db/others').getDeliveryTimes(pin)),
		// Katalogi marki (ten sam katalog plików co zakładka „Katalogi” panelu).
		catalogs: deps.catalogs || (async (pin) => {
			const owner = await require('../../db/users').getOwner(pin);
			return require('../catalogFiles').listCatalogFiles(owner && owner.orgIdent);
		}),
		resolver: deps.resolver || ((lang) => knowledge.makeResolver(lang, deps))
	};
}

/**
 * @returns {Promise<object>} wynik dla modelu (zawsze obiekt; błąd = { error })
 */
async function runTool(name, args, scope, deps = {}) {
	const run = RUNNERS[name];
	if (!run || !available(scope).includes(name)) return { error: 'unknown_tool' };
	if (!scope || !scope.userId) return { error: 'no_account' };
	try {
		return await run(args || {}, scope, defaultDeps(deps));
	} catch (err) {
		(deps.log || log)(`[assistant/tools] ${name}:`, err && err.message);
		return { error: 'temporary_failure' };
	}
}

// ── znaczniki odnośników w odpowiedzi ─────────────────────────────────────
const TOKEN_RE = /\[\[(page|order|action|catalog):([a-z_]+|\d+|copy:\d+)\]\]/g;

/**
 * Zamienia znaczniki na odnośniki: zwraca tekst (bez nieznanych/cudzych
 * znaczników) i mapę `refs` { "[[…]]": { type, href, label, orderId? } }.
 */
async function resolveRefs(text, scope, lang, deps = {}) {
	const d = defaultDeps(deps);
	const found = [...String(text || '').matchAll(TOKEN_RE)].map((m) => ({ token: m[0], type: m[1], value: m[2] }));
	const refs = {};
	if (!found.length) return { text, refs };

	const orderIds = [...new Set(found
		.filter((f) => f.type === 'order' || (f.type === 'action' && f.value.startsWith('copy:')))
		.map((f) => Number(f.type === 'order' ? f.value : f.value.slice(5)))
		.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
	const orders = new Map();
	if (orderIds.length && scope && scope.userId) {
		const where = scopeWhere(scope);
		const rows = await d.select(
			`SELECT o.id, o.order_idx, o.commision, o.status FROM \`order\` o WHERE o.id IN (${orderIds.map(() => '?').join(',')}) AND ${where.sql}`,
			[...orderIds, ...where.params]
		) || [];
		for (const r of rows) orders.set(Number(r.id), r);
	}
	const resolve = d.resolver(lang);
	const orderWord = resolve('history_order.title') || 'Zamówienie nr.';
	// Katalogi: [[catalog:N]] = N-ty plik z listy konta (ta sama kolejność co w list_catalogs).
	let catalogFiles = null;
	if (found.some((f) => f.type === 'catalog') && scope && scope.pin && pages.allowed('catalogs', scope)) {
		catalogFiles = (await d.catalogs(scope.pin).catch(() => null)) || [];
	}

	for (const f of found) {
		if (refs[f.token]) continue;
		if (f.type === 'page') {
			const p = pages.get(f.value, scope, lang, deps);
			if (p) refs[f.token] = { type: 'page', href: p.href, label: p.label };
		} else if (f.type === 'order') {
			const o = orders.get(Number(f.value));
			if (o) {
				const href = o.status === 'active' || o.status === 'pending_approval' ? `/orders/order/${o.id}` : `/orders/history/order/${o.id}`;
				refs[f.token] = { type: 'order', href, label: `${orderWord} ${o.order_idx != null ? o.order_idx : o.id}${o.commision ? ` „${String(o.commision).slice(0, 40)}”` : ''}` };
			}
		} else if (f.type === 'catalog') {
			const file = catalogFiles && catalogFiles[Number(f.value) - 1];
			if (file) refs[f.token] = { type: 'file', href: `/panel/catalogs/download/${encodeURIComponent(file.name)}`, label: String(file.name) };
		} else if (f.type === 'action' && f.value.startsWith('copy:')) {
			const o = orders.get(Number(f.value.slice(5)));
			if (o) refs[f.token] = { type: 'copy', orderId: o.id, number: o.order_idx != null ? String(o.order_idx) : String(o.id) };
		}
	}
	// Znaczniki bez pokrycia znikają z tekstu (zamiast pokazywać klientowi „[[…]]”).
	const clean = String(text).replace(TOKEN_RE, (t) => (refs[t] ? t : '')).replace(/[ \t]{2,}/g, ' ').trim();
	return { text: clean, refs };
}

module.exports = {
	scopeFromRequest,
	responsesTools,
	realtimeTools,
	runTool,
	resolveRefs,
	SERVER_TOOLS,
	TOKEN_RE,
	_scopeWhere: scopeWhere
};
