/**
 * Logika modułu „Klienci organizacji".
 *
 * Orkiestracja: walidacja (`validator.js`) → unikalność → zapis do `user`,
 * `usrtblpsswd`, `delivery_address`/`contact_info`, `customer_commercial_terms`
 * → (po zapisie) eksport do systemu zewnętrznego. Kontroler HTTP
 * (`routes/orgCustomers.js`) nie zna SQL-a ani reguł.
 *
 * ⚠️ Organizacja NIGDY nie pochodzi z formularza — wołający podaje ją jako
 * argument, a bierze z sesji (`organizationIdFromSession`). Każde zapytanie
 * o istniejący rekord ma `organization_id` w WHERE, więc nawet podrobione `id`
 * w URL-u nie wyjdzie poza własną organizację.
 *
 * ⚠️ Świadomie BEZ transakcji na wielu tabelach. `db/core.js` wystawia pulę
 * i helpery bezstanowe (`selectQuery`/`insertQuery`), a jedyny wzorzec
 * transakcyjny w repo (`services/orderImport/transactionalDb.js`) trzyma własne
 * połączenie i jest zbudowany pod import zamówień. Zamiast tego kolejność
 * zapisów jest tak ułożona, że częściowa awaria zostawia stan czytelny:
 * najpierw `user` (bez niego nie ma czego wiązać), potem hasło i adresy, na
 * końcu warunki handlowe. Klient bez wiersza `customer_commercial_terms` NIE
 * pojawia się na liście modułu (INNER JOIN) — nie ma „półklientów" w UI,
 * a `POST` zwraca błąd, więc operator wie, że musi powtórzyć.
 */

'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const orgCustomersDb = require('../../db/orgCustomers');
const usersDb = require('../../db/users');
const addressDb = require('../../db/address');
const { normalizeCustomerInput, normalizeListQuery } = require('./validator');
const { log } = require('../../utils/logging');

const BCRYPT_ROUNDS = 12;
const GENERATED_PASSWORD_BYTES = 9; // 12 znaków base64url
const IDENT_MAX_TRIES = 20;
const PIN_LENGTH = 8;

class CustomerError extends Error {
	/**
	 * @param {string[]} errors klucze i18n (`customers.errors.<klucz>`)
	 * @param {number} [status]
	 */
	constructor(errors, status = 400) {
		super(Array.isArray(errors) ? errors.join(', ') : String(errors));
		this.name = 'CustomerError';
		this.errors = Array.isArray(errors) ? errors : [String(errors)];
		this.status = status;
	}
}

/** Hasło pokazywane operatorowi raz — bez znaków, które gubią się przy dyktowaniu. */
function generatePassword() {
	return crypto
		.randomBytes(GENERATED_PASSWORD_BYTES)
		.toString('base64')
		.replace(/[+/=]/g, '')
		.replace(/[Il0O]/g, 'x')
		.slice(0, 12);
}

/** PIN losowy, nie sekwencyjny — kolizję wyłapuje `findUserIdByPin`. */
function generatePin() {
	let pin = '';
	while (pin.length < PIN_LENGTH) {
		pin += String(crypto.randomInt(0, 10));
	}
	return pin;
}

/**
 * Propozycja identyfikatora z nazwy klienta: `ORG-NAZWA-XX`.
 * Wielkość liter i myślniki jak w istniejących identach z `contractors.txt`.
 *
 * @param {string} orgIdent
 * @param {string} clientName
 * @returns {string}
 */
function suggestIdent(orgIdent, clientName) {
	const base = String(clientName || '')
		// ⚠️ Ł/ł nie mają rozkładu NFD (to osobny znak, nie L + kreska), więc bez
		// tej podmiany „Żółć" dawało „ZO-C" — myślnik w środku słowa zamiast litery.
		.replace(/Ł/g, 'L')
		.replace(/ł/g, 'l')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^A-Za-z0-9]+/g, '-')
		// „Tapijtcentrum Nederland B.V." → kropka + spacja dawały `NEDERLAND--`
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '')
		.toUpperCase()
		// ⚠️ Przycięcie do 24 znaków potrafi skończyć się na myślniku
		// („TAPIJTCENTRUM-NEDERLAND-"), a złączenie z sufiksem dawało `--`.
		.slice(0, 24)
		.replace(/-+$/, '');
	const prefix = String(orgIdent || 'ORG')
		.replace(/[^A-Za-z0-9]/g, '')
		.toUpperCase()
		.slice(0, 8);
	// Sufiks tylko dla unikalności — rozpoznawalność niesie nazwa firmy.
	// Przy kolizji `reserveIdent` losuje kolejny, więc 2 bajty wystarczą.
	const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
	return [prefix, base || 'KLIENT', suffix].filter(Boolean).join('-').slice(0, 50);
}

/**
 * @param {string} orgIdent
 * @param {string} clientName
 * @returns {Promise<string>} wolny identyfikator
 */
async function reserveIdent(orgIdent, clientName) {
	for (let attempt = 0; attempt < IDENT_MAX_TRIES; attempt += 1) {
		const candidate = suggestIdent(orgIdent, clientName);
		if (!(await orgCustomersDb.findUserIdByIdent(candidate))) return candidate;
	}
	throw new CustomerError(['ident_generation_failed'], 500);
}

/**
 * @returns {Promise<string>} wolny PIN
 */
async function reservePin() {
	for (let attempt = 0; attempt < IDENT_MAX_TRIES; attempt += 1) {
		const candidate = generatePin();
		if (!(await orgCustomersDb.findUserIdByPin(candidate))) return candidate;
	}
	throw new CustomerError(['pin_generation_failed'], 500);
}

/**
 * @param {string} ident
 * @param {number|null} exceptUserId
 */
async function assertIdentFree(ident, exceptUserId = null) {
	if (!ident) return;
	if (await orgCustomersDb.findUserIdByIdent(ident, exceptUserId)) {
		throw new CustomerError(['ident_taken'], 409);
	}
}

/**
 * @param {string} pin
 * @param {number|null} exceptUserId
 */
async function assertPinFree(pin, exceptUserId = null) {
	if (!pin) return;
	if (await orgCustomersDb.findUserIdByPin(pin, exceptUserId)) {
		throw new CustomerError(['pin_taken'], 409);
	}
}

/**
 * Zakłada klienta organizacji.
 *
 * @param {object} params
 * @param {number} params.organizationId
 * @param {object} params.body               `req.body`
 * @param {number|null} [params.actorUserId] kto zakłada (audyt)
 * @returns {Promise<{ userId: number, ident: string, pin: string, generatedPassword: string|null }>}
 */
async function createCustomer({ organizationId, body, actorUserId = null }) {
	if (!organizationId) throw new CustomerError(['no_organization_context'], 403);

	const organization = await orgCustomersDb.getOrganization(organizationId);
	const { values, errors, generatePassword: shouldGenerate } = normalizeCustomerInput(body, {
		isEdit: false,
		defaultCountry: organization && organization.country ? String(organization.country).slice(0, 2) : null
	});
	if (errors.length) throw new CustomerError(errors);

	// Identyfikator powstaje Z NAZWY FIRMY (`HKL-ZOLC-SOHNE-A3F91C`) — czytelny
	// przy dyktowaniu przez telefon i od razu mówi, o kogo chodzi. Formularz go
	// nie zbiera; wartość podana wprost pochodzi wyłącznie z API/importu i wtedy
	// jest wiążąca, więc kolizja musi być błędem, a nie cichą podmianą.
	let ident = values.user.ident;
	if (ident) {
		await assertIdentFree(ident);
	} else {
		ident = await reserveIdent(organization && organization.ident, values.user.client_name);
	}

	// PIN (login klienta) też nadajemy sami — operator nie ma powodu go wymyślać,
	// a ręcznie wpisany bywał zajęty i wywracał zapis na końcu formularza.
	const pin = values.user.pin || (await reservePin());
	await assertPinFree(pin);

	const plainPassword = shouldGenerate ? generatePassword() : String(body.password);
	const hash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

	const userId = await orgCustomersDb.insertCustomerUser({
		...values.user,
		ident,
		pin,
		password: hash,
		organization_id: organizationId,
		// ⚠️ `role` zostaje NULL — tak wyglądają WSZYSCY klienci w tej bazie
		// (1932 wiersze), a kod rozpoznaje tylko 'admin' i 'group'
		// (`services/authService.js`, `services/admin/userAdminService.parseRole`).
		// Literał 'client' byłby nową, nigdzie nieczytaną wartością.
		role: null
	});
	if (!userId) throw new CustomerError(['user_insert_failed'], 500);

	// Legacy: `usrtblpsswd` to słownik haseł dla panelu „Hasła" ownera
	// (`templates/owner/pwds.njk` → `getUsersFromUsrtblpsswd`). Trzyma hasła
	// jawnie — patrz RYZYKA w PROJECT_OVERVIEW; nie zakładamy tu nowego długu,
	// tylko wpisujemy się w istniejący kontrakt, żeby nowy klient był widoczny
	// w tym panelu jak każdy inny.
	await usersDb.insertUserIntousrtble(ident, pin, plainPassword);

	if (values.delivery) {
		await addressDb.insertDeliveryAddress(
			{
				name: values.delivery.name,
				phone: values.delivery.phone_number,
				street: values.delivery.street,
				city: values.delivery.city,
				zip: values.delivery.zip,
				country: values.delivery.country
			},
			userId
		);
	}
	if (values.user.email) {
		await addressDb.insertMailAddress({ mail: values.user.email }, userId);
	}

	const saved = await orgCustomersDb.upsertCommercialTerms(userId, organizationId, values.terms, actorUserId);
	if (!saved) throw new CustomerError(['terms_insert_failed'], 500);

	log(`orgCustomers: utworzono klienta ${ident} (user_id=${userId}, org=${organizationId})`);
	return { userId, ident, pin, generatedPassword: shouldGenerate ? plainPassword : null };
}

/**
 * Aktualizuje klienta. Pola pominięte w formularzu zostają bez zmian, poza
 * warunkami handlowymi — te formularz wysyła w całości.
 *
 * @param {object} params
 * @param {number} params.organizationId
 * @param {number} params.userId
 * @param {object} params.body
 * @param {number|null} [params.actorUserId]
 * @returns {Promise<{ userId: number, passwordChanged: boolean }>}
 */
async function updateCustomer({ organizationId, userId, body, actorUserId = null }) {
	if (!organizationId) throw new CustomerError(['no_organization_context'], 403);

	const existing = await orgCustomersDb.getCustomer(userId, organizationId);
	if (!existing) throw new CustomerError(['customer_not_found'], 404);

	const { values, errors } = normalizeCustomerInput(body, { isEdit: true, defaultCountry: existing.country });
	if (errors.length) throw new CustomerError(errors);

	if (values.user.ident && values.user.ident !== existing.ident) await assertIdentFree(values.user.ident, userId);
	if (values.user.pin && values.user.pin !== existing.pin) await assertPinFree(values.user.pin, userId);

	const userRow = { ...values.user };
	let passwordChanged = false;
	if (!(body.password == null || String(body.password) === '')) {
		userRow.password = await bcrypt.hash(String(body.password), BCRYPT_ROUNDS);
		passwordChanged = true;
	}

	const updated = await orgCustomersDb.updateCustomerUser(userId, organizationId, userRow);
	if (!updated) throw new CustomerError(['user_update_failed'], 500);

	if (passwordChanged) {
		await usersDb.insertUserIntousrtble(values.user.ident || existing.ident, values.user.pin || existing.pin, String(body.password));
	}

	const saved = await orgCustomersDb.upsertCommercialTerms(userId, organizationId, values.terms, actorUserId);
	if (!saved) throw new CustomerError(['terms_update_failed'], 500);

	log(`orgCustomers: zapisano zmiany klienta user_id=${userId} (org=${organizationId})`);
	return { userId, passwordChanged };
}

/**
 * @param {number} organizationId
 * @param {object} query `req.query`
 * @returns {Promise<{ rows: object[], total: number, page: number, perPage: number, pages: number, filters: object, countries: string[], priceLists: string[] }>}
 */
async function listCustomers(organizationId, query = {}) {
	if (!organizationId) throw new CustomerError(['no_organization_context'], 403);

	const filters = normalizeListQuery(query);
	const [{ rows, total }, countries, priceLists] = await Promise.all([
		orgCustomersDb.listCustomers(organizationId, filters),
		orgCustomersDb.listCountries(organizationId),
		orgCustomersDb.listPriceListCodes(organizationId)
	]);

	return {
		rows: rows.map(decorateRow),
		total,
		page: filters.page,
		perPage: filters.perPage,
		pages: Math.max(Math.ceil(total / filters.perPage), 1),
		filters,
		countries,
		priceLists
	};
}

/** Kolumny JSON wracają z MySQL-a jako string albo obiekt — normalizujemy raz. */
function parseJsonColumn(value, fallback) {
	if (value == null || value === '') return fallback;
	if (typeof value === 'object') return value;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function decorateRow(row) {
	return {
		...row,
		active: Number(row.active) === 1,
		discount_global_pct: row.discount_global_pct == null ? null : Number(row.discount_global_pct)
	};
}

/**
 * @param {number} organizationId
 * @param {number} userId
 * @returns {Promise<object>}
 */
async function getCustomer(organizationId, userId) {
	if (!organizationId) throw new CustomerError(['no_organization_context'], 403);

	const row = await orgCustomersDb.getCustomer(userId, organizationId);
	if (!row) throw new CustomerError(['customer_not_found'], 404);

	const [ordersCount, exportLog] = await Promise.all([
		orgCustomersDb.countCustomerOrders(userId),
		orgCustomersDb.listExportLog(userId)
	]);

	return {
		...decorateRow(row),
		discount_rules: parseJsonColumn(row.discount_rules, []),
		tags: parseJsonColumn(row.tags, []),
		sub_price_enabled: Number(row.sub_price_enabled) === 1,
		rodo_consent: Number(row.rodo_consent) === 1,
		price_factor: row.price_factor == null ? 1 : Number(row.price_factor),
		ordersCount,
		exportLog
	};
}

/**
 * Miękkie wyłączenie/włączenie. Twarde usuwanie jest niedostępne — a jeśli
 * kiedyś będzie, `countCustomerOrders` jest tu po to, żeby je zablokować dla
 * klienta z historią.
 *
 * @param {object} params
 * @param {number} params.organizationId
 * @param {number} params.userId
 * @param {boolean} params.active
 * @returns {Promise<{ userId: number, active: boolean, ordersCount: number }>}
 */
async function setCustomerActive({ organizationId, userId, active }) {
	if (!organizationId) throw new CustomerError(['no_organization_context'], 403);

	const existing = await orgCustomersDb.getCustomer(userId, organizationId);
	if (!existing) throw new CustomerError(['customer_not_found'], 404);

	const ordersCount = await orgCustomersDb.countCustomerOrders(userId);
	const done = await orgCustomersDb.setCustomerActive(userId, organizationId, active);
	if (!done) throw new CustomerError(['status_update_failed'], 500);

	log(`orgCustomers: klient user_id=${userId} → ${active ? 'aktywny' : 'nieaktywny'} (org=${organizationId})`);
	return { userId, active, ordersCount };
}

module.exports = {
	CustomerError,
	createCustomer,
	updateCustomer,
	listCustomers,
	getCustomer,
	setCustomerActive,
	// Eksportowane dla testów i dla formularza (podpowiedź identyfikatora).
	suggestIdent,
	generatePassword,
	generatePin
};
