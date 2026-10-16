/**
 * Asystent eForm — pokaz krok po kroku: piesek Eforek biegnie po portalu i pokazuje łapą.
 *
 * Kroki przychodzą z odpowiedzi czatu (`tour`, zweryfikowane na serwerze —
 * services/assistant/tour.js) albo z narzędzia głosowego `start_tour`.
 * Każdy krok: { element, page, order, text, click }.
 *   • element — klucz z katalogu (selektory w `assistantBoot.catalog`, ekrany
 *               i flaga kliknięcia w `assistantBoot.tour`),
 *   • page    — strona (adres w `assistantBoot.pages`), gdy krok to przejście,
 *   • order   — ID zlecenia KONTA: piesek biegnie do jego wiersza na liście
 *               (`[data-order-id]`). Listę i numer podaje serwer — w odpowiedzi
 *               czatu (tools.resolveOrderSteps) albo GET /assistant/order-place/:id
 *               (kroki z rozmowy głosowej); cudze zlecenie → 404, krok pominięty.
 *               Gdy wiersza nie ma na pierwszej stronie listy, piesek wpisuje
 *               numer w jej wyszukiwarkę,
 *   • click   — Eforek sam klika element (tylko elementy z flagą `c` — przejścia,
 *               zakładki, otwarcie okna; serwer i ten plik odrzucają resztę).
 * Gdy element jest na innym ekranie, pokaz przechodzi tam i kontynuuje po
 * wczytaniu strony (stan w sessionStorage, ważny 10 min).
 *
 * Wskaźnik: z maskotką (avatar.js, ASSISTANT_AVATAR_ENABLED) — piesek zeskakuje
 * ze swojego miejsca w rogu, biegnie do elementu, wskazuje go łapą, merda
 * ogonem i szczeka („Hau!" + krótki dźwięk, ASSISTANT_BARK_SOUND, wyciszany
 * głośnikiem w dymku), a po pokazie wraca na miejsce. Bez maskotki — palec.
 *
 * Wskaźnik, przyciemnienie i dymek leżą w warstwie `.ea-tour` z
 * `pointer-events: none` — klient może w każdej chwili sam kliknąć wskazany
 * element. Esc albo „Zakończ" przerywa pokaz.
 */
(function () {
	'use strict';

	var A = window.eformAssistant;
	if (!A || A.tour) return;

	var boot = window.eformAssistantBoot || {};
	var META = boot.tour || { elements: {}, screens: {} };
	var CATALOG = boot.catalog || {};
	var PAGES = boot.pages || {};
	var S = A.strings || {};
	var KEY = 'eformAssistant.tour';
	var MAX_AGE_MS = 10 * 60 * 1000;
	// Listy, na których leżą zlecenia (krok `order`).
	var LIST_PAGES = { offers: true, history: true, canceled: true };
	var reduced = false;
	try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { reduced = false; }

	var run = null;      // { steps, i, seen }
	var target = null;   // bieżący wskazany element
	var timers = [];
	var hovering = false; // klient czyta dymek — pokaz nie kończy się sam
	// Przeglądarka już opuszcza stronę (klik w link) — nie ruszamy następnego kroku,
	// bo poprowadziłby gdzie indziej, zanim wczyta się strona docelowa.
	var leavingAt = 0;
	window.addEventListener('beforeunload', function () { leavingAt = Date.now(); });
	window.addEventListener('pageshow', function () { leavingAt = 0; });

	// ── warstwa: przyciemnienie z obramowaniem, wskaźnik, dymek ─────────────
	var FINGER = '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
		'<path d="M14 4c2.2 0 4 1.8 4 4v12.5c.9-.6 2-1 3.2-1 2.3 0 4.2 1.6 4.7 3.8.8-.4 1.7-.6 2.6-.6 2.4 0 4.4 1.7 4.8 4 .7-.3 1.4-.4 2.2-.4 2.7 0 4.9 2.2 4.9 4.9V36c0 6.6-5.4 12-12 12h-4.6c-3.6 0-7-1.7-9.2-4.6L4.4 31.6c-1.3-1.7-1-4.2.7-5.6 1.6-1.3 4-1.1 5.4.4l-.5-.5V8c0-2.2 1.8-4 4-4z" fill="#fff" stroke="#334155" stroke-width="2" stroke-linejoin="round"/>' +
		'<path d="M21 22v7M28.5 25v5M35.5 28.5v4" fill="none" stroke="#334155" stroke-width="1.6" stroke-linecap="round"/>' +
		'</svg>';
	var TIP = { x: 14, y: 4 }; // czubek palca w układzie 48×48
	var FINGER_SIZE = 46;

	function el(tag, cls, html) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html) e.innerHTML = html; // wyłącznie stała grafika z tego pliku
		return e;
	}

	var layer = el('div', 'ea-tour');
	layer.hidden = true;
	var ring = el('div', 'ea-tour-ring');
	var ripple = el('div', 'ea-tour-ripple');
	var finger = el('div', 'ea-tour-finger', FINGER);
	var callout = el('div', 'ea-tour-callout');
	callout.setAttribute('role', 'dialog');
	callout.setAttribute('aria-live', 'polite');
	callout.setAttribute('aria-label', S.title || 'Eforek');
	var stepLabel = el('div', 'ea-tour-step');
	var text = el('p', 'ea-tour-text');
	var actions = el('div', 'ea-tour-actions');
	var endBtn = el('button', 'ea-btn ea-btn-secondary ea-tour-end');
	endBtn.type = 'button';
	endBtn.textContent = S.tourEnd || '×';
	var nextBtn = el('button', 'ea-btn ea-tour-next');
	nextBtn.type = 'button';
	actions.appendChild(endBtn);
	actions.appendChild(nextBtn);
	callout.appendChild(stepLabel);
	callout.appendChild(text);
	callout.appendChild(actions);
	layer.appendChild(ring);
	layer.appendChild(ripple);
	layer.appendChild(finger);
	layer.appendChild(callout);
	A.root.appendChild(layer);

	callout.addEventListener('mouseenter', function () { hovering = true; });
	callout.addEventListener('mouseleave', function () { hovering = false; });
	callout.addEventListener('focusin', function () { hovering = true; });
	callout.addEventListener('focusout', function () { hovering = false; });

	// ── pamięć między stronami ──────────────────────────────────────────────
	function save() {
		try { window.sessionStorage.setItem(KEY, JSON.stringify({ steps: run.steps, i: run.i, seen: run.seen || [], at: Date.now() })); } catch (_) { /* bez pamięci pokaz kończy się na tej stronie */ }
	}
	function clearSaved() {
		try { window.sessionStorage.removeItem(KEY); } catch (_) { /* nic */ }
	}
	function later(fn, ms) {
		var t = setTimeout(fn, ms);
		timers.push(t);
		return t;
	}
	function clearTimers() {
		timers.forEach(clearTimeout);
		timers = [];
	}

	// ── weryfikacja kroków (druga linia obrony po serwerze) ─────────────────
	function normalize(steps) {
		if (!Array.isArray(steps)) return [];
		var out = [];
		steps.slice(0, 8).forEach(function (s) {
			if (!s || typeof s !== 'object') return;
			var t = String(s.text || '').trim().slice(0, 220);
			if (!t) return;
			if (typeof s.order === 'number' && s.order > 0 && Math.floor(s.order) === s.order) {
				// Lista i numer tylko razem (z serwera); bez nich — zapytamy serwer przy tym kroku.
				var list = typeof s.page === 'string' && LIST_PAGES[s.page] && PAGES[s.page] && s.number ? s.page : null;
				out.push({ element: null, page: list, order: s.order, number: list ? String(s.number).slice(0, 20) : null, text: t, click: false });
				return;
			}
			var key = typeof s.element === 'string' && META.elements[s.element] && CATALOG[s.element] ? s.element : null;
			var page = typeof s.page === 'string' && PAGES[s.page] ? s.page : null;
			if (!key && !page) return;
			out.push({ element: key, page: page, text: t, click: !!(key && META.elements[key].c && s.click === true) });
		});
		return out;
	}

	// ── ekrany i elementy ───────────────────────────────────────────────────
	function onScreen(screenKey) {
		if (screenKey === 'any') return true;
		var sc = META.screens[screenKey];
		if (!sc) return false;
		var ok;
		try { ok = new RegExp(sc.p).test(window.location.pathname); } catch (_) { ok = false; }
		if (!ok || !sc.q) return ok;
		var pair = sc.q.split('=');
		return new URLSearchParams(window.location.search).get(pair[0]) === pair[1];
	}

	/** Zapamiętuje ekrany, przez które przeszedł pokaz (najnowszy na końcu). */
	function noteScreen() {
		if (!run) return;
		run.seen = run.seen || [];
		Object.keys(META.screens).forEach(function (k) {
			if (!onScreen(k)) return;
			var at = run.seen.indexOf(k);
			if (at >= 0) run.seen.splice(at, 1);
			run.seen.push(k);
		});
	}

	function hrefForElement(key) {
		var screens = META.elements[key].s;
		// Ten sam przycisk bywa na kilku listach (np. kopiowanie na ofertach i na wysłanych) —
		// wracamy na tę, przez którą pokaz już przechodził, a nie na pierwszą z brzegu.
		var seen = (run && run.seen) || [];
		for (var k = seen.length - 1; k >= 0; k--) {
			var scSeen = screens.indexOf(seen[k]) >= 0 ? META.screens[seen[k]] : null;
			if (scSeen && scSeen.h) return scSeen.h;
		}
		for (var i = 0; i < screens.length; i++) {
			var sc = META.screens[screens[i]];
			if (sc && sc.h) return sc.h;
		}
		return null;
	}

	function samePage(href) {
		var u = new URL(href, window.location.origin);
		return u.pathname === window.location.pathname && (!u.search || u.search === window.location.search);
	}

	function isVisible(node) {
		if (!node || A.root.contains(node)) return false;
		var r = node.getBoundingClientRect();
		// Pusty kontener (np. formularz parametrów przed wyborem działu) ma zerową wysokość.
		if (r.width < 2 || r.height < 2) return false;
		var cs = window.getComputedStyle(node);
		return cs.visibility !== 'hidden' && cs.display !== 'none';
	}

	function findVisible(key, list) {
		var selectors = list || CATALOG[key] || [];
		for (var i = 0; i < selectors.length; i++) {
			var nodes;
			try { nodes = document.querySelectorAll(selectors[i]); } catch (_) { continue; }
			for (var j = 0; j < nodes.length; j++) if (isVisible(nodes[j])) return nodes[j];
		}
		return null;
	}

	/** Wiersz zlecenia na liście (tabela na komputerze, karta na telefonie). */
	function findOrderRow(id) {
		var nodes = document.querySelectorAll('[data-order-id="' + Number(id) + '"]');
		for (var i = 0; i < nodes.length; i++) if (isVisible(nodes[i])) return nodes[i];
		return null;
	}

	/** Element bywa dokładany skryptem strony — czekamy chwilę. */
	function waitForNode(find, ms, cb) {
		var started = Date.now();
		(function poll() {
			var found = find();
			if (found || Date.now() - started > ms) return cb(found);
			later(poll, 150);
		})();
	}
	function waitFor(key, ms, cb) {
		waitForNode(function () { return findVisible(key); }, ms, cb);
	}

	// ── rysowanie: obramowanie, dymek, palec ────────────────────────────────
	function fingerStart() {
		var pet = A.root.querySelector('.ea-pet .ea-launcher') || A.root.querySelector('.ea-launcher');
		if (pet && isVisibleOwn(pet)) {
			var r = pet.getBoundingClientRect();
			return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.3 };
		}
		return { x: window.innerWidth - 60, y: window.innerHeight - 120 };
	}
	function isVisibleOwn(node) {
		var r = node.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	}

	function moveFinger(x, y, instant) {
		var scale = FINGER_SIZE / 48;
		finger.style.transition = instant || reduced ? 'none' : '';
		finger.style.transform = 'translate(' + Math.round(x - TIP.x * scale) + 'px,' + Math.round(y - TIP.y * scale) + 'px)';
	}

	function placeRing(rect) {
		if (!rect) {
			ring.classList.add('ea-tour-ring-off');
			return;
		}
		ring.classList.remove('ea-tour-ring-off');
		var pad = 6;
		ring.style.left = Math.round(rect.left - pad) + 'px';
		ring.style.top = Math.round(rect.top - pad) + 'px';
		ring.style.width = Math.round(rect.width + pad * 2) + 'px';
		ring.style.height = Math.round(rect.height + pad * 2) + 'px';
	}

	/** Dymek przy elemencie — po stronie, z której nie stoi piesek (`spot`). */
	function placeCallout(rect, spot) {
		var vw = window.innerWidth;
		var vh = window.innerHeight;
		var w = Math.min(320, vw - 24);
		callout.style.width = w + 'px';
		var h = callout.offsetHeight || 140;
		var left;
		var top;
		if (!rect) {
			left = vw - w - 16;
			top = vh - h - 150;
		} else {
			left = rect.left + rect.width / 2 - w / 2;
			if (spot && spot.side === 'right') left = Math.min(left, rect.right - w);
			if (spot && spot.side === 'left') left = Math.max(left, rect.left);
			left = Math.min(Math.max(12, left), vw - w - 12);
			var below = rect.bottom + 18;
			var above = rect.top - h - 18;
			var fitsBelow = below + h < vh - 12;
			var fitsAbove = above > 12;
			// Piesek pod elementem → dymek nad nim (i odwrotnie).
			if (spot && spot.side === 'below' && fitsAbove) top = above;
			else if (spot && spot.side === 'above' && fitsBelow) top = below;
			else top = fitsBelow ? below : (fitsAbove ? above : Math.max(12, vh - h - 12));
		}
		callout.style.left = Math.round(left) + 'px';
		callout.style.top = Math.round(Math.max(12, top)) + 'px';
	}

	function tipPoint(rect) {
		return { x: rect.left + Math.min(rect.width * 0.5, 40), y: rect.top + rect.height * 0.62 };
	}

	// ── piesek-przewodnik (maskotka z avatar.js) ────────────────────────────
	var dog = null; // { box, avatar, bark, pos, out, at, spot }
	function ensureDog() {
		if (dog) return dog;
		if (!A.avatar || !A.avatar.create) return null; // maskotka wyłączona → palec
		var box = el('div', 'ea-runner');
		box.hidden = true;
		var av = A.avatar.create('ea-avatar-runner');
		var bark = el('div', 'ea-runner-bark');
		bark.setAttribute('aria-hidden', 'true');
		box.appendChild(av);
		box.appendChild(bark);
		layer.insertBefore(box, callout);
		dog = { box: box, avatar: av, bark: bark, pos: null, out: false, at: null, spot: null };
		ensureSoundButton();
		return dog;
	}
	function dogSize() { return window.innerWidth < 768 ? 68 : 96; }
	function dogState(st) { if (dog) dog.avatar.setAttribute('data-state', st); }

	/** Miejsce pieska na przycisku w rogu (tam zaczyna i tam wraca). */
	function homePos() {
		var D = dogSize();
		var spot = A.root.querySelector('.ea-avatar-launcher');
		if (spot) {
			var r = spot.getBoundingClientRect();
			if (r.width > 0) return { x: r.left + r.width / 2 - D / 2, y: r.bottom - D };
		}
		return { x: window.innerWidth - D - 20, y: window.innerHeight - D - 70 };
	}

	function setDog(x, y, ms) {
		var D = dogSize();
		dog.box.style.width = D + 'px';
		dog.box.style.height = D + 'px';
		dog.box.style.transition = ms ? 'transform ' + ms + 'ms cubic-bezier(.45,.08,.35,1)' : 'none';
		dog.box.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
		dog.pos = { x: x, y: y };
	}

	/** Piesek zeskakuje z przycisku (tam go chwilowo nie ma) — start z jego miejsca. */
	function dogOut() {
		if (!ensureDog() || dog.out) return;
		var h = homePos();
		setDog(h.x, h.y, 0);
		dog.box.hidden = false;
		dog.out = true;
		dogState('idle');
		A.root.classList.add('ea-dog-away');
	}

	/**
	 * Bieg do (x, y); `cb` po dobiegnięciu. Piesek patrzy w stronę biegu, a tuż
	 * przed metą obraca się tak, jak będzie wskazywał (`faceLeft`) — na miejscu
	 * łapa od razu celuje w element.
	 */
	function dogRun(x, y, cb, faceLeft) {
		var from = dog.pos || homePos();
		var dist = Math.sqrt((x - from.x) * (x - from.x) + (y - from.y) * (y - from.y));
		dog.at = null;
		var turn = function () { if (typeof faceLeft === 'boolean') dog.box.classList.toggle('ea-runner-flip', faceLeft); };
		if (reduced || dist < 8) {
			setDog(x, y, 0);
			turn();
			return later(cb, reduced ? 120 : 0);
		}
		dog.box.classList.toggle('ea-runner-flip', x < from.x - 4);
		var ms = Math.round(Math.max(380, Math.min(1300, dist * 1.2)));
		dogState('run');
		void dog.box.offsetWidth; // start przejścia od bieżącego miejsca
		setDog(x, y, ms);
		later(turn, Math.max(0, ms - 300));
		later(cb, ms + 40);
	}

	/**
	 * Gdzie stanąć, żeby łapa (≈0,7 wysokości pieska) wskazywała środek elementu:
	 * z prawej albo z lewej strony; szeroki element (wiersz na telefonie) — pod lub nad nim.
	 */
	function dogSpot(rect) {
		var D = dogSize();
		var vw = window.innerWidth;
		var vh = window.innerHeight;
		var y = Math.min(Math.max(4, rect.top + rect.height / 2 - D * 0.7), vh - D - 4);
		if (rect.right + D * 0.82 <= vw - 4) return { x: rect.right - D * 0.16, y: y, side: 'right' };
		if (rect.left - D * 0.82 >= 4) return { x: rect.left - D * 0.84, y: y, side: 'left' };
		var x = Math.min(Math.max(4, rect.left + Math.min(rect.width * 0.2, 90)), vw - D - 4);
		if (rect.bottom + D * 0.9 <= vh - 4) return { x: x, y: rect.bottom - D * 0.12, side: 'below' };
		return { x: x, y: Math.max(4, rect.top - D * 0.95), side: 'above' };
	}

	/** Na miejscu: łapa w stronę elementu, merdanie, „Hau!". */
	function dogPresent(spot, quiet) {
		// Bez odbicia łapa wskazuje w prawo — piesek stojący z prawej patrzy w lewo.
		dog.box.classList.toggle('ea-runner-flip', spot.side === 'right');
		dogState(spot.side === 'below' ? 'point-up' : (spot.side === 'above' ? 'point-down' : 'point'));
		if (quiet) return;
		dog.bark.textContent = S.bark || 'Hau!';
		dog.bark.classList.remove('ea-on');
		dog.box.classList.remove('ea-runner-barking');
		void dog.bark.offsetWidth; // restart animacji
		dog.bark.classList.add('ea-on');
		dog.box.classList.add('ea-runner-barking');
		if (A.avatar.bark) A.avatar.bark();
	}

	/** Powrót na miejsce w rogu; potem piesek znów siedzi na przycisku. */
	function dogHome(cb) {
		if (!dog || !dog.out) return cb && cb();
		var h = homePos();
		dog.bark.classList.remove('ea-on');
		dogRun(h.x, h.y, function () {
			dog.box.hidden = true;
			dog.out = false;
			dog.pos = null;
			dog.box.classList.remove('ea-runner-flip', 'ea-runner-barking');
			A.root.classList.remove('ea-dog-away');
			if (A.avatar && A.avatar.set) A.avatar.set('happy', 1400);
			if (cb) cb();
		});
	}

	// Głośnik w dymku pokazu — wycisza szczekanie (wybór zapamiętuje przeglądarka).
	var soundBtn = null;
	function ensureSoundButton() {
		var snd = A.avatar && A.avatar.sound;
		if (soundBtn || !snd || !snd.enabled) return;
		soundBtn = el('button', 'ea-tour-sound');
		soundBtn.type = 'button';
		actions.insertBefore(soundBtn, endBtn);
		soundBtn.addEventListener('click', function () {
			snd.setMuted(!snd.muted());
			paintSound();
		});
		paintSound();
	}
	function paintSound() {
		var muted = A.avatar.sound.muted();
		soundBtn.textContent = muted ? '🔇' : '🔊';
		soundBtn.title = muted ? (S.soundOn || '') : (S.soundOff || '');
		soundBtn.setAttribute('aria-label', soundBtn.title);
		soundBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
	}

	// ── przewijanie i zmiany układu ─────────────────────────────────────────
	function refind() {
		var step = run.steps[run.i];
		if (!step) return null;
		if (step.order && target && target.hasAttribute && target.hasAttribute('data-order-id')) return findOrderRow(step.order);
		return step.element ? findVisible(step.element) : null;
	}

	function reposition() {
		if (!run || !target) return;
		if (!document.body.contains(target) || !isVisible(target)) {
			// Strona przerysowała listę (np. wiersze dociągane skryptem) — szukamy elementu na nowo.
			var again = refind();
			if (!again) return;
			if (dog && dog.at === target) dog.at = again;
			target = again;
			try { again.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { again.scrollIntoView(); }
		}
		var rect = target.getBoundingClientRect();
		placeRing(rect);
		if (dog && dog.out) {
			if (dog.at !== target) return; // piesek jeszcze biegnie — dymek ustawi się po dobiegnięciu
			var spot = dogSpot(rect);
			setDog(spot.x, spot.y, 0);
			dog.box.classList.toggle('ea-runner-flip', spot.side === 'right');
			dog.spot = spot;
			placeCallout(rect, spot);
			return;
		}
		var p = tipPoint(rect);
		moveFinger(p.x, p.y, true);
		placeCallout(rect);
	}
	var rafPending = false;
	function onScrollResize() {
		if (rafPending || !run) return;
		rafPending = true;
		window.requestAnimationFrame(function () { rafPending = false; reposition(); });
	}
	window.addEventListener('scroll', onScrollResize, true);
	window.addEventListener('resize', onScrollResize);
	// Układ strony zmienia się też bez przewijania (rozwinięcia, dociągane dane).
	setInterval(function () { if (run && target && !nextBtn.disabled) reposition(); }, 700);

	function showCallout(step, note) {
		save(); // klient może sam kliknąć wskazany przycisk i przejść dalej — pokaz to podchwyci
		var n = run.i + 1;
		var total = run.steps.length;
		stepLabel.textContent = (S.tourStep || '{n}/{total}').replace('{n}', n).replace('{total}', total);
		text.textContent = (note ? note + ' ' : '') + step.text;
		nextBtn.textContent = n >= total ? (S.tourDone || 'OK') : (S.tourNext || '→');
		nextBtn.disabled = false;
		callout.hidden = false;
		layer.hidden = false;
		A.root.classList.add('ea-touring');
		if (!dog && A.avatar && A.avatar.set) A.avatar.set('talking', Math.min(4000, 900 + step.text.length * 30));
	}

	function showNote(step, note) {
		placeRing(null);
		finger.hidden = true;
		showCallout(step, note);
		placeCallout(null);
	}

	// ── przebieg ────────────────────────────────────────────────────────────
	function showStep() {
		clearTimers();
		target = null;
		if (!run) return;
		noteScreen();
		var step = run.steps[run.i];
		if (!step) return stop(true);

		if (step.order) return showOrderStep(step);

		// Krok „przejdź na stronę"
		if (!step.element) {
			var href = PAGES[step.page];
			if (href && !samePage(href)) {
				run.i += 1;
				save();
				window.location.href = href;
				return;
			}
			showNote(step);
			return;
		}

		var meta = META.elements[step.element];
		if (!meta.s.some(onScreen)) {
			var go = hrefForElement(step.element);
			if (go && !samePage(go)) {
				save(); // ten sam krok — wykona się po wczytaniu strony
				window.location.href = go;
				return;
			}
			showNote(step, S.tourOtherScreen);
			return;
		}

		// Nowy krok widać od razu (szukanie elementu trwa do 2,5 s — bez tego dymek
		// stał na poprzednim kroku i klient klikał „Dalej" drugi raz).
		placeRing(null);
		showCallout(step);
		placeCallout(null);
		waitFor(step.element, 2500, function (found) {
			if (!run || run.steps[run.i] !== step) return;
			if (!found) {
				// Np. menu schowane na telefonie — przejście wprost tam, dokąd prowadzi.
				if (step.click && meta.n && !samePage(meta.n)) {
					run.i += 1;
					save();
					window.location.href = meta.n;
					return;
				}
				// Pusta lista (np. brak katalogów, nic do zatwierdzenia) — wskazujemy ją z wyjaśnieniem.
				var empty = meta.e ? findVisible(step.element, meta.e) : null;
				if (empty) return point(empty, step, S.tourEmpty);
				// Element pojawia się dopiero po działaniu klienta (np. formularz po wyborze
				// działu i grupy) — mówimy, co zrobić, i czekamy; gdy się pokaże, piesek tam biegnie.
				showNote(step, meta.w === 'choice' ? S.tourAfterChoice : S.tourMissing);
				watchFor(step);
				return;
			}
			point(found, step);
		});
	}

	function watchFor(step) {
		var until = Date.now() + 3 * 60 * 1000;
		(function poll() {
			if (!run || run.steps[run.i] !== step || target) return;
			var found = findVisible(step.element);
			if (found) return point(found, step);
			if (Date.now() < until) later(poll, 500);
		})();
	}

	// ── krok „to zlecenie na liście" ────────────────────────────────────────
	function showOrderStep(step) {
		if (!step.page) {
			// Krok z rozmowy głosowej — serwer mówi, na której liście jest zlecenie
			// (wyłącznie zlecenia zalogowanego konta; cudze → 404).
			showNote(step);
			A.api('GET', '/assistant/order-place/' + step.order).then(function (r) {
				if (!run || run.steps[run.i] !== step) return;
				if (!r.ok || !r.data || !LIST_PAGES[r.data.page] || !PAGES[r.data.page]) return showNote(step, S.tourOrderMissing);
				step.page = r.data.page;
				step.number = String(r.data.number || '').slice(0, 20);
				save();
				showOrderStep(step);
			}).catch(function () {
				if (run && run.steps[run.i] === step) showNote(step, S.tourOrderMissing);
			});
			return;
		}
		if (!samePage(PAGES[step.page])) {
			save(); // ten sam krok — wykona się na liście
			window.location.href = PAGES[step.page];
			return;
		}
		placeRing(null);
		showCallout(step);
		placeCallout(null);
		waitForNode(function () { return findOrderRow(step.order); }, 1500, function (row) {
			if (!run || run.steps[run.i] !== step) return;
			if (row) return point(row, step);
			searchOrder(step);
		});
	}

	/** Zlecenia nie ma na tej stronie listy — piesek biegnie do „Szukaj" i wpisuje jego numer. */
	function searchOrder(step) {
		var input = document.querySelector('.orders-search__input');
		if (!input || !isVisible(input) || !step.number) return showNote(step, S.tourOrderMissing);
		point(input, step, (S.tourSearching || '').replace('{number}', step.number), true);
		later(function () {
			if (!run || run.steps[run.i] !== step) return;
			input.value = step.number;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			waitForNode(function () { return findOrderRow(step.order); }, 6000, function (row) {
				if (!run || run.steps[run.i] !== step) return;
				if (row) return point(row, step);
				showNote(step, S.tourOrderMissing);
			});
		}, reduced ? 300 : 1700);
	}

	/**
	 * Wskazanie elementu: piesek biegnie i pokazuje łapą (albo palec).
	 * `note` — wyjaśnienie przed tekstem kroku (wtedy bez klikania i bez
	 * samoczynnego końca); `quiet` — bez szczekania (np. przy wyszukiwarce).
	 */
	function point(node, step, note, quiet) {
		target = node;
		try { node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (_) { node.scrollIntoView(); }
		layer.hidden = false;
		showCallout(step, note);
		var withDog = !!ensureDog();
		finger.hidden = withDog;
		if (withDog) dogOut();
		later(function () {
			if (!run || target !== node) return;
			var rect = node.getBoundingClientRect();
			placeRing(rect);
			if (withDog) {
				var spot = dogSpot(rect);
				dog.spot = spot;
				// Bez odbicia łapa wskazuje w prawo — piesek stojący z prawej patrzy w lewo.
				dogRun(spot.x, spot.y, function () {
					if (!run || target !== node) return;
					// Po biegu element mógł się przesunąć (dociągane dane) — stajemy przy nim na nowo.
					var r2 = node.getBoundingClientRect();
					var s2 = dogSpot(r2);
					setDog(s2.x, s2.y, 0);
					dog.spot = s2;
					dog.at = node;
					placeRing(r2);
					placeCallout(r2, s2);
					dogPresent(s2, quiet || !!note);
					afterPointing(node, step, note || quiet, tipPoint(r2));
				}, spot.side === 'right');
			} else {
				placeCallout(rect);
				var p = tipPoint(rect);
				moveFinger(p.x, p.y, false);
				afterPointing(node, step, note || quiet, p);
			}
		}, reduced ? 50 : 420);
	}

	/** Po wskazaniu: klik Eforka (przejścia, zakładki) albo — na ostatnim kroku — powrót pieska. */
	function afterPointing(node, step, noted, p) {
		if (!step.click || noted) {
			if (!noted) autoFinish(step);
			return;
		}
		nextBtn.disabled = true;
		later(function () {
			if (!run || target !== node) return;
			if (dog && dog.out) dogState('tap');
			else {
				finger.classList.remove('ea-tour-tap');
				void finger.offsetWidth; // restart animacji
				finger.classList.add('ea-tour-tap');
			}
			ripple.style.left = Math.round(p.x - 20) + 'px';
			ripple.style.top = Math.round(p.y - 20) + 'px';
			ripple.classList.remove('ea-tour-ripple-on');
			void ripple.offsetWidth;
			ripple.classList.add('ea-tour-ripple-on');
			later(function () {
				if (!run || target !== node) return;
				run.i += 1;
				save();
				node.click();
				// Jeśli klik nie zmienił strony (zakładka, okno), następny krok po chwili.
				later(afterClick, 900);
			}, 380);
		}, reduced ? 200 : (dog && dog.out ? 900 : 950));
	}

	/**
	 * Ostatni krok z pieskiem: po przeczytaniu (czas zależny od długości tekstu)
	 * piesek sam wraca na miejsce — chyba że klient trzyma kursor na dymku.
	 */
	function autoFinish(step) {
		if (!dog || !dog.out || run.i !== run.steps.length - 1) return;
		var wait = Math.max(5000, Math.min(14000, 2500 + step.text.length * 45));
		(function tick(ms) {
			later(function () {
				if (!run || run.steps[run.i] !== step) return;
				if (hovering) return tick(1500);
				stop(true);
			}, ms);
		})(wait);
	}

	/** Po kliknięciu Eforka: strona się zmienia → czekamy (dokończy wznowienie); inaczej następny krok. */
	function afterClick() {
		if (!run) return;
		// Link do pliku (np. PDF) też zaczyna „opuszczanie", ale strona zostaje — po 4 s idziemy dalej.
		if (leavingAt && Date.now() - leavingAt < 4000) return later(afterClick, 300);
		leavingAt = 0;
		showStep();
	}

	function begin(steps, i, seen) {
		run = { steps: steps, i: i, seen: seen || [] };
		hovering = false;
		if (A.close) A.close();
		if (!ensureDog()) {
			var s = fingerStart();
			finger.hidden = false;
			moveFinger(s.x, s.y, true);
		}
	}

	function start(steps) {
		var clean = normalize(steps);
		if (!clean.length) return false;
		begin(clean, 0);
		if (A.avatar && A.avatar.set && !(dog && dog.out)) A.avatar.set('wave', 1400);
		later(showStep, reduced ? 0 : 250);
		return true;
	}

	/**
	 * Koniec pokazu. Z pieskiem: wraca biegiem na swoje miejsce, okno czatu
	 * zostaje zamknięte (rozmowa czeka pod pieskiem). Z palcem — wraca okno czatu.
	 */
	function stop(finished) {
		clearTimers();
		run = null;
		target = null;
		clearSaved();
		placeRing(null);
		callout.hidden = true;
		finger.classList.remove('ea-tour-tap');
		function done() {
			layer.hidden = true;
			callout.hidden = false;
			A.root.classList.remove('ea-touring');
		}
		if (dog && dog.out) return dogHome(done);
		done();
		if (finished && A.open) A.open();
	}

	nextBtn.addEventListener('click', function () {
		if (!run) return;
		run.i += 1;
		if (run.i >= run.steps.length) return stop(true);
		save();
		showStep();
	});
	endBtn.addEventListener('click', function () { stop(false); });
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && run) stop(false);
	});

	A.tour = { start: start, stop: stop, isRunning: function () { return !!run; } };

	// Wznowienie po przejściu na inną stronę w trakcie pokazu.
	var saved = null;
	try { saved = JSON.parse(window.sessionStorage.getItem(KEY) || 'null'); } catch (_) { saved = null; }
	/** Czy krok dotyczy bieżącego ekranu. */
	function stepHere(step) {
		if (!step) return false;
		if (step.order) return !!(step.page && samePage(PAGES[step.page]));
		if (step.element) return META.elements[step.element].s.some(function (sc) { return sc !== 'any' && onScreen(sc); });
		return !!(step.page && PAGES[step.page] && samePage(PAGES[step.page]));
	}

	if (saved && Date.now() - saved.at < MAX_AGE_MS && Array.isArray(saved.steps)) {
		var steps = normalize(saved.steps);
		var i0 = saved.i;
		// Klient sam wykonał krok (np. kliknął wskazane „Zapisz") i jest już na ekranie
		// kolejnego kroku — przeskakujemy dalej, zamiast cofać go na poprzedni ekran.
		while (i0 < steps.length - 1 && !stepHere(steps[i0]) && stepHere(steps[i0 + 1])) i0 += 1;
		if (i0 < steps.length) {
			// Maskotka (avatar.js) ładuje się po tym pliku — start po chwili, gdy już jest.
			later(function () {
				begin(steps, i0, Array.isArray(saved.seen) ? saved.seen.filter(function (k) { return !!META.screens[k]; }) : []);
				showStep();
			}, 350); // skrypty strony zdążą dołożyć elementy
		} else {
			clearSaved();
			if (A.open && !(A.avatar && A.avatar.create)) A.open(); // pokaz skończył się kliknięciem na poprzedniej stronie
		}
	} else if (saved) {
		clearSaved();
	}
})();
