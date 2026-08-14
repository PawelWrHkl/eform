/**
 * Eksport klienta do systemu zewnętrznego (REST/JSON).
 *
 * Kontrakt wychodzący:
 *   POST <CUSTOMER_EXPORT_URL>
 *   Authorization: Bearer <CUSTOMER_EXPORT_TOKEN>
 *   Idempotency-Key: sha256(userId + payload_hash)
 *   X-Signature: sha256=<HMAC-SHA256(body, CUSTOMER_EXPORT_HMAC_SECRET)>
 *   Content-Type: application/json; charset=utf-8
 *
 * Zasady:
 *   - retry TYLKO dla 5xx i timeoutu (1s → 4s → 16s). 4xx to błąd danych —
 *     ponawianie go w kółko nic nie zmieni, a zaśmieca log i odbiorcę,
 *   - każda próba ląduje w `customer_export_log` (również ta nieudana),
 *   - w logu jest WYŁĄCZNIE `payload_hash` — payload niesie dane osobowe
 *     i warunki handlowe,
 *   - eksport NIE jest częścią zapisu klienta: wołany po commicie, a jego
 *     porażka nie wywraca utworzenia konta (operator ponawia z panelu).
 *
 * `fetch` jest natywny (Node 18+) — zero nowych zależności.
 */

'use strict';

const crypto = require('crypto');

const config = require('../../config');
const orgCustomersDb = require('../../db/orgCustomers');
const { buildCustomerPayload, canonicalJson } = require('./mapper');
const { log } = require('../../utils/logging');

/** Odstępy między próbami (ms). Długość tablicy = liczba prób. */
const BACKOFF_MS = [0, 1000, 4000, 16000];

function sha256(text) {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Podpis treści żądania. HMAC liczony z DOKŁADNIE tych bajtów, które lecą
 * w body — dlatego string budujemy raz i wysyłamy ten sam.
 *
 * @param {string} body
 * @param {string} secret
 * @returns {string}
 */
function signBody(body, secret) {
	return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/**
 * Klucz idempotencji: ten sam klient + ta sama treść = ten sam klucz, także po
 * restarcie procesu i przy ręcznym retry z panelu. Odbiorca dzięki temu nie
 * założy drugiego rekordu, gdy odpowiedź zgubi się po drodze.
 *
 * @param {number} userId
 * @param {string} payloadHash
 * @returns {string}
 */
function idempotencyKey(userId, payloadHash) {
	return sha256(`${userId}:${payloadHash}`);
}

function sleep(ms) {
	return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * @param {object} settings `config.customerExport`
 * @returns {string[]} brakujące ustawienia
 */
function missingSettings(settings) {
	const missing = [];
	if (!settings.url) missing.push('CUSTOMER_EXPORT_URL');
	if (!settings.token) missing.push('CUSTOMER_EXPORT_TOKEN');
	if (!settings.hmacSecret) missing.push('CUSTOMER_EXPORT_HMAC_SECRET');
	return missing;
}

/**
 * Wysyła jednego klienta.
 *
 * @param {number} userId
 * @param {object} [opts]
 * @param {number} [opts.organizationId]  strażnik multi-tenancy przy odczycie klienta
 * @param {'create'|'update'|'manual'} [opts.trigger]
 * @param {object} [deps]                 wstrzyknięcia dla testów
 * @param {Function} [deps.fetch]
 * @param {object} [deps.db]              `{ getCustomer, getOrganization, insertExportLog }`
 * @param {Function} [deps.sleep]
 * @param {object} [deps.settings]        nadpisanie `config.customerExport`
 * @returns {Promise<{ ok: boolean, status: 'success'|'error'|'skipped', httpCode: number|null, attempts: number, payloadHash: string|null, reason?: string }>}
 */
async function exportCustomer(userId, opts = {}, deps = {}) {
	const settings = deps.settings || config.customerExport;
	const db = deps.db || orgCustomersDb;
	const doFetch = deps.fetch || globalThis.fetch;
	const wait = deps.sleep || sleep;
	const trigger = opts.trigger || 'create';

	if (!settings.enabled) {
		return { ok: false, status: 'skipped', httpCode: null, attempts: 0, payloadHash: null, reason: 'disabled' };
	}
	const missing = missingSettings(settings);
	if (missing.length) {
		log(`customerExport: brak konfiguracji (${missing.join(', ')}) — pomijam eksport user_id=${userId}`);
		return {
			ok: false,
			status: 'skipped',
			httpCode: null,
			attempts: 0,
			payloadHash: null,
			reason: `missing_config:${missing.join(',')}`
		};
	}

	const customer = await db.getCustomer(userId, opts.organizationId);
	if (!customer) {
		return { ok: false, status: 'error', httpCode: null, attempts: 0, payloadHash: null, reason: 'customer_not_found' };
	}
	const organization = db.getOrganization ? await db.getOrganization(customer.organization_id) : null;

	const body = canonicalJson(buildCustomerPayload(customer, organization));
	const payloadHash = sha256(body);
	const key = idempotencyKey(userId, payloadHash);
	const attemptsAllowed = Math.max(Number(settings.attempts) || BACKOFF_MS.length, 1);

	let lastResult = { ok: false, status: 'error', httpCode: null, attempts: 0, payloadHash, reason: 'not_attempted' };

	for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
		// ⚠️ Indeksowanie, nie `||`: pierwszy odstęp to 0 (próba idzie od razu),
		// a `0 || …` przerzuciłoby ją na koniec tablicy — czyli 16 s czekania
		// przed pierwszym żądaniem. Przy `attempts` większym niż tablica
		// powtarzamy ostatni odstęp.
		const delay = attempt - 1 < BACKOFF_MS.length ? BACKOFF_MS[attempt - 1] : BACKOFF_MS[BACKOFF_MS.length - 1];
		await wait(delay);

		const startedAt = Date.now();
		let httpCode = null;
		let responseBody = null;
		let error = null;

		try {
			const response = await doFetch(settings.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
					Authorization: `Bearer ${settings.token}`,
					'Idempotency-Key': key,
					'X-Signature': signBody(body, settings.hmacSecret)
				},
				body,
				signal: AbortSignal.timeout(settings.timeoutMs)
			});
			httpCode = response.status;
			responseBody = typeof response.text === 'function' ? await response.text().catch(() => null) : null;
		} catch (err) {
			// Timeout i błąd sieci wyglądają tu tak samo i tak samo się je leczy.
			error = err && err.message ? err.message : String(err);
		}

		const durationMs = Date.now() - startedAt;
		const ok = httpCode !== null && httpCode >= 200 && httpCode < 300;
		const retryable = error !== null || (httpCode !== null && httpCode >= 500);

		await db.insertExportLog({
			userId,
			attemptNo: attempt,
			trigger,
			status: ok ? 'success' : 'error',
			httpCode,
			payloadHash,
			idempotencyKey: key,
			responseBody,
			error,
			durationMs
		});

		lastResult = {
			ok,
			status: ok ? 'success' : 'error',
			httpCode,
			attempts: attempt,
			payloadHash,
			reason: ok ? undefined : error || `http_${httpCode}`
		};

		if (ok) {
			log(`customerExport: user_id=${userId} OK (próba ${attempt}/${attemptsAllowed}, ${durationMs} ms)`);
			return lastResult;
		}
		if (!retryable) {
			// 4xx: dane są złe, kolejna identyczna próba nic nie zmieni.
			log(`customerExport: user_id=${userId} odrzucony przez odbiorcę (HTTP ${httpCode}) — bez ponawiania`);
			return lastResult;
		}
		log(`customerExport: user_id=${userId} próba ${attempt}/${attemptsAllowed} nieudana (${error || `HTTP ${httpCode}`})`);
	}

	return lastResult;
}

/**
 * Eksport „po zapisie": nie blokuje odpowiedzi HTTP i nigdy nie wywraca
 * żądania, które go wywołało. Porażka zostaje w `customer_export_log`, a
 * operator ponawia z panelu (`POST /org/customers/:id/export`).
 *
 * @param {number} userId
 * @param {object} [opts]
 * @returns {void}
 */
function exportCustomerInBackground(userId, opts = {}) {
	Promise.resolve()
		.then(() => exportCustomer(userId, opts))
		.catch((err) => log(`customerExport: nieobsłużony błąd eksportu user_id=${userId}: ${err.message}`));
}

module.exports = {
	exportCustomer,
	exportCustomerInBackground,
	idempotencyKey,
	signBody,
	BACKOFF_MS
};
