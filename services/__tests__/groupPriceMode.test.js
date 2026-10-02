'use strict';

/**
 * Tryb wyceny klientów grupy (`user.group_price_mode`) — services/groupPriceMode.js.
 *
 * Baza podmieniona przez `deps.select`/`deps.update` (bez MySQL-a). Najważniejsze
 * reguły: narzut działa WYŁĄCZNIE dla zamówienia konta podrzędnego grupy
 * `client` w trybie `markup`, a brak kolumny (przed migracją) znaczy „tryb
 * rabatowy" — czyli zachowanie sprzed zmiany.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePriceMode,
  isMarkupMode,
  normalizeMarkupPercent,
  getGroupPriceMode,
  setGroupPriceMode,
  getGroupUserMarkupsByParentId,
  resolveClientPricingForOrder,
  MAX_MARKUP_PERCENT
} = require('../groupPriceMode');

const cicho = () => {};

test('normalizePriceMode: tylko „markup" jest narzutem, reszta (także pusta) to rabat', () => {
  assert.equal(normalizePriceMode('markup'), 'markup');
  assert.equal(normalizePriceMode(' MARKUP '), 'markup');
  assert.equal(normalizePriceMode('discount'), 'discount');
  assert.equal(normalizePriceMode(null), 'discount');
  assert.equal(normalizePriceMode(''), 'discount');
  assert.equal(normalizePriceMode('narzut'), 'discount');
  assert.equal(isMarkupMode('markup'), true);
  assert.equal(isMarkupMode(undefined), false);
});

test('normalizeMarkupPercent: przecinek dziesiętny, zaokrąglenie, zapora na literówkę', () => {
  assert.equal(normalizeMarkupPercent('12,5'), 12.5);
  assert.equal(normalizeMarkupPercent('33.333'), 33.33);
  assert.equal(normalizeMarkupPercent('150'), 150);
  assert.equal(normalizeMarkupPercent('-5'), 0);
  assert.equal(normalizeMarkupPercent('abc'), 0);
  assert.equal(normalizeMarkupPercent(null), 0);
  assert.equal(normalizeMarkupPercent('99999'), MAX_MARKUP_PERCENT);
  // DECIMAL wraca ze sterownika jako string.
  assert.equal(normalizeMarkupPercent('30.00'), 30);
});

test('getGroupPriceMode: brak kolumny / brak wiersza = tryb rabatowy', async () => {
  // `selectQuery` połyka błąd nieznanej kolumny i zwraca `false`.
  assert.equal(await getGroupPriceMode(6386, { select: async () => false }), 'discount');
  assert.equal(await getGroupPriceMode(6386, { select: async () => [{ group_price_mode: null }] }), 'discount');
  assert.equal(await getGroupPriceMode(6386, { select: async () => [{ group_price_mode: 'markup' }] }), 'markup');
  assert.equal(await getGroupPriceMode(null, { select: async () => { throw new Error('nie wołać'); } }), 'discount');
});

test('setGroupPriceMode: zapisuje znormalizowaną wartość, `false` gdy zapis padł (przed migracją)', async () => {
  let zapisane = null;
  const ok = await setGroupPriceMode(6386, ' Markup ', {
    update: async (sql, params) => { zapisane = params; return { affectedRows: 1 }; }
  });
  assert.equal(ok, true);
  assert.deepEqual(zapisane, ['markup', 6386]);
  assert.equal(await setGroupPriceMode(6386, 'markup', { update: async () => false }), false);
});

test('getGroupUserMarkupsByParentId: mapa id → procent, pusta przed migracją', async () => {
  const map = await getGroupUserMarkupsByParentId(6386, {
    select: async () => [{ id: 29, markup_percent: '25.00' }, { id: 30, markup_percent: '0.00' }]
  });
  assert.deepEqual(map, { 29: 25, 30: 0 });
  assert.deepEqual(await getGroupUserMarkupsByParentId(6386, { select: async () => false }), {});
});

function selectZWierszem(wiersz) {
  return async () => (wiersz ? [wiersz] : false);
}

test('resolveClientPricingForOrder: narzut dla konta podrzędnego grupy `client` w trybie `markup`', async () => {
  const wynik = await resolveClientPricingForOrder(3040, {
    log: cicho,
    select: selectZWierszem({ mode: 'markup', group_type: 'client', role: 'group', markup: '30.00' })
  });
  assert.deepEqual(wynik, { mode: 'markup', markupPercent: 30 });
});

test('resolveClientPricingForOrder: narzut 0% to nadal tryb narzutu (ceny zwykłe bez narzutu)', async () => {
  const wynik = await resolveClientPricingForOrder(3040, {
    log: cicho,
    select: selectZWierszem({ mode: 'markup', group_type: 'client', role: 'group', markup: '0.00' })
  });
  assert.deepEqual(wynik, { mode: 'markup', markupPercent: 0 });
});

test('resolveClientPricingForOrder: wszystko poza grupą `client` w trybie `markup` = bez zmian', async () => {
  const przypadki = [
    // grupa rozliczana rabatem (domyślnie)
    { mode: null, group_type: 'client', role: 'group', markup: '30.00' },
    { mode: 'discount', group_type: 'client', role: 'group', markup: '30.00' },
    // grupa ze sklepami (np. TCN) — tryb nie ma znaczenia
    { mode: 'markup', group_type: 'shop', role: 'group', markup: '30.00' },
    { mode: 'markup', group_type: '', role: 'group', markup: '30.00' },
    // konto przestało być grupą
    { mode: 'markup', group_type: 'client', role: null, markup: '30.00' }
  ];
  for (const wiersz of przypadki) {
    const wynik = await resolveClientPricingForOrder(3040, { log: cicho, select: selectZWierszem(wiersz) });
    assert.deepEqual(wynik, { mode: 'discount', markupPercent: 0 }, JSON.stringify(wiersz));
  }
});

test('resolveClientPricingForOrder: zamówienie bez konta podrzędnego, brak kolumn, błąd bazy', async () => {
  // Zamówienie grupy-matki albo zwykłego klienta — JOIN nic nie zwraca.
  assert.deepEqual(
    await resolveClientPricingForOrder(3040, { log: cicho, select: async () => false }),
    { mode: 'discount', markupPercent: 0 });
  assert.deepEqual(
    await resolveClientPricingForOrder(3040, { log: cicho, select: async () => { throw new Error('ECONNRESET'); } }),
    { mode: 'discount', markupPercent: 0 });
  assert.deepEqual(
    await resolveClientPricingForOrder(null, { log: cicho, select: async () => { throw new Error('nie wołać'); } }),
    { mode: 'discount', markupPercent: 0 });
});
