'use strict';

/**
 * Walidacja formularza klienta — czyste funkcje, zero bazy.
 *
 * Testy trzymają się kontraktu „klucze i18n, nie zdania": kod błędu jest
 * częścią API (frontend mapuje go na komunikat), więc zmiana klucza musi
 * przewrócić test, a nie po cichu wyświetlić surowy identyfikator operatorowi.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCustomerInput, normalizeListQuery, parseDiscountRules, parseTags } = require('../validator');

const MINIMAL = {
	ident: 'HKL-TEST-01',
	pin: '12345678',
	client_name: 'Tapijtcentrum Nederland',
	email: 'orders@example.com'
};

test('poprawny formularz przechodzi bez błędów i normalizuje typy', () => {
	const { values, errors } = normalizeCustomerInput({
		...MINIMAL,
		country: 'nl',
		currency: 'eur',
		discount_global_pct: '12,5',
		price_factor: '1,2500',
		payment_terms_days: '30',
		vat_rate: '21',
		credit_limit: '15000',
		sub_price_enabled: 'on',
		locale: 'NL'
	});

	assert.deepEqual(errors, []);
	assert.equal(values.user.country, 'NL');
	assert.equal(values.terms.currency, 'EUR');
	// Przecinek dziesiętny jest tym, co realnie wpisuje polski/niemiecki operator.
	assert.equal(values.terms.discount_global_pct, 12.5);
	assert.equal(values.terms.price_factor, 1.25);
	assert.equal(values.terms.payment_terms_days, 30);
	assert.equal(values.terms.sub_price_enabled, 1);
	assert.equal(values.terms.locale, 'nl');
	// Język komunikacji idzie też do `user.ab_lang` — to on decyduje o języku PDF-a.
	assert.equal(values.user.ab_lang, 'nl');
});

test('jedynym twardo wymaganym polem przy tworzeniu jest nazwa klienta', () => {
	const { errors } = normalizeCustomerInput({});

	assert.ok(errors.includes('client_name_required'));
	// Identyfikator i PIN wygeneruje serwis — formularz obiecuje „puste =
	// wygenerujemy", więc walidator NIE może ich żądać.
	assert.ok(!errors.includes('ident_required'));
	assert.ok(!errors.includes('pin_required'));
});

test('podany, ale błędny ident/PIN nadal jest odrzucany', () => {
	const { errors } = normalizeCustomerInput({ ident: 'zł ident', pin: 'abcd' });

	assert.ok(errors.includes('ident_invalid'));
	assert.ok(errors.includes('pin_invalid'));
});

test('przy edycji te same pola są opcjonalne', () => {
	const { errors } = normalizeCustomerInput({ city: 'Best' }, { isEdit: true });

	assert.deepEqual(errors, []);
});

test('puste hasło przy tworzeniu zleca wygenerowanie, przy edycji nie', () => {
	assert.equal(normalizeCustomerInput(MINIMAL).generatePassword, true);
	assert.equal(normalizeCustomerInput({}, { isEdit: true }).generatePassword, false);
});

test('hasło krótsze niż 8 znaków i dłuższe niż 72 jest odrzucane', () => {
	assert.ok(normalizeCustomerInput({ ...MINIMAL, password: 'krotkie' }).errors.includes('password_too_short'));
	// 72 bajty to twarda granica bcrypta — dłuższe hasło dawałoby złudzenie siły.
	assert.ok(normalizeCustomerInput({ ...MINIMAL, password: 'x'.repeat(73) }).errors.includes('password_too_long'));
	assert.deepEqual(normalizeCustomerInput({ ...MINIMAL, password: 'x'.repeat(72) }).errors, []);
});

test('formaty identyfikatora, PIN-u, e-maila, telefonu i kraju', () => {
	const cases = [
		[{ ident: 'ab' }, 'ident_invalid'],
		[{ ident: 'ma spacje' }, 'ident_invalid'],
		[{ pin: '12ab' }, 'pin_invalid'],
		[{ email: 'nie-email' }, 'email_invalid'],
		[{ phone: 'abc' }, 'phone_invalid'],
		[{ country: 'POL' }, 'country_invalid'],
		[{ currency: 'PLNN' }, 'currency_invalid'],
		[{ locale: 'es' }, 'locale_invalid']
	];

	for (const [patch, expected] of cases) {
		const { errors } = normalizeCustomerInput({ ...MINIMAL, ...patch });
		assert.ok(errors.includes(expected), `${JSON.stringify(patch)} → oczekiwano ${expected}, dostano ${errors}`);
	}
});

test('numer w zapisie 00-prefiksowym jest poprawny (tak stoją dane w bazie)', () => {
	const { errors } = normalizeCustomerInput({ ...MINIMAL, phone: '0031499373223' });
	assert.deepEqual(errors, []);
});

test('kanał kontaktu wymaga odpowiedniego pola', () => {
	const brakEmaila = normalizeCustomerInput({ ...MINIMAL, email: '', preferred_channel: 'email' });
	assert.ok(brakEmaila.errors.includes('email_required_for_channel'));

	const brakTelefonu = normalizeCustomerInput({ ...MINIMAL, preferred_channel: 'phone' });
	assert.ok(brakTelefonu.errors.includes('phone_required_for_channel'));
});

test('zakresy liczbowe: rabat, mnożnik, VAT, termin płatności', () => {
	assert.ok(normalizeCustomerInput({ ...MINIMAL, discount_global_pct: '101' }).errors.includes('discount_global_pct_invalid'));
	assert.ok(normalizeCustomerInput({ ...MINIMAL, discount_global_pct: '-1' }).errors.includes('discount_global_pct_invalid'));
	assert.ok(normalizeCustomerInput({ ...MINIMAL, price_factor: '100' }).errors.includes('price_factor_invalid'));
	assert.ok(normalizeCustomerInput({ ...MINIMAL, vat_rate: '120' }).errors.includes('vat_rate_invalid'));
	assert.ok(normalizeCustomerInput({ ...MINIMAL, payment_terms_days: '400' }).errors.includes('payment_terms_days_invalid'));
	// 0 jest legalne dla mnożnika (pozycje z wyzerowaną ceną).
	assert.deepEqual(normalizeCustomerInput({ ...MINIMAL, price_factor: '0' }).errors, []);
});

test('adres dostawy „taki sam jak rejestrowy" jest kopiowany na serwerze', () => {
	const { values } = normalizeCustomerInput({
		...MINIMAL,
		street: 'Sportlaan 31',
		zip: '5683 CS',
		city: 'Best',
		country: 'NL',
		phone: '0031499373223',
		delivery_same_as_registered: 'on'
	});

	assert.equal(values.delivery.street, 'Sportlaan 31');
	assert.equal(values.delivery.city, 'Best');
	assert.equal(values.delivery.country, 'NL');
	assert.equal(values.delivery.name, 'Tapijtcentrum Nederland');
});

test('pusty adres dostawy nie tworzy pustego rekordu', () => {
	const { values } = normalizeCustomerInput(MINIMAL);
	assert.equal(values.delivery, null);
});

test('organizacja z formularza jest ignorowana', () => {
	const { values } = normalizeCustomerInput({ ...MINIMAL, organization_id: 999, organizationId: 999 });

	assert.equal(values.user.organization_id, undefined);
	assert.equal(values.terms.organization_id, undefined);
});

test('reguły rabatowe: poprawne przechodzą, błędne dają konkretny klucz', () => {
	const ok = parseDiscountRules([{ product_group: '43', discount_pct: '12.5', valid_from: '2026-01-01', valid_to: '2026-12-31' }]);
	assert.deepEqual(ok.errors, []);
	assert.deepEqual(ok.value, [{ product_group: '43', discount_pct: 12.5, valid_from: '2026-01-01', valid_to: '2026-12-31' }]);

	assert.ok(parseDiscountRules('{nie json}').errors.includes('discount_rules_malformed'));
	assert.ok(parseDiscountRules([{ discount_pct: 10 }]).errors.includes('discount_rule_group_invalid'));
	assert.ok(parseDiscountRules([{ product_group: '43', discount_pct: 500 }]).errors.includes('discount_rule_pct_invalid'));
	assert.ok(parseDiscountRules([{ product_group: '43', discount_pct: 10, valid_from: '01.01.2026' }]).errors.includes('discount_rule_date_invalid'));
	assert.ok(
		parseDiscountRules([{ product_group: '43', discount_pct: 10, valid_from: '2026-12-31', valid_to: '2026-01-01' }])
			.errors.includes('discount_rule_range_invalid')
	);
	assert.ok(parseDiscountRules(new Array(51).fill({ product_group: '43', discount_pct: 1 })).errors.includes('discount_rules_too_many'));
});

test('reguły rabatowe przychodzą też jako JSON-string (formularz bez JS)', () => {
	const { values } = normalizeCustomerInput({
		...MINIMAL,
		discount_rules: JSON.stringify([{ product_group: '71', discount_pct: 5 }])
	});

	assert.equal(values.terms.discount_rules, JSON.stringify([{ product_group: '71', discount_pct: 5, valid_from: null, valid_to: null }]));
});

test('tagi: lista po przecinku, JSON, duplikaty i limity', () => {
	assert.deepEqual(parseTags('vip, nl , vip').value, ['vip', 'nl']);
	assert.deepEqual(parseTags('["a","b"]').value, ['a', 'b']);
	assert.deepEqual(parseTags('').value, null);
	assert.ok(parseTags(new Array(21).fill(0).map((_, i) => `t${i}`)).errors.includes('tags_too_many'));
	assert.ok(parseTags(['x'.repeat(41)]).errors.includes('tags_too_long'));
});

test('zgoda RODO bez daty dostaje datę bieżącą, brak zgody czyści datę', () => {
	const zgoda = normalizeCustomerInput({ ...MINIMAL, rodo_consent: '1' });
	assert.match(zgoda.values.terms.rodo_consent_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

	const brak = normalizeCustomerInput({ ...MINIMAL, rodo_consent: '0', rodo_consent_at: '2026-01-01' });
	assert.equal(brak.values.terms.rodo_consent_at, null);
});

test('UTF-8 w nazwie i notatkach przechodzi bez zmian', () => {
	const { values, errors } = normalizeCustomerInput({
		...MINIMAL,
		client_name: 'Żółć & Söhne — Ćwikła',
		notes: 'Uwaga: „zażółć gęślą jaźń"'
	});

	assert.deepEqual(errors, []);
	assert.equal(values.user.client_name, 'Żółć & Söhne — Ćwikła');
	assert.equal(values.terms.notes, 'Uwaga: „zażółć gęślą jaźń"');
});

test('filtry listy są przycinane do bezpiecznych wartości', () => {
	const filters = normalizeListQuery({
		page: '3',
		per_page: '999',
		status: 'wymyslony',
		country: 'pl',
		price_list: 'PG#0; DROP TABLE user',
		sort: 'ident',
		dir: 'DESC'
	});

	assert.equal(filters.page, 3);
	assert.equal(filters.perPage, 200); // twardy sufit
	assert.equal(filters.status, 'active'); // nieznana wartość → domyślna
	assert.equal(filters.country, 'PL');
	assert.equal(filters.priceList, null); // średnik nie przechodzi przez wzorzec
	assert.equal(filters.dir, 'desc');
	assert.equal(filters.offset, 400);
});
