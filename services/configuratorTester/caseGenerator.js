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

const { getRecentPositions } = require('./positionsSource');
const engineRunner = require('./engineRunner');
const assertions = require('./assertions');

const DIMENSION_FIELDS = ['SZEROKOSC', 'WYSOKOSC'];

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
    findings.push(...assertions.checkPriceExists(recompute));
    findings.push(...assertions.checkPriceNotUnderpriced(recompute));

    const twice = await engineRunner.recomputeTwice(row);
    findings.push(...assertions.checkCartConsistency(twice));
  }
  return findings;
}

async function runBoundaryCases(groupNumber, positions) {
  const findings = [];
  for (const row of positions) {
    const { version, lang, values } = engineRunner.decodePositionRow(row);
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
        groupNumber, version, lang, baseValues: values, fieldName, testValue: baseValue
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
    const { groupNumber: gn, version, lang, values } = engineRunner.decodePositionRow(row);
    if (!version) continue;

    const paramNames = Object.keys(values).filter((k) => !k.includes('___') && !k.endsWith('_ALIAS') && k !== 'uid');
    if (paramNames.length === 0) continue;
    const fieldName = paramNames[Math.floor(rng() * paramNames.length)];

    const options = await engineRunner.getAvailableOptionValues({ groupNumber: gn, version, lang, baseValues: values, fieldName });
    const alternative = options.find((v) => String(v) !== String(values[fieldName]));
    if (alternative === undefined) continue;

    const mutatedRow = Object.assign({}, row, {
      json_parameters: JSON.stringify(Object.assign({}, values, { [fieldName]: alternative }))
    });

    const recompute = await engineRunner.recomputeFromPositionRow(mutatedRow);
    findings.push(...assertions.checkPriceExists(recompute));
    findings.push(...assertions.checkPriceNotUnderpriced(recompute));
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

  const positions = await getRecentPositions(groupNumber, seedPositions);
  if (positions.length === 0) {
    return {
      groupNumber,
      skipped: true,
      reason: 'Brak zapisanych pozycji dla tej grupy — test podstawowy/graniczny wymaga co najmniej jednej realnej konfiguracji jako punktu wyjścia (Faza 1).',
      findings: []
    };
  }

  const findings = [];
  findings.push(...await runBasicAndCartCases(groupNumber, [positions[0]]));
  findings.push(...await runBoundaryCases(groupNumber, [positions[0]]));
  findings.push(...await runCombinationAndRandomCases(groupNumber, positions, { count: randomCasesCount, seed }));

  return { groupNumber, skipped: false, positionsChecked: positions.length, findings };
}

module.exports = { runGroupSuite };
