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
const { isWithoutPrices, resolveAbLang, isClientAb } = require('../../abType');
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

/* ---------------------------------------------------------------- */
/* `user.ab_lang` — wymuszony język potwierdzenia                    */
/* ---------------------------------------------------------------- */

test('ab_lang: normalizacja i odrzucanie nieznanych języków', () => {
  // ⚠️ W bazie wartość zapisana jest WIELKIMI literami (`"NL"`), a aplikacja
  // i pliki tłumaczeń używają małych — bez normalizacji dokument nie znalazłby
  // słownika. Wartość poza listą języków musi cicho ustąpić domyślnemu,
  // a nie wywalić generowania dokumentu.
  assert.equal(resolveAbLang('NL'), 'nl');
  assert.equal(resolveAbLang(' De '), 'de');
  assert.equal(resolveAbLang('pl'), 'pl');
  ['xx', 'polski', '', null, undefined].forEach((v) => {
    assert.equal(resolveAbLang(v), null, String(v));
  });
});

test('ab_lang zmienia język CAŁEGO dokumentu, nie tylko nagłówków', async () => {
  const pl = await render({ lang: 'pl', withoutPrices: false });
  const nl = await render({ lang: 'nl', withoutPrices: false });

  // Nagłówki kolumn stałych są tłumaczone — po nich poznajemy język dokumentu
  assert.match(pl, /Produkt|Grupa/, 'wersja polska');
  assert.match(nl, /Product|Groep/, 'wersja niderlandzka');
  assert.notEqual(pl, nl, 'dokumenty muszą się różnić językiem');
});

test('brak ab_lang nie zmienia zachowania (dokument w języku wołającego)', () => {
  // Reguła „w każdym innym przypadku tak jak wcześniej": brak wartości
  // oznacza brak nadpisania, a nie jakiś język domyślny modułu.
  assert.equal(resolveAbLang(null), null);
  assert.equal(resolveAbLang(undefined), null);
});

/* ---------------------------------------------------------------- */
/* `ab_lang` w treści MAILA (temat, szablon, nazwa załącznika)        */
/* ---------------------------------------------------------------- */

const { buildMailOptions } = require('../mailBot');

const mail = (opts) => buildMailOptions(
  'x@y.pl', 'pl', Buffer.from('%PDF'), [],
  { klient: 'TCN', orderNr: '198', logoPath: '/brak.png', orderDetails: {}, organization: {} },
  null, 'mailTemplate.njk', 'mail.subject', opts
);

test('ab_lang przestawia język całego maila, nie tylko dokumentu', () => {
  // ⚠️ Zgłoszenie z produkcji: dokument szedł już w języku klienta, a temat
  // i treść maila nadal w języku sesji (polskim). `options.abLang` obejmuje
  // temat, treść szablonu ORAZ nazwę załącznika.
  const domyslny = mail({});
  const niderlandzki = mail({ abLang: 'nl' });

  assert.notEqual(niderlandzki.subject, domyslny.subject, 'temat musi się różnić');
  assert.match(niderlandzki.subject, /Orderbevestiging/, 'temat po niderlandzku');
  assert.match(domyslny.subject, /Potwierdzenia zam/i, 'bez flagi zostaje polski');
  assert.match(niderlandzki.attachments[0].filename, /Bestelling/, 'nazwa załącznika też');
});

test('ab_lang w mailu: normalizacja wielkich liter i odporność na literówkę', () => {
  assert.match(mail({ abLang: 'EN' }).subject, /Order Confirmation/, '„EN" → en');
  // Nieznany język nie może wysłać maila bez tłumaczeń — wracamy do języka wołającego
  assert.match(mail({ abLang: 'xx' }).subject, /Potwierdzenia zam/i, 'nieznany → domyślny');
  assert.match(mail({ abLang: null }).subject, /Potwierdzenia zam/i, 'brak → domyślny');
});

/* ---------------------------------------------------------------- */
/* `user.client_ab` — potwierdzenie wprost do klienta                */
/* ---------------------------------------------------------------- */

test('client_ab: rozpoznanie wartości z kolumny tinyint(1)', () => {
  // ⚠️ Kolumna jest `tinyint(1)`, więc z bazy przychodzi 0/1 (a nie boolean).
  // Odczyt musi też przetrwać string ('1' z formularza) i wartość spoza zakresu.
  [1, '1', true, 'true'].forEach((v) => assert.equal(isClientAb(v), true, String(v)));
  [0, '0', false, null, undefined, '', 2, 'nie'].forEach((v) => assert.equal(isClientAb(v), false, String(v)));
});
