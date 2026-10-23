'use strict';

/**
 * Przegląd „wystawione / niewystawione" w panelu faktur — okres z adresu
 * i render szablonu (własne środowisko Nunjucks, bez serwera i bazy).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nunjucks = require('nunjucks');

const { resolveOverviewSince, isIsoDate } = require('../http/panel');
const PANEL_LABELS = require('../i18n/panel.json');

const TEMPLATES = path.join(__dirname, '..', '..', '..', 'templates');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(TEMPLATES), { autoescape: true });
const render = (ctx) => env.render('owner/partials/invoice_overview.njk', { L: PANEL_LABELS.pl, ...ctx });

function overview(overrides = {}) {
  return {
    since: '2026-10-23',
    autoSince: '2026-10-23',
    isDefaultSince: true,
    clients: 2,
    totals: { shipped: 5, invoiced: 3, pending: 2 },
    truncated: false,
    rows: [
      { clientId: 11, name: 'Salon <Kowalski>', ident: 'KOW', shipped: 3, invoiced: 1, pending: 2, lastShippedFmt: '22.10.2026', lastInvoiceFmt: '' },
      { clientId: 12, name: 'TCN', ident: 'TCN', shipped: 2, invoiced: 2, pending: 0, lastShippedFmt: '21.10.2026', lastInvoiceFmt: '21.10.2026' }
    ],
    ...overrides
  };
}

test('okres: domyślnie od startu automatu, puste = cały okres, zła data = cały okres', () => {
  assert.equal(resolveOverviewSince(undefined, '2026-10-23'), '2026-10-23');
  assert.equal(resolveOverviewSince(undefined, null), null);
  assert.equal(resolveOverviewSince('', '2026-10-23'), null);
  assert.equal(resolveOverviewSince('2026-09-01', '2026-10-23'), '2026-09-01');
  assert.equal(resolveOverviewSince('2026-02-30', '2026-10-23'), null);
  assert.equal(resolveOverviewSince("2026-01-01' OR 1=1", null), null);
  assert.equal(resolveOverviewSince(['2026-01-01'], null), null);
});

test('data ISO: tylko prawdziwe daty', () => {
  assert.equal(isIsoDate('2026-10-22'), true);
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isIsoDate('2028-02-29'), true);
  assert.equal(isIsoDate('22.10.2026'), false);
  assert.equal(isIsoDate(undefined), false);
});

test('szablon: wiersz na nabywcę, „bez faktury" wyróżnione, link do ekranu nabywcy, nazwy escapowane', () => {
  const html = render({ level: 2, overview: overview() });
  assert.match(html, /Przegląd: wystawione i niewystawione/);
  assert.equal((html.match(/<tr data-client-id=/g) || []).length, 2);
  assert.match(html, /href="\/invoices\/client\/11\?level=2"/);
  assert.match(html, /href="\/invoices\/client\/12\?level=2"/);
  assert.match(html, /Salon &lt;Kowalski&gt;/);
  assert.doesNotMatch(html, /Salon <Kowalski>/);
  assert.match(html, /inv-tag inv-tag--warn">2<\/span>/);
  assert.match(html, /inv-tag inv-tag--ok">0<\/span>/);
  assert.match(html, /<th>Klient<\/th>/);
  assert.match(html, /value="2026-10-23"/);
  assert.match(html, /domyślnie od startu automatu faktur/);
  assert.match(html, /href="\/invoices\?level=2&amp;od="/);
});

test('szablon: poziom 1 — kolumna „Organizacja", link z level=1', () => {
  const html = render({ level: 1, overview: overview() });
  assert.match(html, /<th>Organizacja<\/th>/);
  assert.match(html, /href="\/invoices\/client\/11\?level=1"/);
  assert.match(html, /Organizacje z zamówieniami wysłanymi/);
});

test('szablon: pusto, błąd, obcięta lista, cały okres', () => {
  assert.match(render({ level: 2, overview: overview({ rows: [], clients: 0 }) }), /Brak zamówień wysłanych do klienta w tym okresie/);

  const failed = render({ level: 2, overview: overview({ error: true, rows: [] }) });
  assert.match(failed, /Nie udało się wczytać przeglądu/);
  assert.doesNotMatch(failed, /<table/);

  const cut = render({ level: 2, overview: overview({ truncated: true, clients: 450 }) });
  assert.match(cut, /Pokazano 2 z 450 nabywców/);

  const all = render({ level: 2, overview: overview({ since: null, isDefaultSince: false }) });
  assert.match(all, /· cały okres/);
  assert.match(all, /value=""/);
  assert.doesNotMatch(all, /domyślnie od startu automatu/);
});

test('słownik: etykiety przeglądu we wszystkich językach panelu', () => {
  const keys = Object.keys(PANEL_LABELS.pl).filter((k) => k.startsWith('overview_'));
  assert.ok(keys.length >= 20);
  for (const lang of ['en', 'de']) {
    for (const k of keys) assert.ok(PANEL_LABELS[lang][k], `${lang}.${k}`);
  }
});
