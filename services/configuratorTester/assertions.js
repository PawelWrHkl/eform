/**
 * Pure P1 checks from the PDF brief (sekcja 5 "Minimalne warunki w kodzie").
 * Every function takes an engineRunner.js result and returns Finding[] — no
 * side effects, no engine calls, so these are cheap to unit test with fixtures.
 */

'use strict';

function isBlankPrice(value) {
  if (value === null || value === undefined || value === '') return true;
  const num = parseFloat(value);
  return !Number.isFinite(num) || num === 0;
}

function baseFinding(overrides) {
  return Object.assign({
    priority: 'P1',
    code: '',
    groupNumber: null,
    positionId: null,
    message: '',
    expected: null,
    actual: null,
    priceDiff: null,
    date: new Date().toISOString(),
    version: null
  }, overrides);
}

/** BRAK CENY — cena pusta/null/NaN/0 na przeliczeniu, gdzie pozycja sama miała cenę > 0 w bazie. */
function checkPriceExists(recompute) {
  if (!recompute.ok) {
    return [baseFinding({
      code: 'BLAD_PRZELICZENIA',
      groupNumber: recompute.groupNumber,
      positionId: recompute.positionId,
      message: recompute.error
    })];
  }

  const findings = [];
  const { savedTotal, recomputedTotal, groupNumber, positionId, version } = recompute;
  const hadSavedPrice = !isBlankPrice(savedTotal.total) || !isBlankPrice(savedTotal.total_sub);

  if (hadSavedPrice && isBlankPrice(recomputedTotal.total) && isBlankPrice(recomputedTotal.total_sub)) {
    findings.push(baseFinding({
      code: 'BRAK_CENY',
      groupNumber,
      positionId,
      version,
      expected: savedTotal,
      actual: recomputedTotal,
      message: `Przeliczenie pozycji #${positionId} (grupa ${groupNumber}) dało brak/zerową cenę, mimo że zapisana pozycja miała cenę > 0.`
    }));
  }

  return findings;
}

/** CENA ZANIŻONA — przeliczona cena niższa od tej faktycznie zaakceptowanej/zapisanej wcześniej. */
function checkPriceNotUnderpriced(recompute, { toleranceEur = 0.01 } = {}) {
  if (!recompute.ok) return [];
  const { savedTotal, recomputedTotal, groupNumber, positionId, version } = recompute;

  const findings = [];
  for (const key of ['total', 'total_sub']) {
    const saved = parseFloat(savedTotal[key]) || 0;
    const recomputed = parseFloat(recomputedTotal[key]) || 0;
    const diff = saved - recomputed;
    if (saved > 0 && diff > toleranceEur) {
      findings.push(baseFinding({
        code: 'CENA_ZANIZONA',
        groupNumber,
        positionId,
        version,
        expected: saved,
        actual: recomputed,
        priceDiff: parseFloat(diff.toFixed(2)),
        message: `Pozycja #${positionId} (grupa ${groupNumber}, ${key}): przeliczona cena ${recomputed} jest niższa niż zapisana ${saved} (różnica ${diff.toFixed(2)} EUR).`
      }));
    }
  }
  return findings;
}

/** KOSZYK vs KONFIGURACJA — dwa kolejne przeliczenia tych samych wartości muszą dać ten sam wynik. */
function checkCartConsistency(recomputeTwiceResult) {
  if (!recomputeTwiceResult.ok) {
    return [baseFinding({
      code: 'BLAD_PRZELICZENIA',
      groupNumber: recomputeTwiceResult.groupNumber,
      positionId: recomputeTwiceResult.positionId,
      message: recomputeTwiceResult.error
    })];
  }

  const { first, second, groupNumber, positionId } = recomputeTwiceResult;
  if (!first.ok || !second.ok) return [];

  const findings = [];
  for (const key of ['total', 'total_sub', 'total_hidden']) {
    const a = parseFloat(first.recomputedTotal[key]) || 0;
    const b = parseFloat(second.recomputedTotal[key]) || 0;
    if (Math.abs(a - b) > 0.01) {
      findings.push(baseFinding({
        code: 'KOSZYK_NIESPOJNY',
        priority: 'HIGH',
        groupNumber,
        positionId,
        expected: a,
        actual: b,
        priceDiff: parseFloat((a - b).toFixed(2)),
        message: `Pozycja #${positionId} (grupa ${groupNumber}, ${key}): dwa kolejne przeliczenia tej samej konfiguracji dały różne wyniki (${a} vs ${b}).`
      }));
    }
  }
  return findings;
}

/**
 * GRANICA WYMIARÓW — oczekiwany wynik (accept/reject) wg. semantyki testu
 * granicznego z PDF-a (39=odrzuć, 40/41=przyjmij, ...), porównany z tym, co
 * faktycznie zwrócił silnik (checkBoundaryAcceptance z engineRunner.js).
 */
function checkBoundaryResult(boundaryCheck, { groupNumber, positionId, fieldName, testValue, expectedAccepted }) {
  if (!boundaryCheck.ok) {
    return [baseFinding({
      code: 'BLAD_TESTU_GRANICZNEGO',
      priority: 'MEDIUM',
      groupNumber,
      positionId,
      message: `${fieldName}=${testValue}: ${boundaryCheck.error}`
    })];
  }

  if (boundaryCheck.accepted === expectedAccepted) return [];

  return [baseFinding({
    code: 'KONFIGURATOR_NIE_PUSZCZA_DALEJ',
    groupNumber,
    positionId,
    expected: expectedAccepted ? 'przyjęcie' : 'odrzucenie',
    actual: boundaryCheck.accepted ? 'przyjęcie' : 'odrzucenie',
    message: `Grupa ${groupNumber}, pole ${fieldName}=${testValue}: oczekiwano "${expectedAccepted ? 'przyjęcie' : 'odrzucenie'}", silnik zwrócił "${boundaryCheck.accepted ? 'przyjęcie' : 'odrzucenie'}".`
  })];
}

module.exports = {
  isBlankPrice,
  checkPriceExists,
  checkPriceNotUnderpriced,
  checkCartConsistency,
  checkBoundaryResult
};
