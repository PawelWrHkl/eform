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

test('checkAgainstReferencePrice: actualPrice + source describe who computed it', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '73', positionId: 6449, paramName: 'CENA', actualPrice: 60,
    source: 'wdrożony skrypt',
    reference: { found: true, price: 87.36, letter: 'C', multiplier: 1.4, contributions: [] }
  });
  assert.equal(findings[0].code, 'CENA_ZANIZONA');
  assert.match(findings[0].message, /wdrożony skrypt policzył 60/);
});

test('checkEngineMatchesDeployedScript: agreement reports nothing', () => {
  const findings = assertions.checkEngineMatchesDeployedScript({
    groupNumber: '73', positionId: 6438, paramName: 'CENA', enginePrice: 44.62, scriptPrice: 44.62
  });
  assert.equal(findings.length, 0);
});

test('checkEngineMatchesDeployedScript: disagreement is MEDIUM, not a pricing claim', () => {
  const findings = assertions.checkEngineMatchesDeployedScript({
    groupNumber: '73', positionId: 6449, paramName: 'CENA',
    enginePrice: 38.02, scriptPrice: 87.36, scriptFile: 'param-CENA-Cmul1.4.js'
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM');
  assert.equal(findings[0].priority, 'MEDIUM');
  assert.equal(findings[0].expected, 87.36);
  assert.equal(findings[0].actual, 38.02);
});

test('checkEngineMatchesDeployedScript: non-numeric sides are not a finding', () => {
  assert.equal(assertions.checkEngineMatchesDeployedScript({
    groupNumber: '73', positionId: 1, paramName: 'CENA', enginePrice: '', scriptPrice: 87.36
  }).length, 0);
});

test("checkAgainstReferencePrice: an unknown axis is 'no reference', never 'no basis'", () => {
  // Group 73 position #6376: the headless recompute leaves SZEROKOSC_POTRZEBNA
  // undefined, so the lookup cannot tell WHERE in the table to read. Claiming
  // the price has no basis in the price list would be a false accusation — in
  // the browser that position prices at 166.61 and matches the workbook.
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '73', positionId: 6376, paramName: 'CENA', actualPrice: 42.34,
    source: 'wdrożony skrypt',
    reference: { found: false, kind: 'unknown-axis', reason: 'nie da się ustalić osi X sekcji PG2' }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'BRAK_DANYCH_REFERENCYJNYCH');
  assert.equal(findings[0].priority, 'MEDIUM');
});

// --- rangeSweep: konfiguracje generowane przez tester -----------------------

test('checkInRangePrice: a size the price list covers but the script prices at 0 is P1', () => {
  const findings = assertions.checkInRangePrice({
    groupNumber: '73', paramName: 'CENA', size: '250×150 cm', scriptPrice: 0,
    reference: { found: true, price: 87.36, letter: 'C', multiplier: 1.4 }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'BRAK_CENY_W_ZAKRESIE_CENNIKA');
  assert.equal(findings[0].priority, 'P1');
});

test('checkInRangePrice: agreement inside the range reports nothing', () => {
  assert.equal(assertions.checkInRangePrice({
    groupNumber: '73', paramName: 'CENA', size: '250×150 cm', scriptPrice: 87.36,
    reference: { found: true, price: 87.36, letter: 'C', multiplier: 1.4 }
  }).length, 0);
});

test('checkInRangePrice: script below the price list is P1, above is HIGH', () => {
  const low = assertions.checkInRangePrice({
    groupNumber: '73', paramName: 'CENA', size: '250×150 cm', scriptPrice: 50,
    reference: { found: true, price: 87.36, letter: 'C', multiplier: 1 }
  });
  const high = assertions.checkInRangePrice({
    groupNumber: '73', paramName: 'CENA', size: '250×150 cm', scriptPrice: 120,
    reference: { found: true, price: 87.36, letter: 'C', multiplier: 1 }
  });
  assert.equal(low[0].priority, 'P1');
  assert.equal(low[0].code, 'CENA_ZANIZONA');
  assert.equal(high[0].priority, 'HIGH');
  assert.equal(high[0].code, 'CENA_NIEZGODNA_Z_CENNIKIEM');
});

test('checkInRangePrice: a formula-derived reference never raises a price claim', () => {
  assert.equal(assertions.checkInRangePrice({
    groupNumber: '71', paramName: 'DOPLATA', size: '100×100 cm', scriptPrice: 7.92,
    reference: { found: true, derived: true, price: 8.15, letter: 'D', multiplier: 1 }
  }).length, 0);
});

test('checkOutOfRangePrice: charging beyond the table is HIGH — nobody authored that price', () => {
  const findings = assertions.checkOutOfRangePrice({
    groupNumber: '73', paramName: 'CENA', size: '1100×370 cm', where: 'szerokość powyżej maksimum',
    scriptPrice: 240, reference: { found: false, reason: 'powyżej zakresu tabeli' }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'CENA_POZA_ZAKRESEM_CENNIKA');
  assert.equal(findings[0].priority, 'HIGH');
});

test('checkOutOfRangePrice: a price list that DOES cover the point is not a finding', () => {
  // The probe landed inside another section's range after all — the sweep must
  // not invent a rule the price list does not have.
  assert.equal(assertions.checkOutOfRangePrice({
    groupNumber: '73', paramName: 'CENA', size: '1010×370 cm', where: 'szerokość powyżej maksimum',
    scriptPrice: 120, reference: { found: true, price: 120, letter: 'C', multiplier: 1 }
  }).length, 0);
});

test('checkFormAcceptsOutOfRangeDimension: a rejected dimension is correct behaviour', () => {
  // Verified on the live form (group 73, #6449): 11000 mm against a table
  // ending at 1000 cm gives inputFlags false + a red border. Nothing to report.
  assert.equal(assertions.checkFormAcceptsOutOfRangeDimension({
    groupNumber: '73', positionId: 6449, fieldName: 'SZEROKOSC', valueMm: 11000,
    maxInPriceListCm: 1000, rejected: true, price: 0
  }).length, 0);
});

test('checkFormAcceptsOutOfRangeDimension: accepted with no price is P1', () => {
  const findings = assertions.checkFormAcceptsOutOfRangeDimension({
    groupNumber: '73', positionId: 6449, fieldName: 'SZEROKOSC', valueMm: 11000,
    maxInPriceListCm: 1000, rejected: false, price: 0
  });
  assert.equal(findings[0].code, 'WYMIAR_POZA_CENNIKIEM_PRZYJETY');
  assert.equal(findings[0].priority, 'P1');
});

test('checkFormAcceptsOutOfRangeDimension: accepted with a price nobody authored is HIGH', () => {
  const findings = assertions.checkFormAcceptsOutOfRangeDimension({
    groupNumber: '73', positionId: 6449, fieldName: 'SZEROKOSC', valueMm: 11000,
    maxInPriceListCm: 1000, rejected: false, price: 240.5
  });
  assert.equal(findings[0].code, 'CENA_POZA_ZAKRESEM_CENNIKA');
  assert.equal(findings[0].priority, 'HIGH');
  assert.equal(findings[0].actual, 240.5);
});

test('checkFormAcceptsOutOfRangeDimension: a blank price counts as no price', () => {
  const findings = assertions.checkFormAcceptsOutOfRangeDimension({
    groupNumber: '73', positionId: 1, fieldName: 'SZEROKOSC', valueMm: 11000,
    maxInPriceListCm: 1000, rejected: false, price: ''
  });
  assert.equal(findings[0].code, 'WYMIAR_POZA_CENNIKIEM_PRZYJETY');
});

test('checkUnpriceableOptions: nothing unpriceable, nothing reported', () => {
  assert.equal(assertions.checkUnpriceableOptions({
    groupNumber: '73', paramName: 'CENA', unpriceable: [], checked: 284
  }).length, 0);
});

test('checkUnpriceableOptions: a minority without a price is one P1, not one per option', () => {
  // 254 colours in a single unpriced group would otherwise bury the report.
  const unpriceable = Array.from({ length: 30 }, (_, i) => ({ fieldName: 'KOLOR', value: `X${i}`, description: 'PG #9' }));
  const findings = assertions.checkUnpriceableOptions({
    groupNumber: '73', paramName: 'CENA', unpriceable, checked: 284
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'BRAK_CENY_DLA_OPCJI');
  assert.equal(findings[0].priority, 'P1');
  assert.match(findings[0].message, /30 z 284/);
});

test('checkUnpriceableOptions: options that restructure the form are HIGH, not P1', () => {
  // Group 75's Skylight models price at 0 everywhere we can look, but MODEL
  // carries a PROC and its picker is a dialog — so a value swap is not proof
  // that a customer can choose it in this configuration.
  const findings = assertions.checkUnpriceableOptions({
    groupNumber: '75', paramName: 'CENA', checked: 131,
    unpriceable: [
      { fieldName: 'MODEL', value: 'DACH_KOMF', description: 'SKYLIGHT COMFORT', structural: true },
      { fieldName: 'MODEL', value: 'DACH_BAS', description: 'SKYLIGHT BASIC', structural: true }
    ]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'BRAK_CENY_DLA_OPCJI_DO_POTWIERDZENIA');
  assert.equal(findings[0].priority, 'HIGH');
});

test('checkUnpriceableOptions: structural and plain options are reported separately', () => {
  const findings = assertions.checkUnpriceableOptions({
    groupNumber: '75', paramName: 'CENA', checked: 100,
    unpriceable: [
      { fieldName: 'MODEL', value: 'DACH_BAS', description: '', structural: true },
      { fieldName: 'KOLOR', value: '935-25', description: 'PG #3' }
    ]
  });
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.priority).sort(), ['HIGH', 'P1']);
});

test('checkUnpriceableOptions: EVERY option unpriced points at the base config, so MEDIUM', () => {
  // All of them failing is far likelier to mean the sweep started from a
  // configuration that cannot be priced than that the whole collection broke.
  const unpriceable = Array.from({ length: 12 }, (_, i) => ({ fieldName: 'KOLOR', value: `X${i}`, description: '' }));
  const findings = assertions.checkUnpriceableOptions({
    groupNumber: '73', paramName: 'CENA', unpriceable, checked: 12
  });
  assert.equal(findings[0].code, 'BRAK_CENY_DLA_OPCJI_DO_SPRAWDZENIA');
  assert.equal(findings[0].priority, 'MEDIUM');
});

test('checkAgainstReferencePrice: the workbook reference is scaled by the customer surcharge', () => {
  // Group 71 #7262: workbook 304, screen 317.68, the script's own label says
  // *1.045. The surcharge is a per-customer arrangement that the workbook does
  // not contain, so without scaling every such order reads as overpriced.
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '71', positionId: 7262, paramName: 'CENA', actualPrice: 317.68,
    source: 'przeglądarka', referenceFactor: 1.045,
    reference: { found: true, price: 304, letter: 'K', multiplier: 1, contributions: [] }
  });
  assert.equal(findings.length, 0);
});

test('checkAgainstReferencePrice: a real difference still surfaces under a surcharge', () => {
  const findings = assertions.checkAgainstReferencePrice({
    groupNumber: '71', positionId: 7262, paramName: 'CENA', actualPrice: 250,
    source: 'przeglądarka', referenceFactor: 1.045,
    reference: { found: true, price: 304, letter: 'K', multiplier: 1, contributions: [] }
  });
  assert.equal(findings[0].code, 'CENA_ZANIZONA');
  assert.equal(findings[0].expected, 317.68);
  assert.match(findings[0].message, /dopłatą klienta ×1\.045/);
});

test('checkInRangePrice: the surcharge scales the reference there too', () => {
  assert.equal(assertions.checkInRangePrice({
    groupNumber: '71', paramName: 'CENA', size: '250×150 cm', scriptPrice: 317.68,
    referenceFactor: 1.045,
    reference: { found: true, price: 304, letter: 'K', multiplier: 1 }
  }).length, 0);
});

test('checkOutOfRangePrice: both sides silent is summarised elsewhere, not per probe', () => {
  // One line per probe per base meant 12 near-identical MEDIUM entries for
  // group 20 alone; the summary lives in checkOutOfRangeDimensionsSilent.
  assert.equal(assertions.checkOutOfRangePrice({
    groupNumber: '20', paramName: 'CENA', size: '160×120 cm', where: 'szerokość powyżej maksimum',
    scriptPrice: 0, reference: { found: false, reason: 'powyżej zakresu tabeli' }
  }).length, 0);
});

test('checkOutOfRangeDimensionsSilent: one finding listing the sizes, duplicates collapsed', () => {
  const findings = assertions.checkOutOfRangeDimensionsSilent({
    groupNumber: '20', paramName: 'CENA',
    sizes: ['160×120 cm (szerokość powyżej maksimum)', '160×120 cm (szerokość powyżej maksimum)', '80×230 cm (wysokość powyżej maksimum)']
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].priority, 'MEDIUM');
  assert.match(findings[0].message, /160×120/);
  assert.match(findings[0].message, /80×230/);
  // The size list goes into `actual` so the report's deduplication cannot
  // merge two different sets that happen to be the same length.
  assert.match(findings[0].actual, /160×120 cm.*80×230 cm/);
});

test('checkOutOfRangeDimensionsSilent: nothing silent, nothing reported', () => {
  assert.equal(assertions.checkOutOfRangeDimensionsSilent({ groupNumber: '20', paramName: 'CENA', sizes: [] }).length, 0);
});

test('summariseGroupDiagnostics: per-position diagnostics collapse to one line each', () => {
  // Group 73 produced 14 BRAK_DANYCH_REFERENCYJNYCH and 4
  // PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM across 11 positions.
  const findings = [
    { code: 'CENA_ZANIZONA', priority: 'P1', positionId: 1, message: 'x' },
    ...Array.from({ length: 14 }, (_, i) => ({ code: 'BRAK_DANYCH_REFERENCYJNYCH', priority: 'MEDIUM', positionId: 6000 + i, message: 'y' })),
    ...Array.from({ length: 4 }, (_, i) => ({ code: 'PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM', priority: 'MEDIUM', positionId: 7000 + i, message: 'z' }))
  ];
  const out = assertions.summariseGroupDiagnostics(findings, { groupNumber: '73' });
  assert.equal(out.length, 3);
  assert.equal(out.filter((f) => f.code === 'CENA_ZANIZONA').length, 1);
  const summary = out.find((f) => f.code === 'BRAK_DANYCH_REFERENCYJNYCH');
  assert.match(summary.message, /dla 14 sprawdzeń/);
  assert.match(summary.message, /razem 14/);
});

test('summariseGroupDiagnostics: leaves everything else untouched', () => {
  const findings = [{ code: 'BRAK_CENY', priority: 'P1', positionId: 5, message: 'x' }];
  assert.deepEqual(assertions.summariseGroupDiagnostics(findings, { groupNumber: '11' }), findings);
});
