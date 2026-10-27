/**
 * Pokaz krok po kroku („Eforek pokazuje palcem") — weryfikacja kroków od modelu.
 *
 * Model zwraca w odpowiedzi `tour`: [{ element, page, order, text, click }]. Tu
 * zostaje tylko to, co bezpieczne i dostępne dla konta:
 *   • element — klucz z katalogu (uiCatalog), dostępny dla konta,
 *   • page    — strona z pages.js dostępna dla konta (krok „przejdź tam"),
 *   • order   — ID zlecenia z wyników narzędzi: Eforek biegnie do jego wiersza
 *               na liście (ofert / wysłanych / anulowanych); z click — klika wiersz
 *               i otwiera zlecenie; z `action` (send / copy / cancel / delete) —
 *               klika TEN przycisk w wierszu tego zlecenia, a portal otwiera okno
 *               potwierdzenia, które zatwierdza użytkownik. Czy akcja pasuje do
 *               statusu zlecenia i uprawnień konta, sprawdza tools.resolveOrderSteps. Czy zlecenie należy
 *               do konta i na której liście leży, sprawdza tools.resolveOrderSteps
 *               (czat) albo GET /assistant/order-place/:id (głos),
 *   • click   — WYŁĄCZNIE dla elementów z `click: true` w katalogu (przejścia,
 *               zakładki, otwarcie okna); nigdy zapis, wysyłka, usunięcie,
 *   • text    — jedno–dwa zdania objaśnienia.
 * Przeglądarka (public/scripts/assistant/tour.js) wykonuje kroki, korzystając
 * z danych katalogu w `assistantBoot.tour` — klucze spoza nich też odrzuca.
 */

'use strict';

const uiCatalog = require('./uiCatalog');
const pages = require('./pages');

const MAX_STEPS = 12;
const MAX_VALUE = 60;
/** Akcje w wierszu zlecenia na liście — każda tylko otwiera okno potwierdzenia portalu. */
const ORDER_ACTIONS = ['send', 'copy', 'cancel', 'delete'];
const MAX_TEXT = 220;

function sanitizeTour(raw, scope = {}) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const step of raw.slice(0, MAX_STEPS)) {
		if (!step || typeof step !== 'object') continue;
		const text = String(step.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
		// Krok „to zlecenie na liście" — listę i numer dopisze serwer po sprawdzeniu zakresu konta.
		if (Number.isInteger(step.order) && step.order > 0) {
			// click = Eforek klika wiersz i otwiera zlecenie (przejście, nic nie zmienia).
			const action = ORDER_ACTIONS.includes(step.action) ? step.action : null;
			if (text) out.push(action
				? { element: null, page: null, order: step.order, action, text, click: false }
				: { element: null, page: null, order: step.order, text, click: step.click === true });
			continue;
		}
		const e = typeof step.element === 'string' ? uiCatalog.BY_KEY.get(step.element) : null;
		const element = e && uiCatalog.elementAllowed(e, scope) ? e : null;
		const page = typeof step.page === 'string' && pages.allowed(step.page, scope) ? step.page : null;
		if ((!element && !page) || !text) continue;
		const st = { element: element ? element.key : null, page, text, click: !!(element && element.click && step.click === true) };
		// Wpisanie / wybór: tylko w polach z `fill` (nazwa zamówienia, dział, grupa produktu).
		const value = element && element.fill && typeof step.value === 'string' ? step.value.replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE) : '';
		if (value) { st.value = value; st.click = false; }
		out.push(st);
	}
	return out;
}

/** Schemat kroku pokazu (Structured Outputs / Realtime) — enumy zawężone do konta. */
function stepSchema(scope = {}) {
	const elementKeys = uiCatalog.CATALOG.filter((e) => uiCatalog.elementAllowed(e, scope)).map((e) => e.key);
	const pageKeys = pages.PAGES.filter((p) => pages.allowed(p.key, scope)).map((p) => p.key);
	return {
		type: 'object',
		additionalProperties: false,
		required: ['element', 'page', 'order', 'action', 'value', 'text', 'click'],
		properties: {
			element: { anyOf: [{ type: 'string', enum: elementKeys }, { type: 'null' }] },
			page: { anyOf: [{ type: 'string', enum: pageKeys }, { type: 'null' }] },
			// ID zlecenia z wyników narzędzi (ref [[order:ID]]) — krok „to zlecenie na liście".
			order: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
			// Akcja na tym zleceniu (przycisk w jego wierszu) — tylko z order; ostateczne potwierdzenie klika użytkownik.
			action: { anyOf: [{ type: 'string', enum: ORDER_ACTIONS }, { type: 'null' }] },
			// Co Eforek wpisuje / wybiera w polu z `fill` (np. nazwa „Mustermann”, dział „plisy”).
			value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			text: { type: 'string' },
			click: { type: 'boolean' }
		}
	};
}

module.exports = { sanitizeTour, stepSchema, MAX_STEPS, ORDER_ACTIONS };
