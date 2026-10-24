'use strict';

/**
 * Filmy wysyłane linkiem (`routes/film.js`) — prawdziwe żądania HTTP do
 * tymczasowego serwera z katalogiem filmów w /tmp. Szablon renderowany własnym
 * środowiskiem Nunjucks (nie przez `nunjucks-setup`, który ładuje server.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const nunjucks = require('nunjucks');

const { createFilmRouter } = require('../film');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const VIDEO = Buffer.from('ftypisom-to-nie-jest-prawdziwy-film-ale-bajty-sie-zgadzaja');
const SRT_PL = '\uFEFF1\r\n00:00:00,600 --> 00:00:05,591\r\nDodajmy klienta i\r\nprześledźmy zamówienie.\r\n\r\n'
  + '2\r\n00:00:43,700 --> 00:00:48,822\r\nCena klienta wynosi 549,46 euro.\r\n';

let server;
let base;
let dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eform-film-'));
  fs.writeFileSync(path.join(dir, 'demo.mp4'), VIDEO);
  fs.writeFileSync(path.join(dir, 'notatka.txt'), 'nie dla świata');
  // Napisy tak, jak przychodzą od tłumacza: SRT z BOM i CRLF, kod języka na końcu nazwy
  fs.writeFileSync(path.join(dir, 'bez-napisow.mp4'), VIDEO);
  fs.mkdirSync(path.join(dir, 'demo_sub'));
  fs.writeFileSync(path.join(dir, 'demo_sub', 'Demo_napisy_PL.srt'), SRT_PL);
  fs.writeFileSync(path.join(dir, 'demo_sub', 'Demo_napisy_DE.srt'), '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHallo\r\n');
  fs.writeFileSync(path.join(dir, 'demo_sub', 'en.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
  fs.writeFileSync(path.join(dir, 'demo_sub', 'en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nstary angielski\n');
  fs.writeFileSync(path.join(dir, 'demo_sub', 'uwagi.txt'), 'nie napisy');

  const app = express();
  nunjucks.configure(TEMPLATES, { autoescape: true, express: app });
  app.set('view engine', 'njk');
  app.use('/film', createFilmRouter({ moviesDir: dir, publicBaseUrl: '' }));
  app.use('/publiczny', createFilmRouter({ moviesDir: dir, publicBaseUrl: 'https://e-orders.eu' }));
  app.use((req, res) => res.status(404).send('404'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('strona: odtwarzacz z plikiem, podgląd linku z adresem bezwzględnym, bez indeksowania', async () => {
  const res = await fetch(`${base}/film/demo`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const html = await res.text();
  assert.match(html, /<video class="film__video" controls playsinline preload="metadata" src="\/film\/demo\.mp4">/);
  assert.match(html, new RegExp(`<meta property="og:video" content="${base}/film/demo\\.mp4">`));
  assert.match(html, new RegExp(`<meta property="og:url" content="${base}/film/demo">`));
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /og:video:secure_url/, 'http — bez secure_url');
});

test('strona za nginx (X-Forwarded-Proto: https) — adresy https i secure_url', async () => {
  const html = await (await fetch(`${base}/film/demo`, { headers: { 'X-Forwarded-Proto': 'https' } })).text();
  assert.match(html, /<meta property="og:video:secure_url" content="https:\/\/127\.0\.0\.1:\d+\/film\/demo\.mp4">/);
});

test('PUBLIC_BASE_URL (produkcja: nginx bez X-Forwarded-Proto) — adresy z ustawienia, nie z żądania', async () => {
  const html = await (await fetch(`${base}/publiczny/demo`)).text();
  assert.match(html, /<meta property="og:url" content="https:\/\/e-orders\.eu\/film\/demo">/);
  assert.match(html, /<meta property="og:video:secure_url" content="https:\/\/e-orders\.eu\/film\/demo\.mp4">/);
  // Sam odtwarzacz zostaje na adresie względnym — działa pod każdą domeną
  assert.match(html, /src="\/film\/demo\.mp4"/);
});

test('plik: cały film z typem video/mp4, nagłówkiem Range i cache na dobę', async () => {
  const res = await fetch(`${base}/film/demo.mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.match(res.headers.get('cache-control'), /max-age=86400/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), VIDEO);
});

test('plik: zapytanie Range → 206 z fragmentem (przewijanie, Safari)', async () => {
  const res = await fetch(`${base}/film/demo.mp4`, { headers: { Range: 'bytes=4-11' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 4-11/${VIDEO.length}`);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), VIDEO.subarray(4, 12).toString());
});

test('nieistniejący film, inne rozszerzenia i próby wyjścia z katalogu → 404', async () => {
  for (const url of ['/film/brak', '/film/brak.mp4', '/film/notatka.txt', '/film/notatka', '/film/..%2Fdemo', '/film/demo.MP4', '/film/de.mo']) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 404, url);
  }
});

test('strona: napisy ze wszystkich języków, nazwy w ich języku, domyślne wg przeglądarki', async () => {
  const html = await (await fetch(`${base}/film/demo`, { headers: { 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' } })).text();
  const tracks = html.match(/<track [^>]*>/g);
  assert.deepEqual(tracks, [
    '<track kind="subtitles" src="/film/demo.de.vtt" srclang="de" label="Deutsch">',
    '<track kind="subtitles" src="/film/demo.en.vtt" srclang="en" label="English">',
    '<track kind="subtitles" src="/film/demo.pl.vtt" srclang="pl" label="Polski" default>'
  ]);
  const defaultOf = async (acceptLanguage) => {
    const headers = acceptLanguage ? { 'Accept-Language': acceptLanguage } : {};
    const page = await (await fetch(`${base}/film/demo`, { headers })).text();
    return (/srclang="(\w+)"[^>]* default>/.exec(page) || [])[1];
  };
  assert.equal(await defaultOf('de-AT,de;q=0.9'), 'de');
  assert.equal(await defaultOf('it-IT,it;q=0.9'), 'en', 'język bez napisów → angielskie');
  assert.equal(await defaultOf('*'), 'en', 'bez preferencji (`*`, domyślne w fetch) → angielskie');
});

test('strona filmu bez katalogu napisów — sam odtwarzacz, bez <track>', async () => {
  const res = await fetch(`${base}/film/bez-napisow`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /<track/);
});

test('napisy: SRT → WebVTT (bez BOM i CRLF, kropki tylko w czasach), typ text/vtt, bez cache', async () => {
  const res = await fetch(`${base}/film/demo.pl.vtt`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(await res.text(), 'WEBVTT\n\n1\n00:00:00.600 --> 00:00:05.591\nDodajmy klienta i\nprześledźmy zamówienie.\n\n'
    + '2\n00:00:43.700 --> 00:00:48.822\nCena klienta wynosi 549,46 euro.\n');
  // Ten sam język w .srt i .vtt — wygrywa gotowy .vtt
  assert.equal(await (await fetch(`${base}/film/demo.en.vtt`)).text(), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
});

test('napisy: nieznany język, wielkie litery, film bez napisów, nie-napisy z katalogu → 404', async () => {
  for (const url of ['/film/demo.fr.vtt', '/film/demo.PL.vtt', '/film/demo.pl.srt', '/film/bez-napisow.pl.vtt', '/film/brak.pl.vtt', '/film/demo.uwagi.vtt', '/film/demo_sub']) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 404, url);
  }
});
