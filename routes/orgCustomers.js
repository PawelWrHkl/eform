/**
 * Kontroler HTTP modułu „Klienci organizacji" — prefiks `/org/customers`.
 *
 * Router robi trzy rzeczy i nic więcej: czyta żądanie, woła
 * `services/orgCustomers`, oddaje widok albo JSON. Reguły biznesowe, walidacja
 * i SQL są warstwę niżej.
 *
 * Trasy:
 *   GET    /org/customers               lista (HTML; z `Accept: application/json` → JSON)
 *   GET    /org/customers/new           pusty formularz
 *   GET    /org/customers/:id           formularz edycji
 *   POST   /org/customers               utworzenie klienta
 *   POST   /org/customers/:id           zapis zmian
 *   POST   /org/customers/:id/status    aktywacja / dezaktywacja (soft delete)
 *   POST   /org/customers/:id/export    ręczne ponowienie eksportu
 *
 * ⚠️ Formularz działa BEZ JavaScriptu: `POST` z `application/x-www-form-urlencoded`
 * kończy się przekierowaniem (PRG), a z `Accept: application/json` — odpowiedzią
 * JSON dla `public/scripts/orgCustomers/form.js`. Jedna trasa, dwa wyjścia.
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const { requireLogin } = require('../middleware/loginMixture');
const { orgCustomerAccess } = require('../middleware/orgCustomerAccess');
const service = require('../services/orgCustomers');
const groupTerms = require('../services/orgCustomers/groupTerms');
const { PATTERNS } = require('../services/orgCustomers/validator');
const { exportCustomer, exportCustomerInBackground } = require('../services/customerExport');
const orgCustomersDb = require('../db/orgCustomers');
const config = require('../config');
const { log } = require('../utils/logging');

const router = express.Router();

// ⚠️ Etykiety NIE idą przez globalne `__()`: aplikacja czyta tłumaczenia
// z `/mnt/eform/languages` (mount synchronizowany spoza repo), więc klucze
// dodane w `locales/` nie dotarłyby do działającej instancji. Ten sam wybór
// i z tego samego powodu zrobił moduł faktur — patrz `services/invoices/http/panel.js`.
const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'orgCustomers', 'i18n', 'labels.json'), 'utf8'));

function labelsFor(req) {
	const lang = (typeof req.getLocale === 'function' ? req.getLocale() : 'pl') || 'pl';
	return { lang, L: LABELS[lang] || LABELS.pl };
}

function wantsJson(req) {
	return req.xhr
		|| req.get('X-Requested-With') === 'XMLHttpRequest'
		|| (req.get('Accept') || '').includes('application/json');
}

/** Id z URL-a nigdy nie idzie dalej bez sprawdzenia — to klucz do cudzych danych. */
function customerId(req) {
	const id = Number.parseInt(req.params.id, 10);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Jedno miejsce, w którym błąd serwisu zamienia się w odpowiedź.
 * `CustomerError` niesie klucze i18n — nie gotowe zdania — więc tłumaczenie
 * dobiera się do języka żądania.
 */
function fail(req, res, err, L) {
	const isKnown = err && err.name === 'CustomerError';
	const status = isKnown ? err.status : 500;
	const keys = isKnown ? err.errors : ['unexpected'];
	const messages = keys.map((key) => (L.errors && L.errors[key]) || key);

	if (!isKnown) log('orgCustomers route error:', err && err.message);

	if (wantsJson(req)) {
		return res.status(status).json({ success: false, errors: keys, messages });
	}
	return res.status(status).render('error.njk', { message: messages.join(' • '), title: L.title });
}

router.use(requireLogin, orgCustomerAccess);

router.get('/', async (req, res) => {
	const { L, lang } = labelsFor(req);
	try {
		const data = await service.listCustomers(req.orgCustomerContext.organizationId, req.query);
		if (wantsJson(req)) return res.json({ success: true, ...data });

		return res.render('org/customers/list.njk', {
			L,
			lang,
			...data,
			query: req.query,
			exportEnabled: config.customerExport.enabled
		});
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.get('/new', async (req, res) => {
	const { L, lang } = labelsFor(req);
	try {
		const organizationId = req.orgCustomerContext.organizationId;
		const [organization, priceLists] = await Promise.all([
			orgCustomersDb.getOrganization(organizationId),
			orgCustomersDb.listPriceListCodes(organizationId)
		]);

		return res.render('org/customers/form.njk', {
			L,
			lang,
			customer: null,
			priceLists,
			patterns: PATTERNS,
			defaults: {
				country: organization && organization.country ? String(organization.country).slice(0, 2).toUpperCase() : '',
				currency: 'EUR',
				locale: lang
			},
			exportEnabled: config.customerExport.enabled
		});
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.get('/:id', async (req, res) => {
	const { L, lang } = labelsFor(req);
	try {
		const id = customerId(req);
		if (!id) return fail(req, res, new service.CustomerError(['customer_not_found'], 404), L);

		const organizationId = req.orgCustomerContext.organizationId;
		const [customer, priceLists, organization] = await Promise.all([
			service.getCustomer(organizationId, id),
			orgCustomersDb.listPriceListCodes(organizationId),
			orgCustomersDb.getOrganization(organizationId)
		]);

		// Cenniki per grupa asortymentowa — to TU siedzi prawdziwy cennik/rabat
		// klienta (patrz services/orgCustomers/groupTerms.js). Dla starych kont
		// wszystko pochodzi z `prod.txt`, dla klientów eForma z nakładki w bazie.
		const orgIdent = organization ? organization.ident : null;
		const groups = orgIdent
			? await groupTerms.listClientGroupTerms({ userId: id, orgIdent, userIdent: customer.ident, lang })
			: [];
		const variants = {};
		for (const group of groups) variants[group.groupNumber] = groupTerms.listVariants(group.groupNumber);

		if (wantsJson(req)) return res.json({ success: true, customer, groups });

		return res.render('org/customers/form.njk', {
			L,
			lang,
			customer,
			priceLists,
			groups,
			variants,
			patterns: PATTERNS,
			defaults: { country: customer.country || '', currency: customer.currency || 'EUR', locale: customer.locale || lang },
			exportEnabled: config.customerExport.enabled
		});
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.post('/', async (req, res) => {
	const { L } = labelsFor(req);
	try {
		const { organizationId, actorUserId } = req.orgCustomerContext;
		const result = await service.createCustomer({ organizationId, body: req.body, actorUserId });

		// Eksport po zapisie — świadomie poza żądaniem: odpowiedź nie czeka na
		// obcy system, a jego awaria nie kasuje właśnie założonego klienta.
		if (config.customerExport.enabled) {
			exportCustomerInBackground(result.userId, { organizationId, trigger: 'create' });
		}

		if (wantsJson(req)) {
			return res.status(201).json({
				success: true,
				...result,
				message: config.customerExport.enabled ? L.saved_export_queued : L.saved
			});
		}
		// PRG: odświeżenie strony po zapisie nie może założyć drugiego klienta.
		return res.redirect(`/org/customers/${result.userId}?saved=1`);
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.post('/:id', async (req, res) => {
	const { L } = labelsFor(req);
	try {
		const id = customerId(req);
		if (!id) return fail(req, res, new service.CustomerError(['customer_not_found'], 404), L);

		const { organizationId, actorUserId } = req.orgCustomerContext;
		const result = await service.updateCustomer({ organizationId, userId: id, body: req.body, actorUserId });

		if (config.customerExport.enabled) {
			exportCustomerInBackground(id, { organizationId, trigger: 'update' });
		}

		if (wantsJson(req)) return res.json({ success: true, ...result, message: L.saved });
		return res.redirect(`/org/customers/${id}?saved=1`);
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.post('/:id/status', async (req, res) => {
	const { L } = labelsFor(req);
	try {
		const id = customerId(req);
		if (!id) return fail(req, res, new service.CustomerError(['customer_not_found'], 404), L);

		const active = String(req.body.active) === '1' || req.body.active === true;
		const result = await service.setCustomerActive({
			organizationId: req.orgCustomerContext.organizationId,
			userId: id,
			active
		});

		if (wantsJson(req)) return res.json({ success: true, ...result });
		return res.redirect('/org/customers');
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.post('/:id/export', async (req, res) => {
	const { L } = labelsFor(req);
	try {
		const id = customerId(req);
		if (!id) return fail(req, res, new service.CustomerError(['customer_not_found'], 404), L);

		const organizationId = req.orgCustomerContext.organizationId;
		// Ręczny retry czeka na wynik — operator kliknął i chce wiedzieć, czy poszło.
		const result = await exportCustomer(id, { organizationId, trigger: 'manual' });
		const message = result.ok
			? L.export_ok
			: (result.reason === 'disabled' ? L.export_disabled : L.export_failed);

		if (wantsJson(req)) return res.status(result.ok ? 200 : 502).json({ success: result.ok, ...result, message });
		return res.redirect(`/org/customers/${id}?export=${result.ok ? 'ok' : 'failed'}`);
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.post('/:id/group-terms', async (req, res) => {
	const { L, lang } = labelsFor(req);
	try {
		const id = customerId(req);
		if (!id) return fail(req, res, new service.CustomerError(['customer_not_found'], 404), L);

		const { organizationId, actorUserId } = req.orgCustomerContext;
		const customer = await service.getCustomer(organizationId, id);
		const organization = await orgCustomersDb.getOrganization(organizationId);
		const groupNumber = String(req.body.group_number || '').trim();
		if (!/^\d{1,10}$/.test(groupNumber)) {
			return fail(req, res, new service.CustomerError(['group_invalid'], 400), L);
		}

		// „Usuń warunki" = skasowanie NAKŁADKI, nie konfiguracji. Klient wraca do
		// tego, co mówi `prod.txt` (albo do braku cennika, jeśli go tam nie ma) —
		// dlatego to osobna akcja, a nie zapis pustych wariantów.
		if (String(req.body.action) === 'delete') {
			await orgCustomersDb.deleteGroupTerms(id, groupNumber);
			log(`orgCustomers: ${customer.ident} — usunięto nakładkę warunków dla grupy ${groupNumber}`);
			if (wantsJson(req)) return res.json({ success: true, deleted: groupNumber, message: L.saved });
			return res.redirect(`/org/customers/${id}?saved=1`);
		}

		const result = await groupTerms.setGroupVariant({
			userId: id,
			organizationId,
			groupNumber,
			priceVariant: String(req.body.price_variant || '').trim() || null,
			discountVariant: String(req.body.discount_variant || '').trim() || null,
			lang,
			actorUserId
		});
		if (!Object.keys(result.scripts).length) {
			return fail(req, res, new service.CustomerError(['variant_not_found'], 400), L);
		}
		log(`orgCustomers: ${customer.ident} (org ${organization && organization.ident}) grupa ${groupNumber} → cennik ${req.body.price_variant}, rabat ${req.body.discount_variant}`);

		if (wantsJson(req)) return res.json({ success: true, ...result, message: L.saved });
		return res.redirect(`/org/customers/${id}?saved=1`);
	} catch (err) {
		return fail(req, res, err, L);
	}
});

router.post('/:id/copy-terms', async (req, res) => {
	const { L, lang } = labelsFor(req);
	try {
		const id = customerId(req);
		if (!id) return fail(req, res, new service.CustomerError(['customer_not_found'], 404), L);

		const { organizationId, actorUserId } = req.orgCustomerContext;
		const organization = await orgCustomersDb.getOrganization(organizationId);
		const templateIdent = String(req.body.template_ident || '').trim();
		if (!templateIdent) return fail(req, res, new service.CustomerError(['template_required'], 400), L);

		// ⚠️ Wzorcem może być WYŁĄCZNIE klient tej samej organizacji — inaczej
		// panel byłby czytnikiem cenników konkurencji.
		const templateId = await orgCustomersDb.findUserIdByIdent(templateIdent);
		const template = templateId ? await orgCustomersDb.getCustomer(templateId, organizationId) : null;
		if (!template) return fail(req, res, new service.CustomerError(['template_not_found'], 404), L);

		const result = await groupTerms.copyTermsFromClient({
			userId: id,
			organizationId,
			orgIdent: organization ? organization.ident : null,
			templateUserIdent: template.ident,
			lang,
			actorUserId
		});

		if (wantsJson(req)) return res.json({ success: true, ...result, message: L.saved });
		return res.redirect(`/org/customers/${id}?saved=1`);
	} catch (err) {
		return fail(req, res, err, L);
	}
});

module.exports = router;
