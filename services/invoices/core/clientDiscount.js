'use strict';

/**
 * Rabat, który SALON daje swojemu odbiorcy końcowemu.
 *
 * Nadawany na zamówieniu (`order.client_discount_percentage` /
 * `order.client_discount_value`, ekran „Ustaw rabat" → endpoint
 * `/orders/order/:id/discount-info`). Dotyczy relacji **użytkownik → odbiorca
 * końcowy**, więc na fakturze pojawia się wyłącznie na poziomie 3 — w relacji
 * z producentem czy organizacją ten rabat nie istnieje.
 *
 * ⚠️ Rabat jest na CAŁYM ZAMÓWIENIU, a VAT liczy się per pozycja i per grupa
 * stawek. Nie można go więc dopisać jako jednej ujemnej linii, bo przy dwóch
 * stawkach (towar 23% + montaż 8%) nie dałoby się orzec, którą obniża.
 * Dlatego rozkładamy go PROPORCJONALNIE do wartości pozycji — każda grupa
 * stawek maleje o swoją część, a suma VAT zgadza się z sumą netto.
 *
 * ⚠️ Pierwszeństwo procentu przed kwotą jest przepisane z
 * `services/getDiscount.js` — gdyby te dwa miejsca liczyły inaczej, klient
 * zobaczyłby na fakturze inną kwotę niż w podglądzie zamówienia.
 */

const money = require('./money');

/** @typedef {{ type: 'percentage'|'value'|'none', percent: number, valueMajor: number }} ClientDiscount */

/**
 * Odczyt rabatu z wiersza zamówienia.
 *
 * @param {Record<string, any>} order wiersz `order`
 * @returns {ClientDiscount}
 */
function resolveClientDiscount(order) {
  const percent = Number(order && order.client_discount_percentage);
  const value = Number(order && order.client_discount_value);

  if (Number.isFinite(percent) && percent > 0) {
    return { type: 'percentage', percent, valueMajor: 0 };
  }
  if (Number.isFinite(value) && value > 0) {
    return { type: 'value', percent: 0, valueMajor: value };
  }
  return { type: 'none', percent: 0, valueMajor: 0 };
}

/**
 * Rozkłada rabat na pozycje faktury.
 *
 * Zwraca NOWE pozycje (bez mutacji wejścia) z ustawionym `discountAmountMinor`
 * i `discountPercent` — kalkulator odejmuje kwotę, a procent służy do wydruku.
 *
 * ⚠️ Reszta z dzielenia trafia do OSTATNIEJ pozycji, żeby suma rabatów
 * co do grosza równała się rabatowi z zamówienia. Bez tego faktura na 3 pozycje
 * potrafiłaby różnić się o grosz od kwoty pokazanej klientowi przy zamówieniu.
 *
 * @param {Array<Record<string, any>>} rawItems pozycje wejściowe kalkulatora
 * @param {ClientDiscount} discount
 * @param {string} currency
 * @returns {{ items: Array<Record<string, any>>, discountMinor: number, baseMinor: number }}
 */
function applyClientDiscount(rawItems, discount, currency = 'EUR') {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const lineNet = items.map((it) => money.multiply(
    Math.trunc(Number(it.unitPriceNetMinor) || 0),
    Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 1
  ));
  const baseMinor = money.sum(lineNet);

  if (!discount || discount.type === 'none' || baseMinor <= 0 || !items.length) {
    return { items, discountMinor: 0, baseMinor };
  }

  const totalDiscount = discount.type === 'percentage'
    ? money.percentOf(baseMinor, discount.percent)
    : Math.min(money.toMinor(discount.valueMajor, currency), baseMinor);

  if (totalDiscount <= 0) return { items, discountMinor: 0, baseMinor };

  let assigned = 0;
  const withDiscount = items.map((item, index) => {
    const isLast = index === items.length - 1;
    const share = isLast
      ? totalDiscount - assigned
      : money.roundHalfUp((totalDiscount * lineNet[index]) / baseMinor);
    assigned += share;

    return {
      ...item,
      discountAmountMinor: share,
      // Procent tylko do wydruku — wiążąca jest kwota wyżej
      discountPercent: lineNet[index] > 0
        ? Number(((share / lineNet[index]) * 100).toFixed(2))
        : 0
    };
  });

  return { items: withDiscount, discountMinor: totalDiscount, baseMinor };
}

module.exports = { resolveClientDiscount, applyClientDiscount };
