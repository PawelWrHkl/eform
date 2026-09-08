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
 * CENA ZANIŻONA / NIEZGODNA Z CENNIKIEM — the price the portal charges for a
 * configuration versus the reference read straight from the authoring workbook
 * (services/configuratorTester/excelTruthTable). This is the PDF brief's
 * "niezależna tabela prawdy": the workbook is where prices are authored, the
 * `param-*.js` the portal runs is a build artifact of it, so a difference means
 * the build drifted from the source — stale scripts, a bad generation, or
 * unpublished edits.
 *
 * `actualPrice` is preferably the DEPLOYED script's answer (deployedScript.js),
 * not the headless engine's: the engine runs its formula params after the
 * pricing cascade and can therefore price off an unsettled axis, which is a
 * property of the harness rather than of the price list (see
 * `checkEngineMatchesDeployedScript`).
 *
 * Charging LESS than the price list is the financially dangerous direction, so
 * that is P1; charging MORE is reported as HIGH (still wrong, but it does not
 * lose money silently). A per-uid client surcharge factor the generated scripts
 * apply last (and which is not in the workbook) can explain small positive
 * differences — hence `toleranceEur`.
 */
function checkAgainstReferencePrice(
  { groupNumber, positionId, paramName, enginePrice, actualPrice, reference, referenceFactor = 1, source = 'silnik' },
  { toleranceEur = 0.02 } = {}
) {
  const engine = parseFloat(actualPrice !== undefined ? actualPrice : enginePrice);
  // The per-customer surcharge the deployed script applied is not in the
  // workbook at all (deployedScript.factorFromLabel), so scale the reference by
  // it or every order from such a client reads as overpriced by that factor.
  reference = scaleReference(reference, referenceFactor);

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
        message: `${paramName} dla grupy ${groupNumber}${positionId ? ` (pozycja #${positionId})` : ''}: ${source} naliczył ${engine}, ale żadna sekcja cennika nie pasuje do tej konfiguracji — brak podstawy w cenniku.`
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
      message: `${paramName} dla grupy ${groupNumber}${positionId ? ` (pozycja #${positionId})` : ''}: wzorzec ${reference.price} vs ${source} ${engine} (różnica ${diff.toFixed(2)} EUR). ⚠️ Wzorzec liczony z formuły w cenniku (${(reference.contributions || []).filter((c) => c.formula).map((c) => `${c.section}: ${c.formula}`).join('; ')}), która sięga po wartości pośrednie silnika — drobna różnica jest oczekiwana, wymaga oceny człowieka.`
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
    message: `${paramName} dla grupy ${groupNumber}${positionId ? ` (pozycja #${positionId})` : ''}: cennik (${reference.letter}${reference.multiplier !== 1 ? `×${reference.multiplier}` : ''}) mówi ${reference.price}${reference.uidFactor ? ` (z dopłatą klienta ×${reference.uidFactor}, której nie ma w arkuszu)` : ''}, ${source} policzył ${engine} — różnica ${diff.toFixed(2)} EUR. Sekcje cennika: ${(reference.contributions || []).map((c) => `${c.section}×${c.multiplicity}=${c.value}`).join(', ')}.`
  })];
}

/**
 * PRZELICZENIE NIEZGODNE ZE SKRYPTEM — the headless engine and the deployed
 * price script disagree about the SAME configuration.
 *
 * Both are given the identical, settled value set, so the script is the
 * authority on what that configuration costs; a difference means the recompute
 * fed it something else along the way. Confirmed cause on group 73: the price
 * sheet is indexed by `SZEROKOSC_POTRZEBNA`, a FORMULA param that
 * `calculatePrices()` only settles in `applyFormulaParams()` — after the pricing
 * cascade has already run. The live configurator does not have the problem (the
 * browser shows a price consistent with its own script), which is exactly why
 * this is NOT reported as underpricing.
 *
 * MEDIUM, and deliberately so: it says "this tester's recompute of that position
 * cannot be trusted", not "a customer was charged the wrong amount". It also
 * marks the positions whose price comparison had to lean on the script alone.
 */
function checkEngineMatchesDeployedScript(
  { groupNumber, positionId, paramName, enginePrice, scriptPrice, scriptFile },
  { toleranceEur = 0.02 } = {}
) {
  const engine = parseFloat(enginePrice);
  const script = parseFloat(scriptPrice);
  if (!Number.isFinite(engine) || !Number.isFinite(script)) return [];
  if (Math.abs(engine - script) <= toleranceEur) return [];

  return [baseFinding({
    code: 'PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM',
    priority: 'MEDIUM',
    groupNumber,
    positionId,
    expected: script,
    actual: engine,
    priceDiff: parseFloat((script - engine).toFixed(2)),
    message: `${paramName} dla grupy ${groupNumber} (pozycja #${positionId}): wdrożony skrypt ${scriptFile || ''} liczy ${script}, a bezgłowe przeliczenie ${engine} — różnica ${Math.abs(script - engine).toFixed(2)} EUR na tych samych wartościach. Cenę porównano z cennikiem po stronie skryptu; samo przeliczenie w testerze jest tu niemiarodajne (parametr wyliczany formułą ustala się po uruchomieniu skryptu cenowego).`
  })];
}

/**
 * A configuration INSIDE the price list's own dimension range (rangeSweep.js).
 *
 * Two ways this fails, and the first is the brief's headline scenario: the
 * price list has a price for this size but the configurator quotes 0, so a
 * customer can order something for nothing. The second is ordinary drift
 * between the workbook and the built script.
 */
function checkInRangePrice({ groupNumber, paramName, size, scriptPrice, reference, referenceFactor = 1 }, { toleranceEur = 0.02 } = {}) {
  const script = parseFloat(scriptPrice);
  reference = scaleReference(reference, referenceFactor);
  if (!reference || reference.found !== true) return [];
  if (!Number.isFinite(script)) return [];

  if (reference.price > 0 && script === 0) {
    return [baseFinding({
      code: 'BRAK_CENY_W_ZAKRESIE_CENNIKA',
      priority: 'P1',
      groupNumber,
      expected: reference.price,
      actual: 0,
      priceDiff: parseFloat(reference.price.toFixed(2)),
      message: `${paramName} dla grupy ${groupNumber}: wymiar ${size} mieści się w cenniku (${reference.letter}${reference.multiplier !== 1 ? `×${reference.multiplier}` : ''}), który mówi ${reference.price}, ale wdrożony skrypt nie nalicza nic. Klient może zamówić ten rozmiar za 0.`
    })];
  }

  const diff = reference.price - script;
  if (Math.abs(diff) <= toleranceEur) return [];
  if (reference.derived) return [];

  const underpriced = diff > 0;
  return [baseFinding({
    code: underpriced ? 'CENA_ZANIZONA' : 'CENA_NIEZGODNA_Z_CENNIKIEM',
    priority: underpriced ? 'P1' : 'HIGH',
    groupNumber,
    expected: reference.price,
    actual: script,
    priceDiff: parseFloat(diff.toFixed(2)),
    message: `${paramName} dla grupy ${groupNumber}, wymiar ${size}: cennik (${reference.letter}${reference.multiplier !== 1 ? `×${reference.multiplier}` : ''}) mówi ${reference.price}${reference.uidFactor ? ` (z dopłatą klienta ×${reference.uidFactor})` : ''}, wdrożony skrypt policzył ${script} — różnica ${diff.toFixed(2)} EUR.`
  })];
}

/**
 * A configuration OUTSIDE the price list's dimension range (rangeSweep.js).
 *
 * The price list having nothing there is expected — that is what "outside"
 * means. What must not happen is the configurator inventing a price anyway,
 * because nobody authored it and nobody can check it. Both sides agreeing on
 * "no price" is correct behaviour for the price list and reported as a
 * MEDIUM note about the form instead: whether a customer can pick that size at
 * all is a validation question the price list cannot answer.
 */
function checkOutOfRangePrice({ groupNumber, paramName, size, where, scriptPrice, reference }) {
  const script = parseFloat(scriptPrice);
  if (!Number.isFinite(script)) return [];

  const referenceHasPrice = reference && reference.found === true && reference.price > 0;

  if (!referenceHasPrice && script > 0) {
    return [baseFinding({
      code: 'CENA_POZA_ZAKRESEM_CENNIKA',
      priority: 'HIGH',
      groupNumber,
      expected: 'brak ceny (wymiar poza tabelą)',
      actual: script,
      priceDiff: parseFloat((-script).toFixed(2)),
      message: `${paramName} dla grupy ${groupNumber}: wymiar ${size} jest poza tabelą cennika (${where}), a wdrożony skrypt nalicza ${script}. Ta cena nie ma źródła w cenniku — nikt jej nie zatwierdził.`
    })];
  }

  // The "both sides silent" case is NOT reported here. It is the expected
  // outcome for every probe beyond the table, so one finding per probe per
  // base meant 12 near-identical MEDIUM lines for group 20 alone — and the
  // question it asks (does the form even allow that size?) is answered
  // properly by the browser probe. The sweep collects those sizes and reports
  // them once, through checkOutOfRangeDimensionsSilent().
  return [];
}

/**
 * One summary of the sizes beyond the price list where nothing quotes a price.
 *
 * Correct behaviour on the price list's side, so MEDIUM: what remains open is
 * whether the form lets a customer choose such a size, which only the browser
 * probe can answer (browserRunner.probeDimension →
 * checkFormAcceptsOutOfRangeDimension). Reported as one line with the sizes
 * listed, because the alternative is a dozen identical entries per group.
 */
function checkOutOfRangeDimensionsSilent({ groupNumber, paramName, sizes }) {
  const unique = [...new Set(sizes || [])];
  if (!unique.length) return [];

  return [baseFinding({
    code: 'WYMIAR_POZA_CENNIKIEM_DO_SPRAWDZENIA',
    priority: 'MEDIUM',
    groupNumber,
    expected: 'formularz nie powinien przyjmować wymiarów poza cennikiem',
    // The size list, not just the count: the report deduplicates on
    // code/priority/group/position/expected/actual, so two different sets of
    // sizes that happen to be the same size would otherwise collapse into one
    // and the second group's sizes would vanish from the report.
    actual: unique.join('; '),
    message: `${paramName} dla grupy ${groupNumber}: poza tabelą cennika ani cennik, ani wdrożony skrypt nic nie naliczają — to zachowanie poprawne po stronie cennika. Sprawdzone rozmiary: ${unique.slice(0, 10).join('; ')}${unique.length > 10 ? ` (razem ${unique.length})` : ''}. Otwarte zostaje, czy formularz pozwala klientowi taki rozmiar wybrać — na to odpowiada przebieg w przeglądarce (--browser).`
  })];
}

/**
 * The form's own verdict on a dimension the price list does not cover
 * (browserRunner.probeDimension). This is the end of the out-of-range
 * question: the headless sweep can only say the price list is silent there,
 * while this says whether a customer can actually place that order.
 *
 * Accepting the size and quoting nothing is the brief's worst case — an order
 * for 0. Accepting it and quoting something means a price nobody authored.
 * Rejecting it is correct behaviour and reported as nothing at all.
 */
function checkFormAcceptsOutOfRangeDimension({
  groupNumber, positionId, fieldName, valueMm, maxInPriceListCm, rejected, price
}) {
  if (rejected) return [];

  const quoted = parseFloat(price);
  const size = `${fieldName} = ${valueMm} mm (cennik kończy się na ${maxInPriceListCm} cm)`;

  if (!Number.isFinite(quoted) || quoted === 0) {
    return [baseFinding({
      code: 'WYMIAR_POZA_CENNIKIEM_PRZYJETY',
      priority: 'P1',
      groupNumber,
      positionId,
      expected: 'formularz odrzuca wymiar poza cennikiem',
      actual: 'formularz przyjął wymiar, cena 0',
      message: `Grupa ${groupNumber}, pozycja #${positionId} (przeglądarka): formularz przyjął ${size} i nie pokazał żadnej ceny. Klient może złożyć to zamówienie za 0.`
    })];
  }

  return [baseFinding({
    code: 'CENA_POZA_ZAKRESEM_CENNIKA',
    priority: 'HIGH',
    groupNumber,
    positionId,
    expected: 'brak ceny (wymiar poza tabelą cennika)',
    actual: quoted,
    priceDiff: parseFloat((-quoted).toFixed(2)),
    message: `Grupa ${groupNumber}, pozycja #${positionId} (przeglądarka): formularz przyjął ${size} i wycenił go na ${quoted}. Tej ceny nie ma w cenniku — nikt jej nie zatwierdził.`
  })];
}

/**
 * Options the configurator offers that nothing prices (rangeSweep.runOptionSweep).
 *
 * The brief's headline failure in option form: a fabric or colour a customer
 * can select, for which neither the workbook nor the deployed script produces
 * a price — so the position comes out at 0. Reported as ONE finding listing
 * them, not one per option: a single unpriced colour group in group 73 would
 * otherwise mean 254 identical entries and bury everything else.
 *
 * P1 only while it is a minority. Every option of a field coming back
 * unpriceable is far more likely to mean the sweep's own base configuration
 * cannot be priced in the first place than that the whole collection is
 * broken, so that case is reported as a MEDIUM asking to be looked at rather
 * than as a certainty.
 */
/**
 * Apply the deployed script's per-customer factor to a workbook reference.
 *
 * Kept separate and explicit so the factor shows up in the message: a reader
 * comparing the report against the spreadsheet by hand needs to know the
 * reference was scaled, and by how much.
 */
function scaleReference(reference, factor) {
  if (!reference || reference.found !== true) return reference;
  const f = parseFloat(factor);
  if (!Number.isFinite(f) || f === 1 || f <= 0) return reference;
  return Object.assign({}, reference, {
    price: parseFloat((reference.price * f).toFixed(2)),
    uidFactor: f
  });
}

function checkUnpriceableOptions({ groupNumber, paramName, unpriceable, checked }) {
  if (!unpriceable || !unpriceable.length) return [];

  const list = (entries) => entries.slice(0, 8)
    .map((u) => `${u.fieldName}=${u.value}${u.description ? ` (${u.description})` : ''}`)
    .join(', ') + (entries.length > 8 ? `, … (razem ${entries.length})` : '');

  // Every single option failing says more about the sweep's starting point than
  // about the price list.
  if (checked > 0 && unpriceable.length === checked) {
    return [baseFinding({
      code: 'BRAK_CENY_DLA_OPCJI_DO_SPRAWDZENIA',
      priority: 'MEDIUM',
      groupNumber,
      expected: 'każda oferowana opcja ma cenę w cenniku',
      actual: list(unpriceable),
      message: `${paramName} dla grupy ${groupNumber}: ŻADNA z ${checked} sprawdzonych opcji nie ma ceny w cenniku (${list(unpriceable)}). Skoro dotyczy to wszystkich, najpewniej to konfiguracja bazowa przeglądu jest niewycenialna, a nie cały cennik — wymaga oceny człowieka.`
    })];
  }

  // Split by whether choosing the option restructures the form.
  //
  // An option carrying a PROC (`MODEL` sets other fields' MIN/MAX and some
  // models need fields the previous one did not have) cannot be verified by
  // swapping it into a value set — and the fields that offer such options are
  // dialog-driven buttons, not selects, so the browser pass cannot read their
  // real availability either. Group 75's Skylight models price at 0 through
  // the script, the workbook AND a full engine cascade, which is strong but
  // not proof that a customer can reach them in that configuration. Reported
  // as HIGH with the caveat rather than asserted as P1.
  const structural = unpriceable.filter((u) => u.structural);
  const plain = unpriceable.filter((u) => !u.structural);
  const findings = [];

  if (plain.length) {
    findings.push(baseFinding({
      code: 'BRAK_CENY_DLA_OPCJI',
      priority: 'P1',
      groupNumber,
      expected: 'każda oferowana opcja ma cenę w cenniku',
      actual: list(plain),
      message: `${paramName} dla grupy ${groupNumber}: ${plain.length} z ${checked} opcji, które konfigurator pozwala wybrać, nie ma ceny ani w cenniku, ani we wdrożonym skrypcie: ${list(plain)}. Klient może wybrać taką opcję i dostać pozycję za 0.`
    }));
  }

  if (structural.length) {
    findings.push(baseFinding({
      code: 'BRAK_CENY_DLA_OPCJI_DO_POTWIERDZENIA',
      priority: 'HIGH',
      groupNumber,
      expected: 'każda oferowana opcja ma cenę w cenniku',
      actual: list(structural),
      message: `${paramName} dla grupy ${groupNumber}: ${structural.length} z ${checked} opcji wycenia się na 0 — w cenniku, we wdrożonym skrypcie i po pełnym przeliczeniu silnikiem: ${list(structural)}. ⚠️ Te opcje przebudowują formularz (mają własne PROC ustawiające inne pola), więc podmiana wartości nie jest tym samym co wybór w konfiguratorze — do potwierdzenia ręcznie, czy klient może je w ogóle wybrać w tej konfiguracji.`
    }));
  }

  return findings;
}

/**
 * Collapse the two per-position diagnostics that describe the GROUP, not the
 * position, into one line each.
 *
 * Both say the same thing however many positions they land on:
 * `BRAK_DANYCH_REFERENCYJNYCH` — this group prices off a param the headless
 * recompute cannot settle, so no reference can be read; and
 * `PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM` — the recompute disagrees with the
 * deployed script. Group 73 produced 14 and 4 of them respectively across 11
 * positions; as separate entries they bury the findings that matter.
 *
 * @returns {Array} the findings with those codes replaced by summaries
 */
function summariseGroupDiagnostics(findings, { groupNumber } = {}) {
  const AGGREGATED = {
    BRAK_DANYCH_REFERENCYJNYCH: {
      priority: 'MEDIUM',
      describe: (n, positions) => `Grupa ${groupNumber}: dla ${n} sprawdzeń nie dało się ustalić ceny wzorcowej z cennika (pozycje ${positions}). Najczęstsza przyczyna: arkusz jest indeksowany parametrem liczonym formułą, którego bezgłowe przeliczenie nie ustala — to ograniczenie testera, nie dowód błędu wyceny. Pewną odpowiedź daje przebieg w przeglądarce.`
    },
    PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM: {
      priority: 'MEDIUM',
      describe: (n, positions) => `Grupa ${groupNumber}: w ${n} sprawdzeniach bezgłowe przeliczenie rozjechało się z wdrożonym skryptem cenowym (pozycje ${positions}). Cena porównywana jest po stronie skryptu, więc porównanie z cennikiem pozostaje wiarygodne; niemiarodajne jest samo przeliczenie w testerze.`
    }
  };

  const kept = [];
  const buckets = new Map();

  for (const finding of findings) {
    const rule = AGGREGATED[finding.code];
    if (!rule) {
      kept.push(finding);
      continue;
    }
    if (!buckets.has(finding.code)) buckets.set(finding.code, []);
    buckets.get(finding.code).push(finding);
  }

  for (const [code, group] of buckets) {
    const rule = AGGREGATED[code];
    const positions = [...new Set(group.map((f) => f.positionId).filter((id) => id != null))];
    const shown = positions.slice(0, 10).map((id) => `#${id}`).join(', ')
      + (positions.length > 10 ? `, … (razem ${positions.length})` : '');
    kept.push(baseFinding({
      code,
      priority: rule.priority,
      groupNumber,
      expected: 'cena wzorcowa do porównania',
      actual: `${group.length} sprawdzeń bez wiarygodnego porównania`,
      message: rule.describe(group.length, shown || 'bez numerów')
    }));
  }

  return kept;
}

module.exports = {
  isBlankPrice,
  summariseGroupDiagnostics,
  checkUnpriceableOptions,
  checkInRangePrice,
  checkOutOfRangePrice,
  checkOutOfRangeDimensionsSilent,
  checkFormAcceptsOutOfRangeDimension,
  checkPriceExists,
  checkPriceNotUnderpriced,
  checkCartConsistency,
  checkBoundaryResult,
  checkNoBlockedFields,
  checkFreshConfigHasPrice,
  checkAgainstReferencePrice,
  checkEngineMatchesDeployedScript
};
