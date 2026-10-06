'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResponse, _retryDelay } = require('../openaiClient');

const cfg = { apiKey: 'k', apiUrl: 'http://x', timeoutMs: 1000 };
const json = (status, body, headers = {}) => ({
	ok: status < 400,
	status,
	headers: { get: (n) => headers[n.toLowerCase()] ?? null },
	json: async () => body
});
const limited = (msg = 'Rate limit reached … Please try again in 62ms.') => json(429, { error: { message: msg, code: 'rate_limit_exceeded' } });

test('429 z limitu na minutę → ponawia (czas z treści błędu), potem zwraca odpowiedź', async () => {
	const waits = [];
	const queue = [limited(), limited('Please try again in 1.334s.'), json(200, { status: 'completed', output: [] })];
	const out = await createResponse({}, cfg, { fetch: async () => queue.shift(), sleep: async (ms) => { waits.push(ms); } });
	assert.equal(out.status, 'completed');
	assert.equal(waits.length, 2);
	assert.ok(waits[0] >= 62 + 150 && waits[0] < 62 + 400, `pierwsze czekanie ${waits[0]}`);
	assert.ok(waits[1] >= 1334 + 150 && waits[1] < 1334 + 400, `drugie czekanie ${waits[1]}`);
});

test('po 4 próbach poddaje się z błędem 429', async () => {
	let calls = 0;
	await assert.rejects(
		createResponse({}, cfg, { fetch: async () => { calls++; return limited(); }, sleep: async () => {} }),
		(err) => err.status === 429
	);
	assert.equal(calls, 4);
});

test('brak środków (insufficient_quota) i błędy 400 — bez ponawiania', async () => {
	for (const res of [json(429, { error: { message: 'quota', code: 'insufficient_quota' } }), json(400, { error: { message: 'bad', code: 'invalid' } })]) {
		let calls = 0;
		await assert.rejects(createResponse({}, cfg, { fetch: async () => { calls++; return res; }, sleep: async () => {} }));
		assert.equal(calls, 1);
	}
});

test('czas czekania: nagłówek retry-after-ms ma pierwszeństwo, górny limit 5 s', () => {
	assert.ok(_retryDelay(json(429, {}, { 'retry-after-ms': '700' }), 'try again in 3s', 1) < 1200);
	assert.equal(_retryDelay(null, 'Please try again in 20s.', 1), 5000);
	assert.ok(_retryDelay(null, '', 2) >= 1000);
});
