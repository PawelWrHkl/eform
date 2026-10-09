'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateOrderPayload, normalizeOrderNo } = require('../orderValidator');

test('rejects non-object payload', () => {
  const r = validateOrderPayload('nope');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /not an order object/);
});

test('rejects displayValues array mistaken for order payload', () => {
  const r = validateOrderPayload([
    ['CENA', { option_value: '59.43', param_description: 'Price' }]
  ]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /json_parameters_desc/);
});

test('requires userIdent and items', () => {
  const r = validateOrderPayload({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /userIdent/.test(e)));
  assert.ok(r.errors.some((e) => /items/.test(e)));
});

test('rejects empty items array', () => {
  const r = validateOrderPayload({ userIdent: 'u1', items: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /non-empty/.test(e)));
});

test('rejects item without product/asortment', () => {
  const r = validateOrderPayload({
    userIdent: 'u1',
    items: [{ parameters: { KOLOR: 'X' } }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /product\/asortment/.test(e)));
});

test('rejects item with empty parameters', () => {
  const r = validateOrderPayload({
    userIdent: 'u1',
    items: [{ product: 'GRP1', parameters: {} }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /parameters is empty/.test(e)));
});

test('accepts a minimal valid payload', () => {
  const payload = {
    userIdent: 'CLIENT_42',
    items: [
      { product: 'SLOPE', parameters: { KOLOR: 'czarny', ILOSC: 2 } }
    ]
  };
  const r = validateOrderPayload(payload);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.data, payload);
});

test('accepts asortment alias as well as product', () => {
  const r = validateOrderPayload({
    userIdent: 'X',
    items: [{ asortment: 'SLOPE', parameters: { A: 1 } }]
  });
  assert.equal(r.ok, true);
});

test('normalizeOrderNo: no orderno means eForm numbering', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.equal(normalizeOrderNo(raw), null);
  }
});

test('normalizeOrderNo: strings are trimmed, numbers become text', () => {
  assert.equal(normalizeOrderNo('272905'), '272905');
  assert.equal(normalizeOrderNo(' 272905 '), '272905');
  assert.equal(normalizeOrderNo(272905), '272905');
  assert.equal(normalizeOrderNo('ZAM-2026.12_A'), 'ZAM-2026.12_A');
});

test('normalizeOrderNo: rejects values that cannot be an order number', () => {
  assert.throws(() => normalizeOrderNo('ZAM/2026/1'), /may only contain/);
  assert.throws(() => normalizeOrderNo('27 29'), /may only contain/);
  assert.throws(() => normalizeOrderNo('..'), /may only contain/);
  assert.throws(() => normalizeOrderNo(-5), /may only contain/);
  assert.throws(() => normalizeOrderNo('1'.repeat(33)), /longer than 32/);
  assert.throws(() => normalizeOrderNo(NaN), /not a valid number/);
  assert.throws(() => normalizeOrderNo({ no: 1 }), /string or a number/);
});

test('rejects a payload whose orderno cannot be an order number', () => {
  const r = validateOrderPayload({
    userIdent: 'u1',
    orderno: 'ZAM/2026/1',
    items: [{ product: '71', parameters: { KOLOR: 'X' } }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /orderno "ZAM\/2026\/1"/.test(e)));
});

test('accepts a payload with a usable orderno', () => {
  const r = validateOrderPayload({
    userIdent: 'u1',
    orderno: 272905,
    items: [{ product: '71', parameters: { KOLOR: 'X' } }]
  });
  assert.equal(r.ok, true);
});
