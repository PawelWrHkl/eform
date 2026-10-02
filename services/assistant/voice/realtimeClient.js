/**
 * OpenAI Realtime — zakładanie i kończenie rozmowy głosowej (WebRTC).
 *
 * „Unified interface": przeglądarka wysyła ofertę SDP do eForm, a eForm
 * przekazuje ją do `POST /v1/realtime/calls` razem z konfiguracją sesji
 * (instrukcje, baza wiedzy, narzędzia). Dzięki temu:
 *   • klucz API nie opuszcza serwera (żadnych kluczy tymczasowych w przeglądarce),
 *   • instrukcje ustawia serwer, a nie przeglądarka,
 *   • serwer zna `call_id` (nagłówek Location) i może podpiąć sideband
 *     (sideband.js) oraz rozłączyć rozmowę (`/hangup`).
 */

'use strict';

const { AssistantApiError } = require('../openaiClient');

/** `/v1/realtime/calls/rtc_123` → `rtc_123` */
function callIdFromLocation(location) {
	const id = String(location || '').split('?')[0].split('/').filter(Boolean).pop() || '';
	return /^[\w-]{3,200}$/.test(id) ? id : null;
}

/**
 * @param {{sdp:string, session:object, safetyId?:string}} p
 * @param {{apiKey:string, callsUrl:string, timeoutMs?:number}} cfg
 * @returns {Promise<{sdp:string, callId:string}>}
 */
async function createCall(p, cfg, deps = {}) {
	const fetchImpl = deps.fetch || globalThis.fetch;
	if (!cfg.apiKey) throw new AssistantApiError('Brak OPENAI_API_KEY', { code: 'no_api_key' });

	const fd = new FormData();
	fd.set('sdp', p.sdp);
	fd.set('session', JSON.stringify(p.session));

	let res;
	try {
		res = await fetchImpl(cfg.callsUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${cfg.apiKey}`,
				...(p.safetyId ? { 'OpenAI-Safety-Identifier': p.safetyId } : {})
			},
			body: fd,
			signal: AbortSignal.timeout(cfg.timeoutMs || 15000)
		});
	} catch (err) {
		const code = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network';
		throw new AssistantApiError(`OpenAI Realtime: ${err && err.message}`, { code });
	}

	const text = await res.text().catch(() => '');
	if (!res.ok) {
		let message = text.slice(0, 300);
		let code = 'http_error';
		try {
			const j = JSON.parse(text);
			message = (j.error && j.error.message) || message;
			code = (j.error && j.error.code) || code;
		} catch (_) { /* treść nie-JSON */ }
		throw new AssistantApiError(`OpenAI Realtime HTTP ${res.status}: ${message}`, { status: res.status, code });
	}

	const callId = callIdFromLocation(res.headers.get('location'));
	if (!callId) throw new AssistantApiError('OpenAI Realtime: brak call_id w nagłówku Location', { code: 'no_call_id' });
	if (!text.trim().startsWith('v=')) throw new AssistantApiError('OpenAI Realtime: odpowiedź nie jest SDP', { code: 'bad_sdp' });
	return { sdp: text, callId };
}

/** Kończy rozmowę po stronie OpenAI. Błędy połyka — rozmowa mogła się już skończyć sama. */
async function hangup(callId, cfg, deps = {}) {
	const fetchImpl = deps.fetch || globalThis.fetch;
	if (!callId || !cfg.apiKey) return false;
	try {
		const res = await fetchImpl(`${cfg.callsUrl}/${encodeURIComponent(callId)}/hangup`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${cfg.apiKey}` },
			signal: AbortSignal.timeout(10000)
		});
		return res.ok;
	} catch (_) {
		return false;
	}
}

module.exports = { createCall, hangup, callIdFromLocation };
