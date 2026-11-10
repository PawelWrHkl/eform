/**
 * Moduł „Serwis” — zgłoszenia reklamacyjne i serwisowe klienta (`/service/*`).
 * Montowany w server.js tylko przy `SERVICE_ENABLED=true|admins` (config.service).
 *
 *   GET  /service                      strona startowa: rodzaje + „Moje zgłoszenia”
 *   GET  /service/new[?order=ID]       kreator (4 kroki); `order` = zlecenie wybrane z podglądu
 *   GET  /service/rules.js             TEN SAM plik reguł, który waliduje serwer (services/serviceTickets/rules.js)
 *   GET  /service/api/orders           JSON: zlecenia konta do kroku 1 (tab, q, from, to)
 *   GET  /service/api/orders/:id       JSON: zlecenie + pozycje + statusy + dostępne rodzaje
 *   POST /service/api/tickets          multipart: `payload` (JSON) + `files[]` → { ticket }
 *   GET  /service/tickets/:id          podgląd zgłoszenia z osią czasu i dopiskiem
 *   POST /service/tickets/:id/messages multipart: `message` + `files[]`
 *   GET  /service/tickets/:id/files/:fileId[?thumb=1]  plik ze sprawdzeniem dostępu (admin albo zakres konta)
 *
 * Odpowiedzi API: JSON 401/403/422 (jak routes/assistant.js), strony: przekierowanie na login.
 */

'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');

const config = require('../config');
const { scopeFromRequest } = require('../services/orderScope');
const { canAccessService } = require('../services/serviceTickets/access');
const service = require('../services/serviceTickets');
const rules = require('../services/serviceTickets/rules');
const fileTools = require('../services/serviceTickets/files');
const repo = require('../services/serviceTickets/repository');
const labels = require('../services/assistant/labels');
const { loadEmployeePermissions } = require('../middleware/employeePermissions');
const { log } = require('../utils/logging');

const router = express.Router();
const RULES_FILE = path.join(__dirname, '..', 'services', 'serviceTickets', 'rules.js');

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: rules.LIMITS.maxFileBytes, files: rules.LIMITS.maxFiles, fieldSize: 1024 * 1024 }
});

function isApi(req) { return req.path.startsWith('/api/') || req.method !== 'GET' || req.xhr || !req.accepts('html'); }

router.use((req, res, next) => {
	const user = req.session && req.session.user;
	if (!user) return isApi(req) ? res.status(401).json({ success: false, error: 'not_logged_in' }) : res.redirect('/user/login');
	if (!canAccessService(user, config.service)) return isApi(req) ? res.status(403).json({ success: false, error: 'forbidden' }) : res.status(403).render('no-permission.njk');
	return next();
});
router.use(loadEmployeePermissions);

function lang(req, res) { return labels.normalizeLang(res.locals.locale || (typeof req.getLocale === 'function' ? req.getLocale() : 'en')); }

/** Cały pod-słownik `service.*` w języku strony (z polskim fallbackiem) — dla skryptów kreatora. */
function serviceStrings(l) {
	const merge = (a, b) => {
		const out = { ...(a || {}) };
		for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' ? merge(out[k], v) : v;
		return out;
	};
	return merge(labels.loadLocale('pl').service, labels.loadLocale(l).service);
}

/** JSON do `<script type="application/json">`: `<` → `\\u003c`, żeby dane klienta nie zamknęły znacznika. */
function json(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }

function statusLabels(res) {
	return { received: res.__('order.status_order_sent'), '!sent!': res.__('!sent!'), '!preparation!': res.__('!preparation!'), '!production!': res.__('!production!'), '!backorder!': res.__('!backorder!') };
}

function departmentsFor(l, rows) {
	return rows.map((d) => ({ id: d.id, name: d[`name_${l}`] || d.name_pl }));
}

/** `2026-11-09 14:54` w czasie polskim — mysql2 oddaje obiekty Date, a `Date.toString()` w szablonie jest nieczytelne. */
function fmtDate(v, withTime = true) {
	if (!v) return '';
	const d = v instanceof Date ? v : new Date(v);
	if (Number.isNaN(d.getTime())) return String(v).slice(0, withTime ? 16 : 10);
	const parts = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).formatToParts(d);
	const g = (t) => (parts.find((x) => x.type === t) || {}).value || '';
	return `${g('day')}.${g('month')}.${g('year')}${withTime ? ` ${g('hour')}:${g('minute')}` : ''}`;
}

function ticketView(t, l) {
	return {
		...t,
		department_name: t[`department_${l}`] || t.department_pl || null,
		created_label: fmtDate(t.created_at),
		last_change_label: fmtDate(t.last_change || t.updated_at),
		delivered_label: fmtDate(t.delivered_at, false),
		events: Array.isArray(t.events) ? t.events.map((e) => ({ ...e, created_label: fmtDate(e.created_at) })) : t.events
	};
}

function uploadFiles(req, res, next) {
	upload.array('files', rules.LIMITS.maxFiles)(req, res, (err) => {
		if (!err) return next();
		const code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_big' : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'too_many_files' : 'upload_failed';
		return res.status(422).json({ success: false, code: 'validation', errors: [{ field: 'files', code, index: -1 }] });
	});
}

function parsePayload(req) {
	if (req.body && typeof req.body.payload === 'string') {
		try { return JSON.parse(req.body.payload); } catch { return null; }
	}
	return req.body || {};
}

// ── strony ────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
	try {
		const l = lang(req, res);
		const scope = scopeFromRequest(req, l);
		const tickets = (await service.listTickets(scope)).map((t) => ticketView(t, l));
		res.render('service/index.njk', { tickets, types: rules.TYPES, isAdminUser: !!req.session.user.isAdmin });
	} catch (err) { next(err); }
});

router.get('/new', async (req, res, next) => {
	try {
		const l = lang(req, res);
		const scope = scopeFromRequest(req, l);
		const [departments, snapshot] = await Promise.all([repo.findDepartments(), scope.userId ? repo.findUserSnapshot(scope.userId) : null]);
		const emp = req.session.employee;
		const defaults = {
			contactName: emp ? [emp.name, emp.surname].filter(Boolean).join(' ') : (snapshot && snapshot.client_name) || '',
			contactPhone: (emp && emp.phone) || (snapshot && snapshot.phone) || '',
			contactEmail: (snapshot && snapshot.email) || ''
		};
		res.render('service/wizard.njk', {
			rulesJson: json(rules.clientRules()),
			stringsJson: json(serviceStrings(l)),
			departmentsJson: json(departmentsFor(l, departments)),
			defaultsJson: json(defaults),
			statusLabelsJson: json(statusLabels(res)),
			preselectedOrder: Number(req.query.order) || null,
			noOrder: req.query.order === 'none',
			preselectedType: rules.TYPES.includes(req.query.type) ? req.query.type : null,
			lang: l
		});
	} catch (err) { next(err); }
});

router.get('/rules.js', (req, res) => {
	res.type('application/javascript');
	res.sendFile(RULES_FILE);
});

router.get('/tickets', (req, res) => res.redirect('/service'));

router.get('/tickets/:id', async (req, res, next) => {
	try {
		const l = lang(req, res);
		const scope = scopeFromRequest(req, l);
		const ticket = await service.getTicket(scope, req.params.id);
		if (!ticket) return res.status(404).render('error.njk', { message: res.__('service.err.ticket_forbidden') });
		res.render('service/ticket.njk', {
			ticket: ticketView(ticket, l),
			items: ticket.items.map((it) => ({ ...it, department_name: (it.department && (it.department[l] || it.department.pl)) || '' })),
			rulesJson: json(rules.clientRules()),
			stringsJson: json(serviceStrings(l)),
			lang: l
		});
	} catch (err) { next(err); }
});

// ── pliki (nigdy katalog statyczny) ───────────────────────────────────────

router.get('/tickets/:id/files/:fileId', async (req, res, next) => {
	try {
		const scope = scopeFromRequest(req, lang(req, res));
		const admin = !!req.session.user.isAdmin;
		const ticket = admin ? await repo.findTicket(Number(req.params.id) || 0) : await repo.findTicketInScope(Number(req.params.id) || 0, scope);
		if (!ticket) return res.status(404).end();
		const file = await repo.findFile(ticket.id, Number(req.params.fileId) || 0);
		if (!file) return res.status(404).end();
		const dir = fileTools.ticketDir(config.outputData, ticket.number);
		const full = path.join(dir, path.basename(file.stored_name));
		if (req.query.thumb && fileTools.isImage(file.mime)) {
			const thumb = path.join(dir, `.thumb-${path.basename(file.stored_name)}.jpg`);
			try {
				await require('fs').promises.access(thumb);
			} catch {
				try {
					await require('sharp')(full).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(thumb);
				} catch (err) {
					// HEIC bez dekodera itp. — oddajemy oryginał
					return res.type(file.mime).sendFile(full);
				}
			}
			return res.type('image/jpeg').sendFile(thumb);
		}
		res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file.original_name).replace(/'/g, '%27')}"`);
		res.type(file.mime).sendFile(full);
	} catch (err) { next(err); }
});

// ── API kreatora ──────────────────────────────────────────────────────────

router.get('/api/orders', async (req, res) => {
	try {
		const scope = scopeFromRequest(req, lang(req, res));
		const q = req.query || {};
		const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
		const out = await service.listEligibleOrders(scope, { tab: q.tab === 'in_progress' ? 'in_progress' : 'delivered', q: String(q.q || '').trim().slice(0, 80), from: date(q.from), to: date(q.to), limit: 50 });
		res.json({ success: true, ...out });
	} catch (err) {
		log('[service] /api/orders:', err && err.message);
		res.status(500).json({ success: false, error: 'server_error' });
	}
});

router.get('/api/orders/:id', async (req, res) => {
	try {
		const scope = scopeFromRequest(req, lang(req, res));
		const view = await service.getOrderForTicket(scope, req.params.id);
		if (!view) return res.status(404).json({ success: false, error: 'order_forbidden' });
		res.json({ success: true, ...view });
	} catch (err) {
		log('[service] /api/orders/:id:', err && err.message);
		res.status(500).json({ success: false, error: 'server_error' });
	}
});

router.post('/api/tickets', uploadFiles, async (req, res) => {
	const input = parsePayload(req);
	if (!input) return res.status(422).json({ success: false, code: 'validation', errors: [{ field: 'payload', code: 'invalid' }] });
	try {
		const scope = scopeFromRequest(req, lang(req, res));
		const r = await service.createTicket(scope, input, req.files || []);
		const { ok, status, ...body } = r;
		res.status(status).json({ success: ok, ...body });
	} catch (err) {
		log('[service] POST /api/tickets:', err && err.stack || err);
		res.status(500).json({ success: false, code: 'server_error' });
	}
});

router.post('/tickets/:id/messages', uploadFiles, async (req, res) => {
	try {
		const scope = scopeFromRequest(req, lang(req, res));
		const r = await service.addClientMessage(scope, req.params.id, { message: req.body && req.body.message }, req.files || []);
		const { ok, status, ...body } = r;
		res.status(status).json({ success: ok, ...body });
	} catch (err) {
		log('[service] POST /tickets/:id/messages:', err && err.stack || err);
		res.status(500).json({ success: false, code: 'server_error' });
	}
});

module.exports = router;
module.exports.fmtDate = fmtDate;
