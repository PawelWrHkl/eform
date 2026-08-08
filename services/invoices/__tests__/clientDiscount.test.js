'use strict';

/**
 * Rabat salonu dla odbiorcy końcowego (poziom 3).
 *
 * ⚠️ Rabat jest na CAŁYM zamówieniu, a VAT liczy się per grupa stawek — testy
 * pilnują, że rozkład na pozycje sumuje się co do grosza i że rabat nie
 * wycieka na relacje, w których nie obowiązuje.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveClientDiscount, applyClientDiscount } = require('../core/clientDiscount');
const { InvoiceCalculator } = require('../core/calculator');

const items = () => ([
  { name: 'A', quantity: 1, unitPriceNetMinor: 10000, taxRate: 23, taxCategory: 'standard' },
  { name: 'B', quantity: 1, unitPriceNetMinor: 5000, taxRate: 23, taxCategory: 'standard' },
  { name: 'C', quantity: 1, unitPriceNetMinor: 3333, taxRate: 23, taxCategory: 'standard' }
]);

test('procent ma pierwszeństwo przed kwotą — tak samo jak w podglądzie zamówienia', () => {
  // ⚠️ Ta sama reguła co `services/getDiscount.js`; rozjechanie się tych dwóch
  // miejsc dałoby inną kwotę na fakturze niż w zamówieniu.
  assert.deepEqual(
    resolveClientDiscount({ client_discount_percentage: 12, client_discount_value: 50 }),
    { type: 'percentage', percent: 12, valueMajor: 0 }
  );
  assert.deepEqual(
    resolveClientDiscount({ client_discount_percentage: 0, client_discount_value: 50 }),
    { type: 'value', percent: 0, valueMajor: 50 }
  );
  assert.equal(resolveClientDiscount({ client_discount_percentage: 0, client_discount_value: 0 }).type, 'none');
  assert.equal(resolveClientDiscount(null).type, 'none');
});

test('rabat procentowy rozkłada się na pozycje i sumuje co do grosza', () => {
  const discount = { type: 'percentage', percent: 12, valueMajor: 0 };
  const { items: out, discountMinor, baseMinor } = applyClientDiscount(items(), discount, 'EUR');

  assert.equal(baseMinor, 18333);
  assert.equal(discountMinor, 2200, '12% z 183,33 = 22,00');
  const suma = out.reduce((acc, i) => acc + i.discountAmountMinor, 0);
  assert.equal(suma, discountMinor, 'suma rabatów pozycji = rabat zamówienia');
});

test('rabat kwotowy: reszta z dzielenia trafia do ostatniej pozycji', () => {
  const discount = { type: 'value', percent: 0, valueMajor: 10 };
  const { items: out, discountMinor } = applyClientDiscount(items(), discount, 'EUR');

  assert.equal(discountMinor, 1000);
  const suma = out.reduce((acc, i) => acc + i.discountAmountMinor, 0);
  assert.equal(suma, 1000, 'bez tego faktura różniłaby się o grosz od zamówienia');
});

test('rabat nie może przekroczyć wartości zamówienia', () => {
  const { discountMinor } = applyClientDiscount(items(), { type: 'value', percent: 0, valueMajor: 10000 }, 'EUR');
  assert.equal(discountMinor, 18333, 'maksymalnie do zera, nigdy poniżej');
});

test('kalkulator odejmuje rabat i przelicza VAT od kwoty PO rabacie', () => {
  const discount = { type: 'percentage', percent: 10, valueMajor: 0 };
  const { items: out } = applyClientDiscount(items(), discount, 'EUR');
  const wynik = new InvoiceCalculator({ currency: 'EUR', localCurrency: 'EUR' }).calculate(out);

  assert.equal(wynik.totalNet, 16500, '183,33 − 10% = 165,00');
  // VAT liczony od netto po rabacie, nie przed
  assert.equal(wynik.totalTax, Math.round(16500 * 0.23), 'podatek od obniżonej podstawy');
});

test('brak rabatu zostawia pozycje nietknięte', () => {
  const src = items();
  const { items: out, discountMinor } = applyClientDiscount(src, { type: 'none', percent: 0, valueMajor: 0 }, 'EUR');
  assert.equal(discountMinor, 0);
  assert.deepEqual(out, src);
});
