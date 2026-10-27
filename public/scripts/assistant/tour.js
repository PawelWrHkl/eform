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
 *               numer w jej wyszukiwarkę. Z `click` piesek otwiera zlecenie,
 *               z `action` (send / copy / cancel / delete) klika ten przycisk
 *               w wierszu TEGO zlecenia — portal otwiera okno potwierdzenia,
 *               a piesek wskazuje w nim przycisk, który klika już klient,
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
 * Okna potwierdzenia portalu są modalne (<dialog> w warstwie top-layer) —
 * na ten krok warstwa pokazu wchodzi do środka okna; gdy klient okno zamknie
 * (potwierdzi albo zrezygnuje), pokaz się kończy i piesek wraca na miejsce.
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
	// Przyciski akcji w wierszu zlecenia (tabela i karta na telefonie) — każdy tylko otwiera okno potwierdzenia.
	var ROW_ACTIONS = {
		send: '.send-order-btn, .submit-approval-btn',
		copy: '.copy-order-btn',
		cancel: '.cancel-order-btn',
		delete: '.delete-position-btn'
	};
	// Ograniczenie ruchu decyduje widget.js (ustawienie systemu, chyba że ASSISTANT_ANIMATE_ALWAYS).
	var reduced = !!A.reducedMotion;

	// Tempo pokazu (ms) — klient ma spokojnie przeczytać dymek, zanim piesek pobiegnie dalej.
	// „Dalej" w dymku pozwala przyspieszyć.
	var PACE = {
		runMin: 900, runMax: 2600, runPerPx: 2.2, // bieg: czas wg odległości
		readMin: 3000, readMax: 8000, readBase: 1400, readPerChar: 50, // czytanie przed kliknięciem Eforka
		tap: 600,          // od stuknięcia łapą do kliknięcia
		rowAction: 1800,   // wiersz zlecenia wskazany → bieg do przycisku akcji
		search: 2600,      // piesek przy „Szukaj" → wpisanie numeru
		hiddenDone: 3000,  // „Zrobione!" przy przełączniku bez przycisku
		finishMin: 7000, finishMax: 16000, finishBase: 3000, finishPerChar: 60 // ostatni krok → powrót na miejsce
	};
	function soundOn() {
		return !!(A.speech && A.speech.enabled && !A.speech.muted());
	}

	/**
	 * `fn` dopiero, gdy Eforek skończy mówić (i chwila pauzy) — pokaz nie ucieka przed
	 * zdaniem i przejście na inną stronę nie ucina dźwięku. Najwyżej 60 s czekania.
	 */
	function quietThen(fn) {
		var waited = 0;
		var heard = false;
		var g = function () {
			if (A.speech && A.speech.speaking() && waited < 60000) {
				waited += 250;
				heard = true;
				return later(g, 250);
			}
			if (heard) {
				heard = false;
				return later(g, 700);
			}
			fn();
		};
		return g;
	}

	/** Pierwsza pauza przed ruchem Eforka: z dźwiękiem krótko (dalej czeka na koniec zdania), bez — czas czytania. */
	function firstWait(step) {
		if (reduced) return 200;
		return soundOn() ? 1500 : readMs(step);
	}

	function readMs(step) {
		return Math.max(PACE.readMin, Math.min(PACE.readMax, PACE.readBase + String(step.text || '').length * PACE.readPerChar));
	}
	var pendingTap = null; // klik Eforka czekający, aż klient przeczyta (albo kliknie „Dalej")

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
		steps.slice(0, 12).forEach(function (s) {
			if (!s || typeof s !== 'object') return;
			var t = String(s.text || '').trim().slice(0, 220);
			if (!t) return;
			if (typeof s.order === 'number' && s.order > 0 && Math.floor(s.order) === s.order) {
				// Lista i numer tylko razem (z serwera); bez nich — zapytamy serwer przy tym kroku.
				var list = typeof s.page === 'string' && LIST_PAGES[s.page] && PAGES[s.page] && s.number ? s.page : null;
				var action = typeof s.action === 'string' && ROW_ACTIONS[s.action] ? s.action : null;
				// click — piesek klika wiersz i otwiera zlecenie (zwykłe przejście na jego stronę).
				out.push({ element: null, page: list, order: s.order, number: list ? String(s.number).slice(0, 20) : null, action: action, text: t, click: !action && s.click === true });
				return;
			}
			var key = typeof s.element === 'string' && META.elements[s.element] && CATALOG[s.element] ? s.element : null;
			var page = typeof s.page === 'string' && PAGES[s.page] ? s.page : null;
			if (!key && !page) return;
			var st = { element: key, page: page, text: t, click: !!(key && META.elements[key].c && s.click === true) };
			// Pole z `fill` (nazwa zamówienia, dział, grupa produktu) — Eforek wpisze / wybierze `value`.
			if (key && META.elements[key].f && typeof s.value === 'string' && s.value.trim()) {
				st.value = s.value.replace(/\s+/g, ' ').trim().slice(0, 60);
				st.click = false;
			}
			out.push(st);
		});
		return withConfirmSteps(out);
	}

	function isDialogStep(step) {
		return !!(step && step.element && META.elements[step.element] && META.elements[step.element].d);
	}

	/**
	 * Po każdej akcji, która otwiera okno potwierdzenia portalu, krok „potwierdź tutaj"
	 * (piesek wskazuje przycisk, klika klient) — chyba że model już go dodał.
	 */
	function withConfirmSteps(steps) {
		if (!META.elements.dialog_confirm) return steps;
		var out = [];
		steps.forEach(function (st, i) {
			out.push(st);
			var opens = st.order ? !!st.action : !!(st.element && st.click && META.elements[st.element].k);
			if (!opens || isDialogStep(steps[i + 1])) return;
			var cancel = st.action === 'cancel' || st.element === 'cancel_order_view';
			out.push({ element: 'dialog_confirm', page: null, text: (cancel ? S.tourConfirmCancel : S.tourConfirm) || '✓', click: false });
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

	/** Pierwszy pasujący element, także niewidoczny (przełączniki widoku w zwiniętym menu). */
	function findAny(key) {
		var selectors = CATALOG[key] || [];
		for (var i = 0; i < selectors.length; i++) {
			var n = null;
			try { n = document.querySelector(selectors[i]); } catch (_) { n = null; }
			if (n && !A.root.contains(n)) return n;
		}
		return null;
	}

	/**
	 * Panel użytkownika, „Zmień wygląd”, przewodnik i tryb ciemny siedzą w menu konta
	 * (`[data-header-menu]`, base.njk) — zamknięta lista chowa je przed wskazaniem,
	 * więc ją rozwijamy. Na telefonie nagłówka nie widać: zostaje `navTo`/`hiddenOk`.
	 */
	function revealInMenu(key) {
		var node = findAny(key);
		var menu = node && node.closest ? node.closest('[data-header-menu]') : null;
		if (!menu || isVisible(node)) return;
		var trigger = menu.querySelector('[data-bs-toggle="dropdown"]');
		if (!trigger || !isVisible(trigger) || !window.bootstrap || !window.bootstrap.Dropdown) return;
		window.bootstrap.Dropdown.getOrCreateInstance(trigger).show();
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

	// ── warstwa w oknie modalnym ────────────────────────────────────────────
	var hostDlg = null;
	var hostCss = '';
	/**
	 * Okno potwierdzenia (<dialog> modalny) przykrywa wszystko — warstwa pokazu wchodzi
	 * do jego środka. Rozmyte szkło (backdrop-filter) okna zamknęłoby jednak warstwę
	 * w jego ramce (containing block dla position: fixed, a na komputerze okno ucina
	 * zawartość), więc na ten czas okno dostaje pełne tło bez rozmycia; potem wraca
	 * jego styl. Przesunięcia okna (telefon: translate(-50%, -50%)) nie ruszamy —
	 * kompensuje je fitLayer().
	 */
	function ensureHost(node) {
		var dlg = node && node.closest ? node.closest('dialog[open]') : null;
		if (dlg !== hostDlg) {
			if (hostDlg) hostDlg.style.cssText = hostCss;
			hostDlg = dlg;
			hostCss = dlg ? dlg.style.cssText : '';
			if (dlg) {
				['backdrop-filter', '-webkit-backdrop-filter', 'filter', 'animation'].forEach(function (prop) { dlg.style.setProperty(prop, 'none', 'important'); });
				dlg.style.setProperty('background', 'var(--bg-surface-solid, #fff)', 'important');
			}
		}
		var host = dlg || A.root;
		if (layer.parentNode !== host) host.appendChild(layer);
		fitLayer();
	}

	/**
	 * Warstwa ma zawsze pokrywać ekran od jego lewego górnego rogu. W oknie z
	 * transformacją (telefon) `position: fixed` liczy się od okna — przesuwamy
	 * warstwę o tyle, o ile okno jest przesunięte (jej dzieci liczą się od niej,
	 * bo `.ea-tour` ma transform w CSS).
	 */
	function fitLayer() {
		['left', 'top', 'right', 'bottom', 'width', 'height'].forEach(function (p) { layer.style[p] = ''; });
		if (!hostDlg || layer.hidden) return;
		var lr = layer.getBoundingClientRect();
		if (Math.abs(lr.left) < 0.5 && Math.abs(lr.top) < 0.5) return;
		layer.style.left = (-lr.left) + 'px';
		layer.style.top = (-lr.top) + 'px';
		layer.style.right = 'auto';
		layer.style.bottom = 'auto';
		layer.style.width = window.innerWidth + 'px';
		layer.style.height = window.innerHeight + 'px';
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
		var ms = Math.round(Math.max(PACE.runMin, Math.min(PACE.runMax, dist * PACE.runPerPx)));
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
	/** Głośnik: mowa (speech.js) i szczekanie (avatar.js) — jeden przełącznik. */
	function soundApi() {
		if (A.speech && A.speech.enabled) return { enabled: true, muted: A.speech.muted, setMuted: A.speech.setMuted };
		return A.avatar && A.avatar.sound;
	}
	function ensureSoundButton() {
		var snd = soundApi();
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
	window.addEventListener('eform-assistant:sound', function () { if (soundBtn) paintSound(); });
	function paintSound() {
		var muted = soundApi().muted();
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
			// Strona przerysowała listę (np. wiersze dociągane skryptem) albo okno potwierdzenia
			// przeszło do następnego etapu (anulowanie: „Dalej" → „Czy na pewno?") — szukamy na nowo.
			var again = refind();
			if (!again) {
				// Klient zamknął okno potwierdzenia (potwierdził albo zrezygnował) — koniec pokazu.
				if (isDialogStep(run.steps[run.i])) stop(true);
				return;
			}
			if (dog && dog.at === target) dog.at = again;
			target = again;
			ensureHost(again);
			try { again.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { again.scrollIntoView(); }
		}
		if (hostDlg) fitLayer();
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

	/** Eforek czyta dymek na głos — raz na krok (i jeszcze raz, gdy dojdzie wyjaśnienie). */
	var spokenKey = null;
	function speakStep(step, note) {
		if (!A.speech) return;
		var key = run.i + '|' + (note || '') + '|' + step.text;
		if (key === spokenKey) return;
		var onlyNote = spokenKey && spokenKey.indexOf(run.i + '|') === 0 && note;
		spokenKey = key;
		A.speech.say(onlyNote ? note : (note ? note + ' ' : '') + step.text);
	}

	function showCallout(step, note) {
		save(); // klient może sam kliknąć wskazany przycisk i przejść dalej — pokaz to podchwyci
		speakStep(step, note);
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
		ensureHost(null);
		placeRing(null);
		finger.hidden = true;
		showCallout(step, note);
		placeCallout(null);
	}

	// ── przebieg ────────────────────────────────────────────────────────────
	function showStep() {
		clearTimers();
		pendingTap = null;
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

		// Pozycja menu konta w nagłówku — po bieżącym kliknięciu (np. „Dalej”), bo to
		// samo kliknięcie zamknęłoby listę rozwiniętą od razu (Bootstrap: klik poza nią).
		later(function () { revealInMenu(step.element); }, 0);
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
				// Przełącznik widoku bez widocznego przycisku (np. tryb ciemny na telefonie,
				// „Zmień wygląd" w zwiniętym menu) — działa i bez wskazania: klikamy go wprost.
				if (step.click && meta.h) {
					var hiddenNode = findAny(step.element);
					if (hiddenNode) {
						showNote(step, S.tourDoneHidden);
						hiddenNode.click();
						run.i += 1;
						save();
						later(quietThen(function () { if (run) { if (run.i >= run.steps.length) stop(true); else showStep(); } }), PACE.hiddenDone);
						return;
					}
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
				// Akcja tylko, gdy serwer ją dopuszcza dla tego zlecenia (status, uprawnienia konta).
				if (step.action && (!Array.isArray(r.data.actions) || r.data.actions.indexOf(step.action) < 0)) step.action = null;
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
		}, reduced ? 300 : PACE.search);
	}

	/**
	 * Wskazanie elementu: piesek biegnie i pokazuje łapą (albo palec).
	 * `note` — wyjaśnienie przed tekstem kroku (wtedy bez klikania i bez
	 * samoczynnego końca); `quiet` — bez szczekania (np. przy wyszukiwarce).
	 */
	function point(node, step, note, quiet) {
		target = node;
		ensureHost(node);
		try { node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (_) { node.scrollIntoView(); }
		layer.hidden = false;
		fitLayer();
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

	/** Akcja w wierszu zlecenia: piesek przebiega do przycisku (wysłanie, anulowanie…) i go klika. */
	function rowAction(row, step) {
		var btn = null;
		var nodes = row.querySelectorAll(ROW_ACTIONS[step.action]);
		for (var i = 0; i < nodes.length; i++) if (isVisible(nodes[i]) && !nodes[i].disabled) { btn = nodes[i]; break; }
		if (!btn) return showNote(step, S.tourActionMissing);
		target = btn;
		var rect = btn.getBoundingClientRect();
		placeRing(rect);
		var go = function () {
			if (!run || target !== btn) return;
			var r2 = btn.getBoundingClientRect();
			placeRing(r2);
			if (dog && dog.out) {
				var s2 = dogSpot(r2);
				setDog(s2.x, s2.y, 0);
				dog.at = btn;
				dogState(s2.side === 'below' ? 'point-up' : (s2.side === 'above' ? 'point-down' : 'point'));
				placeCallout(r2, s2);
			} else placeCallout(r2);
			afterPointing(btn, { click: true, text: step.text, quick: true }, false, tipPoint(r2));
		};
		if (dog && dog.out) {
			var spot = dogSpot(rect);
			dogRun(spot.x, spot.y, go, spot.side === 'right');
		} else {
			var p = tipPoint(rect);
			moveFinger(p.x, p.y, false);
			later(go, reduced ? 50 : PACE.rowAction);
		}
	}

	// ── wpisywanie i wybór (nazwa zamówienia, dział i grupa produktu) ───────
	function norm(t) {
		return String(t || '').toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, ' ').trim();
	}

	/** Pozycja listy najlepiej pasująca do `wanted`: dokładna → na początku → zawiera (w obie strony). */
	function bestOption(sel, wanted) {
		var w = norm(wanted);
		if (!w) return null;
		var opts = Array.prototype.filter.call(sel.options, function (o) { return o.value && !o.disabled; });
		var score = function (o) {
			var t = norm(o.textContent);
			if (!t) return 0;
			if (t === w) return 4;
			if (t.indexOf(w) === 0) return 3;
			if (t.indexOf(w) >= 0) return 2;
			// „plisy cosiflor" w polu działu: wystarczy, że nazwa działu jest w życzeniu.
			return w.indexOf(t) >= 0 ? 1 : 0;
		};
		var best = null;
		var bestScore = 0;
		opts.forEach(function (o) { var sc = score(o); if (sc > bestScore) { best = o; bestScore = sc; } });
		return best;
	}

	/** Piesek wpisuje tekst litera po literze albo wybiera pozycję z listy; potem następny krok. */
	function fillStep(node, step) {
		var kind = META.elements[step.element].f;
		var go = function () {
			if (pendingTap !== go) return;
			pendingTap = null;
			if (!run || target !== node) return;
			nextBtn.disabled = true;
			if (dog && dog.out) dogState('tap');
			var done = function (ok) {
				if (!run || target !== node) return;
				nextBtn.disabled = false;
				if (!ok) {
					// Nie ma takiej pozycji (np. inna nazwa produktu u klienta) — klient wybiera sam.
					// Wymieniamy, co jest na liście — klient od razu widzi, z czego wybrać.
					var names = Array.prototype.filter.call(node.options || [], function (o) { return o.value && !o.disabled; })
						.map(function (o) { return o.textContent.trim(); }).filter(Boolean).slice(0, 8);
					var note = (S.tourPickYourself || '').replace('{value}', step.value);
					if (names.length) note += ' ' + (S.tourAvailable || '').replace('{list}', names.join(', '));
					showCallout(step, note);
					return;
				}
				if (dog && dog.out) dogPresent(dog.spot || dogSpot(node.getBoundingClientRect()), true);
				run.i += 1;
				save();
				later(function () { if (run) showStep(); }, reduced ? 200 : 900);
			};
			if (kind === 'text') typeInto(node, step.value, done);
			else pickOption(node, step.value, done);
		};
		pendingTap = go;
		later(quietThen(go), reduced ? 200 : Math.min(firstWait(step), 4000));
	}

	function typeInto(input, value, done) {
		try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
		input.value = '';
		var i = 0;
		(function next() {
			if (!run) return;
			if (i >= value.length) {
				input.dispatchEvent(new Event('change', { bubbles: true }));
				return done(true);
			}
			input.value += value.charAt(i++);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			later(next, reduced ? 0 : 90);
		})();
	}

	/** Lista bywa dociągana po wyborze poprzedniej (grupy po dziale) — czekamy do 6 s. */
	function pickOption(sel, value, done) {
		var started = Date.now();
		(function poll() {
			if (!run) return;
			var opt = bestOption(sel, value);
			if (!opt && Date.now() - started < 6000) return later(poll, 250);
			if (!opt) return done(false);
			sel.value = opt.value;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			done(true);
		})();
	}

	/** Po wskazaniu: klik Eforka (przejścia, zakładki, akcje) albo — na ostatnim kroku — powrót pieska. */
	function afterPointing(node, step, noted, p) {
		if (step.order && step.action && !noted) {
			// Wiersz wskazany; po chwili (albo od razu po „Dalej") piesek biegnie do przycisku akcji.
			var goAction = function () {
				if (pendingTap !== goAction) return;
				pendingTap = null;
				if (run && target === node) rowAction(node, step);
			};
			pendingTap = goAction;
			return later(quietThen(goAction), reduced ? 100 : PACE.rowAction);
		}
		if (step.value && !noted) return fillStep(node, step);
		if (!step.click || noted) {
			if (!noted) autoFinish(step);
			return;
		}
		// Klient czyta dymek; po czasie czytania (albo od razu po „Dalej") piesek klika.
		var doTap = function () {
			if (pendingTap !== doTap) return;
			pendingTap = null;
			if (!run || target !== node) return;
			nextBtn.disabled = true;
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
			}, PACE.tap);
		};
		pendingTap = doTap;
		// Przy przycisku akcji klient już przeczytał dymek (przy wierszu) — krócej.
		// Klik dopiero, gdy Eforek skończy mówić.
		later(quietThen(doTap), step.quick ? (reduced ? 200 : PACE.tap * 3) : firstWait(step));
	}

	/**
	 * Ostatni krok z pieskiem: po przeczytaniu (czas zależny od długości tekstu)
	 * piesek sam wraca na miejsce — chyba że klient trzyma kursor na dymku.
	 */
	function autoFinish(step) {
		// Przy oknie potwierdzenia piesek czeka, aż klient je zamknie (reposition → stop).
		if (!dog || !dog.out || run.i !== run.steps.length - 1 || isDialogStep(step)) return;
		var wait = Math.max(PACE.finishMin, Math.min(PACE.finishMax, PACE.finishBase + step.text.length * PACE.finishPerChar));
		(function tick(ms) {
			later(function () {
				if (!run || run.steps[run.i] !== step) return;
				if (hovering || (A.speech && A.speech.speaking())) return tick(1500);
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
		// Nagrania wszystkich dymków przygotowane od razu — Eforek mówi bez czekania na syntezę.
		if (A.speech && A.speech.prefetch) A.speech.prefetch(steps.slice(i).map(function (st) { return st.text; }));
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
		pendingTap = null;
		spokenKey = null;
		// Zakończony ręcznie — cisza; zakończony sam — Eforek dokończy zdanie.
		if (!finished && A.speech) A.speech.stop();
		run = null;
		target = null;
		clearSaved();
		ensureHost(null); // z zamkniętego (albo jeszcze otwartego) okna potwierdzenia — z powrotem na stronę
		placeRing(null);
		callout.hidden = true;
		finger.classList.remove('ea-tour-tap');
		function done() {
			layer.hidden = true;
			callout.hidden = false;
			ensureHost(null);
			A.root.classList.remove('ea-touring');
		}
		if (dog && dog.out) return dogHome(done);
		done();
		if (finished && A.open) A.open();
	}

	nextBtn.addEventListener('click', function () {
		if (!run) return;
		if (A.speech) A.speech.stop();
		// Piesek czeka z kliknięciem, aż klient przeczyta — „Dalej" = klikaj już.
		if (pendingTap) return pendingTap();
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
		// Strona przeładowała się w trakcie okna potwierdzenia (klient potwierdził) — pokaz skończony.
		if (isDialogStep(steps[i0])) i0 = steps.length;
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
			// Pokaz skończył się kliknięciem na poprzedniej stronie: z palcem wraca okno czatu,
			// z pieskiem nie (siedzi na swoim miejscu). Maskotka ładuje się po tym pliku —
			// sprawdzamy ją dopiero po wczytaniu wszystkich skryptów.
			var reopen = function () { if (A.open && !(A.avatar && A.avatar.create)) A.open(); };
			if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reopen);
			else window.setTimeout(reopen, 0);
		}
	} else if (saved) {
		clearSaved();
	}
})();
