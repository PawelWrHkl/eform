'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasOfferColumn, markOffer } = require('../orderOffer');

test('markOffer: bez kolumny nic nie zapisuje; z kolumną tylko pierwsze zdarzenie aktywnego zlecenia', async () => {
	const updates = [];
	const update = async (sql, params) => { updates.push({ sql, params }); return { affectedRows: 1 }; };
	assert.equal(await markOffer(5, { select: async () => false, update }), false);
	assert.equal(updates.length, 0, 'produkcja bez migracji: zero zapytań UPDATE');

	assert.equal(await markOffer('5', { select: async () => [{ 1: 1 }], update }), true);
	assert.match(updates[0].sql, /SET offer_at = \? WHERE id = \? AND status = 'active' AND offer_at IS NULL/);
	assert.match(updates[0].params[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'czas jak created_date');
	assert.equal(updates[0].params[1], 5);

	assert.equal(await markOffer(5, { select: async () => [{}], update: async () => ({ affectedRows: 0 }) }), false, 'już oznaczone / wysłane');
	assert.equal(await markOffer(5, { select: async () => { throw new Error('db down'); } }), false, 'błąd bazy nie wywraca PDF-u ani importu');
});

test('hasOfferColumn: pyta information_schema o order.offer_at', async () => {
	let sql = '';
	assert.equal(await hasOfferColumn({ select: async (q) => { sql = q; return [{ 1: 1 }]; } }), true);
	assert.match(sql, /TABLE_NAME = 'order' AND COLUMN_NAME = 'offer_at'/);
});
