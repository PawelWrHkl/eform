/**
 * Zakres zleceń KONTA — te same zasady, które stosują listy zleceń portalu:
 *   • klient / owner, admin albo biuro w kontekście klienta → zlecenia tego klienta,
 *   • pracownik bez „Wszystkie zamówienia” → tylko zlecenia, które sam utworzył (`o.employee_id`),
 *   • konto podrzędne grupy (albo grupa w kontekście sklepu) → tylko zlecenia sklepu (`o.group_user_id`).
 *
 * Jedno źródło prawdy dla asystenta (services/assistant/tools.js), modułu
 * serwisu (services/serviceTickets) i każdego kolejnego widoku „moje zlecenia”.
 * Wołać PO `loadEmployeePermissions` (świeże uprawnienia pracownika).
 */

'use strict';

const ownerService = require('./owner');
const { getActiveGroupShopId } = require('./groupContext');

/**
 * Zakres danych dla żądania.
 * @param {import('express').Request} req
 * @param {string} [lang]
 */
function scopeFromRequest(req, lang) {
	const u = (req.session && req.session.user) || {};
	const current = ownerService.getCurrentUser(req) || {};
	const perms = req.session.employeePermissions || null;
	const isEmployee = !!u.isEmployee;
	const config = require('../config');
	const features = config.features || {};
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
		isAdmin: !!u.isAdmin,
		isStaff: !!u.isStaff,
		// Pracownik bez „Wszystkie zamówienia” widzi tylko swoje — jak lista „Wysłane zlecenia”.
		employeeId: isEmployee && !(perms && perms.can_see_all_orders) ? (req.session.employee && req.session.employee.id) || -1 : null,
		groupUserId: getActiveGroupShopId(req) || null,
		// Ta sama reguła co menu portalu (także tryb INVOICES_ADMIN_ONLY)
		invoices: require('./invoices/access').canAccessInvoices(u, features),
		// Moduł „Serwis” (SERVICE_ENABLED=true|admins) — ta sama reguła co menu i router.
		service: require('./serviceTickets/access').canAccessService(u, config.service),
		cancelCtx: {
			sessionUser: u,
			sessionEmployee: req.session.employee,
			employeePermissions: perms,
			contextUser: req.session.context_user
		}
	};
}

/**
 * Warunek SQL zawężający do zakresu konta. Domyślnie na aliasie `o` (tabela `order`);
 * ten sam kształt kolumn ma `service_ticket` (alias `t`) — migawka właściciela zgłoszenia.
 */
function scopeWhere(scope, alias = 'o') {
	const clauses = [`${alias}.user_id = ?`];
	const params = [scope.userId];
	if (scope.employeeId !== null && scope.employeeId !== undefined) { clauses.push(`${alias}.employee_id = ?`); params.push(scope.employeeId); }
	if (scope.groupUserId) { clauses.push(`${alias}.group_user_id = ?`); params.push(scope.groupUserId); }
	return { sql: clauses.join(' AND '), params };
}

module.exports = { scopeFromRequest, scopeWhere };
