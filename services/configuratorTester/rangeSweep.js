/**
 * Generates configurations by itself and drives them across — and past — the
 * price list's own dimension range.
 *
 * This is the PDF brief's real ask ("mnóstwo pozycji w zakresie i poza
 * zakresem cenników"), and it is a different question from replaying saved
 * orders: history only ever covers what somebody happened to order, which is a
 * thin, biased sample of the table. Here the table itself supplies the grid:
 * `excelTruthTable.getDimensionGrid()` returns exactly which widths and heights
 * the matching sections price, so every cell can be visited and the space just
 * outside the edges can be probed deliberately.
 *
 * What each case asserts:
 *
 *   inside the range  → the deployed script must quote a price, and it must
 *                       equal the workbook's. A 0 here is the brief's headline
 *                       failure: a configuration a customer can pick that the
 *                       configurator has no price for.
 *   outside the range → the workbook has nothing, so the script must quote
 *                       nothing either. A price with no basis in the price list
 *                       is reported; agreement on "no price" is reported only
 *                       as the (separate, cheap) question of whether the form
 *                       lets a customer choose that size at all.
 *
 * Cost: the deployed script answers in ~40 ms once compiled, against ~2.5 s for
 * a full engine recompute, which is what makes thousands of cases per group
 * affordable at all. The engine is not involved per case — the base
 * configuration is settled once, then only the axis values move.
 */

'use strict';

const assertions = require('./assertions');
const excelTruthTable = require('./excelTruthTable');
const { runDeployedScript } = require('./deployedScript');
const engineRunner = require('./engineRunner');
const formEngine = require('../formEngine');
const { loadClientDescriptions } = require('../orderImport/paramDescriptions');

/** Same deterministic PRNG the other case generators use. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many in-range cells to visit per price table before striding over the rest. */
const DEFAULT_MAX_CASES = Number(process.env.CONFIGTEST_RANGE_CASES_PER_GROUP) || 400;

/**
 * Wall-clock budget per price table.
 *
 * A case costs ~114 ms on group 73 but far more where the generated script is
 * 6 MB of decision tree, and groupProcess kills a group at 15 minutes: group 43
 * hit that ceiling mid-sweep and its whole result was lost. Counting cases is
 * therefore not enough — the sweep has to watch the clock and stop early,
 * covering fewer cells rather than costing the group its entire report.
 */
const DEFAULT_BUDGET_MS = Number(process.env.CONFIGTEST_RANGE_BUDGET_MS) || 90 * 1000;

/**
 * Evenly spread `count` picks across `values`, always keeping the first and
 * last — the edges are the interesting part and must never be strided away.
 */
function stride(values, count) {
  if (values.length <= count) return values.slice();
  if (count <= 2) return [values[0], values[values.length - 1]];
  const picked = [];
  const step = (values.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) picked.push(values[Math.round(i * step)]);
  return [...new Set(picked)];
}

/**
 * Order the grid so that ANY prefix of it is still spread over the whole table.
 *
 * The time budget cuts the sweep wherever it happens to be, and iterating
 * width-major meant a truncated run tested small sizes thoroughly and never
 * looked at large ones at all. Corners go first — the edges of a price table
 * are where the mistakes live — then the rest in a fixed pseudo-random order,
 * so a run that only gets a third of the way through has still sampled the
 * whole grid rather than one corner of it. Seeded, so two runs visit the same
 * cells in the same order and a finding can be reproduced.
 */
function spreadOrder(widths, heights, rng) {
  const corners = [];
  const rest = [];
  const lastW = widths.length - 1;
  const lastH = heights.length - 1;
  const isEdgeW = (i) => i === 0 || i === lastW;
  const isEdgeH = (i) => i === 0 || i === lastH;

  for (let wi = 0; wi < widths.length; wi++) {
    for (let hi = 0; hi < heights.length; hi++) {
      const pair = [widths[wi], heights[hi]];
      if (isEdgeW(wi) && isEdgeH(hi)) corners.push(pair);
      else rest.push(pair);
    }
  }

  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return corners.concat(rest);
}

/**
 * Dimensions to probe beyond each end of the grid.
 *
 * Below the minimum is skipped when the minimum is already at the bottom of the
 * scale: the smallest bucket in these sheets is typically 10 cm and a ceiling
 * lookup treats everything under it as belonging to it, so "below the range"
 * does not exist on that side — asserting otherwise would invent a rule the
 * price list does not have.
 */
function outOfRangePoints(valuesCm) {
  const min = valuesCm[0];
  const max = valuesCm[valuesCm.length - 1];
  const points = [];
  if (min > 10) points.push({ cm: Math.round(min / 2), where: 'poniżej minimum' });
  points.push({ cm: max + 10, where: 'powyżej maksimum' });
  points.push({ cm: max + 100, where: 'daleko powyżej maksimum' });
  return points;
}

/**
 * @param {object} opts
 * @param {string} opts.groupNumber
 * @param {string} [opts.lang]
 * @param {string} opts.orgIdent
 * @param {string} opts.userIdent
 * @param {object} opts.baseValues   a settled configuration to vary
 * @param {string} [opts.paramName]
 * @param {string} [opts.scriptsField]
 * @param {number} [opts.maxCases]
 * @param {number} [opts.budgetMs] stop early once this much time has gone
 * @param {number} [opts.seed] fixes the visiting order so runs are reproducible
 * @returns {Promise<{findings:Array, cases:number, inRange:number, outOfRange:number, ranOutOfTime:boolean, reason:string}>}
 */
async function runRangeSweep({
  groupNumber, lang = 'pl', orgIdent, userIdent, baseValues,
  paramName = 'CENA', scriptsField, maxCases = DEFAULT_MAX_CASES, budgetMs = DEFAULT_BUDGET_MS,
  seed = 20260907
}) {
  const startedAt = Date.now();
  const empty = (reason) => ({ findings: [], cases: 0, inRange: 0, outOfRange: 0, ranOutOfTime: false, reason });

  const grid = await excelTruthTable.getDimensionGrid({
    groupNumber, lang, orgIdent, userIdent, paramName, values: baseValues, scriptsField
  });
  if (!grid.ok) return empty(`przegląd zakresu cennika pominięty — ${grid.reason}`);
  if (grid.axisAmbiguous) {
    // Two matching sections indexed by different params: one value cannot move
    // both lookups, so sweeping would silently test only one of them.
    return empty('przegląd zakresu cennika pominięty — pasujące sekcje mają różne osie, nie da się przesuwać ich jedną wartością');
  }

  // Confirm the base configuration prices at all before varying it: sweeping
  // from a configuration the script cannot price would report the whole grid as
  // broken and say nothing about the price list.
  const baseline = runDeployedScript({ groupNumber, lang, orgIdent, userIdent, paramName, scriptsField, values: baseValues });
  if (!baseline.ok) return empty(`przegląd zakresu cennika pominięty — ${baseline.reason}`);

  const findings = [];
  const silentSizes = [];
  const heights = grid.heightsCm.length ? grid.heightsCm : [null];

  // Budget: spend it on a rectangle of the grid rather than on one long row,
  // so both axes are exercised.
  const perAxis = Math.max(2, Math.floor(Math.sqrt(maxCases)));
  const widthPicks = stride(grid.widthsCm, perAxis);
  const heightPicks = heights[0] === null ? [null] : stride(heights, Math.max(2, Math.floor(maxCases / widthPicks.length)));

  const at = (widthCm, heightCm) => {
    const values = Object.assign({}, baseValues);
    // Move the param the axis formula actually reads (group 73 indexes by
    // SZEROKOSC_POTRZEBNA, not SZEROKOSC) AND the plain dimension, so anything
    // else keyed off the size stays consistent with it.
    values[grid.widthParam] = widthCm * 10;
    values.SZEROKOSC = widthCm * 10;
    if (heightCm !== null) {
      values[grid.heightParam] = heightCm * 10;
      values.WYSOKOSC = heightCm * 10;
    }
    return values;
  };

  const check = async (widthCm, heightCm, outside) => {
    const values = at(widthCm, heightCm);
    const size = `${widthCm}×${heightCm === null ? '—' : heightCm} cm`;

    const script = runDeployedScript({ groupNumber, lang, orgIdent, userIdent, paramName, scriptsField, values });
    if (!script.ok) return;

    let reference;
    try {
      reference = await excelTruthTable.getReferencePrice({
        groupNumber, lang, orgIdent, userIdent, paramName, values, scriptsField
      });
    } catch (err) {
      return;
    }
    if (reference.kind === 'no-sheet' || reference.kind === 'unknown-axis') return;

    if (outside) {
      const before = findings.length;
      findings.push(...assertions.checkOutOfRangePrice({
        groupNumber, paramName, size, where: outside, scriptPrice: script.value, reference
      }));
      // Nothing reported means both sides agree there is no price there —
      // correct, and summarised once at the end rather than per probe.
      const referenceHasPrice = reference.found === true && reference.price > 0;
      if (findings.length === before && !referenceHasPrice && script.value === 0) {
        silentSizes.push(`${size} (${outside})`);
      }
      return;
    }

    findings.push(...assertions.checkInRangePrice({
      groupNumber, paramName, size, scriptPrice: script.value, reference, referenceFactor: script.factor
    }));
  };

  // Out-of-range probes are cheap and the most likely to find something
  // nobody authored, so they are never the part that gets cut for time.
  let outOfRange = 0;
  const midWidthIndex = Math.floor(widthPicks.length / 2);
  const midHeightIndex = Math.floor(heightPicks.length / 2);
  for (const point of outOfRangePoints(grid.widthsCm)) {
    await check(point.cm, heightPicks[midHeightIndex], `szerokość ${point.where}`);
    outOfRange += 1;
  }
  if (heights[0] !== null) {
    for (const point of outOfRangePoints(grid.heightsCm)) {
      await check(widthPicks[midWidthIndex], point.cm, `wysokość ${point.where}`);
      outOfRange += 1;
    }
  }

  let inRange = 0;
  let ranOutOfTime = false;
  const order = spreadOrder(widthPicks, heightPicks, mulberry32(seed));
  for (const [widthCm, heightCm] of order) {
    if (Date.now() - startedAt > budgetMs) { ranOutOfTime = true; break; }
    await check(widthCm, heightCm, null);
    inRange += 1;
  }

  findings.push(...assertions.checkOutOfRangeDimensionsSilent({ groupNumber, paramName, sizes: silentSizes }));

  return {
    findings,
    cases: inRange + outOfRange,
    inRange,
    outOfRange,
    ranOutOfTime,
    reason: `Przegląd cennika ${paramName} (blok ${grid.letter}, sekcje ${grid.sections.join('/')}): ${inRange} konfiguracji w zakresie `
      + `(${grid.widthsCm[0]}-${grid.widthsCm[grid.widthsCm.length - 1]} cm szerokości`
      + `${heights[0] === null ? '' : `, ${heights[0]}-${heights[heights.length - 1]} cm wysokości`}) `
      + `i ${outOfRange} poza zakresem${ranOutOfTime ? ` (przerwane po ${Math.round(budgetMs / 1000)} s budżetu; odwiedzone komórki są rozłożone po całej tabeli, nie po jej fragmencie)` : ''}.`
  };
}


/**
 * Price ONE swapped option through the real engine cascade.
 *
 * Used only to confirm a candidate that already looks unpriced, because it
 * costs a full recompute (~2.5 s) against ~0.1 s for a script call.
 *
 * @returns {Promise<number|null>} the price, or null when the engine could not
 *   produce an answer — which is not evidence of anything and must not be
 *   reported as a missing price.
 */
async function recomputeWithOption({ groupNumber, version, lang, orgIdent, userIdent, baseValues, candidate }) {
  if (!version) return null;
  try {
    const values = Object.assign({}, baseValues, { [candidate.fieldName]: candidate.value });
    // Drop the stale mirrors so the cascade re-derives them for the new value
    // instead of pricing against the previous option's description.
    delete values[`${candidate.fieldName}___DESCRIPTION`];
    delete values[`${candidate.fieldName}_ALIAS___DESCRIPTION`];
    delete values[`${candidate.fieldName}_ALIAS`];

    const result = await formEngine.calculatePrices({
      groupNumber, version, lang, values, singlePass: true, orgIdent, userIdent, isGroup: true
    });
    const total = result && result.total ? parseFloat(result.total.total) : NaN;
    return Number.isFinite(total) ? total : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Sweeps the OPTION space — fabrics, colours, models — instead of dimensions.
 *
 * This is the other half of "mnóstwo pozycji": a price sheet is sectioned by
 * model family and by the colour's price group, and history only ever covers
 * the handful of combinations somebody happened to order. Group 73 offers 254
 * colours; if one of them has no price group with a section, the configurator
 * lets a customer pick it and quotes nothing — the brief's headline failure,
 * and one no replay of past orders would ever reach.
 *
 * Two things make this trustworthy rather than noisy:
 *
 *  - **descriptions come from the engine**, not from a re-derivation. Every
 *    section gates on the description (`ZAWIERA(KOLOR___DESCRIPTION,"#2")`),
 *    and the engine was booted as the order owner, so its option descriptions
 *    are the ones this client's dictionary and alias collection produce.
 *  - **ENABLE is honoured.** An option is only offered when its formula holds
 *    (`TASMA G01` is `=WSROD(MODEL,"TAPE")`). Generating combinations without
 *    it would invent configurations no customer can pick and then report them
 *    as missing prices.
 *
 * Only the fields the section gates actually read are swept
 * (`grid.conditionParams`) — changing anything else cannot move the lookup.
 */
async function runOptionSweep({
  groupNumber, lang = 'pl', orgIdent, userIdent, baseValues, version,
  paramName = 'CENA', scriptsField, maxCases = DEFAULT_MAX_CASES, budgetMs = DEFAULT_BUDGET_MS
}) {
  const startedAt = Date.now();
  const empty = (reason) => ({ findings: [], cases: 0, unpriceable: [], ranOutOfTime: false, reason });

  const grid = await excelTruthTable.getDimensionGrid({
    groupNumber, lang, orgIdent, userIdent, paramName, values: baseValues, scriptsField
  });
  if (!grid.ok) return empty(`przegląd opcji pominięty — ${grid.reason}`);

  // Fields worth sweeping: read by a section gate, present in the
  // configuration, and not the dimensions (rangeSweep already moves those).
  const candidates = (grid.conditionParams || []).filter((name) => (
    baseValues[name] !== undefined && name !== 'SZEROKOSC' && name !== 'WYSOKOSC'
    && name !== grid.widthParam && name !== grid.heightParam
  ));
  if (!candidates.length) return empty('przegląd opcji pominięty — żadna sekcja cennika nie zależy od pól tej konfiguracji');

  const options = await engineRunner.getAvailableOptions({
    groupNumber, version, lang, baseValues, fieldNames: candidates, orgIdent, userIdent
  });

  // The price group frequently does NOT live in the base dictionary. Quoting
  // services/orderImport/paramDescriptions.js, which solved this for imports:
  // for Duette fabrics `paramdict.txt` carries no description at all and the
  // tag exists only in the client's alias collection. Sweeping without it
  // produced false P1s — group 04's `935-25`, `926-25`, `20914-25` came back
  // "unpriceable" purely because the alias tag had been dropped.
  let clientDescriptions = null;
  try {
    clientDescriptions = await loadClientDescriptions(groupNumber, orgIdent, userIdent);
  } catch (_err) {
    clientDescriptions = null;
  }
  const aliasEntry = (fieldName, value) => {
    if (!clientDescriptions || typeof clientDescriptions.get !== 'function') return null;
    const byValue = clientDescriptions.get(fieldName);
    return (byValue && byValue.get(String(value))) || null;
  };

  const env = await excelTruthTable.getEvaluator(lang);
  const holds = (formula, values) => {
    if (!formula) return true;
    try {
      const result = env.window.FormulaHandler.evaluateFormula(
        String(formula).replace(/^=/, ''), excelTruthTable.withAuthoringDialect(values), 'formula'
      );
      return result === true || result === 1 || result === '1';
    } catch (_err) {
      // An ENABLE we cannot evaluate is not evidence the option is unavailable,
      // so keep the case rather than silently dropping coverage.
      return true;
    }
  };

  const findings = [];
  const unpriceable = [];
  let cases = 0;
  let ranOutOfTime = false;
  const reportsUnpriceable = /^(SUB___)?CENA$/.test(paramName);

  for (const fieldName of candidates) {
    const entries = options[fieldName] || [];
    if (entries.length < 2) continue;

    for (const entry of entries) {
      if (Date.now() - startedAt > budgetMs) { ranOutOfTime = true; break; }
      if (cases >= maxCases) { ranOutOfTime = true; break; }
      if (String(entry.value) === String(baseValues[fieldName])) continue;

      const alias = aliasEntry(fieldName, entry.value);
      const aliasDescription = alias && alias.description ? String(alias.description) : '';

      // No price group from either source means we cannot tell which section
      // should apply — so we must not claim the option has no price. Skipped,
      // not reported: "we don't know" is never evidence of a defect.
      if (!entry.description && !aliasDescription) continue;

      const values = Object.assign({}, baseValues, {
        [fieldName]: entry.value,
        [`${fieldName}___DESCRIPTION`]: entry.description,
        // The gates read the alias description first and fall back to the plain
        // one; hot-formula-parser resolves BOTH branches of an IF, so the key
        // has to exist even when empty rather than be missing.
        [`${fieldName}_ALIAS___DESCRIPTION`]: aliasDescription,
        ...(alias && alias.alias ? { [`${fieldName}_ALIAS`]: alias.alias } : {})
      });
      if (!holds(entry.enable, values)) continue;

      cases += 1;
      const script = runDeployedScript({ groupNumber, lang, orgIdent, userIdent, paramName, scriptsField, values });
      if (!script.ok) continue;

      let reference;
      try {
        reference = await excelTruthTable.getReferencePrice({
          groupNumber, lang, orgIdent, userIdent, paramName, values, scriptsField
        });
      } catch (_err) {
        continue;
      }
      if (reference.kind === 'no-sheet' || reference.kind === 'unknown-axis') continue;

      const referenceHasPrice = reference.found === true && reference.price > 0;
      if (!referenceHasPrice && script.value === 0) {
        // Only the BASE price may be missing. A surcharge that does not apply
        // to a model is the normal state of a surcharge, not a defect —
        // measured: group 75 reported `DOPLATA: 348 z 354 opcji` without a
        // price, which is simply what a surcharge table looks like.
        if (reportsUnpriceable) {
          // Collected rather than reported one by one: 254 colours in one
          // price group would otherwise bury the report.
          unpriceable.push({
            fieldName,
            value: entry.value,
            description: entry.description || aliasDescription,
            structural: !!entry.proc
          });
        }
        continue;
      }

      findings.push(...assertions.checkInRangePrice({
        groupNumber, paramName, size: `${fieldName}=${entry.value} (${entry.description || 'bez opisu'})`,
        scriptPrice: script.value, reference, referenceFactor: script.factor
      }));
    }
    if (ranOutOfTime) break;
  }

  // Confirm each candidate through a REAL recompute before reporting it.
  //
  // Swapping a value in the value set is not the same as choosing it in the
  // form: changing MODEL restructures the configuration (its option PROC sets
  // other params' MIN/MAX, and some models need fields the old one did not
  // have), so "no price alongside the previous model's other fields" is not
  // evidence of a missing price. Measured on group 75: MODEL=DACH_KOMF /
  // DACH_BAS (Skylight) came back unpriced from the value swap alone.
  //
  // Only the candidates that already look unpriced are re-run, so the cost is
  // a couple of seconds each on a handful of options rather than on all 254.
  const confirmed = [];
  for (const candidate of unpriceable) {
    if (Date.now() - startedAt > budgetMs * 2) break;
    const settled = await recomputeWithOption({
      groupNumber, version, lang, orgIdent, userIdent, baseValues, candidate
    });
    // Engine could not answer → not evidence either way, so do not report.
    if (settled === null) continue;
    if (settled > 0) continue;
    confirmed.push(candidate);
  }

  findings.push(...assertions.checkUnpriceableOptions({ groupNumber, paramName, unpriceable: confirmed, checked: cases }));

  return {
    findings,
    cases,
    unpriceable: confirmed,
    ranOutOfTime,
    reason: `Przegląd opcji ${paramName} (pola ${candidates.join('/')}): ${cases} kombinacji`
      + `${unpriceable.length ? `, ${unpriceable.length} bez ceny w cenniku` : ''}`
      + `${ranOutOfTime ? ' (przerwane limitem)' : ''}.`
  };
}

module.exports = { runRangeSweep, runOptionSweep, stride, spreadOrder, outOfRangePoints, DEFAULT_MAX_CASES, DEFAULT_BUDGET_MS };
