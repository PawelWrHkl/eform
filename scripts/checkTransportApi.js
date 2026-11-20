#!/usr/bin/env node
'use strict';

/**
 * Kontrola API kosztów transportu Wiktorii (mail z 17.11.2026) na żywym serwerze.
 * Nie wchodzi do `npm test`, bo potrzebuje sieci HKL.
 *
 *   node scripts/checkTransportApi.js
 *
 * TRANSPORT_API_KEY (klucz testowy działa tylko z 192.168.0.8) trzymamy tylko w .env.local,
 * bo .env jest automatycznie commitowany. Bez klucza sprawdza tylko autoryzację,
 * ścieżki i metody, a testy z kluczem są pomijane. Odpowiedzi wypisuje w całości,
 * żeby było widać ich format (specyfikacji z załącznika nie ma w repo).
 */

require('dotenv').config({ path: ['.env.local', '.env'].map((f) => require('path').join(__dirname, '..', f)) });
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = (process.env.TRANSPORT_API_URL || 'http://192.168.0.21:5031').replace(/\/+$/, '');
const KEY = process.env.TRANSPORT_API_KEY || '';
const needsKey = { skip: KEY ? false : 'brak TRANSPORT_API_KEY w .env.local' };

async function call(method, path, { key, body } = {}) {
  const headers = key ? { 'X-Api-Key': key } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* treść nie-JSON zostaje w `text` */ }
  return { status: res.status, json, text };
}

test('bez klucza: reguły i wycena odpowiadają 401', async () => {
  assert.equal((await call('GET', '/v1/transport/rules')).status, 401);
  assert.equal((await call('POST', '/v1/transport/quote', { body: {} })).status, 401);
});

test('zły klucz: 401 przed sprawdzeniem treści zapytania', async () => {
  const r = await call('POST', '/v1/transport/quote', { key: 'zly-klucz-kontrola-eform', body: {} });
  assert.equal(r.status, 401, r.text);
});

test('adres bez „/api”: dawne /api/v1/... daje 404', async () => {
  assert.equal((await call('POST', '/api/v1/transport/quote', { body: {} })).status, 404);
});

test('wycena tylko przez POST', async () => {
  assert.equal((await call('GET', '/v1/transport/quote')).status, 405);
});

test('reguły: 200 i wersja reguł', needsKey, async () => {
  const r = await call('GET', '/v1/transport/rules', { key: KEY });
  console.log('GET /v1/transport/rules →', r.status, r.text);
  assert.equal(r.status, 200);
  assert.ok(r.json, 'odpowiedź nie jest JSON-em');
  assert.match(r.text, /version|wersj/i, 'brak wersji reguł');
});

test('puste zapytanie: 422 z listą pól', needsKey, async () => {
  const r = await call('POST', '/v1/transport/quote', { key: KEY, body: {} });
  console.log('POST /v1/transport/quote {} →', r.status, r.text);
  assert.equal(r.status, 422);
  assert.ok(r.json && Object.values(r.json).some((v) => Array.isArray(v) && v.length), 'brak listy błędnych pól');
});

// Kwoty z maila Wiktorii z 19.11 (reguły 2026-11-18.v4.2). Inna kwota = zmiana reguł albo błąd.
const pos = (extra) => ({ client: 'EFORM_KONTROLA', ship_date: '2026-11-16', carrier: 'DPD', country: 'DE', qty: 1, net: 50, ...extra });
async function quote(...positions) {
  const r = await call('POST', '/v1/transport/quote', { key: KEY, body: { positions } });
  assert.equal(r.status, 200, r.text);
  return r.json.charges.map((c) => [c.amount, c.action]);
}

test('wycena: DE poniżej 100 EUR 8,50, Austria 19,00, naprawa 22,00, zastępcza bez kosztu', needsKey, async () => {
  assert.deepEqual(await quote(pos()), [['8.50', 'charge']]);
  assert.deepEqual(await quote(pos({ country: 'AT' })), [['19.00', 'charge']]);
  assert.deepEqual(await quote(pos({ kind: 'repair' })), [['22.00', 'charge']]);
  assert.deepEqual(await quote(pos({ kind: 'replacement', net: 0 })), [['0.00', 'none']]);
});

test('wycena: jedna przesyłka na dwóch fakturach liczy się razem, inny adres = osobna przesyłka', needsKey, async () => {
  assert.deepEqual(await quote(pos({ net: 70, order: 'O1', address: 'A1' }), pos({ net: 66.09, order: 'O2', address: 'A1' })), [['0.00', 'none']]);
  assert.deepEqual(await quote(pos({ net: 70, address: 'A1' }), pos({ net: 66.09, address: 'A2' })), [['8.50', 'charge'], ['8.50', 'charge']]);
});

test('wycena: linia rabatu (ilość 0, wartość ujemna) obniża wartość przesyłki', needsKey, async () => {
  assert.deepEqual(await quote(pos({ net: 120 }), pos({ qty: 0, net: -30 })), [['8.50', 'charge']]);
});

test('tekst linii: data w formacie DD.MM.RRRR', needsKey, async () => {
  const r = await call('POST', '/v1/transport/quote', { key: KEY, body: { positions: [pos()] } });
  assert.match(r.json.charges[0].text_de, /Sendung 16\.11\.2026$/);
});

test('nieznany rodzaj albo przewoźnik: 422', needsKey, async () => {
  assert.equal((await call('POST', '/v1/transport/quote', { key: KEY, body: { positions: [pos({ kind: 'naprawa' })] } })).status, 422);
  assert.equal((await call('POST', '/v1/transport/quote', { key: KEY, body: { positions: [pos({ carrier: 'BUS' })] } })).status, 422);
});

test.todo('próbki 1–3 z załącznika z 19.11 (wymagają plików z próbkami)');
