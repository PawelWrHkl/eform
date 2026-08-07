'use strict';

/**
 * Parowanie statusów produkcji z pozycjami zamówienia.
 *
 * ⚠️ Sedno: ORDERPOS z pliku `status.txt` nie jest liczbą. Poza zwykłym `7`
 * przychodzą PODPOZYCJE (`1-1`, `1-2`) i kody produkcyjne (`B793638`).
 * Wcześniej kolumna była INT-em, więc takie wiersze w ogóle nie wchodziły do
 * bazy, a widok parował statusy z wierszami po zwykłym indeksie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { positionNumber, alignStatusesToItems } = require('../prodStatus');

test('numer pozycji: zwykła, podpozycja, kod produkcyjny', () => {
  assert.equal(positionNumber('7'), 7);
  assert.equal(positionNumber('1-2'), 1);
  assert.equal(positionNumber('12-10'), 12);
  assert.equal(positionNumber(' 3 '), 3);
  assert.equal(positionNumber('B793638'), null, 'kod produkcyjny nie wskazuje pozycji');
  assert.equal(positionNumber(''), null);
  assert.equal(positionNumber(null), null);
});

test('podpozycje jednej pozycji nie przesuwają statusów kolejnych wierszy', () => {
  // Pozycja 1 rozbita na 1-1 i 1-2; bez grupowania status pozycji 2 trafiłby
  // do wiersza 3, bo statusów jest więcej niż wierszy.
  const statuses = [
    { order_pos: '1-1', status: '!sent!', shipping_date: '2026-08-01' },
    { order_pos: '1-2', status: '!sent!', shipping_date: '2026-08-05' },
    { order_pos: '2', status: '!production!', shipping_date: '2026-08-20' }
  ];
  const items = [{ orderpos: 1 }, { orderpos: 2 }];
  const aligned = alignStatusesToItems(statuses, items);

  assert.equal(aligned.length, 2);
  // Pozycja jest kompletna dopiero z ostatnią paczką → późniejsza data
  assert.equal(aligned[0].shipping_date, '2026-08-05');
  assert.equal(aligned[0].subPositions, 2);
  assert.equal(aligned[1].status, '!production!');
});

test('niewysłana podpozycja wygrywa nad wysłaną', () => {
  const statuses = [
    { order_pos: '1-1', status: '!sent!', shipping_date: '2026-08-01' },
    { order_pos: '1-2', status: '!backorder!', shipping_date: '2026-09-01' }
  ];
  const aligned = alignStatusesToItems(statuses, [{ orderpos: 1 }]);
  assert.equal(aligned[0].status, '!backorder!', 'pozycja nie jest wysłana, dopóki brakuje części');
});

test('pozycja bez statusu daje pustą komórkę, nie cudzy status', () => {
  const statuses = [{ order_pos: '2', status: '!sent!', shipping_date: '2026-08-01' }];
  const aligned = alignStatusesToItems(statuses, [{ orderpos: 1 }, { orderpos: 2 }]);
  assert.equal(aligned[0], null);
  assert.equal(aligned[1].status, '!sent!');
});

test('same kody produkcyjne — zachowujemy dotychczasowe parowanie po indeksie', () => {
  // Regresja: gdyby żaden status nie miał numeru pozycji, grupowanie
  // wyczyściłoby cały widok statusów.
  const statuses = [
    { order_pos: 'B793638', status: '!sent!', shipping_date: '2026-08-03' },
    { order_pos: 'B793638', status: '!sent!', shipping_date: '2026-08-03' }
  ];
  const aligned = alignStatusesToItems(statuses, [{ orderpos: 1 }, { orderpos: 2 }]);
  assert.deepEqual(aligned, statuses);
});

test('brak statusów albo brak pozycji nie wywraca widoku', () => {
  assert.deepEqual(alignStatusesToItems([], [{ orderpos: 1 }]), []);
  assert.deepEqual(alignStatusesToItems(null, [{ orderpos: 1 }]), []);
  const s = [{ order_pos: '1', status: '!sent!' }];
  assert.deepEqual(alignStatusesToItems(s, []), s);
});
