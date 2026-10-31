/**
 * Tryb demo (services/demoMode.js): formularz, rozpoznawanie kont demo,
 * zakładanie konta i sprzątanie — na atrapie połączenia, bez bazy.
 */
const test = require('node:test');
const assert = require('node:assert');
const demo = require('../demoMode');

/** Atrapa połączenia mysql2: odpowiedzi po kolei, zapamiętuje zapytania. */
function fakeConnection(responses = []) {
	const calls = [];
	const conn = {
		calls,
		query: async (sql, params) => {
			calls.push({ sql, params });
			const next = responses.shift();
			if (next instanceof Error) throw next;
			return next || [[]];
		},
		beginTransaction: async () => calls.push({ sql: 'BEGIN' }),
		commit: async () => calls.push({ sql: 'COMMIT' }),
		rollback: async () => calls.push({ sql: 'ROLLBACK' }),
		end: () => calls.push({ sql: 'RELEASE' })
	};
	return conn;
}

const deps = (conn, extra = {}) => ({
	getConnection: async () => conn,
	unlink: async () => {},
	outputData: '/mnt/out',
	env: { DEMO_ORGANIZATION: 'LUXANGMBH' },
	log: () => {},
	...extra
});

test('formularz: poprawne dane przechodzą, kraj wielkimi literami', () => {
	const { values, errors } = demo.validateDemoForm({ company: '  Sonnen GmbH ', email: 'a@b.de', country: 'de' });
	assert.deepStrictEqual(errors, []);
	assert.deepStrictEqual(values, { company: 'Sonnen GmbH', email: 'a@b.de', country: 'DE' });
});

test('formularz: brak firmy, zły mail i kraj spoza listy to trzy błędy', () => {
	const { errors } = demo.validateDemoForm({ company: ' ', email: 'nie-mail', country: 'US' });
	assert.deepStrictEqual(errors, ['demo.error_company', 'demo.error_email', 'demo.error_country']);
});

test('konto demo rozpoznajemy tylko po pełnym wzorcu, nie po samym prefiksie', () => {
	assert.ok(demo.isDemoIdent('DEMO_0A1B2C3D'));
	assert.ok(demo.isDemoPin('demo0a1b2c3d'));
	for (const real of ['DEMOLUX', 'DEMO_SHOP', '12345', 'LUXANGMBH', null, undefined]) {
		assert.equal(demo.isDemoIdent(real), false, real);
		assert.equal(demo.isDemoPin(real), false, real);
	}
});

test('limit z jednego IP: piąte konto w godzinie przechodzi, szóste nie, po godzinie znowu tak', () => {
	const env = { DEMO_MAX_PER_IP_HOUR: '5' };
	const t0 = 1_000_000_000;
	for (let i = 0; i < 5; i++) assert.ok(demo.takeIpSlot('10.0.0.1', { now: t0 + i, env }));
	assert.equal(demo.takeIpSlot('10.0.0.1', { now: t0 + 10, env }), false);
	assert.ok(demo.takeIpSlot('10.0.0.2', { now: t0 + 10, env }), 'inne IP ma własny limit');
	assert.ok(demo.takeIpSlot('10.0.0.1', { now: t0 + 3600 * 1000 + 10, env }));
});

test('zakładanie konta: rola demo, pin/ident z tego samego losowania, organizacja z env', async () => {
	const conn = fakeConnection([[[{ id: 5 }]], [[{ active: 0 }]], [{ insertId: 99 }]]);
	const account = await demo.createDemoAccount({ company: 'Firma', email: 'a@b.pl', country: 'PL' }, deps(conn));

	assert.ok(demo.isDemoPin(account.pin) && demo.isDemoIdent(account.ident));
	assert.equal(account.pin.slice(4), account.ident.slice(5));
	assert.deepStrictEqual(conn.calls[0].params, ['LUXANGMBH']);
	const insert = conn.calls[2];
	assert.match(insert.sql, /'demo', NOW\(\)/);
	assert.deepStrictEqual(insert.params.slice(2), ['Firma', 'a@b.pl', 'PL', account.ident, 5]);
	assert.notEqual(insert.params[1], account.password, 'w bazie tylko hash');
	assert.equal(conn.calls.at(-1).sql, 'RELEASE');
});

test('zakładanie konta: limit aktywnych kont → null, bez INSERT-a', async () => {
	const conn = fakeConnection([[[{ id: 5 }]], [[{ active: 30 }]]]);
	assert.equal(await demo.createDemoAccount({ company: 'F', email: 'a@b.pl', country: 'PL' }, deps(conn)), null);
	assert.ok(!conn.calls.some((c) => /INSERT/.test(c.sql)));
});

test('zakładanie konta: brak organizacji z DEMO_ORGANIZATION → błąd z nazwą', async () => {
	const conn = fakeConnection([[[]]]);
	await assert.rejects(
		demo.createDemoAccount({ company: 'F', email: 'a@b.pl', country: 'PL' }, deps(conn)),
		/LUXANGMBH/
	);
	assert.equal(conn.calls.at(-1).sql, 'RELEASE', 'połączenie wraca do puli');
});

test('sprzątanie: tylko potwierdzone konta demo, dzieci przed rodzicami, załączniki z dysku', async () => {
	const conn = fakeConnection([
		[[{ id: 7 }]],
		[[{ attachments: [{ savedName: '11_PLIK_a.pdf' }] }, { attachments: '[{"savedName":"../../etc/x"}]' }, { attachments: null }]],
		[[{ id: 41 }]]
	]);
	const removed = [];
	const n = await demo.purgeDemoUsers([7, 8], deps(conn, { unlink: async (f) => removed.push(f) }));

	assert.equal(n, 1);
	assert.deepStrictEqual(conn.calls[1].params, [[7, 8]]);
	assert.match(conn.calls[1].sql, /role = 'demo' AND pin LIKE 'DEMO%'/);
	const deletes = conn.calls.filter((c) => /^DELETE/.test(c.sql));
	const byUser = deletes.slice(0, -1);
	assert.ok(byUser.every((c) => c.params[0][0] === 7 && c.params[0].length === 1), 'tylko id z bazy');
	assert.match(byUser[0].sql, /order_item/);
	assert.match(byUser.at(-1).sql, /DELETE FROM `user`/);
	assert.deepStrictEqual(deletes.at(-1), { sql: 'DELETE FROM send_address WHERE id IN (?)', params: [[41]] }, 'adres wysyłki bez user_id też znika');
	assert.ok(conn.calls.findIndex((c) => c.sql === 'COMMIT') > conn.calls.indexOf(deletes.at(-1)));
	assert.deepStrictEqual(removed, ['/mnt/out/11_PLIK_a.pdf', '/mnt/out/x'], 'nazwa przycięta do basename');
});

test('sprzątanie: id prawdziwego klienta nic nie usuwa', async () => {
	const conn = fakeConnection([[[]]]);
	assert.equal(await demo.purgeDemoUsers([123], deps(conn)), 0);
	assert.ok(!conn.calls.some((c) => /^DELETE/.test(c.sql)));
	assert.ok(conn.calls.some((c) => c.sql === 'ROLLBACK'));
});

test('sprzątanie: błąd w połowie → ROLLBACK, błąd wychodzi dalej, pliki zostają', async () => {
	const conn = fakeConnection([[[{ id: 7 }]], [[{ attachments: [{ savedName: 'a.pdf' }] }]], [[]], [[]], new Error('lock wait')]);
	const removed = [];
	await assert.rejects(demo.purgeDemoUsers([7], deps(conn, { unlink: async (f) => removed.push(f) })), /lock wait/);
	assert.ok(conn.calls.some((c) => c.sql === 'ROLLBACK'));
	assert.deepStrictEqual(removed, []);
	assert.equal(conn.calls.at(-1).sql, 'RELEASE');
});

test('lista krajów: nazwy w języku strony, posortowane', () => {
	const de = demo.countryOptions('de');
	assert.equal(de.length, demo.DEMO_COUNTRIES.length);
	assert.equal(de.find((c) => c.code === 'DE').name, 'Deutschland');
	const names = de.map((c) => c.name);
	assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'de')));
});
