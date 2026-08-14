'use strict';

/**
 * Mapper payloadu eksportu — czysta funkcja, więc testowana snapshotem
 * i przypadkami brzegowymi.
 *
 * ⚠️ Snapshot pilnuje KSZTAŁTU kontraktu z systemem zewnętrznym. Jeśli ten test
 * pada, to nie znaczy „popraw test" — znaczy „zmieniłeś kontrakt, podbij
 * `PAYLOAD_VERSION` i uzgodnij zmianę z odbiorcą".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCustomerPayload, canonicalJson, PAYLOAD_VERSION } = require('../mapper');

const CUSTOMER = {
	id: 7072,
	ident: 'HKL-TCN-01',
	client_name: 'Tapijtcentrum Nederland',
	tax_id: 'NL004148496B01',
	country: 'nl',
	locale: 'nl',
	email: 'orders@eurogordijn.nl',
	phone: '0031499373223',
	preferred_channel: 'email',
	street: 'Sportlaan 31',
	zip: '5683 CS',
	city: 'Best',
	delivery_street: 'Magazijnstraat 1',
	delivery_zip: '5683 AA',
	delivery_city: 'Best',
	delivery_country: 'nl',
	price_list_code: 'TCN-2026',
	price_list_version: '2026.1',
	discount_global_pct: '12.50',
	discount_rules: '[{"product_group":"43","discount_pct":5,"valid_from":"2026-01-01","valid_to":null}]',
	surcharge_version: '2026_Q3',
	sub_price_enabled: 1,
	price_factor: '1.2500',
	currency: 'EUR',
	vat_rate: '21.00',
	payment_terms_days: 30,
	credit_limit: '15000.00',
	rodo_consent: 1,
	rodo_consent_at: '2026-08-13 10:15:00',
	terms_version: 'v3',
	tags: '["vip","nl"]',
	active: 1,
	organization_id: 3
};

const ORGANIZATION = { id: 3, ident: 'HKL', name: 'HKL', tax_id: 'PL1234567890' };

test('payload ma uzgodniony kształt (snapshot kontraktu)', () => {
	const payload = buildCustomerPayload(CUSTOMER, ORGANIZATION);

	assert.deepEqual(payload, {
		payload_version: PAYLOAD_VERSION,
		source: 'eform',
		organization: { id: 3, ident: 'HKL', name: 'HKL', tax_id: 'PL1234567890' },
		customer: {
			ident: 'HKL-TCN-01',
			internal_id: 7072,
			name: 'Tapijtcentrum Nederland',
			tax_id: 'NL004148496B01',
			country: 'NL',
			locale: 'nl',
			active: true,
			contact: {
				email: 'orders@eurogordijn.nl',
				phone: '0031499373223',
				preferred_channel: 'email'
			},
			addresses: {
				registered: { street: 'Sportlaan 31', zip: '5683 CS', city: 'Best', country: 'NL' },
				delivery: { street: 'Magazijnstraat 1', zip: '5683 AA', city: 'Best', country: 'NL' }
			}
		},
		commercial_terms: {
			price_list: { code: 'TCN-2026', version: '2026.1' },
			surcharge_version: '2026_Q3',
			discount_global_pct: 12.5,
			discount_rules: [{ product_group: '43', discount_pct: 5, valid_from: '2026-01-01', valid_to: null }],
			price_factor: 1.25,
			sub_price_enabled: true,
			currency: 'EUR',
			vat_rate: 21,
			payment_terms_days: 30,
			credit_limit: 15000
		},
		compliance: { rodo_consent: true, rodo_consent_at: '2026-08-13', terms_version: 'v3' },
		tags: ['vip', 'nl']
	});
});

test('brak rabatów, adresu dostawy i organizacji nie wywraca mappera', () => {
	const payload = buildCustomerPayload({ id: 1, ident: 'X', client_name: 'X', active: 0 });

	assert.equal(payload.organization, null);
	assert.deepEqual(payload.commercial_terms.discount_rules, []);
	assert.equal(payload.commercial_terms.discount_global_pct, 0);
	// Brak mnożnika = 1, nie null — odbiorca nie ma się domyślać.
	assert.equal(payload.commercial_terms.price_factor, 1);
	assert.equal(payload.commercial_terms.currency, 'EUR');
	assert.equal(payload.customer.addresses.delivery, null);
	assert.equal(payload.customer.addresses.registered, null);
	assert.equal(payload.customer.active, false);
});

test('błędne reguły rabatowe są odsiewane, a nie przepuszczane dalej', () => {
	const payload = buildCustomerPayload({
		...CUSTOMER,
		discount_rules: '[{"product_group":null,"discount_pct":5},{"product_group":"71","discount_pct":"abc"},{"product_group":"71","discount_pct":"7.5"}]'
	});

	assert.deepEqual(payload.commercial_terms.discount_rules, [
		{ product_group: '71', discount_pct: 7.5, valid_from: null, valid_to: null }
	]);
});

test('niezdatny JSON w kolumnach nie rzuca wyjątkiem', () => {
	const payload = buildCustomerPayload({ ...CUSTOMER, discount_rules: '{{', tags: 'nie-json' });

	assert.deepEqual(payload.commercial_terms.discount_rules, []);
	assert.deepEqual(payload.tags, []);
});

test('UTF-8 przechodzi bez uszczerbku', () => {
	const payload = buildCustomerPayload({ ...CUSTOMER, client_name: 'Żółć & Söhne — Ćwikła', city: 'Kraków' });

	assert.equal(payload.customer.name, 'Żółć & Söhne — Ćwikła');
	assert.equal(payload.customer.addresses.registered.city, 'Kraków');
	assert.match(canonicalJson(payload), /Żółć/);
});

test('data zgody z obiektu Date jest sprowadzana do dnia', () => {
	const payload = buildCustomerPayload({ ...CUSTOMER, rodo_consent_at: new Date('2026-08-13T22:30:00Z') });
	assert.equal(payload.compliance.rodo_consent_at, '2026-08-13');
});

test('canonicalJson jest deterministyczny niezależnie od kolejności kluczy', () => {
	const a = canonicalJson(buildCustomerPayload(CUSTOMER, ORGANIZATION));
	const przestawione = Object.keys(CUSTOMER)
		.reverse()
		.reduce((acc, key) => {
			acc[key] = CUSTOMER[key];
			return acc;
		}, {});
	const b = canonicalJson(buildCustomerPayload(przestawione, ORGANIZATION));

	assert.equal(a, b);
});

test('mapper bez klienta rzuca czytelnym błędem, a nie „cannot read property"', () => {
	assert.throws(() => buildCustomerPayload(null), /brak danych klienta/);
});
