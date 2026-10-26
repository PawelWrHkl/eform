'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tts = require('../tts');

const cfg = (over = {}) => ({ enabled: true, url: 'http://tts', model: 'm', voice: 'v', timeoutMs: 1000, maxCharsPerDay: 100, ...over });

function fakeRes() {
	const res = { headers: {}, chunks: [], ended: false, statusCode: 200 };
	res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
	res.write = (b) => { res.chunks.push(Buffer.from(b)); };
	res.end = (b) => { if (b) res.chunks.push(Buffer.from(b)); res.ended = true; };
	return res;
}
function fakeFetch(bytes, calls, status = 200) {
	return async (url, opts) => {
		calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
		let sent = false;
		return {
			ok: status < 400,
			status,
			text: async () => 'err',
			body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(bytes) })) }) }
		};
	};
}

test('clean: bez znaczników [[…]], emoji i nadmiarowych spacji; najwyżej 700 znaków', () => {
	assert.equal(tts.clean('Zamówienie [[order:5]]  jest 🐶 tutaj.\n'), 'Zamówienie jest tutaj.');
	assert.equal(tts.clean('a'.repeat(900)).length, 700);
});

test('prepare: wyłączone / pusty tekst / limit dzienny na osobę (powtórka z pamięci nie liczy się do limitu)', async () => {
	assert.throws(() => tts.prepare('x', 'pl', 'u', { config: cfg({ enabled: false }), apiKey: 'k' }), (e) => e.code === 'tts_disabled' && e.status === 404);
	assert.throws(() => tts.prepare('  [[page:offers]] ', 'pl', 'u', { config: cfg(), apiKey: 'k' }), (e) => e.code === 'empty');
	const c = cfg({ maxCharsPerDay: 20 });
	const a = tts.prepare('Dziesięć znaków', 'pl', 'limit-user', { config: c, apiKey: 'k' }); // 15 znaków
	assert.ok(a.id);
	assert.throws(() => tts.prepare('Kolejne zdanie', 'pl', 'limit-user', { config: c, apiKey: 'k' }), (e) => e.code === 'limit' && e.status === 429);
	assert.ok(tts.prepare('x', 'pl', 'inny-user', { config: c, apiKey: 'k' }).id, 'limit jest per osoba');
	// Nagranie trafia do pamięci — ten sam tekst ponownie nie liczy się do limitu.
	await tts.stream(a.id, fakeRes(), { config: c, apiKey: 'k', fetch: fakeFetch([1, 2, 3], []) });
	assert.ok(tts.prepare('Dziesięć znaków', 'pl', 'limit-user', { config: c, apiKey: 'k' }).id);
});

test('stream: nagranie strumieniem z OpenAI (model, głos, język w instrukcji), drugi raz z pamięci bez zapytania', async () => {
	const c = cfg({ maxCharsPerDay: 1000 });
	const calls = [];
	const { id } = tts.prepare('Guten Tag, ich bin Eforek.', 'de', 'u2', { config: c, apiKey: 'KEY' });
	const res = fakeRes();
	await tts.stream(id, res, { config: c, apiKey: 'KEY', fetch: fakeFetch([9, 8, 7], calls) });
	assert.equal(res.headers['content-type'], 'audio/mpeg');
	assert.deepEqual([...Buffer.concat(res.chunks)], [9, 8, 7]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].auth, 'Bearer KEY');
	assert.equal(calls[0].body.model, 'm');
	assert.equal(calls[0].body.voice, 'v');
	assert.equal(calls[0].body.input, 'Guten Tag, ich bin Eforek.');
	assert.match(calls[0].body.instructions, /po niemiecku/);
	const again = tts.prepare('Guten Tag, ich bin Eforek.', 'de', 'u2', { config: c, apiKey: 'KEY' });
	const res2 = fakeRes();
	await tts.stream(again.id, res2, { config: c, apiKey: 'KEY', fetch: fakeFetch([0], calls) });
	assert.equal(calls.length, 1, 'z pamięci — bez drugiego zapytania');
	assert.deepEqual([...Buffer.concat(res2.chunks)], [9, 8, 7]);
});

test('stream: nieznane id → 404; błąd OpenAI → 502', async () => {
	await assert.rejects(tts.stream('nie-ma', fakeRes(), { config: cfg() }), (e) => e.status === 404);
	const c = cfg({ maxCharsPerDay: 1000 });
	const { id } = tts.prepare('Błąd dostawcy.', 'pl', 'u3', { config: c, apiKey: 'k' });
	await assert.rejects(tts.stream(id, fakeRes(), { config: c, apiKey: 'k', fetch: fakeFetch([], [], 500) }), (e) => e.status === 502);
});
