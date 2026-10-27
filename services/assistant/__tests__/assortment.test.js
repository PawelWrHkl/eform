'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assortment = require('../assortment');
const tools = require('../tools');

function fakeData() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eforek-asort-'));
	const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
	write('data/pl/group.txt', 'NUM\t1\t2\t3\r\nPRODUCTS\t71,43,20\t75\t99\r\nDESCRIPTION\tPLISY\tROLETY\tPUSTY\r\n');
	write('71/data/pl/prod.txt', 'CODE\t71\nOWNERS\tCOZY\nDESCRIPTION\tEOS\nPARAM_SCRIPTS\t' + 'x'.repeat(5000) + '\nUSERS\tTESTOWY,Inny\n');
	write('43/data/pl/prod.txt', 'CODE\t43\nDESCRIPTION\tCOSIFLOR\nUSERS\tTESTOWY,Kowalski\n');
	write('20/data/pl/prod.txt', 'CODE\t20\nDESCRIPTION\tBASIC\nUSERS\t\n');
	write('75/data/pl/prod.txt', 'CODE\t75\nDESCRIPTION\tCOULISSE\nUSERS\tTESTOWY\n');
	return dir;
}

test('asortyment: działy z grupami wg USERS w prod.txt (bez wielkości liter); pusty USERS = dla wszystkich; dział bez grup znika', () => {
	const dataDir = fakeData();
	assert.deepEqual(assortment.forUser('pl', 'testowy', { dataDir }), [
		{ department: 'PLISY', groups: ['EOS', 'COSIFLOR', 'BASIC'] },
		{ department: 'ROLETY', groups: ['COULISSE'] }
	]);
	assert.deepEqual(assortment.forUser('pl', 'KOWALSKI', { dataDir }), [{ department: 'PLISY', groups: ['COSIFLOR', 'BASIC'] }]);
	// Język bez plików → polskie.
	assert.equal(assortment.forUser('de', 'TESTOWY', { dataDir }).length, 2);
});

test('list_products: asortyment dla identu konta (pin → ident), dostępne dla każdego konta', async () => {
	const seen = [];
	const r = await tools.runTool('list_products', {}, { userId: 1, pin: 'P1', lang: 'pl', cancelCtx: {} }, {
		select: async () => [],
		ownerIdent: async (pin) => { seen.push(pin); return 'TESTOWY'; },
		assortment: (lang, ident) => [{ department: 'PLISY', groups: [ident] }],
		log: () => {}
	});
	assert.deepEqual(seen, ['P1']);
	assert.deepEqual(r, { departments: [{ department: 'PLISY', groups: ['TESTOWY'] }] });
	assert.ok(tools.responsesTools({ isEmployee: true }).some((t) => t.name === 'list_products'));
});
