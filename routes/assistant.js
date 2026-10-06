/**
 * Asystent eForm — API widżetu czatu (`/assistant/*`).
 *
 * Montowany w server.js tylko przy `ASSISTANT_ENABLED=true|admins`.
 * Wszystkie trasy: zalogowana sesja + `sessionContext.isAllowed` (pilotaż
 * `admins` odcina pozostałe konta także od API, nie tylko od widżetu).
 *
 *   GET  /assistant/state    — rozmowa z sesji (widżet po przejściu na inną stronę)
 *   POST /assistant/ask      — { question, page } → { status, answer, highlight }
 *   POST /assistant/handoff  — { email, phone?, note?, trigger?, page? } → mail do konsultanta
 *   POST /assistant/reset    — nowa rozmowa
 *   POST /assistant/bubble/hide — „×" na dymku maskotki: dymek znika do końca sesji
 *   POST /assistant/voice/session — { sdp, page, resume } → { sdp, callId, maxSeconds } (rozmowa głosowa)
 *   POST /assistant/voice/end     — { callId } (także sendBeacon przy zamykaniu strony)
 *   GET  /assistant/go/order/:id  — przejście do zlecenia z rozmowy (sprawdza zakres konta)
 *
 * Wypowiedzi z rozmowy głosowej zbiera sideband poza żądaniem; do sesji
 * trafiają przez `voiceService.flushInto` na początku każdej trasy czatu.
 */

'use strict';

const express = require('express');

const assistantService = require('../services/assistant/assistantService');
const handoff = require('../services/assistant/handoff');
const sessionContext = require('../services/assistant/sessionContext');
const strings = require('../services/assistant/strings');
const prompt = require('../services/assistant/prompt');
const { normalizeLang } = require('../services/assistant/labels');
const voiceService = require('../services/assistant/voice/voiceService');
const tools = require('../services/assistant/tools');
const { loadEmployeePermissions } = require('../middleware/employeePermissions');
const config = require('../config');
const { log } = require('../utils/logging');

const router = express.Router();

// JSON zamiast przekierowania na /user/login — wołają nas wyłącznie fetch-e widżetu.
router.use((req, res, next) => {
	if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'not_logged_in' });
	if (!sessionContext.isAllowed(req.session.user)) return res.status(403).json({ success: false, error: 'forbidden' });
	return next();
});

function langOf(req) {
	return normalizeLang(typeof req.getLocale === 'function' ? req.getLocale() : 'en');
}

function str(v, max) {
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Kontekst ekranu od przeglądarki — tylko znane pola, przycięte. */
function sanitizePage(raw) {
	const p = raw && typeof raw === 'object' ? raw : {};
	return {
		path: str(p.path, 200),
		title: str(p.title, 150),
		heading: str(p.heading, 150),
		notices: Array.isArray(p.notices)
			? p.notices.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3).map((s) => s.trim().slice(0, 200))
			: [],
		elements: Array.isArray(p.elements) ? p.elements.filter((k) => typeof k === 'string').slice(0, 60) : []
	};
}

router.get('/state', async (req, res) => {
	const state = assistantService.getState(req.session);
	voiceService.flushInto(state);
	const profile = await sessionContext.getProfile(req);
	res.json({
		success: true,
		messages: assistantService.publicMessages(state),
		handoffSent: !!state.handoff,
		contactEmail: (profile && profile.email) || ''
	});
});

// `loadEmployeePermissions` — świeże uprawnienia pracownika z bazy (jak listy zleceń),
// bo od nich zależy, które zlecenia widzą narzędzia Eforka.
router.post('/ask', loadEmployeePermissions, async (req, res) => {
	try {
		voiceService.flushInto(assistantService.getState(req.session));
		const profile = await sessionContext.getProfile(req);
		const result = await assistantService.ask(req.session, {
			question: req.body && req.body.question,
			lang: langOf(req),
			scope: tools.scopeFromRequest(req, langOf(req)),
			account: await sessionContext.describeAccount(req),
			orgIdent: (profile && profile.org_ident) || (typeof req.session.user.organization === 'string' ? req.session.user.organization : ''),
			userKey: sessionContext.userKey(req),
			page: sanitizePage(req.body && req.body.page)
		});
		const { httpStatus, reason, ...body } = result;
		return res.status(httpStatus || 200).json({ success: !httpStatus, ...body });
	} catch (err) {
		log('[assistant] /ask:', err && err.message);
		const S = strings.forLang(langOf(req));
		return res.json({ success: true, status: 'handoff', answer: S.unavailable, highlight: null });
	}
});

router.post('/handoff', async (req, res) => {
	const lang = langOf(req);
	const S = strings.forLang(lang);
	const body = req.body || {};
	const state = assistantService.getState(req.session);
	voiceService.flushInto(state);
	const email = str(body.email, 200);
	const note = str(body.note, 2000);

	if (!state.messages.length && !note) {
		return res.status(400).json({ success: false, message: S.noteRequired });
	}

	try {
		const profile = await sessionContext.getProfile(req);
		const account = await sessionContext.describeAccount(req);
		const result = await handoff.sendHandoff({
			state,
			profile,
			orgIdent: typeof req.session.user.organization === 'string' ? req.session.user.organization : '',
			account: { ...account, label: prompt.describeAccount(account) },
			extra: sessionContext.writerDetails(req),
			contactEmail: email,
			contactPhone: str(body.phone, 50),
			note,
			lang,
			pagePath: sanitizePage(body.page).path,
			reason: body.trigger === 'button' ? 'user_request' : (state.lastHandoffReason || 'user_request')
		});

		if (result.sent) {
			const message = S.handoffSent.replace('{email}', email);
			assistantService.addNote(state, message, 'handoff_sent');
			return res.json({ success: true, message });
		}
		if (result.error === 'invalid_email') return res.status(400).json({ success: false, message: S.invalidEmail });
		if (result.error === 'too_soon') return res.status(429).json({ success: false, message: S.handoffTooSoon });
		return res.status(502).json({ success: false, message: S.handoffFailed, contact: true });
	} catch (err) {
		log('[assistant] /handoff:', err && err.message);
		return res.status(502).json({ success: false, message: S.handoffFailed, contact: true });
	}
});

// Odnośnik do zlecenia z rozmowy (głos: narzędzie open_order) — sprawdza, że zlecenie
// należy do konta, i przekierowuje do właściwego widoku (oferta albo wysłane).
router.get('/go/order/:id', loadEmployeePermissions, async (req, res) => {
	const scope = tools.scopeFromRequest(req, langOf(req));
	const { refs } = await tools.resolveRefs(`[[order:${Number(req.params.id) || 0}]]`, scope, langOf(req));
	const ref = Object.values(refs)[0];
	return res.redirect(ref ? ref.href : '/orders/history');
});

// „×" na dymku maskotki — dymek znika do końca sesji logowania (server.js → assistantBoot.bubbleHidden).
router.post('/bubble/hide', (req, res) => {
	req.session.assistantBubbleHidden = true;
	res.json({ success: true });
});

// 👍/👎 pod odpowiedzią Eforka.
router.post('/feedback', (req, res) => {
	const body = req.body || {};
	const ok = assistantService.rateMessage(assistantService.getState(req.session), str(body.id, 40), body.value, {
		userKey: sessionContext.userKey(req),
		lang: langOf(req)
	});
	res.status(ok ? 200 : 400).json({ success: ok });
});

router.post('/reset', (req, res) => {
	assistantService.resetState(req.session);
	res.json({ success: true });
});

// ── rozmowa głosowa ────────────────────────────────────────────────────────
const VOICE_MESSAGES = {
	voice_unavailable: 'voiceUnavailable',
	voice_limit: 'voiceLimit',
	bad_sdp: 'voiceUnavailable'
};

router.post('/voice/session', loadEmployeePermissions, async (req, res) => {
	const lang = langOf(req);
	const S = strings.forLang(lang);
	if (!config.assistant.voice.enabled) return res.status(404).json({ success: false, error: 'voice_disabled', message: S.voiceUnavailable });
	const body = req.body || {};
	try {
		const profile = await sessionContext.getProfile(req);
		const result = await voiceService.startCall({
			session: req.session,
			userKey: sessionContext.userKey(req),
			lang,
			account: await sessionContext.describeAccount(req),
			orgIdent: (profile && profile.org_ident) || (typeof req.session.user.organization === 'string' ? req.session.user.organization : ''),
			page: sanitizePage(body.page),
			sdp: typeof body.sdp === 'string' ? body.sdp : '',
			resume: body.resume === true,
			scope: tools.scopeFromRequest(req, lang)
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		const code = (err && err.code) || 'voice_unavailable';
		if (!(err instanceof voiceService.VoiceError)) log('[assistant/voice] /session:', err && err.message);
		const status = code === 'voice_limit' ? 429 : code === 'bad_sdp' ? 400 : 503;
		return res.status(status).json({ success: false, error: code, message: S[VOICE_MESSAGES[code] || 'voiceUnavailable'] });
	}
});

router.post('/voice/end', (req, res) => {
	const callId = str(req.body && req.body.callId, 200);
	const ended = callId ? voiceService.endCallFor(sessionContext.userKey(req), callId) : false;
	res.json({ success: true, ended });
});

module.exports = router;
module.exports.sanitizePage = sanitizePage;
