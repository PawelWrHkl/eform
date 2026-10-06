'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tools = require('../tools');
const pages = require('../pages');
const assistant = require('../assistantService');

/** Baza-atrapa: zapamiętuje zapytania, odpowiada kolejnymi wynikami. */
function fakeSelect(answers = []) {
	const calls = [];
	const select = async (sql, params) => {
		calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
		const next = answers.length ? answers.shift() : [];
		return typeof next === 'function' ? next(sql, params) : next;
	};
	select.calls = calls;
	return select;
}

const resolver = () => (key) => ({ 'order.status_order_sent': 'Zamówienie przyjęte', '!production!': 'W trakcie produkcji', 'history_order.title': 'Zamówienie nr.', 'base.orders_history': 'Wysłane zlecenia' }[key] || null);

function deps(select, extra = {}) {
	return {
		select,
		resolver,
		attachCancelDeadlines: async (orders) => { orders.forEach((o) => { if (o.id === 2) o.cancelDeadlineLabel = '06.10.2026 14:00'; }); return orders; },
		cancellationInfo: async () => ({ cancelable: true, deadlineLabel: '06.10.2026 14:00', canCancel: true }),
		deliveryTimes: async () => [{ product_code: 'termin.PLISY', lead_time: '7' }],
		log: () => {},
		...extra
	};
}

const CLIENT = { userId: 42, pin: 'P1', lang: 'pl', isEmployee: false, isGroup: false, isGroupShop: false, isOwner: false, employeeId: null, groupUserId: null, invoices: true, cancelCtx: {} };
const EMPLOYEE = { ...CLIENT, isEmployee: true, employeeId: 7, cancelCtx: { employeePermissions: { can_send_orders: false, can_see_prices: false, can_see_all_orders: false } } };
const SHOP = { ...CLIENT, isGroupShop: true, groupUserId: 3, invoices: false };

// ── zakres ────────────────────────────────────────────────────────────────
test('zakres: klient — swoje; pracownik — tylko utworzone przez siebie; sklep grupy — tylko swoje', () => {
	assert.deepEqual(tools._scopeWhere(CLIENT), { sql: 'o.user_id = ?', params: [42] });
	assert.deepEqual(tools._scopeWhere(EMPLOYEE), { sql: 'o.user_id = ? AND o.employee_id = ?', params: [42, 7] });
	assert.deepEqual(tools._scopeWhere(SHOP), { sql: 'o.user_id = ? AND o.group_user_id = ?', params: [42, 3] });
});

test('scopeFromRequest: pracownik z „Wszystkie zamówienia" widzi całość, bez — tylko swoje; owner w kontekście klienta → klient', () => {
	const base = (over) => ({ session: { user: { userId: 1, pin: 'A', isEmployee: true }, employee: { id: 9 }, employeePermissions: { can_see_all_orders: false }, ...over } });
	assert.equal(tools.scopeFromRequest(base(), 'pl').employeeId, 9);
	assert.equal(tools.scopeFromRequest(base({ employeePermissions: { can_see_all_orders: true } }), 'pl').employeeId, null);
	const owner = { session: { user: { userId: 1, pin: 'OWN', isOwner: true }, context_user: { userId: 55, pin: 'CLI' } } };
	const s = tools.scopeFromRequest(owner, 'pl');
	assert.equal(s.userId, 55);
	assert.equal(s.pin, 'CLI');
});

// ── find_orders ───────────────────────────────────────────────────────────
test('find_orders: zapytanie w zakresie konta, filtr nazwy/numeru i dat, wynik bez cen z odnośnikiem i statusem', async () => {
	const select = fakeSelect([[
		{ id: 2, commision: 'Kowalski salon', created_date: '2026-10-01', sent_date: '2026-10-05 10:00:00', status: 'sent', order_idx: 798, prod_status: '!production!', delivery_date: null, spedition_numbers: '["DPD 123"]', max_prod_days: 12, total_price: 999 },
		{ id: 3, commision: 'Nowak', created_date: '2026-10-03', sent_date: null, status: 'active', order_idx: 801, prod_status: null, delivery_date: null, spedition_numbers: null }
	]]);
	const r = await tools.runTool('find_orders', { query: 'Kow_%', kind: 'any', sent_from: '2026-10-01', sent_to: 'zła data', limit: 5 }, EMPLOYEE, deps(select));
	const q = select.calls[0];
	assert.match(q.sql, /o\.user_id = \? AND o\.employee_id = \?/);
	assert.match(q.sql, /o\.status IN \(\?,\?,\?,\?\)/);
	assert.match(q.sql, /\(o\.commision LIKE \? OR o\.order_idx LIKE \?\)/);
	assert.match(q.sql, /DATE\(o\.sent_date\) >= \?/);
	assert.doesNotMatch(q.sql, /sent_date\) <= \?/, 'zła data jest pomijana');
	assert.deepEqual(q.params.slice(0, 2), [42, 7]);
	assert.ok(q.params.includes('%Kow\\_\\%%'), 'znaki LIKE są escapowane');
	assert.equal(q.params[q.params.length - 1], 6, 'limit + 1 (czy jest więcej)');

	assert.equal(r.orders.length, 2);
	const [sent, offer] = r.orders;
	assert.deepEqual(sent, {
		ref: '[[order:2]]', number: '798', name: 'Kowalski salon', kind: 'sent', created: '2026-10-01', sent: '2026-10-05',
		production_status: 'W trakcie produkcji', shipping_date: null, parcels: ['DPD 123'], estimated_production_days: 12, can_cancel_until: '06.10.2026 14:00',
		copy: '[[action:copy:2]]'
	});
	assert.equal(offer.kind, 'offer');
	assert.ok(!JSON.stringify(r).includes('999'), 'bez cen');
});

test('find_orders: limit przycięty do 10, „more" gdy jest więcej', async () => {
	const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, status: 'active', order_idx: i + 1, commision: 'x', created_date: '2026-10-01' }));
	const select = fakeSelect([rows]);
	const r = await tools.runTool('find_orders', { query: '', kind: 'offer', sent_from: null, sent_to: null, limit: 99 }, CLIENT, deps(select));
	assert.equal(r.orders.length, 10);
	assert.equal(r.more, true);
	assert.match(select.calls[0].sql, /o\.status IN \(\?,\?\)/);
});

// ── get_order ─────────────────────────────────────────────────────────────
test('get_order: zlecenie spoza zakresu → not_found (bez dalszych zapytań)', async () => {
	const select = fakeSelect([[]]);
	const r = await tools.runTool('get_order', { order_id: 5 }, SHOP, deps(select));
	assert.equal(r.error, 'not_found');
	assert.equal(select.calls.length, 1);
	assert.match(select.calls[0].sql, /WHERE o\.id = \? AND o\.user_id = \? AND o\.group_user_id = \?/);
	assert.deepEqual(select.calls[0].params, [5, 42, 3]);
});

test('get_order: pozycje ze statusem i przesyłką, anulowanie, akcja kopiowania', async () => {
	const select = fakeSelect([
		[{ id: 2, commision: 'Salon', created_date: '2026-10-01', sent_date: '2026-10-05', status: 'sent', order_idx: 798, prod_status: '!production!', spedition_numbers: null, user_ident: 'K1' }],
		[{ orderpos: 1, name: 'Kuchnia', department: 'Plisy', group_name: 'VS2' }, { orderpos: 2, commision: 'Salon', department: 'Rolety', group_name: '' }],
		[{ order_pos: '1', status: '!production!', shipping_date: '2026-10-12', parcel_code: 'DPD 555' }]
	]);
	const r = await tools.runTool('get_order', { order_id: 2 }, CLIENT, deps(select));
	assert.deepEqual(r.positions, [
		{ position: 1, room: 'Kuchnia', product: 'Plisy / VS2', status: 'W trakcie produkcji', shipping_date: '2026-10-12', parcel: 'DPD 555' },
		{ position: 2, room: 'Salon', product: 'Rolety' }
	]);
	assert.deepEqual(r.cancel, { possible: true, until: '06.10.2026 14:00', this_account_can_cancel: true });
	assert.equal(r.copy, '[[action:copy:2]]');
	assert.deepEqual(select.calls[2].params, ['K1', '798']);
});

// ── pozostałe narzędzia ───────────────────────────────────────────────────
test('get_account_overview i get_delivery_times', async () => {
	const select = fakeSelect([
		[{ status: 'active', n: 4, last30: 0 }, { status: 'sent', n: 20, last30: 3 }, { status: 'canceled', n: 1, last30: 0 }],
		[]
	]);
	const o = await tools.runTool('get_account_overview', {}, EMPLOYEE, deps(select));
	assert.deepEqual({ ...o, your_permissions: undefined }, { offers: 4, waiting_for_approval: 0, sent_total: 20, sent_last_30_days: 3, canceled: 1, last_sent: null, your_permissions: undefined });
	assert.deepEqual(o.your_permissions, { send_orders: false, see_prices: false, see_all_orders: false });
	const dt = await tools.runTool('get_delivery_times', {}, CLIENT, deps(fakeSelect()));
	assert.deepEqual(dt, { products: [{ product: 'termin.PLISY', days: 7 }] });
});

test('list_employees: niedostępne dla pracownika i sklepu grupy, dla klienta — bez haseł', async () => {
	assert.equal((await tools.runTool('list_employees', {}, EMPLOYEE, deps(fakeSelect()))).error, 'unknown_tool');
	assert.equal((await tools.runTool('list_employees', {}, SHOP, deps(fakeSelect()))).error, 'unknown_tool');
	const select = fakeSelect([[{ name: 'Anna', surname: 'Nowak', login: 'anna', last_login: null, can_send_orders: 1, can_see_prices: 0, can_see_all_orders: 0, password: 'x' }]]);
	const r = await tools.runTool('list_employees', {}, CLIENT, deps(select));
	assert.deepEqual(r.employees, [{ name: 'Anna Nowak', login: 'anna', last_login: null, send_orders: true, see_prices: false, see_all_orders: false }]);
	assert.doesNotMatch(select.calls[0].sql, /password/);
	assert.deepEqual(tools.responsesTools(EMPLOYEE).map((t) => t.name).includes('list_employees'), false);
	assert.ok(tools.responsesTools(CLIENT).every((t) => t.strict === true));
});

test('runTool: nieznane narzędzie, brak konta, wyjątek bazy → obiekt z błędem, bez wyjątku', async () => {
	assert.equal((await tools.runTool('drop_table', {}, CLIENT, deps(fakeSelect()))).error, 'unknown_tool');
	assert.equal((await tools.runTool('find_orders', {}, { ...CLIENT, userId: null }, deps(fakeSelect()))).error, 'no_account');
	const boom = async () => { throw new Error('db down'); };
	assert.equal((await tools.runTool('find_orders', { query: '', kind: 'any', sent_from: null, sent_to: null, limit: 1 }, CLIENT, deps(boom))).error, 'temporary_failure');
});

// ── odnośniki ─────────────────────────────────────────────────────────────
test('resolveRefs: strony z listy konta, zlecenia tylko w zakresie, kopiowanie; reszta znika', async () => {
	const select = fakeSelect([[{ id: 2, order_idx: 798, commision: 'Salon', status: 'sent' }, { id: 3, order_idx: 801, commision: '', status: 'active' }]]);
	const text = 'Proszę otworzyć [[page:history]] albo [[page:group_panel]]. Zlecenie [[order:2]], oferta [[order:3]], cudze [[order:999]]. [[action:copy:2]] [[page:nieistnieje]]';
	const { text: out, refs } = await tools.resolveRefs(text, CLIENT, 'pl', deps(select));
	assert.match(select.calls[0].sql, /o\.id IN \(\?,\?,\?\) AND o\.user_id = \?/);
	assert.deepEqual(refs['[[page:history]]'], { type: 'page', href: '/orders/history', label: 'Wysłane zlecenia' });
	assert.ok(!refs['[[page:group_panel]]'], 'panel grupy niedostępny dla zwykłego klienta');
	assert.deepEqual(refs['[[order:2]]'], { type: 'order', href: '/orders/history/order/2', label: 'Zamówienie nr. 798 „Salon”' });
	assert.equal(refs['[[order:3]]'].href, '/orders/order/3');
	assert.deepEqual(refs['[[action:copy:2]]'], { type: 'copy', orderId: 2, number: '798' });
	assert.ok(!out.includes('[[order:999]]') && !out.includes('[[page:nieistnieje]]') && !out.includes('[[page:group_panel]]'));
	assert.ok(out.includes('[[order:2]]') && out.includes('[[page:history]]'));
});

test('pages.forScope: pracownik bez panelu i pracowników, faktury tylko z modułem, grupa ma panel grupy', () => {
	const keys = (s) => pages.forScope(s, 'pl', { localesDir: require('os').tmpdir() }).map((p) => p.key);
	assert.ok(!keys(EMPLOYEE).includes('employees') && !keys(EMPLOYEE).includes('password'));
	assert.ok(keys(CLIENT).includes('invoices') && !keys(SHOP).includes('invoices'));
	assert.ok(keys({ ...CLIENT, isGroup: true }).includes('group_pending'));
	assert.ok(pages.forScope(CLIENT, 'pl').every((p) => p.href.startsWith('/') && !p.href.startsWith('//')));
});

// ── pętla narzędzi w czacie ───────────────────────────────────────────────
test('ask: model woła find_orders → wynik wraca jako function_call_output → odpowiedź z odnośnikiem', async () => {
	const bodies = [];
	const responses = [
		{ status: 'completed', output: [
			{ type: 'reasoning', id: 'rs_1', encrypted_content: 'xxx' },
			{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'find_orders', arguments: '{"query":"798","kind":"any","sent_from":null,"sent_to":null,"limit":3}' }
		], usage: { input_tokens: 100, output_tokens: 10 } },
		{ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ status: 'answered', answer: 'Zlecenie [[order:2]] jest w produkcji. Lista: [[page:history]]', highlight: null }) }] }], usage: { input_tokens: 200, output_tokens: 20 } }
	];
	const ran = [];
	const logged = [];
	const r = await assistant.ask({}, {
		question: 'Co z zamówieniem 798?', lang: 'pl', account: { type: 'client' }, userKey: 'k', scope: CLIENT, page: { path: '/' }
	}, {
		config: { model: 'm', reasoningEffort: 'low', maxQuestionsPerHour: 100 },
		takeQuota: () => true,
		getKnowledgeText: () => 'KB',
		getContactText: async () => null,
		logEntry: (e) => logged.push(e),
		log: () => {},
		createResponse: async (b) => { bodies.push(JSON.parse(JSON.stringify(b))); return responses.shift(); },
		runTool: async (name, args, scope) => { ran.push({ name, args, scope }); return { orders: [{ ref: '[[order:2]]', number: '798' }] }; },
		resolveRefs: async (text) => ({ text, refs: { '[[order:2]]': { type: 'order', href: '/orders/history/order/2', label: 'Zamówienie nr. 798' } } })
	});

	assert.equal(bodies.length, 2);
	assert.equal(bodies[0].tool_choice, 'auto');
	assert.deepEqual(bodies[0].include, ['reasoning.encrypted_content']);
	assert.ok(bodies[0].tools.some((t) => t.name === 'find_orders'));
	assert.equal(ran[0].name, 'find_orders');
	assert.equal(ran[0].scope, CLIENT, 'narzędzie dostaje zakres konta, nie dane od modelu');
	const second = bodies[1].input;
	assert.ok(second.some((it) => it.type === 'reasoning' && it.encrypted_content === 'xxx'), 'rozumowanie odesłane');
	assert.ok(second.some((it) => it.type === 'function_call' && it.call_id === 'call_1'));
	const outItem = second.find((it) => it.type === 'function_call_output');
	assert.equal(outItem.call_id, 'call_1');
	assert.match(outItem.output, /798/);
	assert.match(bodies[0].input.find((m) => m.role === 'developer').content, /STRONY PORTALU[\s\S]*\[\[page:history\]\]/);

	assert.equal(r.status, 'answered');
	assert.deepEqual(Object.keys(r.refs), ['[[order:2]]']);
	assert.deepEqual(logged[0].tools, [{ name: 'find_orders', args: { query: '798', kind: 'any', sent_from: null, sent_to: null, limit: 3 }, error: null }]);
	assert.deepEqual(logged[0].usage, { in: 300, out: 30 });
});

test('ask: w ostatniej rundzie narzędzia wyłączone (tool_choice none) — model musi odpowiedzieć', async () => {
	const bodies = [];
	const fc = { status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'get_account_overview', arguments: '{}' }] };
	const final = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"status":"answered","answer":"OK","highlight":null}' }] }] };
	const queue = [fc, fc, fc, final];
	await assistant.ask({}, { question: 'x', lang: 'pl', account: { type: 'client' }, userKey: 'k2', scope: CLIENT, page: {} }, {
		config: { model: 'm', reasoningEffort: 'low', maxQuestionsPerHour: 100 }, takeQuota: () => true, getKnowledgeText: () => 'KB', getContactText: async () => null,
		logEntry: () => {}, log: () => {}, runTool: async () => ({}), resolveRefs: async (t) => ({ text: t, refs: {} }),
		createResponse: async (b) => { bodies.push(b.tool_choice); return queue.shift(); }
	});
	assert.deepEqual(bodies, ['auto', 'auto', 'auto', 'none']);
});

test('ask bez zakresu konta (np. eval) — bez narzędzi', async () => {
	let body;
	await assistant.ask({}, { question: 'x', lang: 'pl', account: { type: 'client' }, userKey: 'k3', page: {} }, {
		config: { model: 'm', reasoningEffort: 'low', maxQuestionsPerHour: 100 }, takeQuota: () => true, getKnowledgeText: () => 'KB', getContactText: async () => null, logEntry: () => {}, log: () => {},
		createResponse: async (b) => { body = b; return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"status":"answered","answer":"OK","highlight":null}' }] }] }; }
	});
	assert.equal(body.tools, undefined);
	assert.match(body.input.find((m) => m.role === 'developer').content, /NARZĘDZIA Z DANYMI KONTA: niedostępne/);
});

// ── nowe narzędzia: katalogi, kolejka zatwierdzeń grupy, importy ──────────
const GROUP = { ...CLIENT, isGroup: true };

test('dostępność narzędzi: katalogi nie dla pracownika i sklepu, kolejka zatwierdzeń tylko dla grupy, importy dla wszystkich', () => {
	const names = (scope) => tools.responsesTools(scope).map((t) => t.name);
	assert.ok(names(CLIENT).includes('list_catalogs'));
	assert.ok(!names(EMPLOYEE).includes('list_catalogs'));
	assert.ok(!names(SHOP).includes('list_catalogs'));
	assert.ok(!names(CLIENT).includes('get_pending_approvals'));
	assert.ok(names(GROUP).includes('get_pending_approvals'));
	for (const s of [CLIENT, EMPLOYEE, SHOP, GROUP]) assert.ok(names(s).includes('get_import_log'));
	// Strict mode: każde pole wymagane, bez dodatkowych.
	for (const t of tools.responsesTools(GROUP)) {
		assert.deepEqual([...t.parameters.required].sort(), Object.keys(t.parameters.properties).sort(), t.name);
		assert.equal(t.parameters.additionalProperties, false, t.name);
	}
});

test('list_catalogs: pliki marki konta ze znacznikami pobrania; brak plików → pusta lista', async () => {
	const files = [{ name: 'Rolety 2026.pdf', size: 2048000 }, { name: 'Plisy.pdf', size: 512 }];
	const r = await tools.runTool('list_catalogs', {}, CLIENT, deps(fakeSelect(), { catalogs: async (pin) => (pin === 'P1' ? files : []) }));
	assert.deepEqual(r.catalogs, [
		{ name: 'Rolety 2026.pdf', size_kb: 2000, download: '[[catalog:1]]' },
		{ name: 'Plisy.pdf', size_kb: 1, download: '[[catalog:2]]' }
	]);
	const empty = await tools.runTool('list_catalogs', {}, { ...CLIENT, pin: 'X' }, deps(fakeSelect(), { catalogs: async () => [] }));
	assert.deepEqual(empty.catalogs, []);
	// Pracownik nie ma zakładki „Katalogi" — narzędzia też nie.
	assert.equal((await tools.runTool('list_catalogs', {}, EMPLOYEE, deps(fakeSelect(), { catalogs: async () => files }))).error, 'unknown_tool');
});

test('resolveRefs: [[catalog:N]] → link pobrania z nazwą pliku (zakodowaną w adresie); numer spoza listy znika', async () => {
	const files = [{ name: 'Rolety 2026.pdf', size: 1 }];
	const r = await tools.resolveRefs('Proszę: [[catalog:1]] i [[catalog:7]].', CLIENT, 'pl', deps(fakeSelect(), { catalogs: async () => files }));
	assert.deepEqual(r.refs['[[catalog:1]]'], { type: 'file', href: '/panel/catalogs/download/Rolety%202026.pdf', label: 'Rolety 2026.pdf' });
	assert.equal(r.text, 'Proszę: [[catalog:1]] i .');
	// Pracownik: bez katalogów, znacznik znika.
	const e = await tools.resolveRefs('[[catalog:1]]', EMPLOYEE, 'pl', deps(fakeSelect(), { catalogs: async () => files }));
	assert.deepEqual(e.refs, {});
});

test('get_pending_approvals: tylko zamówienia sklepów tej grupy, ze sklepem i odnośnikiem; inne konta — brak narzędzia', async () => {
	const select = fakeSelect([[{ id: 5, order_idx: 120, commision: 'Salon A', created_date: '2026-10-02 09:00:00', shop_name: 'Sklep Gdańsk', shop_ident: 'GD' }]]);
	const r = await tools.runTool('get_pending_approvals', {}, GROUP, deps(select));
	assert.match(select.calls[0].sql, /gu\.user_id = \? AND o\.user_id = \? AND o\.status = 'pending_approval'/);
	assert.deepEqual(select.calls[0].params.slice(0, 2), [42, 42]);
	assert.deepEqual(r.orders, [{ number: '120', name: 'Salon A', shop: 'Sklep Gdańsk', created: '2026-10-02', ref: '[[order:5]]' }]);
	assert.equal(r.page, '[[page:group_pending]]');
	assert.equal((await tools.runTool('get_pending_approvals', {}, CLIENT, deps(fakeSelect()))).error, 'unknown_tool');
});

test('get_import_log: importy zalogowanego (ident), opcjonalnie tylko błędy; bez identu — pusto', async () => {
	const select = fakeSelect([[{ file_name: 'zam_1.csv', status: 'error', order_id: null, items_count: 0, error_message: 'Brak kolumny\n„szerokość”', created_at: new Date('2026-10-04T08:15:00') }]]);
	const r = await tools.runTool('get_import_log', { only_errors: true }, { ...CLIENT, ident: 'TEST1' }, deps(select));
	assert.match(select.calls[0].sql, /user_ident = \? AND status <> 'success'/);
	assert.equal(select.calls[0].params[0], 'TEST1');
	assert.equal(r.imports[0].ok, false);
	assert.equal(r.imports[0].error, 'Brak kolumny „szerokość”');
	assert.equal(r.imports[0].order, null);
	const none = await tools.runTool('get_import_log', { only_errors: false }, CLIENT, deps(fakeSelect()));
	assert.deepEqual(none.imports, []);
});

// ── ocena odpowiedzi ──────────────────────────────────────────────────────
test('rateMessage: 👍/👎 tylko dla odpowiedzi Eforka z tej rozmowy; do dziennika trafia pytanie i odpowiedź', () => {
	const session = {};
	const state = assistant.getState(session);
	assistant.appendMessage(state, { role: 'user', text: 'Jak skopiować?' });
	assistant.appendMessage(state, { role: 'assistant', text: 'Kliknij „Zamów ponownie”.', status: 'answered' });
	const [q, a] = state.messages;
	const logged = [];
	assert.equal(assistant.rateMessage(state, a.id, 'down', { lang: 'pl' }, { logEntry: (e) => logged.push(e) }), true);
	assert.equal(state.messages[1].feedback, 'down');
	assert.equal(logged[0].type, 'feedback');
	assert.equal(logged[0].question, 'Jak skopiować?');
	assert.equal(logged[0].answer, 'Kliknij „Zamów ponownie”.');
	assert.equal(assistant.rateMessage(state, q.id, 'up', {}, { logEntry: () => {} }), false, 'wiadomość użytkownika');
	assert.equal(assistant.rateMessage(state, 'nieistnieje', 'up', {}, { logEntry: () => {} }), false);
	assert.equal(assistant.rateMessage(state, a.id, 'super', {}, { logEntry: () => {} }), false);
	assert.equal(assistant.publicMessages(state)[1].feedback, 'down');
	assert.ok(assistant.publicMessages(state)[1].id);
});
