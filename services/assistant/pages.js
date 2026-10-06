/**
 * Strony portalu, do których Eforek może dać odnośnik (`[[page:klucz]]` w odpowiedzi
 * czatu) albo przejść sam w rozmowie głosowej (narzędzie `open_page`).
 *
 * Model nie zna i nie zwraca adresów — tylko KLUCZ z tej listy; adres i etykietę
 * (w języku klienta) podstawia serwer. Strony niedostępne dla danego konta
 * (`when`) nie trafiają ani do modelu, ani do przeglądarki.
 */

'use strict';

const { makeResolver } = require('./knowledge');
const { normalizeLang } = require('./labels');

/** Etykiety wpisane w portalu na sztywno (bez klucza tłumaczenia). */
const FIXED_LABELS = {
	home: { pl: 'Strona główna', en: 'Home', de: 'Startseite', fr: 'Accueil', nl: 'Startpagina' },
	// Pozycja menu „Faktury" jest po polsku we wszystkich językach portalu.
	invoices: { pl: 'Faktury', en: 'Faktury', de: 'Faktury', fr: 'Faktury', nl: 'Faktury' },
	import_log: { pl: 'Moje Importy', en: 'Moje Importy', de: 'Moje Importy', fr: 'Moje Importy', nl: 'Moje Importy' }
};

/**
 * `when(scope)` — czy konto widzi stronę (te same warunki co menu portalu).
 * scope: { accountType, isEmployee, isGroup, isGroupShop, isOwner, invoices }
 */
const PAGES = [
	{ key: 'home', href: '/', description: 'strona główna (dane konta, ostatnie oferty)' },
	{ key: 'new_order', href: '/orders/add-order', labelKey: 'base.new_order', description: 'nowa oferta (nagłówek zamówienia)' },
	{ key: 'offers', href: '/orders', labelKey: 'base.your_orders', description: 'lista ofert niewysłanych' },
	{ key: 'history', href: '/orders/history', labelKey: 'base.orders_history', description: 'wysłane zlecenia: status, termin wysyłki, przesyłki, zamów ponownie, anulowanie' },
	{ key: 'canceled', href: '/orders/canceled', labelKey: 'cancel_order.panel_link_title', description: 'zlecenia anulowane' },
	{ key: 'delivery_time', href: '/delivery-time', labelKey: 'termin.delivery_time', description: 'czasy produkcji produktów' },
	{ key: 'import_log', href: '/orders/import-log', description: 'wynik automatycznych importów zamówień' },
	{ key: 'account', href: '/panel', labelKey: 'panel.nav_link', description: 'panel użytkownika (dane konta)', when: (s) => !s.isEmployee && !s.isGroupShop },
	{ key: 'password', href: '/panel?tab=password', labelKey: 'panel.tab_password', description: 'zmiana hasła', when: (s) => !s.isEmployee && !s.isGroupShop },
	{ key: 'catalogs', href: '/panel?tab=catalogs', labelKey: 'panel.tab_catalogs', description: 'katalogi PDF do pobrania', when: (s) => !s.isEmployee && !s.isGroupShop },
	{ key: 'appearance', href: '/panel?tab=personalization', labelKey: 'panel.tab_personalization', description: 'wybór wyglądu portalu', when: (s) => !s.isEmployee && !s.isGroupShop },
	{ key: 'employees', href: '/user/employee-panel', labelKey: 'base.employee_panel', description: 'panel pracowników i ich uprawnienia', when: (s) => !s.isEmployee && !s.isGroupShop },
	{ key: 'add_employee', href: '/user/employee/add', labelKey: 'employee.add_employee', description: 'formularz nowego pracownika', when: (s) => !s.isEmployee && !s.isGroupShop },
	{ key: 'invoices', href: '/invoices', description: 'moduł faktur', when: (s) => s.invoices },
	{ key: 'end_clients', href: '/invoices/end-clients', labelKey: 'inv:end_clients', description: 'odbiorcy końcowi do faktur', when: (s) => s.invoices },
	{ key: 'invoice_profile', href: '/invoices/profile', labelKey: 'inv:profile', description: 'dane do faktur (konto organizacji)', when: (s) => s.invoices && s.isOwner },
	{ key: 'group_panel', href: '/group/panel', labelKey: 'group.panel_title', description: 'panel grupy: sklepy/klienci i ich zamówienia', when: (s) => s.isGroup },
	{ key: 'group_pending', href: '/group/panel?tab=pending', labelKey: 'group.tab_pending', description: 'zamówienia sklepów czekające na zatwierdzenie', when: (s) => s.isGroup },
	{ key: 'contact', href: '/contact', labelKey: 'site.contact', description: 'dane kontaktowe obsługi' },
	{ key: 'terms', href: '/terms', labelKey: 'site.terms', description: 'regulamin' },
	{ key: 'privacy', href: '/privacy', labelKey: 'site.privacy', description: 'polityka prywatności' }
];

const BY_KEY = new Map(PAGES.map((p) => [p.key, p]));

function label(page, lang, resolve) {
	const l = normalizeLang(lang);
	if (FIXED_LABELS[page.key]) return FIXED_LABELS[page.key][l] || FIXED_LABELS[page.key].pl;
	return (page.labelKey && resolve(page.labelKey)) || page.key;
}

/**
 * Strony widoczne dla konta: [{ key, href, label, description }].
 * @param {object} scope  zakres konta (tools.scopeFromRequest)
 */
function forScope(scope, lang, deps = {}) {
	const resolve = makeResolver(lang, deps);
	return PAGES
		.filter((p) => !p.when || p.when(scope || {}))
		.map((p) => ({ key: p.key, href: p.href, label: label(p, lang, resolve), description: p.description }));
}

/** Czy konto widzi stronę — bez etykiet (tanie; wołane dla każdego elementu katalogu). */
function allowed(key, scope) {
	const p = BY_KEY.get(key);
	return !!p && (!p.when || p.when(scope || {}));
}

/** Jedna strona dla konta albo null (klucz spoza listy lub niedostępny). */
function get(key, scope, lang, deps = {}) {
	const p = BY_KEY.get(key);
	if (!p || (p.when && !p.when(scope || {}))) return null;
	return { key: p.key, href: p.href, label: label(p, lang, makeResolver(lang, deps)) };
}

module.exports = { PAGES, forScope, get, allowed };
