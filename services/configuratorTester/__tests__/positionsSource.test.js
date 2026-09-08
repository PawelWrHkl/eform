'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { dedupePositions } = require('../positionsSource');

const base = { org_ident: 'HKL', user_ident: 'TESTOWY', ver: '0.3.364' };

test('dedupePositions: identical configurations collapse to the newest', () => {
  const { positions, duplicates } = dedupePositions([
    Object.assign({ id: 6449, json_parameters: '{"MODEL":"TAPE","SZEROKOSC":1000}' }, base),
    Object.assign({ id: 6448, json_parameters: '{"MODEL":"TAPE","SZEROKOSC":1000}' }, base),
    Object.assign({ id: 6447, json_parameters: '{"SZEROKOSC":1000,"MODEL":"TAPE"}' }, base)
  ]);
  assert.equal(duplicates, 2);
  assert.deepEqual(positions.map((p) => p.id), [6449]);
});

test('dedupePositions: same configuration from another client is NOT a duplicate', () => {
  // The price-list variant (Excel block letter + multiplier) is per client, so
  // this genuinely exercises a second price list.
  const { positions, duplicates } = dedupePositions([
    Object.assign({ id: 2, json_parameters: '{"MODEL":"TAPE"}' }, base),
    Object.assign({ id: 1, json_parameters: '{"MODEL":"TAPE"}' }, base, { user_ident: 'LIPKA' })
  ]);
  assert.equal(duplicates, 0);
  assert.equal(positions.length, 2);
});

test('dedupePositions: differing configurations are both kept', () => {
  const { positions, duplicates } = dedupePositions([
    Object.assign({ id: 2, json_parameters: '{"MODEL":"TAPE","SZEROKOSC":1000}' }, base),
    Object.assign({ id: 1, json_parameters: '{"MODEL":"TAPE","SZEROKOSC":1200}' }, base)
  ]);
  assert.equal(duplicates, 0);
  assert.equal(positions.length, 2);
});

test('dedupePositions: a position with unreadable parameters is kept, not dropped', () => {
  const { positions, duplicates } = dedupePositions([
    Object.assign({ id: 2, json_parameters: 'to nie jest json' }, base),
    Object.assign({ id: 1, json_parameters: null }, base)
  ]);
  assert.equal(duplicates, 0);
  assert.equal(positions.length, 2);
});

test('dedupePositions: already-parsed JSON columns work too (mysql2 does that)', () => {
  const { duplicates } = dedupePositions([
    Object.assign({ id: 2, json_parameters: { MODEL: 'TAPE' } }, base),
    Object.assign({ id: 1, json_parameters: { MODEL: 'TAPE' } }, base)
  ]);
  assert.equal(duplicates, 1);
});

// Point the state file at a scratch path so these tests never touch the real
// one (runState resolves it per call for exactly this reason).
process.env.CONFIGTEST_STATE_PATH = require('node:path').join(
  require('node:os').tmpdir(), `configtest-state-test-${process.pid}.json`
);
const { getLastCheckedPositionId, setLastCheckedPositionId } = require('../runState');

test('runState: the mark only ever moves forward', () => {
  // A partial or out-of-order run must not rewind it — that would hide those
  // positions from every future run.
  const group = `__test_${process.pid}`;
  setLastCheckedPositionId(group, 100);
  assert.equal(getLastCheckedPositionId(group), 100);
  setLastCheckedPositionId(group, 50);
  assert.equal(getLastCheckedPositionId(group), 100);
  setLastCheckedPositionId(group, 150);
  assert.equal(getLastCheckedPositionId(group), 150);
});

test('runState: an unknown group reads as "nothing checked yet"', () => {
  assert.equal(getLastCheckedPositionId(`__brak_${process.pid}`), null);
});

test('runState: a non-numeric id is ignored rather than stored', () => {
  const group = `__test_nan_${process.pid}`;
  setLastCheckedPositionId(group, 'nie liczba');
  assert.equal(getLastCheckedPositionId(group), null);
});

const { spreadOrder, stride, outOfRangePoints } = require('../rangeSweep');

function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('spreadOrder: the four corners of the table come first', () => {
  // The edges of a price table are where the mistakes live, and the time
  // budget can cut the sweep at any point — so the corners must never be the
  // part that gets dropped.
  const order = spreadOrder([10, 20, 30, 40], [100, 200, 300], seededRng(1));
  assert.deepEqual(order.slice(0, 4).sort(), [[10, 100], [10, 300], [40, 100], [40, 300]].sort());
  assert.equal(order.length, 12);
});

test('spreadOrder: a truncated prefix still spans both ends of the width axis', () => {
  const order = spreadOrder([10, 20, 30, 40, 50], [100, 200], seededRng(7));
  const widths = new Set(order.slice(0, 5).map((p) => p[0]));
  assert.ok(widths.has(10) && widths.has(50), `prefiks pokrył szerokości ${[...widths]}`);
});

test('spreadOrder: is reproducible for the same seed', () => {
  assert.deepEqual(
    spreadOrder([10, 20, 30], [100, 200], seededRng(42)),
    spreadOrder([10, 20, 30], [100, 200], seededRng(42))
  );
});

test('spreadOrder: a single height (width-only table) keeps every pair', () => {
  const order = spreadOrder([10, 20, 30], [null], seededRng(1));
  assert.equal(order.length, 3);
});

test('stride: always keeps the first and last value', () => {
  const picked = stride([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
  assert.equal(picked[0], 1);
  assert.equal(picked[picked.length - 1], 10);
});

test('outOfRangePoints: no "below minimum" probe when the scale starts at 10 cm', () => {
  // A ceiling lookup puts everything under the smallest bucket INTO it, so
  // "below the range" does not exist on that side and must not be asserted.
  const points = outOfRangePoints([10, 500, 1000]);
  assert.ok(!points.some((p) => p.where.includes('poniżej')));
  assert.deepEqual(points.map((p) => p.cm), [1010, 1100]);
});

test('outOfRangePoints: probes below the minimum when the scale starts higher up', () => {
  const points = outOfRangePoints([100, 200]);
  assert.ok(points.some((p) => p.where.includes('poniżej') && p.cm === 50));
});
