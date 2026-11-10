'use strict';
/**
 * Serwis zgłoszeń (index.js) na atrapach: repozytorium, system plików, eksport i maile.
 * Bez MySQL, FTP i SMTP. Sprawdza zakres, walidację per rodzaj, duplikaty, limity,
 * transakcję z plikami, bramkę demo i zachowanie po awarii eksportu.
 */
const test = require('node:test');
const assert = require('node:assert');
const service = require('../index');

const JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(32)]);
const file = (name = 'a.jpg') => ({ buffer: JPG, originalname: name, size: JPG.length });

const ORDER = {
	id: 10, order_idx: '273314', commision: 'Kowalski salon', status: 'sent', prod_status: '!sent!', sent_date: '2026-10-01 10:00:00',
	delivery_date: '2026-10-05', spedition_numbers: '["DPD 1234567890"]', user_id: 42, group_user_id: null, employee_id: null,
	user_ident: 'TCN', client_name: 'TCN GmbH', user_email: 'biuro@tcn.de', user_phone: '+49 1', organization_id: 3, org_ident: 'HKL', org_name: 'HKL',
	addr_name: 'Montaż', addr_street: 'Lange 1', addr_zip: '10115', addr_city: 'Berlin', addr_country: 'DE', end_client: 'Müller'
};
const ITEMS = [
	{ id: 101, orderpos: 1, name: 'Salon', asortment_group_number: '43', department: 'PLISY', group_name: 'COSIFLOR', parameters_short: { data: { ILOSC: 2, MODEL: 'VS2SLC', SZEROKOSC: 1200, WYSOKOSC: 1500, KOLOR: '6950-W25', CENA: 121.08 } }, amount: 2, department_id: 1, name_pl: 'PLISY', name_en: 'PLEATED BLINDS', name_de: 'PLISSEE', name_fr: 'STORES PLISSÉE', name_nl: 'PLISSÉGORDIJNEN' },
	{ id: 102, orderpos: 2, name: 'Kuchnia', asortment_group_number: '39', department: 'ŻALUZJE', group_name: 'ŻALUZJA 16/25', parameters_short: { data: { ILOSC: 1, MODEL: 'U16SD', SZEROKOSC: 800, WYSOKOSC: 900, KOLOR: '4023-16' } }, amount: 1, department_id: 2, name_pl: 'ŻALUZJE' },
	{ id: 103, orderpos: 3, name: 'Łazienka', asortment_group_number: '43', department: 'PLISY', group_name: 'COSIFLOR', parameters_short: { data: { ILOSC: 1 } }, amount: 1, department_id: 1, name_pl: 'PLISY' }
];
const SCOPE = { userId: 42, ident: 'TCN', lang: 'de', isEmployee: false, employeeId: null, groupUserId: null, cancelCtx: { sessionUser: { ident: 'TCN' } } };
const INPUT = {
	type: 'complaint', orderId: 10, commission: 'Kowalski salon', description: 'Mechanismus klemmt',
	items: [{ orderItemId: 101, qty: 1, category: 'mechanism', note: 'lewe okno' }, { orderItemId: 102, qty: 1, category: 'wrong_size' }],
	contactName: 'Hans', contactPhone: '+49 170', contactEmail: 'hans@tcn.de'
};

function fakeRepo(over = {}) {
	const state = { created: null, events: [], messages: [] };
	const repo = {
		state,
		findOrderInScope: async (id) => (id === 10 ? ORDER : null),
		findOrderItems: async () => ITEMS,
		findPositionStatuses: async () => [{ order_pos: '1-1', status: '!sent!', shipping_date: '2026-10-04', parcel_code: 'DPD 1234567890' }, { order_pos: '1-2', status: '!sent!', shipping_date: '2026-10-05', parcel_code: 'DPD 999' }, { order_pos: '2', status: '!sent!', shipping_date: '2026-10-05', parcel_code: '-' }],
		findOpenTicketsForItems: async () => [],
		findDepartments: async () => [],
		findUserSnapshot: async (id) => (id === 42 ? { id: 42, ident: 'TCN', client_name: 'TCN GmbH', email: 'biuro@tcn.de', organization_id: 3, org_ident: 'HKL' } : null),
		countRecentActivity: async () => 0,
		findRecentSimilar: async () => [],
		createTicket: async ({ ticket, items, files, year }) => { state.created = { ticket, items, files, year }; return { id: 7, number: `SRV-${year}-00007` }; },
		addClientMessage: async (m) => { state.messages.push(m); return { eventId: 55 }; },
		addEvent: async (ticketId, ev) => { state.events.push({ ticketId, ...ev }); return state.events.length; },
		updateStatus: async () => 1,
		findTicket: async (id) => (state.created && id === 7 ? { id: 7, number: 'SRV-2026-00007', ...state.created.ticket, order_idx: ORDER.order_idx, order_sent_date: ORDER.sent_date, order_prod_status: ORDER.prod_status, department_pl: null } : null),
		findTicketInScope: async (id, scope) => (state.created && id === 7 && scope.userId === 42 ? { id: 7, number: 'SRV-2026-00007', ...state.created.ticket } : null),
		findTicketItems: async () => (state.created ? state.created.items.map((it, i) => ({ id: i + 1, ...it, parameters_short: ITEMS.find((x) => x.id === it.order_item_id).parameters_short, group_name: 'G', asortment_group_number: '43', department_pl: 'PLISY' })) : []),
		findTicketEvents: async () => state.events.map((e, i) => ({ id: i + 1, created_at: '2026-11-09 12:00:00', ...e })),
		findTicketFiles: async () => (state.created ? state.created.files.map((f, i) => ({ id: i + 1, event_id: null, stored_name: f.storedName, original_name: f.originalName, mime: f.mime, size: f.size })) : []),
		listTickets: async () => [],
		findExportRetries: async () => [],
		...over
	};
	return repo;
}

function fakeFs() {
	const calls = [];
	return {
		calls,
		mkdir: async () => {},
		writeFile: async (p) => calls.push(['write', p]),
		rename: async (a, b) => calls.push(['rename', a, b]),
		unlink: async (p) => calls.push(['unlink', p]),
		rm: async (p) => calls.push(['rm', p])
	};
}

function deps(repo, extra = {}) {
	const sent = { deliver: [], client: [], hkl: [], status: [] };
	return {
		sent,
		repo,
		fsp: fakeFs(),
		outputData: '/out',
		now: () => new Date('2026-11-09T12:00:00Z'),
		log: () => {},
		isDemoIdent: (ident) => /^DEMO_/.test(ident || ''),
		translate: async (t) => `PL: ${t}`,
		exporter: { deliver: async (pkg, opts) => { sent.deliver.push({ number: pkg.number, eventId: opts.eventId }); return 'ftp:/service-test/' + pkg.number; } },
		mailer: {
			sendClient: async (pkg) => { sent.client.push(pkg.number); return { to: pkg.contact.email }; },
			sendHkl: async (pkg) => { sent.hkl.push(pkg.number); return { to: 'serwis@test' }; },
			sendStatus: async (pkg, o) => { sent.status.push(o.status); return { to: pkg.contact.email }; }
		},
		...extra
	};
}

test('reklamacja techniczna: 2 z 3 pozycji, różne kategorie, 2 zdjęcia → numer SRV, jedna transakcja, pliki po COMMIT, eksport i maile po zapisie', async () => {
	const repo = fakeRepo();
	const d = deps(repo);
	const r = await service.createTicket(SCOPE, INPUT, [file('a.jpg'), file('b.jpg')], d);
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(r.ticket.number, 'SRV-2026-00007');
	const { ticket, items, files } = repo.state.created;
	assert.equal(ticket.type, 'complaint');
	assert.equal(ticket.order_id, 10);
	assert.equal(ticket.commission, 'Kowalski salon');
	assert.equal(ticket.user_ident, 'TCN');
	assert.equal(ticket.organization_ident, 'HKL');
	assert.equal(ticket.created_by, 'user:TCN');
	assert.equal(ticket.lang, 'de');
	assert.equal(ticket.description_pl, 'PL: Mechanismus klemmt');
	assert.equal(ticket.end_client, 'Müller');
	assert.deepEqual(items.map((i) => [i.order_item_id, i.order_pos, i.department_id, i.qty, i.category, i.note]), [[101, '1', 1, 1, 'mechanism', 'lewe okno'], [102, '2', 2, 1, 'wrong_size', null]]);
	assert.equal(files.length, 2);
	assert.ok(files.every((f) => f.mime === 'image/jpeg' && /^\d{2}-[0-9a-f]{12}\.jpg$/.test(f.storedName)));
	// pliki: najpierw .tmp, po zapisie rename do katalogu zgłoszenia
	const writes = d.fsp.calls.filter((c) => c[0] === 'write');
	const renames = d.fsp.calls.filter((c) => c[0] === 'rename');
	assert.equal(writes.length, 2);
	assert.ok(writes.every((w) => w[1].startsWith('/out/service/.tmp/')));
	assert.ok(renames.every((w) => w[2].startsWith('/out/service/SRV-2026-00007/')));
	// eksport i maile po COMMIT, każdy z własnym zdarzeniem
	assert.deepEqual(d.sent.deliver, [{ number: 'SRV-2026-00007', eventId: null }]);
	assert.deepEqual(d.sent.client, ['SRV-2026-00007']);
	assert.deepEqual(d.sent.hkl, ['SRV-2026-00007']);
	assert.deepEqual(repo.state.events.map((e) => e.kind), ['export_ok', 'mail_sent', 'mail_sent']);
});

test('ROLLBACK (błąd zapisu) → 500, pliki tymczasowe usunięte, żadnego eksportu ani maila', async () => {
	const repo = fakeRepo({ createTicket: async () => { throw new Error('lock wait'); } });
	const d = deps(repo);
	const r = await service.createTicket(SCOPE, INPUT, [file(), file()], d);
	assert.equal(r.status, 500);
	assert.equal(d.fsp.calls.filter((c) => c[0] === 'unlink').length, 2);
	assert.equal(d.fsp.calls.filter((c) => c[0] === 'rename').length, 0);
	assert.deepEqual(d.sent.deliver, []);
	assert.deepEqual(d.sent.client, []);
});

test('odmowy: cudze zlecenie 403, pozycja z innego zlecenia 422, rodzaj 1–3 dla zlecenia w realizacji 422, anulowane 409, qty > ILOSC 422, transport z 1 zdjęciem 422', async () => {
	const d = deps(fakeRepo());
	assert.equal((await service.createTicket(SCOPE, { ...INPUT, orderId: 99 }, [file()], d)).code, 'order_forbidden');
	const foreignItem = await service.createTicket(SCOPE, { ...INPUT, items: [{ orderItemId: 999, qty: 1, category: 'mechanism' }] }, [file()], d);
	assert.equal(foreignItem.status, 422);
	assert.ok(foreignItem.errors.some((e) => e.code === 'item_not_in_order'));
	const inProgress = deps(fakeRepo({ findOrderInScope: async () => ({ ...ORDER, prod_status: '!production!' }) }));
	const notAllowed = await service.createTicket(SCOPE, INPUT, [file()], inProgress);
	assert.equal(notAllowed.status, 422);
	assert.ok(notAllowed.errors.some((e) => e.code === 'type_not_allowed_for_order'));
	const canceled = deps(fakeRepo({ findOrderInScope: async () => ({ ...ORDER, status: 'canceled' }) }));
	assert.equal((await service.createTicket(SCOPE, INPUT, [file()], canceled)).code, 'order_not_eligible');
	const tooMany = await service.createTicket(SCOPE, { ...INPUT, items: [{ orderItemId: 101, qty: 3, category: 'mechanism' }] }, [file()], d);
	assert.ok(tooMany.errors.some((e) => e.code === 'qty_too_big'));
	const transport = await service.createTicket(SCOPE, { ...INPUT, type: 'transport', items: [{ orderItemId: 101, qty: 1, category: 'parcel_missing' }] }, [file()], d);
	assert.ok(transport.errors.some((e) => e.code === 'min_two_files'));
	assert.deepEqual(d.sent.deliver, [], 'żadna odmowa nie eksportuje');
	assert.equal(d.fsp.calls.filter((c) => c[0] === 'write').length, 0, 'odrzucone zgłoszenie nie zapisuje plików');
});

test('duplikat w 2 minuty (ten sam autor, zlecenie, rodzaj, zestaw pozycji) → 409 z numerem; inny zestaw pozycji przechodzi', async () => {
	const similar = [{ id: 5, number: 'SRV-2026-00005', itemIds: [101, 102] }];
	const d = deps(fakeRepo({ findRecentSimilar: async () => similar }));
	const dup = await service.createTicket(SCOPE, INPUT, [file()], d);
	assert.equal(dup.status, 409);
	assert.equal(dup.ticket.number, 'SRV-2026-00005');
	const other = await service.createTicket(SCOPE, { ...INPUT, items: [INPUT.items[0]] }, [file()], d);
	assert.equal(other.ok, true);
});

test('limit 20 zgłoszeń i dopisków na dobę → 429', async () => {
	const d = deps(fakeRepo({ countRecentActivity: async () => 20 }));
	assert.equal((await service.createTicket(SCOPE, INPUT, [file()], d)).status, 429);
});

test('konto demo: zgłoszenie zapisane, bez eksportu i maili', async () => {
	const repo = fakeRepo({ findOrderInScope: async () => ({ ...ORDER, user_ident: 'DEMO_1A2B3C4D' }) });
	const d = deps(repo);
	const r = await service.createTicket({ ...SCOPE, cancelCtx: { sessionUser: { ident: 'DEMO_1A2B3C4D' } } }, INPUT, [file()], d);
	assert.equal(r.ok, true);
	assert.equal(r.demo, true);
	assert.deepEqual(d.sent.deliver, []);
	assert.deepEqual(d.sent.client, []);
	assert.deepEqual(d.sent.hkl, []);
	assert.deepEqual(repo.state.events, []);
});

test('awaria eksportu nie cofa zgłoszenia: export_failed w dzienniku, maile idą dalej', async () => {
	const repo = fakeRepo();
	const d = deps(repo, { exporter: { deliver: async () => { throw new Error('FTP timeout'); } } });
	const r = await service.createTicket(SCOPE, INPUT, [file()], d);
	assert.equal(r.ok, true);
	assert.deepEqual(repo.state.events.map((e) => e.kind), ['export_failed', 'mail_sent', 'mail_sent']);
	assert.match(repo.state.events[0].message, /FTP timeout/);
});

test('bez numeru zlecenia: komisja + kolekcja + opis, migawka właściciela z konta, order_id NULL', async () => {
	const repo = fakeRepo();
	const d = deps(repo);
	const r = await service.createTicket(SCOPE, { type: 'repair', orderId: null, orderNoText: 'tel. 12.10', commission: 'Nowak', departmentId: 3, description: 'nie działa', contactName: 'A', contactPhone: '1', contactEmail: 'a@b.pl', quoteBeforeRepair: 'false' }, [], d);
	assert.equal(r.ok, true, JSON.stringify(r));
	const t = repo.state.created.ticket;
	assert.equal(t.order_id, null);
	assert.equal(t.order_no_text, 'tel. 12.10');
	assert.equal(t.department_id, 3);
	assert.equal(t.quote_before_repair, 0);
	assert.equal(t.user_ident, 'TCN');
	assert.equal(t.organization_ident, 'HKL');
	assert.deepEqual(repo.state.created.items, []);
	const missing = await service.createTicket(SCOPE, { type: 'repair', commission: 'Nowak', description: 'x', contactName: 'A', contactPhone: '1', contactEmail: 'a@b.pl' }, [], d);
	assert.ok(missing.errors.some((e) => e.field === 'departmentId'));
});

test('pracownik: created_by employee:<id>, employee_id w migawce; admin w kontekście → admin:<ident> -> <klient>', async () => {
	const repo = fakeRepo();
	const d = deps(repo);
	const emp = { ...SCOPE, isEmployee: true, employeeId: 9, cancelCtx: { sessionUser: { isEmployee: true, ident: 'TCN' }, sessionEmployee: { id: 9, login: 'jan' } } };
	await service.createTicket(emp, INPUT, [file()], d);
	assert.equal(repo.state.created.ticket.created_by, 'employee:9 (jan)');
	assert.equal(repo.state.created.ticket.employee_id, 9);
	const adm = { ...SCOPE, cancelCtx: { sessionUser: { isAdmin: true, ident: 'admin' }, contextUser: { ident: 'TCN' } } };
	await service.createTicket(adm, INPUT, [file()], d);
	assert.equal(repo.state.created.ticket.created_by, 'admin:admin -> TCN');
});

test('getOrderForTicket: pozycje z kolekcją, ilością z ILOSC, podpozycjami, paczką i otwartym zgłoszeniem; cudze → null', async () => {
	const d = deps(fakeRepo({ findOpenTicketsForItems: async () => [{ order_item_id: 102, id: 3, number: 'SRV-2026-00003', status: 'submitted' }] }));
	const v = await service.getOrderForTicket(SCOPE, 10, d);
	assert.equal(v.state, 'delivered');
	assert.deepEqual(v.eligibleTypes, ['repair', 'complaint', 'transport', 'delivery']);
	assert.equal(v.order.address, 'Montaż, Lange 1, 10115 Berlin, DE');
	assert.equal(v.order.end_client, 'Müller');
	assert.deepEqual(v.order.parcels.map((p) => p.code), ['1234567890']);
	const [p1, p2] = v.items;
	assert.equal(p1.qty, 2);
	assert.equal(p1.department.pl, 'PLISY');
	assert.equal(p1.summary, 'VS2SLC · 1200×1500 · 6950-W25');
	assert.deepEqual(p1.sub_positions, ['1-1', '1-2']);
	assert.equal(p1.shipping_date, '2026-10-05');
	assert.deepEqual(p1.parcels.map((p) => p.code), ['DPD 1234567890', 'DPD 999']);
	assert.ok(p1.parcels[0].href.includes('dpd'));
	assert.deepEqual(p2.open_ticket, { id: 3, number: 'SRV-2026-00003' });
	assert.equal(await service.getOrderForTicket(SCOPE, 99, d), null);
	assert.ok(!JSON.stringify(v).includes('121.08'), 'bez cen');
});

test('dopisek: cudze → 403, zamknięte → 409, poprawny → transakcja, pliki numerowane dalej, paczka event-<n>, bez maila do klienta', async () => {
	const repo = fakeRepo();
	const d = deps(repo);
	await service.createTicket(SCOPE, INPUT, [file()], d);
	d.sent.client.length = 0; d.sent.hkl.length = 0; d.sent.deliver.length = 0;
	assert.equal((await service.addClientMessage({ ...SCOPE, userId: 1 }, 7, { message: 'x' }, [], d)).status, 403);
	repo.state.created.ticket.status = 'closed';
	assert.equal((await service.addClientMessage(SCOPE, 7, { message: 'x' }, [], d)).code, 'ticket_closed');
	repo.state.created.ticket.status = 'submitted';
	assert.equal((await service.addClientMessage(SCOPE, 7, { message: '' }, [], d)).status, 422);
	const r = await service.addClientMessage(SCOPE, 7, { message: 'dosyłam zdjęcie' }, [file('c.jpg')], d);
	assert.equal(r.ok, true);
	assert.equal(repo.state.messages[0].message, 'dosyłam zdjęcie');
	assert.match(repo.state.messages[0].files[0].storedName, /^02-/, 'numeracja po plikach zgłoszenia');
	assert.deepEqual(d.sent.deliver, [{ number: 'SRV-2026-00007', eventId: 55 }]);
	assert.deepEqual(d.sent.client, []);
	assert.deepEqual(d.sent.hkl, ['SRV-2026-00007']);
});

test('getTicket: poza zakresem null; klient widzi tylko zdarzenia created/client_message/status, admin wszystkie', async () => {
	const repo = fakeRepo();
	const d = deps(repo);
	await service.createTicket(SCOPE, INPUT, [file()], d);
	repo.state.events.unshift({ ticketId: 7, kind: 'created', actor: 'user:TCN' });
	assert.equal(await service.getTicket({ ...SCOPE, userId: 1 }, 7, d), null);
	const client = await service.getTicket(SCOPE, 7, d);
	assert.ok(client.canAddMessage);
	assert.equal(client.items[0].summary, 'VS2SLC · 1200×1500 · 6950-W25');
	const admin = await service.getTicket(null, 7, d, { admin: true });
	assert.ok(admin.events.length >= 4);
});

test('buildPackage: komplet dla HKL bez cen — numer, plik produkcyjny, wiek zlecenia, pozycje ze statusem, opis + PL, kontakt', async () => {
	const repo = fakeRepo();
	const d = deps(repo);
	await service.createTicket(SCOPE, INPUT, [file()], d);
	const pkg = await service.buildPackage(7, { ...d, repo });
	assert.equal(pkg.number, 'SRV-2026-00007');
	assert.equal(pkg.order.production_file, 'HKL_TCN_273314');
	assert.equal(pkg.order.age_days, 39);
	assert.equal(pkg.items[0].shipping_date, '2026-10-05');
	assert.deepEqual(pkg.items[0].parcel_codes, ['DPD 1234567890', 'DPD 999']);
	assert.equal(pkg.description_pl, 'PL: Mechanismus klemmt');
	assert.equal(pkg.contact.email, 'hans@tcn.de');
	assert.equal(pkg.created_by, 'user:TCN');
	assert.ok(!JSON.stringify(pkg).includes('CENA') && !JSON.stringify(pkg).includes('121.08'), 'bez cen (decyzja 22)');
	assert.deepEqual(pkg.items[0].parameters_short, { ILOSC: 2, MODEL: 'VS2SLC', SZEROKOSC: 1200, WYSOKOSC: 1500, KOLOR: '6950-W25' });
});

test('retryFailedExports: ponawia tylko należne, sukces → export_ok, porażka → export_failed; dry-run nic nie wysyła', async () => {
	const repo = fakeRepo({ findExportRetries: async () => [{ id: 7, number: 'SRV-2026-00007', kind: 'export_failed', event_ref: 'FTP timeout', attempts: 1 }] });
	const d = deps(repo);
	await service.createTicket(SCOPE, INPUT, [file()], d);
	repo.state.events.length = 0;
	const dry = await service.retryFailedExports(d, { dryRun: true });
	assert.deepEqual(dry.planned, ['SRV-2026-00007']);
	assert.deepEqual(repo.state.events, []);
	const ok = await service.retryFailedExports(d);
	assert.deepEqual(ok.retried, ['SRV-2026-00007']);
	assert.equal(repo.state.events.at(-1).kind, 'export_ok');
	const bad = await service.retryFailedExports({ ...d, exporter: { deliver: async () => { throw new Error('nadal FTP'); } } });
	assert.equal(bad.failed[0].error, 'nadal FTP');
	assert.equal(repo.state.events.at(-1).kind, 'export_failed');
});

test('changeStatus (admin): nieznany status 422, zapis + mail do klienta ze statusem, demo bez maila', async () => {
	const repo = fakeRepo();
	const d = deps(repo);
	await service.createTicket(SCOPE, INPUT, [file()], d);
	assert.equal((await service.changeStatus(7, { status: 'bogus' }, d)).status, 422);
	const r = await service.changeStatus(7, { status: 'in_progress', message: 'Zajmujemy się', actor: 'admin:admin' }, d);
	assert.equal(r.ok, true);
	assert.deepEqual(d.sent.status, ['in_progress']);
	assert.equal(repo.state.events.at(-1).kind, 'mail_sent');
});
