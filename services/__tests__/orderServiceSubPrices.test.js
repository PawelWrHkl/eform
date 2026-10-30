'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const orderService = require('../orderService');
const {
  makeOrderItem,
  makeLegacyOrderItem,
  SUB_CENA_VISIBLE,
  SUB_CENA_LOCKED,
  REGULAR_CENA
} = require('./fixtures/subPriceOrder');

test('jsonTextBackToMap extracts SUB___ params into subParamValues, not main table', async () => {
  const { cleanOrderItems } = await orderService.jsonTextBackToMap([makeOrderItem()]);
  const row = cleanOrderItems[0].rows[0];
  const subValues = row.item.subParamValues;

  assert.ok(Array.isArray(subValues));
  assert.equal(subValues.length, 4);

  const visibleSub = subValues.find((e) => e.display === 'SUB cena [€]' && !e.locked);
  const lockedSub = subValues.find((e) => e.display === 'SUB rabat [€]' && e.locked);
  assert.equal(visibleSub?.value, SUB_CENA_VISIBLE);
  assert.equal(lockedSub?.value, SUB_CENA_LOCKED);

  const headerDisplays = cleanOrderItems[0].headers2;
  assert.ok(headerDisplays.includes('Cena katalogowa [€]'));
  assert.ok(!headerDisplays.some((h) => h.includes('SUB')));
  assert.ok(!headerDisplays.some((h) => h.toLowerCase().includes('rabat')));
  assert.equal(row.row.row2['Cena katalogowa [€]'], REGULAR_CENA);
});

test('jsonTextBackToMap omits zero-percent RABAT from price rows', async () => {
  const { cleanOrderItems } = await orderService.jsonTextBackToMap([makeOrderItem()]);
  const headers2 = cleanOrderItems[0].headers2;
  assert.ok(!headers2.some((h) => h.toLowerCase().includes('rabat') && !h.toLowerCase().includes('sub')));
});

test('jsonTextBackToMap skips empty SUB___ values', async () => {
  const item = makeOrderItem();
  item.json_parameters_desc.push(
    ['SUB___PUSTY', { param_description: 'Pusty SUB', option_value: '-', row: '2' }]
  );
  const { cleanOrderItems } = await orderService.jsonTextBackToMap([item]);
  const subValues = cleanOrderItems[0].rows[0].item.subParamValues;
  assert.equal(subValues.some((e) => e.display === 'Pusty SUB'), false);
});

test('jsonTextBackToMap legacy order has empty subParamValues', async () => {
  const { cleanOrderItems } = await orderService.jsonTextBackToMap([makeLegacyOrderItem()]);
  const subValues = cleanOrderItems[0].rows[0].item.subParamValues;
  assert.deepEqual(subValues, []);
});

test('dropZeroOnlySubPrices: zlecenie HKL z samymi zerami w SUB___ nie ma cen SUB', () => {
  const zeroItem = {
    order_id: 3315,
    subParamValues: [
      { key: 'SUB___CENA_SUMA', value: '0' },
      { key: 'SUB___SUMA_BRUTTO', value: '0.00' },
      { key: 'SUB___WARTOSC_KONCOWA', value: '', locked: true }
    ],
    clientDiscountValues: [{ key: 'SUB___RABAT_KLIENTA', value: '0' }]
  };
  const pricedItem = { order_id: 3315, subParamValues: [{ key: 'SUB___CENA_SUMA', value: '0' }, { key: 'SUB___CENA', value: '12.50' }] };
  const otherOrgItem = { order_id: 4000, subParamValues: [{ key: 'SUB___CENA_SUMA', value: '0' }] };
  const table = { rows: [{ item: zeroItem }, { item: pricedItem }, { item: otherOrgItem }] };

  orderService.dropZeroOnlySubPrices([table], new Set([3315]));

  assert.deepEqual(zeroItem.subParamValues, []);
  assert.deepEqual(zeroItem.clientDiscountValues, []);
  // Choć jedna prawdziwa cena — pozycja zostaje z cenami SUB (zera też).
  assert.equal(pricedItem.subParamValues.length, 2);
  // Spoza HKL zero zostaje: „ma ceny SUB” chowa tam ceny zakupu HKL.
  assert.equal(otherOrgItem.subParamValues.length, 1);
});
