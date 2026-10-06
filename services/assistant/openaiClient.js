/**
 * Klient OpenAI Responses API (`POST /v1/responses`) dla asystenta eForm.
 *
 * Natywny `fetch` (Node 18+), bez SDK — ten sam wybór co
 * services/customerExport: jedna zależność mniej do wdrażania, a potrzebujemy
 * dokładnie jednego wywołania.
 *
 * ⚠️ Klucz API żyje tylko tutaj, po stronie serwera. Przeglądarka rozmawia
 * wyłącznie z `/assistant/*` w eForm.
 */

'use strict';

class AssistantApiError extends Error {
	constructor(message, { status = null, code = null } = {}) {
		super(message);
		this.name = 'AssistantApiError';
		this.status = status;
		this.code = code;
	}
}

// Ponawianie po chwilowych błędach: limit tokenów/zapytań na minutę (429 — wspólny dla
// całej organizacji OpenAI, więc przy wielu klientach naraz zdarza się w szczycie)
// i przeciążenie po stronie OpenAI (500/502/503). Brak środków na koncie
// (insufficient_quota) też ma kod 429, ale ponawianie nic nie da.
const RETRY_STATUSES = new Set([429, 500, 502, 503]);
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 5000;

/** Ile czekać przed ponowieniem: nagłówki retry-after(-ms), „try again in 1.3s/62ms" z treści, inaczej rosnąco. */
function retryDelay(res, message, attempt) {
	const h = (name) => (res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
	let ms = Number(h('retry-after-ms'));
	if (!(ms > 0)) ms = Number(h('retry-after')) * 1000;
	if (!(ms > 0)) {
		const m = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message || '');
		if (m) ms = Number(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1);
	}
	if (!(ms > 0)) ms = 500 * 2 ** (attempt - 1);
	// Odrobina losowości, żeby kilka czekających rozmów nie wróciło w tej samej milisekundzie.
	return Math.min(MAX_WAIT_MS, Math.ceil(ms) + 150 + Math.floor(Math.random() * 250));
}

/**
 * @param {object} body treść żądania Responses API
 * @param {{apiKey:string, apiUrl:string, timeoutMs:number}} cfg
 * @param {{fetch?:Function, sleep?:Function}} [deps]
 * @returns {Promise<object>} surowa odpowiedź API
 */
async function createResponse(body, cfg, deps = {}) {
	if (!cfg.apiKey) throw new AssistantApiError('Brak OPENAI_API_KEY', { code: 'no_api_key' });
	const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
	for (let attempt = 1; ; attempt++) {
		try {
			return await requestOnce(body, cfg, deps);
		} catch (err) {
			const retryable = err instanceof AssistantApiError && RETRY_STATUSES.has(err.status) && err.code !== 'insufficient_quota';
			if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
			await sleep(retryDelay(err.response, err.message, attempt));
		}
	}
}

async function requestOnce(body, cfg, deps) {
	const fetchImpl = deps.fetch || globalThis.fetch;

	let res;
	try {
		res = await fetchImpl(cfg.apiUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${cfg.apiKey}`
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(cfg.timeoutMs)
		});
	} catch (err) {
		const code = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network';
		throw new AssistantApiError(`OpenAI: ${err && err.message}`, { code });
	}

	let payload = null;
	try {
		payload = await res.json();
	} catch (_) {
		payload = null;
	}

	if (!res.ok) {
		const apiMessage = payload && payload.error && payload.error.message;
		const err = new AssistantApiError(`OpenAI HTTP ${res.status}: ${apiMessage || 'brak treści błędu'}`, {
			status: res.status,
			code: (payload && payload.error && payload.error.code) || 'http_error'
		});
		Object.defineProperty(err, 'response', { value: res, enumerable: false });
		throw err;
	}
	if (!payload) throw new AssistantApiError('OpenAI: odpowiedź nie jest JSON-em', { code: 'bad_payload' });
	return payload;
}

/**
 * Wyciąga tekst modelu z surowej odpowiedzi (`output[].content[]`).
 * Odmowa modelu (`type: refusal`) i odpowiedź przerwana (`status: incomplete`)
 * nie są tekstem odpowiedzi — wywołujący traktuje je jak „nie wiem".
 *
 * @returns {{text:string|null, refusal:string|null, status:string|null, reason:string|null}}
 */
function extractOutput(payload) {
	const out = { text: null, refusal: null, status: payload && payload.status || null, reason: null };
	if (payload && payload.incomplete_details) out.reason = payload.incomplete_details.reason || null;

	const items = Array.isArray(payload && payload.output) ? payload.output : [];
	const parts = [];
	for (const item of items) {
		if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
		for (const c of item.content) {
			if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
			if (c && c.type === 'refusal') out.refusal = c.refusal || 'refusal';
		}
	}
	if (parts.length) out.text = parts.join('');
	return out;
}

module.exports = { createResponse, extractOutput, AssistantApiError, _retryDelay: retryDelay };
