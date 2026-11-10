/**
 * Repozytorium MySQL modułu „Serwis” — jedyne miejsce z SQL-em.
 * Serwis (`index.js`) dostaje ten obiekt przez wstrzyknięcie, testy podają atrapę.
 *
 * ⚠️ `db/core.selectQuery` zwraca `false` przy zerowej liczbie wierszy (i przy błędzie,
 * który tylko loguje) — `rows()` normalizuje do `[]`.
 * Zakres konta: `scopeWhere` z services/orderScope.js — na `order` (alias `o`) i na
 * `service_ticket` (alias `t`, ta sama migawka kolumn user_id/employee_id/group_user_id).
 */

'use strict';

const { selectQuery, connetToDb } = require('../../db/core');
const { scopeWhere } = require('../orderScope');
const { LIMITS, CLOSED_STATUSES } = require('./rules');

const CLIENT_EVENT_KINDS = ['created', 'client_message', 'status'];

async function rows(sql, params) {
	const r = await selectQuery(sql, params);
	return Array.isArray(r) ? r : [];
}

/** `invoice_end_client` należy do modułu faktur — bez niego lista nie może paść. */
let endClientTable = null;
async function hasEndClientTable() {
	if (endClientTable === null) {
		const r = await rows("SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_end_client'");
		endClientTable = r.length > 0;
	}
	return endClientTable;
}

async function endClientJoin() {
	return (await hasEndClientTable())
		? { select: ', ec.name AS end_client', join: 'LEFT JOIN invoice_end_client ec ON ec.id = o.end_client_id', search: ' OR ec.name LIKE ?' }
		: { select: ', NULL AS end_client', join: '', search: '' };
}

function like(q) { return `%${String(q).replace(/[%_\\]/g, (c) => `\\${c}`)}%`; }

/**
 * Zlecenia konta do kroku 1 kreatora.
 * @param {object} filters { tab: 'delivered'|'in_progress', q, from, to, limit }
 */
async function findEligibleOrders(scope, filters = {}) {
	const where = scopeWhere(scope);
	const ec = await endClientJoin();
	const clauses = [where.sql, "o.status = 'sent'"];
	const params = [...where.params];
	clauses.push(filters.tab === 'in_progress' ? "(o.prod_status IS NULL OR o.prod_status <> '!sent!')" : "o.prod_status = '!sent!'");
	if (filters.from) { clauses.push('DATE(o.sent_date) >= ?'); params.push(filters.from); }
	else { clauses.push('o.sent_date >= DATE_SUB(NOW(), INTERVAL ? MONTH)'); params.push(LIMITS.eligibleMonths); }
	if (filters.to) { clauses.push('DATE(o.sent_date) <= ?'); params.push(filters.to); }
	if (filters.q) {
		clauses.push(`(o.order_idx LIKE ? OR o.commision LIKE ?${ec.search})`);
		params.push(like(filters.q), like(filters.q));
		if (ec.search) params.push(like(filters.q));
	}
	const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
	return rows(
		`SELECT o.id, o.order_idx, o.commision, o.status, o.prod_status, o.sent_date, o.delivery_date, o.spedition_numbers${ec.select}
		   FROM \`order\` o ${ec.join}
		  WHERE ${clauses.join(' AND ')}
		  ORDER BY o.sent_date DESC, o.id DESC
		  LIMIT ?`,
		[...params, limit + 1]
	);
}

/** Zlecenie w zakresie konta razem z migawką właściciela i adresem dostawy — albo null. */
async function findOrderInScope(orderId, scope) {
	const where = scopeWhere(scope);
	const ec = await endClientJoin();
	const r = await rows(
		`SELECT o.id, o.order_idx, o.commision, o.status, o.prod_status, o.sent_date, o.delivery_date, o.spedition_numbers,
		        o.user_id, o.group_user_id, o.employee_id,
		        u.ident AS user_ident, u.client_name, u.email AS user_email, u.phone AS user_phone,
		        COALESCE(o.organization_id, u.organization_id) AS organization_id,
		        org.ident AS org_ident, org.name AS org_name,
		        COALESCE(sa.name, da.name) AS addr_name, COALESCE(sa.street, da.street) AS addr_street,
		        COALESCE(sa.zip, da.zip) AS addr_zip, COALESCE(sa.city, da.city) AS addr_city,
		        COALESCE(sa.country, da.country) AS addr_country, COALESCE(sa.phone, da.phone_number) AS addr_phone${ec.select}
		   FROM \`order\` o
		   JOIN \`user\` u ON u.id = o.user_id
		   LEFT JOIN organization org ON org.id = COALESCE(o.organization_id, u.organization_id)
		   LEFT JOIN send_address sa ON sa.id = o.send_address_id
		   LEFT JOIN delivery_address da ON da.id = o.delivery_address_id
		   ${ec.join}
		  WHERE o.id = ? AND ${where.sql}
		  LIMIT 1`,
		[orderId, ...where.params]
	);
	return r[0] || null;
}

/** Pozycje zlecenia z kolekcją (`product_group.department_id`) i nazwami działu w 5 językach. */
async function findOrderItems(orderId) {
	return rows(
		`SELECT oi.id, oi.orderpos, oi.name, oi.commision, oi.asortment_group_number, oi.department, oi.group_name,
		        oi.parameters_short, oi.amount,
		        pg.department_id, d.name_pl, d.name_en, d.name_de, d.name_fr, d.name_nl
		   FROM order_item oi
		   LEFT JOIN product_group pg ON pg.group_number = LPAD(oi.asortment_group_number, 2, '0')
		   LEFT JOIN department d ON d.id = pg.department_id
		  WHERE oi.order_id = ?
		  ORDER BY oi.orderpos, oi.id`,
		[orderId]
	);
}

async function findPositionStatuses(userIdent, orderIdx) {
	if (!userIdent || orderIdx === null || orderIdx === undefined) return [];
	return rows('SELECT order_pos, status, shipping_date, parcel_code FROM position_statuses WHERE user_ident = ? AND order_idx = ?', [userIdent, String(orderIdx)]);
}

async function findDepartments() {
	return rows('SELECT id, name_pl, name_en, name_de, name_fr, name_nl FROM department ORDER BY id');
}

/** Migawka właściciela dla zgłoszenia bez zlecenia (klient z sesji/kontekstu). */
async function findUserSnapshot(userId) {
	const r = await rows(
		`SELECT u.id, u.ident, u.client_name, u.email, u.phone, u.organization_id, org.ident AS org_ident, org.name AS org_name
		   FROM \`user\` u LEFT JOIN organization org ON org.id = u.organization_id
		  WHERE u.id = ? LIMIT 1`,
		[userId]
	);
	return r[0] || null;
}

/** Zgłoszenia i dopiski konta z ostatniej doby (limit 20/dobę). */
async function countRecentActivity(userId) {
	const r = await rows(
		`SELECT COUNT(*) AS n FROM service_ticket_event e JOIN service_ticket t ON t.id = e.ticket_id
		  WHERE t.user_id = ? AND e.kind IN ('created', 'client_message') AND e.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`,
		[userId]
	);
	return Number(r[0] && r[0].n) || 0;
}

/** Zgłoszenia tego samego autora, zlecenia i rodzaju z ostatnich 2 minut, z listą pozycji. */
async function findRecentSimilar({ userId, orderId, type, createdBy, commission }) {
	const tickets = await rows(
		`SELECT t.id, t.number FROM service_ticket t
		  WHERE t.user_id = ? AND t.type = ? AND t.created_by = ? AND (t.order_id <=> ?) AND (? IS NULL OR t.commission = ?)
		    AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)`,
		[userId, type, createdBy, orderId ?? null, orderId ? null : commission, commission, Math.round(LIMITS.duplicateWindowMs / 1000)]
	);
	if (!tickets.length) return [];
	const items = await rows('SELECT ticket_id, order_item_id FROM service_ticket_item WHERE ticket_id IN (?)', [tickets.map((t) => t.id)]);
	return tickets.map((t) => ({ ...t, itemIds: items.filter((i) => i.ticket_id === t.id).map((i) => Number(i.order_item_id)).sort((a, b) => a - b) }));
}

/** Otwarte zgłoszenia dotyczące podanych pozycji zlecenia (ostrzeżenie w kreatorze). */
async function findOpenTicketsForItems(orderItemIds) {
	if (!orderItemIds || !orderItemIds.length) return [];
	return rows(
		`SELECT i.order_item_id, t.id, t.number, t.status FROM service_ticket_item i JOIN service_ticket t ON t.id = i.ticket_id
		  WHERE i.order_item_id IN (?) AND t.status NOT IN (?)`,
		[orderItemIds, CLOSED_STATUSES]
	);
}

function ticketNumber(id, year) { return `SRV-${year}-${String(id).padStart(5, '0')}`; }

/**
 * Zapis zgłoszenia, pozycji, zdarzenia `created` i plików w JEDNEJ transakcji.
 * Numer `SRV-<rok>-<id>` z AUTO_INCREMENT (UPDATE po INSERT, ta sama transakcja).
 * @returns {Promise<{ id: number, number: string }>}
 */
async function createTicket({ ticket, items, files, year }) {
	const conn = await connetToDb();
	try {
		await conn.beginTransaction();
		const [ins] = await conn.query('INSERT INTO service_ticket SET ?', [ticket]);
		const id = ins.insertId;
		const number = ticketNumber(id, year);
		await conn.query('UPDATE service_ticket SET number = ? WHERE id = ?', [number, id]);
		for (const it of items) await conn.query('INSERT INTO service_ticket_item SET ?', [{ ...it, ticket_id: id }]);
		await conn.query('INSERT INTO service_ticket_event SET ?', [{ ticket_id: id, actor: ticket.created_by, kind: 'created' }]);
		for (const f of files) {
			await conn.query('INSERT INTO service_ticket_file SET ?', [{ ticket_id: id, event_id: null, stored_name: f.storedName, original_name: f.originalName, mime: f.mime, size: f.size }]);
		}
		await conn.commit();
		return { id, number };
	} catch (err) {
		try { await conn.rollback(); } catch { /* połączenie mogło paść */ }
		throw err;
	} finally {
		await conn.end();
	}
}

/** Dopisek klienta: zdarzenie `client_message` + jego pliki, jedna transakcja. */
async function addClientMessage({ ticketId, actor, message, files }) {
	const conn = await connetToDb();
	try {
		await conn.beginTransaction();
		const [ev] = await conn.query('INSERT INTO service_ticket_event SET ?', [{ ticket_id: ticketId, actor, kind: 'client_message', message }]);
		for (const f of files) {
			await conn.query('INSERT INTO service_ticket_file SET ?', [{ ticket_id: ticketId, event_id: ev.insertId, stored_name: f.storedName, original_name: f.originalName, mime: f.mime, size: f.size }]);
		}
		await conn.query('UPDATE service_ticket SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [ticketId]);
		await conn.commit();
		return { eventId: ev.insertId };
	} catch (err) {
		try { await conn.rollback(); } catch { /* j.w. */ }
		throw err;
	} finally {
		await conn.end();
	}
}

async function addEvent(ticketId, { actor = 'system', kind, status = null, message = null }) {
	const conn = await connetToDb();
	try {
		const [r] = await conn.query('INSERT INTO service_ticket_event SET ?', [{ ticket_id: ticketId, actor, kind, status, message: message === null ? null : String(message).slice(0, 2000) }]);
		return r.insertId;
	} finally {
		await conn.end();
	}
}

/** Zmiana statusu (admin) — zdarzenie `status` z wiadomością do klienta, `closed_at` przy zamknięciu. */
async function updateStatus(ticketId, { status, actor, message }) {
	const conn = await connetToDb();
	try {
		await conn.beginTransaction();
		await conn.query('UPDATE service_ticket SET status = ?, closed_at = ? WHERE id = ?', [status, CLOSED_STATUSES.includes(status) ? new Date() : null, ticketId]);
		const [ev] = await conn.query('INSERT INTO service_ticket_event SET ?', [{ ticket_id: ticketId, actor, kind: 'status', status, message: message || null }]);
		await conn.commit();
		return ev.insertId;
	} catch (err) {
		try { await conn.rollback(); } catch { /* j.w. */ }
		throw err;
	} finally {
		await conn.end();
	}
}

const TICKET_COLUMNS = `t.id, t.number, t.type, t.status, t.order_id, t.order_no_text, t.commission, t.department_id, t.category,
	t.description, t.description_pl, t.contact_name, t.contact_phone, t.contact_email, t.product_address, t.end_client,
	t.delivered_at, t.carrier_noted, t.quote_before_repair, t.lang, t.user_id, t.user_ident, t.client_name, t.organization_id,
	t.organization_ident, t.group_user_id, t.employee_id, t.created_by, t.hkl_ref, t.created_at, t.updated_at, t.closed_at,
	o.order_idx, o.sent_date AS order_sent_date, o.prod_status AS order_prod_status, o.status AS order_status,
	d.name_pl AS department_pl, d.name_en AS department_en, d.name_de AS department_de, d.name_fr AS department_fr, d.name_nl AS department_nl`;
const TICKET_FROM = 'FROM service_ticket t LEFT JOIN `order` o ON o.id = t.order_id LEFT JOIN department d ON d.id = t.department_id';

/** „Moje zgłoszenia” — zakres konta jak na listach zleceń. */
async function listTickets(scope) {
	const where = scopeWhere(scope, 't');
	return rows(
		`SELECT ${TICKET_COLUMNS},
		        (SELECT MAX(e.created_at) FROM service_ticket_event e WHERE e.ticket_id = t.id AND e.kind IN (?)) AS last_change
		   ${TICKET_FROM}
		  WHERE ${where.sql}
		  ORDER BY t.created_at DESC
		  LIMIT 200`,
		[CLIENT_EVENT_KINDS, ...where.params]
	);
}

async function findTicketInScope(ticketId, scope) {
	const where = scopeWhere(scope, 't');
	const r = await rows(`SELECT ${TICKET_COLUMNS} ${TICKET_FROM} WHERE t.id = ? AND ${where.sql} LIMIT 1`, [ticketId, ...where.params]);
	return r[0] || null;
}

async function findTicket(ticketId) {
	const r = await rows(`SELECT ${TICKET_COLUMNS} ${TICKET_FROM} WHERE t.id = ? LIMIT 1`, [ticketId]);
	return r[0] || null;
}

async function findTicketItems(ticketId) {
	return rows(
		`SELECT i.id, i.order_item_id, i.order_pos, i.department_id, i.qty, i.category, i.note,
		        oi.asortment_group_number, oi.group_name, oi.parameters_short, oi.name,
		        d.name_pl AS department_pl, d.name_en AS department_en, d.name_de AS department_de, d.name_fr AS department_fr, d.name_nl AS department_nl
		   FROM service_ticket_item i
		   LEFT JOIN order_item oi ON oi.id = i.order_item_id
		   LEFT JOIN department d ON d.id = i.department_id
		  WHERE i.ticket_id = ? ORDER BY i.id`,
		[ticketId]
	);
}

async function findTicketEvents(ticketId, { clientOnly = false } = {}) {
	const kinds = clientOnly ? ' AND kind IN (?)' : '';
	return rows(`SELECT id, created_at, actor, kind, status, message FROM service_ticket_event WHERE ticket_id = ?${kinds} ORDER BY created_at, id`, clientOnly ? [ticketId, CLIENT_EVENT_KINDS] : [ticketId]);
}

async function findTicketFiles(ticketId) {
	return rows('SELECT id, event_id, stored_name, original_name, mime, size, created_at FROM service_ticket_file WHERE ticket_id = ? ORDER BY id', [ticketId]);
}

async function findFile(ticketId, fileId) {
	const r = await rows('SELECT id, ticket_id, event_id, stored_name, original_name, mime, size FROM service_ticket_file WHERE ticket_id = ? AND id = ? LIMIT 1', [ticketId, fileId]);
	return r[0] || null;
}

/** Zgłoszenia z nieudanym eksportem bez późniejszego `export_ok` — do ponawiania w cyklu tła. */
async function findExportRetries(maxAttempts) {
	return rows(
		`SELECT t.id, t.number, f.kind, f.event_ref,
		        (SELECT COUNT(*) FROM service_ticket_event e WHERE e.ticket_id = t.id AND e.kind = 'export_failed' AND e.created_at > COALESCE((SELECT MAX(ok.created_at) FROM service_ticket_event ok WHERE ok.ticket_id = t.id AND ok.kind = 'export_ok'), '1970-01-01')) AS attempts
		   FROM service_ticket t
		   JOIN (SELECT ticket_id, MAX(id) AS last_id FROM service_ticket_event WHERE kind IN ('export_ok', 'export_failed') GROUP BY ticket_id) l ON l.ticket_id = t.id
		   JOIN (SELECT id, kind, message AS event_ref FROM service_ticket_event) f ON f.id = l.last_id
		  WHERE f.kind = 'export_failed'
		 HAVING attempts < ?
		  ORDER BY t.id`,
		[maxAttempts]
	);
}

/** Panel admina: lista z filtrami i paginacją. */
async function listAllTickets(filters = {}, { page = 1, limit = 25 } = {}) {
	const clauses = ['1=1'];
	const params = [];
	if (filters.type) { clauses.push('t.type = ?'); params.push(filters.type); }
	if (filters.status) { clauses.push('t.status = ?'); params.push(filters.status); }
	if (filters.organization) { clauses.push('t.organization_ident = ?'); params.push(filters.organization); }
	if (filters.client) { clauses.push('(t.user_ident LIKE ? OR t.client_name LIKE ?)'); params.push(like(filters.client), like(filters.client)); }
	if (filters.q) { clauses.push('(t.number LIKE ? OR t.commission LIKE ? OR o.order_idx LIKE ?)'); params.push(like(filters.q), like(filters.q), like(filters.q)); }
	if (filters.from) { clauses.push('DATE(t.created_at) >= ?'); params.push(filters.from); }
	if (filters.to) { clauses.push('DATE(t.created_at) <= ?'); params.push(filters.to); }
	if (filters.exportFailed) {
		clauses.push(`(SELECT e.kind FROM service_ticket_event e WHERE e.ticket_id = t.id AND e.kind IN ('export_ok', 'export_failed') ORDER BY e.id DESC LIMIT 1) = 'export_failed'`);
	}
	const where = clauses.join(' AND ');
	const total = await rows(`SELECT COUNT(*) AS n ${TICKET_FROM} WHERE ${where}`, params);
	const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
	const offset = (Math.max(Number(page) || 1, 1) - 1) * safeLimit;
	const list = await rows(
		`SELECT ${TICKET_COLUMNS},
		        (SELECT e.kind FROM service_ticket_event e WHERE e.ticket_id = t.id AND e.kind IN ('export_ok', 'export_failed') ORDER BY e.id DESC LIMIT 1) AS export_state
		   ${TICKET_FROM} WHERE ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
		[...params, safeLimit, offset]
	);
	return { rows: list, total: Number(total[0] && total[0].n) || 0, page: Math.max(Number(page) || 1, 1), limit: safeLimit };
}

async function listOrganizations() {
	return rows('SELECT DISTINCT organization_ident FROM service_ticket WHERE organization_ident IS NOT NULL ORDER BY organization_ident');
}

module.exports = {
	CLIENT_EVENT_KINDS,
	ticketNumber,
	findEligibleOrders,
	findOrderInScope,
	findOrderItems,
	findPositionStatuses,
	findDepartments,
	findUserSnapshot,
	countRecentActivity,
	findRecentSimilar,
	findOpenTicketsForItems,
	createTicket,
	addClientMessage,
	addEvent,
	updateStatus,
	listTickets,
	findTicketInScope,
	findTicket,
	findTicketItems,
	findTicketEvents,
	findTicketFiles,
	findFile,
	findExportRetries,
	listAllTickets,
	listOrganizations
};
