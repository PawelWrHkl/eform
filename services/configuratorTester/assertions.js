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

  // ⚠️ MEDIUM, not P1, on purpose. The oracle here is `window.inputFlags[field]`
  // after a synthetically targeted updateProcedure, and that turned out NOT to
  // be a trustworthy accept/reject signal: on a real order whose width no
  // validator constrains at all (no MIN/MAX rule anywhere in
  // window.inputsValidators), the flag still came back false. The browser
  // reaches this state through its own event sequence (input → debounce →
  // updateProcedure), and approximating that flips the flag. Reporting this as
  // P1 produced false alarms, so it stays informational until the acceptance
  // signal itself is proven — the verified price signal now lives in
  // checkAgainstReferencePrice().
  return [baseFinding({
    code: 'WALIDACJA_WYMIARU_DO_SPRAWDZENIA',
    priority: 'MEDIUM',
    groupNumber,
    positionId,
    expected: expectedAccepted ? 'przyjęcie' : 'odrzucenie',
    actual: boundaryCheck.accepted ? 'przyjęcie' : 'odrzucenie',
    message: `Grupa ${groupNumber}, pole ${fieldName}=${testValue}: oczekiwano "${expectedAccepted ? 'przyjęcie' : 'odrzucenie'}", odczyt walidacji dał "${boundaryCheck.accepted ? 'przyjęcie' : 'odrzucenie'}". ⚠️ Sygnał orientacyjny — odczyt inputFlags po syntetycznym przeliczeniu nie jest w pełni wiarygodny, wymaga ręcznego potwierdzenia w przeglądarce.`
  })];
}

/**
 * KONFIGURATOR NIE PUSZCZA DALEJ — formWalker.js could not find ANY legal
 * value for a visible, fillable field after the walk stabilized (an empty
 * option list a real client would also hit).
 */
function checkNoBlockedFields(walkerResult) {
  if (!walkerResult.ok) {
    return [baseFinding({
      code: 'BLAD_PRZELICZENIA',
      groupNumber: walkerResult.groupNumber,
      message: walkerResult.error
    })];
  }
  if (!walkerResult.blockedFields || walkerResult.blockedFields.length === 0) return [];

  return [baseFinding({
    code: 'KONFIGURATOR_NIE_PUSZCZA_DALEJ',
    groupNumber: walkerResult.groupNumber,
    version: walkerResult.version,
    expected: walkerResult.blockedFields.map((f) => `${f}: co najmniej jedna opcja`),
    actual: walkerResult.blockedFields.map((f) => `${f}: brak dostępnych opcji`),
    message: `Grupa ${walkerResult.groupNumber}: pole(a) ${walkerResult.blockedFields.join(', ')} nie mają żadnej dostępnej opcji w skonstruowanej konfiguracji — klient utknąłby w tym samym miejscu.`
  })];
}

/**
 * BRAK CENY na świeżo zbudowanej, od zera, konfiguracji (formWalker.js) —
 * bez punktu odniesienia z historii: każda pełna, nie zablokowana
 * konfiguracja musi wycenić się na > 0, inaczej to dokładnie PDF-owy
 * "brak ceny albo cena zaniżona — najwyższy priorytet finansowy".
 */
function checkFreshConfigHasPrice(walkerResult, recomputedTotal) {
  if (!walkerResult.ok) return []; // already reported by checkNoBlockedFields
  if (walkerResult.blockedFields && walkerResult.blockedFields.length > 0) return []; // can't price an incomplete config

  const hasPrice = !isBlankPrice(recomputedTotal.total) || !isBlankPrice(recomputedTotal.total_sub);
  if (hasPrice) return [];

  const relevantValues = {};
  for (const [k, v] of Object.entries(walkerResult.values)) {
    if (!k.includes('___') && !k.endsWith('_ALIAS') && k !== 'uid' && v !== '') relevantValues[k] = v;
  }

  return [baseFinding({
    code: 'BRAK_CENY',
    groupNumber: walkerResult.groupNumber,
    version: walkerResult.version,
    expected: 'cena > 0',
    actual: recomputedTotal,
    message: `Grupa ${walkerResult.groupNumber}: kompletna, niezablokowana konfiguracja wyceniła się na 0 — każde pole z osobna było dostępne do wyboru, ale ich kombinacja nie ma ceny w drzewie cenowym. Konfiguracja: ${JSON.stringify(relevantValues)}`
  })];
}

/**
 * CENA ZANIŻONA / NIEZGODNA Z CENNIKIEM — the engine's own price for a
 * configuration versus the reference read straight from the authoring workbook
 * (services/configuratorTester/excelTruthTable). This is the PDF brief's
 * "niezależna tabela prawdy": the workbook is where prices are authored, the
 * `param-*.js` the portal runs is a build artifact of it, so a difference means
 * the build drifted from the source — stale scripts, a bad generation, or
 * unpublished edits.
 *
 * The engine pricing LOWER than the price list is the financially dangerous
 * direction, so that is P1; pricing HIGHER is reported as HIGH (still wrong,
 * but it does not lose money silently). A per-uid client surcharge factor the
 * generated scripts apply last (and which is not in the workbook) can explain
 * small positive differences — hence `toleranceEur`.
 */
function checkAgainstReferencePrice({ groupNumber, positionId, paramName, enginePrice, reference }, { toleranceEur = 0.02 } = {}) {
  const engine = parseFloat(enginePrice);

  if (!reference || reference.found !== true) {
    // "No section of the price list applies" means the reference is 0 — the
    // compiled script would sum nothing either. If the engine also charges
    // nothing, the two AGREE and there is nothing to report; only the engine
    // charging for something the price list does not define is a real signal.
    if (reference && reference.kind === 'no-match') {
      if (!Number.isFinite(engine) || engine === 0) return [];
      return [baseFinding({
        code: 'CENA_BEZ_PODSTAWY_W_CENNIKU',
        priority: 'HIGH',
        groupNumber,
        positionId,
        expected: 0,
        actual: engine,
        priceDiff: parseFloat((0 - engine).toFixed(2)),
        message: `${paramName} dla grupy ${groupNumber}${positionId ? ` (pozycja #${positionId})` : ''}: silnik naliczył ${engine}, ale żadna sekcja cennika nie pasuje do tej konfiguracji — brak podstawy w cenniku.`
      })];
    }

    return [baseFinding({
      code: 'BRAK_DANYCH_REFERENCYJNYCH',
      priority: 'MEDIUM',
      groupNumber,
      positionId,
      message: `${paramName}: nie udało się ustalić ceny wzorcowej z cennika — ${reference ? reference.reason : 'brak wyniku'}`
    })];
  }

  if (!Number.isFinite(engine)) return [];

  const diff = reference.price - engine;
  if (Math.abs(diff) <= toleranceEur) return [];

  // Reference values derived from a cell formula read the engine's own
  // intermediate params back (see truthTableLookup's `derived` flag), so a few
  // percent of drift is expected and must not masquerade as a pricing bug.
  if (reference.derived) {
    return [baseFinding({
      code: 'CENA_POCHODNA_DO_SPRAWDZENIA',
      priority: 'MEDIUM',
      groupNumber,
      positionId,
      expected: reference.price,
      actual: engine,
      priceDiff: parseFloat(diff.toFixed(2)),
      message: `${paramName} dla grupy ${groupNumber}${positionId ? ` (pozycja #${positionId})` : ''}: wzorzec ${reference.price} vs silnik ${engine} (różnica ${diff.toFixed(2)} EUR). ⚠️ Wzorzec liczony z formuły w cenniku (${(reference.contributions || []).filter((c) => c.formula).map((c) => `${c.section}: ${c.formula}`).join('; ')}), która sięga po wartości pośrednie silnika — drobna różnica jest oczekiwana, wymaga oceny człowieka.`
    })];
  }

  const underpriced = diff > 0;
  return [baseFinding({
    code: underpriced ? 'CENA_ZANIZONA' : 'CENA_NIEZGODNA_Z_CENNIKIEM',
    priority: underpriced ? 'P1' : 'HIGH',
    groupNumber,
    positionId,
    expected: reference.price,
    actual: engine,
    priceDiff: parseFloat(diff.toFixed(2)),
    message: `${paramName} dla grupy ${groupNumber}${positionId ? ` (pozycja #${positionId})` : ''}: cennik (${reference.letter}${reference.multiplier !== 1 ? `×${reference.multiplier}` : ''}) mówi ${reference.price}, silnik policzył ${engine} — różnica ${diff.toFixed(2)} EUR. Sekcje cennika: ${(reference.contributions || []).map((c) => `${c.section}×${c.multiplicity}=${c.value}`).join(', ')}.`
  })];
}

module.exports = {
  isBlankPrice,
  checkPriceExists,
  checkPriceNotUnderpriced,
  checkCartConsistency,
  checkBoundaryResult,
  checkNoBlockedFields,
  checkFreshConfigHasPrice,
  checkAgainstReferencePrice
};
