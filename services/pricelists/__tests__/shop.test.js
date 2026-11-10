'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shopPricelist, shopHasFinalPrices } = require('../shop');

// Cennik grupy-matki w kształcie `buildPricelist`: komórka tabeli, dopłata, dopłata EL.
function list(prefix, rebates) {
  return {
    priceSet: prefix ? 'SUB' : 'CENA',
    parts: [
      { param: `${prefix}CENA`, tables: [{ cells: { 2: { '100|100': 547 } } }], items: [] },
      { param: `${prefix}DOPLATA`, tables: [], items: [{ kind: 'amount', amount: 10 }] },
      { param: `${prefix}DOPLATA_EL`, tables: [], items: [{ kind: 'amount', amount: 100 }] }
    ],
    discount: {
      formula: `=(${prefix}CENA+${prefix}DOPLATA)*(1-${prefix}CENA_RABAT)+${prefix}DOPLATA_EL*(1-${prefix}DOPLATA_EL_RABAT)`,
      rebates,
      components: [`${prefix}CENA`, `${prefix}DOPLATA`, `${prefix}DOPLATA_EL`]
    }
  };
}
const amounts = (l) => [l.parts[0].tables[0].cells[2]['100|100'], l.parts[1].items[0].amount, l.parts[2].items[0].amount];
const shop = (over) => ({ mode: 'discount', markupPercent: 0, clientPct: 0, bonusPct: 0, ...over });

test('rabat konta zastępuje rabat cennikowy na katalogu, dopłaty z rabatem skryptu, bonus mnoży (pricesCalculator)', () => {
  const sub = list('SUB___', { SUB___CENA_RABAT: 0.3, SUB___DOPLATA_EL_RABAT: 0.1 });
  // Katalog 547 × 0,40 = 218,80; dopłata bez SUB___DOPLATA_RABAT → rabat SUB___CENA_RABAT; EL — swój.
  assert.deepEqual(amounts(shopPricelist(sub, shop({ clientPct: 60 }), true)), [218.8, 7, 90]);
  // Ekstra rabat 1% od kwoty po rabacie: 218,80 → 216,61 (przykład z komentarza applyClientDiscount).
  assert.equal(amounts(shopPricelist(sub, shop({ clientPct: 60, bonusPct: 1 }), true))[0], 216.61);
  // Grupa z parametrem SUB___DOPLATA_RABAT: dopłata bierze jego stawkę.
  const withDoplataRate = list('SUB___', { SUB___CENA_RABAT: 0.3, SUB___DOPLATA_RABAT: 0.2, SUB___DOPLATA_EL_RABAT: 0 });
  assert.deepEqual(amounts(shopPricelist(withDoplataRate, shop({ clientPct: 60 }), true)), [218.8, 8, 100]);
  // Ceny katalogowe konta = SUB___ grupy-matki bez zmian.
  assert.deepEqual(amounts(shopPricelist(sub, shop({ clientPct: 60 }), false)), [547, 10, 100]);
});

test('bez rabatu konta zostają rabaty cennikowe SUB___ (np. konta grupy typu shop)', () => {
  const sub = list('SUB___', { SUB___CENA_RABAT: 0.3, SUB___DOPLATA_EL_RABAT: 0.1 });
  assert.deepEqual(amounts(shopPricelist(sub, shop({}), true)), [382.9, 7, 90]);
  assert.equal(shopHasFinalPrices(shop({}), false), false);
  assert.equal(shopHasFinalPrices(shop({ clientPct: 5 }), false), true);
});

test('narzut: ceny zwykłe × (1 + narzut); cena końcowa = łańcuch grupy-matki × (1 + narzut)', () => {
  const cena = list('', { CENA_RABAT: 0.3, DOPLATA_EL_RABAT: 0 });
  const markup = shop({ mode: 'markup', markupPercent: 10 });
  assert.deepEqual(amounts(shopPricelist(cena, markup, false)), [601.7, 11, 110]);
  // 547 × 0,7 = 382,90 → × 1,1 = 421,19.
  assert.deepEqual(amounts(shopPricelist(cena, markup, true)), [421.19, 7.7, 110]);
});
