'use strict';

// Parametr wyłączony w konfiguracji (ENABLE niespełnione) z domyślnym „0” w opisie
// pozycji — np. SZEROKOSC_DACH/WYSOKOSC_DACH żaluzji 16/25 poza modelami dachowymi —
// nie pokazuje się w wierszu cen (zgłoszenie właściciela 2026-10-27).

const test = require('node:test');
const assert = require('node:assert/strict');

const { jsonTextBackToMap, isDisabledDefaultRow } = require('../orderService');

const row = (param_description, option_value, rowNo = '2') => ({ param_description, option_value, locked: false, sub: false, row: rowNo });

function blind({ id, model, roof }) {
  const values = {
    MODEL: model, SZEROKOSC: roof ? '' : 999, WYSOKOSC: roof ? '' : 999,
    SZEROKOSC_DACH: roof ? 999 : '', WYSOKOSC_DACH: roof ? 999 : '',
    POW: 1, CENA: 33.25, DOPLATA_EL: ''
  };
  const desc = [
    ['MODEL', { param_description: 'MODEL', option_value: model, option_description: '', row: '1' }],
    ['SZEROKOSC_DACH', row('SZEROKOSC [MM]', roof ? '999' : '0')],
    ['WYSOKOSC_DACH', row('WYSOKOSC [MM]', roof ? '999' : '0')],
    ['POW', row('POWIERZCHNIA [M2]', '1.00')],
    ['CENA', row('CENA HKL netto [EUR]', '33.25')],
    // Kwota wyłączona z „0” — poza zakresem tej reguły (kwoty mają własne reguły).
    ['DOPLATA_EL', row('DOPŁATA EL [EUR]', '0')]
  ];
  // Opis i wartości zapisane jak w bazie — podwójnie zakodowany JSON.
  return { id, json_parameters: JSON.stringify(JSON.stringify(values)), json_parameters_desc: JSON.stringify(JSON.stringify(desc)) };
}

test('wyłączony wymiar z domyślnym „0” — bez kolumny w wierszu cen; kwoty bez zmian', async () => {
  const { cleanOrderItems } = await jsonTextBackToMap([blind({ id: 1, model: 'U25EL' }), blind({ id: 2, model: 'U25EL' })]);
  const [table] = cleanOrderItems;
  assert.ok(!table.headers2.includes('SZEROKOSC [MM]'), 'kolumna pusta we wszystkich wierszach znika');
  assert.ok(!table.headers2.includes('WYSOKOSC [MM]'));
  assert.equal(table.rows[0].row.row2['POWIERZCHNIA [M2]'], '1.00');
  assert.equal(table.rows[0].row.row2['DOPŁATA EL [EUR]'], '0', 'kwoty — własne reguły, nie ruszane');
});

test('żaluzja dachowa w tym samym zleceniu — prawdziwe wymiary zostają, zwykła ma pustą komórkę, jedna tabela', async () => {
  const { cleanOrderItems } = await jsonTextBackToMap([blind({ id: 1, model: 'U25DF', roof: true }), blind({ id: 2, model: 'U25EL' })]);
  assert.equal(cleanOrderItems.length, 1, 'te same klucze — pozycje nie rozjeżdżają się na dwie tabele');
  const [roofRow, plainRow] = cleanOrderItems[0].rows;
  assert.equal(roofRow.row.row2['SZEROKOSC [MM]'], '999');
  assert.equal(roofRow.row.row2['WYSOKOSC [MM]'], '999');
  assert.equal(plainRow.row.row2['SZEROKOSC [MM]'], '-');
  assert.equal(plainRow.row.row2['WYSOKOSC [MM]'], '-');
});

test('isDisabledDefaultRow: tylko pusta wartość + „0”, nie kwoty, rabaty ani SUB___', () => {
  const values = { SZEROKOSC_DACH: '', SZEROKOSC: 0, DOPLATA_EL: '', CENA_RABAT: '', SUB___POW: '' };
  assert.equal(isDisabledDefaultRow('SZEROKOSC_DACH', { option_value: '0' }, values), true);
  assert.equal(isDisabledDefaultRow('SZEROKOSC_DACH', { option_value: '0' }, JSON.stringify(values)), true, 'json_parameters jako tekst');
  assert.equal(isDisabledDefaultRow('SZEROKOSC', { option_value: '0' }, values), false, 'prawdziwe 0 (liczba) zostaje');
  assert.equal(isDisabledDefaultRow('SZEROKOSC_DACH', { option_value: '999' }, values), false);
  assert.equal(isDisabledDefaultRow('DOPLATA_EL', { option_value: '0' }, values), false);
  assert.equal(isDisabledDefaultRow('CENA_RABAT', { option_value: '0' }, values), false);
  assert.equal(isDisabledDefaultRow('SUB___POW', { option_value: '0' }, values), false);
  assert.equal(isDisabledDefaultRow('SZEROKOSC_DACH', { option_value: '0' }, null), false, 'bez wartości silnika — nic nie wiadomo');
});
