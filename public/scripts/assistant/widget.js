/**
 * Asystent eForm — widżet czatu w prawym dolnym rogu każdej strony.
 *
 * Dane startowe: `window.eformAssistantBoot` = { strings, catalog } z server.js
 * (partials/assistant-widget.njk). `catalog` to mapa klucz → selektory
 * elementów, które asystent może wskazać; serwer zwraca tylko KLUCZ, więc
 * odpowiedź modelu nie może podświetlić niczego spoza tej listy.
 *
 * Rozmowa żyje w sesji serwera (`GET /assistant/state`), a w sessionStorage
 * trzymamy tylko to, czy okno jest otwarte — dzięki temu po kliknięciu
 * wskazanego przycisku menu okno na nowej stronie otwiera się z tą samą
 * rozmową.
 *
 * `window.eformAssistant` (koniec pliku) to API dla modułów dokładanych do
 * okna: rozmowy głosowej (voice.js) i — w przyszłości — avatara, który
 * dostaje miejsce `.ea-avatar-slot` i zdarzenia `eform-assistant:voice`.
 */
(function () {
	'use strict';

	var boot = window.eformAssistantBoot;
	if (!boot || window.__eformAssistantLoaded) return;
	window.__eformAssistantLoaded = true;

	var S = boot.strings || {};
	var CATALOG = boot.catalog || {};
	var SUGGESTIONS = Array.isArray(boot.suggestions) ? boot.suggestions : [];
	var OPEN_KEY = 'eformAssistant.open';
	var HIGHLIGHT_MS = 8000;

	var state = { loaded: false, busy: false, messages: [], handoffSent: false, contactEmail: '' };
	var highlightTimer = null;
	var highlighted = null;

	// ── pamięć przeglądarki (może być niedostępna) ─────────────────────────
	function storeGet(key) {
		try { return window.sessionStorage.getItem(key); } catch (_) { return null; }
	}
	function storeSet(key, value) {
		try {
			if (value === null) window.sessionStorage.removeItem(key);
			else window.sessionStorage.setItem(key, value);
		} catch (_) { /* tryb prywatny itp. — okno po prostu się nie odtworzy */ }
	}

	/** Sygnał stanu czatu dla modułów okna (maskotka): open | close | thinking | answer. */
	function emit(stateName, extra) {
		try {
			var detail = { state: stateName };
			if (extra) Object.keys(extra).forEach(function (k) { detail[k] = extra[k]; });
			window.dispatchEvent(new CustomEvent('eform-assistant:state', { detail: detail }));
		} catch (_) { /* stare przeglądarki bez CustomEvent */ }
	}

	// ── budowa DOM ──────────────────────────────────────────────────────────
	function h(tag, attrs, children) {
		var el = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (k) {
				if (k === 'text') el.textContent = attrs[k];
				else if (k === 'html') el.innerHTML = attrs[k]; // wyłącznie stałe ikony SVG z tego pliku
				else el.setAttribute(k, attrs[k]);
			});
		}
		(children || []).forEach(function (c) { if (c) el.appendChild(c); });
		return el;
	}

	var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
	var ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
	var ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
	var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

	var root = h('div', { id: 'eform-assistant' });
	var launcher = h('button', { type: 'button', class: 'ea-launcher', 'aria-expanded': 'false', 'aria-controls': 'ea-panel' }, [
		h('span', { html: ICON_CHAT }).firstChild,
		h('span', { class: 'ea-launcher-text', text: S.open || 'Pomoc' })
	]);
	launcher.setAttribute('aria-label', S.title || 'Asystent eForm');

	var consultantBtn = h('button', { type: 'button', class: 'ea-icon-btn ea-consultant', title: S.consultantHint || '' }, [
		h('span', { html: ICON_USER }).firstChild,
		h('span', { class: 'ea-consultant-text', text: S.consultant || '' })
	]);
	consultantBtn.setAttribute('aria-label', S.consultantHint || S.consultant || '');
	var resetBtn = h('button', { type: 'button', class: 'ea-icon-btn ea-reset', title: S.reset || '', 'aria-label': S.reset || '', html: ICON_RESET });
	var closeBtn = h('button', { type: 'button', class: 'ea-icon-btn ea-close', title: S.close || '', 'aria-label': S.close || '', html: ICON_CLOSE });

	var messagesEl = h('div', { class: 'ea-messages', 'aria-live': 'polite' });
	var textarea = h('textarea', { rows: '1', maxlength: '1000', placeholder: S.placeholder || '', 'aria-label': S.placeholder || '' });
	var sendBtn = h('button', { type: 'submit', class: 'ea-btn', text: S.send || 'OK' });
	var form = h('form', { class: 'ea-input' }, [textarea, sendBtn]);

	var panel = h('section', { id: 'ea-panel', class: 'ea-panel', role: 'dialog', 'aria-label': S.title || '' }, [
		h('div', { class: 'ea-header' }, [
			h('div', { class: 'ea-header-text' }, [
				h('span', { class: 'ea-title', text: S.title || '' }),
				h('span', { class: 'ea-subtitle', text: S.subtitle || '' })
			]),
			consultantBtn,
			resetBtn,
			closeBtn
		]),
		// Miejsce na avatara (etap późniejszy) — ukryte, dopóki moduł avatara go nie zajmie.
		h('div', { class: 'ea-avatar-slot', hidden: 'hidden' }),
		messagesEl,
		form,
		h('p', { class: 'ea-disclaimer', text: S.disclaimer || '' })
	]);
	panel.hidden = true;

	root.appendChild(launcher);
	root.appendChild(panel);
	document.body.appendChild(root);
	if (document.querySelector('.mobile-pwd-fab')) root.classList.add('ea-stacked');

	// ── elementy strony ─────────────────────────────────────────────────────
	function isVisible(el) {
		if (!el || root.contains(el)) return false;
		var r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return false;
		var cs = window.getComputedStyle(el);
		return cs.visibility !== 'hidden' && cs.display !== 'none';
	}

	function findTarget(key) {
		var selectors = CATALOG[key] || [];
		for (var i = 0; i < selectors.length; i++) {
			var nodes;
			try { nodes = document.querySelectorAll(selectors[i]); } catch (_) { continue; }
			for (var j = 0; j < nodes.length; j++) if (isVisible(nodes[j])) return nodes[j];
		}
		return null;
	}

	function availableKeys() {
		return Object.keys(CATALOG).filter(function (k) { return !!findTarget(k); });
	}

	function textOf(el) {
		return (el.textContent || '').replace(/\s+/g, ' ').trim();
	}

	/** Kontekst ekranu dla asystenta — bez wartości pól (dane klienta zostają w przeglądarce). */
	function pageContext() {
		var heading = '';
		var hs = document.querySelectorAll('main h1, main h2, h1, h2');
		for (var i = 0; i < hs.length; i++) {
			if (isVisible(hs[i]) && textOf(hs[i])) { heading = textOf(hs[i]); break; }
		}
		var notices = [];
		var ns = document.querySelectorAll('.alert, [role="alert"], #toast-container .toast-message, .invalid-feedback');
		for (var k = 0; k < ns.length && notices.length < 3; k++) {
			var t = textOf(ns[k]);
			if (t && isVisible(ns[k]) && notices.indexOf(t) === -1) notices.push(t.slice(0, 200));
		}
		return {
			path: window.location.pathname,
			title: document.title.trim(),
			heading: heading.slice(0, 150),
			notices: notices,
			elements: availableKeys()
		};
	}

	// ── podświetlanie ───────────────────────────────────────────────────────
	function clearHighlight() {
		if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
		if (highlighted) { highlighted.classList.remove('ea-highlight'); highlighted = null; }
		root.classList.remove('ea-dock-left');
	}

	/** Wskazany element pod oknem asystenta (np. akcje przy prawej krawędzi tabeli) → okno na lewo. */
	function dodge(el) {
		if (panel.hidden || window.innerWidth < 768 || highlighted !== el) return;
		var a = el.getBoundingClientRect();
		var b = panel.getBoundingClientRect();
		var overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
		root.classList.toggle('ea-dock-left', overlap);
	}

	function highlight(key) {
		var el = findTarget(key);
		if (!el) return false;
		clearHighlight();
		// Na telefonie okno zasłania stronę — chowamy je, żeby wskazany element był widoczny.
		if (window.innerWidth < 768) setOpen(false);
		el.classList.add('ea-highlight');
		highlighted = el;
		try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { el.scrollIntoView(); }
		highlightTimer = setTimeout(clearHighlight, HIGHLIGHT_MS);
		el.addEventListener('click', clearHighlight, { once: true });
		// Po płynnym przewinięciu — dopiero wtedy wiadomo, gdzie element stoi.
		setTimeout(function () { dodge(el); }, 450);
		return true;
	}

	// ── komunikacja z serwerem ──────────────────────────────────────────────
	function api(method, url, body) {
		return fetch(url, {
			method: method,
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
			body: body ? JSON.stringify(body) : undefined
		}).then(function (res) {
			return res.json().catch(function () { return {}; }).then(function (data) {
				return { ok: res.ok, status: res.status, data: data || {} };
			});
		});
	}

	// ── renderowanie ────────────────────────────────────────────────────────
	function scrollDown() {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderMessage(m, isLast) {
		var voice = m.voice ? ' ea-msg-voice' : '';
		var text = m.text || '…'; // wypowiedź głosowa w trakcie transkrypcji
		if (m.role === 'user') {
			messagesEl.appendChild(h('div', { class: 'ea-msg ea-msg-user' + voice, text: text }));
			return;
		}
		var cls = 'ea-msg ea-msg-assistant' + voice + (m.status === 'handoff_sent' ? ' ea-msg-note' : '');
		var bubble = h('div', { class: cls });
		appendRichText(bubble, text, m.refs);
		if (m.tour && m.tour.length && window.eformAssistant && window.eformAssistant.tour) {
			var play = h('button', { type: 'button', class: 'ea-show-btn ea-tour-play', text: S.tourShow || '▶' });
			play.addEventListener('click', function () { window.eformAssistant.tour.start(m.tour); });
			bubble.appendChild(h('br'));
			bubble.appendChild(play);
		} else if (m.highlight && findTarget(m.highlight)) {
			var show = h('button', { type: 'button', class: 'ea-show-btn', text: S.show || '' });
			show.addEventListener('click', function () { highlight(m.highlight); });
			bubble.appendChild(h('br'));
			bubble.appendChild(show);
		}
		if (m.id && !m.voice && (m.status === 'answered' || m.status === 'handoff' || m.status === 'off_topic')) bubble.appendChild(feedbackBar(m));
		messagesEl.appendChild(bubble);
		if (isLast && m.status === 'handoff' && !state.handoffSent) {
			messagesEl.appendChild(handoffCard('model'));
		}
	}

	/** 👍/👎 pod odpowiedzią — ocena trafia do dziennika (luki w bazie wiedzy). */
	function feedbackBar(m) {
		var bar = h('div', { class: 'ea-feedback' });
		if (m.feedback) {
			bar.appendChild(h('span', { class: 'ea-feedback-thanks', text: S.feedbackThanks || '' }));
			return bar;
		}
		[['up', '👍', S.feedbackUp], ['down', '👎', S.feedbackDown]].forEach(function (v) {
			var b = h('button', { type: 'button', class: 'ea-feedback-btn', 'aria-label': v[2] || v[0], title: v[2] || v[0], text: v[1] });
			b.addEventListener('click', function () {
				m.feedback = v[0];
				bar.textContent = '';
				bar.appendChild(h('span', { class: 'ea-feedback-thanks', text: S.feedbackThanks || '' }));
				api('POST', '/assistant/feedback', { id: m.id, value: v[0] });
			});
			bar.appendChild(b);
		});
		return bar;
	}

	// ── odnośniki i akcje w odpowiedziach ([[page:…]], [[order:ID]], [[action:copy:ID]]) ──
	// Serwer (tools.resolveRefs) zostawia w tekście tylko sprawdzone znaczniki i podaje
	// do nich `refs` { znacznik: { type, href, label } }. Tekst trafia do DOM jako węzły
	// tekstowe — znacznik bez wpisu w refs po prostu znika.
	var TOKEN_RE = /\[\[(?:page|order|action|catalog):[a-z_0-9:]+\]\]/g;

	function appendRichText(el, text, refs) {
		var last = 0;
		var m;
		refs = refs || {};
		TOKEN_RE.lastIndex = 0;
		while ((m = TOKEN_RE.exec(text)) !== null) {
			if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
			var ref = refs[m[0]];
			if (ref) el.appendChild(ref.type === 'copy' ? copyButton(ref) : linkFor(ref));
			last = m.index + m[0].length;
		}
		if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
	}

	function linkFor(ref) {
		// Adresy tylko względne, z portalu (serwer ich pilnuje; tu druga linia obrony).
		var href = String(ref.href || '');
		if (href.charAt(0) !== '/' || href.charAt(1) === '/') return document.createTextNode(ref.label || '');
		if (ref.type === 'file') return h('a', { class: 'ea-link ea-link-file', href: href, download: '', text: ref.label || href });
		return h('a', { class: 'ea-link', href: href, text: ref.label || href });
	}

	/** Przycisk akcji kopiowania: 1. klik = pytanie o potwierdzenie, 2. klik = kopia (POST /orders/copy/:id). */
	function copyButton(ref) {
		var btn = h('button', { type: 'button', class: 'ea-action', text: (S.copyAction || '').replace('{number}', ref.number) });
		var armed = false;
		var timer = null;
		btn.addEventListener('click', function () {
			if (!armed) {
				armed = true;
				btn.textContent = S.copyConfirm || '';
				btn.classList.add('ea-action-armed');
				timer = setTimeout(function () {
					armed = false;
					btn.textContent = (S.copyAction || '').replace('{number}', ref.number);
					btn.classList.remove('ea-action-armed');
				}, 6000);
				return;
			}
			clearTimeout(timer);
			btn.disabled = true;
			btn.textContent = S.copyWorking || '…';
			api('POST', '/orders/copy/' + encodeURIComponent(ref.orderId)).then(function (r) {
				var redirect = r.data && r.data.redirect;
				if (r.ok && redirect && redirect.charAt(0) === '/' && redirect.charAt(1) !== '/') {
					btn.textContent = S.copyDone || '';
					window.location.href = redirect;
				} else {
					btn.disabled = false;
					armed = false;
					btn.textContent = (r.data && r.data.message) || S.networkError || '';
				}
			}).catch(function () {
				btn.disabled = false;
				armed = false;
				btn.textContent = S.networkError || '';
			});
		});
		return btn;
	}

	/** Proponowane pytania (server.js → i18n/suggestions.json) — klik = wysłanie pytania. */
	function suggestionsBox() {
		var box = h('div', { class: 'ea-suggestions', role: 'group', 'aria-label': S.suggestionsTitle || '' }, [
			h('p', { class: 'ea-suggestions-title', text: S.suggestionsTitle || '' })
		]);
		SUGGESTIONS.forEach(function (q) {
			var chip = h('button', { type: 'button', class: 'ea-chip', text: q });
			chip.addEventListener('click', function () { ask(q); });
			box.appendChild(chip);
		});
		return box;
	}

	function render() {
		messagesEl.textContent = '';
		if (!state.messages.length) {
			messagesEl.appendChild(h('div', { class: 'ea-msg ea-msg-assistant', text: S.greeting || '' }));
			if (SUGGESTIONS.length && !state.busy) messagesEl.appendChild(suggestionsBox());
		}
		state.messages.forEach(function (m, i) { renderMessage(m, i === state.messages.length - 1); });
		if (state.busy) messagesEl.appendChild(h('div', { class: 'ea-msg ea-msg-assistant ea-msg-thinking', text: S.thinking || '…' }));
		scrollDown();
	}

	/** Formularz przekazania do konsultanta. `trigger`: 'button' (klient sam) albo 'model'. */
	function handoffCard(trigger) {
		var email = h('input', { type: 'email', maxlength: '200', autocomplete: 'email', id: 'ea-handoff-email' });
		email.value = state.contactEmail || '';
		var phone = h('input', { type: 'tel', maxlength: '50', autocomplete: 'tel', id: 'ea-handoff-phone' });
		var note = h('textarea', { maxlength: '2000', id: 'ea-handoff-note' });
		var submit = h('button', { type: 'submit', class: 'ea-btn', text: S.submit || '' });
		var cancel = h('button', { type: 'button', class: 'ea-btn ea-btn-secondary', text: S.cancel || '' });
		var error = h('div', { class: 'ea-handoff-error', role: 'alert' });
		error.hidden = true;

		var card = h('form', { class: 'ea-handoff' }, [
			h('h3', { text: S.handoffTitle || '' }),
			h('p', { text: S.handoffIntro || '' }),
			h('label', { for: 'ea-handoff-email', text: S.emailLabel || '' }), email,
			h('label', { for: 'ea-handoff-phone', text: S.phoneLabel || '' }), phone,
			h('label', { for: 'ea-handoff-note', text: S.noteLabel || '' }), note,
			error,
			h('div', { class: 'ea-handoff-actions' }, [submit, cancel])
		]);

		cancel.addEventListener('click', function () { card.remove(); textarea.focus(); });
		card.addEventListener('submit', function (ev) {
			ev.preventDefault();
			submit.disabled = true;
			error.hidden = true;
			api('POST', '/assistant/handoff', {
				email: email.value.trim(),
				phone: phone.value.trim(),
				note: note.value.trim(),
				trigger: trigger,
				page: { path: window.location.pathname }
			}).then(function (r) {
				if (r.ok && r.data.success) {
					state.handoffSent = true;
					state.messages.push({ role: 'assistant', text: r.data.message, status: 'handoff_sent' });
					render();
					emit('answer', { status: 'handoff_sent', length: (r.data.message || '').length });
					return;
				}
				submit.disabled = false;
				error.textContent = r.data.message || S.handoffFailed || '';
				if (r.data.contact) {
					error.appendChild(document.createTextNode(' '));
					error.appendChild(h('a', { href: '/contact', text: S.contactLink || '' }));
				}
				error.hidden = false;
			}).catch(function () {
				submit.disabled = false;
				error.textContent = S.networkError || '';
				error.hidden = false;
			});
		});
		setTimeout(function () { (email.value ? note : email).focus(); }, 0);
		return card;
	}

	/** `trigger`: 'button' — klient sam (nagłówek okna), 'model' — zaproponował asystent (np. głosowy). */
	function openConsultantForm(trigger) {
		setOpen(true);
		ensureLoaded().then(function () {
			var existing = messagesEl.querySelector('.ea-handoff');
			if (existing) existing.remove();
			// Ponowne przekazanie tej samej rozmowy jest dozwolone (serwer pilnuje odstępu).
			messagesEl.appendChild(handoffCard(trigger === 'model' ? 'model' : 'button'));
			scrollDown();
		});
	}

	function ask(question) {
		if (state.busy) return;
		state.busy = true;
		sendBtn.disabled = true;
		// Najpierw stan z serwera — inaczej jego późniejsze wczytanie nadpisałoby to pytanie.
		ensureLoaded().then(function () {
			state.messages.push({ role: 'user', text: question });
			render();
			emit('thinking');
			return api('POST', '/assistant/ask', { question: question, page: pageContext() });
		}).then(function (r) {
			state.busy = false;
			sendBtn.disabled = false;
			if (r.status === 401) { window.location.reload(); return; }
			var d = r.data;
			if (!d.answer) {
				state.messages.push({ role: 'assistant', text: S.networkError || '', status: 'error' });
			} else {
				state.messages.push({ role: 'assistant', text: d.answer, status: d.status, highlight: d.highlight || null, refs: d.refs || null, tour: d.tour || null, id: d.messageId || null });
				if (d.status === 'handoff') state.handoffSent = false;
			}
			render();
			emit('answer', { status: d.answer ? d.status : 'error', length: (d.answer || '').length });
			// Pokaz krok po kroku startuje sam (klient o niego prosił) — po chwili na przeczytanie zapowiedzi.
			if (d.tour && d.tour.length && window.eformAssistant && window.eformAssistant.tour) {
				setTimeout(function () { window.eformAssistant.tour.start(d.tour); }, 1200);
			}
			if (d.highlight && window.innerWidth >= 768) highlight(d.highlight);
		}).catch(function () {
			state.busy = false;
			sendBtn.disabled = false;
			state.messages.push({ role: 'assistant', text: S.networkError || '', status: 'error' });
			render();
			emit('answer', { status: 'error', length: 0 });
		});
	}

	var loading = null;
	function ensureLoaded() {
		if (loading) return loading;
		loading = api('GET', '/assistant/state').then(function (r) {
			if (r.ok && r.data.success) {
				state.messages = r.data.messages || [];
				state.handoffSent = !!r.data.handoffSent;
				state.contactEmail = r.data.contactEmail || '';
			}
			state.loaded = true;
			render();
		}).catch(function () {
			state.loaded = true;
			render();
		});
		return loading;
	}

	function setOpen(open) {
		panel.hidden = !open;
		root.classList.toggle('ea-open', open);
		launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
		storeSet(OPEN_KEY, open ? '1' : null);
		emit(open ? 'open' : 'close');
		if (open) {
			ensureLoaded();
			setTimeout(function () { textarea.focus(); }, 0);
		}
	}

	// ── zdarzenia ───────────────────────────────────────────────────────────
	launcher.addEventListener('click', function () { setOpen(true); });
	closeBtn.addEventListener('click', function () { setOpen(false); launcher.focus(); });
	consultantBtn.addEventListener('click', function () { openConsultantForm('button'); });
	resetBtn.addEventListener('click', function () {
		api('POST', '/assistant/reset').finally(function () {
			state.messages = [];
			state.handoffSent = false;
			render();
			textarea.focus();
		});
	});

	form.addEventListener('submit', function (ev) {
		ev.preventDefault();
		var q = textarea.value.trim();
		if (!q || state.busy) return;
		textarea.value = '';
		textarea.style.height = '';
		ask(q);
	});

	textarea.addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
			ev.preventDefault();
			form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
		}
	});
	textarea.addEventListener('input', function () {
		textarea.style.height = 'auto';
		textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
	});

	panel.addEventListener('keydown', function (ev) {
		if (ev.key === 'Escape') { setOpen(false); launcher.focus(); }
	});

	if (storeGet(OPEN_KEY) === '1') setOpen(true);

	// ── API dla modułów okna (voice.js, w przyszłości avatar) ───────────────
	var renderQueued = false;
	function scheduleRender() {
		if (renderQueued) return;
		renderQueued = true;
		window.requestAnimationFrame(function () { renderQueued = false; render(); });
	}

	window.eformAssistant = {
		strings: S,
		voiceEnabled: !!boot.voice,
		root: root,
		panel: panel,
		form: form,
		sendBtn: sendBtn,
		api: api,
		ensureLoaded: ensureLoaded,
		open: function () { setOpen(true); },
		close: function () { setOpen(false); },
		isOpen: function () { return !panel.hidden; },
		/** Dodaje wypowiedź (obiekt jest żywy: zmiana `text` + refresh() aktualizuje dymek). */
		addMessage: function (m) { state.messages.push(m); scheduleRender(); return m; },
		removeMessage: function (m) {
			var i = state.messages.indexOf(m);
			if (i >= 0) state.messages.splice(i, 1);
			scheduleRender();
		},
		refresh: scheduleRender,
		highlight: highlight,
		openConsultantForm: openConsultantForm,
		pageContext: pageContext
	};
})();
