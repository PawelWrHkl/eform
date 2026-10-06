/**
 * Asystent eForm — pokaz krok po kroku: Eforek prowadzi palcem po portalu.
 *
 * Kroki przychodzą z odpowiedzi czatu (`tour`, zweryfikowane na serwerze —
 * services/assistant/tour.js) albo z narzędzia głosowego `start_tour`.
 * Każdy krok: { element, page, text, click }.
 *   • element — klucz z katalogu (selektory w `assistantBoot.catalog`, ekrany
 *               i flaga kliknięcia w `assistantBoot.tour`),
 *   • page    — strona (adres w `assistantBoot.pages`), gdy krok to przejście,
 *   • click   — Eforek sam klika element (tylko elementy z flagą `c` — przejścia,
 *               zakładki, otwarcie okna; serwer i ten plik odrzucają resztę).
 * Gdy element jest na innym ekranie, pokaz przechodzi tam i kontynuuje po
 * wczytaniu strony (stan w sessionStorage, ważny 10 min).
 *
 * Palec, przyciemnienie i dymek leżą w warstwie `.ea-tour` z
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
	var reduced = false;
	try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { reduced = false; }

	var run = null;      // { steps, i }
	var target = null;   // bieżący wskazany element
	var timers = [];
	// Przeglądarka już opuszcza stronę (klik w link) — nie ruszamy następnego kroku,
	// bo poprowadziłby gdzie indziej, zanim wczyta się strona docelowa.
	var leavingAt = 0;
	window.addEventListener('beforeunload', function () { leavingAt = Date.now(); });
	window.addEventListener('pageshow', function () { leavingAt = 0; });

	// ── warstwa: przyciemnienie z obramowaniem, palec, dymek ────────────────
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
			var key = typeof s.element === 'string' && META.elements[s.element] && CATALOG[s.element] ? s.element : null;
			var page = typeof s.page === 'string' && PAGES[s.page] ? s.page : null;
			var t = String(s.text || '').trim().slice(0, 220);
			if ((!key && !page) || !t) return;
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

	/** Element bywa dokładany skryptem strony — czekamy chwilę. */
	function waitFor(key, ms, cb) {
		var started = Date.now();
		(function poll() {
			var found = findVisible(key);
			if (found || Date.now() - started > ms) return cb(found);
			later(poll, 150);
		})();
	}

	// ── rysowanie ───────────────────────────────────────────────────────────
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

	function placeCallout(rect) {
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
			left = Math.min(Math.max(12, rect.left + rect.width / 2 - w / 2), vw - w - 12);
			var below = rect.bottom + 18;
			var above = rect.top - h - 18;
			top = below + h < vh - 12 ? below : (above > 12 ? above : Math.max(12, vh - h - 12));
		}
		callout.style.left = Math.round(left) + 'px';
		callout.style.top = Math.round(Math.max(12, top)) + 'px';
	}

	function tipPoint(rect) {
		return { x: rect.left + Math.min(rect.width * 0.5, 40), y: rect.top + rect.height * 0.62 };
	}

	function reposition() {
		if (!run || !target) return;
		if (!document.body.contains(target) || !isVisible(target)) {
			// Strona przerysowała listę (np. wiersze dociągane skryptem) — szukamy elementu na nowo.
			var step = run.steps[run.i];
			var again = step && step.element ? findVisible(step.element) : null;
			if (!again) return;
			target = again;
			try { again.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { again.scrollIntoView(); }
		}
		var rect = target.getBoundingClientRect();
		placeRing(rect);
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
		layer.hidden = false;
		A.root.classList.add('ea-touring');
		if (A.avatar && A.avatar.set) A.avatar.set('talking', Math.min(4000, 900 + step.text.length * 30));
	}

	// ── przebieg ────────────────────────────────────────────────────────────
	function showStep() {
		clearTimers();
		target = null;
		if (!run) return;
		noteScreen();
		var step = run.steps[run.i];
		if (!step) return stop(true);

		// Krok „przejdź na stronę"
		if (!step.element) {
			var href = PAGES[step.page];
			if (href && !samePage(href)) {
				run.i += 1;
				save();
				window.location.href = href;
				return;
			}
			placeRing(null);
			finger.hidden = true;
			showCallout(step);
			placeCallout(null);
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
			placeRing(null);
			finger.hidden = true;
			showCallout(step, S.tourOtherScreen);
			placeCallout(null);
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
				placeRing(null);
				finger.hidden = true;
				// Element pojawia się dopiero po działaniu klienta (np. formularz po wyborze
				// działu i grupy) — mówimy, co zrobić, i czekamy; gdy się pokaże, palec tam idzie.
				showCallout(step, meta.w === 'choice' ? S.tourAfterChoice : S.tourMissing);
				placeCallout(null);
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

	function point(node, step, note) {
		target = node;
		finger.hidden = false;
		try { node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (_) { node.scrollIntoView(); }
		layer.hidden = false;
		showCallout(step, note);
		later(function () {
			if (!run || target !== node) return;
			var rect = node.getBoundingClientRect();
			placeRing(rect);
			placeCallout(rect);
			var p = tipPoint(rect);
			moveFinger(p.x, p.y, false);
			if (!step.click || note) return;
			// Klik Eforka: palec dojeżdża, „stuknięcie", potem kliknięcie elementu.
			nextBtn.disabled = true;
			later(function () {
				if (!run || target !== node) return;
				finger.classList.remove('ea-tour-tap');
				void finger.offsetWidth; // restart animacji
				finger.classList.add('ea-tour-tap');
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
			}, reduced ? 200 : 950);
		}, reduced ? 50 : 420);
	}

	/** Po kliknięciu Eforka: strona się zmienia → czekamy (dokończy wznowienie); inaczej następny krok. */
	function afterClick() {
		if (!run) return;
		// Link do pliku (np. PDF) też zaczyna „opuszczanie", ale strona zostaje — po 4 s idziemy dalej.
		if (leavingAt && Date.now() - leavingAt < 4000) return later(afterClick, 300);
		leavingAt = 0;
		showStep();
	}

	function start(steps) {
		var clean = normalize(steps);
		if (!clean.length) return false;
		run = { steps: clean, i: 0 };
		if (A.close) A.close();
		var s = fingerStart();
		finger.hidden = false;
		moveFinger(s.x, s.y, true);
		if (A.avatar && A.avatar.set) A.avatar.set('wave', 1400);
		later(showStep, reduced ? 0 : 250);
		return true;
	}

	function stop(finished) {
		clearTimers();
		run = null;
		target = null;
		clearSaved();
		layer.hidden = true;
		A.root.classList.remove('ea-touring');
		finger.classList.remove('ea-tour-tap');
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
			run = { steps: steps, i: i0, seen: Array.isArray(saved.seen) ? saved.seen.filter(function (k) { return !!META.screens[k]; }) : [] };
			if (A.close) A.close();
			var s0 = fingerStart();
			moveFinger(s0.x, s0.y, true);
			later(showStep, 350); // skrypty strony zdążą dołożyć elementy
		} else {
			clearSaved();
			if (A.open) A.open(); // pokaz skończył się kliknięciem na poprzedniej stronie
		}
	} else if (saved) {
		clearSaved();
	}
})();
