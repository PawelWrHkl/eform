/**
 * Walidacja i normalizacja formularza „Klient organizacji".
 *
 * Czyste funkcje: wejście = `req.body`, wyjście = `{ values, errors }` z kluczami
 * i18n zamiast gotowych komunikatów (ten sam kontrakt co
 * `services/admin/userAdminService.normalizeUserSettings`, żeby oba panele
 * zachowywały się tak samo i dały się testować bez bazy).
 *
 * ⚠️ `organization_id` NIE jest tu przyjmowane ani walidowane. Organizację
 * wyznacza sesja (`services/invoices/http/session.organizationIdFromSession`) —
 * gdyby dało się ją podać w formularzu, każdy owner mógłby zapisać klienta
 * cudzej organizacji.
 */

'use strict';

const CURRENCY_RE = /^[A-Z]{3}$/;
const IDENT_RE = /^[A-Za-z0-9._-]{3,50}$/;
const PIN_RE = /^[0-9]{4,12}$/;
const CODE_RE = /^[A-Za-z0-9._-]{1,50}$/;
const VERSION_RE = /^[A-Za-z0-9._/-]{1,30}$/;
const TAX_ID_RE = /^[A-Za-z0-9 .-]{1,30}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
/**
 * E.164 z tolerancją na zapis „00" zamiast „+" — w bazie stoją oba warianty
 * (patrz `migration_phone_lengths.sql`: `00494504205022`).
 * ⚠️ `user.phone` to VARCHAR(22), więc dłuższych nie przyjmujemy.
 */
const PHONE_RE = /^(\+|00)?[0-9 ()-]{6,22}$/;
/** RFC 5322 w wersji praktycznej — pełna gramatyka przepuszcza adresy, których żaden MTA nie przyjmie. */
const EMAIL_RE = /^[^\s@"'<>]+@[^\s@.,"'<>]+(\.[^\s@.,"'<>]+)+$/;

const PREFERRED_CHANNELS = new Set(['email', 'phone']);
const LOCALES = new Set(['pl', 'en', 'de', 'fr', 'nl']);
const MAX_TAGS = 20;
const MAX_DISCOUNT_RULES = 50;

function blank(value) {
	return value === undefined || value === null || String(value).trim() === '';
}

function text(value) {
	return blank(value) ? null : String(value).trim();
}

function toTinyint(value) {
	if (value === true || value === 1) return 1;
	const asText = String(value == null ? '' : value).trim().toLowerCase();
	return asText === '1' || asText === 'true' || asText === 'on' || asText === 'yes' ? 1 : 0;
}

/**
 * Liczba dziesiętna w zadanym zakresie.
 *
 * @returns {{ value: number|null, error?: string }}
 */
function decimal(value, { min, max, scale, fallback = null }) {
	if (blank(value)) return { value: fallback };
	const parsed = Number(String(value).replace(',', '.'));
	if (!Number.isFinite(parsed)) return { value: fallback, error: 'not_a_number' };
	if (parsed < min || parsed > max) return { value: fallback, error: 'out_of_range' };
	return { value: Number(parsed.toFixed(scale)) };
}

function integer(value, { min, max, fallback = null }) {
	if (blank(value)) return { value: fallback };
	const parsed = Number(String(value).trim());
	if (!Number.isInteger(parsed)) return { value: fallback, error: 'not_an_integer' };
	if (parsed < min || parsed > max) return { value: fallback, error: 'out_of_range' };
	return { value: parsed };
}

/**
 * Reguły rabatowe per grupa produktowa.
 *
 * Przyjmuje tablicę albo JSON-string (formularz bez JS wysyła string z pola
 * ukrytego). Każdy element musi mieć grupę i procent; daty są opcjonalne, ale
 * gdy obie są podane, `valid_from` nie może być po `valid_to`.
 *
 * @param {*} raw
 * @returns {{ value: object[]|null, errors: string[] }}
 */
function parseDiscountRules(raw) {
	if (blank(raw)) return { value: null, errors: [] };

	let list = raw;
	if (typeof raw === 'string') {
		try {
			list = JSON.parse(raw);
		} catch {
			return { value: null, errors: ['discount_rules_malformed'] };
		}
	}
	if (!Array.isArray(list)) return { value: null, errors: ['discount_rules_malformed'] };
	if (list.length > MAX_DISCOUNT_RULES) return { value: null, errors: ['discount_rules_too_many'] };

	const errors = [];
	const rules = [];
	for (const entry of list) {
		if (!entry || typeof entry !== 'object') {
			errors.push('discount_rules_malformed');
			continue;
		}
		const group = text(entry.product_group);
		const pct = decimal(entry.discount_pct, { min: 0, max: 100, scale: 2 });
		const from = text(entry.valid_from);
		const to = text(entry.valid_to);

		if (!group || !CODE_RE.test(group)) {
			errors.push('discount_rule_group_invalid');
			continue;
		}
		if (pct.error || pct.value === null) {
			errors.push('discount_rule_pct_invalid');
			continue;
		}
		if (from && !ISO_DATE_RE.test(from)) {
			errors.push('discount_rule_date_invalid');
			continue;
		}
		if (to && !ISO_DATE_RE.test(to)) {
			errors.push('discount_rule_date_invalid');
			continue;
		}
		if (from && to && from > to) {
			errors.push('discount_rule_range_invalid');
			continue;
		}
		rules.push({ product_group: group, discount_pct: pct.value, valid_from: from, valid_to: to });
	}

	return { value: rules.length ? rules : null, errors: [...new Set(errors)] };
}

/**
 * @param {*} raw tablica albo lista rozdzielona przecinkami
 * @returns {{ value: string[]|null, errors: string[] }}
 */
function parseTags(raw) {
	if (blank(raw)) return { value: null, errors: [] };

	let list = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (trimmed.startsWith('[')) {
			try {
				list = JSON.parse(trimmed);
			} catch {
				return { value: null, errors: ['tags_malformed'] };
			}
		} else {
			list = trimmed.split(',');
		}
	}
	if (!Array.isArray(list)) return { value: null, errors: ['tags_malformed'] };

	const tags = [...new Set(list.map((t) => text(t)).filter(Boolean))];
	if (tags.length > MAX_TAGS) return { value: null, errors: ['tags_too_many'] };
	if (tags.some((t) => t.length > 40)) return { value: null, errors: ['tags_too_long'] };
	return { value: tags.length ? tags : null, errors: [] };
}

/**
 * Normalizuje całe wejście formularza.
 *
 * @param {object} body                        `req.body`
 * @param {object} [opts]
 * @param {boolean} [opts.isEdit]              przy edycji ident/pin/hasło są opcjonalne
 * @param {string} [opts.defaultCountry]       kraj organizacji — domyślna wartość
 * @returns {{ values: { user: object, terms: object, delivery: object|null }, errors: string[], generatePassword: boolean }}
 */
function normalizeCustomerInput(body = {}, opts = {}) {
	const errors = [];
	const isEdit = opts.isEdit === true;
	const user = {};
	const terms = {};

	// ── Identyfikacja ────────────────────────────────────────────────
	// ⚠️ Puste `ident`/`pin` to NIE błąd — formularz obiecuje „puste =
	// wygenerujemy" (pole identyfikatora jest domyślnie zablokowane), a
	// generowaniem zajmuje się serwis, bo tylko on może sprawdzić w bazie,
	// czy kandydat jest wolny. Walidujemy więc wyłącznie wartości podane.
	const ident = text(body.ident);
	if (ident && !IDENT_RE.test(ident)) errors.push('ident_invalid');
	else if (ident) user.ident = ident;

	const pin = text(body.pin);
	if (pin && !PIN_RE.test(pin)) errors.push('pin_invalid');
	else if (pin) user.pin = pin;

	// Puste hasło = wygeneruj i pokaż raz (nie zapisujemy jawnego w `user.plain`).
	const password = body.password == null ? '' : String(body.password);
	let generatePassword = false;
	if (blank(password)) {
		generatePassword = !isEdit;
	} else if (password.length < 8) {
		errors.push('password_too_short');
	} else if (password.length > 72) {
		// bcrypt tnie wejście po 72 bajtach — dłuższe hasło dawałoby złudzenie siły.
		errors.push('password_too_long');
	}

	// ── Dane podstawowe ─────────────────────────────────────────────
	const clientName = text(body.client_name);
	if (!clientName) {
		if (!isEdit) errors.push('client_name_required');
	} else if (clientName.length > 128) {
		errors.push('client_name_too_long');
	} else {
		user.client_name = clientName;
	}

	const taxId = text(body.tax_id);
	if (taxId && !TAX_ID_RE.test(taxId)) errors.push('tax_id_invalid');
	else if (taxId !== null || isEdit) user.tax_id = taxId;

	const country = text(body.country) || (isEdit ? null : text(opts.defaultCountry));
	if (country && !COUNTRY_RE.test(country)) errors.push('country_invalid');
	else if (country !== null || isEdit) user.country = country ? country.toUpperCase() : null;

	const locale = text(body.locale);
	if (locale && !LOCALES.has(locale.toLowerCase())) errors.push('locale_invalid');
	else {
		terms.locale = locale ? locale.toLowerCase() : null;
		// `user.ab_lang` decyduje o języku potwierdzeń (patrz services/abType.js),
		// więc język komunikacji ustawiamy w obu miejscach naraz.
		user.ab_lang = terms.locale;
	}

	// ── Kontakt ─────────────────────────────────────────────────────
	const email = text(body.email);
	if (email && !EMAIL_RE.test(email)) errors.push('email_invalid');
	else if (email && email.length > 128) errors.push('email_too_long');
	else user.email = email;

	const phone = text(body.phone);
	if (phone && !PHONE_RE.test(phone)) errors.push('phone_invalid');
	else user.phone = phone;

	const channel = (text(body.preferred_channel) || 'email').toLowerCase();
	if (!PREFERRED_CHANNELS.has(channel)) errors.push('preferred_channel_invalid');
	else terms.preferred_channel = channel;
	if (channel === 'email' && !email && !isEdit) errors.push('email_required_for_channel');
	if (channel === 'phone' && !phone && !isEdit) errors.push('phone_required_for_channel');

	// ── Adres rejestrowy ────────────────────────────────────────────
	user.street = text(body.street);
	user.city = text(body.city);
	user.zip = text(body.zip);
	if (user.zip && user.zip.length > 15) errors.push('zip_too_long');

	// ── Adres dostawy ───────────────────────────────────────────────
	const sameAddress = toTinyint(body.delivery_same_as_registered) === 1;
	const delivery = sameAddress
		? {
			name: user.client_name,
			street: user.street,
			zip: user.zip,
			city: user.city,
			country: user.country,
			phone_number: user.phone
		}
		: {
			name: text(body.delivery_name),
			street: text(body.delivery_street),
			zip: text(body.delivery_zip),
			city: text(body.delivery_city),
			country: text(body.delivery_country),
			phone_number: text(body.delivery_phone)
		};
	if (delivery.country && !COUNTRY_RE.test(delivery.country)) errors.push('delivery_country_invalid');
	if (delivery.country) delivery.country = delivery.country.toUpperCase();
	if (delivery.phone_number && !PHONE_RE.test(delivery.phone_number)) errors.push('delivery_phone_invalid');
	const hasDelivery = Object.values(delivery).some((v) => !blank(v));

	// ── Cennik i rabaty ─────────────────────────────────────────────
	const priceListCode = text(body.price_list_code);
	if (priceListCode && !CODE_RE.test(priceListCode)) errors.push('price_list_code_invalid');
	else terms.price_list_code = priceListCode;

	const priceListVersion = text(body.price_list_version);
	if (priceListVersion && !VERSION_RE.test(priceListVersion)) errors.push('price_list_version_invalid');
	else terms.price_list_version = priceListVersion;

	const surchargeVersion = text(body.surcharge_version);
	if (surchargeVersion && !VERSION_RE.test(surchargeVersion)) errors.push('surcharge_version_invalid');
	else terms.surcharge_version = surchargeVersion;

	const discount = decimal(body.discount_global_pct, { min: 0, max: 100, scale: 2, fallback: 0 });
	if (discount.error) errors.push('discount_global_pct_invalid');
	terms.discount_global_pct = discount.value === null ? 0 : discount.value;

	const rules = parseDiscountRules(body.discount_rules);
	errors.push(...rules.errors);
	terms.discount_rules = rules.value ? JSON.stringify(rules.value) : null;

	// 0 jest legalne (np. „ceny zerowane"), więc dolna granica to 0, nie epsilon.
	const factor = decimal(body.price_factor, { min: 0, max: 99.9999, scale: 4, fallback: 1 });
	if (factor.error) errors.push('price_factor_invalid');
	terms.price_factor = factor.value === null ? 1 : factor.value;

	const currency = (text(body.currency) || 'EUR').toUpperCase();
	if (!CURRENCY_RE.test(currency)) errors.push('currency_invalid');
	else terms.currency = currency;

	const vat = decimal(body.vat_rate, { min: 0, max: 100, scale: 2 });
	if (vat.error) errors.push('vat_rate_invalid');
	terms.vat_rate = vat.value;

	const paymentTerms = integer(body.payment_terms_days, { min: 0, max: 365, fallback: 0 });
	if (paymentTerms.error) errors.push('payment_terms_days_invalid');
	terms.payment_terms_days = paymentTerms.value === null ? 0 : paymentTerms.value;

	const creditLimit = decimal(body.credit_limit, { min: 0, max: 9999999999, scale: 2 });
	if (creditLimit.error) errors.push('credit_limit_invalid');
	terms.credit_limit = creditLimit.value;

	terms.sub_price_enabled = toTinyint(body.sub_price_enabled);

	// ── RODO ────────────────────────────────────────────────────────
	terms.rodo_consent = toTinyint(body.rodo_consent);
	const consentAt = text(body.rodo_consent_at);
	if (terms.rodo_consent === 1) {
		if (consentAt && !ISO_DATE_RE.test(consentAt)) errors.push('rodo_consent_at_invalid');
		terms.rodo_consent_at = consentAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
	} else {
		terms.rodo_consent_at = null;
	}
	const termsVersion = text(body.terms_version);
	if (termsVersion && !VERSION_RE.test(termsVersion)) errors.push('terms_version_invalid');
	else terms.terms_version = termsVersion;

	// ── Meta ────────────────────────────────────────────────────────
	const notes = text(body.notes);
	if (notes && notes.length > 5000) errors.push('notes_too_long');
	else terms.notes = notes;

	const tags = parseTags(body.tags);
	errors.push(...tags.errors);
	terms.tags = tags.value ? JSON.stringify(tags.value) : null;

	terms.active = Object.prototype.hasOwnProperty.call(body, 'active') ? toTinyint(body.active) : 1;

	return {
		values: { user, terms, delivery: hasDelivery ? delivery : null },
		errors: [...new Set(errors)],
		generatePassword
	};
}

/**
 * Filtry listy — też z białej listy, bo trafiają do zapytania.
 *
 * @param {object} query `req.query`
 * @returns {object}
 */
function normalizeListQuery(query = {}) {
	const page = Math.max(parseInt(query.page, 10) || 1, 1);
	const perPage = Math.min(Math.max(parseInt(query.per_page, 10) || 25, 5), 200);
	const status = ['all', 'active', 'inactive'].includes(query.status) ? query.status : 'active';
	const search = text(query.q);

	return {
		page,
		perPage,
		status,
		search: search && search.length <= 100 ? search : null,
		country: COUNTRY_RE.test(String(query.country || '')) ? String(query.country).toUpperCase() : null,
		priceList: CODE_RE.test(String(query.price_list || '')) ? String(query.price_list) : null,
		// Klient bez wiersza warunków handlowych to normalny, istniejący klient
		// organizacji — filtr pozwala znaleźć tych jeszcze nieskonfigurowanych.
		terms: ['with', 'without'].includes(query.terms) ? query.terms : null,
		sort: text(query.sort),
		dir: String(query.dir).toLowerCase() === 'desc' ? 'desc' : 'asc',
		limit: perPage,
		offset: (page - 1) * perPage
	};
}

module.exports = {
	normalizeCustomerInput,
	normalizeListQuery,
	parseDiscountRules,
	parseTags,
	// Reguły udostępnione UI (te same wzorce w inline-walidacji przeglądarki).
	PATTERNS: {
		ident: IDENT_RE.source,
		pin: PIN_RE.source,
		email: EMAIL_RE.source,
		phone: PHONE_RE.source,
		currency: CURRENCY_RE.source,
		country: COUNTRY_RE.source
	}
};
