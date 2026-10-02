/**
 * Asystent eForm — rozmowa głosowa (OpenAI Realtime przez WebRTC).
 *
 * Dokłada do okna widżetu (window.eformAssistant z widget.js) przycisk
 * mikrofonu i pasek stanu. Przeglądarka NIE zna klucza API ani instrukcji:
 * wysyła ofertę SDP do `/assistant/voice/session`, serwer zakłada rozmowę
 * w OpenAI i odsyła odpowiedź SDP. Dźwięk płynie bezpośrednio między
 * przeglądarką a OpenAI, zdarzenia (transkrypt, narzędzia) — kanałem
 * danych `oai-events`.
 *
 * Narzędzia modelu wykonuje przeglądarka:
 *   • highlight_element { key } — klucz z katalogu (uiCatalog), jak w czacie,
 *   • show_consultant_form       — formularz przekazania do konsultanta.
 *
 * Przejście na inną stronę zrywa WebRTC: przy `pagehide` kończymy rozmowę
 * (sendBeacon) i zostawiamy znacznik czasu w sessionStorage — nowa strona
 * w ciągu 2 minut łączy się sama (`resume`), a serwer podaje modelowi
 * dotychczasową rozmowę.
 *
 * Avatar (etap późniejszy) podpina się bez zmian w tym pliku:
 *   • zdarzenie `window` „eform-assistant:voice" z `detail.state`:
 *     idle | connecting | listening | user_speaking | thinking | speaking,
 *   • `window.eformAssistant.voice.getOutputLevel()` → 0…1 (głośność mowy
 *     asystenta, np. do ruchu ust),
 *   • miejsce w oknie: `.ea-avatar-slot`.
 */
(function () {
	'use strict';

	var A = window.eformAssistant;
	if (!A || !A.voiceEnabled || A.voice) return;
	// Mikrofon i WebRTC tylko w bezpiecznym kontekście (https / localhost).
	if (!window.isSecureContext || !window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

	var S = A.strings;
	var FLAG = 'eformAssistant.voice';
	var RESUME_MS = 2 * 60 * 1000;

	var call = null;
	var voiceState = 'idle';
	var audioCtx = null;
	var analyser = null;
	var levelBuf = null;

	function storeGet(key) {
		try { return window.sessionStorage.getItem(key); } catch (_) { return null; }
	}
	function storeSet(key, value) {
		try {
			if (value === null) window.sessionStorage.removeItem(key);
			else window.sessionStorage.setItem(key, value);
		} catch (_) { /* bez pamięci — po prostu brak wznowienia */ }
	}

	// ── interfejs ───────────────────────────────────────────────────────────
	var ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>';
	var ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

	var micBtn = document.createElement('button');
	micBtn.type = 'button';
	micBtn.className = 'ea-btn ea-mic-btn';
	micBtn.innerHTML = ICON_MIC;
	micBtn.title = S.voiceStart || '';
	micBtn.setAttribute('aria-label', S.voiceStart || '');
	micBtn.setAttribute('aria-pressed', 'false');
	A.form.insertBefore(micBtn, A.sendBtn);

	var bar = document.createElement('div');
	bar.className = 'ea-voice-bar';
	bar.hidden = true;
	bar.setAttribute('role', 'status');
	var dot = document.createElement('span');
	dot.className = 'ea-voice-dot';
	var barText = document.createElement('span');
	barText.className = 'ea-voice-text';
	var resumeBtn = document.createElement('button');
	resumeBtn.type = 'button';
	resumeBtn.className = 'ea-btn ea-btn-secondary ea-voice-resume';
	resumeBtn.textContent = S.voiceResume || '';
	resumeBtn.hidden = true;
	var stopBtn = document.createElement('button');
	stopBtn.type = 'button';
	stopBtn.className = 'ea-btn ea-btn-secondary ea-voice-stop';
	stopBtn.innerHTML = ICON_STOP;
	stopBtn.appendChild(document.createTextNode(' ' + (S.voiceStop || '')));
	bar.appendChild(dot);
	bar.appendChild(barText);
	bar.appendChild(resumeBtn);
	bar.appendChild(stopBtn);
	A.panel.insertBefore(bar, A.form);

	var STATE_TEXT = {
		connecting: S.voiceConnecting,
		listening: S.voiceListening,
		user_speaking: S.voiceListening,
		thinking: S.voiceThinking,
		speaking: S.voiceSpeaking
	};

	function setState(s) {
		voiceState = s;
		A.root.setAttribute('data-voice', s);
		bar.hidden = s === 'idle';
		barText.textContent = STATE_TEXT[s] || '';
		var active = s !== 'idle';
		micBtn.classList.toggle('ea-mic-active', active);
		micBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
		micBtn.title = active ? (S.voiceStop || '') : (S.voiceStart || '');
		micBtn.setAttribute('aria-label', micBtn.title);
		micBtn.innerHTML = active ? ICON_STOP : ICON_MIC;
		try {
			window.dispatchEvent(new CustomEvent('eform-assistant:voice', { detail: { state: s } }));
		} catch (_) { /* stare przeglądarki bez CustomEvent */ }
	}

	function note(text) {
		if (text) A.addMessage({ role: 'assistant', text: text, status: 'voice_note' });
	}

	// ── poziom dźwięku asystenta (dla avatara) ──────────────────────────────
	function setupAnalyser(stream) {
		try {
			var AC = window.AudioContext || window.webkitAudioContext;
			if (!AC) return;
			audioCtx = audioCtx || new AC();
			var source = audioCtx.createMediaStreamSource(stream);
			analyser = audioCtx.createAnalyser();
			analyser.fftSize = 512;
			source.connect(analyser); // bez wyjścia na głośnik — gra element <audio>
			levelBuf = new Uint8Array(analyser.fftSize);
		} catch (_) {
			analyser = null;
		}
	}

	function getOutputLevel() {
		if (!analyser || voiceState !== 'speaking') return 0;
		analyser.getByteTimeDomainData(levelBuf);
		var sum = 0;
		for (var i = 0; i < levelBuf.length; i++) {
			var v = (levelBuf[i] - 128) / 128;
			sum += v * v;
		}
		return Math.min(1, Math.sqrt(sum / levelBuf.length) * 3);
	}

	function resumeAudio() {
		if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
		if (!call || !call.audio) return;
		var p = call.audio.play();
		if (p && p.catch) {
			p.then(function () { resumeBtn.hidden = true; }).catch(function () { resumeBtn.hidden = false; });
		}
	}

	// ── kanał zdarzeń ───────────────────────────────────────────────────────
	function send(obj) {
		if (call && call.dc && call.dc.readyState === 'open') call.dc.send(JSON.stringify(obj));
	}

	/** Dymek wypowiedzi dla elementu rozmowy — tworzony raz, w kolejności zdarzeń. */
	function messageFor(itemId, role) {
		if (!call || !itemId) return null;
		var m = call.items[itemId];
		if (!m) {
			m = A.addMessage({ role: role, text: '', voice: true });
			call.items[itemId] = m;
		}
		return m;
	}

	function runTool(ev) {
		var args = {};
		try { args = JSON.parse(ev.arguments || '{}'); } catch (_) { args = {}; }
		var out;
		if (ev.name === 'highlight_element') {
			out = { ok: !!A.highlight(String(args.key || '')) };
		} else if (ev.name === 'show_consultant_form') {
			A.openConsultantForm('model');
			out = { shown: true };
		} else {
			out = { error: 'unknown_tool' };
		}
		send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(out) } });
	}

	/** Odpowiedź złożona z samego wywołania narzędzia — poproś model o dokończenie wypowiedzi. */
	function afterResponse(resp) {
		if (!call || !resp || !Array.isArray(resp.output)) return;
		var hadTool = resp.output.some(function (o) { return o && o.type === 'function_call'; });
		var hadSpeech = resp.output.some(function (o) { return o && o.type === 'message'; });
		if (hadTool && !hadSpeech) send({ type: 'response.create' });
	}

	function onEvent(ev) {
		var m;
		switch (ev.type) {
			case 'conversation.item.added':
			case 'conversation.item.created':
				if (ev.item && ev.item.type === 'message' && (ev.item.role === 'user' || ev.item.role === 'assistant')) {
					messageFor(ev.item.id, ev.item.role);
				}
				break;
			case 'conversation.item.input_audio_transcription.completed':
				m = messageFor(ev.item_id, 'user');
				if (m) { m.text = String(ev.transcript || '').trim() || S.voiceUnclear || '…'; A.refresh(); }
				break;
			case 'conversation.item.input_audio_transcription.failed':
				m = messageFor(ev.item_id, 'user');
				if (m) { m.text = S.voiceUnclear || '…'; A.refresh(); }
				break;
			case 'response.output_audio_transcript.delta':
				m = messageFor(ev.item_id, 'assistant');
				if (m) { m.text += ev.delta || ''; A.refresh(); }
				break;
			case 'response.output_audio_transcript.done':
				m = messageFor(ev.item_id, 'assistant');
				if (m) { m.text = ev.transcript || m.text; A.refresh(); }
				break;
			case 'input_audio_buffer.speech_started':
				setState('user_speaking');
				break;
			case 'input_audio_buffer.speech_stopped':
				setState('thinking');
				break;
			case 'output_audio_buffer.started':
				setState('speaking');
				break;
			case 'output_audio_buffer.stopped':
			case 'output_audio_buffer.cleared':
				setState('listening');
				break;
			case 'response.function_call_arguments.done':
				runTool(ev);
				break;
			case 'response.done':
				afterResponse(ev.response);
				break;
			case 'error':
				if (window.console) console.warn('[eform-assistant] realtime:', ev.error && ev.error.message);
				break;
			default:
		}
	}

	// ── start / stop ────────────────────────────────────────────────────────
	function start(resume) {
		if (call) return;
		var c = { items: {}, ended: false, callId: null };
		call = c;
		setState('connecting');
		A.open();

		var pc;
		navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
			.then(function (stream) {
				c.stream = stream;
				if (c.ended) throw { silent: true };
				pc = new RTCPeerConnection();
				c.pc = pc;
				var audio = document.createElement('audio');
				audio.autoplay = true;
				audio.setAttribute('playsinline', '');
				audio.hidden = true;
				A.root.appendChild(audio);
				c.audio = audio;
				pc.ontrack = function (e) {
					audio.srcObject = e.streams[0];
					setupAnalyser(e.streams[0]);
					resumeAudio();
				};
				pc.addTrack(stream.getTracks()[0], stream);
				var dc = pc.createDataChannel('oai-events');
				c.dc = dc;
				dc.addEventListener('message', function (e) {
					var ev;
					try { ev = JSON.parse(e.data); } catch (_) { return; }
					if (call === c) onEvent(ev);
				});
				dc.addEventListener('open', function () { if (call === c) setState('listening'); });
				dc.addEventListener('close', function () { if (call === c) stop('dropped'); });
				pc.addEventListener('connectionstatechange', function () {
					if (call === c && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) stop('dropped');
				});
				return pc.createOffer();
			})
			.then(function (offer) { return pc.setLocalDescription(offer).then(function () { return offer; }); })
			.then(function (offer) {
				return A.ensureLoaded().then(function () {
					return A.api('POST', '/assistant/voice/session', { sdp: offer.sdp, page: A.pageContext(), resume: !!resume });
				});
			})
			.then(function (r) {
				var d = r.data || {};
				if (c.ended) {
					if (d.callId) A.api('POST', '/assistant/voice/end', { callId: d.callId }).catch(function () {});
					throw { silent: true };
				}
				if (!r.ok || !d.success) throw { userMessage: d.message };
				c.callId = d.callId;
				storeSet(FLAG, String(Date.now()));
				c.limitTimer = setTimeout(function () { if (call === c) stop('time_limit'); }, (d.maxSeconds || 600) * 1000);
				return pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
			})
			.catch(function (err) {
				if (err && err.silent) return;
				var message = err && err.name === 'NotAllowedError' ? S.voiceMicDenied
					: (err && err.userMessage) || S.voiceUnavailable;
				if (call === c) stop('error', message);
			});
	}

	/**
	 * @param {string} reason  user | error | dropped | time_limit | pagehide
	 * @param {string} [message]
	 */
	function stop(reason, message) {
		var c = call;
		if (!c || c.ended) return;
		c.ended = true;
		call = null;
		clearTimeout(c.limitTimer);
		if (c.callId && reason !== 'pagehide') A.api('POST', '/assistant/voice/end', { callId: c.callId }).catch(function () {});
		try { if (c.dc) c.dc.close(); } catch (_) { /* już zamknięty */ }
		try { if (c.pc) c.pc.close(); } catch (_) { /* już zamknięty */ }
		if (c.stream) c.stream.getTracks().forEach(function (t) { t.stop(); });
		if (c.audio) { c.audio.srcObject = null; c.audio.remove(); }
		analyser = null;
		resumeBtn.hidden = true;
		Object.keys(c.items).forEach(function (id) { if (!c.items[id].text) A.removeMessage(c.items[id]); });
		// Przejście na inną stronę zostawia znacznik — nowa strona połączy się sama.
		if (reason !== 'pagehide') storeSet(FLAG, null);
		setState('idle');
		if (reason === 'pagehide') return;
		note(message || (reason === 'time_limit' ? S.voiceTimeLimit : reason === 'dropped' ? S.voiceEnded : null));
	}

	// ── zdarzenia ───────────────────────────────────────────────────────────
	micBtn.addEventListener('click', function () {
		if (call) stop('user');
		else start(false);
	});
	stopBtn.addEventListener('click', function () { stop('user'); });
	resumeBtn.addEventListener('click', resumeAudio);
	document.addEventListener('pointerdown', function () {
		if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
	});

	window.addEventListener('pagehide', function () {
		if (!call) return;
		var id = call.callId;
		if (id && navigator.sendBeacon) {
			navigator.sendBeacon('/assistant/voice/end', new Blob([JSON.stringify({ callId: id })], { type: 'application/json' }));
		}
		stop('pagehide');
		storeSet(FLAG, String(Date.now()));
	});

	A.voice = {
		getState: function () { return voiceState; },
		getOutputLevel: getOutputLevel,
		start: function () { start(false); },
		stop: function () { stop('user'); }
	};

	var flag = Number(storeGet(FLAG) || 0);
	if (flag && Date.now() - flag < RESUME_MS) start(true);
	else if (flag) storeSet(FLAG, null);
})();
