'use strict';

/**
 * Pozycja w PDF-ie potwierdzenia jest NIEROZDZIELNA.
 *
 * ⚠️ Zgłoszenie z produkcji: wiersz z parametrami zostawał na jednej stronie,
 * a wiersz z cenami tej samej pozycji przechodził na następną. Warunkiem
 * naprawy jest struktura: każda pozycja we WŁASNYM `<tbody class="pos">`,
 * bo `break-inside: avoid` działa na grupę wierszy, a nie na luźne `<tr>`.
 * Gdyby ktoś wrócił do jednego wspólnego `<tbody>`, reguła CSS przestanie
 * cokolwiek chronić — i tego pilnują te testy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderOrderPdfHtml } = require('../pdfGenerator');
const orderService = require('../../orderService.js');
const { makeOrderItem } = require('../../__tests__/fixtures/subPriceOrder');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles', 'order-pdf.css'), 'utf8');

async function render(extra = {}, ileP = 3) {
  const orderItems = Array.from({ length: ileP }, () => makeOrderItem());
  const { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems);
  return renderOrderPdfHtml({
    orderDetails: { id: 1, order_idx: 197, commision: 'Salon', comment: '' },
    cleanOrderItems,
    sendData: { total: 'Suma: 1234,00€' },
    orderNr: '197', prices: true, maxProdDays: 5,
    showGoldPrices: true, clientView: false, showBoth: true, lang: 'pl',
    ...extra
  });
}

test('każda pozycja ma własny <tbody class="pos">', async () => {
  const html = await render({}, 4);
  const otwarcia = html.match(/<tbody class="pos[^"]*">/g) || [];
  const zamkniecia = html.match(/<\/tbody>/g) || [];
  assert.equal(otwarcia.length, 4, 'jeden tbody na pozycję, nie jeden na całą tabelę');
  assert.equal(zamkniecia.length, 4, 'tagi muszą się bilansować');
});

test('wiersz parametrów i wiersze cen tej samej pozycji są w JEDNYM tbody', async () => {
  const html = await render({}, 2);
  const bloki = html.split(/<tbody class="pos[^"]*">/).slice(1);
  assert.equal(bloki.length, 2);
  bloki.forEach((blok, i) => {
    const doKonca = blok.slice(0, blok.indexOf('</tbody>'));
    const wiersze = (doKonca.match(/<tr>/g) || []).length;
    const cenowe = (doKonca.match(/class="price"/g) || []).length;
    assert.ok(wiersze >= 2, `pozycja ${i + 1}: oczekiwany wiersz parametrów i co najmniej jeden cenowy`);
    assert.ok(cenowe > 0, `pozycja ${i + 1}: komórki z cenami muszą być w tym samym tbody`);
  });
});

test('pasek co drugą pozycję jest oparty na klasie, nie na nth-child', async () => {
  const html = await render({}, 4);
  // ⚠️ Po rozbiciu na tbody per pozycja `tr:nth-child(even)` liczyłby wiersze
  // od nowa w każdej pozycji i szary byłby zawsze wiersz cen.
  assert.equal((html.match(/class="pos pos--alt"/g) || []).length, 2, 'co druga pozycja');
  assert.ok(!/tbody tr:nth-child\(even\)/.test(CSS), 'stara reguła pasowania musi być usunięta');
  assert.match(CSS, /#table tbody\.pos--alt\s*\{/, 'pasek nadawany po klasie pozycji');
});

test('CSS zabrania łamania wewnątrz pozycji i powtarza nagłówek tabeli', () => {
  const bezBiałych = CSS.replace(/\s+/g, ' ');
  assert.match(bezBiałych, /#table tbody\.pos \{[^}]*break-inside: avoid/, 'grupa wierszy pozycji');
  assert.match(bezBiałych, /#table tbody\.pos \{[^}]*page-break-inside: avoid/, 'starsza właściwość dla zgodności');
  assert.match(bezBiałych, /#table tr \{[^}]*break-inside: avoid/, 'pojedynczy wiersz też się nie dzieli');
  // Przy większej liczbie stron kolumny bez nagłówka są nieczytelne.
  assert.match(bezBiałych, /#table thead \{[^}]*display: table-header-group/);
});

test('reguły podziału są poza @media print — obowiązują też w załączniku HTML', () => {
  const odReguly = CSS.indexOf('#table tbody.pos {');
  assert.ok(odReguly !== -1, 'reguła istnieje');

  // Wyznaczamy prawdziwy zakres bloku @media print (dopasowanie nawiasów),
  // a nie „gdzieś dalej w pliku".
  const start = CSS.indexOf('@media print');
  if (start === -1) return;
  let i = CSS.indexOf('{', start);
  let poziom = 0;
  let koniec = -1;
  for (; i < CSS.length; i++) {
    if (CSS[i] === '{') poziom++;
    else if (CSS[i] === '}') { poziom--; if (poziom === 0) { koniec = i; break; } }
  }
  assert.ok(koniec !== -1, 'blok @media print jest domknięty');
  // ⚠️ `page.pdf()` renderuje w trybie print, ale ten sam arkusz obsługuje też
  // podglądowy załącznik .html — zamknięcie reguły w @media zabrałoby ją tam.
  assert.ok(odReguly < start || odReguly > koniec, 'reguła nie leży wewnątrz @media print');
});

test('struktura trzyma się także bez cen (ab_type = without_price)', async () => {
  const html = await render({ withoutPrices: true }, 3);
  assert.equal((html.match(/<tbody class="pos[^"]*">/g) || []).length, 3);
  assert.equal((html.match(/<\/tbody>/g) || []).length, 3);
  assert.equal((html.match(/class="price"/g) || []).length, 0, 'bez cen, ale struktura pozycji zachowana');
});
