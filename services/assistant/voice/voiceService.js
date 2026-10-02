/**
 * Rozmowa głosowa z asystentem (OpenAI Realtime przez WebRTC).
 *
 * Przebieg jednej rozmowy (jedna strona portalu = jedna rozmowa — przejście
 * na inną stronę zrywa WebRTC, a widżet łączy się ponownie z `resume`):
 *   1. przeglądarka → `POST /assistant/voice/session` z ofertą SDP i kontekstem ekranu,
 *   2. startCall: limity → instrukcje (reguły + baza wiedzy + ekran + dotychczasowa
 *      rozmowa) → `POST /v1/realtime/calls` → sideband (bez niego NIE łączymy —
 *      bez sidebandu nie ma transkryptu dla konsultanta ani kontroli instrukcji),
 *   3. sideband zbiera transkrypt do bufora `pending` (per rozmowa czatu),
 *      który trafia do sesji przy najbliższym żądaniu (`flushInto`) — sesji
 *      nie ruszamy spoza żądania, bo express-session nadpisałby zmiany,
 *   4. koniec: przycisk, zamknięcie strony (sendBeacon), limit czasu, próba
 *      podmiany instrukcji albo zerwanie połączenia → endCall.
 *
 * ⚠️ Zasady „tylko portal" i „nie wiem → konsultant" pilnuje tu instrukcja
 * modelu głosowego (wybór właściciela: Realtime zamiast twardego schematu
 * czatu). Ryzyko szczątkowe: przeglądarka trzyma kanał danych i może wysłać
 * `response.create` z własnym poleceniem — tego sideband nie widzi. Koszt
 * takiego nadużycia ograniczają limity minut (config.assistant.voice).
 */

'use strict';

const config = require('../../../config');
const { log } = require('../../../utils/logging');
const assistantService = require('../assistantService');
const knowledge = require('../knowledge');
const prompt = require('../prompt');
const uiCatalog = require('../uiCatalog');
const realtimeClient = require('./realtimeClient');
const { connectSideband } = require('./sideband');

const HISTORY_FOR_VOICE = 12;
/** Ponowne połączenie po przejściu na inną stronę „kontynuuje" tylko świeżą rozmowę. */
const RESUME_WINDOW_MS = 2 * 60 * 1000;
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const calls = new Map(); // callId → rozmowa
const pending = new Map(); // id rozmowy czatu → { seq, items: Map(itemId → wpis), handoff, touchedAt }
const usage = new Map(); // userKey → { day, seconds }

function today(now = Date.now()) {
	return new Date(now).toISOString().slice(0, 10);
}

function usedSeconds(userKey, now = Date.now()) {
	const u = usage.get(userKey);
	return u && u.day === today(now) ? u.seconds : 0;
}

function addUsage(userKey, seconds, now = Date.now()) {
	const used = usedSeconds(userKey, now);
	usage.set(userKey, { day: today(now), seconds: used + Math.max(0, seconds) });
}

/** Narzędzia sesji głosowej. Enum `key` = elementy widoczne na ekranie w chwili połączenia. */
function buildTools(availableKeys) {
	const tools = [{
		type: 'function',
		name: 'show_consultant_form',
		description: 'Otwiera w oknie czatu formularz przekazania rozmowy konsultantowi (użytkownik sam go wysyła).',
		parameters: {
			type: 'object',
			properties: { reason: { type: 'string', description: 'Krótko: dlaczego potrzebny jest konsultant.' } },
			required: ['reason'],
			additionalProperties: false
		}
	}];
	if (availableKeys.length) {
		tools.unshift({
			type: 'function',
			name: 'highlight_element',
			description: 'Podświetla na ekranie użytkownika element, który ma teraz kliknąć.',
			parameters: {
				type: 'object',
				properties: { key: { type: 'string', enum: availableKeys } },
				required: ['key'],
				additionalProperties: false
			}
		});
	}
	return tools;
}

function buildSessionConfig(instructions, availableKeys, cfg) {
	return {
		type: 'realtime',
		model: cfg.model,
		instructions,
		output_modalities: ['audio'],
		audio: {
			input: {
				transcription: { model: cfg.transcribeModel },
				turn_detection: { type: 'semantic_vad' }
			},
			output: { voice: cfg.voice }
		},
		tools: buildTools(availableKeys),
		tool_choice: 'auto'
	};
}

// ── bufor transkryptu ──────────────────────────────────────────────────────
function pendingFor(conversationId) {
	let p = pending.get(conversationId);
	if (!p) {
		p = { seq: 0, items: new Map(), handoff: false, touchedAt: Date.now() };
		pending.set(conversationId, p);
	}
	p.touchedAt = Date.now();
	return p;
}

function entry(p, itemId) {
	let e = p.items.get(itemId);
	if (!e) {
		e = { order: p.seq++, role: null, text: null, at: new Date().toISOString() };
		p.items.set(itemId, e);
	}
	return e;
}

/**
 * Przenosi gotowe wypowiedzi głosowe do stanu rozmowy w sesji. Wołane
 * WYŁĄCZNIE w obsłudze żądania (route), gdy `state` należy do tej sesji.
 */
function flushInto(state) {
	const p = state && pending.get(state.id);
	if (!p) return 0;
	const ready = [...p.items.entries()]
		.filter(([, e]) => e.role && e.text)
		.sort((a, b) => a[1].order - b[1].order);
	for (const [id, e] of ready) {
		assistantService.appendMessage(state, { role: e.role, text: e.text, status: e.role === 'assistant' ? 'answered' : undefined, channel: 'voice' });
		p.items.delete(id);
	}
	if (p.handoff) {
		state.lastHandoffReason = 'model_handoff';
		p.handoff = false;
	}
	if (!p.items.size) pending.delete(state.id);
	return ready.length;
}

function prunePending(now = Date.now()) {
	for (const [id, p] of pending) if (now - p.touchedAt > PENDING_TTL_MS) pending.delete(id);
}

// ── zdarzenia z sidebandu ──────────────────────────────────────────────────
function handleEvent(call, ev, deps = {}) {
	const p = pendingFor(call.conversationId);
	const logEntry = deps.logEntry || assistantService.appendConversationLog;
	switch (ev.type) {
		case 'session.updated': {
			// Serwer nie wysyła session.update — każda zmiana instrukcji przyszła z przeglądarki.
			const s = ev.session || {};
			if (typeof s.instructions === 'string' && s.instructions.trim() !== call.instructions.trim()) {
				(deps.log || log)(`[assistant/voice] ⚠️ podmiana instrukcji w rozmowie ${call.callId} (${call.userKey}) — rozłączam`);
				endCall(call.callId, 'tampered', deps);
			}
			break;
		}
		case 'conversation.item.added':
		case 'conversation.item.created': {
			const item = ev.item || {};
			if (item.id && item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
				entry(p, item.id).role = item.role;
			}
			break;
		}
		case 'conversation.item.input_audio_transcription.completed': {
			const text = String(ev.transcript || '').trim();
			if (!ev.item_id || !text) break;
			const e = entry(p, ev.item_id);
			e.role = 'user';
			e.text = text.slice(0, 2000);
			logEntry({ at: new Date().toISOString(), type: 'voice_turn', conversation: call.conversationId, call: call.callId, user: call.userKey, role: 'user', text: e.text }, deps);
			break;
		}
		case 'response.output_audio_transcript.done': {
			const text = String(ev.transcript || '').trim();
			if (!ev.item_id || !text) break;
			const e = entry(p, ev.item_id);
			e.role = 'assistant';
			e.text = text.slice(0, 2000);
			logEntry({ at: new Date().toISOString(), type: 'voice_turn', conversation: call.conversationId, call: call.callId, user: call.userKey, role: 'assistant', text: e.text }, deps);
			call.lastAssistantAt = Date.now();
			break;
		}
		case 'response.function_call_arguments.done': {
			if (ev.name === 'show_consultant_form') {
				p.handoff = true;
				call.handoffSuggested = true;
			}
			call.toolCalls.push(ev.name);
			break;
		}
		case 'response.done': {
			const u = ev.response && ev.response.usage;
			if (u) {
				call.tokens.input += Number(u.input_tokens) || 0;
				call.tokens.output += Number(u.output_tokens) || 0;
			}
			break;
		}
		case 'error': {
			(deps.log || log)(`[assistant/voice] błąd w rozmowie ${call.callId}:`, ev.error && ev.error.message);
			break;
		}
		default:
	}
}

// ── start / koniec ─────────────────────────────────────────────────────────
class VoiceError extends Error {
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

/**
 * @param {object} p
 * @param {object} p.session     req.session
 * @param {string} p.userKey
 * @param {string} p.lang
 * @param {object} p.account
 * @param {string} [p.orgIdent]
 * @param {object} p.page        oczyszczony kontekst ekranu (sanitizePage)
 * @param {string} p.sdp         oferta SDP przeglądarki
 * @param {boolean} [p.resume]   ponowne połączenie po przejściu na inną stronę
 * @returns {Promise<{sdp:string, callId:string, maxSeconds:number}>}
 */
async function startCall(p, deps = {}) {
	const base = deps.config || config.assistant;
	const cfg = { ...base.voice, apiKey: base.apiKey };
	const now = deps.now ? deps.now() : Date.now();
	if (!cfg.enabled || !cfg.apiKey) throw new VoiceError('voice_unavailable');
	if (typeof p.sdp !== 'string' || !p.sdp.startsWith('v=') || p.sdp.length > 20000) throw new VoiceError('bad_sdp');

	const remaining = cfg.maxMinutesPerDay * 60 - usedSeconds(p.userKey, now);
	if (remaining < 15) throw new VoiceError('voice_limit');

	// Jedna rozmowa na osobę: poprzednia (np. ze strony, z której klient przeszedł) kończy się.
	for (const c of calls.values()) if (c.userKey === p.userKey) endCall(c.callId, 'replaced', deps);
	prunePending(now);

	const state = assistantService.getState(p.session);
	flushInto(state);
	const history = state.messages.slice(-HISTORY_FOR_VOICE).map((m) => ({ role: m.role, text: m.text }));
	const elements = uiCatalog.describeAvailable(p.page && p.page.elements, p.lang, deps);
	const getKnowledge = deps.getKnowledgeText || knowledge.getKnowledgeText;
	const getContact = deps.getContactText || knowledge.getContactText;
	const instructions = prompt.buildVoiceInstructions(getKnowledge(p.lang, deps, knowledge.flagsFor(p.account, deps)), {
		lang: p.lang,
		account: p.account,
		orgIdent: p.orgIdent,
		page: p.page,
		elements,
		contactText: await getContact(p.orgIdent, p.lang)
	}, history);
	const session = buildSessionConfig(instructions, elements.map((e) => e.key), cfg);

	const create = deps.createCall || ((args) => realtimeClient.createCall(args, cfg));
	const { sdp, callId } = await create({ sdp: p.sdp, session, safetyId: assistantService.safetyId(p.userKey) });

	const maxSeconds = Math.max(15, Math.min(cfg.maxSessionMinutes * 60, remaining));
	const call = {
		callId,
		userKey: p.userKey,
		conversationId: state.id,
		instructions,
		startedAt: now,
		lastAssistantAt: null,
		toolCalls: [],
		tokens: { input: 0, output: 0 },
		handoffSuggested: false,
		cfg,
		ended: false,
		sideband: null,
		timer: null
	};
	calls.set(callId, call);

	const connect = deps.connectSideband || connectSideband;
	call.sideband = connect({
		url: `${cfg.sidebandUrl}?call_id=${encodeURIComponent(callId)}`,
		apiKey: cfg.apiKey,
		onEvent: (ev) => handleEvent(call, ev, deps),
		onClose: () => endCall(callId, 'closed', deps)
	});
	try {
		await call.sideband.ready;
	} catch (err) {
		(deps.log || log)(`[assistant/voice] sideband nie wstał dla ${callId}: ${err && err.message} — rozłączam`);
		endCall(callId, 'sideband_failed', deps);
		throw new VoiceError('voice_unavailable', 'sideband');
	}

	call.timer = setTimeout(() => endCall(callId, 'time_limit', deps), maxSeconds * 1000);
	if (call.timer.unref) call.timer.unref();

	// Po przejściu na inną stronę asystent sam mówi następny krok — ale tylko
	// w świeżej rozmowie. Polecenie jako wiadomość systemowa: `response.create`
	// z własnymi `instructions` zastąpiłby instrukcje sesji (a z nimi bazę wiedzy).
	const lastVoiceAt = (() => {
		const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
		return last ? Date.parse(last.at) : NaN;
	})();
	if (p.resume && now - lastVoiceAt < RESUME_WINDOW_MS) {
		call.sideband.send({
			type: 'conversation.item.create',
			item: {
				type: 'message',
				role: 'system',
				content: [{ type: 'input_text', text: 'Użytkownik przeszedł właśnie na ekran opisany w KONTEKŚCIE. Jeśli prowadzisz go przez kilka kroków, powiedz jednym zdaniem następny krok na tym ekranie. W przeciwnym razie zapytaj jednym krótkim zdaniem, w czym jeszcze pomóc.' }]
			}
		});
		call.sideband.send({ type: 'response.create' });
	}

	(deps.log || log)(`[assistant/voice] start ${callId} (${p.userKey}, ${p.lang}, ${(p.page && p.page.path) || '-'}, limit ${maxSeconds}s${p.resume ? ', wznowienie' : ''})`);
	return { sdp, callId, maxSeconds };
}

function endCall(callId, reason, deps = {}) {
	const call = calls.get(callId);
	if (!call || call.ended) return false;
	call.ended = true;
	calls.delete(callId);
	if (call.timer) clearTimeout(call.timer);
	if (call.sideband) call.sideband.close();
	const hang = deps.hangup || ((id) => realtimeClient.hangup(id, call.cfg));
	if (reason !== 'closed') Promise.resolve(hang(callId)).catch(() => {});

	const now = deps.now ? deps.now() : Date.now();
	const seconds = Math.round((now - call.startedAt) / 1000);
	addUsage(call.userKey, seconds, now);
	const logEntry = deps.logEntry || assistantService.appendConversationLog;
	logEntry({
		at: new Date(now).toISOString(),
		type: 'voice_call',
		conversation: call.conversationId,
		call: callId,
		user: call.userKey,
		seconds,
		reason,
		tools: call.toolCalls,
		handoffSuggested: call.handoffSuggested,
		usage: call.tokens
	}, deps);
	(deps.log || log)(`[assistant/voice] koniec ${callId} (${reason}, ${seconds}s)`);
	return true;
}

/** Koniec na żądanie przeglądarki — tylko własnej rozmowy. */
function endCallFor(userKey, callId, deps = {}) {
	const call = calls.get(callId);
	if (!call || call.userKey !== userKey) return false;
	return endCall(callId, 'client', deps);
}

module.exports = {
	startCall,
	endCall,
	endCallFor,
	flushInto,
	handleEvent,
	buildSessionConfig,
	buildTools,
	usedSeconds,
	VoiceError,
	_calls: calls,
	_pending: pending,
	_usage: usage
};
