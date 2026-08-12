'use strict';

/**
 * `user.delivery_delay` — indywidualne opóźnienie dostawy klienta doliczane
 * do terminów PRODUKCJI LICZONYCH Z BAZY.
 *
 * ⚠️ Nie dotyczy danych z `status.txt`: statusy i daty wysyłki z produkcji są
 * faktami, nie szacunkiem. W widokach oba źródła są rozdzielone — szacunek
 * z bazy pokazuje się tylko wtedy, gdy zamówienie nie ma jeszcze
 * `order.prod_status` (patrz `templates/orders_history.njk`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDeliveryDelay, resolveDeliveryDelay, buildItemProductionDays } = require('../productionDays');

test('normalizacja wartości kolumny', () => {
  assert.equal(resolveDeliveryDelay(10), 10);
  assert.equal(resolveDeliveryDelay('10'), 10, 'z bazy może przyjść string');
  assert.equal(resolveDeliveryDelay(null), 0);
  assert.equal(resolveDeliveryDelay(undefined), 0);
  assert.equal(resolveDeliveryDelay(''), 0);
  assert.equal(resolveDeliveryDelay('abc'), 0, 'śmieć w kolumnie nie może zepsuć terminu');
});

test('opóźnienie dodaje się do wyliczonych dni', () => {
  assert.equal(applyDeliveryDelay(12, 10), 22);
  assert.equal(applyDeliveryDelay(14, 10), 24);
});

test('brak opóźnienia nie zmienia terminu', () => {
  [0, null, undefined, ''].forEach((v) => assert.equal(applyDeliveryDelay(5, v), 5, String(v)));
});

test('brak wyliczonych dni zostaje brakiem — nie zmyślamy terminu', () => {
  // `null` oznacza „grupa asortymentowa nie ma czasu produkcji w bazie".
  // Zwrócenie samego opóźnienia (10 dni) byłoby wymyśleniem terminu z powietrza.
  assert.equal(applyDeliveryDelay(null, 10), null);
});

test('wynik nigdy nie schodzi poniżej zera', () => {
  // Kolumna jest int-em, więc technicznie może zawierać wartość ujemną.
  assert.equal(applyDeliveryDelay(2, -10), 0);
  assert.equal(applyDeliveryDelay(5, -3), 2);
});

test('buildItemProductionDays: opóźnienie trafia do pozycji I do maksimum, bez podwajania', () => {
  const items = [{
    rows: [
      { item: { id: 1, asortment_group_number: '39', json_parameters: {} } },
      { item: { id: 2, asortment_group_number: '12', json_parameters: {} } }
    ]
  }];
  const times = { 39: { days: 5 }, 12: { days: 12 } };

  const bez = buildItemProductionDays(items, times);
  assert.deepEqual(bez.itemProductionDays, { 1: 5, 2: 12 });
  assert.equal(bez.maxProdDays, 12);

  const z = buildItemProductionDays(items, times, 10);
  assert.deepEqual(z.itemProductionDays, { 1: 15, 2: 22 }, 'każda pozycja z opóźnieniem');
  // ⚠️ Maksimum liczone z pozycji, które JUŻ mają opóźnienie — dodanie go
  // ponownie do maksimum dałoby 32 dni zamiast 22.
  assert.equal(z.maxProdDays, 22, 'maksimum bez podwójnego doliczenia');
});

test('pozycja bez czasu produkcji w bazie nie wchodzi do zestawienia', () => {
  const items = [{ rows: [{ item: { id: 1, asortment_group_number: 'BRAK', json_parameters: {} } }] }];
  const wynik = buildItemProductionDays(items, {}, 10);
  assert.deepEqual(wynik.itemProductionDays, {}, 'brak danych = brak wpisu');
  assert.equal(wynik.maxProdDays, 0, 'i brak maksimum');
});
