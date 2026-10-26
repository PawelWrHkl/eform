/**
 * Eforek czyta na głos — synteza mowy OpenAI (`POST /v1/audio/speech`).
 *
 * Przebieg (routes/assistant.js):
 *   1. POST /assistant/speak { text, lang } → `prepare()` zapisuje tekst pod
 *      losowym id (na 10 min) i zwraca adres nagrania,
 *   2. <audio src="/assistant/speak/:id"> → `stream()` — nagranie płynie do
 *      przeglądarki kawałkami, więc Eforek zaczyna mówić, zanim przyjdzie całość.
 * Gotowe nagrania leżą w pamięci (te same teksty — np. kroki pokazu — nie
 * kosztują drugi raz). Dzienny limit znaków na osobę pilnuje kosztów.
 *
 * Głos niezależny od dostawcy czatu (ASSISTANT_PROVIDER) — zawsze OpenAI,
 * jak rozmowa głosowa; klucz OPENAI_API_KEY z .env.local.
 */

'use strict';

const crypto = require('crypto');
const config = require('../../config');
const { normalizeLang } = require('./labels');

const MAX_TEXT = 700;          // jedna wypowiedź (odpowiedź czatu, krok pokazu)
const PREPARED_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;         // gotowych nagrań w pamięci (ok. 50–150 kB każde)

const LANGUAGE = { pl: 'polsku', en: 'angielsku', de: 'niemiecku', fr: 'francusku', nl: 'niderlandzku' };

const prepared = new Map(); // id → { key, text, lang, at }
const cache = new Map();    // key → Buffer (kolejność = wiek; najstarszy wylatuje)
const spent = new Map();    // userKey|dzień → znaki

class TtsError extends Error {
	constructor(code, status) {
		super(code);
		this.code = code;
		this.status = status || 400;
	}
}

/** Tekst do mówienia: bez znaczników [[…]], emoji i podwójnych spacji. */
function clean(text) {
	return String(text || '')
		.replace(/\[\[[^\]]*\]\]/g, ' ')
		.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_TEXT);
}

function cacheKey(text, lang, cfg) {
	return crypto.createHash('sha1').update(`${cfg.model}|${cfg.voice}|${lang}|${text}`).digest('hex');
}

function prune(now) {
	for (const [id, p] of prepared) if (now - p.at > PREPARED_TTL_MS) prepared.delete(id);
	while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Zapamiętuje tekst do przeczytania; zwraca { id } albo rzuca TtsError
 * (tts_disabled, empty, limit).
 */
function prepare(rawText, lang, userKey, deps = {}) {
	const cfg = deps.config || config.assistant.tts;
	if (!cfg.enabled || !(deps.apiKey || config.assistant.apiKey)) throw new TtsError('tts_disabled', 404);
	const text = clean(rawText);
	if (!text) throw new TtsError('empty');
	const l = normalizeLang(lang);
	const now = deps.now ? deps.now() : Date.now();
	prune(now);
	const key = cacheKey(text, l, cfg);
	// Limit liczymy tylko za nowe nagrania (z pamięci — za darmo).
	if (!cache.has(key)) {
		const dayKey = `${userKey}|${new Date(now).toISOString().slice(0, 10)}`;
		const used = spent.get(dayKey) || 0;
		if (used + text.length > cfg.maxCharsPerDay) throw new TtsError('limit', 429);
		spent.set(dayKey, used + text.length);
	}
	const id = crypto.randomBytes(9).toString('base64url');
	prepared.set(id, { key, text, lang: l, at: now });
	return { id };
}

/**
 * Wysyła nagranie do odpowiedzi HTTP: z pamięci albo strumieniem z OpenAI
 * (równocześnie zbierając je do pamięci).
 */
async function stream(id, res, deps = {}) {
	const cfg = deps.config || config.assistant.tts;
	const p = prepared.get(String(id || ''));
	if (!p) throw new TtsError('not_found', 404);
	res.setHeader('Content-Type', 'audio/mpeg');
	res.setHeader('Cache-Control', 'private, max-age=600');
	const hit = cache.get(p.key);
	if (hit) {
		res.setHeader('Content-Length', hit.length);
		return res.end(hit);
	}
	const fetchImpl = deps.fetch || globalThis.fetch;
	const upstream = await fetchImpl(cfg.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.apiKey || config.assistant.apiKey}` },
		body: JSON.stringify({
			model: cfg.model,
			voice: cfg.voice,
			input: p.text,
			response_format: 'mp3',
			instructions: `Jesteś Eforek, pogodny i życzliwy asystent portalu eForm. Mów po ${LANGUAGE[p.lang] || 'polsku'}, ciepło i naturalnie, w umiarkowanym tempie.`
		}),
		signal: AbortSignal.timeout(cfg.timeoutMs)
	});
	if (!upstream.ok || !upstream.body) {
		const detail = await upstream.text().catch(() => '');
		throw new TtsError(`upstream_${upstream.status}: ${detail.slice(0, 160)}`, 502);
	}
	const chunks = [];
	const reader = upstream.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const buf = Buffer.from(value);
		chunks.push(buf);
		res.write(buf);
	}
	res.end();
	cache.set(p.key, Buffer.concat(chunks));
	prune(Date.now());
}

module.exports = { prepare, stream, clean, TtsError, _state: { prepared, cache, spent } };
