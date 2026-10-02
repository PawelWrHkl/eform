/**
 * Kto pyta asystenta — typ konta, uprawnienia i profil klienta z sesji.
 *
 * ⚠️ Do modelu trafia wyłącznie TYP konta i flagi uprawnień, nigdy sesja
 * (ta trzyma hasło w jawnej postaci) ani dane osobowe. Nazwa i e-mail klienta
 * idą tylko do maila dla konsultanta.
 */

'use strict';

const config = require('../../config');
const ownerService = require('../owner');
const { canGroupShopSendOrders } = require('../groupShopSendPolicy');
const handoff = require('./handoff');

/** Czy widżet i trasy `/assistant` są dostępne dla tej sesji. */
function isAllowed(sessionUser, mode = config.assistant.mode) {
	if (!sessionUser) return false;
	if (mode === 'true') return true;
	if (mode === 'admins') return !!sessionUser.isAdmin;
	return false;
}

async function describeAccount(req, deps = {}) {
	const u = (req.session && req.session.user) || {};
	const inContext = !!req.session.context_user;
	if (u.isAdmin) return { type: 'admin' };
	if (u.isEmployee) {
		const p = req.session.employeePermissions || {};
		return {
			type: 'employee',
			permissions: {
				canSendOrders: !!p.can_send_orders,
				canSeePrices: !!p.can_see_prices,
				canSeeAllOrders: !!p.can_see_all_orders
			}
		};
	}
	if (u.isGroupShop) {
		const canSend = deps.canGroupShopSendOrders || canGroupShopSendOrders;
		let allowed = false;
		try {
			allowed = !!(await canSend(u));
		} catch (_) {
			allowed = false;
		}
		return { type: 'group_shop', canSend: allowed };
	}
	if (u.isGroup) return { type: 'group' };
	if (u.isOwner) return { type: inContext ? 'owner_as_client' : 'owner' };
	return { type: 'client' };
}

/** Stały klucz osoby zalogowanej (limit pytań, dziennik). Bez pinu/hasła. */
function userKey(req) {
	const u = (req.session && req.session.user) || {};
	const emp = req.session.employee;
	return [
		u.organization || 'org?',
		u.ident || (u.userId != null ? `u${u.userId}` : 'user?'),
		emp && emp.login ? `emp:${emp.login}` : null,
		u.groupShopId ? `shop:${u.groupShopId}` : null
	].filter(Boolean).join(':');
}

/**
 * Profil bieżącego klienta (z kontekstem ownera) — cache w sesji per pin, bo
 * zmienia się rzadko, a pytamy przy każdym pytaniu.
 */
async function getProfile(req, deps = {}) {
	const current = ownerService.getCurrentUser(req);
	const pin = current && current.pin;
	if (!pin) return null;
	const cached = req.session.assistantProfile;
	if (cached && cached.pin === pin) return cached.data;
	const load = deps.loadClientProfile || handoff.loadClientProfile;
	let data = null;
	try {
		data = await load(pin);
	} catch (_) {
		data = null;
	}
	if (data) req.session.assistantProfile = { pin, data };
	return data;
}

/** Kto faktycznie pisze, gdy to nie sam klient (do maila). */
function writerDetails(req) {
	const emp = req.session.employee;
	const u = req.session.user || {};
	return {
		employee: emp ? [emp.name, emp.surname].filter(Boolean).join(' ') + (emp.login ? ` (login ${emp.login})` : '') : null,
		shopName: u.isGroupShop ? (u.shopName || u.ident || null) : null
	};
}

module.exports = { isAllowed, describeAccount, userKey, getProfile, writerDetails };
