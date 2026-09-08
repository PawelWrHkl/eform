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

const { getRecentPositions, dedupePositions, countGroupPositions, getFieldValueFrequencies, getTypicalNumericValue, mostPopularValue } = require('./positionsSource');
const engineRunner = require('./engineRunner');
const assertions = require('./assertions');
const formWalker = require('./formWalker');
const formEngine = require('../formEngine');
const excelTruthTable = require('./excelTruthTable');
const deployedScript = require('./deployedScript');
const { runRangeSweep, runOptionSweep } = require('./rangeSweep');
const { getLastCheckedPositionId, setLastCheckedPositionId } = require('./runState');

const DIMENSION_FIELDS = ['SZEROKOSC', 'WYSOKOSC'];
// Price params cross-checked against the authoring workbook. CENA is the base
// price (literal tables, exact); DOPLATA is the surcharge the PDF brief's own
// headline example is about ("brak dopłaty Metal SN").
// CENA/DOPLATA are the organization's prices, SUB___* the client-facing ones
// (same sheets, different block letter), CENA_RABAT a flat per-client constant.
const REFERENCE_PRICE_PARAMS = ['CENA', 'DOPLATA', 'SUB___CENA', 'SUB___DOPLATA', 'CENA_RABAT'];
// Params whose dimension table is worth sweeping end to end. CENA_RABAT and the
// SUB___ variants read the same tables (or a flat constant), so sweeping them
// would re-walk the same grid for no new information.
const RANGE_SWEEP_PARAMS = ['CENA', 'DOPLATA'];

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

/**
 * Check EVERY position we pulled, not just the newest one.
 *
 * Two kinds of comparison, with deliberately different scope, because the
 * engine has no notion of historical price lists — resourceLoader maps
 * `/data/...` straight onto today's files, so an old position is always
 * recomputed with TODAY's dictionaries and price scripts:
 *
 *  - **engine vs source price list (Excel)** — both sides use today's data, so
 *    this is version-proof and runs on every position. If a configuration no
 *    longer resolves at all (a discontinued colour, say), the workbook reports
 *    no matching section and the engine returns 0 — they agree, no finding.
 *  - **recompute vs the price stored on the order** — only meaningful when the
 *    position was priced with the price list that is live now, otherwise a
 *    legitimate price change looks exactly like an error.
 *
 * Cart-consistency doubles the engine cost per position, so it runs on the
 * first `cartCheckLimit` positions of each group rather than all of them.
 */
async function runPositionChecks(groupNumber, positions, { currentVersion, cartCheckLimit = 3 } = {}) {
  const findings = [];
  const stats = { checked: 0, failed: 0, comparedToPriceList: 0, comparedToStored: 0, cartChecked: 0, scriptsRun: 0 };

  for (let i = 0; i < positions.length; i++) {
    const row = positions[i];
    const recompute = await engineRunner.recomputeFromPositionRow(row, { isGroup: true });

    if (!recompute.ok) {
      stats.failed += 1;
      findings.push(...assertions.checkPriceExists(recompute));
      continue;
    }
    stats.checked += 1;

    const reference = await runReferencePriceCase(groupNumber, row, recompute);
    stats.comparedToPriceList += reference.compared;
    stats.scriptsRun += reference.scriptsRun;
    findings.push(...reference.findings);

    // Comparing the recompute with the price stored on the order needs BOTH
    // sides to be trustworthy: the same price-list version (otherwise a
    // legitimate price change looks like an error) and a recompute that agrees
    // with the deployed script (otherwise the harness's own unsettled-axis
    // problem would be reported as underpricing — see
    // checkEngineMatchesDeployedScript).
    // A KNOWN, matching version is required — not merely "not contradicted".
    // Treating an unknown current version as permission compared positions
    // priced by an older price list against today's, which is how #6070/#6071
    // (group 11, ver 0.3.39/0.3.40, stored 180.00) and #7087 (group 14, saved
    // with an empty WYSOKOSC) became P1 "BRAK_CENY": the engine AND the
    // deployed script both price them at 0 today, so the stored price is
    // simply history, not evidence of a defect.
    if (currentVersion && String(row.ver) === String(currentVersion) && reference.engineMatchesScript) {
      stats.comparedToStored += 1;
      findings.push(...assertions.checkPriceExists(recompute));
      findings.push(...assertions.checkPriceNotUnderpriced(recompute));
    }

    if (i < cartCheckLimit) {
      const twice = await engineRunner.recomputeTwice(row);
      stats.cartChecked += 1;
      findings.push(...assertions.checkCartConsistency(twice));
    }
  }

  // Two of these describe the group rather than each position; one line each
  // instead of one per position/param (see summariseGroupDiagnostics).
  return { findings: assertions.summariseGroupDiagnostics(findings, { groupNumber }), stats };
}

/**
 * Faza 2 część B — the PDF brief's "niezależna tabela prawdy": compare what the
 * engine computed against the price read straight from the authoring workbook
 * in /mnt/eformconf. Skipped silently when the group's workbook or this
 * client's price-list variant can't be resolved (reported as
 * BRAK_DANYCH_REFERENCYJNYCH, never guessed).
 */
async function runReferencePriceCase(groupNumber, row, recompute) {
  if (!recompute.ok || !row.org_ident || !row.user_ident) return { findings: [], compared: 0, scriptsRun: 0, engineMatchesScript: true };
  const values = recompute.result && recompute.result.values;
  if (!values) return { findings: [], compared: 0, scriptsRun: 0, engineMatchesScript: true };

  // One recompute serves every param: it already ran with isGroup, so SUB___*
  // (client-facing) prices exist alongside the organization's own.
  const subValues = values;

  const metaParams = (recompute.result.formMeta && recompute.result.formMeta.params) || [];
  const scriptsOf = (name) => {
    const found = metaParams.find((p) => p.NAME === name);
    return found ? found.SCRIPTS : undefined;
  };

  const findings = [];
  let compared = 0;
  let scriptsRun = 0;
  // Does the recompute agree with the script the portal serves? Everything
  // that leans on the ENGINE's number (rather than the script's) is only
  // meaningful while it does.
  let engineMatchesScript = true;
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

    compared += 1;

    // Compare the price list against the DEPLOYED script rather than the
    // headless engine wherever that script can be run: the engine settles its
    // formula params after the pricing cascade, so for groups whose price sheet
    // is indexed by such a param it prices off an unsettled axis (group 73 —
    // five false P1s). The script is what the portal actually serves, so a
    // workbook/script difference is the real "cennik nie trafił do
    // konfiguratora" signal, and the engine's own disagreement with its script
    // is a separate, MEDIUM, harness-level report.
    const deployed = deployedScript.runDeployedScript({
      groupNumber,
      lang: recompute.lang,
      orgIdent: row.org_ident,
      userIdent: row.user_ident,
      paramName,
      scriptsField: scriptsOf(paramName),
      values: source
    });

    if (deployed.ok) {
      scriptsRun += 1;
      const drift = assertions.checkEngineMatchesDeployedScript({
        groupNumber, positionId: row.id, paramName, enginePrice, scriptPrice: deployed.value, scriptFile: deployed.file
      });
      if (drift.length) engineMatchesScript = false;
      findings.push(...drift);
    }

    findings.push(...assertions.checkAgainstReferencePrice({
      groupNumber,
      positionId: row.id,
      paramName,
      actualPrice: deployed.ok ? deployed.value : enginePrice,
      source: deployed.ok ? 'wdrożony skrypt' : 'silnik',
      // The per-customer surcharge is not in the workbook, so the reference has
      // to be scaled by whatever the script says it applied.
      referenceFactor: deployed.ok ? deployed.factor : 1,
      reference
    }));
  }
  return { findings, compared, scriptsRun, engineMatchesScript };
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

async function runCombinationAndRandomCases(groupNumber, positions, { count = 5, seed = Date.now(), currentVersion } = {}) {
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

    // Same version rule as the position pass: `checkPriceExists` compares
    // against the price stored on the ORIGINAL position, which only means
    // anything if that position was priced with the price list live now.
    if (!currentVersion || String(row.ver) !== String(currentVersion)) continue;

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
 * Self-generated configurations across the price list's whole dimension range,
 * and past its edges (rangeSweep.js) — the brief's "mnóstwo pozycji w zakresie
 * i poza zakresem cenników".
 *
 * Swept from several DIFFERENT base configurations rather than one, because the
 * sheet is sectioned by model family and colour price group: sweeping one base
 * would visit one section's table thoroughly and never touch the others. Bases
 * are picked by distinct MODEL from the deduplicated positions, so each is a
 * combination a real client has actually ordered and therefore prices at all.
 *
 * Only the axis values move per case, so no engine recompute is needed inside
 * the sweep — one settled base costs ~2.5 s, each case after that ~0.1 s.
 */
async function runPriceListRangeSweep(groupNumber, positions) {
  const maxBases = Number(process.env.CONFIGTEST_RANGE_BASES_PER_GROUP) || 3;
  const maxCases = Number(process.env.CONFIGTEST_RANGE_CASES_PER_GROUP) || 400;
  // groupProcess kills a group at 15 minutes and group 43 hit that ceiling
  // mid-sweep, losing its entire report. Budget the sweep as a whole and split
  // it across the tables it visits, so a slow group covers fewer cells instead
  // of costing itself everything.
  const groupBudgetMs = Number(process.env.CONFIGTEST_RANGE_GROUP_BUDGET_MS) || 4 * 60 * 1000;

  const bases = [];
  const seenModels = new Set();
  for (const row of positions) {
    if (bases.length >= maxBases) break;
    if (!row.org_ident || !row.user_ident) continue;
    const decoded = engineRunner.decodePositionRow(row);
    const model = String(decoded.values.MODEL ?? '');
    if (seenModels.has(model)) continue;
    seenModels.add(model);
    bases.push(row);
  }

  const findings = [];
  let cases = 0;
  let inRange = 0;
  let outOfRange = 0;
  let optionCases = 0;
  let unpriceableOptions = 0;
  let ranOutOfTime = false;
  // The budget covers both sweeps per table: dimensions and options.
  const perTableBudgetMs = Math.max(15000, Math.floor(groupBudgetMs / Math.max(1, bases.length * RANGE_SWEEP_PARAMS.length * 2)));

  for (const row of bases) {
    const settled = await engineRunner.recomputeFromPositionRow(row, { isGroup: true });
    if (!settled.ok) continue;
    const values = settled.result.values;
    const metaParams = (settled.result.formMeta && settled.result.formMeta.params) || [];

    for (const paramName of RANGE_SWEEP_PARAMS) {
      if (values[paramName] === undefined) continue;
      const meta = metaParams.find((p) => p.NAME === paramName);
      const result = await runRangeSweep({
        groupNumber,
        lang: settled.lang,
        orgIdent: row.org_ident,
        userIdent: row.user_ident,
        baseValues: values,
        paramName,
        scriptsField: meta ? meta.SCRIPTS : undefined,
        maxCases,
        budgetMs: perTableBudgetMs
      });
      findings.push(...result.findings);
      cases += result.cases;
      inRange += result.inRange;
      outOfRange += result.outOfRange;
      if (result.ranOutOfTime) ranOutOfTime = true;

      // Same base, the other axis of the configuration space: the fabrics,
      // colours and models the price sheet is sectioned by. History covers a
      // handful of those; the configurator offers hundreds.
      const optionResult = await runOptionSweep({
        groupNumber,
        lang: settled.lang,
        orgIdent: row.org_ident,
        userIdent: row.user_ident,
        baseValues: values,
        version: settled.version,
        paramName,
        scriptsField: meta ? meta.SCRIPTS : undefined,
        maxCases,
        budgetMs: perTableBudgetMs
      });
      findings.push(...optionResult.findings);
      cases += optionResult.cases;
      optionCases += optionResult.cases;
      unpriceableOptions += optionResult.unpriceable.length;
      if (optionResult.ranOutOfTime) ranOutOfTime = true;
    }
  }

  return {
    findings,
    cases,
    inRange,
    outOfRange,
    optionCases,
    unpriceableOptions,
    reason: cases
      ? `Wygenerowano ${cases} własnych konfiguracji z ${bases.length} baz: ${inRange} w zakresie wymiarów cennika, ${outOfRange} poza zakresem, ${optionCases} po opcjach (tkaniny/kolory/modele)${unpriceableOptions ? `, z tego ${unpriceableOptions} bez ceny` : ''}`
        + `${ranOutOfTime ? ` (przegląd przerwany budżetem czasu ${Math.round(perTableBudgetMs / 1000)} s na tabelę — odwiedzone komórki są rozłożone po całej tabeli)` : ''}.`
      : 'Przegląd zakresu cennika nie dał się wykonać dla tej grupy (brak tabeli wymiarów w cenniku).'
  };
}

/**
 * Run all 4 test kinds for one group.
 * @param {string} groupNumber
 * @param {object} [opts]
 * @param {number} [opts.seedPositions] how many recent positions to pull as
 *   seeds; 0 (CONFIGTEST_POSITIONS_PER_GROUP=0) means EVERY saved position.
 *   Budget roughly 2.5 s per position — the whole database is ~6 200 positions.
 * @param {number} [opts.randomCasesCount]
 * @param {number} [opts.seed] PRNG seed for the random/kombinacji sampling
 */
async function runGroupSuite(groupNumber, opts = {}) {
  const configured = process.env.CONFIGTEST_POSITIONS_PER_GROUP;
  const {
    seedPositions = configured === undefined || configured === '' ? 25 : Number(configured),
    randomCasesCount = 5,
    onlyNew = false,
    seed
  } = opts;

  const findings = [];
  // Nightly runs check what came in since last time; the mark only moves
  // forward, so a position is never checked twice and never skipped (runState).
  const sinceId = onlyNew ? getLastCheckedPositionId(groupNumber) : null;
  const fetched = await getRecentPositions(groupNumber, seedPositions, { sinceId });
  // Exact repeats cost a full engine recompute each and prove nothing new.
  const { positions, duplicates } = dedupePositions(fetched);
  const counted = await countGroupPositions(groupNumber).catch(() => null);

  // The price-list sweep runs even when no new order arrived: the workbooks in
  // /mnt/eformconf change on their own, and that is the failure the brief cares
  // about most. It only needs SOME priceable configuration to start from, so
  // fall back to the newest positions when there is nothing new to check.
  const rangeBases = positions.length ? positions : dedupePositions(await getRecentPositions(groupNumber, 5)).positions;

  const currentVersion = await (async () => {
    const { getAppVersion } = require('../../db/positions');
    try { return await getAppVersion(groupNumber, process.env.NODE_ENV || 'dev'); } catch (_e) { return null; }
  })();

  // Blocked-field detection needs no history at all; the from-scratch price
  // check stays off unless the group has no positions to compare against
  // (see runFreshBasicCase for why it is too noisy otherwise). It keys off
  // whether the group has ANY history — not off whether anything is new — or
  // an incremental run with no new orders would switch it on every night and
  // report a P1 for a group that is perfectly fine.
  const basicCase = await runFreshBasicCase(groupNumber, { checkPrice: rangeBases.length === 0 });
  findings.push(...basicCase.findings);

  if (positions.length === 0) {
    if (basicCase.hasPrice) {
      findings.push(...await runFreshVariantCases(
        groupNumber, basicCase.version, basicCase.lang, basicCase.walkerResult.values,
        { count: randomCasesCount, seed }
      ));
    }
    const rangeOnly = await runPriceListRangeSweep(groupNumber, rangeBases);
    findings.push(...rangeOnly.findings);
    return {
      groupNumber,
      skipped: false,
      positionsChecked: 0,
      stats: { rangeCases: rangeOnly.cases, rangeInRange: rangeOnly.inRange, rangeOutOfRange: rangeOnly.outOfRange, rangeOptionCases: rangeOnly.optionCases },
      reason: `${sinceId ? `Brak nowych pozycji od #${sinceId}` : 'Brak zapisanych pozycji'} — sprawdzono konfigurację zbudowaną od zera. ${rangeOnly.reason}`,
      findings
    };
  }

  const sweep = await runPositionChecks(groupNumber, positions, { currentVersion });
  findings.push(...sweep.findings);

  findings.push(...await runBoundaryCases(groupNumber, [positions[0]]));
  findings.push(...await runCombinationAndRandomCases(groupNumber, positions, { count: randomCasesCount, seed, currentVersion }));

  const range = await runPriceListRangeSweep(groupNumber, rangeBases);
  findings.push(...range.findings);

  // Only after the position checks actually ran: marking positions as done on
  // a failed or interrupted pass would hide them from every future run.
  if (fetched.length) setLastCheckedPositionId(groupNumber, Math.max(...fetched.map((r) => Number(r.id) || 0)));

  const s = sweep.stats;
  s.rangeCases = range.cases;
  s.rangeInRange = range.inRange;
  s.rangeOutOfRange = range.outOfRange;
  s.rangeOptionCases = range.optionCases;
  return {
    groupNumber,
    skipped: false,
    positionsChecked: s.checked,
    positionsTotal: fetched.length,
    stats: Object.assign({ duplicates }, s, counted ? { positionsInDb: counted.total, positionsReachable: counted.reachable } : {}),
    reason: `Sprawdzono ${s.checked} z ${fetched.length} pozycji${duplicates ? ` (${duplicates} pominięto jako identyczne konfiguracje)` : ''}${counted && counted.total > counted.reachable ? `; grupa ma ${counted.total} pozycji, z czego ${counted.total - counted.reachable} bez powiązanego zamówienia lub klienta — dla nich nie da się ustalić wariantu cennika` : ''}: ${s.comparedToPriceList} porównań z cennikiem źródłowym, ${s.comparedToStored} z ceną zapisaną (wersja aktualna ${currentVersion || '—'}), ${s.cartChecked} kontroli powtarzalności, ${s.scriptsRun} porównań z wdrożonym skryptem cenowym. ${range.reason}`,
    findings
  };
}

module.exports = { runGroupSuite };
