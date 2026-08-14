/**
 * Dostęp do modułu „Klienci organizacji".
 *
 * Wpuszcza:
 *   - ownera i admina (konto organizacji),
 *   - pracownika z `employee.can_manage_customers = 1`.
 *
 * ⚠️ Uprawnienie pracownika czytamy Z BAZY przy każdym żądaniu, a nie z
 * `req.session.employeePermissions`. Sesja jest wypełniana w
 * `middleware/employeePermissions.js` i `services/authService.js`, które znają
 * tylko trzy stare flagi — nowa nie byłaby tam obecna, a `undefined === true`
 * to `false`, czyli ciche 403 dla uprawnionego pracownika. Dzięki odczytowi
 * z bazy moduł jest samowystarczalny i nie wymaga zmian w tamtych plikach
 * (nadanie/odebranie uprawnienia działa też natychmiast, bez przelogowania).
 *
 * ⚠️ Odpowiedź zależy od typu żądania: XHR/fetch dostaje JSON (frontend
 * pokazuje toast), zwykłe wejście w URL — stronę 403, a nie surowy JSON.
 */

'use strict';

const { selectQuery } = require('../db/core');
const { organizationIdFromSession } = require('../services/invoices/http/session');
const { log } = require('../utils/logging');

/**
 * @param {number} employeeId
 * @returns {Promise<boolean>}
 */
async function employeeCanManageCustomers(employeeId) {
	const rows = await selectQuery('SELECT can_manage_customers FROM employee WHERE id = ? LIMIT 1', [employeeId]);
	return !!(rows && rows[0] && Number(rows[0].can_manage_customers) === 1);
}

function wantsJson(req) {
	return req.xhr
		|| req.get('X-Requested-With') === 'XMLHttpRequest'
		|| (req.get('Accept') || '').includes('application/json');
}

function deny(req, res, messageKey) {
	if (wantsJson(req)) {
		return res.status(403).json({ success: false, error: messageKey });
	}
	return res.status(403).render('error.njk', {
		message: messageKey,
		title: 'customers.errors.forbidden'
	});
}

/**
 * @type {import('express').RequestHandler}
 */
async function orgCustomerAccess(req, res, next) {
	try {
		const user = req.session && req.session.user;
		if (!user) return res.redirect('/user/login');

		const organizationId = organizationIdFromSession(req);
		if (!organizationId) return deny(req, res, 'customers.errors.no_organization_context');

		if (user.isOwner || user.isAdmin) {
			req.orgCustomerContext = { organizationId, actorUserId: Number(user.userId) || null };
			return next();
		}

		const employeeId = req.session.employee && req.session.employee.id;
		if (user.isEmployee && employeeId && (await employeeCanManageCustomers(employeeId))) {
			req.orgCustomerContext = { organizationId, actorUserId: Number(user.userId) || null };
			return next();
		}

		return deny(req, res, 'customers.errors.forbidden');
	} catch (err) {
		log('orgCustomerAccess error:', err.message);
		return deny(req, res, 'customers.errors.forbidden');
	}
}

module.exports = { orgCustomerAccess, employeeCanManageCustomers };
