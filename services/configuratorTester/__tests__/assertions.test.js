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

test('checkNoBlockedFields: no finding when nothing is blocked', () => {
  const findings = assertions.checkNoBlockedFields({ ok: true, groupNumber: '43', blockedFields: [] });
  assert.equal(findings.length, 0);
});

test('checkNoBlockedFields: flags a stuck field as KONFIGURATOR_NIE_PUSZCZA_DALEJ', () => {
  const findings = assertions.checkNoBlockedFields({ ok: true, groupNumber: '43', blockedFields: ['KOLOR'] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'KONFIGURATOR_NIE_PUSZCZA_DALEJ');
});

test('checkFreshConfigHasPrice: flags BRAK_CENY on a complete, unpriced fresh configuration', () => {
  const findings = assertions.checkFreshConfigHasPrice(
    { ok: true, groupNumber: '43', blockedFields: [], values: { MODEL: 'VS2', uid: 'x' } },
    { total: 0, total_sub: 0 }
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'BRAK_CENY');
});

test('checkFreshConfigHasPrice: no finding when the fresh configuration has a price', () => {
  const findings = assertions.checkFreshConfigHasPrice(
    { ok: true, groupNumber: '43', blockedFields: [], values: {} },
    { total: 50, total_sub: 50 }
  );
  assert.equal(findings.length, 0);
});

test('checkFreshConfigHasPrice: no finding for a blocked (incomplete) configuration', () => {
  const findings = assertions.checkFreshConfigHasPrice(
    { ok: true, groupNumber: '43', blockedFields: ['SZEROKOSC'], values: {} },
    { total: 0, total_sub: 0 }
  );
  assert.equal(findings.length, 0);
});

test('checkBoundaryResult: reports a mismatch as an informational MEDIUM, not P1', () => {
  const findings = assertions.checkBoundaryResult(
    { ok: true, accepted: true },
    { groupNumber: '43', positionId: 101, fieldName: 'SZEROKOSC', testValue: 39, expectedAccepted: false }
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'WALIDACJA_WYMIARU_DO_SPRAWDZENIA');
  assert.equal(findings[0].priority, 'MEDIUM');
});

test('checkAgainstReferencePrice: engine below the price list is a P1', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '71', positionId: 1, paramName: 'CENA', enginePrice: 100,
    reference: { found: true, price: 120, letter: 'A', multiplier: 1, contributions: [] }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'CENA_ZANIZONA');
  assert.equal(findings[0].priority, 'P1');
  assert.equal(findings[0].priceDiff, 20);
});

test('checkAgainstReferencePrice: engine above the price list is HIGH, not P1', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '71', positionId: 1, paramName: 'CENA', enginePrice: 130,
    reference: { found: true, price: 120, letter: 'A', multiplier: 1, contributions: [] }
  });
  assert.equal(findings[0].code, 'CENA_NIEZGODNA_Z_CENNIKIEM');
  assert.equal(findings[0].priority, 'HIGH');
});

test('checkAgainstReferencePrice: agreement produces no finding', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '71', positionId: 1, paramName: 'CENA', enginePrice: 120,
    reference: { found: true, price: 120, letter: 'A', multiplier: 1, contributions: [] }
  });
  assert.equal(findings.length, 0);
});

test('checkAgainstReferencePrice: missing reference is MEDIUM, never a price claim', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '71', positionId: 1, paramName: 'CENA', enginePrice: 120,
    reference: { found: false, reason: 'brak wariantu cennika' }
  });
  assert.equal(findings[0].code, 'BRAK_DANYCH_REFERENCYJNYCH');
  assert.equal(findings[0].priority, 'MEDIUM');
});

test('checkAgainstReferencePrice: no matching section + engine charging nothing = agreement', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '43', positionId: 5, paramName: 'DOPLATA', enginePrice: 0,
    reference: { found: false, kind: 'no-match', reason: 'żadna sekcja cennika nie pasuje' }
  });
  assert.equal(findings.length, 0);
});

test('checkAgainstReferencePrice: charging with no price-list basis is HIGH', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '43', positionId: 5, paramName: 'DOPLATA', enginePrice: 12.5,
    reference: { found: false, kind: 'no-match', reason: 'żadna sekcja cennika nie pasuje' }
  });
  assert.equal(findings[0].code, 'CENA_BEZ_PODSTAWY_W_CENNIKU');
  assert.equal(findings[0].priority, 'HIGH');
});

test('checkAgainstReferencePrice: formula-derived difference stays MEDIUM', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '71', positionId: 7, paramName: 'DOPLATA', enginePrice: 7.92,
    reference: { found: true, derived: true, price: 8.15, letter: 'D', multiplier: 0.8, contributions: [{ section: 'BB24', formula: 'ROUND(CENA*0.1,2)' }] }
  });
  assert.equal(findings[0].code, 'CENA_POCHODNA_DO_SPRAWDZENIA');
  assert.equal(findings[0].priority, 'MEDIUM');
});
