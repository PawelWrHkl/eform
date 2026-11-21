/**
 * Raporty organizacji — prefiks `/org/reports` (flaga ORG_REPORTS, server.js).
 *
 *   GET    /org/reports                 strona (owner; admin: ?org=<id>, tylko odczyt)
 *   POST   /org/reports/api/stats       dane raportu
 *   POST   /org/reports/api/configs     zapis konfiguracji (tylko owner)
 *   DELETE /org/reports/api/configs/:n  usunięcie konfiguracji (tylko owner)
 *
 * Organizacja ZAWSZE z `services/orgReports.resolveReportOrg` (sesja; admin — ?org=).
 * Logika i reguły cen: services/orgReports.js. SQL: db/admin/reports.js.
 */

'use strict';

const express = require('express');
const i18n = require('i18n');
const reportsDb = require('../db/admin/reports');
const orgReports = require('../services/orgReports');
const { hasOfferColumn } = require('../services/orderOffer');
const { log } = require('../utils/logging');

const router = express.Router();
const LANG_LOCALE = { pl: 'pl-PL', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', nl: 'nl-NL' };

function lang(req, res) {
	const l = res.locals.locale || (typeof req.getLocale === 'function' ? req.getLocale() : 'en');
	return LANG_LOCALE[l] ? l : 'en';
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

/** Dostęp + organizacja w `req.reportOrg`; inne role dostają 401/403 (admin bez ?org= — 400). */
function access(req, res, next) {
	const r = orgReports.resolveReportOrg(req.session?.user, req.query);
	if (!r.status) {
		req.reportOrg = r;
		return next();
	}
	if (req.method === 'GET' && r.status === 401) return res.redirect('/user/login');
	if (req.method === 'GET') return res.status(r.status).render('no-permission.njk');
	return res.status(r.status).json({ success: false, message: res.__('reports.no_access') });
}

function ownerOnly(req, res, next) {
	if (req.reportOrg.readOnly) return res.status(403).json({ success: false, message: res.__('reports.read_only') });
	next();
}

router.get('/', async (req, res, next) => {
	// Admin bez ?org= wybiera organizację z listy (szablon, `organizations` z addOrganizationsForAdmin).
	if (req.session?.user?.isAdmin && !req.query.org) return res.render('admin/reports.njk', { orgMode: true, orgPicker: true });
	next();
}, access, async (req, res) => {
	try {
		const { orgId, readOnly } = req.reportOrg;
		const org = await reportsDb.getOrganization(orgId);
		if (!org) return res.status(404).render('error.njk', { message: res.__('reports.no_access') });
		const clients = orgReports.withCurrency(await reportsDb.getReportClients(null, null, orgId) || []);
		const currencies = orgReports.currenciesOf(clients);
		const savedConfigs = readOnly ? [] : await reportsDb.getReportConfigs(req.session.user.userId);
		const l = lang(req, res);
		const isHkl = orgId === orgReports.HKL_ORG_ID;
		res.render('admin/reports.njk', {
			orgMode: true,
			org,
			readOnly,
			clients,
			savedConfigs,
			orgs: [],
			hasGroupClients: clients.some((c) => c.role === 'group'),
			currencies,
			reportsCfg: {
				mode: 'org',
				api: '/org/reports/api',
				orgQuery: readOnly ? `?org=${orgId}` : '',
				readOnly,
				isHkl,
				// Raport ofert tylko po migracji add_order_offer_at.sql (produkcja bez niej = jak dotąd).
				offers: await hasOfferColumn(),
				unlocked: !isHkl && !!req.session.user.showSubParams,
				numberLocale: LANG_LOCALE[l],
				t: i18n.getCatalog(req, l)?.reports || {},
			},
		});
	} catch (error) {
		log('Error loading org reports page:', error);
		res.status(500).render('error.njk', { message: res.__('reports.load_error') });
	}
});

router.post('/api/stats', access, async (req, res) => {
	try {
		const { userIds, dateFrom, dateTo, currency } = req.body || {};
		const data = await orgReports.buildOrgReport({
			orgId: req.reportOrg.orgId,
			unlocked: !!req.session.user.showSubParams,
			lang: lang(req, res),
			userIds: Array.isArray(userIds) ? userIds : null,
			dateFrom: dateFrom || null,
			dateTo: dateTo || null,
			currency,
			today: today(),
			readOnly: req.reportOrg.readOnly,
		}, { db: reportsDb, hasOfferColumn });
		res.json({ success: true, ...data });
	} catch (error) {
		log('Error fetching org report stats:', error);
		res.status(500).json({ success: false, message: res.__('reports.load_error') });
	}
});

router.post('/api/configs', access, ownerOnly, async (req, res) => {
	try {
		const { name, userIds, dateFrom, dateTo, dateToToday } = req.body || {};
		if (!name || typeof name !== 'string' || name.length > 100) {
			return res.status(400).json({ success: false, message: res.__('reports.config_name_invalid') });
		}
		// Zapisujemy tylko własnych klientów — cudze id nie trafiają nawet do konfiguracji.
		const mine = (await reportsDb.getReportClients(null, null, req.reportOrg.orgId) || []).map((c) => c.id);
		const ids = orgReports.scopeUserIds(userIds, mine, mine.length) || [];
		const configs = await reportsDb.saveReportConfig(req.session.user.userId, { name, userIds: ids, dateFrom: dateFrom || null, dateTo: dateTo || null, dateToToday: !!dateToToday });
		res.json({ success: true, configs });
	} catch (error) {
		log('Error saving org report config:', error);
		res.status(500).json({ success: false, message: res.__('reports.load_error') });
	}
});

router.delete('/api/configs/:name', access, ownerOnly, async (req, res) => {
	try {
		const configs = await reportsDb.deleteReportConfig(req.session.user.userId, decodeURIComponent(req.params.name));
		res.json({ success: true, configs });
	} catch (error) {
		log('Error deleting org report config:', error);
		res.status(500).json({ success: false, message: res.__('reports.load_error') });
	}
});

module.exports = router;
