/**
 * Katalog elementów portalu, które asystent może wskazać (podświetlić).
 *
 * Model NIE dostaje selektorów CSS i nie może ich zwrócić: wybiera wyłącznie
 * KLUCZ z tej listy (enum w schemacie odpowiedzi, zawężony do elementów
 * widocznych na ekranie klienta), a przeglądarka zamienia klucz na selektor
 * z tej samej listy. Dzięki temu odpowiedź modelu nie może wskazać niczego
 * spoza katalogu.
 *
 * `selectors` — kolejne warianty tego samego elementu; widżet bierze pierwszy
 * WIDOCZNY (np. boczne menu na komputerze, dolny pasek na telefonie).
 * `labelKey` — klucz tłumaczenia etykiety (model dostaje ją w języku klienta).
 *
 * ⚠️ Dodając element, sprawdź selektor w szablonie i dopisz go do bazy
 * wiedzy (knowledge/*.md), inaczej model nie będzie wiedział, kiedy go użyć.
 */

'use strict';

const labels = require('./labels');

const CATALOG = [
	// ── nawigacja (każda strona) ──
	{ key: 'nav_new_order', selectors: ['#new-order-nav-btn'], labelKey: 'base.new_order', description: 'menu: utworzenie nowej oferty/zlecenia' },
	{ key: 'nav_offers', selectors: ['#orders-nav-btn', '.m-bottomnav [data-m-nav="offers"]'], labelKey: 'base.your_orders', description: 'menu: lista ofert (zleceń jeszcze niewysłanych)' },
	{ key: 'nav_history', selectors: ['#orders-history-nav-btn', '.m-bottomnav [data-m-nav="orders"]'], labelKey: 'base.orders_history', description: 'menu: historia wysłanych zleceń' },
	{ key: 'nav_employee_panel', selectors: ['#employee-panel-nav-btn'], labelKey: 'base.employee_panel', description: 'menu: panel pracowników' },
	{ key: 'nav_invoices', selectors: ['#invoices-nav-btn'], labelKey: null, description: 'menu: moduł „Faktury" (tylko gdy moduł jest włączony)' },
	{ key: 'tour_button', selectors: ['#intro-tour-header-btn'], labelKey: null, description: 'przycisk w nagłówku (ikona kompasu) uruchamiający przewodnik po stronie' },
	{ key: 'language_switcher', selectors: ['.language-switcher'], labelKey: null, description: 'wybór języka w nagłówku (flagi)' },
	{ key: 'footer_contact', selectors: ['.site-footer a[href="/contact"]'], labelKey: 'site.contact', description: 'stopka: dane kontaktowe' },

	// ── lista ofert / historia ──
	{ key: 'copy_order', selectors: ['.copy-order-btn'], labelKey: 'orders.copy_offer', description: 'przycisk kopiowania zlecenia w wierszu listy (kopia trafia do ofert)' },
	{ key: 'edit_order_name', selectors: ['#edit-order-btn'], labelKey: 'orders.edit_order_tooltip', description: 'przycisk edycji nazwy oferty w wierszu listy ofert' },
	{ key: 'delete_order', selectors: ['#delete-order-btn'], labelKey: 'orders.delete_order', description: 'przycisk usunięcia oferty w wierszu listy ofert' },

	// ── widok oferty ──
	{ key: 'add_position', selectors: ['#new-order-button'], labelKey: 'order.add_position_btn', description: 'dodanie nowej pozycji do oferty (otwiera konfigurator)' },
	{ key: 'send_order', selectors: ['#send-order'], labelKey: 'order.send_order_btn', description: 'wysłanie oferty do realizacji' },
	{ key: 'edit_order_header', selectors: ['#edit-order-button'], labelKey: 'edit_order.title', description: 'edycja danych i nazwy oferty (nagłówek, adres, komentarz)' },
	{ key: 'discount', selectors: ['#discount-btn'], labelKey: 'base.give_discount_tooltip', description: 'centrum rabatów oferty' },
	{ key: 'print_pdf', selectors: ['#print-button'], labelKey: 'base.generate_pdf_tooltip', description: 'pobranie oferty jako PDF' },
	{ key: 'print_short_pdf', selectors: ['#short-print-button'], labelKey: 'base.generate_short_pdf_tooltip', description: 'pobranie krótkiej wersji PDF' },
	{ key: 'export_excel', selectors: ['#generate-excel-btn'], labelKey: 'order.generate_excel_tooltip', description: 'pobranie oferty jako plik Excel' },
	{ key: 'duplicate_position', selectors: ['.duplicate-btn'], labelKey: 'order.duplicate', description: 'duplikowanie pozycji w wierszu tabeli pozycji' },
	{ key: 'edit_position', selectors: ['.edit-position-btn'], labelKey: 'order.edit_pos', description: 'edycja pozycji w wierszu tabeli pozycji' },
	{ key: 'delete_position', selectors: ['.delete-position-btn'], labelKey: 'order.delete_pos', description: 'usunięcie pozycji w wierszu tabeli pozycji' },

	// ── nowa oferta (nagłówek) ──
	{ key: 'commission_input', selectors: ['#commission-input'], labelKey: null, description: 'pole nazwy/komisji oferty w formularzu nowej oferty' },
	{ key: 'save_new_order', selectors: ['#save-order-btn'], labelKey: null, description: 'zapis nagłówka nowej oferty (dalej można dodawać pozycje)' },

	// ── konfigurator pozycji ──
	{ key: 'department_select', selectors: ['#department-select'], labelKey: null, description: 'konfigurator: wybór działu produktów' },
	{ key: 'product_group_select', selectors: ['#asortment-group-select'], labelKey: null, description: 'konfigurator: wybór grupy asortymentowej (produktu)' },
	{ key: 'save_position', selectors: ['#show-button'], labelKey: 'form.save_button', description: 'konfigurator: zapis pozycji' },
	{ key: 'reset_form', selectors: ['#reset-button'], labelKey: 'form.reset_button', description: 'konfigurator: wyczyszczenie wartości formularza' }
];

const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));

/** Mapa klucz → selektory dla przeglądarki (bez opisów dla modelu). */
function clientMap() {
	const out = {};
	for (const e of CATALOG) out[e.key] = e.selectors;
	return out;
}

/**
 * Elementy zgłoszone przez przeglądarkę jako widoczne → opisy dla modelu.
 * Klucze spoza katalogu są pomijane (przeglądarka nie dopisze nowych).
 */
function describeAvailable(keys, lang, deps = {}) {
	if (!Array.isArray(keys)) return [];
	const l = labels.normalizeLang(lang);
	const local = labels.loadLocale(l, deps);
	const out = [];
	for (const key of [...new Set(keys)].slice(0, CATALOG.length)) {
		const e = BY_KEY.get(key);
		if (!e) continue;
		out.push({ key: e.key, description: e.description, label: e.labelKey ? labels.lookup(local, e.labelKey) : null });
	}
	return out;
}

module.exports = { CATALOG, clientMap, describeAvailable };
