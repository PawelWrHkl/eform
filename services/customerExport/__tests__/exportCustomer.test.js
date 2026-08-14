'use strict';

/**
 * Transport eksportu: retry, backoff, idempotencja, audyt.
 *
 * Wszystko na wstrzykniętym `fetch` i atrapie bazy — test nie dotyka sieci ani
 * MySQL-a. `sleep` też jest wstrzyknięty, więc backoff jest sprawdzany co do
 * wartości, a suita nie czeka realnych 21 sekund.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { exportCustomer, idempotencyKey, signBody, BACKOFF_MS } = require('../index');

const SETTINGS = {
	enabled: true,
	url: 'https://example.test/customers',
	token: 'test-token',
	hmacSecret: 'test-secret',
	timeoutMs: 10000,
	attempts: 4
};

const CUSTOMER = {
	id: 42,
	ident: 'HKL-TEST',
	client_name: 'Test',
	organization_id: 3,
	currency: 'EUR',
	active: 1
};

function fakeDb(customer = CUSTOMER) {
	const logs = [];
	return {
		logs,
		async getCustomer() { return customer; },
		async getOrganization() { return { id: 3, ident: 'HKL', name: 'HKL' }; },
		async insertExportLog(entry) { logs.push(entry); return true; }
	};
}

function response(status, body = '') {
	return { status, async text() { return body; } };
}

test('sukces za pierwszym razem: jedno żądanie, jeden wpis w logu', async () => {
	const db = fakeDb();
	const calls = [];
	const result = await exportCustomer(42, { organizationId: 3, trigger: 'create' }, {
		settings: SETTINGS,
		db,
		sleep: async () => {},
		fetch: async (url, options) => {
			calls.push({ url, options });
			return response(201, '{"ok":true}');
		}
	});

	assert.equal(result.ok, true);
	assert.equal(result.status, 'success');
	assert.equal(result.attempts, 1);
	assert.equal(calls.length, 1);
	assert.equal(db.logs.length, 1);
	assert.equal(db.logs[0].status, 'success');
	assert.equal(db.logs[0].httpCode, 201);
	// Payload nigdy nie ląduje w logu — tylko jego hash.
	assert.match(db.logs[0].payloadHash, /^[0-9a-f]{64}$/);
	assert.equal(db.logs[0].payload, undefined);
});

test('nagłówki żądania: Bearer, Idempotency-Key, podpis HMAC i JSON', async () => {
	const db = fakeDb();
	let captured = null;
	await exportCustomer(42, { organizationId: 3 }, {
		settings: SETTINGS,
		db,
		sleep: async () => {},
		fetch: async (url, options) => {
			captured = options;
			return response(200);
		}
	});

	assert.equal(captured.method, 'POST');
	assert.equal(captured.headers.Authorization, 'Bearer test-token');
	assert.equal(captured.headers['Content-Type'], 'application/json; charset=utf-8');
	assert.equal(captured.headers['Idempotency-Key'], idempotencyKey(42, db.logs[0].payloadHash));
	// Podpis liczony z DOKŁADNIE tych bajtów, które lecą w body.
	assert.equal(captured.headers['X-Signature'], signBody(captured.body, SETTINGS.hmacSecret));
	assert.match(captured.headers['X-Signature'], /^sha256=[0-9a-f]{64}$/);
});

test('5xx jest ponawiane z narastającym backoffem, aż do wyczerpania prób', async () => {
	const db = fakeDb();
	const waits = [];
	let calls = 0;

	const result = await exportCustomer(42, {}, {
		settings: SETTINGS,
		db,
		sleep: async (ms) => { waits.push(ms); },
		fetch: async () => { calls += 1; return response(503, 'unavailable'); }
	});

	assert.equal(result.ok, false);
	assert.equal(result.attempts, 4);
	assert.equal(calls, 4);
	// Pierwsza próba natychmiast, potem 1s / 4s / 16s.
	assert.deepEqual(waits, BACKOFF_MS);
	assert.equal(db.logs.length, 4);
	assert.deepEqual(db.logs.map((l) => l.attemptNo), [1, 2, 3, 4]);
});

test('5xx, a potem sukces — kończymy na pierwszej udanej próbie', async () => {
	const db = fakeDb();
	let calls = 0;
	const result = await exportCustomer(42, {}, {
		settings: SETTINGS,
		db,
		sleep: async () => {},
		fetch: async () => {
			calls += 1;
			return calls < 3 ? response(500) : response(200, 'ok');
		}
	});

	assert.equal(result.ok, true);
	assert.equal(result.attempts, 3);
	assert.equal(calls, 3);
});

test('4xx NIE jest ponawiane — złe dane nie naprawią się przez powtórzenie', async () => {
	const db = fakeDb();
	let calls = 0;
	const result = await exportCustomer(42, {}, {
		settings: SETTINGS,
		db,
		sleep: async () => {},
		fetch: async () => { calls += 1; return response(422, 'invalid tax id'); }
	});

	assert.equal(result.ok, false);
	assert.equal(result.attempts, 1);
	assert.equal(calls, 1);
	assert.equal(db.logs.length, 1);
	assert.equal(db.logs[0].httpCode, 422);
});

test('timeout/błąd sieci jest traktowany jak 5xx (ponawiany) i trafia do logu', async () => {
	const db = fakeDb();
	let calls = 0;
	const result = await exportCustomer(42, {}, {
		settings: { ...SETTINGS, attempts: 2 },
		db,
		sleep: async () => {},
		fetch: async () => { calls += 1; throw new Error('The operation was aborted due to timeout'); }
	});

	assert.equal(result.ok, false);
	assert.equal(calls, 2);
	assert.equal(db.logs.length, 2);
	assert.match(db.logs[0].error, /timeout/i);
	assert.equal(db.logs[0].httpCode, null);
});

test('klucz idempotencji jest deterministyczny i zależny od treści', async () => {
	const first = idempotencyKey(42, 'a'.repeat(64));
	const second = idempotencyKey(42, 'a'.repeat(64));
	const other = idempotencyKey(42, 'b'.repeat(64));
	const otherUser = idempotencyKey(43, 'a'.repeat(64));

	assert.equal(first, second);
	assert.notEqual(first, other);
	assert.notEqual(first, otherUser);
	assert.match(first, /^[0-9a-f]{64}$/);
});

test('ten sam klient wysłany dwa razy dostaje ten sam klucz idempotencji', async () => {
	const db = fakeDb();
	const keys = [];
	const send = () => exportCustomer(42, {}, {
		settings: SETTINGS,
		db,
		sleep: async () => {},
		fetch: async (url, options) => {
			keys.push(options.headers['Idempotency-Key']);
			return response(200);
		}
	});

	await send();
	await send();

	assert.equal(keys[0], keys[1]);
});

test('wyłączony eksport kończy się statusem skipped i nie dzwoni nigdzie', async () => {
	const db = fakeDb();
	let called = false;
	const result = await exportCustomer(42, {}, {
		settings: { ...SETTINGS, enabled: false },
		db,
		sleep: async () => {},
		fetch: async () => { called = true; return response(200); }
	});

	assert.equal(result.status, 'skipped');
	assert.equal(result.reason, 'disabled');
	assert.equal(called, false);
	assert.equal(db.logs.length, 0);
});

test('brak konfiguracji (URL/token/sekret) też daje skipped z nazwą braku', async () => {
	const result = await exportCustomer(42, {}, {
		settings: { ...SETTINGS, token: '' },
		db: fakeDb(),
		sleep: async () => {},
		fetch: async () => response(200)
	});

	assert.equal(result.status, 'skipped');
	assert.match(result.reason, /CUSTOMER_EXPORT_TOKEN/);
});

test('nieznany klient nie generuje żądania', async () => {
	const db = fakeDb(null);
	let called = false;
	const result = await exportCustomer(999, {}, {
		settings: SETTINGS,
		db,
		sleep: async () => {},
		fetch: async () => { called = true; return response(200); }
	});

	assert.equal(result.status, 'error');
	assert.equal(result.reason, 'customer_not_found');
	assert.equal(called, false);
});
