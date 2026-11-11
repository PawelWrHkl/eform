'use strict';
/** Adapter do bazy reklamacji HKL (hklAdapter.js) — mapowanie, zapis, idempotencja; FTP/MySQL/smbclient jako atrapy. */
const test = require('node:test');
const assert = require('node:assert');
const adapter = require('../hklAdapter');

const t = (key) => ({ 'service.category.mechanism': 'Mechanizm/obsługa nie działa', 'service.category.wrong_size': 'Niezgodny wymiar', 'service.category.when_delivery': 'Kiedy dostawa?' }[key] || key);
const NOW = new Date('2026-11-10T08:00:00Z');
const PKG = {
	number: 'SRV-2026-00002', id: 2, type: 'complaint', status: 'submitted', category: null, commission: 'PAweł 1', created_at: '2026-11-09T13:54:34.000Z',
	order: { id: 1247, order_idx: '337', production_file: 'HKL_TESTOWY_337', sent_date: '2025-09-17', prod_status: '!sent!', age_days: 418 },
	client: { ident: 'TESTOWY', name: 'Testowy sp. z o.o.', organization_ident: 'HKL', lang: 'de' },
	items: [
		{ pos: '1', group: 'COSIFLOR', group_number: '43', department: { pl: 'PLISY' }, parameters_short: { MODEL: 'VS2SLC', SZEROKOSC: 1200, WYSOKOSC: 1500, KOLOR: '6950-W25' }, qty: 2, category: 'mechanism', note: 'lewe okno' },
		{ pos: '2', group: 'COSIFLOR', group_number: '43', department: { pl: 'PLISY' }, parameters_short: {}, qty: 1, category: 'wrong_size', note: null }
	],
	description: 'Mechanismus klemmt', description_pl: 'Mechanizm się zacina',
	contact: { name: 'Jan', phone: '+48 600', email: 'jan@x.pl' }, product_address: null, end_client: 'Müller', transport: null, repair: null,
	files: [{ id: 1, event_id: null, name: '01-aaa.jpg' }, { id: 2, event_id: null, name: '02-bbb.jpg' }, { id: 3, event_id: 10, name: '03-ccc.jpg' }],
	events: [], message: null, created_by: 'group:TESTOWY'
};

test('mapTicket: kolumny jak w formularzu PHP, kolekcja → ASORTMENTGROUP, wymiary w cm, bez cen', () => {
	const { orders, products } = adapter.mapTicket(PKG, { now: NOW, t, operator: 'eForm', producer: 'HKL', ranid: 'uuid-1' });
	assert.equal(orders.COMMISSION, 'PAweł 1');
	assert.equal(orders.COMMISSION_INTERNAL, 'HKL_TESTOWY_337');
	assert.equal(orders.DEALER, 'TESTOWY');
	assert.equal(orders.CUSTOMER, 'Müller');
	assert.equal(orders.ASORTMENTGROUP, 'Plisy');
	assert.equal(orders.ASORTMENT, 'COSIFLOR');
	assert.equal(orders.COUNT, '3');
	assert.equal(orders.STATE, 'Nowa');
	assert.equal(orders.CLIENT_LANGUAGE, 'DE');
	assert.equal(orders.RANID, 'uuid-1');
	assert.equal(orders.SENT_DATE, '2025-09-17');
	assert.equal(orders.DATE_RECLAMATION, '2026-11-09');
	assert.equal(orders.CLIENTINFOTRANSLATED, 'Mechanizm się zacina');
	assert.match(orders.CLIENTINFO, /^\[eForm SRV-2026-00002\] Reklamacja techniczna\nKontakt: Jan, \+48 600, jan@x.pl\nZlecenie eForm 337 \(plik HKL_TESTOWY_337, wysłane 2025-09-17, 418 dni temu\)\nPozycje: 1 ×2 Mechanizm\/obsługa nie działa \(lewe okno\); 2 ×1 Niezgodny wymiar\n\nMechanismus klemmt$/);
	assert.equal(products.length, 2);
	assert.deepEqual(products[0], { PRODUCT_SUBCOMMISSION: 'PAweł 1 / 1', PRODUCT_NAME: 'COSIFLOR', PRODUCT_CODE: '43', PRODUCT_MODEL: 'VS2SLC', PRODUCT_COLOR: '6950-W25', PRODUCT_EL: '-', PRODUCT_SIZE: '120.0 x 150.0', PRODUCT_RESPONSIBILITY: null, PRODUCT_DECISION: null, PRODUCT_COMMENT: 'Mechanizm/obsługa nie działa: lewe okno (×2)' });
	assert.equal(products[1].PRODUCT_SIZE, '');
	assert.ok(!JSON.stringify({ orders, products }).match(/CENA|121/));
});

test('asortmentGroup: żaluzje po grupie, ff/RZYMSKIE = Raffrollo, działy bez odpowiednika → puste, bez zlecenia z kolekcji', () => {
	const g = (department, group_number) => adapter.asortmentGroup({ items: [{ department: { pl: department }, group_number }] });
	assert.equal(g('ŻALUZJE', '39'), 'Żaluzje 16/25');
	assert.equal(g('ŻALUZJE', '59'), 'Żaluzje drewniane');
	assert.equal(g('ŻALUZJE', '02'), 'Żaluzje 35/50/70');
	assert.equal(g('ROLETY', '75'), 'Rollo');
	assert.equal(g('VERTIKAL', '14'), 'Vertikale');
	assert.equal(g('RZYMSKIE', '24'), 'Raffrollo');
	assert.equal(g('KOMPONENTY', '01'), '');
	assert.equal(adapter.asortmentGroup({ items: [], department: { pl: 'PLISY' } }), 'Plisy');
	assert.equal(adapter.asortmentGroup({ items: [] }), '');
});

test('mapTicket: zapytanie o dostawę bez zlecenia i bez pozycji — kategoria w nagłówku, COUNT 1, numer ręczny', () => {
	const pkg = { ...PKG, type: 'delivery', category: 'when_delivery', order: null, order_no_text: 'tel. 12.10', items: [], department: { pl: 'ROLETY' }, end_client: null, files: [] };
	const { orders, products } = adapter.mapTicket(pkg, { now: NOW, t, operator: 'eForm', producer: 'HKL', ranid: 'u' });
	assert.match(orders.CLIENTINFO, /Zapytanie o dostawę — Kiedy dostawa\?\n.*\nNumer zamówienia podany ręcznie: tel\. 12\.10/s);
	assert.equal(orders.COUNT, '1');
	assert.equal(orders.ASORTMENTGROUP, 'Rollo');
	assert.equal(orders.CUSTOMER, 'Testowy sp. z o.o.');
	assert.equal(orders.SENT_DATE, null);
	assert.equal(products.length, 0);
});

test('mapTicket: CLIENTINFO przycięte do 1500 znaków (limit kolumny)', () => {
	const { orders } = adapter.mapTicket({ ...PKG, description: 'x'.repeat(3000) }, { now: NOW, t, operator: 'eForm', producer: 'HKL', ranid: 'u' });
	assert.equal(orders.CLIENTINFO.length, 1500);
});

function fakeConn() {
	const calls = [];
	return {
		calls,
		beginTransaction: async () => calls.push('BEGIN'),
		commit: async () => calls.push('COMMIT'),
		rollback: async () => calls.push('ROLLBACK'),
		end: async () => calls.push('END'),
		query: async (sql, params) => { calls.push({ sql, params }); return [/^INSERT INTO `orders`/.test(sql) ? { insertId: 777 } : { insertId: 1 }]; }
	};
}

test('importTicket: INSERT orders → ID, products z ORDER_ID w transakcji, pliki przez smbclient do uploads/<RANID>/ z hasłem w środowisku', async () => {
	const conn = fakeConn();
	const smb = [];
	const deps = { execFile: (cmd, args, opts, cb) => { smb.push({ cmd, args, env: opts.env.PASSWD }); cb(null, '', ''); } };
	const cfg = adapter.readConfig({ FTP_HOST: 'h', FTP_USER: 'u', FTP_PASSWORD: 'p', SERVICE_HKL_DB_USER: 'r', SERVICE_HKL_DB_PASSWORD: 'x', SERVICE_HKL_SMB_USER: 'inf', SERVICE_HKL_SMB_PASSWORD: 'tajne' });
	const marker = await adapter.importTicket(PKG, [{ name: '01-aaa.jpg', localPath: '/tmp/x/01-aaa.jpg' }], { conn, cfg, t, now: NOW, deps });
	assert.equal(marker.orders_id, 777);
	assert.match(marker.ranid, /^[0-9a-f-]{36}$/);
	const sqls = conn.calls.filter((c) => c.sql).map((c) => c.sql);
	assert.deepEqual(conn.calls.filter((c) => typeof c === 'string'), ['BEGIN', 'COMMIT']);
	assert.match(sqls[0], /^INSERT INTO `orders` SET \?/);
	assert.equal(conn.calls.filter((c) => c.sql && /products/.test(c.sql)).length, 2);
	assert.equal(conn.calls.find((c) => c.sql && /products/.test(c.sql)).params[0].ORDER_ID, 777);
	assert.equal(smb.length, 1);
	assert.equal(smb[0].cmd, 'smbclient');
	assert.equal(smb[0].env, 'tajne');
	assert.ok(!smb[0].args.join(' ').includes('tajne'), 'hasło nie w argumentach');
	assert.match(smb[0].args.at(-1), new RegExp(`cd reklamacje/uploads; mkdir ${marker.ranid}; cd ${marker.ranid}; put "/tmp/x/01-aaa.jpg" "01-aaa.jpg"`));
});

test('importTicket: błąd INSERT → ROLLBACK, bez smbclient, wyjątek wychodzi', async () => {
	const conn = fakeConn();
	conn.query = async (sql) => { if (/products/.test(sql)) throw new Error('kolumna?'); return [{ insertId: 5 }]; };
	let smbCalled = false;
	const cfg = adapter.readConfig({ FTP_HOST: 'h', FTP_USER: 'u', FTP_PASSWORD: 'p', SERVICE_HKL_DB_USER: 'r', SERVICE_HKL_DB_PASSWORD: 'x', SERVICE_HKL_SMB_USER: 'i', SERVICE_HKL_SMB_PASSWORD: 's' });
	await assert.rejects(adapter.importTicket(PKG, [], { conn, cfg, t, now: NOW, deps: { execFile: () => { smbCalled = true; } } }), /kolumna/);
	assert.ok(conn.calls.includes('ROLLBACK') && !smbCalled);
});

/** Atrapa FTP: drzewo katalogów w pamięci; downloadTo zapisuje bufor do pliku lokalnego. */
function fakeFtp(tree) {
	const fs = require('fs');
	const uploads = [];
	return {
		uploads,
		access: async () => {},
		close: () => {},
		list: async (dir) => {
			const key = dir.replace(/\/$/, '');
			if (key === '/service') return Object.keys(tree).map((name) => ({ name, isDirectory: true }));
			const sub = tree[key.split('/').pop()] || {};
			return Object.keys(sub).map((name) => ({ name, isDirectory: false }));
		},
		downloadTo: async (local, remote) => { const [, dir, name] = /\/service\/([^/]+)\/(.+)$/.exec(remote); fs.writeFileSync(local, tree[dir][name]); },
		uploadFrom: async (stream, remote) => { let buf = ''; for await (const c of stream) buf += c; uploads.push({ remote, data: JSON.parse(buf) }); const [, dir, name] = /\/service\/([^/]+)\/(.+)$/.exec(remote); tree[dir][name] = buf; }
	};
}

const ENV = { FTP_HOST: 'h', FTP_USER: 'u', FTP_PASSWORD: 'p', SERVICE_HKL_DB_USER: 'r', SERVICE_HKL_DB_PASSWORD: 'x', SERVICE_HKL_SMB_USER: 'i', SERVICE_HKL_SMB_PASSWORD: 's', SERVICE_HKL_SYNC_ENABLED: 'true' };

test('runHklSync: dry-run czyta FTP i mapuje, ale nie zapisuje nic (ani MySQL, ani znaczników)', async () => {
	const tree = { 'SRV-2026-00002': { 'ticket.json': JSON.stringify(PKG), '01-aaa.jpg': 'x', '02-bbb.jpg': 'y', 'event-1.json': JSON.stringify({ number: PKG.number, event: 1, text: 'dosyłam', files: ['03-ccc.jpg'], at: '2026-11-09T14:54:40Z' }), '03-ccc.jpg': 'z' } };
	const ftp = fakeFtp(tree);
	const logs = [];
	let dbOpened = false;
	const r = await adapter.runHklSync({ dryRun: true, deps: { env: ENV, ftpClientFactory: () => ftp, createDb: async () => { dbOpened = true; return fakeConn(); }, t, now: () => NOW, log: (m) => logs.push(m) } });
	assert.deepEqual(r.planned, ['SRV-2026-00002']);
	assert.deepEqual(r.imported, ['SRV-2026-00002']);
	assert.deepEqual(r.messages, ['SRV-2026-00002#1']);
	assert.equal(dbOpened, false);
	assert.equal(ftp.uploads.length, 0);
	assert.ok(logs.some((m) => /DRY-RUN SRV-2026-00002: orders .*"ASORTMENTGROUP":"Plisy"/.test(m)));
});

test('runHklSync: import zgłoszenia i dopisku ze znacznikami na FTP; drugi przebieg nic nie robi; błąd jednej paczki nie zatrzymuje innych', async () => {
	const tree = {
		'SRV-2026-00002': { 'ticket.json': JSON.stringify(PKG), '01-aaa.jpg': 'x', '02-bbb.jpg': 'y', 'event-1.json': JSON.stringify({ number: PKG.number, event: 1, text: 'dosyłam', files: ['03-ccc.jpg'], at: '2026-11-09T14:54:40Z' }), '03-ccc.jpg': 'z' },
		'SRV-2026-00003': { 'ticket.json': '{nie json' },
		'SRV-2026-00004': { 'ticket.json': JSON.stringify({ ...PKG, number: 'SRV-2026-00004', items: [], files: [] }), 'hkl-imported.json': JSON.stringify({ orders_id: 1, ranid: 'r' }) }
	};
	const ftp = fakeFtp(tree);
	const conn = fakeConn();
	const smb = [];
	const deps = { env: ENV, ftpClientFactory: () => ftp, createDb: async () => conn, t, now: () => NOW, log: () => {}, execFile: (cmd, args, opts, cb) => { smb.push(args.at(-1)); cb(null, '', ''); } };
	const r = await adapter.runHklSync({ deps });
	assert.deepEqual(r.imported, ['SRV-2026-00002']);
	assert.deepEqual(r.messages, ['SRV-2026-00002#1']);
	assert.equal(r.failed.length, 1);
	assert.equal(r.failed[0].number, 'SRV-2026-00003');
	assert.ok(tree['SRV-2026-00002']['hkl-imported.json'] && tree['SRV-2026-00002']['hkl-imported-event-1.json']);
	assert.equal(JSON.parse(tree['SRV-2026-00002']['hkl-imported.json']).orders_id, 777);
	assert.ok(conn.calls.some((c) => c.sql && /UPDATE `orders` SET CLIENTINFO = LEFT\(CONCAT/.test(c.sql)));
	assert.equal(smb.length, 2, 'pliki zgłoszenia i dopisku');
	assert.match(smb[0], /put ".*01-aaa\.jpg" "01-aaa\.jpg"; put ".*02-bbb\.jpg" "02-bbb\.jpg"/);
	assert.match(smb[1], /03-ccc\.jpg/);
	assert.ok(conn.calls.includes('END'));
	// drugi przebieg: wszystko ma znaczniki (poza uszkodzoną paczką)
	const r2 = await adapter.runHklSync({ deps });
	assert.deepEqual(r2.imported, []);
	assert.deepEqual(r2.messages, []);
	assert.deepEqual(r2.failed.map((f) => f.number), ['SRV-2026-00003']);
});

test('readConfig: domyślnie /service, wyłączony, braki sekretów wymienione', () => {
	const c = adapter.readConfig({ FTP_HOST: 'h', FTP_USER: 'u', FTP_PASSWORD: 'p' });
	assert.equal(c.ftpDir, '/service');
	assert.equal(c.enabled, false);
	assert.equal(c.db.database, 'reklamacje');
	assert.ok(c.problems.some((p) => /SERVICE_HKL_DB_USER/.test(p)) && c.problems.some((p) => /SMB/.test(p)));
	assert.equal(adapter.readConfig({ ...ENV, SERVICE_HKL_SYNC_FTP_DIR: 'service-test/' }).ftpDir, '/service-test');
});

test('smbPut: istniejący katalog (NT_STATUS_OBJECT_NAME_COLLISION, kod ≠ 0) przechodzi; ACCESS_DENIED odrzuca', async () => {
	const cfg = adapter.readConfig({ ...ENV });
	const files = [{ name: 'a.jpg', localPath: '/tmp/a.jpg' }];
	const ok = await adapter.smbPut(cfg, 'r', files, { execFile: (c, a, o, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), 'NT_STATUS_OBJECT_NAME_COLLISION making remote directory \\r\n', '') });
	assert.match(ok, /COLLISION/);
	await assert.rejects(adapter.smbPut(cfg, 'r', files, { execFile: (c, a, o, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), 'NT_STATUS_ACCESS_DENIED opening remote file', '') }), /ACCESS_DENIED/);
	await assert.rejects(adapter.smbPut(cfg, 'r', files, { execFile: (c, a, o, cb) => cb(new Error('spawn smbclient ENOENT'), '', '') }), /ENOENT/);
});
