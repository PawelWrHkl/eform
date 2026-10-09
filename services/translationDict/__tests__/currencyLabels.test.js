'use strict';

/**
 * Waluta w nagłówkach tabeli pozycji po tłumaczeniu (dokument w innym języku,
 * zlecenie produkcyjne po polsku).
 *
 * Opis parametru kwotowego zapisany z pozycją niesie na końcu walutę klienta
 * („CENA HKL netto [PLN]”, public/scripts/formTools/currencyLabel.js), a
 * `translation_dictionary` zna surowy opis z param.txt — bez waluty. Tłumacz
 * ma przenieść walutę na tłumaczenie, a pozycje sprzed 2026-10-08 (`[€]` w
 * środku opisu) dostać `[EUR]`.
 *
 * Repozytorium podmienione atrapą — bez MySQL-a.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const repoPath = require.resolve('../dbRepository');
const translatorPath = require.resolve('../itemTranslator');

function withStubRepo(stub) {
  delete require.cache[repoPath];
  delete require.cache[translatorPath];
  require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: stub };
  return require(translatorPath);
}

const translator = () => withStubRepo({
  getGroupTranslations: async () => ({
    params: { MODEL: 'MODELL', CENA: 'HKL PREIS', SUMA_BRUTTO: 'GES.WERT', CENA_RABAT: 'RABATT' },
    paramdict: {}
  }),
  getGroupDepartmentNames: async () => new Map()
});

const orderItems = [{ id: 1, asortment_group_number: '71' }];

function table({ cena, suma }) {
  return [{
    headers1: ['MODEL'],
    headers2: [cena, suma, 'RABAT'],
    headerKeys1: ['MODEL||MODEL'],
    headerKeys2: [`${cena}||CENA`, `${suma}||SUMA_BRUTTO`, 'RABAT||CENA_RABAT'],
    locked: [suma],
    rows: [{
      item: { id: 1, lockedParams: [suma] },
      row: { row1: { MODEL: 'H50' }, row2: { [cena]: '10.00', [suma]: '20.00', RABAT: '45%' } }
    }]
  }];
}

test('waluta klienta zostaje na końcu przetłumaczonego nagłówka', async () => {
  const [wynik] = await translator().translateOrderItems(
    orderItems, table({ cena: 'CENA HKL netto [PLN]', suma: 'WARTOŚĆ BR. [PLN]' }), 'de');

  assert.deepEqual(wynik.headers1, ['MODELL']);
  assert.deepEqual(wynik.headers2, ['HKL PREIS [PLN]', 'GES.WERT [PLN]', 'RABATT']);
  assert.deepEqual(wynik.headerKeys2, ['HKL PREIS [PLN]||CENA', 'GES.WERT [PLN]||SUMA_BRUTTO', 'RABATT||CENA_RABAT']);
  // Komórki, kłódki i lista zablokowanych idą za nowym nagłówkiem — inaczej
  // szablon nie znalazłby wartości ani nie schował zablokowanej kolumny.
  assert.deepEqual(wynik.rows[0].row.row2, { 'HKL PREIS [PLN]': '10.00', 'GES.WERT [PLN]': '20.00', RABATT: '45%' });
  assert.deepEqual(wynik.locked, ['GES.WERT [PLN]']);
  assert.deepEqual(wynik.rows[0].item.lockedParams, ['GES.WERT [PLN]']);
});

test('pozycja zapisana ze starym [€] dostaje po tłumaczeniu [EUR]', async () => {
  const [wynik] = await translator().translateOrderItems(
    orderItems, table({ cena: 'CENA HKL [€] netto', suma: 'WARTOŚĆ BR.[€]' }), 'de');
  assert.deepEqual(wynik.headers2, ['HKL PREIS [EUR]', 'GES.WERT [EUR]', 'RABATT']);
});

test('nagłówek bez waluty tłumaczy się jak dotąd', async () => {
  const [wynik] = await translator().translateOrderItems(
    orderItems, table({ cena: 'CENA HKL netto', suma: 'WARTOŚĆ BR.' }), 'de');
  assert.deepEqual(wynik.headers2, ['HKL PREIS', 'GES.WERT', 'RABATT']);
});
