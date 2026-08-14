/**
 * Warstwa SQL modułu „Klienci organizacji" (`/org/customers`).
 *
 * Cienka warstwa: bez logiki biznesowej, bez walidacji — te siedzą w
 * `services/orgCustomers/`. Każde zapytanie parametryzowane; wyłącznie helpery
 * z `db/core.js` (pula połączeń), nigdy własne `connetToDb`.
 *
 * ⚠️ Kontrakty helperów z `core.js`, na które łatwo się nadziać:
 *   - `selectQuery` zwraca `false` przy zero wierszy (nie pustą tablicę) i
 *     `false` przy błędzie SQL — brak wyniku i awaria są nieodróżnialne,
 *   - `insertQuery` zwraca CAŁĄ odpowiedź `mysql2` (`[ResultSetHeader, fields]`),
 *     więc `insertId` jest pod `response[0].insertId`. Istniejące `db/users.js`
 *     robi tu `result.insertId` (→ `undefined`) — nie kopiujemy tego.
 *
 * Multi-tenancy: KAŻDE zapytanie o dane klienta ma `organization_id` w WHERE.
 * Wyjątkiem jest tylko `findUserIdByIdent`, który sprawdza globalną unikalność
 * identyfikatora (a ta z definicji jest ponad organizacjami).
 */

'use strict';

const { selectQuery, insertQuery, updateQuery } = require('./core');

/** Kolumny `user`, które moduł zapisuje — biała lista, nie budujemy SQL-a z wejścia. */
const USER_COLUMNS = [
	'ident',
	'pin',
	'password',
	'client_name',
	'tax_id',
	'street',
	'city',
	'zip',
	'country',
	'phone',
	'email',
	'organization_id',
	'role',
	'ab_lang'
];

/** Kolumny `customer_commercial_terms`, które moduł zapisuje. */
const TERMS_COLUMNS = [
	'price_list_code',
	'price_list_version',
	'discount_global_pct',
	'discount_rules',
	'surcharge_version',
	'sub_price_enabled',
	'price_factor',
	'currency',
	'vat_rate',
	'payment_terms_days',
	'credit_limit',
	'locale',
	'preferred_channel',
	'rodo_consent',
	'rodo_consent_at',
	'terms_version',
	'notes',
	'tags',
	'active'
];

/** Kolumny, po których wolno sortować listę (biała lista — trafiają do ORDER BY). */
const SORTABLE = {
	ident: 'u.ident',
	client_name: 'u.client_name',
	city: 'u.city',
	country: 'u.country',
	price_list: 't.price_list_code',
	created_at: 't.created_at',
	active: 't.active'
};

function pickColumns(data, allowed) {
	const columns = [];
	const values = [];
	for (const column of allowed) {
		if (Object.prototype.hasOwnProperty.call(data, column)) {
			columns.push(column);
			values.push(data[column]);
		}
	}
	return { columns, values };
}

/**
 * Czy identyfikator jest już zajęty (globalnie — `user.ident` służy do logowania
 * i mapowania na systemy zewnętrzne).
 *
 * @param {string} ident
 * @param {number|null} [exceptUserId] pomiń ten wiersz (edycja własnego rekordu)
 * @returns {Promise<number|null>} id kolidującego użytkownika albo null
 */
async function findUserIdByIdent(ident, exceptUserId = null) {
	const rows = exceptUserId
		? await selectQuery('SELECT id FROM `user` WHERE ident = ? AND id <> ? LIMIT 1', [ident, exceptUserId])
		: await selectQuery('SELECT id FROM `user` WHERE ident = ? LIMIT 1', [ident]);
	return rows && rows[0] ? rows[0].id : null;
}

/**
 * @param {string} pin
 * @param {number|null} [exceptUserId]
 * @returns {Promise<number|null>} id kolidującego użytkownika albo null
 */
async function findUserIdByPin(pin, exceptUserId = null) {
	const rows = exceptUserId
		? await selectQuery('SELECT id FROM `user` WHERE pin = ? AND id <> ? LIMIT 1', [pin, exceptUserId])
		: await selectQuery('SELECT id FROM `user` WHERE pin = ? LIMIT 1', [pin]);
	return rows && rows[0] ? rows[0].id : null;
}

/**
 * Wstawia wiersz `user`. Kolumny z białej listy, wartości parametryzowane.
 *
 * @param {object} userRow
 * @returns {Promise<number|null>} nowe `user.id`
 */
async function insertCustomerUser(userRow) {
	const { columns, values } = pickColumns(userRow, USER_COLUMNS);
	if (!columns.length) return null;

	const query = `INSERT INTO \`user\` (${columns.map((c) => `\`${c}\``).join(', ')})
		VALUES (${columns.map(() => '?').join(', ')})`;
	const response = await insertQuery(query, values);
	return response && response[0] ? response[0].insertId : null;
}

/**
 * @param {number} userId
 * @param {number} organizationId strażnik multi-tenancy w WHERE
 * @param {object} userRow
 * @returns {Promise<boolean>}
 */
async function updateCustomerUser(userId, organizationId, userRow) {
	const { columns, values } = pickColumns(userRow, USER_COLUMNS);
	if (!columns.length) return false;

	const query = `UPDATE \`user\` SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')}
		WHERE id = ? AND organization_id = ?`;
	const result = await updateQuery(query, [...values, userId, organizationId]);
	return !!result;
}

/**
 * Wstawia albo aktualizuje warunki handlowe (1:1 z `user`).
 *
 * @param {number} userId
 * @param {number} organizationId
 * @param {object} terms
 * @param {number|null} [createdByUserId]
 * @returns {Promise<boolean>}
 */
async function upsertCommercialTerms(userId, organizationId, terms, createdByUserId = null) {
	const { columns, values } = pickColumns(terms, TERMS_COLUMNS);
	const allColumns = ['user_id', 'organization_id', 'created_by_user_id', ...columns];
	const allValues = [userId, organizationId, createdByUserId, ...values];
	const updates = columns.map((c) => `\`${c}\` = VALUES(\`${c}\`)`);
	// `user_id`/`organization_id` nigdy się nie zmieniają — nie ma ich w UPDATE.
	if (!updates.length) updates.push('`updated_at` = CURRENT_TIMESTAMP');

	const query = `INSERT INTO customer_commercial_terms
			(${allColumns.map((c) => `\`${c}\``).join(', ')})
		VALUES (${allColumns.map(() => '?').join(', ')})
		ON DUPLICATE KEY UPDATE ${updates.join(', ')}`;
	const response = await insertQuery(query, allValues);
	return !!response;
}

/**
 * Jeden klient z warunkami handlowymi — zawsze w obrębie organizacji.
 *
 * @param {number} userId
 * @param {number} organizationId
 * @returns {Promise<object|null>}
 */
async function getCustomer(userId, organizationId) {
	const query = `SELECT
			u.id, u.ident, u.pin, u.client_name, u.tax_id, u.street, u.city, u.zip,
			u.country, u.phone, u.email, u.organization_id, u.role, u.ab_lang,
			t.id AS terms_id, t.price_list_code, t.price_list_version, t.discount_global_pct,
			t.discount_rules, t.surcharge_version, t.sub_price_enabled, t.price_factor,
			t.currency, t.vat_rate, t.payment_terms_days, t.credit_limit, t.locale,
			t.preferred_channel, t.rodo_consent, t.rodo_consent_at, t.terms_version,
			t.notes, t.tags, t.active, t.deactivated_at, t.created_at, t.updated_at,
			da.street AS delivery_street, da.zip AS delivery_zip, da.city AS delivery_city,
			da.country AS delivery_country, da.phone_number AS delivery_phone, da.name AS delivery_name
		FROM \`user\` u
		LEFT JOIN customer_commercial_terms t ON t.user_id = u.id
		LEFT JOIN delivery_address da ON da.user_id = u.id
		WHERE u.id = ? AND u.organization_id = ?
		LIMIT 1`;
	const rows = await selectQuery(query, [userId, organizationId]);
	return rows && rows[0] ? rows[0] : null;
}

/**
 * Lista klientów organizacji z filtrami, sortowaniem i paginacją.
 *
 * ⚠️ LEFT JOIN, nie INNER. Klienci organizacji to po prostu wiersze `user`
 * z jej `organization_id` — jest ich w bazie 1935 (m.in. z `contractors.txt`
 * przez `services/dbUserSync.js`) i to NIMI ten panel ma zarządzać.
 * `customer_commercial_terms` trzyma wyłącznie warunki handlowe, których
 * `user` nie ma gdzie zapisać, i powstaje przy pierwszym zapisie klienta —
 * przy INNER JOIN panel świeciłby pustką, mimo że klienci istnieją.
 * `terms_id` mówi widokowi, czy warunki są już uzupełnione.
 *
 * @param {number} organizationId
 * @param {object} [opts]
 * @param {string} [opts.search]     fragment ident / client_name / email
 * @param {string} [opts.country]
 * @param {string} [opts.priceList]
 * @param {'all'|'active'|'inactive'} [opts.status]
 * @param {string} [opts.sort]       klucz z `SORTABLE`
 * @param {'asc'|'desc'} [opts.dir]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function listCustomers(organizationId, opts = {}) {
	const where = ['u.organization_id = ?'];
	const params = [organizationId];

	if (opts.search) {
		where.push('(u.ident LIKE ? OR u.client_name LIKE ? OR u.email LIKE ?)');
		const like = `%${opts.search}%`;
		params.push(like, like, like);
	}
	if (opts.country) {
		where.push('u.country = ?');
		params.push(opts.country);
	}
	if (opts.priceList) {
		where.push('t.price_list_code = ?');
		params.push(opts.priceList);
	}
	// Brak wiersza warunków = konto aktywne: dziś każdy klient z `user` działa,
	// a `active` dopisujemy dopiero przy pierwszym zapisie w tym panelu.
	if (opts.status === 'active') where.push('COALESCE(t.active, 1) = 1');
	if (opts.status === 'inactive') where.push('COALESCE(t.active, 1) = 0');
	if (opts.terms === 'with') where.push('t.id IS NOT NULL');
	if (opts.terms === 'without') where.push('t.id IS NULL');

	const orderColumn = SORTABLE[opts.sort] || SORTABLE.ident;
	const orderDir = String(opts.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
	const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 25, 1), 200);
	const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);

	const rows = await selectQuery(
		`SELECT
				u.id, u.ident, u.client_name, u.city, u.country, u.email, u.phone,
				t.id AS terms_id, t.price_list_code, t.price_list_version, t.discount_global_pct,
				t.currency, COALESCE(t.active, 1) AS active, t.created_at,
				(SELECT status FROM customer_export_log l
					WHERE l.user_id = u.id ORDER BY l.id DESC LIMIT 1) AS last_export_status,
				-- Cennik jest PER GRUPA (patrz services/orgCustomers/groupTerms.js),
				-- więc jedna kolumna „cennik" nie ma sensu — pokazujemy, ile grup
				-- klient ma skonfigurowanych nakładką.
				(SELECT COUNT(*) FROM customer_group_terms g WHERE g.user_id = u.id) AS groups_configured
			FROM \`user\` u
			LEFT JOIN customer_commercial_terms t ON t.user_id = u.id
			WHERE ${where.join(' AND ')}
			ORDER BY ${orderColumn} ${orderDir}
			LIMIT ? OFFSET ?`,
		[...params, limit, offset]
	);

	const counted = await selectQuery(
		`SELECT COUNT(*) AS total
			FROM \`user\` u
			LEFT JOIN customer_commercial_terms t ON t.user_id = u.id
			WHERE ${where.join(' AND ')}`,
		params
	);

	return {
		rows: rows || [],
		total: counted && counted[0] ? Number(counted[0].total) : 0
	};
}

/**
 * Kody cenników już użyte w organizacji — do podpowiedzi w formularzu i filtra.
 * (Tabeli `price_list` w bazie nie ma; kod jest wartością tekstową.)
 *
 * @param {number} organizationId
 * @returns {Promise<string[]>}
 */
async function listPriceListCodes(organizationId) {
	const rows = await selectQuery(
		`SELECT DISTINCT price_list_code FROM customer_commercial_terms
			WHERE organization_id = ? AND price_list_code IS NOT NULL AND price_list_code <> ''
			ORDER BY price_list_code`,
		[organizationId]
	);
	return rows ? rows.map((r) => r.price_list_code) : [];
}

/**
 * Kraje występujące u klientów organizacji — do filtra listy.
 *
 * @param {number} organizationId
 * @returns {Promise<string[]>}
 */
async function listCountries(organizationId) {
	const rows = await selectQuery(
		`SELECT DISTINCT u.country FROM \`user\` u
			WHERE u.organization_id = ? AND u.country IS NOT NULL AND u.country <> ''
			ORDER BY u.country`,
		[organizationId]
	);
	return rows ? rows.map((r) => r.country) : [];
}

/**
 * Miękkie wyłączenie klienta. Twardego usuwania moduł nie ma — konto jest
 * powiązane z zamówieniami i logami.
 *
 * @param {number} userId
 * @param {number} organizationId
 * @param {boolean} active
 * @returns {Promise<boolean>}
 */
async function setCustomerActive(userId, organizationId, active) {
	// ⚠️ UPSERT, nie UPDATE. Większość klientów nie ma jeszcze wiersza warunków
	// handlowych (powstaje przy pierwszym zapisie w tym panelu), a `UPDATE`
	// trafiłby wtedy w zero wierszy i po cichu nic by nie zrobił — operator
	// widziałby „dezaktywowano", a konto dalej byłoby aktywne.
	const response = await insertQuery(
		`INSERT INTO customer_commercial_terms (user_id, organization_id, active, deactivated_at)
			VALUES (?, ?, ?, ${active ? 'NULL' : 'CURRENT_TIMESTAMP'})
			ON DUPLICATE KEY UPDATE active = VALUES(active), deactivated_at = VALUES(deactivated_at)`,
		[userId, organizationId, active ? 1 : 0]
	);
	return !!response;
}

/**
 * Liczba zamówień klienta — blokada twardego usuwania i informacja w UI.
 *
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function countCustomerOrders(userId) {
	const rows = await selectQuery('SELECT COUNT(*) AS n FROM `order` WHERE user_id = ?', [userId]);
	return rows && rows[0] ? Number(rows[0].n) : 0;
}

/**
 * Wpis do audytu eksportu. Nigdy nie zapisujemy payloadu — tylko jego hash.
 *
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
async function insertExportLog(entry) {
	const response = await insertQuery(
		`INSERT INTO customer_export_log
			(user_id, attempt_no, trigger_source, status, http_code, payload_hash,
			 idempotency_key, response_body, error, duration_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			entry.userId,
			entry.attemptNo || 1,
			entry.trigger || 'create',
			entry.status,
			entry.httpCode == null ? null : entry.httpCode,
			entry.payloadHash,
			entry.idempotencyKey || null,
			entry.responseBody == null ? null : String(entry.responseBody).slice(0, 4000),
			entry.error == null ? null : String(entry.error).slice(0, 2000),
			entry.durationMs == null ? null : entry.durationMs
		]
	);
	return !!response;
}

/**
 * Historia eksportu klienta (najnowsze pierwsze).
 *
 * @param {number} userId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function listExportLog(userId, limit = 20) {
	const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
	const rows = await selectQuery(
		`SELECT id, attempt_no, trigger_source, status, http_code, payload_hash,
				idempotency_key, error, duration_ms, created_at
			FROM customer_export_log WHERE user_id = ?
			ORDER BY id DESC LIMIT ?`,
		[userId, safeLimit]
	);
	return rows || [];
}

/**
 * Dane organizacji — źródło domyślnych wartości formularza (kraj) i nadawcy
 * w payloadzie eksportu.
 *
 * @param {number} organizationId
 * @returns {Promise<object|null>}
 */
async function getOrganization(organizationId) {
	const rows = await selectQuery(
		'SELECT id, ident, name, country, tax_id, email FROM organization WHERE id = ? LIMIT 1',
		[organizationId]
	);
	return rows && rows[0] ? rows[0] : null;
}

/* ─────────────── warunki per grupa asortymentowa (nakładka na prod.txt) ─────────────── */

/** Kolumny JSON z MySQL-a bywają stringiem albo obiektem — normalizujemy raz. */
function parseJson(value, fallback) {
	if (value == null || value === '') return fallback;
	if (typeof value === 'object') return value;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

/**
 * Nakładka warunków dla jednej grupy. `null` = brak wpisu, czyli obowiązuje
 * wyłącznie `prod.txt` (tak działają wszystkie stare konta).
 *
 * @param {number} userId
 * @param {string|number} groupNumber
 * @returns {Promise<{scripts: object, collections: object, has_access: number}|null>}
 */
async function getGroupTerms(userId, groupNumber) {
	const rows = await selectQuery(
		`SELECT scripts, collections, has_access, price_variant, discount_variant, notes, updated_at
			FROM customer_group_terms WHERE user_id = ? AND group_number = ? LIMIT 1`,
		[userId, String(groupNumber)]
	);
	if (!rows || !rows[0]) return null;
	return {
		...rows[0],
		scripts: parseJson(rows[0].scripts, {}),
		collections: parseJson(rows[0].collections, {})
	};
}

/**
 * Wszystkie nakładki klienta — jedno zapytanie zamiast pytania per grupa.
 *
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
async function listGroupTerms(userId) {
	const rows = await selectQuery(
		`SELECT group_number, scripts, collections, has_access, price_variant, discount_variant, notes, updated_at
			FROM customer_group_terms WHERE user_id = ? ORDER BY CAST(group_number AS UNSIGNED)`,
		[userId]
	);
	return (rows || []).map((row) => ({
		...row,
		scripts: parseJson(row.scripts, {}),
		collections: parseJson(row.collections, {})
	}));
}

/**
 * Nakładki wszystkich klientów organizacji dla jednej grupy — używane przy
 * podgrzewaniu cache\'u przed uruchomieniem silnika.
 *
 * @param {number} organizationId
 * @param {string|number} groupNumber
 * @returns {Promise<object[]>}
 */
async function listGroupTermsForOrganization(organizationId, groupNumber) {
	const rows = await selectQuery(
		`SELECT t.user_id, u.ident, t.scripts, t.collections, t.has_access
			FROM customer_group_terms t
			JOIN \`user\` u ON u.id = t.user_id
			WHERE t.organization_id = ? AND t.group_number = ?`,
		[organizationId, String(groupNumber)]
	);
	return (rows || []).map((row) => ({
		...row,
		scripts: parseJson(row.scripts, {}),
		collections: parseJson(row.collections, {})
	}));
}

/**
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
async function upsertGroupTerms(entry) {
	const response = await insertQuery(
		`INSERT INTO customer_group_terms
			(user_id, organization_id, group_number, scripts, collections, has_access,
			 price_variant, discount_variant, notes, created_by_user_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			scripts = VALUES(scripts), collections = VALUES(collections),
			has_access = VALUES(has_access), price_variant = VALUES(price_variant),
			discount_variant = VALUES(discount_variant), notes = VALUES(notes)`,
		[
			entry.userId,
			entry.organizationId,
			String(entry.groupNumber),
			entry.scripts ? JSON.stringify(entry.scripts) : null,
			entry.collections ? JSON.stringify(entry.collections) : null,
			entry.hasAccess === false ? 0 : 1,
			entry.priceVariant || null,
			entry.discountVariant || null,
			entry.notes || null,
			entry.createdByUserId || null
		]
	);
	return !!response;
}

/**
 * @param {number} userId
 * @param {string|number} groupNumber
 * @returns {Promise<boolean>}
 */
async function deleteGroupTerms(userId, groupNumber) {
	const result = await updateQuery(
		'DELETE FROM customer_group_terms WHERE user_id = ? AND group_number = ?',
		[userId, String(groupNumber)]
	);
	return !!result;
}

module.exports = {
	findUserIdByIdent,
	findUserIdByPin,
	insertCustomerUser,
	updateCustomerUser,
	upsertCommercialTerms,
	getCustomer,
	listCustomers,
	listPriceListCodes,
	listCountries,
	setCustomerActive,
	countCustomerOrders,
	insertExportLog,
	listExportLog,
	getOrganization,
	getGroupTerms,
	listGroupTerms,
	listGroupTermsForOrganization,
	upsertGroupTerms,
	deleteGroupTerms,
	// Eksport dla testów/serwisu — biała lista kolumn sortowania.
	SORTABLE
};
