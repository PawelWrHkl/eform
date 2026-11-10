/**
 * Moduł „Serwis” — zgłoszenia reklamacyjne i serwisowe (decyzje właściciela 7.11.2026).
 *
 * Cykl zgłoszenia:
 *   1. kontrola zakresu (zlecenie w `scopeWhere`, pozycje należą do zlecenia, `qty` ≤ ILOSC,
 *      rodzaj pasuje do stanu zlecenia — `rules.js`), limit 20/dobę, duplikat 2 min,
 *   2. pliki: typ po sygnaturze, zapis w katalogu tymczasowym,
 *   3. JEDNA transakcja: zgłoszenie + pozycje + zdarzenie `created` + pliki (repository.createTicket),
 *   4. po COMMIT: pliki do `outputData/service/<numer>/`, potem eksport do HKL i maile.
 *      Ich błąd NIE cofa zgłoszenia — zapisuje `export_failed` / `mail_failed`
 *      (ponawianie: `retryFailedExports` w cyklu tła). Po ROLLBACK pliki tymczasowe znikają.
 *
 * Konto demo (`isDemoIdent` po WŁAŚCICIELU zlecenia/zgłoszenia): zapis tak, eksport i maile nie.
 * Zależności wstrzykiwane (wzorzec services/orderCancellation.js) — testy bez MySQL, FTP i SMTP.
 * Bez cen: żadne zapytanie tego modułu nie czyta kolumn cenowych.
 */

'use strict';

const rules = require('./rules');
const fileTools = require('./files');
const { describeActor } = require('../orderCancellation');
const { parseSpeditionNumbers, setParcelHref, positionNumber } = require('../prodStatus');

const MAX_EXPORT_ATTEMPTS = 5;
const { CLIENT_EVENT_KINDS } = require('./repository');

function resolveDeps(deps = {}) {
	const d = { ...deps };
	if (!d.repo) d.repo = require('./repository');
	if (!d.fsp) d.fsp = require('fs').promises;
	if (!d.outputData) d.outputData = require('../../config').outputData;
	if (!d.now) d.now = () => new Date();
	if (!d.log) d.log = require('../../utils/logging').log;
	if (!d.isDemoIdent) d.isDemoIdent = require('../demoMode').isDemoIdent;
	if (!d.translate) d.translate = require('../mailBot/commentTranslator').translateToPolish;
	if (!d.exporter) d.exporter = require('./exporter');
	if (!d.mailer) d.mailer = require('./mailer');
	return d;
}

function result(status, code, extra = {}) { return { ok: status < 400, status, code, ...extra }; }
function str(v, max) { const s = v === null || v === undefined ? '' : String(v).trim(); return max ? s.slice(0, max) : s; }
function yearOf(date) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', year: 'numeric' }).format(date); }
function parseJson(v) { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
function day(value) {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Decyzja 22: do HKL nie idą ceny — pola cenowe z `parameters_short` są wycinane. */
const PRICE_KEY_RE = /CENA|SUMA|RABAT|WARTOSC|VAT|SUB___|DOPLATA|PRICE|DISCOUNT|KWOTA|NETTO|BRUTTO/i;
function stripPrices(ps) {
	const src = parseJson(ps);
	if (!src || typeof src !== 'object') return null;
	const data = src.data && typeof src.data === 'object' ? src.data : src;
	return Object.fromEntries(Object.entries(data).filter(([k]) => !PRICE_KEY_RE.test(k)));
}

/** Ilość pozycji: `parameters_short.data.ILOSC`, awaryjnie `amount`. */
function itemQty(item) {
	const ps = parseJson(item.parameters_short);
	const n = Number(ps && ps.data && ps.data.ILOSC);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : (Number(item.amount) > 0 ? Number(item.amount) : 1);
}

/** Krótki opis pozycji bez cen: model, wymiary, kolor/tkanina. */
function itemSummary(item) {
	const data = (parseJson(item.parameters_short) || {}).data || {};
	const parts = [];
	if (data.MODEL) parts.push(String(data.MODEL));
	if (data.SZEROKOSC && data.WYSOKOSC) parts.push(`${data.SZEROKOSC}×${data.WYSOKOSC}`);
	else if (data.SZEROKOSC) parts.push(String(data.SZEROKOSC));
	if (data.KOLOR) parts.push(String(data.KOLOR));
	if (!parts.length && item.name) parts.push(String(item.name));
	return parts.join(' · ').slice(0, 160);
}

function departmentNames(row, prefix = 'name_') {
	const out = {};
	for (const l of ['pl', 'en', 'de', 'fr', 'nl']) if (row && row[`${prefix}${l}`]) out[l] = row[`${prefix}${l}`];
	return Object.keys(out).length ? out : null;
}

/** Statusy pozycji przypięte do POZYCJI (podpozycje `1-1` zebrane razem). */
function statusesByPosition(statuses) {
	const map = new Map();
	for (const s of setParcelHref(statuses || [])) {
		const pos = positionNumber(s.order_pos);
		if (pos === null) continue;
		if (!map.has(pos)) map.set(pos, []);
		map.get(pos).push(s);
	}
	return map;
}

function orderView(order) {
	return {
		id: order.id,
		order_idx: order.order_idx,
		commission: order.commision,
		status: order.status,
		prod_status: order.prod_status,
		state: rules.orderState(order),
		sent_date: day(order.sent_date),
		delivery_date: day(order.delivery_date),
		parcels: parseSpeditionNumbers(order.spedition_numbers),
		end_client: order.end_client || null
	};
}

// ── odczyt ────────────────────────────────────────────────────────────────

async function listEligibleOrders(scope, filters = {}, deps) {
	const d = resolveDeps(deps);
	if (!scope || !scope.userId) return { orders: [], more: false };
	const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
	const rows = await d.repo.findEligibleOrders(scope, { ...filters, limit });
	return { orders: rows.slice(0, limit).map(orderView), more: rows.length > limit };
}

/**
 * Zlecenie do kroku 2 kreatora: pozycje z kolekcją, ilością, statusem wysyłki i paczką,
 * rodzaje dostępne dla stanu zlecenia, otwarte zgłoszenia pozycji.
 * @returns {Promise<object|null>} null = poza zakresem konta
 */
async function getOrderForTicket(scope, orderId, deps) {
	const d = resolveDeps(deps);
	const id = Number(orderId);
	if (!scope || !scope.userId || !Number.isInteger(id) || id <= 0) return null;
	const order = await d.repo.findOrderInScope(id, scope);
	if (!order) return null;
	const state = rules.orderState(order);
	if (!state) return { order: orderView(order), state: null, eligibleTypes: [], items: [] };

	const [items, statuses] = await Promise.all([
		d.repo.findOrderItems(order.id),
		d.repo.findPositionStatuses(order.user_ident, order.order_idx)
	]);
	const byPos = statusesByPosition(statuses);
	const open = await d.repo.findOpenTicketsForItems(items.map((i) => i.id));
	const openByItem = new Map(open.map((o) => [Number(o.order_item_id), o]));

	const view = items.map((it, idx) => {
		const pos = Number(it.orderpos) || idx + 1;
		const group = byPos.get(pos) || [];
		const shipped = group.filter((s) => s.shipping_date && s.shipping_date !== '-');
		const parcels = group.filter((s) => s.parcel_code && s.parcel_code !== '-').map((s) => ({ code: s.parcel_code, href: s.parcel_href || null }));
		const openTicket = openByItem.get(Number(it.id));
		return {
			id: it.id,
			pos,
			sub_positions: group.length > 1 ? group.map((s) => s.order_pos) : [],
			department_id: it.department_id || null,
			department: departmentNames(it) || (it.department ? { pl: it.department } : null),
			group: it.group_name || it.asortment_group_number || null,
			summary: itemSummary(it),
			qty: itemQty(it),
			status: group.length ? (group.find((s) => s.status !== '!sent!') || group[0]).status : null,
			shipping_date: shipped.length ? shipped.map((s) => s.shipping_date).sort().pop() : null,
			parcels,
			open_ticket: openTicket ? { id: openTicket.id, number: openTicket.number } : null
		};
	});

	return {
		order: {
			...orderView(order),
			address: order.addr_street ? [order.addr_name, order.addr_street, [order.addr_zip, order.addr_city].filter(Boolean).join(' '), order.addr_country].filter(Boolean).join(', ') : null,
			contact_email: order.user_email || null,
			contact_phone: order.user_phone || null
		},
		state,
		eligibleTypes: rules.eligibleTypes(state),
		items: view
	};
}

// ── zapis ─────────────────────────────────────────────────────────────────

/**
 * Tworzy zgłoszenie.
 * @param {object} scope   orderScope.scopeFromRequest
 * @param {object} input   { type, orderId|null, orderNoText, commission, departmentId, category, description,
 *                           items: [{ orderItemId, qty, category, note }], contactName, contactPhone, contactEmail,
 *                           productAddress, deliveredAt, carrierNoted, quoteBeforeRepair }
 * @param {Array} files    pliki z multera ({ buffer, originalname, size })
 * @returns {Promise<{ok: boolean, status: number, code: string, ticket?: {id, number}, errors?: Array, warnings?: string[]}>}
 */
async function createTicket(scope, input, files, deps) {
	const d = resolveDeps(deps);
	const i = input || {};
	if (!scope || !scope.userId) return result(401, 'not_logged_in');
	const actor = describeActor(scope.cancelCtx || {});

	// ── zlecenie i pozycje w zakresie konta ──
	let order = null;
	let orderItems = [];
	const orderId = Number(i.orderId) || null;
	if (orderId) {
		order = await d.repo.findOrderInScope(orderId, scope);
		if (!order) return result(403, 'order_forbidden');
		if (!rules.orderState(order)) return result(409, 'order_not_eligible');
		orderItems = await d.repo.findOrderItems(order.id);
	}
	const state = order ? rules.orderState(order) : rules.ORDER_STATE.NONE;
	const byId = new Map(orderItems.map((it) => [Number(it.id), it]));
	const errors = [];
	const items = [];
	(Array.isArray(i.items) ? i.items : []).forEach((raw, idx) => {
		const it = byId.get(Number(raw && raw.orderItemId));
		if (!it) { errors.push({ field: 'items', code: 'item_not_in_order', index: idx }); return; }
		items.push({ src: it, key: it.id, qty: Number(raw.qty), maxQty: itemQty(it), category: str(raw.category, 40), note: str(raw.note, rules.LIMITS.maxNote) || null });
	});

	// ── pliki ──
	const checked = fileTools.checkFiles(files);
	errors.push(...checked.errors);

	const toValidate = {
		type: i.type, orderState: state, commission: str(i.commission || (order && order.commision), rules.LIMITS.maxCommission),
		departmentId: order ? null : Number(i.departmentId) || null, orderNoText: str(i.orderNoText), category: str(i.category, 40),
		description: str(i.description), items, filesCount: checked.ok.length,
		contactName: str(i.contactName), contactPhone: str(i.contactPhone), contactEmail: str(i.contactEmail),
		productAddress: str(i.productAddress), deliveredAt: str(i.deliveredAt, 10)
	};
	errors.push(...rules.validate(toValidate));
	if (errors.length) return result(422, 'validation', { errors });

	// ── limity nadużyć ──
	if (await d.repo.countRecentActivity(scope.userId) >= rules.LIMITS.maxPerDay) return result(429, 'daily_limit');
	const itemIds = items.map((it) => Number(it.key)).sort((a, b) => a - b);
	const similar = await d.repo.findRecentSimilar({ userId: scope.userId, orderId: order ? order.id : null, type: i.type, createdBy: actor, commission: toValidate.commission });
	const dup = similar.find((t) => JSON.stringify(t.itemIds) === JSON.stringify(itemIds));
	if (dup) return result(409, 'duplicate', { ticket: { id: dup.id, number: dup.number } });

	// ── migawka właściciela ──
	let owner = order;
	if (!owner) {
		const u = await d.repo.findUserSnapshot(scope.userId);
		if (!u) return result(403, 'order_forbidden');
		owner = { user_id: u.id, user_ident: u.ident, client_name: u.client_name, organization_id: u.organization_id, org_ident: u.org_ident, group_user_id: scope.groupUserId || null, employee_id: null };
	}
	const employeeId = (scope.cancelCtx && scope.cancelCtx.sessionEmployee && scope.cancelCtx.sessionEmployee.id) || owner.employee_id || null;
	const rule = rules.RULES[i.type];
	const description = toValidate.description || null;
	let descriptionPl = null;
	if (description) {
		try { const t = await d.translate(description); descriptionPl = t && t !== description ? String(t).slice(0, 4000) : null; } catch { descriptionPl = null; }
	}

	const ticket = {
		type: i.type,
		status: 'submitted',
		order_id: order ? order.id : null,
		order_no_text: order ? null : (toValidate.orderNoText || null),
		commission: toValidate.commission,
		department_id: order ? null : toValidate.departmentId,
		category: rule.categoryPerItem ? null : toValidate.category,
		description,
		description_pl: descriptionPl,
		contact_name: toValidate.contactName.slice(0, rules.LIMITS.maxContact),
		contact_phone: toValidate.contactPhone.slice(0, rules.LIMITS.maxPhone),
		contact_email: toValidate.contactEmail.slice(0, rules.LIMITS.maxEmail),
		product_address: toValidate.productAddress ? toValidate.productAddress.slice(0, rules.LIMITS.maxAddress) : null,
		end_client: str(i.endClient || (order && order.end_client), 250) || null,
		delivered_at: rule.extra.includes('delivered_at') && toValidate.deliveredAt ? toValidate.deliveredAt : null,
		carrier_noted: rule.extra.includes('carrier_noted') && i.carrierNoted !== undefined && i.carrierNoted !== null && i.carrierNoted !== '' ? (i.carrierNoted === true || i.carrierNoted === 'true' || i.carrierNoted === '1' || i.carrierNoted === 1 ? 1 : 0) : null,
		quote_before_repair: rule.extra.includes('quote_before_repair') ? (i.quoteBeforeRepair === false || i.quoteBeforeRepair === 'false' || i.quoteBeforeRepair === '0' ? 0 : 1) : null,
		lang: str(scope.lang, 2) || null,
		user_id: owner.user_id,
		user_ident: owner.user_ident,
		client_name: owner.client_name,
		organization_id: owner.organization_id,
		organization_ident: owner.org_ident,
		group_user_id: owner.group_user_id || scope.groupUserId || null,
		employee_id: employeeId,
		created_by: actor
	};
	const itemRows = items.map((it) => ({ order_item_id: it.src.id, order_pos: String(it.src.orderpos ?? ''), department_id: it.src.department_id || null, qty: it.qty, category: it.category, note: it.note }));

	// ── pliki tymczasowe → transakcja → przeniesienie ──
	const staged = await fileTools.stageFiles(d.fsp, d.outputData, checked.ok);
	let created;
	try {
		created = await d.repo.createTicket({ ticket, items: itemRows, files: staged, year: yearOf(d.now()) });
	} catch (err) {
		await fileTools.discardFiles(d.fsp, staged);
		d.log(`[service] zapis zgłoszenia nie powiódł się (${actor}):`, err && err.message ? err.message : err);
		return result(500, 'server_error');
	}
	try {
		await fileTools.commitFiles(d.fsp, d.outputData, created.number, staged);
	} catch (err) {
		d.log(`[service] ⚠️ ${created.number}: zgłoszenie zapisane, ale plików nie udało się przenieść:`, err && err.message ? err.message : err);
		await d.repo.addEvent(created.id, { kind: 'export_failed', message: `pliki: ${err && err.message ? err.message : err}` }).catch(() => {});
	}
	d.log(`[service] ${created.number} (${i.type}) przez ${actor}, zlecenie ${order ? order.order_idx : '—'}, pozycji ${itemRows.length}, plików ${staged.length}`);

	const warnings = rules.warnings(toValidate, d.now());
	if (d.isDemoIdent(ticket.user_ident)) {
		d.log(`[service] ${created.number}: konto demo — bez eksportu i maili`);
		return result(201, 'created', { ticket: created, warnings, demo: true });
	}
	await deliverAndNotify(created.id, d, { clientMail: true });
	return result(201, 'created', { ticket: created, warnings });
}

/**
 * Dopisek klienta (tekst i/lub zdjęcia) do niezamkniętego zgłoszenia w zakresie konta.
 */
async function addClientMessage(scope, ticketId, input, files, deps) {
	const d = resolveDeps(deps);
	if (!scope || !scope.userId) return result(401, 'not_logged_in');
	const ticket = await d.repo.findTicketInScope(Number(ticketId) || 0, scope);
	if (!ticket) return result(403, 'ticket_forbidden');
	if (rules.isClosed(ticket.status)) return result(409, 'ticket_closed');
	const message = str(input && input.message, rules.LIMITS.maxDescription);
	const checked = fileTools.checkFiles(files, (await d.repo.findTicketFiles(ticket.id)).length);
	const errors = [...checked.errors];
	if (!message && !checked.ok.length) errors.push({ field: 'message', code: 'required' });
	if (errors.length) return result(422, 'validation', { errors });
	if (await d.repo.countRecentActivity(scope.userId) >= rules.LIMITS.maxPerDay) return result(429, 'daily_limit');

	const actor = describeActor(scope.cancelCtx || {});
	const staged = await fileTools.stageFiles(d.fsp, d.outputData, checked.ok);
	let saved;
	try {
		saved = await d.repo.addClientMessage({ ticketId: ticket.id, actor, message: message || null, files: staged });
	} catch (err) {
		await fileTools.discardFiles(d.fsp, staged);
		d.log(`[service] ${ticket.number}: dopisek nie zapisany:`, err && err.message ? err.message : err);
		return result(500, 'server_error');
	}
	try { await fileTools.commitFiles(d.fsp, d.outputData, ticket.number, staged); } catch (err) {
		d.log(`[service] ⚠️ ${ticket.number}: dopisek zapisany, pliki nie przeniesione:`, err && err.message ? err.message : err);
	}
	d.log(`[service] ${ticket.number}: dopisek klienta (${actor}), plików ${staged.length}`);
	if (d.isDemoIdent(ticket.user_ident)) return result(201, 'created', { eventId: saved.eventId, demo: true });
	await deliverAndNotify(ticket.id, d, { eventId: saved.eventId, clientMail: false });
	return result(201, 'created', { eventId: saved.eventId });
}

async function listTickets(scope, deps) {
	const d = resolveDeps(deps);
	if (!scope || !scope.userId) return [];
	return d.repo.listTickets(scope);
}

/** Zgłoszenie z pozycjami, osią czasu widoczną dla klienta i plikami — albo null (poza zakresem). */
async function getTicket(scope, ticketId, deps, { admin = false } = {}) {
	const d = resolveDeps(deps);
	const id = Number(ticketId) || 0;
	const ticket = admin ? await d.repo.findTicket(id) : (scope && scope.userId ? await d.repo.findTicketInScope(id, scope) : null);
	if (!ticket) return null;
	const [items, events, files] = await Promise.all([
		d.repo.findTicketItems(ticket.id),
		d.repo.findTicketEvents(ticket.id, { clientOnly: !admin }),
		d.repo.findTicketFiles(ticket.id)
	]);
	return {
		...ticket,
		department: departmentNames(ticket, 'department_'),
		canAddMessage: !rules.isClosed(ticket.status),
		items: items.map((it) => ({ ...it, department: departmentNames(it, 'department_'), summary: itemSummary(it) })),
		events,
		files
	};
}

// ── dostarczenie do HKL ───────────────────────────────────────────────────

/** Paczka dla HKL — wszystko, co pójdzie do bazy reklamacji. BEZ CEN. */
async function buildPackage(ticketId, d, eventId = null) {
	const ticket = await d.repo.findTicket(ticketId);
	if (!ticket) return null;
	const [items, files, events] = await Promise.all([d.repo.findTicketItems(ticket.id), d.repo.findTicketFiles(ticket.id), d.repo.findTicketEvents(ticket.id)]);
	let statuses = new Map();
	if (ticket.order_id && ticket.user_ident && ticket.order_idx != null) {
		statuses = statusesByPosition(await d.repo.findPositionStatuses(ticket.user_ident, ticket.order_idx));
	}
	const { buildOrderFileName } = require('../../utils/orderFileName');
	const sent = ticket.order_sent_date ? new Date(ticket.order_sent_date) : null;
	const ageDays = sent && !Number.isNaN(sent.getTime()) ? Math.max(0, Math.floor((d.now().getTime() - sent.getTime()) / 86400000)) : null;
	const message = eventId ? events.find((e) => e.id === eventId) : null;
	return {
		number: ticket.number,
		id: ticket.id,
		created_at: ticket.created_at,
		type: ticket.type,
		status: ticket.status,
		category: ticket.category,
		commission: ticket.commission,
		order: ticket.order_id ? {
			id: ticket.order_id,
			order_idx: ticket.order_idx,
			production_file: ticket.organization_ident && ticket.user_ident ? buildOrderFileName(ticket.organization_ident, ticket.user_ident, ticket.order_idx) : null,
			sent_date: day(ticket.order_sent_date),
			prod_status: ticket.order_prod_status,
			age_days: ageDays
		} : null,
		order_no_text: ticket.order_no_text,
		client: { ident: ticket.user_ident, name: ticket.client_name, organization_ident: ticket.organization_ident, organization_id: ticket.organization_id, group_user_id: ticket.group_user_id, employee_id: ticket.employee_id, lang: ticket.lang },
		department: departmentNames(ticket, 'department_'),
		items: items.map((it) => {
			const group = statuses.get(positionNumber(it.order_pos)) || [];
			return {
				order_item_id: it.order_item_id,
				pos: it.order_pos,
				group: it.group_name || it.asortment_group_number,
				group_number: it.asortment_group_number,
				department: departmentNames(it, 'department_'),
				parameters_short: stripPrices(it.parameters_short),
				summary: itemSummary(it),
				qty: it.qty,
				category: it.category,
				note: it.note,
				shipping_date: group.map((s) => s.shipping_date).filter((s) => s && s !== '-').sort().pop() || null,
				parcel_codes: group.map((s) => s.parcel_code).filter((p) => p && p !== '-')
			};
		}),
		description: ticket.description,
		description_pl: ticket.description_pl,
		contact: { name: ticket.contact_name, phone: ticket.contact_phone, email: ticket.contact_email },
		product_address: ticket.product_address,
		end_client: ticket.end_client,
		transport: ticket.type === 'transport' ? { delivered_at: day(ticket.delivered_at), carrier_noted: ticket.carrier_noted === null ? null : !!ticket.carrier_noted } : null,
		repair: ticket.type === 'repair' ? { quote_before_repair: !!ticket.quote_before_repair } : null,
		files: files.map((f) => ({ id: f.id, event_id: f.event_id, name: f.stored_name, original_name: f.original_name, mime: f.mime, size: f.size })),
		events: events.filter((e) => CLIENT_EVENT_KINDS.includes(e.kind)).map((e) => ({ id: e.id, at: e.created_at, kind: e.kind, status: e.status, message: e.message, actor: e.actor })),
		message: message ? { id: message.id, at: message.created_at, text: message.message, files: files.filter((f) => f.event_id === message.id).map((f) => f.stored_name) } : null,
		created_by: ticket.created_by
	};
}

/**
 * Po COMMIT: paczka do HKL (exporter.deliver) i maile. Każdy błąd → zdarzenie, nigdy wyjątek.
 * @param {object} opts { eventId: dopisek (event-<n>.json) albo null, clientMail: mail potwierdzający do klienta }
 */
async function deliverAndNotify(ticketId, d, { eventId = null, clientMail = true } = {}) {
	const pkg = await buildPackage(ticketId, d, eventId);
	if (!pkg) return;
	const dir = fileTools.ticketDir(d.outputData, pkg.number);
	try {
		const where = await d.exporter.deliver(pkg, { filesDir: dir, eventId });
		await d.repo.addEvent(ticketId, { kind: 'export_ok', message: where ? String(where) : null });
	} catch (err) {
		d.log(`[service] ${pkg.number}: eksport do HKL nie powiódł się:`, err && err.message ? err.message : err);
		await d.repo.addEvent(ticketId, { kind: 'export_failed', message: `${eventId ? `event:${eventId} ` : ''}${err && err.message ? err.message : err}` }).catch(() => {});
	}
	if (clientMail) {
		try {
			const r = await d.mailer.sendClient(pkg);
			await d.repo.addEvent(ticketId, { kind: r && r.skipped ? 'mail_failed' : 'mail_sent', message: `klient: ${r && r.to ? r.to : (r && r.skipped) || '—'}` });
		} catch (err) {
			d.log(`[service] ${pkg.number}: mail do klienta nie wysłany:`, err && err.message ? err.message : err);
			await d.repo.addEvent(ticketId, { kind: 'mail_failed', message: `klient: ${err && err.message ? err.message : err}` }).catch(() => {});
		}
	}
	try {
		const r = await d.mailer.sendHkl(pkg, { filesDir: dir, eventId });
		await d.repo.addEvent(ticketId, { kind: r && r.skipped ? 'mail_failed' : 'mail_sent', message: `serwis: ${r && r.to ? r.to : (r && r.skipped) || '—'}` });
	} catch (err) {
		d.log(`[service] ${pkg.number}: mail do serwisu nie wysłany:`, err && err.message ? err.message : err);
		await d.repo.addEvent(ticketId, { kind: 'mail_failed', message: `serwis: ${err && err.message ? err.message : err}` }).catch(() => {});
	}
}

/**
 * Krok cyklu tła (services/prodStatusCycle.js): ponawia paczki z ostatnim `export_failed`,
 * maksymalnie MAX_EXPORT_ATTEMPTS prób; potem tylko alarm w logu (widoczne w panelu admina).
 */
async function retryFailedExports(deps, { dryRun = false } = {}) {
	const d = resolveDeps(deps);
	const due = await d.repo.findExportRetries(MAX_EXPORT_ATTEMPTS);
	const out = { retried: [], failed: [], planned: due.map((t) => t.number) };
	for (const t of due) {
		if (dryRun) continue;
		const eventMatch = /^event:(\d+)/.exec(String(t.event_ref || ''));
		const eventId = eventMatch ? Number(eventMatch[1]) : null;
		try {
			const pkg = await buildPackage(t.id, d, eventId);
			const where = await d.exporter.deliver(pkg, { filesDir: fileTools.ticketDir(d.outputData, pkg.number), eventId });
			await d.repo.addEvent(t.id, { kind: 'export_ok', message: where ? String(where) : null });
			out.retried.push(t.number);
			d.log(`[service] ${t.number}: ponowny eksport do HKL udany`);
		} catch (err) {
			await d.repo.addEvent(t.id, { kind: 'export_failed', message: `${eventId ? `event:${eventId} ` : ''}${err && err.message ? err.message : err}` }).catch(() => {});
			out.failed.push({ number: t.number, error: err && err.message ? err.message : String(err) });
			d.log(`[service] ${t.number}: ponowny eksport nieudany (próba ${Number(t.attempts) + 1}/${MAX_EXPORT_ATTEMPTS}):`, err && err.message ? err.message : err);
		}
	}
	return out;
}

/** Ręczne „Wyślij ponownie do HKL” z panelu admina. */
async function resendToHkl(ticketId, deps) {
	const d = resolveDeps(deps);
	await deliverAndNotify(Number(ticketId), d, { clientMail: false });
}

/** Admin: zmiana statusu + wiadomość do klienta (mail i zdarzenie `status`). */
async function changeStatus(ticketId, { status, message, actor }, deps) {
	const d = resolveDeps(deps);
	if (!rules.STATUSES.includes(status)) return result(422, 'validation', { errors: [{ field: 'status', code: 'unknown' }] });
	const ticket = await d.repo.findTicket(Number(ticketId) || 0);
	if (!ticket) return result(404, 'not_found');
	await d.repo.updateStatus(ticket.id, { status, actor: actor || 'admin', message: str(message, 2000) || null });
	d.log(`[service] ${ticket.number}: status ${ticket.status} → ${status} (${actor || 'admin'})`);
	if (!d.isDemoIdent(ticket.user_ident)) {
		try {
			const pkg = await buildPackage(ticket.id, d);
			const r = await d.mailer.sendStatus(pkg, { status, message: str(message, 2000) });
			await d.repo.addEvent(ticket.id, { kind: r && r.skipped ? 'mail_failed' : 'mail_sent', message: `klient (status): ${r && r.to ? r.to : (r && r.skipped) || '—'}` });
		} catch (err) {
			await d.repo.addEvent(ticket.id, { kind: 'mail_failed', message: `klient (status): ${err && err.message ? err.message : err}` }).catch(() => {});
		}
	}
	return result(200, 'updated');
}

module.exports = {
	MAX_EXPORT_ATTEMPTS,
	CLIENT_EVENT_KINDS,
	itemQty,
	itemSummary,
	stripPrices,
	listEligibleOrders,
	getOrderForTicket,
	createTicket,
	addClientMessage,
	listTickets,
	getTicket,
	buildPackage,
	deliverAndNotify,
	retryFailedExports,
	resendToHkl,
	changeStatus
};
