'use strict';

/**
 * Tłumaczenie nazw DZIAŁU i GRUPY na dokumencie („Produkt" / „Grupa").
 *
 * ⚠️ Te dwie wartości NIE są parametrami konfiguratora i nie ma ich
 * w `translation_dictionary` — `order_item.department` i `group_name` zapisują
 * się w języku autora pozycji. Tłumaczenia trzymają tabele `product_group`
 * i `department` (kolumny `name_pl … name_fr`), dopasowywane przez
 * `asortment_group_number` = `product_group.group_number`.
 *
 * Repozytorium jest tu podmienione atrapą — testy nie potrzebują MySQL-a.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const repoPath = require.resolve('../dbRepository');
const translatorPath = require.resolve('../itemTranslator');

/** Podmienia repozytorium na atrapę i zwraca świeżą instancję translatora. */
function withStubRepo(stub) {
  delete require.cache[repoPath];
  delete require.cache[translatorPath];
  require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: stub };
  return require(translatorPath);
}

const pozycje = () => ([{
  headers1: ['MODEL'],
  headers2: [],
  headerKeys1: ['MODEL||MODEL'],
  headerKeys2: [],
  locked: [],
  rows: [{
    item: { id: 1, department: 'ŻALUZJE', group_name: 'ŻALUZJA ALUMINIOWA 16/25', lockedParams: [] },
    row: { row1: { MODEL: 'H50' }, row2: {} }
  }]
}]);

const orderItems = [{ id: 1, asortment_group_number: '39' }];

test('dział i grupa tłumaczone z tabel product_group/department', async () => {
  const translator = withStubRepo({
    getGroupTranslations: async () => ({ params: {}, paramdict: {} }),
    getGroupDepartmentNames: async (numery, lang) => {
      assert.deepEqual(numery, ['39'], 'pyta o numer grupy z pozycji');
      assert.equal(lang, 'nl');
      return new Map([['39', { group: 'ALUMINIUM JALOEZIEËN 16/25', department: 'JALOEZIEËN' }]]);
    }
  });

  const wynik = await translator.translateOrderItems(orderItems, pozycje(), 'nl');
  assert.equal(wynik[0].rows[0].item.department, 'JALOEZIEËN');
  assert.equal(wynik[0].rows[0].item.group_name, 'ALUMINIUM JALOEZIEËN 16/25');
});

test('tłumaczenie nazw działa też, gdy grupa nie ma słownika parametrów', async () => {
  // ⚠️ Pętla tłumacząca parametry przerywa (`continue`) przy braku słownika —
  // nazwy działu i grupy nie mogą od tego zależeć, dlatego są w osobnej pętli.
  const translator = withStubRepo({
    getGroupTranslations: async () => null,
    getGroupDepartmentNames: async () => new Map([['39', { group: 'EOS', department: 'PLISSÉGORDIJNEN' }]])
  });

  const wynik = await translator.translateOrderItems(orderItems, pozycje(), 'nl');
  assert.equal(wynik[0].rows[0].item.department, 'PLISSÉGORDIJNEN');
  assert.equal(wynik[0].rows[0].item.group_name, 'EOS');
});

test('brak tłumaczenia zostawia wartości z pozycji', async () => {
  const translator = withStubRepo({
    getGroupTranslations: async () => ({ params: {}, paramdict: {} }),
    getGroupDepartmentNames: async () => new Map()
  });

  const wynik = await translator.translateOrderItems(orderItems, pozycje(), 'nl');
  assert.equal(wynik[0].rows[0].item.department, 'ŻALUZJE');
  assert.equal(wynik[0].rows[0].item.group_name, 'ŻALUZJA ALUMINIOWA 16/25');
});

test('oryginalna struktura nie jest mutowana', async () => {
  const translator = withStubRepo({
    getGroupTranslations: async () => ({ params: {}, paramdict: {} }),
    getGroupDepartmentNames: async () => new Map([['39', { group: 'EOS', department: 'PLISSÉGORDIJNEN' }]])
  });

  const wejscie = pozycje();
  await translator.translateOrderItems(orderItems, wejscie, 'nl');
  assert.equal(wejscie[0].rows[0].item.department, 'ŻALUZJE', 'wejście bez zmian');
});
