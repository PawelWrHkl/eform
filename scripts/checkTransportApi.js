#!/usr/bin/env node
'use strict';

/**
 * Kontrola API kosztów transportu Wiktorii (mail z 17.11.2026) na żywym serwerze.
 * Nie wchodzi do `npm test`, bo potrzebuje sieci HKL.
 *
 *   node scripts/checkTransportApi.js
 *
 * TRANSPORT_API_KEY (i ewentualnie TRANSPORT_API_URL) trzymamy tylko w .env.local,
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

// Te testy wymagają formatu zapytania ze specyfikacji Wiktorii (załącznik, mail z 28.10).
test.todo('wycena: te same kwoty co faktury z 16.11');
test.todo('linia rabatu (ilość 0, wartość ujemna) jest przyjmowana');
test.todo('data w tekście linii w formacie DD.MM.RRRR');
