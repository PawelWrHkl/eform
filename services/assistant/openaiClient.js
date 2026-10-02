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

/**
 * @param {object} body treść żądania Responses API
 * @param {{apiKey:string, apiUrl:string, timeoutMs:number}} cfg
 * @param {{fetch?:Function}} [deps]
 * @returns {Promise<object>} surowa odpowiedź API
 */
async function createResponse(body, cfg, deps = {}) {
	const fetchImpl = deps.fetch || globalThis.fetch;
	if (!cfg.apiKey) throw new AssistantApiError('Brak OPENAI_API_KEY', { code: 'no_api_key' });

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
		throw new AssistantApiError(`OpenAI HTTP ${res.status}: ${apiMessage || 'brak treści błędu'}`, {
			status: res.status,
			code: (payload && payload.error && payload.error.code) || 'http_error'
		});
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

module.exports = { createResponse, extractOutput, AssistantApiError };
