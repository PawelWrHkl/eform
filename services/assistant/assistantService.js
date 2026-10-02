/**
 * Asystent eForm — logika jednej rundy pytanie → odpowiedź.
 *
 * Stan rozmowy trzymamy w SESJI (`req.session.assistant`), nie w przeglądarce:
 *   • transkrypt w mailu do konsultanta jest wtedy wiarygodny (klient nie
 *     dopisze „odpowiedzi asystenta", których ten nie udzielił),
 *   • rozmowa przeżywa przejście na inną stronę portalu (widżet po
 *     przeładowaniu pobiera ją z `GET /assistant/state`).
 *
 * Każda awaria (brak klucza, timeout, błąd API, odpowiedź niezgodna ze
 * schematem, odmowa modelu) kończy się statusem `handoff` — klient zawsze
 * dostaje drogę do człowieka, nigdy pustego okna.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../../config');
const { log } = require('../../utils/logging');
const openaiClient = require('./openaiClient');
const prompt = require('./prompt');
const knowledge = require('./knowledge');
const labels = require('./labels');
const uiCatalog = require('./uiCatalog');
const strings = require('./strings');

const MAX_QUESTION_CHARS = 1000;
/** Ile ostatnich wypowiedzi idzie do modelu jako historia. */
const HISTORY_FOR_MODEL = 12;
/** Ile wypowiedzi trzymamy w sesji (transkrypt dla konsultanta). */
const MAX_STORED_MESSAGES = 40;
const MAX_ANSWER_CHARS = 2000;

function emptyState() {
	return { id: crypto.randomUUID(), startedAt: new Date().toISOString(), messages: [], handoff: null, lastHandoffReason: null };
}

/** Stan z sesji — tworzy go przy pierwszym użyciu. */
function getState(session) {
	if (!session.assistant || !Array.isArray(session.assistant.messages)) session.assistant = emptyState();
	return session.assistant;
}

function resetState(session) {
	session.assistant = emptyState();
	return session.assistant;
}

function pushMessage(state, msg) {
	state.messages.push({ ...msg, at: new Date().toISOString() });
	if (state.messages.length > MAX_STORED_MESSAGES) state.messages.splice(0, state.messages.length - MAX_STORED_MESSAGES);
}

// ── limit pytań (koszt + nadużycia) ────────────────────────────────────────
const usage = new Map(); // userKey → [timestamps]
const HOUR_MS = 60 * 60 * 1000;

function takeQuota(userKey, limit, now = Date.now()) {
	const list = (usage.get(userKey) || []).filter((t) => now - t < HOUR_MS);
	if (list.length >= limit) {
		usage.set(userKey, list);
		return false;
	}
	list.push(now);
	usage.set(userKey, list);
	return true;
}

// ── dziennik rozmów (do przeglądu luk w bazie wiedzy) ──────────────────────
function appendConversationLog(entry, deps = {}) {
	if (deps.logEntry) return deps.logEntry(entry);
	try {
		const day = new Date().toISOString().slice(0, 10);
		const dir = path.join(config.logsDir, 'assistant');
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFile(path.join(dir, `assistant-${day}.jsonl`), JSON.stringify(entry) + '\n', () => {});
	} catch (err) {
		log('[assistant] nie udało się zapisać dziennika rozmowy:', err.message);
	}
}

/** Odpowiedź modelu → bezpieczny obiekt dla przeglądarki albo null, gdy niezgodna. */
function parseModelReply(text, availableKeys) {
	if (!text) return null;
	let data;
	try {
		data = JSON.parse(text);
	} catch (_) {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	if (!prompt.STATUSES.includes(data.status)) return null;
	const answer = typeof data.answer === 'string' ? data.answer.trim().slice(0, MAX_ANSWER_CHARS) : '';
	if (!answer) return null;
	const highlight = typeof data.highlight === 'string' && availableKeys.includes(data.highlight) ? data.highlight : null;
	return { status: data.status, answer, highlight };
}

/** Skrót identyfikatora klienta dla OpenAI (wykrywanie nadużyć bez danych osobowych). */
function safetyId(userKey) {
	return crypto.createHash('sha256').update(`eform-assistant:${userKey}`).digest('hex').slice(0, 32);
}

/**
 * @param {object} session  req.session
 * @param {object} input
 * @param {string} input.question
 * @param {string} input.lang
 * @param {object} input.account   { type, permissions?, canSend? }
 * @param {string} [input.orgIdent]
 * @param {string} input.userKey   stały identyfikator użytkownika (limit, safety id)
 * @param {object} [input.page]    { path, title, heading, notices[], elements[] }
 * @param {object} [deps]          wstrzyknięcia do testów
 * @returns {Promise<{status:string, answer:string, highlight:string|null, reason?:string, httpStatus?:number}>}
 */
async function ask(session, input, deps = {}) {
	const cfg = deps.config || config.assistant;
	const lang = labels.normalizeLang(input.lang);
	const S = strings.forLang(lang);
	const question = String(input.question || '').trim();

	if (!question) return { status: 'error', answer: S.emptyQuestion, highlight: null, httpStatus: 400 };
	if (question.length > MAX_QUESTION_CHARS) return { status: 'error', answer: S.tooLong, highlight: null, httpStatus: 400 };

	const quota = deps.takeQuota || takeQuota;
	if (!quota(input.userKey, cfg.maxQuestionsPerHour)) {
		return { status: 'handoff', answer: S.rateLimited, highlight: null, reason: 'rate_limited' };
	}

	const state = getState(session);
	const history = state.messages.slice(-HISTORY_FOR_MODEL);
	pushMessage(state, { role: 'user', text: question });

	const page = input.page || {};
	const elements = uiCatalog.describeAvailable(page.elements, lang, deps);
	const availableKeys = elements.map((e) => e.key);

	let result;
	let reason = null;
	let usageInfo = null;
	try {
		const getKnowledge = deps.getKnowledgeText || knowledge.getKnowledgeText;
		const getContact = deps.getContactText || knowledge.getContactText;
		const contactText = await getContact(input.orgIdent, lang);

		const body = {
			model: cfg.model,
			instructions: prompt.buildInstructions(getKnowledge(lang, deps, knowledge.flagsFor(input.account, deps))),
			input: [
				...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
				{
					role: 'developer',
					content: prompt.buildContextMessage({
						lang,
						account: input.account,
						orgIdent: input.orgIdent,
						page,
						elements,
						contactText
					})
				},
				{ role: 'user', content: question }
			],
			text: { format: prompt.buildResponseFormat(availableKeys), verbosity: 'low' },
			reasoning: { effort: cfg.reasoningEffort },
			max_output_tokens: 3000,
			// Rozmowy klientów nie są przechowywane po stronie OpenAI.
			store: false,
			safety_identifier: safetyId(input.userKey)
		};

		const call = deps.createResponse || ((b) => openaiClient.createResponse(b, cfg));
		const payload = await call(body);
		usageInfo = payload && payload.usage ? { in: payload.usage.input_tokens, out: payload.usage.output_tokens } : null;
		const out = openaiClient.extractOutput(payload);
		if (out.refusal) reason = 'refusal';
		else if (out.status && out.status !== 'completed') reason = `incomplete:${out.reason || out.status}`;
		result = reason ? null : parseModelReply(out.text, availableKeys);
		if (!result && !reason) reason = 'bad_reply';
	} catch (err) {
		reason = err && err.code ? `api:${err.code}` : 'api:error';
		(deps.log || log)('[assistant] błąd wywołania modelu:', err && err.message);
	}

	if (!result) {
		result = { status: 'handoff', answer: S.unavailable, highlight: null };
	}
	if (result.status === 'handoff') state.lastHandoffReason = reason || 'model_handoff';

	pushMessage(state, { role: 'assistant', text: result.answer, status: result.status, highlight: result.highlight });

	appendConversationLog({
		at: new Date().toISOString(),
		conversation: state.id,
		user: input.userKey,
		org: input.orgIdent || null,
		account: input.account && input.account.type,
		lang,
		path: page.path || null,
		question,
		status: result.status,
		answer: result.answer,
		highlight: result.highlight,
		reason,
		usage: usageInfo
	}, deps);

	return reason ? { ...result, reason } : result;
}

/** Komunikat systemowy w transkrypcie (np. potwierdzenie przekazania) — bez wywołania modelu. */
function addNote(state, text, status) {
	pushMessage(state, { role: 'assistant', text, status });
}

/** Wypowiedzi do odtworzenia w widżecie (bez znaczników czasu i pól wewnętrznych). */
function publicMessages(state) {
	return state.messages.map((m) => ({
		role: m.role,
		text: m.text,
		status: m.status || null,
		highlight: m.highlight || null,
		voice: m.channel === 'voice'
	}));
}

module.exports = {
	ask,
	getState,
	resetState,
	addNote,
	appendMessage: pushMessage,
	appendConversationLog,
	safetyId,
	publicMessages,
	parseModelReply,
	takeQuota,
	MAX_QUESTION_CHARS,
	_usage: usage
};
