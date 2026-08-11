'use strict';

/**
 * `user.ab_type = without_price` → potwierdzenie zamówienia BEZ żadnych kwot.
 *
 * ⚠️ Testy pilnują tego, co najłatwiej zepsuć przy kolejnych zmianach szablonu:
 * w `order-pdf.njk` wiersz cen (`headers2`) i wiersz `SUB___` NIE są bramkowane
 * flagą `prices` — steruje nimi `clientView`/`showBoth`. Samo `prices: false`
 * nie usuwa więc cen z dokumentu i dlatego istnieje osobna flaga `withoutPrices`.
 *
 * Dane budujemy wspólnym fixture'em i prawdziwym `jsonTextBackToMap`, żeby
 * kształt `cleanOrderItems` zgadzał się z tym, co dostaje szablon w mailu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { isWithoutPrices } = require('../../abType');
const { renderOrderPdfHtml } = require('../pdfGenerator');
const orderService = require('../../orderService.js');
const {
  makeOrderItem, SUB_CENA_VISIBLE, SUB_CENA_LOCKED, REGULAR_CENA
} = require('../../__tests__/fixtures/subPriceOrder');

async function render(extra) {
  const orderItems = [makeOrderItem()];
  const { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems);
  return renderOrderPdfHtml({
    orderDetails: { id: 1, order_idx: 197, commision: 'Salon', comment: '' },
    cleanOrderItems,
    sendData: { total: 'Suma: 1234,00€', total_hidden: 'Ukryta: 999,00€' },
    orderNr: '197', prices: true, maxProdDays: 5,
    showGoldPrices: true, clientView: false, showBoth: true, lang: 'pl',
    ...extra
  });
}

test('rozpoznanie ab_type: oba zapisy, bez wrażliwości na wielkość liter i spacje', () => {
  // ⚠️ W bazie jest `without_price`, w wymaganiu pojawiło się `without_prices` —
  // literówka nie może cicho przywrócić cen na dokumencie klienta.
  ['without_price', 'without_prices', 'WITHOUT_PRICE', ' without_price '].forEach((v) => {
    assert.equal(isWithoutPrices(v), true, String(v));
  });
  ['with_prices', 'standard', '', null, undefined].forEach((v) => {
    assert.equal(isWithoutPrices(v), false, String(v));
  });
});

test('bez flagi dokument zawiera ceny, ceny SUB i sumy', async () => {
  const html = await render({ withoutPrices: false });
  assert.match(html, /class="price"/, 'wiersz cen');
  assert.match(html, new RegExp(REGULAR_CENA.replace('.', '\\.')), 'cena katalogowa');
  assert.match(html, new RegExp(SUB_CENA_VISIBLE), 'cena SUB');
  assert.match(html, /1234,00/, 'suma w stopce');
});

test('z flagą znikają WSZYSTKIE kwoty: row2, SUB, zablokowane, sumy', async () => {
  const html = await render({ withoutPrices: true });
  assert.doesNotMatch(html, /class="price"/, 'żadnej komórki cenowej');
  assert.doesNotMatch(html, new RegExp(REGULAR_CENA.replace('.', '\\.')), 'brak ceny katalogowej');
  assert.doesNotMatch(html, new RegExp(SUB_CENA_VISIBLE), 'brak ceny SUB');
  assert.doesNotMatch(html, new RegExp(SUB_CENA_LOCKED), 'brak kwoty zablokowanej');
  assert.doesNotMatch(html, /price-label gold/, 'brak etykiet kwot zablokowanych');
  assert.doesNotMatch(html, /1234,00|999,00/, 'brak sum w stopce');
});

test('parametry pozycji zostają nietknięte', async () => {
  const zCenami = await render({ withoutPrices: false });
  const bezCen = await render({ withoutPrices: true });
  // Liczba komórek parametrów (row1) musi być identyczna — flaga tnie WYŁĄCZNIE kwoty
  const licz = (html) => (html.match(/<td>/g) || []).length;
  assert.equal(licz(bezCen), licz(zCenami), 'tyle samo komórek parametrów');
  assert.match(bezCen, /order\.total_items|Ilość/i, 'podsumowanie liczby pozycji zostaje');
});

test('rabat nie przecieka do dokumentu bez cen', async () => {
  const html = await render({
    withoutPrices: true, prices: false,
    discountInfo: { type: 'percentage', discountValue: 11, result: '480.37' }
  });
  assert.doesNotMatch(html, /480\.37/, 'kwota po rabacie nie może się pojawić');
});
