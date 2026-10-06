/**
 * Asystent eForm — animowana maskotka „Eforek” (mały biały piesek, własny projekt w SVG).
 *
 * Włączana `ASSISTANT_AVATAR_ENABLED=true` (server.js → partial ładuje ten
 * plik i public/styles/assistant-avatar.css). Dwie kopie postaci: na
 * przycisku „Pomoc" i w nagłówku okna. Stan postaci = atrybut
 * `data-state` (animacje są w CSS):
 *   idle      — oddycha, mruga, merda ogonem,
 *   wave      — macha łapką (otwarcie okna, co jakiś czas na przycisku),
 *   thinking  — patrzy w górę, chmurka z kropkami (czeka na odpowiedź),
 *   talking   — rusza pyszczkiem (odpowiedź tekstowa),
 *   speaking  — pyszczek w rytm głosu asystenta (rozmowa głosowa),
 *   listening — uszy w górę, fale dźwięku (rozmowa głosowa: słucha),
 *   sorry     — smutne brwi, opuszczone uszy (konsultant, błąd),
 *   shake     — kręci głową (pytanie spoza tematu),
 *   happy     — podskok i szybkie merdanie (przekazanie wysłane).
 *
 * Źródła zdarzeń: `eform-assistant:state` (widget.js — czat) i
 * `eform-assistant:voice` (voice.js — rozmowa głosowa) + poziom dźwięku
 * `eformAssistant.voice.getOutputLevel()`.
 */
(function () {
	'use strict';

	var A = window.eformAssistant;
	if (!A || A.avatar) return;

	var reduced = false;
	try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { reduced = false; }

	// Postać: sylwetka mieści się w 100×100, łapka do machania osobno.
	// Postać: mały biały piesek (własny projekt), sylwetka w 100×100. Prawa
	// przednia łapa (`av-paw-r`) rysowana na wierzchu — macha nią przy powitaniu.
	var SVG = '' +
		'<svg class="av-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
		'<ellipse class="av-shadow" cx="50" cy="96" rx="27" ry="3.5"/>' +
		'<g class="av-tail"><path class="av-fur" d="M68 86 C 80 86 89 76 86 63 C 85 58.5 79.5 59.5 80.2 64 C 81.5 72 76 79 67 80 Z"/></g>' +
		'<g class="av-body">' +
		'<path class="av-fur" d="M28 93 C 24 75 31 58 50 58 C 69 58 76 75 72 93 Z"/>' +
		'<ellipse class="av-fur" cx="30.5" cy="90.5" rx="8.5" ry="5"/>' +
		'<ellipse class="av-fur" cx="69.5" cy="90.5" rx="8.5" ry="5"/>' +
		'<rect class="av-fur" x="40" y="70" width="9" height="24.5" rx="4.5"/>' +
		'<path class="av-toe" d="M43 94 v-2.4 M46 94 v-2.4"/>' +
		'</g>' +
		'<ellipse class="av-chest" cx="50" cy="67.5" rx="10.5" ry="7.5"/>' +
		'<g class="av-collar"><path class="av-collar-band" d="M36.5 59.5 Q50 67 63.5 59.5"/><circle class="av-tag" cx="50" cy="66.2" r="3.1"/></g>' +
		'<g class="av-head">' +
		'<path class="av-tuft" d="M44 19.5 q2.5 -6 6 -1.5 q2.5 -5.5 6 0"/>' +
		'<ellipse class="av-fur" cx="50" cy="38" rx="23.5" ry="21"/>' +
		'<ellipse class="av-muzzle" cx="50" cy="47.5" rx="12" ry="8.8"/>' +
		'<ellipse class="av-cheek" cx="34.5" cy="46" rx="4.4" ry="3"/>' +
		'<ellipse class="av-cheek" cx="65.5" cy="46" rx="4.4" ry="3"/>' +
		'<g class="av-eyes">' +
		'<g class="av-eye"><ellipse class="av-pupil" cx="41" cy="35.5" rx="3.9" ry="4.5"/><circle class="av-glint" cx="42.4" cy="33.8" r="1.4"/></g>' +
		'<g class="av-eye"><ellipse class="av-pupil" cx="59" cy="35.5" rx="3.9" ry="4.5"/><circle class="av-glint" cx="60.4" cy="33.8" r="1.4"/></g>' +
		'</g>' +
		'<g class="av-brows"><path d="M36.5 29.5 l7.5 -2.4"/><path d="M63.5 29.5 l-7.5 -2.4"/></g>' +
		'<path class="av-nose" d="M45.2 42.6 Q50 39.8 54.8 42.6 Q54.3 46.6 50 47.6 Q45.7 46.6 45.2 42.6 Z"/>' +
		'<circle class="av-glint" cx="48.4" cy="42.2" r="0.9"/>' +
		'<path class="av-smile" d="M50 47.6 v2.2 M44.8 50.2 q2.6 2.8 5.2 0 q2.6 2.8 5.2 0"/>' +
		'<g class="av-mouth"><ellipse class="av-mouth-in" cx="50" cy="53.4" rx="4.2" ry="3.7"/><ellipse class="av-tongue" cx="50" cy="55.6" rx="2.7" ry="1.9"/></g>' +
		'<g class="av-ear av-ear-l"><path class="av-ear-fill" d="M31 22 C 22.5 24 19.5 39 23.5 50 C 25.5 55 31.5 54 32.5 48.5 C 33.5 40 35 30 31 22 Z"/></g>' +
		'<g class="av-ear av-ear-r"><path class="av-ear-fill" d="M69 22 C 77.5 24 80.5 39 76.5 50 C 74.5 55 68.5 54 67.5 48.5 C 66.5 40 65 30 69 22 Z"/></g>' +
		'</g>' +
		'<g class="av-paw-r"><rect class="av-fur" x="51" y="70" width="9" height="24.5" rx="4.5"/><path class="av-toe" d="M54 94 v-2.4 M57 94 v-2.4"/></g>' +
		'<g class="av-think"><circle cx="78" cy="29" r="1.8"/><circle cx="82" cy="23" r="2.8"/><ellipse class="av-cloud" cx="89" cy="11" rx="11" ry="9"/><g class="av-dots"><circle cx="84.5" cy="11" r="1.6"/><circle cx="89" cy="11" r="1.6"/><circle cx="93.5" cy="11" r="1.6"/></g></g>' +
		'<g class="av-waves"><path d="M84 31 q4 6 0 12"/><path d="M89 27 q6.5 10 0 20"/></g>' +
		'</svg>';

	function makeAvatar(extraClass) {
		var el = document.createElement('span');
		el.className = 'ea-avatar ' + extraClass;
		el.setAttribute('data-state', 'idle');
		el.innerHTML = SVG; // stała treść z tego pliku, bez danych użytkownika
		return el;
	}

	var onLauncher = makeAvatar('ea-avatar-launcher');
	var inHeader = makeAvatar('ea-avatar-header');
	var launcher = A.root.querySelector('.ea-launcher');
	var header = A.panel.querySelector('.ea-header');
	if (!launcher || !header) return;

	// ── przycisk = piesek z dymkiem (zamiast „Pomoc") ──
	// Struktura: div.ea-pet > [dymek (button) + „×" (button)] + przycisk okna z pieskiem.
	// Dymek nie jest w przycisku okna, bo „×" też jest przyciskiem (bez zagnieżdżeń).
	var S = A.strings || {};
	var pet = document.createElement('div');
	pet.className = 'ea-pet';
	var bubbleWrap = document.createElement('div');
	bubbleWrap.className = 'ea-bubble-wrap';
	var bubble = document.createElement('button');
	bubble.type = 'button';
	bubble.className = 'ea-bubble';
	bubble.textContent = S.bubbleText || '';
	var bubbleClose = document.createElement('button');
	bubbleClose.type = 'button';
	bubbleClose.className = 'ea-bubble-close';
	bubbleClose.textContent = '×';
	bubbleClose.title = S.bubbleHide || '';
	bubbleClose.setAttribute('aria-label', S.bubbleHide || '');
	bubbleWrap.appendChild(bubble);
	bubbleWrap.appendChild(bubbleClose);
	pet.appendChild(bubbleWrap);
	launcher.parentNode.insertBefore(pet, launcher);
	pet.appendChild(launcher);
	launcher.classList.add('ea-has-avatar');
	launcher.setAttribute('aria-label', (S.title || '') + ' — ' + (S.bubbleText || ''));
	launcher.insertBefore(onLauncher, launcher.firstChild);
	header.insertBefore(inHeader, header.firstChild);
	A.root.classList.add('ea-avatar-on');

	// Dymek jest zawsze (także po użyciu czatu i na telefonie) — znika WYŁĄCZNIE po „×",
	// do końca sesji logowania: flaga w sesji serwera (`POST /assistant/bubble/hide`),
	// więc obowiązuje na każdej stronie i w każdej karcie, a wraca po ponownym zalogowaniu.
	var boot = window.eformAssistantBoot || {};
	if (boot.bubbleHidden) pet.classList.add('ea-bubble-hidden');
	bubble.addEventListener('click', function () { A.open(); });
	bubbleClose.addEventListener('click', function (e) {
		e.stopPropagation();
		pet.classList.add('ea-bubble-hidden');
		A.api('POST', '/assistant/bubble/hide').catch(function () { /* najwyżej wróci przy następnej stronie */ });
		launcher.focus();
	});

	var instances = [onLauncher, inHeader];
	var base = 'idle';       // stan trwały (rozmowa głosowa)
	var transientTimer = null;
	var raf = null;

	function apply(state) {
		instances.forEach(function (el) { el.setAttribute('data-state', state); });
	}

	/** Stan chwilowy (np. machanie) — po `ms` powrót do stanu trwałego. */
	function flash(state, ms) {
		if (transientTimer) clearTimeout(transientTimer);
		apply(state);
		transientTimer = setTimeout(function () { transientTimer = null; apply(base); }, ms);
	}

	/** Stan trwały — dopóki ktoś go nie zmieni. */
	function hold(state) {
		if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
		base = state;
		apply(state);
		if (state === 'speaking') startMouth();
		else stopMouth();
	}

	// Pyszczek w rytm głosu asystenta (rozmowa głosowa).
	function startMouth() {
		if (raf || reduced || !A.voice || !A.voice.getOutputLevel) return;
		var smooth = 0;
		(function frame() {
			var level = A.voice.getOutputLevel();
			smooth = smooth * 0.6 + level * 0.4;
			var v = Math.min(1, smooth * 1.6).toFixed(3);
			instances.forEach(function (el) { el.style.setProperty('--mouth', v); });
			raf = window.requestAnimationFrame(frame);
		})();
	}
	function stopMouth() {
		if (raf) window.cancelAnimationFrame(raf);
		raf = null;
		instances.forEach(function (el) { el.style.removeProperty('--mouth'); });
	}

	// ── czat tekstowy (widget.js) ──
	window.addEventListener('eform-assistant:state', function (e) {
		var d = (e && e.detail) || {};
		if (base !== 'idle') return; // trwa rozmowa głosowa — ona steruje postacią
		switch (d.state) {
			case 'open': flash('wave', 1600); break;
			case 'thinking': hold('thinking'); base = 'idle'; break;
			case 'answer': {
				var talk = Math.max(1200, Math.min(5000, (d.length || 80) * 35));
				if (d.status === 'off_topic') { flash('shake', 1100); setTimeout(function () { if (base === 'idle') flash('talking', talk); }, 1100); }
				else if (d.status === 'handoff' || d.status === 'error') flash('sorry', Math.max(2200, talk));
				else if (d.status === 'handoff_sent') flash('happy', 1800);
				else flash('talking', talk);
				break;
			}
			default:
		}
	});

	// ── rozmowa głosowa (voice.js) ──
	var VOICE_TO_AVATAR = { connecting: 'thinking', listening: 'listening', user_speaking: 'listening', thinking: 'thinking', speaking: 'speaking' };
	window.addEventListener('eform-assistant:voice', function (e) {
		var s = e && e.detail && e.detail.state;
		hold(VOICE_TO_AVATAR[s] || 'idle');
	});

	// Na zamkniętym oknie chomik co jakiś czas macha do klienta (nie przy ograniczonym ruchu).
	if (!reduced) {
		setInterval(function () {
			if (!A.isOpen() && base === 'idle' && !transientTimer && document.visibilityState === 'visible') {
				onLauncher.setAttribute('data-state', 'wave');
				setTimeout(function () { if (!A.isOpen()) onLauncher.setAttribute('data-state', base); }, 1600);
			}
		}, 25000);
	}

	A.avatar = { set: flash, hold: hold };
})();
