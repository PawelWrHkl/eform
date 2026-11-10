'use strict';
/** Reguły modułu „Serwis” (rules.js) — czysta logika, bez bazy. */
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../rules');

const base = { commission: 'K-1', contactName: 'Jan', contactPhone: '600', contactEmail: 'jan@firma.pl', description: 'opis' };
const item = (over = {}) => ({ key: 1, qty: 1, maxQty: 2, category: 'mechanism', ...over });
const codes = (errs) => errs.map((e) => `${e.field}:${e.code}`);

test('orderState: sent+!sent! = delivered, inne sent = in_progress, oferta/anulowane/korekta = poza serwisem, brak = none', () => {
	assert.equal(rules.orderState({ status: 'sent', prod_status: '!sent!' }), 'delivered');
	assert.equal(rules.orderState({ status: 'sent', prod_status: '!production!' }), 'in_progress');
	assert.equal(rules.orderState({ status: 'sent', prod_status: null }), 'in_progress');
	assert.equal(rules.orderState({ status: 'canceled', prod_status: '!sent!' }), null);
	assert.equal(rules.orderState({ status: 'active' }), null);
	assert.equal(rules.orderState({ status: 'correction' }), null);
	assert.equal(rules.orderState(null), 'none');
});

test('eligibleTypes: dostarczone → wszystkie 4; w realizacji → tylko zapytanie o dostawę; poza serwisem → nic', () => {
	assert.deepEqual(rules.eligibleTypes('delivered'), ['repair', 'complaint', 'transport', 'delivery']);
	assert.deepEqual(rules.eligibleTypes('in_progress'), ['delivery']);
	assert.deepEqual(rules.eligibleTypes('none'), ['repair', 'complaint', 'transport', 'delivery']);
	assert.deepEqual(rules.eligibleTypes(null), []);
});

test('validate: rodzaje 1–3 dla zlecenia w realizacji odpadają; zapytanie o dostawę przechodzi bez pozycji, opisu i zdjęć', () => {
	for (const type of ['repair', 'complaint', 'transport']) {
		assert.ok(codes(rules.validate({ ...base, type, orderState: 'in_progress', items: [item()], filesCount: 2 })).includes('type:type_not_allowed_for_order'), type);
	}
	assert.deepEqual(rules.validate({ ...base, type: 'delivery', orderState: 'in_progress', description: '', category: 'when_delivery', items: [], filesCount: 0 }), []);
	assert.ok(codes(rules.validate({ ...base, type: 'delivery', orderState: 'in_progress', items: [] })).includes('category:required'));
});

test('validate: tabela wymagań per rodzaj (pozycje, kategoria per pozycja, opis, zdjęcia)', () => {
	const delivered = (type, over = {}) => rules.validate({ ...base, type, orderState: 'delivered', items: [item()], filesCount: 2, ...over });
	assert.deepEqual(delivered('repair', { filesCount: 0 }), [], 'naprawa: zdjęcia tylko zalecane');
	assert.ok(codes(delivered('complaint', { filesCount: 0 })).includes('files:min_one_file'));
	assert.ok(codes(delivered('transport', { filesCount: 1 })).includes('files:min_two_files'));
	assert.deepEqual(delivered('transport', { filesCount: 2, items: [item({ category: 'parcel_missing' })] }), []);
	assert.ok(codes(delivered('complaint', { items: [] })).includes('items:min_one_item'));
	assert.ok(codes(delivered('complaint', { items: [item({ category: 'parcel_missing' })] })).includes('items.category:required'), 'kategoria z cudzej listy');
	assert.ok(codes(delivered('complaint', { description: '' })).includes('description:required'));
	assert.ok(codes(delivered('complaint', { filesCount: 11 })).includes('files:too_many_files'));
});

test('validate: ilość 1..ILOSC, komisja zawsze, kontakt (osoba, telefon, poprawny e-mail)', () => {
	const run = (over) => codes(rules.validate({ ...base, type: 'complaint', orderState: 'delivered', items: [item()], filesCount: 1, ...over }));
	assert.ok(run({ items: [item({ qty: 3, maxQty: 2 })] }).includes('items.qty:qty_too_big'));
	assert.ok(run({ items: [item({ qty: 0 })] }).includes('items.qty:qty_invalid'));
	assert.ok(run({ commission: '  ' }).includes('commission:required'));
	assert.ok(run({ contactName: '' }).includes('contactName:required'));
	assert.ok(run({ contactPhone: '' }).includes('contactPhone:required'));
	assert.ok(run({ contactEmail: 'zly-adres' }).includes('contactEmail:email_invalid'));
	assert.ok(run({ deliveredAt: '12.11.2026', type: 'transport', filesCount: 2, items: [item({ category: 'other' })] }).includes('deliveredAt:date_invalid'));
});

test('validate: bez numeru zlecenia wymagane komisja, kolekcja i opis; pozycje nie', () => {
	const none = (over) => codes(rules.validate({ ...base, type: 'repair', orderState: 'none', items: [], filesCount: 0, departmentId: 3, ...over }));
	assert.deepEqual(none({}), []);
	assert.ok(none({ departmentId: null }).includes('departmentId:required'));
	assert.ok(none({ description: '' }).includes('description:required'));
	assert.deepEqual(none({ type: 'delivery', category: 'other' }), [], 'zapytanie bez zlecenia też z kolekcją i opisem');
});

test('warnings: transport zgłoszony po 7 dniach od dostawy = ostrzeżenie, wysyłka nie jest blokowana', () => {
	const now = new Date('2026-11-09T12:00:00Z');
	assert.deepEqual(rules.warnings({ type: 'transport', deliveredAt: '2026-11-05' }, now), []);
	assert.deepEqual(rules.warnings({ type: 'transport', deliveredAt: '2026-10-20' }, now), ['late_transport_report']);
	assert.deepEqual(rules.warnings({ type: 'complaint', deliveredAt: '2026-10-20' }, now), []);
	assert.deepEqual(rules.validate({ ...base, type: 'transport', orderState: 'delivered', items: [item({ category: 'other' })], filesCount: 2, deliveredAt: '2026-10-20' }), []);
});

test('clientRules: serializowalne do JSON, bez funkcji, z limitami i kategoriami', () => {
	const json = JSON.parse(JSON.stringify(rules.clientRules()));
	assert.deepEqual(json.types, rules.TYPES);
	assert.equal(json.limits.maxFiles, 10);
	assert.equal(json.limits.maxFileBytes, 20 * 1024 * 1024);
	assert.deepEqual(Object.keys(json.categories), ['product', 'transport', 'delivery']);
	assert.ok(json.closed.includes('closed') && json.statuses.includes('submitted'));
});

test('isClosed: zamknięte statusy blokują dopisek klienta', () => {
	assert.ok(rules.isClosed('closed') && rules.isClosed('resolved_rejected') && rules.isClosed('resolved_accepted'));
	assert.ok(!rules.isClosed('submitted') && !rules.isClosed('waiting_for_client'));
});
