/**
 * Mapper klienta na kanoniczny payload dla systemu zewnętrznego.
 *
 * Czysta funkcja — bez bazy, bez zegara, bez `process.env`. Dzięki temu payload
 * jest testowalny snapshotem, a hash z niego liczony jest deterministyczny
 * (klucz idempotencji, patrz `index.js`). Wszystko, co zmienne (data wysyłki,
 * numer próby), dokłada warstwa transportowa jako nagłówki — NIE payload.
 */

'use strict';

/** Wersja kontraktu payloadu. Bump = zmiana kształtu po stronie odbiorcy. */
const PAYLOAD_VERSION = '1.0';

function text(value) {
	if (value === undefined || value === null) return null;
	const trimmed = String(value).trim();
	return trimmed === '' ? null : trimmed;
}

function decimal(value, scale) {
	if (value === undefined || value === null || value === '') return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	return Number(parsed.toFixed(scale));
}

function bool(value) {
	return Number(value) === 1 || value === true;
}

/** Kolumny JSON z MySQL-a bywają stringiem albo obiektem — zależnie od sterownika. */
function jsonArray(value) {
	if (value == null || value === '') return [];
	if (Array.isArray(value)) return value;
	if (typeof value === 'object') return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** `Date` → 'YYYY-MM-DD' bez strefowych niespodzianek; string zostawiamy jak jest. */
function isoDay(value) {
	if (!value) return null;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
	}
	const asText = String(value).trim();
	if (!asText) return null;
	return asText.length >= 10 ? asText.slice(0, 10) : asText;
}

function address(street, zip, city, country) {
	const out = {
		street: text(street),
		zip: text(zip),
		city: text(city),
		country: text(country) ? String(country).toUpperCase() : null
	};
	return Object.values(out).some((v) => v !== null) ? out : null;
}

/**
 * @param {object} customer wiersz z `orgCustomers.getCustomer` (join user + terms + delivery_address)
 * @param {object} [organization] wiersz `organization` — nadawca danych
 * @returns {object} kanoniczny payload
 */
function buildCustomerPayload(customer, organization = null) {
	if (!customer) throw new TypeError('buildCustomerPayload: brak danych klienta');

	const rules = jsonArray(customer.discount_rules)
		.map((rule) => ({
			product_group: text(rule && rule.product_group),
			discount_pct: decimal(rule && rule.discount_pct, 2),
			valid_from: isoDay(rule && rule.valid_from),
			valid_to: isoDay(rule && rule.valid_to)
		}))
		.filter((rule) => rule.product_group !== null && rule.discount_pct !== null);

	return {
		payload_version: PAYLOAD_VERSION,
		source: 'eform',
		organization: organization
			? {
				id: Number(organization.id) || null,
				ident: text(organization.ident),
				name: text(organization.name),
				tax_id: text(organization.tax_id)
			}
			: null,
		customer: {
			// `ident` jest kluczem biznesowym po obu stronach — `id` bazowe idzie
			// tylko informacyjnie, żeby odbiorca nie budował na nim relacji.
			ident: text(customer.ident),
			internal_id: Number(customer.id) || null,
			name: text(customer.client_name),
			tax_id: text(customer.tax_id),
			country: text(customer.country) ? String(customer.country).toUpperCase() : null,
			locale: text(customer.locale),
			active: bool(customer.active),
			contact: {
				email: text(customer.email),
				phone: text(customer.phone),
				preferred_channel: text(customer.preferred_channel) || 'email'
			},
			addresses: {
				registered: address(customer.street, customer.zip, customer.city, customer.country),
				delivery: address(
					customer.delivery_street,
					customer.delivery_zip,
					customer.delivery_city,
					customer.delivery_country
				)
			}
		},
		commercial_terms: {
			price_list: {
				code: text(customer.price_list_code),
				version: text(customer.price_list_version)
			},
			surcharge_version: text(customer.surcharge_version),
			discount_global_pct: decimal(customer.discount_global_pct, 2) || 0,
			discount_rules: rules,
			price_factor: decimal(customer.price_factor, 4) === null ? 1 : decimal(customer.price_factor, 4),
			sub_price_enabled: bool(customer.sub_price_enabled),
			currency: text(customer.currency) || 'EUR',
			vat_rate: decimal(customer.vat_rate, 2),
			payment_terms_days: customer.payment_terms_days == null ? 0 : Number(customer.payment_terms_days),
			credit_limit: decimal(customer.credit_limit, 2)
		},
		compliance: {
			rodo_consent: bool(customer.rodo_consent),
			rodo_consent_at: isoDay(customer.rodo_consent_at),
			terms_version: text(customer.terms_version)
		},
		tags: jsonArray(customer.tags).map((t) => text(t)).filter(Boolean)
	};
}

/**
 * Kanoniczny JSON — klucze posortowane rekurencyjnie, żeby ten sam stan klienta
 * dawał ten sam bajt w bajt string (a więc ten sam hash i klucz idempotencji)
 * niezależnie od kolejności kolumn w zapytaniu.
 *
 * @param {object} payload
 * @returns {string}
 */
function canonicalJson(payload) {
	const sort = (value) => {
		if (Array.isArray(value)) return value.map(sort);
		if (value && typeof value === 'object') {
			return Object.keys(value)
				.sort()
				.reduce((acc, key) => {
					acc[key] = sort(value[key]);
					return acc;
				}, {});
		}
		return value;
	};
	return JSON.stringify(sort(payload));
}

module.exports = { buildCustomerPayload, canonicalJson, PAYLOAD_VERSION };
