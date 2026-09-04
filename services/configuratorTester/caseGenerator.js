/**
 * Builds and runs the 4 test kinds from the PDF brief (sekcja 2) for ONE
 * group, using real historical positions as seed configurations (see
 * positionsSource.js) instead of synthesizing configurations from scratch —
 * see the plan's Faza 1 scope note on why: walking cascading dependent
 * dropdowns generically, the way a browser user would, is exactly the
 * problem the real engine already solves interactively; reusing an already
 * human-confirmed configuration sidesteps re-solving it and still exercises
 * the real pricing/validation code for every case.
 *
 * - Test podstawowy: recompute the most recent position as-is.
 * - Test graniczny (Faza 1, narrowed scope — see runBoundaryCases): confirm
 *   the position's actual SZEROKOSC/WYSOKOSC still validates as accepted.
 *   The PDF's full min-1/min/min+1/max-1/max/max+1 matrix needs true
 *   per-model MIN/MAX bounds (Faza 2).
 * - Test kombinacji / losowy: for a sample of recent positions, swap ONE
 *   field for a different value the engine currently reports as available
 *   (engineRunner.getAvailableOptionValues) and recompute.
 */

'use strict';

const { getRecentPositions, getFieldValueFrequencies, getTypicalNumericValue, mostPopularValue } = require('./positionsSource');
const engineRunner = require('./engineRunner');
const assertions = require('./assertions');
const formWalker = require('./formWalker');
const formEngine = require('../formEngine');
const excelTruthTable = require('./excelTruthTable');

const DIMENSION_FIELDS = ['SZEROKOSC', 'WYSOKOSC'];
// Price params cross-checked against the authoring workbook. CENA is the base
// price (literal tables, exact); DOPLATA is the surcharge the PDF brief's own
// headline example is about ("brak dopłaty Metal SN").
// CENA/DOPLATA are the organization's prices, SUB___* the client-facing ones
// (same sheets, different block letter), CENA_RABAT a flat per-client constant.
const REFERENCE_PRICE_PARAMS = ['CENA', 'DOPLATA', 'SUB___CENA', 'SUB___DOPLATA', 'CENA_RABAT'];

function shuffle(arr, rng) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Simple deterministic PRNG so nightly random-case runs are reproducible from a seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runBasicAndCartCases(groupNumber, positions) {
  const findings = [];
  for (const row of positions) {
    const recompute = await engineRunner.recomputeFromPositionRow(row);

    // A position saved under an OLDER price-list version cannot be judged by
    // today's data: its model/colour may no longer exist in the current
    // dictionaries, so a 0 recompute is expected, not a defect. Verified on the
    // full sweep — every single BRAK_CENY it reported was a stale-version
    // position (e.g. ver 0.3.23 vs current 0.3.53). Engine ERRORS are still
    // surfaced regardless of version.
    findings.push(...assertions.checkPriceExists(recompute));

    // "Recomputed lower than what was saved" only means something when the
    // position was priced with the SAME price list that is live now. Price
    // lists get republished (new `ver`), and a legitimate price change then
    // looks exactly like underpricing — verified on real orders, where the
    // engine and the workbook agreed to the cent while both differed from the
    // older stored value. The Excel reference check below is the version-proof
    // signal; this one is only trustworthy on same-version positions.
    findings.push(...assertions.checkPriceNotUnderpriced(recompute));

    const twice = await engineRunner.recomputeTwice(row);
    findings.push(...assertions.checkCartConsistency(twice));

    findings.push(...await runReferencePriceCase(groupNumber, row, recompute));
  }
  return findings;
}

/**
 * Faza 2 część B — the PDF brief's "niezależna tabela prawdy": compare what the
 * engine computed against the price read straight from the authoring workbook
 * in /mnt/eformconf. Skipped silently when the group's workbook or this
 * client's price-list variant can't be resolved (reported as
 * BRAK_DANYCH_REFERENCYJNYCH, never guessed).
 */
async function runReferencePriceCase(groupNumber, row, recompute) {
  if (!recompute.ok || !row.org_ident || !row.user_ident) return [];
  const values = recompute.result && recompute.result.values;
  if (!values) return [];

  // SUB___* (client-facing) params are only BUILT when the form thinks a group
  // user is looking (form.js buildHtml), so they need one extra pass with
  // isGroup — verified not to change the organization's own CENA/DOPLATA.
  let subValues = null;
  if (REFERENCE_PRICE_PARAMS.some((p) => p.startsWith('SUB___'))) {
    const { version, lang, values: inputValues, orgIdent, userIdent } = engineRunner.decodePositionRow(row);
    try {
      const subCalc = await formEngine.calculatePrices({
        groupNumber, version, lang, values: inputValues, singlePass: true, orgIdent, userIdent, isGroup: true
      });
      subValues = subCalc.values;
    } catch (_err) {
      subValues = null;
    }
  }

  const metaParams = (recompute.result.formMeta && recompute.result.formMeta.params) || [];
  const scriptsOf = (name) => {
    const found = metaParams.find((p) => p.NAME === name);
    return found ? found.SCRIPTS : undefined;
  };

  const findings = [];
  for (const paramName of REFERENCE_PRICE_PARAMS) {
    const source = paramName.startsWith('SUB___') ? subValues : values;
    if (!source) continue;
    const enginePrice = source[paramName];
    if (enginePrice === undefined || enginePrice === '') continue;

    let reference;
    try {
      reference = await excelTruthTable.getReferencePrice({
        groupNumber,
        lang: recompute.lang,
        orgIdent: row.org_ident,
        userIdent: row.user_ident,
        paramName,
        values: source,
        scriptsField: scriptsOf(paramName)
      });
    } catch (err) {
      reference = { found: false, reason: `błąd odczytu cennika: ${err.message}` };
    }

    // The group not pricing this param in its workbook at all is configuration,
    // not a defect — don't repeat it for every position.
    if (reference.kind === 'no-sheet') continue;

    findings.push(...assertions.checkAgainstReferencePrice({
      groupNumber, positionId: row.id, paramName, enginePrice, reference
    }));
  }
  return findings;
}

async function runBoundaryCases(groupNumber, positions) {
  const findings = [];
  for (const row of positions) {
    const { version, lang, values, orgIdent, userIdent } = engineRunner.decodePositionRow(row);
    if (!version) continue;

    for (const fieldName of DIMENSION_FIELDS) {
      const rawValue = values[fieldName];
      const baseValue = parseInt(rawValue, 10);
      if (!Number.isFinite(baseValue)) continue;

      // Faza 1 scope note: the PDF's full boundary matrix (min-1 reject,
      // min/min+1 accept, max-1/max accept, max+1 reject) needs the true
      // per-model MIN/MAX the engine derives at runtime (window.inputsValidators,
      // populated dynamically as MODEL etc. are selected) — reading that
      // reliably across every group's option-dependent validator shape is
      // Faza 2 work. Asserting "value-1 must be rejected" against an
      // ARBITRARY historical width/height (which is essentially never exactly
      // at the true minimum) produced false positives on every group during
      // testing, so for now we only assert the one thing we can know for
      // certain without independently discovering true bounds: a
      // historically real, previously-accepted dimension must still pass
      // validation today. Losing that IS a genuine regression worth a P1.
      const check = await engineRunner.checkBoundaryAcceptance({
        groupNumber, version, lang, baseValues: values, fieldName, testValue: baseValue, orgIdent, userIdent
      });
      findings.push(...assertions.checkBoundaryResult(check, {
        groupNumber, positionId: row.id, fieldName, testValue: baseValue, expectedAccepted: true
      }));
    }
  }
  return findings;
}

async function runCombinationAndRandomCases(groupNumber, positions, { count = 5, seed = Date.now() } = {}) {
  const rng = mulberry32(seed);
  const findings = [];
  const samples = shuffle(positions, rng).slice(0, count);

  for (const row of samples) {
    const { groupNumber: gn, version, lang, values, orgIdent, userIdent } = engineRunner.decodePositionRow(row);
    if (!version) continue;

    const paramNames = Object.keys(values).filter((k) => !k.includes('___') && !k.endsWith('_ALIAS') && k !== 'uid');
    if (paramNames.length === 0) continue;
    const fieldName = paramNames[Math.floor(rng() * paramNames.length)];

    const options = await engineRunner.getAvailableOptionValues({ groupNumber: gn, version, lang, baseValues: values, fieldName, orgIdent, userIdent });
    const alternative = options.find((v) => String(v) !== String(values[fieldName]));
    if (alternative === undefined) continue;

    const mutatedRow = Object.assign({}, row, {
      json_parameters: JSON.stringify(Object.assign({}, values, { [fieldName]: alternative }))
    });

    const recompute = await engineRunner.recomputeFromPositionRow(mutatedRow);
    // ONLY "does it still price at all". Deliberately NOT
    // checkPriceNotUnderpriced: we just swapped a field (a cheaper fabric, a
    // different mechanism), so the price is SUPPOSED to differ from what the
    // unmutated position was sold for — comparing the two produced a
    // spectacular false P1 ("30.91 is lower than the saved 97.02") on a
    // configuration the engine actually prices correctly.
    findings.push(...assertions.checkPriceExists(recompute));
  }

  return findings;
}

/**
 * formWalker.js drives the real engine field-by-field instead of replaying a
 * saved order — the only way to test a group with NO order history at all.
 *
 * Picks each field's most historically POPULAR currently-legal value (falls
 * back to the first available one when there's no history) rather than
 * always "the first option in the list" — see formWalker.js's
 * buildBasicConfiguration doc comment.
 *
 * ⚠️ Verified empirically across 9 groups: even popularity-per-field can
 * combine into a configuration with no price at all when two fields are
 * correlated (e.g. KOLOR and KOLOR_SYSTE belong together as a "color family"
 * — each independently popular, but not necessarily WITH EACH OTHER). ~7/9
 * groups produced a spurious BRAK_CENY this way. A REAL saved position is a
 * jointly-consistent tuple by construction and doesn't have this problem —
 * so `checkPrice` must stay OFF whenever real history exists (see
 * runGroupSuite: only groups with zero saved positions turn it on). Blocked-
 * field detection (checkNoBlockedFields) has no such correlation problem —
 * option EXISTENCE per field doesn't depend on any other field being
 * "right" — so it always runs, regardless of history.
 */
async function runFreshBasicCase(groupNumber, { checkPrice = true } = {}) {
  const { getAppVersion } = require('../../db/positions');
  const version = await getAppVersion(groupNumber, process.env.NODE_ENV || 'dev');
  if (!version) return { findings: [], version: null, lang: null, walkerResult: null, hasPrice: false };
  const lang = 'pl';

  const freq = await getFieldValueFrequencies(groupNumber, 40);
  const numericDefaults = async (fieldName, currentValues) => {
    const matchFields = currentValues.MODEL ? { MODEL: currentValues.MODEL } : null;
    return getTypicalNumericValue(groupNumber, fieldName, 30, matchFields);
  };
  const pickValue = (options, param) => mostPopularValue(freq, param.NAME, options) ?? options[0];

  const walkerResult = await formWalker.buildBasicConfiguration({ groupNumber, version, lang, numericDefaults, pickValue });
  const findings = [...assertions.checkNoBlockedFields(walkerResult)];
  let hasPrice = false;

  if (checkPrice && walkerResult.ok && walkerResult.blockedFields.length === 0) {
    const priceResult = await formEngine.calculatePrices({ groupNumber, version, lang, values: walkerResult.values, singlePass: true });
    const priceFindings = assertions.checkFreshConfigHasPrice(walkerResult, priceResult.total);
    findings.push(...priceFindings);
    hasPrice = priceFindings.length === 0;
  }

  return { findings, version, lang, walkerResult, hasPrice };
}

/**
 * Test kombinacji / losowy "od zera" (Faza 2, część A) — starts from
 * runFreshBasicCase's own base configuration (not a historical position) and
 * swaps ONE categorical field at a time to a different currently-available
 * value via formWalker.buildVariantConfiguration, exploring combinations no
 * client may have ever ordered before — the PDF's actual ask, as opposed to
 * runCombinationAndRandomCases()'s historical-position mutations above.
 *
 * Only categorical fields are swapped — SZEROKOSC/WYSOKOSC are excluded since
 * they're already covered by the boundary check, and mutating them here would
 * just produce another arbitrary width/height, not a "combination" in the
 * PDF's sense.
 */
async function runFreshVariantCases(groupNumber, version, lang, baseValues, { count = 5, seed = Date.now() } = {}) {
  const rng = mulberry32(seed);
  const findings = [];

  const candidateFields = Object.keys(baseValues).filter((k) => (
    !k.includes('___') && !k.endsWith('_ALIAS') && k !== 'uid'
    && !DIMENSION_FIELDS.includes(k) && baseValues[k] !== ''
  ));
  if (candidateFields.length === 0) return findings;

  const picks = shuffle(candidateFields, rng).slice(0, count);
  for (const fieldName of picks) {
    const variantResult = await formWalker.buildVariantConfiguration({
      groupNumber, version, lang, baseValues, fieldName,
      pickAlternative: (options) => options[Math.floor(rng() * options.length)]
    });
    if (!variantResult.ok) continue; // no alternative option for this field — nothing to test

    findings.push(...assertions.checkNoBlockedFields(variantResult));
    if (variantResult.blockedFields.length === 0) {
      const priceResult = await formEngine.calculatePrices({ groupNumber, version, lang, values: variantResult.values, singlePass: true });
      findings.push(...assertions.checkFreshConfigHasPrice(variantResult, priceResult.total));
    }
  }

  return findings;
}

/**
 * Run all 4 test kinds for one group.
 * @param {string} groupNumber
 * @param {object} [opts]
 * @param {number} [opts.seedPositions] how many recent positions to pull as seeds
 * @param {number} [opts.randomCasesCount]
 * @param {number} [opts.seed] PRNG seed for the random/kombinacji sampling
 */
async function runGroupSuite(groupNumber, opts = {}) {
  const { seedPositions = 5, randomCasesCount = 5, seed } = opts;

  const allPositions = await getRecentPositions(groupNumber, seedPositions);

  const findings = [];
  // Blocked-field detection has no cross-field-correlation problem (see
  // runFreshBasicCase's doc comment) — runs unconditionally. The fresh
  // config's PRICE is only trustworthy as a P1 signal when there is no real
  // historical position to test against instead.
  // Only positions priced with the CURRENTLY deployed price list can be judged
  // against today's data — an older `ver` legitimately recomputes to a
  // different number, or to 0 when its model/colour no longer exists. Filtering
  // once here (rather than gating each check) is what finally stopped stale
  // positions leaking in through the mutation pass.
  const currentVersion = await (async () => {
    const { getAppVersion } = require('../../db/positions');
    try { return await getAppVersion(groupNumber, process.env.NODE_ENV || 'dev'); } catch (_e) { return null; }
  })();
  const positions = currentVersion
    ? allPositions.filter((row) => String(row.ver) === String(currentVersion))
    : allPositions;
  const hasHistory = positions.length > 0;

  const basicCase = await runFreshBasicCase(groupNumber, { checkPrice: !hasHistory && allPositions.length === 0 });
  findings.push(...basicCase.findings);

  if (!hasHistory) {
    if (allPositions.length > 0) {
      // History exists but all of it predates the current price list: nothing
      // comparable to check, and the from-scratch price check is too noisy to
      // substitute for it (see runFreshBasicCase). Blocked-field detection above
      // still ran.
      return {
        groupNumber,
        skipped: false,
        positionsChecked: 0,
        reason: `Wszystkie ${allPositions.length} ostatnich pozycji pochodzi z innej wersji cennika niż aktualna (${currentVersion}) — porównania cen pominięte.`,
        findings
      };
    }
    if (!basicCase.walkerResult) {
      return { groupNumber, skipped: findings.length === 0, reason: `Nie udało się ustalić wersji formularza dla grupy ${groupNumber}.`, findings };
    }
    // Only explore variants of a base configuration that is itself valid and
    // priced — mutating an already-broken base (BRAK_CENY on the basic case)
    // just reproduces the same root cause on every variant instead of
    // surfacing anything new, inflating the report with uninformative repeats.
    if (basicCase.hasPrice) {
      findings.push(...await runFreshVariantCases(
        groupNumber, basicCase.version, basicCase.lang, basicCase.walkerResult.values,
        { count: randomCasesCount, seed }
      ));
    }
    return {
      groupNumber,
      skipped: false,
      positionsChecked: 0,
      reason: 'Brak zapisanych pozycji dla tej grupy — test podstawowy/kombinacji oparty wyłącznie o formWalker.js "od zera" (Faza 2), bez porównania z historią.',
      findings
    };
  }

  findings.push(...await runBasicAndCartCases(groupNumber, [positions[0]]));
  findings.push(...await runBoundaryCases(groupNumber, [positions[0]]));
  findings.push(...await runCombinationAndRandomCases(groupNumber, positions, { count: randomCasesCount, seed }));

  return { groupNumber, skipped: false, positionsChecked: positions.length, findings };
}

module.exports = { runGroupSuite };
