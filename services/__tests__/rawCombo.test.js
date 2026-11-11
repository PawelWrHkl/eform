'use strict';
/**
 * Pole „wpisz i wybierz” okna biura (public/scripts/staff/rawCombo.js) — czyste funkcje:
 * porównania bez polskich znaków, filtr listy i odczyt napisu kafelka (alias / kod HKL).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => {
  mod = await import('../../public/scripts/staff/rawCombo.js');
});

const opt = (code, desc) => ({ code, desc });

test('normalize: małe litery, bez diakrytyków (także ł), jedna spacja', () => {
  assert.equal(mod.normalize('  Żółta  ŁÓDŹ '), 'zolta lodz');
  assert.equal(mod.normalize(null), '');
});

test('filterOptions: każde słowo w kodzie lub opisie, bez polskich znaków', () => {
  const list = [opt('3004-P20', 'PG #0 biały'), opt('10401-P20', 'PG #0 kremowy'), opt('UK', 'Uchwyt kątowy')];
  assert.deepEqual(mod.filterOptions(list, 'katowy').map((o) => o.code), ['UK']);
  assert.deepEqual(mod.filterOptions(list, 'pg kremowy').map((o) => o.code), ['10401-P20']);
  assert.equal(mod.filterOptions(list, '').length, 3, 'pusty tekst = cała lista');
  assert.deepEqual(mod.filterOptions(list, 'xyz'), []);
});

test('filterOptions: trafienia od początku kodu na górze, poza tym kolejność źródła (ulubione pierwsze)', () => {
  const list = [opt('A-10401', 'x'), opt('20401-P20', 'x'), opt('10401-P20', 'x')];
  assert.deepEqual(mod.filterOptions(list, '10401').map((o) => o.code), ['10401-P20', 'A-10401']);
  assert.deepEqual(mod.filterOptions(list, 'x').map((o) => o.code), ['A-10401', '20401-P20', '10401-P20']);
});

test('parseTileLabel: „KOD<br>OPIS” kafelka, encje HTML i znaczniki usunięte', () => {
  assert.deepEqual(mod.parseTileLabel('10401-P20<br>PG #0'), { code: '10401-P20', desc: 'PG #0' });
  assert.deepEqual(mod.parseTileLabel('B&amp;C<br/>Opis <b>gruby</b>'), { code: 'B&C', desc: 'Opis gruby' });
  assert.deepEqual(mod.parseTileLabel('SAM'), { code: 'SAM', desc: '' });
});
