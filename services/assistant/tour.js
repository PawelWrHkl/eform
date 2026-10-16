/**
 * Pokaz krok po kroku („Eforek pokazuje palcem") — weryfikacja kroków od modelu.
 *
 * Model zwraca w odpowiedzi `tour`: [{ element, page, order, text, click }]. Tu
 * zostaje tylko to, co bezpieczne i dostępne dla konta:
 *   • element — klucz z katalogu (uiCatalog), dostępny dla konta,
 *   • page    — strona z pages.js dostępna dla konta (krok „przejdź tam"),
 *   • order   — ID zlecenia z wyników narzędzi: Eforek biegnie do jego wiersza
 *               na liście (ofert / wysłanych / anulowanych). Czy zlecenie należy
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

const MAX_STEPS = 8;
const MAX_TEXT = 220;

function sanitizeTour(raw, scope = {}) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const step of raw.slice(0, MAX_STEPS)) {
		if (!step || typeof step !== 'object') continue;
		const text = String(step.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
		// Krok „to zlecenie na liście" — listę i numer dopisze serwer po sprawdzeniu zakresu konta.
		if (Number.isInteger(step.order) && step.order > 0) {
			if (text) out.push({ element: null, page: null, order: step.order, text, click: false });
			continue;
		}
		const e = typeof step.element === 'string' ? uiCatalog.BY_KEY.get(step.element) : null;
		const element = e && uiCatalog.elementAllowed(e, scope) ? e : null;
		const page = typeof step.page === 'string' && pages.allowed(step.page, scope) ? step.page : null;
		if ((!element && !page) || !text) continue;
		out.push({ element: element ? element.key : null, page, text, click: !!(element && element.click && step.click === true) });
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
		required: ['element', 'page', 'order', 'text', 'click'],
		properties: {
			element: { anyOf: [{ type: 'string', enum: elementKeys }, { type: 'null' }] },
			page: { anyOf: [{ type: 'string', enum: pageKeys }, { type: 'null' }] },
			// ID zlecenia z wyników narzędzi (ref [[order:ID]]) — krok „to zlecenie na liście".
			order: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
			text: { type: 'string' },
			click: { type: 'boolean' }
		}
	};
}

module.exports = { sanitizeTour, stepSchema, MAX_STEPS };
