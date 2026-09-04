'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTransposedTsv } = require('../groupDiscovery');

test('parseTransposedTsv: parses a group.txt-shaped transposed TSV', () => {
  const text = [
    'NUM\t1\t2\t3',
    'PRODUCTS\t71,43,20\t39,02,59,04\t75,76',
    'DESCRIPTION\tPLISY\tALUZJE\tROLETY'
  ].join('\n');

  const objects = parseTransposedTsv(text);
  assert.equal(objects.length, 3);
  assert.deepEqual(objects[0], { num: '1', products: '71,43,20', description: 'PLISY' });
  assert.deepEqual(objects[2], { num: '3', products: '75,76', description: 'ROLETY' });
});

test('parseTransposedTsv: drops trailing empty columns', () => {
  const text = 'NUM\t1\t\t\nPRODUCTS\t71\t\t\n';
  const objects = parseTransposedTsv(text);
  assert.equal(objects.length, 1);
});
