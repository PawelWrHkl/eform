/**
 * Asystent eForm — Eforek czyta na głos (odpowiedzi czatu i dymki pokazu).
 *
 * Nagranie robi serwer (services/assistant/tts.js, synteza mowy OpenAI):
 * POST /assistant/speak { text, lang } → { url }, a <audio src=url> gra je
 * strumieniem. Gdy serwer nie może (wyłączone, błąd, limit) — głos wbudowany
 * w przeglądarkę (speechSynthesis), o ile jest.
 *
 * Wypowiedzi idą w kolejce (odpowiedź, potem kroki pokazu); `stop()` ją
 * czyści. Jeden głośnik dla mowy i szczekania: localStorage
 * `eformAssistant.barkMuted` (ten sam klucz czyta avatar.js), przycisk w
 * nagłówku okna i w dymku pokazu.
 *
 * Przeglądarka gra dźwięk dopiero po geście klienta na stronie. Gdy odtwarzanie
 * zostanie zablokowane (np. po przejściu na inną stronę w trakcie pokazu),
 * wypowiedź czeka, głośniki pulsują, a pierwsze kliknięcie na stronie ją odtwarza.
 */
(function () {
	'use strict';

	var A = window.eformAssistant;
	if (!A || A.speech) return;
	var boot = window.eformAssistantBoot || {};
	var S = A.strings || {};
	var MUTE_KEY = 'eformAssistant.barkMuted';
	var LANG = (document.documentElement.getAttribute('lang') || 'pl').slice(0, 2);
	var BCP47 = { pl: 'pl-PL', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', nl: 'nl-NL' };
	// Bardzo krótka cisza (WAV) — „odblokowuje" odtwarzacz przy pierwszym geście klienta.
	var SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

	var serverTts = !!boot.tts;
	var browserTts = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
	var enabled = serverTts || browserTts;

	var audio = new Audio();
	audio.preload = 'auto';
	var queue = [];        // [{ text }]
	var current = null;    // bieżąca wypowiedź
	var blocked = null;    // wypowiedź czekająca na gest klienta
	var unlocked = false;
	var generation = 0;    // stop() unieważnia trwające pobrania

	function muted() {
		try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { return false; }
	}
	function setMuted(on) {
		try { window.localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch (_) { /* tylko na tej stronie */ }
		if (on) stop();
		paint();
		window.dispatchEvent(new CustomEvent('eform-assistant:sound', { detail: { muted: !!on } }));
	}

	function voiceBusy() {
		var st = A.voice && A.voice.getState ? A.voice.getState() : 'idle';
		return st && st !== 'idle';
	}

	function setSpeaking(on, text) {
		A.root.classList.toggle('ea-speaking', !!on);
		if (on && A.avatar && A.avatar.set) A.avatar.set('talking', Math.min(15000, 900 + String(text || '').length * 65));
	}

	function finish() {
		current = null;
		setSpeaking(false);
		next();
	}

	function next() {
		if (current || blocked || !queue.length) return;
		current = queue.shift();
		var item = current;
		var gen = generation;
		if (!serverTts) return speakBrowser(item, gen);
		A.api('POST', '/assistant/speak', { text: item.text, lang: LANG }).then(function (r) {
			if (gen !== generation || current !== item) return;
			if (!r.ok || !r.data || !r.data.url) return speakBrowser(item, gen);
			audio.src = r.data.url;
			play(item);
		}).catch(function () {
			if (gen === generation && current === item) speakBrowser(item, gen);
		});
	}

	function play(item) {
		var p;
		try { p = audio.play(); } catch (err) { p = Promise.reject(err); }
		setSpeaking(true, item.text);
		if (p && p.catch) {
			p.catch(function (err) {
				if (current !== item) return;
				setSpeaking(false);
				if (err && err.name === 'NotAllowedError') {
					// Przeglądarka czeka na gest klienta — wypowiedź zagra po pierwszym kliknięciu.
					blocked = item;
					current = null;
					A.root.classList.add('ea-sound-blocked');
					return;
				}
				finish();
			});
		}
	}

	function speakBrowser(item, gen) {
		if (!browserTts || gen !== generation) return finish();
		try {
			var u = new window.SpeechSynthesisUtterance(item.text);
			u.lang = BCP47[LANG] || 'pl-PL';
			u.rate = 1;
			u.onend = u.onerror = function () { if (current === item) finish(); };
			setSpeaking(true, item.text);
			window.speechSynthesis.speak(u);
		} catch (_) {
			finish();
		}
	}

	audio.addEventListener('ended', function () { if (current) finish(); });
	audio.addEventListener('error', function () { if (current) speakBrowser(current, generation); });

	/** Przeczytaj tekst (kolejka). Pomijane: wyciszone, rozmowa głosowa trwa, pusty tekst. */
	function say(text) {
		var t = String(text || '').replace(/\s+/g, ' ').trim();
		if (!enabled || !t || muted() || voiceBusy()) return;
		queue.push({ text: t });
		next();
	}

	/** Odpowiedź czatu: znaczniki [[…]] → nazwy z odnośników (strona, zlecenie, plik). */
	function sayAnswer(text, refs) {
		refs = refs || {};
		say(String(text || '').replace(/\[\[[^\]]+\]\]/g, function (tok) {
			var r = refs[tok];
			return r && r.label && r.type !== 'copy' ? ' ' + r.label + ' ' : ' ';
		}));
	}

	/** Cisza i pusta kolejka (np. „Dalej", „Zakończ", nowe pytanie). */
	function stop() {
		generation += 1;
		queue = [];
		blocked = null;
		current = null;
		A.root.classList.remove('ea-sound-blocked');
		try { audio.pause(); } catch (_) { /* nic */ }
		if (browserTts) { try { window.speechSynthesis.cancel(); } catch (_) { /* nic */ } }
		setSpeaking(false);
	}

	function speaking() {
		return !!(current || queue.length);
	}

	// Pierwszy gest klienta: odblokowanie odtwarzacza i zaległa wypowiedź.
	function onGesture() {
		if (!unlocked && !current && !blocked) {
			unlocked = true;
			audio.src = SILENCE;
			var p = audio.play();
			if (p && p.catch) p.catch(function () { unlocked = false; });
		}
		if (blocked) {
			var item = blocked;
			blocked = null;
			current = item;
			A.root.classList.remove('ea-sound-blocked');
			play(item);
		}
	}
	document.addEventListener('pointerdown', onGesture, true);
	document.addEventListener('keydown', onGesture, true);

	// ── głośnik w nagłówku okna czatu ──
	var ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
	var ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
	var headerBtn = null;
	var header = A.panel && A.panel.querySelector('.ea-header');
	var reset = header && header.querySelector('.ea-reset');
	if (enabled && header && reset) {
		headerBtn = document.createElement('button');
		headerBtn.type = 'button';
		headerBtn.className = 'ea-icon-btn ea-sound';
		headerBtn.addEventListener('click', function () { setMuted(!muted()); });
		header.insertBefore(headerBtn, reset);
	}
	function paint() {
		if (!headerBtn) return;
		var m = muted();
		headerBtn.innerHTML = m ? ICON_OFF : ICON_ON; // stałe ikony z tego pliku
		headerBtn.title = m ? (S.soundOn || '') : (S.soundOff || '');
		headerBtn.setAttribute('aria-label', headerBtn.title);
		headerBtn.setAttribute('aria-pressed', m ? 'true' : 'false');
	}
	paint();

	A.speech = {
		enabled: enabled,
		say: say,
		sayAnswer: sayAnswer,
		stop: stop,
		speaking: speaking,
		muted: muted,
		setMuted: setMuted
	};
})();
