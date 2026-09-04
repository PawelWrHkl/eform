'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertions = require('../assertions');

test('checkPriceExists: flags BRAK_CENY when a previously-priced position recomputes to zero', () => {
  const findings = assertions.checkPriceExists({
    ok: true,
    groupNumber: '43',
    positionId: 101,
    version: '5',
    savedTotal: { total: 120, total_sub: 150 },
    recomputedTotal: { total: 0, total_sub: 0, total_hidden: 0 }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'BRAK_CENY');
  assert.equal(findings[0].priority, 'P1');
});

test('checkPriceExists: no finding when recompute still has a price', () => {
  const findings = assertions.checkPriceExists({
    ok: true,
    groupNumber: '43',
    positionId: 101,
    savedTotal: { total: 120, total_sub: 150 },
    recomputedTotal: { total: 118, total_sub: 148, total_hidden: 0 }
  });
  assert.equal(findings.length, 0);
});

test('checkPriceExists: surfaces engine errors as BLAD_PRZELICZENIA', () => {
  const findings = assertions.checkPriceExists({ ok: false, groupNumber: '43', positionId: 101, error: 'boom' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'BLAD_PRZELICZENIA');
});

test('checkPriceNotUnderpriced: flags CENA_ZANIZONA beyond tolerance', () => {
  const findings = assertions.checkPriceNotUnderpriced({
    ok: true,
    groupNumber: '43',
    positionId: 101,
    savedTotal: { total: 120, total_sub: 0 },
    recomputedTotal: { total: 111.5, total_sub: 0 }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'CENA_ZANIZONA');
  assert.equal(findings[0].priceDiff, 8.5);
});

test('checkPriceNotUnderpriced: tiny rounding differences are not flagged', () => {
  const findings = assertions.checkPriceNotUnderpriced({
    ok: true,
    groupNumber: '43',
    positionId: 101,
    savedTotal: { total: 120, total_sub: 0 },
    recomputedTotal: { total: 119.995, total_sub: 0 }
  });
  assert.equal(findings.length, 0);
});

test('checkCartConsistency: flags mismatched repeated recomputations', () => {
  const findings = assertions.checkCartConsistency({
    ok: true,
    groupNumber: '43',
    positionId: 101,
    first: { ok: true, recomputedTotal: { total: 100, total_sub: 100, total_hidden: 0 } },
    second: { ok: true, recomputedTotal: { total: 90, total_sub: 100, total_hidden: 0 } }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'KOSZYK_NIESPOJNY');
});

test('checkBoundaryResult: no finding when acceptance matches expectation', () => {
  const findings = assertions.checkBoundaryResult(
    { ok: true, accepted: true },
    { groupNumber: '43', positionId: 101, fieldName: 'SZEROKOSC', testValue: 40, expectedAccepted: true }
  );
  assert.equal(findings.length, 0);
});

test('checkBoundaryResult: flags a mismatch as KONFIGURATOR_NIE_PUSZCZA_DALEJ', () => {
  const findings = assertions.checkBoundaryResult(
    { ok: true, accepted: true },
    { groupNumber: '43', positionId: 101, fieldName: 'SZEROKOSC', testValue: 39, expectedAccepted: false }
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'KONFIGURATOR_NIE_PUSZCZA_DALEJ');
});
