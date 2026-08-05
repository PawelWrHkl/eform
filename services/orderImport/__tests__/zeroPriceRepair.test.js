'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { repairZeroPriceOrder, reseedOrderParameters } = require('../zeroPriceRepair');

const PARAM_TXT = [
  'NAME\tDESCRIPTION\tTYPE\tENABLE\tFORMROW',
  'MODEL\tMODEL\tdict\t<NULL>\t1',
  'KOLOR\tKOLOR\tdict\t<NULL>\t1',
  'DLUGOSC_STER\tDŁUGOŚĆ STEROWANIA\tnumeric\t=NOT(WSROD(MODEL,"BB24"))\t1',
  'OPIS_POZYCJI\tOPIS_POZYCJI\t<NULL>\t<NULL>\t0'
].join('\n');

/**
 * Minimal mysql2-ish stub: answers the two SELECTs zeroPriceRepair issues and
 * records UPDATEs. `prices` is mutated between calls to emulate the recalc.
 */
function makeDb({ positions, prices }) {
  const updates = [];
  const connect = async () => ({
    async query(sql, params) {
      if (/FROM order_item\s+WHERE order_id = \? AND \(unit_price/.test(sql.replace(/\n\s*/g, ' '))) {
        const zero = positions
          .filter((p) => prices[p.id] === null || prices[p.id] === 0)
          .map((p) => ({ id: p.id, orderpos: p.orderpos, unit_price: prices[p.id] }));
        return [zero];
      }
      if (/JOIN organization/.test(sql)) {
        return [positions.map((p) => ({
          id: p.id,
          groupNumber: '71',
          lang: 'nl',
          json_parameters: JSON.stringify(p.values),
          userIdent: 'TCN',
          orgIdent: 'HKL'
        }))];
      }
      if (/^UPDATE order_item/.test(sql.trim())) {
        updates.push({ id: params[1], values: JSON.parse(params[0]) });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async end() {}
  });
  return { connect, updates };
}

function baseDeps(db, extra = {}) {
  const { parseParamDefinitions } = require('../paramVisibility');
  return {
    connect: db.connect,
    translationRepo: {
      async getGroupTranslations() {
        return { params: {}, paramdict: { MODEL: { BB24: 'BB 24' } } };
      }
    },
    loadClientDescriptions: async () => new Map([
      ['KOLOR', new Map([['7750-W32', { alias: '7750-W32', description: 'PG#2' }]])]
    ]),
    readFormParamDefs: async () => parseParamDefinitions(PARAM_TXT),
    log: () => {},
    ...extra
  };
}

const IMPORTED_VALUES = {
  MODEL: 'BB24',
  KOLOR: '7750-W32',
  KOLOR_ALIAS___DESCRIPTION: 'PG#2',
  DLUGOSC_STER: 800,
  DLUGOSC_STER___VISIBLE: false,
  OPIS_POZYCJI: 'Duette 32mm; Mont.hg=2600',
  OPIS_POZYCJI___VISIBLE: false,
  CENA: 0
};

test('reseedOrderParameters writes the missing price group and keeps FORMROW=0 content', async () => {
  const db = makeDb({
    positions: [{ id: 6962, orderpos: 1, values: { ...IMPORTED_VALUES } }],
    prices: { 6962: null }
  });

  const report = await reseedOrderParameters(2908, baseDeps(db));

  assert.equal(report.length, 1);
  assert.equal(report[0].changed, true);
  assert.deepEqual(report[0].seeded, ['MODEL=translation_dictionary', 'KOLOR=client_aliases']);
  assert.deepEqual(report[0].cleared, ['DLUGOSC_STER']);

  const written = db.updates[0].values;
  assert.equal(written.KOLOR___DESCRIPTION, 'PG#2');   // the tag the price gate needs
  assert.equal(written.DLUGOSC_STER, '');              // disabled by ENABLE for BB24
  assert.equal(written.OPIS_POZYCJI, 'Duette 32mm; Mont.hg=2600');  // only FORMROW=0 — keep
  assert.equal(written.WYSOKOSC___DESCRIPTION, undefined);
  assert.equal(written.KOLOR_ALIAS___DESCRIPTION, 'PG#2');
});

test('repairZeroPriceOrder recalculates and reports the order as repaired', async () => {
  const prices = { 6962: null, 6963: 0 };
  const db = makeDb({
    positions: [
      { id: 6962, orderpos: 1, values: { ...IMPORTED_VALUES } },
      { id: 6963, orderpos: 2, values: { ...IMPORTED_VALUES } }
    ],
    prices
  });

  const calls = [];
  const result = await repairZeroPriceOrder(2908, {
    deps: baseDeps(db, {
      recalculateOrderInBrowser: async (orderId) => {
        calls.push(`recalc:${orderId}`);
        prices[6962] = 115.5;   // the browser prices them now that the tag is there
        prices[6963] = 115.5;
        return { success: true, message: 'Przeliczono 2 pozycji', attempts: 1 };
      },
      rebuildDisplayValuesForOrder: async (orderId) => { calls.push(`rebuild:${orderId}`); }
    })
  });

  assert.deepEqual(calls, ['recalc:2908', 'rebuild:2908']);
  assert.deepEqual(result.zeroBefore, [1, 2]);
  assert.deepEqual(result.zeroAfter, []);
  assert.equal(result.repaired, true);
  assert.match(result.message, /Naprawiono ceny wszystkich 2 pozycji/);
});

test('repairZeroPriceOrder reports a real price-list problem when recalc does not help', async () => {
  const prices = { 6962: null };
  const db = makeDb({
    positions: [{ id: 6962, orderpos: 1, values: { ...IMPORTED_VALUES } }],
    prices
  });

  const result = await repairZeroPriceOrder(2908, {
    deps: baseDeps(db, {
      recalculateOrderInBrowser: async () => ({ success: true, message: 'Przeliczono 1 pozycji', attempts: 1 }),
      rebuildDisplayValuesForOrder: async () => {}
    })
  });

  assert.equal(result.repaired, false);
  assert.deepEqual(result.zeroAfter, [1]);
  assert.match(result.message, /Nadal cena 0 na pozycjach: #1/);
});

test('repairZeroPriceOrder skips the browser when recalculate is false', async () => {
  const db = makeDb({
    positions: [{ id: 6962, orderpos: 1, values: { ...IMPORTED_VALUES } }],
    prices: { 6962: null }
  });

  let recalcCalled = false;
  const result = await repairZeroPriceOrder(2908, {
    recalculate: false,
    deps: baseDeps(db, {
      recalculateOrderInBrowser: async () => { recalcCalled = true; return { success: true }; }
    })
  });

  assert.equal(recalcCalled, false);
  assert.equal(result.recalc, null);
  assert.equal(db.updates.length, 1);   // params still re-seeded
});

test('repairZeroPriceOrder is a no-op verdict for an order that already prices', async () => {
  const db = makeDb({
    positions: [{
      id: 7008,
      orderpos: 1,
      values: { MODEL: 'BB24', KOLOR: '7750-W32', KOLOR___DESCRIPTION: 'PG#2', CENA: 105 }
    }],
    prices: { 7008: 115.5 }
  });

  const result = await repairZeroPriceOrder(2908, {
    recalculate: false,
    deps: baseDeps(db)
  });

  assert.deepEqual(result.zeroBefore, []);
  assert.equal(result.repaired, false);
  assert.equal(result.message, 'Brak pozycji z ceną 0');
});
