/**
 * Katalog elementów portalu, które Eforek może wskazać (podświetlić, pokazać
 * palcem w pokazie krok po kroku) — i nieliczne, które może sam kliknąć.
 *
 * Model NIE dostaje selektorów CSS i nie może ich zwrócić: wybiera wyłącznie
 * KLUCZ z tej listy (enum w schemacie odpowiedzi), a przeglądarka zamienia
 * klucz na selektor z tej samej listy. Odpowiedź modelu nie może więc wskazać
 * ani kliknąć niczego spoza katalogu.
 *
 * Pola wpisu:
 *   selectors — warianty tego samego elementu; przeglądarka bierze pierwszy WIDOCZNY
 *               (np. boczne menu na komputerze, dolny pasek na telefonie),
 *   labelKey  — klucz tłumaczenia etykiety (model dostaje ją w języku klienta),
 *   screens   — ekrany, na których element jest (SCREENS; 'any' = każdy ekran),
 *   click     — Eforek może go kliknąć w pokazie. WYŁĄCZNIE przejścia, zakładki,
 *               rozwinięcia i otwarcie okna — nic, co zapisuje, wysyła, usuwa
 *               albo pobiera plik,
 *   navTo     — strona (pages.js), na którą prowadzi element menu; gdy go nie
 *               widać (np. menu schowane na telefonie), pokaz przechodzi wprost,
 *   js        — element tworzy skrypt (test szuka selektora w public/scripts),
 *   when      — warunek konta (zakres z tools.scopeFromRequest), np. tylko z prawem wysyłki,
 *   appears   — 'choice': element pojawia się dopiero po wyborze działu i grupy
 *               (pokaz mówi, co zrobić, i czeka na niego),
 *   empty     — selektory „pustego stanu" listy (np. brak katalogów) — pokaz wskazuje
 *               je, gdy samego elementu nie ma.
 *
 * ⚠️ Dodając element, sprawdź selektor w szablonie (test building-blocks to
 * pilnuje) i opisz go w bazie wiedzy (knowledge/*.md).
 */

'use strict';

const labels = require('./labels');
const pages = require('./pages');

/**
 * Ekrany: `page` = strona z pages.js (wtedy pokaz umie tam przejść i ekran
 * jest dostępny tylko dla kont, które tę stronę mają), `path`/`query` —
 * rozpoznanie w przeglądarce. Ekrany bez `page` (widok oferty, konfigurator…)
 * są osiągalne tylko krokami pokazu (np. klik w wiersz oferty).
 */
/** Pracownik bez uprawnienia „Wysyłanie zamówień" nie ma przycisku wysyłki (templates/order.njk). */
function canSendOrders(s) {
	if (!s.isEmployee) return true;
	const p = s.cancelCtx && s.cancelCtx.employeePermissions;
	return !!(p && p.can_send_orders);
}

const SCREENS = {
	any: { label: 'każdy ekran (menu, nagłówek, stopka)' },
	home: { page: 'home', path: '^/$', label: 'strona główna' },
	new_order: { page: 'new_order', path: '^/orders/add-order', label: 'nowa oferta' },
	offers: { page: 'offers', path: '^/orders/?$', label: 'lista ofert' },
	history: { page: 'history', path: '^/orders/history/?$', label: 'wysłane zlecenia' },
	canceled: { page: 'canceled', path: '^/orders/canceled', label: 'zlecenia anulowane' },
	sent_view: { path: '^/orders/history/order/\\d+', label: 'podgląd wysłanego zlecenia' },
	order_view: { path: '^/orders/order/\\d+/?$', label: 'widok oferty' },
	order_edit: { path: '^/orders/edit/\\d+', label: 'edycja nagłówka oferty' },
	configurator: { path: '^/orders/order/\\d+/new-position|^/position/\\d+/edit', label: 'konfigurator pozycji' },
	account: { page: 'account', path: '^/panel/?$', label: 'panel użytkownika' },
	password: { page: 'password', path: '^/panel/?$', query: 'tab=password', label: 'panel: zmiana hasła' },
	catalogs: { page: 'catalogs', path: '^/panel/?$', query: 'tab=catalogs', label: 'panel: katalogi' },
	employees: { page: 'employees', path: '^/user/employee-panel', label: 'panel pracowników' },
	add_employee: { page: 'add_employee', path: '^/user/employee/add', label: 'formularz nowego pracownika' },
	group_panel: { page: 'group_panel', path: '^/group/panel', label: 'panel grupy' }
};

const CATALOG = [
	// ── nawigacja, nagłówek, stopka (każdy ekran) ──
	{ key: 'nav_new_order', selectors: ['#new-order-nav-btn'], labelKey: 'base.new_order', description: 'menu: utworzenie nowej oferty', screens: ['any'], click: true, navTo: 'new_order' },
	{ key: 'nav_offers', selectors: ['#orders-nav-btn', '.m-bottomnav [data-m-nav="offers"]'], labelKey: 'base.your_orders', description: 'menu: lista ofert (niewysłanych)', screens: ['any'], click: true, navTo: 'offers' },
	{ key: 'nav_history', selectors: ['#orders-history-nav-btn', '.m-bottomnav [data-m-nav="orders"]'], labelKey: 'base.orders_history', description: 'menu: wysłane zlecenia', screens: ['any'], click: true, navTo: 'history' },
	{ key: 'nav_employee_panel', selectors: ['#employee-panel-nav-btn'], labelKey: 'base.employee_panel', description: 'menu: panel pracowników', screens: ['any'], click: true, navTo: 'employees' },
	{ key: 'nav_invoices', selectors: ['#invoices-nav-btn'], labelKey: null, description: 'menu: moduł „Faktury" (tylko gdy moduł jest włączony)', screens: ['any'], click: true, navTo: 'invoices' },
	{ key: 'user_panel_btn', selectors: ['#user-panel-header-btn'], labelKey: 'panel.nav_link', description: 'nagłówek: panel użytkownika (dane konta, hasło, katalogi)', screens: ['any'], click: true, navTo: 'account' },
	{ key: 'mobile_menu', selectors: ['.navbar-toggler'], labelKey: null, description: 'telefon: przycisk menu (trzy kreski)', screens: ['any'], click: true },
	{ key: 'tour_button', selectors: ['#intro-tour-header-btn'], labelKey: null, description: 'nagłówek: ikona kompasu — przewodnik po stronie', screens: ['any'], js: true },
	{ key: 'language_switcher', selectors: ['.language-switcher'], labelKey: null, description: 'nagłówek: wybór języka (flagi)', screens: ['any'] },
	{ key: 'theme_toggle', selectors: ['#theme-toggle'], labelKey: null, description: 'nagłówek: tryb jasny/ciemny (księżyc/słońce)', screens: ['any'], js: true },
	{ key: 'ui_variant_toggle', selectors: ['#ui-variant-toggle'], labelKey: null, description: 'nagłówek: „Zmień wygląd" (klasyczny/nowy)', screens: ['any'] },
	{ key: 'logout_btn', selectors: ['#logout-nav-btn'], labelKey: 'base.logout', description: 'menu: wylogowanie', screens: ['any'] },
	{ key: 'footer_contact', selectors: ['.site-footer a[href="/contact"]'], labelKey: 'site.contact', description: 'stopka: dane kontaktowe', screens: ['any'], click: true, navTo: 'contact' },

	// ── strona główna ──
	{ key: 'home_recent_toggle', selectors: ['#orders-toggle'], labelKey: 'base.show_orders', description: 'strona główna: rozwinięcie ostatnich ofert i zamówień', screens: ['home'], click: true },

	// ── nowa oferta (nagłówek zamówienia) ──
	{ key: 'commission_input', selectors: ['#commission-input'], labelKey: 'new-order.order_name', description: 'pole nazwy zamówienia (obowiązkowe)', screens: ['new_order', 'order_edit'] },
	{ key: 'address_checkbox', selectors: ['#address-checkbox-container', '#show-addresses-checkbox'], labelKey: 'new-order.chcekbox_address_label', description: 'wybór adresu dostawy z listy', screens: ['new_order', 'order_edit'] },
	{ key: 'add_address_btn', selectors: ['#add-delivery-address-btn'], labelKey: 'order.create_address', description: 'otwiera okno nowego adresu dostawy', screens: ['new_order', 'order_edit'], click: true },
	{ key: 'send_address_checkbox', selectors: ['#send-address-checkbox-container', '#show-send-address-checkbox'], labelKey: 'new-order.send_chcekbox_address_label', description: 'jednorazowy adres wysyłki', screens: ['new_order', 'order_edit'] },
	{ key: 'comment_input', selectors: ['#comment'], labelKey: 'new-order.comments', description: 'uwagi do zamówienia', screens: ['new_order', 'order_edit'] },
	{ key: 'save_new_order', selectors: ['#save-order-btn'], labelKey: 'new-order.save_button', description: 'zapis nagłówka nowej oferty (klika użytkownik)', screens: ['new_order'] },

	// ── listy: oferty / wysłane / anulowane ──
	{ key: 'offer_row', selectors: ['.order-row'], labelKey: null, description: 'wiersz oferty na liście — otwiera ofertę', screens: ['offers'], click: true },
	{ key: 'sent_row', selectors: ['.order-row'], labelKey: null, description: 'wiersz wysłanego zlecenia — otwiera podgląd (pozycje, statusy, anulowanie, PDF). „Zamów ponownie" i numery przesyłek są w WIERSZU listy, w podglądzie ich nie ma', screens: ['history', 'canceled'], click: true, empty: ['.orders-canceled-empty'] },
	{ key: 'copy_order', selectors: ['.copy-order-btn'], labelKey: 'orders.copy_offer', description: 'przycisk kopiowania w wierszu LISTY („Kopiuj ofertę" na ofertach, „Zamów ponownie" na wysłanych) — nie ma go w podglądzie zlecenia', screens: ['history', 'offers', 'canceled'] },
	{ key: 'edit_order_name', selectors: ['#edit-order-btn'], labelKey: 'orders.edit_order_tooltip', description: 'ołówek w wierszu oferty — edycja nagłówka', screens: ['offers'] },
	{ key: 'delete_order', selectors: ['#delete-order-btn'], labelKey: 'orders.delete_order', description: 'kosz w wierszu oferty — usunięcie oferty', screens: ['offers'] },
	{ key: 'send_order_list', selectors: ['.send-order-btn'], labelKey: 'orders.send_order_tooltip', description: 'wysyłka oferty z listy', screens: ['offers'] },
	{ key: 'orders_search', selectors: ['#orders-search-mount'], labelKey: 'orders.search', description: 'wyszukiwarka zleceń (nazwa, numer)', screens: ['offers', 'history'] },
	{ key: 'delivery_btn', selectors: ['#delivery-btn'], labelKey: 'termin.delivery_time', description: 'ikona ciężarówki — czasy dostawy', screens: ['offers', 'history'], click: true, navTo: 'delivery_time' },
	{ key: 'import_log_btn', selectors: ['a[href="/orders/import-log"]'], labelKey: null, description: 'ikona „Moje Importy" — log automatycznych importów', screens: ['offers'], click: true, navTo: 'import_log' },
	{ key: 'cancel_order_btn', selectors: ['.cancel-order-btn'], labelKey: 'cancel_order.button_short', description: 'anulowanie wysłanego zlecenia (do 24 h)', screens: ['history', 'sent_view'] },
	{ key: 'tracking_btn', selectors: ['[id^="trackingDropdown"]'], labelKey: 'orders.tracking_numbers', description: 'liczba przesyłek w kolumnie „Śledzenie paczek" w wierszu listy wysłanych (rozwija numery; „-" = brak przesyłek)', screens: ['history'], click: true, empty: ['th[data-col="tracking"]'] },
	{ key: 'filter_status', selectors: ['#filter-prod-status'], labelKey: 'orders.status', description: 'filtr statusu produkcji', screens: ['history'] },
	{ key: 'filter_sent_from', selectors: ['#filter-sent-from'], labelKey: 'orders.sent_date_from', description: 'filtr daty wysłania (od)', screens: ['history'] },

	// ── widok oferty ──
	{ key: 'add_position', selectors: ['#new-order-button'], labelKey: 'order.add_position_btn', description: 'dodanie pozycji — otwiera konfigurator', screens: ['order_view'], click: true },
	{ key: 'edit_order_header', selectors: ['#edit-order-button'], labelKey: 'edit_order.title', description: 'edycja danych i nazwy oferty', screens: ['order_view'], click: true },
	{ key: 'discount', selectors: ['#discount-btn'], labelKey: 'base.give_discount_tooltip', description: 'centrum rabatów (otwiera okno rabatu)', screens: ['order_view'], click: true },
	{ key: 'link_manager', selectors: ['.open-link-manager-btn'], labelKey: 'order.link_manager_title', description: 'łączenie pozycji (otwiera okno)', screens: ['order_view'], click: true },
	{ key: 'unlock_prices', selectors: ['#unlockBtn'], labelKey: 'order.unlock', description: 'kłódka cen ukrytych (otwiera okno hasła)', screens: ['order_view'], click: true },
	{ key: 'print_pdf', selectors: ['#print-button'], labelKey: 'base.generate_pdf_tooltip', description: 'pobranie PDF', screens: ['order_view', 'sent_view'] },
	{ key: 'print_short_pdf', selectors: ['#short-print-button'], labelKey: 'base.generate_short_pdf_tooltip', description: 'pobranie krótkiego PDF', screens: ['order_view', 'sent_view'] },
	{ key: 'export_excel', selectors: ['#generate-excel-btn'], labelKey: 'order.generate_excel_tooltip', description: 'pobranie Excela', screens: ['order_view', 'sent_view'] },
	{ key: 'send_order', selectors: ['#send-order'], labelKey: 'order.send_order_btn', description: 'wysłanie oferty do realizacji (klika użytkownik)', screens: ['order_view'], when: canSendOrders },
	{ key: 'submit_for_approval', selectors: ['#submit-for-approval-btn'], labelKey: 'group.submit_for_approval_title', description: 'wysłanie do zatwierdzenia przez centralę (konto sklepu)', screens: ['order_view'], when: (s) => s.isGroupShop },
	{ key: 'group_approve_btn', selectors: ['.gp-pane[data-pane="pending"] .js-approve-btn', '#group-approve-btn'], labelKey: 'group.approve_btn', description: 'zatwierdzenie i wysyłka zamówienia sklepu do realizacji (klika użytkownik)', screens: ['group_panel', 'order_view'], when: (s) => s.isGroup, empty: ['.gp-pane[data-pane="pending"] .gp-empty'] },
	{ key: 'group_reject_btn', selectors: ['.gp-pane[data-pane="pending"] .js-reject-btn', '#group-reject-btn'], labelKey: 'group.reject_btn', description: 'odrzucenie zamówienia sklepu (wraca do sklepu; klika użytkownik)', screens: ['group_panel', 'order_view'], when: (s) => s.isGroup },
	{ key: 'group_preview_btn', selectors: ['.gp-pane[data-pane="pending"] .gp-btn--ghost'], labelKey: 'group.preview_btn', description: 'podgląd zamówienia sklepu przed zatwierdzeniem (nowa karta)', screens: ['group_panel'], when: (s) => s.isGroup },
	{ key: 'duplicate_position', selectors: ['.duplicate-btn'], labelKey: 'order.duplicate', description: 'duplikowanie pozycji', screens: ['order_view'] },
	{ key: 'edit_position', selectors: ['.edit-position-btn'], labelKey: 'order.edit_pos', description: 'edycja pozycji — otwiera formularz', screens: ['order_view'], click: true },
	{ key: 'delete_position', selectors: ['.delete-position-btn'], labelKey: 'order.delete_pos', description: 'usunięcie pozycji', screens: ['order_view'] },
	{ key: 'move_position', selectors: ['.move-up-btn'], labelKey: 'order.move_up', description: 'strzałki zmiany kolejności pozycji', screens: ['order_view'] },

	// ── konfigurator ──
	{ key: 'department_select', selectors: ['#department-select'], labelKey: 'form.department_label', description: 'wybór działu (rodzaju produktu)', screens: ['configurator'] },
	{ key: 'product_group_select', selectors: ['#asortment-group-select'], labelKey: 'form.group_label', description: 'wybór grupy produktu', screens: ['configurator'] },
	{ key: 'dynamic_form', selectors: ['#dynamic-form'], labelKey: null, description: 'formularz parametrów produktu (wypełniać po kolei)', screens: ['configurator'], appears: 'choice' },
	{ key: 'info_icon', selectors: ['.param-info-icon'], labelKey: null, description: 'ikonka „i" z opisem parametru', screens: ['configurator'], appears: 'choice', js: true },
	{ key: 'comment_link', selectors: ['#show-comment-button'], labelKey: 'form.add_comment_button', description: 'link „dodaj komentarz" do pozycji (odsłania pole)', screens: ['configurator'], appears: 'choice', click: true, js: true },
	{ key: 'save_position', selectors: ['#show-button'], labelKey: 'form.save_button', description: 'zapis pozycji (klika użytkownik)', screens: ['configurator'], appears: 'choice' },
	{ key: 'reset_form', selectors: ['#reset-button'], labelKey: 'form.reset_button', description: 'wyczyszczenie wartości formularza', screens: ['configurator'], appears: 'choice' },

	// ── panel użytkownika ──
	{ key: 'panel_tab_password', selectors: ['a.panel-tab[href="/panel?tab=password"]'], labelKey: 'panel.tab_password', description: 'zakładka zmiany hasła', screens: ['account', 'password', 'catalogs'], click: true, navTo: 'password' },
	{ key: 'panel_tab_catalogs', selectors: ['a.panel-tab[href="/panel?tab=catalogs"]'], labelKey: 'panel.tab_catalogs', description: 'zakładka katalogów PDF', screens: ['account', 'password', 'catalogs'], click: true, navTo: 'catalogs' },
	{ key: 'panel_tab_personalization', selectors: ['a.panel-tab[href="/panel?tab=personalization"]'], labelKey: 'panel.tab_personalization', description: 'zakładka wyglądu portalu', screens: ['account', 'password', 'catalogs'], click: true, navTo: 'appearance' },
	{ key: 'canceled_link', selectors: ['#panel-canceled-orders-link'], labelKey: 'cancel_order.panel_link_title', description: 'kafelek zleceń anulowanych', screens: ['account', 'password', 'catalogs'], click: true, navTo: 'canceled' },
	{ key: 'current_password', selectors: ['#currentPassword'], labelKey: 'panel.current_password', description: 'pole aktualnego hasła', screens: ['password'] },
	{ key: 'new_password', selectors: ['#newPassword'], labelKey: 'panel.new_password', description: 'pole nowego hasła', screens: ['password'] },
	{ key: 'change_password_btn', selectors: ['#panel-password-form button[type="submit"]'], labelKey: 'panel.change_password_btn', description: 'zapis nowego hasła (klika użytkownik)', screens: ['password'] },
	{ key: 'catalog_download', selectors: ['.panel-catalog-download'], labelKey: 'panel.catalog_download', description: 'pobranie katalogu PDF', screens: ['catalogs'], empty: ['.panel-empty'] },

	// ── pracownicy ──
	{ key: 'add_employee_btn', selectors: ['.action-btn-add'], labelKey: 'employee.add_employee', description: 'dodanie pracownika — otwiera formularz', screens: ['employees'], click: true, navTo: 'add_employee' },
	{ key: 'permission_toggle', selectors: ['.permission-toggle'], labelKey: 'employee.permissions', description: 'przełączniki uprawnień pracownika (zapisują się od razu — klika użytkownik)', screens: ['employees'] },
	{ key: 'edit_employee_btn', selectors: ['.edit-employee-btn'], labelKey: 'employee.edit', description: 'edycja danych pracownika — otwiera formularz', screens: ['employees'], click: true },
	{ key: 'employee_login_input', selectors: ['#login'], labelKey: null, description: 'formularz pracownika: imię, nazwisko, login (unikalny), hasło, telefon', screens: ['add_employee'] },
	{ key: 'employee_form_permissions', selectors: ['#can_send_orders'], labelKey: 'employee.permissions', description: 'formularz pracownika: uprawnienia (wysyłanie, ceny, wszystkie zamówienia)', screens: ['add_employee'] },
	{ key: 'save_employee', selectors: ['#submit-btn'], labelKey: 'employee.save', description: 'zapis nowego pracownika (klika użytkownik)', screens: ['add_employee'] },

	// ── grupa ──
	{ key: 'group_pending_tab', selectors: ['.gp-tab[data-tab="pending"]'], labelKey: 'group.tab_pending', description: 'zakładka zamówień czekających na zatwierdzenie', screens: ['group_panel'], click: true }
];

const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));

/** Mapa klucz → selektory dla przeglądarki (bez opisów dla modelu). */
function clientMap() {
	const out = {};
	for (const e of CATALOG) out[e.key] = e.selectors;
	return out;
}

/** Ekran dostępny dla konta: bez `page` zawsze, ze stroną — gdy konto ją widzi. */
function screenAllowed(screenKey, scope) {
	const s = SCREENS[screenKey];
	if (!s) return false;
	return !s.page || pages.allowed(s.page, scope);
}

/** Element dostępny dla konta: któryś z jego ekranów dostępny, strona docelowa (navTo) też, i warunek `when`. */
function elementAllowed(e, scope) {
	if (!e) return false;
	if (e.when && !e.when(scope || {})) return false;
	if (e.navTo && !pages.allowed(e.navTo, scope)) return false;
	return e.screens.some((sc) => screenAllowed(sc, scope));
}

/**
 * Elementy zgłoszone przez przeglądarkę jako widoczne → opisy dla modelu.
 * Klucze spoza katalogu są pomijane (przeglądarka nie dopisze nowych), a przy
 * podanym zakresie konta — także te, których konto nie widzi (np. „Panel
 * pracowników" zgłoszony przez zmanipulowaną albo nieaktualną stronę pracownika).
 */
function describeAvailable(keys, lang, deps = {}, scope = null) {
	if (!Array.isArray(keys)) return [];
	const l = labels.normalizeLang(lang);
	const local = labels.loadLocale(l, deps);
	const out = [];
	for (const key of [...new Set(keys)].slice(0, CATALOG.length)) {
		const e = BY_KEY.get(key);
		if (!e) continue;
		if (scope && !elementAllowed(e, scope)) continue;
		out.push({ key: e.key, description: e.description, label: e.labelKey ? labels.lookup(local, e.labelKey) : null });
	}
	return out;
}

/** Katalog do pokazów krok po kroku: elementy dostępne dla konta, z ekranem i flagą kliknięcia. */
function describeForTour(scope, lang, deps = {}) {
	const local = labels.loadLocale(labels.normalizeLang(lang), deps);
	return CATALOG.filter((e) => elementAllowed(e, scope)).map((e) => ({
		key: e.key,
		label: e.labelKey ? labels.lookup(local, e.labelKey) : null,
		description: e.description,
		screens: e.screens.filter((sc) => screenAllowed(sc, scope)).map((sc) => SCREENS[sc].label),
		click: !!e.click
	}));
}

/**
 * Dane pokazu dla przeglądarki: element → { s: ekrany, c: czy klikalny, n: adres navTo,
 *   w: 'choice' gdy element pojawia się dopiero po wyborze działu i grupy,
 *   e: selektory „pustego stanu" (np. brak katalogów) — wskazywane, gdy elementu brak },
 * ekran → { p: wzorzec ścieżki, q: zapytanie, h: adres strony }. Tylko dla konta.
 */
function clientTourMeta(scope) {
	const elements = {};
	for (const e of CATALOG) {
		if (!elementAllowed(e, scope)) continue;
		const nav = e.navTo ? pages.PAGES.find((pg) => pg.key === e.navTo) : null;
		elements[e.key] = { s: e.screens.filter((sc) => screenAllowed(sc, scope)), c: !!e.click, n: nav ? nav.href : null };
		if (e.appears) elements[e.key].w = e.appears;
		if (e.empty) elements[e.key].e = e.empty;
	}
	const screens = {};
	for (const [key, sc] of Object.entries(SCREENS)) {
		if (!screenAllowed(key, scope) || key === 'any') continue;
		const p = sc.page ? pages.PAGES.find((pg) => pg.key === sc.page) : null;
		screens[key] = { p: sc.path, q: sc.query || null, h: p ? p.href : null };
	}
	return { elements, screens };
}

module.exports = { CATALOG, SCREENS, BY_KEY, clientMap, describeAvailable, describeForTour, clientTourMeta, elementAllowed };
