/**
 * Panel admina modułu „Serwis” (`/admin/service`): lista zgłoszeń z filtrami, podgląd z plikami
 * i pełną osią czasu (także zdarzenia eksportu), „Wyślij ponownie do HKL”, ręczna zmiana statusu
 * z wiadomością do klienta (mail + zdarzenie). Ręczna zmiana to rozwiązanie tymczasowe, dopóki
 * statusy nie wracają z bazy reklamacji HKL. Pliki serwuje routes/service.js (admin omija zakres).
 */

'use strict';

const express = require('express');
const config = require('../../config');
const service = require('../../services/serviceTickets');
const repo = require('../../services/serviceTickets/repository');
const rules = require('../../services/serviceTickets/rules');
const { log } = require('../../utils/logging');
const { fmtDate } = require('../service');

const router = express.Router();

router.use((req, res, next) => {
	if (!req.session || !req.session.user || !req.session.user.isAdmin) return res.status(403).render('no-permission.njk');
	if (config.service.mode === 'off') return res.status(404).render('error.njk', { message: 'Moduł Serwis jest wyłączony (SERVICE_ENABLED).' });
	return next();
});

const TYPE_PL = { repair: 'Naprawa', complaint: 'Reklamacja techniczna', transport: 'Uszkodzenie w transporcie', delivery: 'Zapytanie o dostawę' };
const STATUS_PL = { submitted: 'Przekazane', accepted: 'Przyjęte', in_progress: 'W trakcie', waiting_for_client: 'Czeka na klienta', resolved_accepted: 'Uznane', resolved_rejected: 'Odrzucone', closed: 'Zamknięte' };
const EVENT_PL = { created: 'Zgłoszenie', client_message: 'Dopisek klienta', status: 'Zmiana statusu', export_ok: 'Eksport do HKL OK', export_failed: 'Eksport do HKL NIEUDANY', mail_sent: 'Mail wysłany', mail_failed: 'Mail nieudany' };

function date(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : ''; }

router.get('/', async (req, res, next) => {
	try {
		const q = req.query || {};
		const filters = {
			type: rules.TYPES.includes(q.type) ? q.type : '',
			status: rules.STATUSES.includes(q.status) ? q.status : '',
			organization: String(q.organization || '').slice(0, 70),
			client: String(q.client || '').trim().slice(0, 80),
			q: String(q.q || '').trim().slice(0, 80),
			from: date(q.from),
			to: date(q.to),
			exportFailed: q.exportFailed === '1'
		};
		const data = await repo.listAllTickets(filters, { page: Number(q.page) || 1, limit: 25 });
		const organizations = await repo.listOrganizations();
		const query = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v === true ? '1' : v)}`).join('&');
		data.rows = data.rows.map((t) => ({ ...t, created_label: fmtDate(t.created_at) }));
		res.render('admin/service/index.njk', { ...data, totalPages: Math.max(1, Math.ceil(data.total / data.limit)), filters, organizations, query, TYPE_PL, STATUS_PL, types: rules.TYPES, statuses: rules.STATUSES });
	} catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
	try {
		const ticket = await service.getTicket(null, req.params.id, undefined, { admin: true });
		if (!ticket) return res.status(404).render('error.njk', { message: 'Nie ma takiego zgłoszenia.' });
		ticket.created_label = fmtDate(ticket.created_at);
		ticket.order_sent_label = fmtDate(ticket.order_sent_date, false);
		ticket.delivered_label = fmtDate(ticket.delivered_at, false);
		ticket.events = ticket.events.map((e) => ({ ...e, created_label: fmtDate(e.created_at) }));
		const lastExport = [...ticket.events].reverse().find((e) => e.kind === 'export_ok' || e.kind === 'export_failed');
		res.render('admin/service/ticket.njk', { ticket, lastExport, msg: req.query.msg || '', TYPE_PL, STATUS_PL, EVENT_PL, statuses: rules.STATUSES, pkgPreview: JSON.stringify(await service.buildPackage(ticket.id, undefined).catch(() => null), null, 2) });
	} catch (err) { next(err); }
});

router.post('/:id/resend', async (req, res, next) => {
	try {
		await service.resendToHkl(req.params.id);
		log(`[service] admin ${req.session.user.ident || req.session.user.pin}: ponowny eksport zgłoszenia ${req.params.id}`);
		res.redirect(`/admin/service/${encodeURIComponent(req.params.id)}?msg=resent`);
	} catch (err) { next(err); }
});

router.post('/:id/status', async (req, res, next) => {
	try {
		const actor = `admin:${req.session.user.ident || req.session.user.pin || '?'}`;
		const r = await service.changeStatus(req.params.id, { status: req.body.status, message: req.body.message, actor });
		res.redirect(`/admin/service/${encodeURIComponent(req.params.id)}?msg=${r.ok ? 'status' : 'status_error'}`);
	} catch (err) { next(err); }
});

module.exports = router;
