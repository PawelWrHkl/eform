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
const tools = require('./tools');
const pages = require('./pages');
const tourModule = require('./tour');

const MAX_QUESTION_CHARS = 1000;
/** Ile ostatnich wypowiedzi idzie do modelu jako historia. */
const HISTORY_FOR_MODEL = 12;
/** Ile wypowiedzi trzymamy w sesji (transkrypt dla konsultanta). */
const MAX_STORED_MESSAGES = 40;
const MAX_ANSWER_CHARS = 2000;
/** Ile razy model może sięgnąć po narzędzia, zanim musi odpowiedzieć. */
const MAX_TOOL_ROUNDS = 3;

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
	// id — do oceny odpowiedzi (👍/👎) bez polegania na pozycji w liście.
	state.messages.push({ ...msg, id: crypto.randomBytes(6).toString('hex'), at: new Date().toISOString() });
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
	const reply = { status: data.status, answer, highlight };
	// Kroki pokazu weryfikuje ask() (zależą od konta) — tu tylko przekazujemy surowe.
	if (Array.isArray(data.tour) && data.tour.length) Object.defineProperty(reply, 'rawTour', { value: data.tour, enumerable: false });
	return reply;
}

/**
 * Podświetlenie musi dotyczyć tego, o czym mowa: model lubi dokleić dowolny
 * element z ekranu (np. „Panel pracowników" przy pytaniu o zatwierdzenia).
 * Zostaje, gdy odpowiedź wspomina etykietę elementu (rdzeń dowolnego słowa
 * etykiety ≥ 4 litery — odmiana: „Dodaj pozycję" ↔ „dodać pozycję"), gdy to
 * pierwszy krok pokazu, albo gdy element nie ma etykiety (nie da się sprawdzić).
 */
function relevantHighlight(key, answer, elements, tour) {
	if (!key) return null;
	if (tour && tour.length && tour[0].element === key) return key;
	const el = (elements || []).find((e) => e.key === key);
	if (!el || !el.label) return key;
	const norm = (t) => String(t || '').toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
	const text = norm(answer);
	const stems = norm(el.label).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(4, Math.min(6, w.length - 2))));
	return !stems.length || stems.some((st) => text.includes(st)) ? key : null;
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

	// Zakres danych konta (tools.scopeFromRequest) — bez niego Eforek nie ma narzędzi,
	// tylko bazę wiedzy (np. w testach i w scripts/assistantEval.js).
	const scope = input.scope && input.scope.userId ? input.scope : null;

	const page = input.page || {};
	const elements = uiCatalog.describeAvailable(page.elements, lang, deps, scope);
	const availableKeys = elements.map((e) => e.key);
	const toolDefs = scope ? tools.responsesTools(scope) : [];
	const pageList = pages.forScope(scope || { lang }, lang, deps);

	let result;
	let reason = null;
	const usageInfo = { in: 0, out: 0 };
	const toolLog = [];
	try {
		const getKnowledge = deps.getKnowledgeText || knowledge.getKnowledgeText;
		const getContact = deps.getContactText || knowledge.getContactText;
		const contactText = await getContact(input.orgIdent, lang);

		const conversation = [
			...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
			{
				role: 'developer',
				content: prompt.buildContextMessage({
					lang,
					account: input.account,
					orgIdent: input.orgIdent,
					page,
					elements,
					contactText,
					pages: pageList,
					tools: toolDefs.map((t) => t.name),
					tourCatalog: uiCatalog.describeForTour(scope || {}, lang, deps)
				})
			},
			{ role: 'user', content: question }
		];
		const instructions = prompt.buildInstructions(getKnowledge(lang, deps, knowledge.flagsFor(input.account, deps)));
		const call = deps.createResponse || ((b) => openaiClient.createResponse(b, cfg));
		const runTool = deps.runTool || tools.runTool;

		// Pętla narzędzi: model może kilka razy poprosić o dane (find_orders → get_order…),
		// w ostatniej rundzie narzędzia są wyłączone, więc musi odpowiedzieć.
		let out = null;
		for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
			const body = {
				model: cfg.model,
				instructions,
				input: conversation,
				text: { format: prompt.buildResponseFormat(availableKeys, tourModule.stepSchema(scope || {})), verbosity: 'low' },
				reasoning: { effort: cfg.reasoningEffort },
				max_output_tokens: 3000,
				// Rozmowy klientów nie są przechowywane po stronie OpenAI.
				store: false,
				safety_identifier: safetyId(input.userKey)
			};
			if (toolDefs.length) {
				body.tools = toolDefs;
				body.tool_choice = round < MAX_TOOL_ROUNDS ? 'auto' : 'none';
				// store:false → rozumowanie modelu wraca do nas zaszyfrowane i odsyłamy je w kolejnej rundzie.
				body.include = ['reasoning.encrypted_content'];
			}
			const payload = await call(body);
			if (payload && payload.usage) {
				usageInfo.in += Number(payload.usage.input_tokens) || 0;
				usageInfo.out += Number(payload.usage.output_tokens) || 0;
			}
			const calls = (Array.isArray(payload && payload.output) ? payload.output : []).filter((it) => it && it.type === 'function_call');
			if (calls.length && round < MAX_TOOL_ROUNDS) {
				conversation.push(...payload.output);
				for (const c of calls) {
					let args = {};
					try { args = JSON.parse(c.arguments || '{}'); } catch (_) { args = {}; }
					const res = await runTool(c.name, args, scope, deps);
					toolLog.push({ name: c.name, args, error: (res && res.error) || null });
					conversation.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(res).slice(0, 12000) });
				}
				continue;
			}
			out = openaiClient.extractOutput(payload);
			break;
		}
		if (out.refusal) reason = 'refusal';
		else if (out.status && out.status !== 'completed') reason = `incomplete:${out.reason || out.status}`;
		result = reason ? null : parseModelReply(out.text, availableKeys);
		if (!result && !reason) reason = 'bad_reply';
		if (result) {
			const steps = tourModule.sanitizeTour(result.rawTour, scope || {});
			if (steps.length) result.tour = steps;
			result.highlight = relevantHighlight(result.highlight, result.answer, elements, result.tour);
			// [[page:…]] / [[order:ID]] / [[action:copy:ID]] → odnośniki (zlecenia sprawdzane w zakresie konta).
			const resolveRefs = deps.resolveRefs || tools.resolveRefs;
			const r = await resolveRefs(result.answer, scope, lang, deps);
			result.answer = r.text || result.answer;
			if (r.refs && Object.keys(r.refs).length) result.refs = r.refs;
		}
	} catch (err) {
		reason = err && err.code ? `api:${err.code}` : 'api:error';
		(deps.log || log)('[assistant] błąd wywołania modelu:', err && err.message);
	}

	if (!result) {
		result = { status: 'handoff', answer: S.unavailable, highlight: null };
	}
	if (result.status === 'handoff') state.lastHandoffReason = reason || 'model_handoff';

	pushMessage(state, { role: 'assistant', text: result.answer, status: result.status, highlight: result.highlight, refs: result.refs || null, tour: result.tour || null });
	result.messageId = state.messages[state.messages.length - 1].id;

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
		tour: result.tour ? result.tour.map((st) => `${st.element || st.page}${st.click ? '*' : ''}`) : undefined,
		tools: toolLog.length ? toolLog : undefined,
		reason,
		usage: usageInfo.in || usageInfo.out ? usageInfo : null
	}, deps);

	return reason ? { ...result, reason } : result;
}

/**
 * Ocena odpowiedzi Eforka przez klienta (👍 'up' / 👎 'down'). Zapisuje ją przy
 * wiadomości i w dzienniku rozmów — scripts/assistantGaps.js zbiera 👎 jako luki.
 * @returns {boolean} false, gdy nie ma takiej odpowiedzi w tej rozmowie
 */
function rateMessage(state, messageId, value, meta = {}, deps = {}) {
	if (value !== 'up' && value !== 'down') return false;
	const i = state.messages.findIndex((m) => m.id === messageId && m.role === 'assistant');
	if (i < 0) return false;
	const m = state.messages[i];
	m.feedback = value;
	const question = state.messages.slice(0, i).reverse().find((x) => x.role === 'user');
	appendConversationLog({
		at: new Date().toISOString(),
		type: 'feedback',
		conversation: state.id,
		user: meta.userKey || null,
		lang: meta.lang || null,
		value,
		question: question ? question.text : null,
		answer: m.text,
		status: m.status || null
	}, deps);
	return true;
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
		refs: m.refs || null,
		tour: m.tour || null,
		voice: m.channel === 'voice',
		id: m.id || null,
		feedback: m.feedback || null
	}));
}

module.exports = {
	ask,
	getState,
	resetState,
	addNote,
	rateMessage,
	appendMessage: pushMessage,
	appendConversationLog,
	safetyId,
	publicMessages,
	parseModelReply,
	relevantHighlight,
	takeQuota,
	MAX_QUESTION_CHARS,
	_usage: usage
};
