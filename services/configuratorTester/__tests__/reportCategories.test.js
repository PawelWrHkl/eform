'use strict';

/**
 * Układ maila z raportem — decyzja właściciela 2026-10-12:
 *  1. ślepe zaułki NA GÓRZE, z pełną ścieżką (dział, produkt, model,
 *     konfiguracja, pole, na którym formularz staje),
 *  2. błędy cen i ceny zero,
 *  3. pozostałe NA DOLE.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { categorize, splitByCategory, CATEGORY } = require('../reportCategories');
const { buildSimulationPath } = require('../assertions');
const { buildHtml } = require('../mailer');

test('ślepy zaułek = formularz nie puszcza dalej, niezależnie od źródła', () => {
  for (const code of ['KONFIGURATOR_NIE_PUSZCZA_DALEJ', 'WALIDACJA_ODRZUCA_KONFIGURACJE', 'BLOKADA_ZAPISU',
    'PRZEGLADARKA_FORMULARZ_SIE_NIE_ZBUDOWAL', 'PRZEGLADARKA_PRZELICZANIE_NIE_KONCZY_SIE']) {
    assert.equal(categorize(code), CATEGORY.DEAD_END, code);
  }
});

test('ceny: niezgodność z cennikiem, brak ceny, uszkodzone skrypty', () => {
  for (const code of ['BRAK_CENY', 'BRAK_CENY_MIMO_CENNIKA', 'CENA_ZANIZONA', 'CENA_NIEZGODNA_Z_CENNIKIEM',
    'SKRYPT_CENOWY_NIE_PARSUJE_SIE', 'WYMIAR_POZA_CENNIKIEM_PRZYJETY', 'KOSZYK_NIESPOJNY']) {
    assert.equal(categorize(code), CATEGORY.PRICE, code);
  }
});

test('wpisy „cenowe", które same mówią, że błędem nie są, idą na dół', () => {
  // 12.10: 22 z 49 wpisów w kategorii cen to były takie — zaśmiecały listę.
  for (const code of ['WYMIAR_POZA_CENNIKIEM_DO_SPRAWDZENIA', 'CENA_POCHODNA_DO_SPRAWDZENIA',
    'PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM', 'BRAK_CENY_PRZY_NIEKOMPLETNEJ_KONFIGURACJI']) {
    assert.equal(categorize(code), CATEGORY.OTHER, code);
  }
});

test('nieznany kod nie znika i nie udaje ślepego zaułka', () => {
  assert.equal(categorize('NOWY_KOD_Z_PRZYSZLOSCI'), CATEGORY.OTHER);
  assert.equal(categorize(undefined), CATEGORY.OTHER);
});

test('w kategorii: najpierw krytyczne, potem po numerze grupy', () => {
  const k = splitByCategory([
    { code: 'BRAK_CENY', priority: 'HIGH', groupNumber: '02' },
    { code: 'BRAK_CENY', priority: 'P1', groupNumber: '76' },
    { code: 'BRAK_CENY', priority: 'P1', groupNumber: '11' }
  ]);
  assert.deepEqual(k[CATEGORY.PRICE].map((f) => `${f.priority}/${f.groupNumber}`), ['P1/11', 'P1/76', 'HIGH/02']);
});

test('ścieżka symulacji: kolejność wyboru, ostatnia wartość pola, bez pola-stopu', () => {
  const p = buildSimulationPath({
    departmentNumber: '8', departmentName: 'ZASŁONY', groupName: 'ZASŁONY',
    filled: [
      { name: 'KONFIGURACJA', value: 'CFO' },
      { name: 'SZEROKOSC', value: '900' },
      { name: 'MODEL', value: 'FLEX' },
      { name: 'SZEROKOSC', value: '1000' }, // poprawione w drugiej rundzie
      { name: 'FALA', value: 'V1' } // pole-stop nie może udawać wybranego
    ]
  }, [{ field: 'FALA', reason: 'brak opcji' }]);
  assert.deepEqual(p.steps, [
    { field: 'KONFIGURACJA', value: 'CFO' },
    { field: 'SZEROKOSC', value: '1000' },
    { field: 'MODEL', value: 'FLEX' }
  ]);
  assert.deepEqual(p.blockedAt, [{ field: 'FALA', reason: 'brak opcji' }]);
  assert.equal(p.groupName, 'ZASŁONY');
});

test('mail: kategorie w kolejności 1 → 2 → 3, ślepy zaułek ze ścieżką i polem-stopem', () => {
  const html = buildHtml({
    finishedAt: '2026-10-12T13:36:36Z',
    groupsChecked: 3,
    groups: [],
    totals: {},
    findings: [
      { priority: 'MEDIUM', code: 'BRAK_DANYCH_REFERENCYJNYCH', groupNumber: '02', message: 'POZOSTALY-WPIS' },
      { priority: 'HIGH', code: 'CENA_NIEZGODNA_Z_CENNIKIEM', groupNumber: '39', message: 'CENOWY-WPIS', expected: 29.15, actual: 55.536 },
      {
        priority: 'P1', code: 'KONFIGURATOR_NIE_PUSZCZA_DALEJ', groupNumber: '99', source: 'simulation', message: 'x',
        path: { departmentName: 'DZIAŁ-TESTOWY', groupName: 'PRODUKT-TESTOWY',
          steps: [{ field: 'MODEL', value: 'MOD-X' }, { field: 'KOLOR', value: 'K1' }],
          blockedAt: [{ field: 'POLE-STOP', reason: 'brak opcji do wyboru' }] }
      }
    ]
  }, '/tmp/raport.json', new Map());

  const i1 = html.indexOf('Ślepe zaułki');
  const i2 = html.indexOf('Błędy cen i ceny zero');
  const i3 = html.indexOf('Pozostałe');
  assert.ok(i1 > 0 && i1 < i2 && i2 < i3, 'kolejność sekcji');
  assert.ok(html.indexOf('POZOSTALY-WPIS') > i3, 'pozostałe na samym dole');
  assert.ok(html.indexOf('CENOWY-WPIS') > i2 && html.indexOf('CENOWY-WPIS') < i3);

  const karta = html.slice(i1, i2);
  for (const fragment of ['DZIAŁ-TESTOWY', 'PRODUKT-TESTOWY', 'MOD-X', 'KOLOR', 'K1', 'Tu formularz staje', 'POLE-STOP', 'brak opcji do wyboru']) {
    assert.ok(karta.includes(fragment), `karta ślepego zaułka zawiera: ${fragment}`);
  }
  assert.ok(html.includes('29.15 €') && html.includes('55.54 €'), 'kwoty cennik/system po 2 miejscach');
});

test('mail: surowy klucz tłumaczenia z silnika testowego zamieniony na tekst klienta', () => {
  const html = buildHtml({
    finishedAt: '2026-10-12T13:36:36Z', groupsChecked: 1, groups: [], totals: {},
    findings: [{ priority: 'P1', code: 'BRAK_CENY_MIMO_CENNIKA', groupNumber: '76', expected: 288, actual: 'order.according_to_price', message: 'silnik podaje „order.according_to_price"' }]
  }, '/tmp/r.json', new Map());
  assert.ok(!html.includes('order.according_to_price'));
  assert.ok(html.includes('według cennika'));
});
