'use strict';

/**
 * Klient usługi e-faktur (`einvoice/client.js`) na prawdziwym gnieździe HTTP
 * (serwer-atrapa na 127.0.0.1) — nagłówki, 202 z odpytywaniem, ponowienia,
 * timeout, pliki. Bez usługi Wiktorii i bez sieci LAN.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { EinvoiceClient, EinvoiceTransportError, pathNumber } = require('../einvoice/client');

const KEY = 'klucz-testowy-123';
const PAYLOAD = { schema_version: '1', number: '2026/00017', items: [{ name_de: 'Plissee' }] };

/** Serwer-atrapa: `handler(req, body, n)` dostaje kolejny numer żądania; zwraca adres i listę żądań. */
async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function makeClient(url, extra = {}) {
  const logs = [];
  const sleeps = [];
  const client = new EinvoiceClient({ baseUrl: url, log: (m) => logs.push(m), sleep: async (ms) => { sleeps.push(ms); }, ...extra });
  return { client, logs, sleeps };
}

test('submit 200: X-Api-Key, JSON UTF-8, treść bez zmian', async () => {
  const srv = await startServer((req, res) => json(res, 200, { status: 'ready', mode: 'shadow', number: '2026/00017' }));
  try {
    const { client } = makeClient(srv.url);
    const res = await client.submit(PAYLOAD, KEY);
    assert.equal(res.httpStatus, 200);
    assert.equal(res.body.status, 'ready');
    const [r] = srv.requests;
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/v1/documents');
    assert.equal(r.headers['x-api-key'], KEY);
    assert.match(r.headers['content-type'], /application\/json; charset=utf-8/);
    assert.deepEqual(JSON.parse(r.body), PAYLOAD);
  } finally {
    await srv.close();
  }
});

test('submit 202: odpytuje Location z Retry-After, aż dokument przestanie być w toku', async () => {
  const srv = await startServer((req, res, body, n) => {
    if (req.method === 'POST') return json(res, 202, { status: 'received' }, { Location: '/v1/documents?number=2026%2F00017', 'Retry-After': '2' });
    if (n === 2) return json(res, 202, { status: 'generating' }, { 'Retry-After': '3' });
    return json(res, 200, { status: 'ready' });
  });
  try {
    const { client, sleeps } = makeClient(srv.url);
    const res = await client.submit(PAYLOAD, KEY);
    assert.equal(res.httpStatus, 200);
    assert.deepEqual(sleeps, [2000, 3000]);
    assert.deepEqual(srv.requests.map((r) => `${r.method} ${r.url}`), [
      'POST /v1/documents',
      'GET /v1/documents?number=2026%2F00017',
      'GET /v1/documents?number=2026%2F00017'
    ]);
    assert.ok(srv.requests.every((r) => r.headers['x-api-key'] === KEY));
  } finally {
    await srv.close();
  }
});

test('submit 202 bez końca: po maxPollMs oddaje ostatnie 202 (wróci w następnym przebiegu)', async () => {
  const srv = await startServer((req, res) => json(res, 202, { status: 'generating' }, { 'Retry-After': '5' }));
  try {
    const { client } = makeClient(srv.url, { maxPollMs: 10000 });
    const res = await client.submit(PAYLOAD, KEY);
    assert.equal(res.httpStatus, 202);
    assert.equal(srv.requests.length, 3);
  } finally {
    await srv.close();
  }
});

test('500 i 503 → ponowienie tego samego POST; 401 bez ponowienia', async () => {
  const srv = await startServer((req, res, body, n) => (n === 1 ? json(res, 500, { status: 'error' }) : n === 2 ? json(res, 503, {}) : json(res, 200, { status: 'ready' })));
  try {
    const { client, sleeps, logs } = makeClient(srv.url);
    const res = await client.submit(PAYLOAD, KEY);
    assert.equal(res.httpStatus, 200);
    assert.equal(srv.requests.length, 3);
    assert.equal(srv.requests[0].body, srv.requests[2].body);
    assert.deepEqual(sleeps, [5000, 15000]);
    // W logu skrót treści — nigdy treść ani klucz
    assert.ok(logs.length === 2 && logs.every((l) => !l.includes(KEY) && !l.includes('Plissee')));
  } finally {
    await srv.close();
  }

  const srv401 = await startServer((req, res) => json(res, 401, { detail: 'api key unknown' }));
  try {
    const { client } = makeClient(srv401.url);
    const res = await client.submit(PAYLOAD, 'zly');
    assert.equal(res.httpStatus, 401);
    assert.equal(res.body.detail, 'api key unknown');
    assert.equal(srv401.requests.length, 1);
  } finally {
    await srv401.close();
  }
});

test('422 held i 409 wracają jako wynik, nie wyjątek', async () => {
  const srv = await startServer((req, res) => json(res, 422, { status: 'held', holds: [{ code: 'K_NO_VAT_ID', pl: 'Brak numeru VAT-UE nabywcy', en: '…' }] }));
  try {
    const { client } = makeClient(srv.url);
    const res = await client.check({ ...PAYLOAD, number: null }, KEY);
    assert.equal(res.httpStatus, 422);
    assert.equal(res.body.holds[0].code, 'K_NO_VAT_ID');
    assert.equal(srv.requests[0].url, '/v1/documents/check');
  } finally {
    await srv.close();
  }
});

test('brak odpowiedzi w czasie i odmowa połączenia → EinvoiceTransportError', async () => {
  const srv = await startServer(() => { /* nigdy nie odpowiada */ });
  try {
    const { client } = makeClient(srv.url, { timeoutMs: 200, retryDelaysMs: [] });
    await assert.rejects(client.submit(PAYLOAD, KEY), (err) => err instanceof EinvoiceTransportError && /brak odpowiedzi/.test(err.message));
  } finally {
    await srv.close();
  }
  const { client } = makeClient('http://127.0.0.1:9', { retryDelaysMs: [] });
  await assert.rejects(client.health(), EinvoiceTransportError);
});

test('pliki i unieważnienie: numer w URL-u z „_” zamiast „/”', async () => {
  const pdf = Buffer.from('%PDF-1.7 atrapa');
  const srv = await startServer((req, res) => {
    if (req.url.endsWith('/pdf')) { res.writeHead(200, { 'Content-Type': 'application/pdf', ETag: 'abc' }); return res.end(pdf); }
    return json(res, 200, { status: 'void' });
  });
  try {
    const { client } = makeClient(srv.url);
    assert.equal(pathNumber('2026/00017'), '2026_00017');
    const file = await client.getFile('2026/00017', 'pdf', KEY);
    assert.equal(file.httpStatus, 200);
    assert.deepEqual(file.buffer, pdf);
    const voided = await client.void('2026/00017', 'Fehler', KEY);
    assert.equal(voided.body.status, 'void');
    assert.deepEqual(srv.requests.map((r) => `${r.method} ${r.url}`), ['GET /v1/documents/2026_00017/pdf', 'POST /v1/documents/2026_00017/void']);
    assert.deepEqual(JSON.parse(srv.requests[1].body), { reason: 'Fehler' });
    await assert.rejects(client.void('2026/00017', ' ', KEY), /powód/);
    await assert.rejects(client.getFile('2026/00017', 'zip', KEY), /rodzaj/);
  } finally {
    await srv.close();
  }
});

test('health bez klucza; zły adres usługi odrzucony w konstruktorze', async () => {
  const srv = await startServer((req, res) => json(res, 200, { ok: true }));
  try {
    const { client } = makeClient(srv.url);
    const res = await client.health();
    assert.equal(res.httpStatus, 200);
    assert.equal(srv.requests[0].headers['x-api-key'], undefined);
  } finally {
    await srv.close();
  }
  assert.throws(() => new EinvoiceClient({ baseUrl: '192.168.0.21:5031' }), /adres/);
});
