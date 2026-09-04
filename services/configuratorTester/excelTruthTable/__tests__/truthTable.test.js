'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScriptFileName } = require('../priceVariant');
const { computePrice, ceilingBucket } = require('../truthTableLookup');

test('parseScriptFileName: plain block letter', () => {
  assert.deepEqual(parseScriptFileName('param-CENA-C.js', 'CENA'), { letter: 'C', multiplier: 1 });
});

test('parseScriptFileName: block letter with multiplier', () => {
  assert.deepEqual(parseScriptFileName('param-CENA-Bmul0.32.js', 'CENA'), { letter: 'B', multiplier: 0.32 });
});

test('parseScriptFileName: rejects a different param', () => {
  assert.equal(parseScriptFileName('param-DOPLATA-A.js', 'CENA'), null);
});

test('ceilingBucket: picks the first bound at or above the value', () => {
  const entries = [{ b: 10 }, { b: 20 }, { b: 30 }];
  assert.equal(ceilingBucket(entries, 11, (e) => e.b).b, 20);
  assert.equal(ceilingBucket(entries, 20, (e) => e.b).b, 20);
  assert.equal(ceilingBucket(entries, 31, (e) => e.b), null);
});

/**
 * Synthetic sheet mirroring the real layout: the block's first column is the
 * height axis, price columns follow with widths from row 2, and a section's
 * rows are looked up by CEILING bucket on both axes.
 *
 *          axisCol(3)   col4(w=10)  col5(w=20)
 *   row 11      10          100         200
 *   row 12      20          300         400
 */
function fakeSheet() {
  const cells = {
    '11,3': 10, '11,4': 100, '11,5': 200,
    '12,3': 20, '12,4': 300, '12,5': 400
  };
  return {
    blocks: [{ letter: 'A', axisCol: 3, startCol: 3, endCol: 5 }],
    sections: [{
      label: 'PG0', headerRow: 10, conditions: ['C1', 'C2'], dataStartRow: 11, dataEndRow: 12,
      shapeByBlock: {
        A: {
          kind: 'grid2d',
          widths: [{ col: 4, widthCm: 10 }, { col: 5, widthCm: 20 }],
          heightRows: [{ row: 11, heightCm: 10 }, { row: 12, heightCm: 20 }]
        }
      }
    }],
    valueAt: (r, c) => (cells[`${r},${c}`] ?? null)
  };
}

test('computePrice: exact bucket hit', () => {
  const sheet = fakeSheet();
  const result = computePrice({
    sheet, letter: 'A', widthMm: 100, heightMm: 100,
    evaluateCondition: (f) => f === 'C1'
  });
  assert.equal(result.found, true);
  assert.equal(result.price, 100);
});

test('computePrice: rounds both axes UP to the next bucket (no interpolation)', () => {
  const sheet = fakeSheet();
  const result = computePrice({
    sheet, letter: 'A', widthMm: 101, heightMm: 101,
    evaluateCondition: (f) => f === 'C1'
  });
  // width 10.1cm → bucket 20, height 10.1cm → bucket 20 ⇒ row 12 / col 5
  assert.equal(result.price, 400);
});

test('computePrice: both colour conditions matching doubles the section', () => {
  const sheet = fakeSheet();
  const result = computePrice({
    sheet, letter: 'A', widthMm: 100, heightMm: 100,
    evaluateCondition: () => true
  });
  assert.equal(result.price, 200);
  assert.equal(result.contributions[0].multiplicity, 2);
});

test('computePrice: applies the client multiplier after summing', () => {
  const sheet = fakeSheet();
  const result = computePrice({
    sheet, letter: 'A', multiplier: 0.5, widthMm: 100, heightMm: 100,
    evaluateCondition: (f) => f === 'C1'
  });
  assert.equal(result.price, 50);
});

test('computePrice: no matching section is reported, never guessed', () => {
  const sheet = fakeSheet();
  const result = computePrice({
    sheet, letter: 'A', widthMm: 100, heightMm: 100, evaluateCondition: () => false
  });
  assert.equal(result.found, false);
  assert.match(result.reason, /żadna sekcja/);
});

test('computePrice: dimensions above the table are reported, never extrapolated', () => {
  const sheet = fakeSheet();
  const result = computePrice({
    sheet, letter: 'A', widthMm: 9999, heightMm: 100, evaluateCondition: () => true
  });
  assert.equal(result.found, false);
  assert.match(result.reason, /powyżej zakresu/);
});

test('computePrice: unknown block letter is reported', () => {
  const sheet = fakeSheet();
  const result = computePrice({
    sheet, letter: 'Z', widthMm: 100, heightMm: 100, evaluateCondition: () => true
  });
  assert.equal(result.found, false);
  assert.match(result.reason, /bloku Z/);
});

/** Scalar sheet (DOPLATA shape): one flat amount per section on its label row. */
function fakeScalarSheet() {
  const cells = { '2,3': 79 };
  const formulas = { '5,3': 'ROUND(CENA*0.1,2)' };
  return {
    kind: 'scalar',
    blocks: [{ letter: 'A', axisCol: 3, startCol: 3, endCol: 3 }],
    sections: [
      { label: 'AB10', headerRow: 2, conditions: ['C1'], dataStartRow: 3, dataEndRow: 4, shapeByBlock: { A: { kind: 'scalar', widths: [] } } },
      { label: 'BB24', headerRow: 5, conditions: ['C2'], dataStartRow: 6, dataEndRow: 7, shapeByBlock: { A: { kind: 'scalar', widths: [] } } }
    ],
    valueAt: (r, c) => (cells[`${r},${c}`] ?? null),
    formulaAt: (r, c) => (formulas[`${r},${c}`] ?? null)
  };
}

test('computePrice: scalar sheet reads the flat amount off the section row', () => {
  const sheet = fakeScalarSheet();
  const result = computePrice({
    sheet, letter: 'A', widthMm: 1000, heightMm: 1000,
    evaluateCondition: (f) => f === 'C1'
  });
  assert.equal(result.found, true);
  assert.equal(result.price, 79);
  assert.equal(result.derived, false);
});

test('computePrice: scalar sheet evaluates a formula-valued cell and marks it derived', () => {
  const sheet = fakeScalarSheet();
  const result = computePrice({
    sheet, letter: 'A', widthMm: 1000, heightMm: 1000,
    evaluateCondition: (f) => f === 'C2',
    evaluateNumber: (formula) => (formula === 'ROUND(CENA*0.1,2)' ? 10.19 : NaN)
  });
  assert.equal(result.price, 10.19);
  assert.equal(result.derived, true);
  assert.equal(result.contributions[0].formula, 'ROUND(CENA*0.1,2)');
});

test('computePrice: an empty scalar cell contributes zero, not a gap', () => {
  const sheet = fakeScalarSheet();
  sheet.sections.push({ label: 'EMPTY', headerRow: 9, conditions: ['C3'], dataStartRow: 10, dataEndRow: 10, shapeByBlock: { A: { kind: 'scalar', widths: [] } } });
  const result = computePrice({
    sheet, letter: 'A', widthMm: 1000, heightMm: 1000,
    evaluateCondition: (f) => f === 'C3'
  });
  assert.equal(result.found, true);
  assert.equal(result.price, 0);
  assert.equal(result.contributions[0].empty, true);
});

test('computePrice: width-only (1-D) section ignores the height axis', () => {
  const cells = { '21,4': 22.44, '21,5': 46.33 };
  const sheet = {
    kind: 'grid',
    blocks: [{ letter: 'K', axisCol: 3, startCol: 3, endCol: 5 }],
    sections: [{
      label: 'XLEL', headerRow: 20, conditions: ['C1'], dataStartRow: 21, dataEndRow: 22,
      shapeByBlock: { K: { kind: 'grid1d', widths: [{ col: 4, widthCm: 10 }, { col: 5, widthCm: 20 }], dataRow: 21 } }
    }],
    valueAt: (r, c) => (cells[`${r},${c}`] ?? null),
    formulaAt: () => null
  };
  const result = computePrice({
    sheet, letter: 'K', widthMm: 200, heightMm: 99999,
    evaluateCondition: () => true
  });
  assert.equal(result.found, true);
  assert.equal(result.price, 46.33);
});
