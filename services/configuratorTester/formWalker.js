/**
 * Drives the real engine like a client filling in the form field by field,
 * instead of relying on an already-saved historical position (Faza 1's
 * caseGenerator.js). This is what makes "every possible configuration" from
 * the PDF brief tractable: cascading dependent dropdowns (choosing MODEL
 * changes which KOLOR/WYMIARY are legal) are exactly the problem
 * generateForm()/updateProcedure() already solve interactively — this module
 * just calls them in a loop instead of reimplementing that resolution.
 *
 * Reused, never duplicated:
 *   - formEngine.bootEngine / cascadeSinglePass (services/formEngine/index.js)
 *   - window.FormulaHandler.evaluateFormula (public/scripts/formula.js,
 *     loaded into the JSDOM window by services/formEngine/jsdomEnv.js)
 *
 * `collectAvailableOptions`/`isFieldEnabled` below mirror the ~5-line
 * ENABLE-filtering that public/scripts/formTools/createForm.js
 * (getPossibleValues) and public/scripts/components/htmlManipulator.js
 * (isEnabled) already do — those two functions are UI-option filtering, not
 * pricing/validation logic, and are not exposed on window.__engine (the
 * esbuild bundle only exports the functions form.js itself re-exports — see
 * services/formEngine/bundler.js — and form.js does not re-export them).
 * Extending form.js's exports to dodge this would violate the "no engine
 * changes" constraint for a cosmetic convenience, so this mirrors the same
 * evaluateFormula call these two functions already make instead.
 */

'use strict';

const formEngine = require('../formEngine');

function isFormulaEnabled(window, formula, values, paramName) {
  if (!formula || formula === '<NULL>') return true;
  try {
    const result = window.FormulaHandler.evaluateFormula(formula, values, 'paramdict', paramName);
    return result !== false && result !== 'password';
  } catch (_err) {
    return false;
  }
}

/**
 * Does this param have a dictionary (i.e. is it a picklist at all)?
 *
 * `allOptionsByParameter` is keyed off the paramdict.txt header, so a param
 * with no `<NAME>_VALUE` column simply has no entry — that means FREE INPUT
 * (e.g. group 76's CIEZARMAT = fabric weight "350", group 24's KOLOR_KUNDE =
 * the customer's own colour "XXX TCN"), not "a picklist with nothing in it".
 * Treating the two the same reported both as P1 "the client would be stuck",
 * while real orders happily carry values for them.
 */
function hasDictionary(window, paramName) {
  return !!(window.allOptionsByParameter && window.allOptionsByParameter[paramName]);
}

/** Mirrors createForm.js:getPossibleValues() — values currently legal for one field. */
function collectAvailableOptions(window, paramName) {
  const dictValues = (window.allOptionsByParameter && window.allOptionsByParameter[paramName]) || [];
  const values = window.formValues || {};
  const out = [];
  for (const row of dictValues) {
    if (row.VALUE === '-' || row.VALUE === '=' || row.VALUE === '' || row.VALUE === undefined) continue;
    if (!isFormulaEnabled(window, row.ENABLE, values, paramName)) continue;
    out.push(row.VALUE === '<NULL>' ? null : row.VALUE);
  }
  return out;
}

/** Fields the walker should try to fill: visible, plain-input params a real client would set. */
function isFillableField(param) {
  if (!param || !param.NAME) return false;
  const name = param.NAME;
  if (name.startsWith('_') || name.includes('___')) return false;
  if (param.TYPE === 'file') return false;
  if (param.SOURCE && param.SOURCE === param.NAME) return false; // modal/source param (e.g. slope) — out of scope here
  if (param.SCRIPTS && param.SCRIPTS !== '<NULL>') return false; // calculated
  if (param.FORMULA && param.FORMULA !== '<NULL>') return false; // calculated
  if (param.FORMROW === '0') return false; // hidden row
  return true;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Merge the MIN/MAX rules window.inputsValidators[fieldName] currently holds
 * — keyed by whatever OTHER field's value produced each rule (e.g. per
 * MODEL) — into one effective range, the same way
 * formTools/validateUtils.js:getValidatorsRange() does for validation.
 */
function mergeValidatorBounds(validators) {
  let min = 0;
  let max = Infinity;
  let found = false;
  for (const rules of Object.values(validators || {})) {
    const vMin = Number(rules.MIN2 ?? rules.MIN);
    const vMax = Number(rules.MAX2 ?? rules.MAX);
    if (Number.isFinite(vMin)) { min = Math.max(min, vMin); found = true; }
    if (Number.isFinite(vMax)) { max = Math.min(max, vMax); found = true; }
  }
  return found ? { min, max } : null;
}

// Last-resort fallback for a TYPE='numeric' field with neither a derived
// MIN/MAX rule NOR any historical data to fall back on (see pickNumericValue
// below) — an arbitrary plausible width/height in millimetres, only used to
// produce a complete, priceable configuration, never to assert accept/reject.
const NUMERIC_FIELD_FALLBACK = 1000;

/**
 * TYPE='numeric' fields (SZEROKOSC/WYSOKOSC and similar) are free-input, not
 * picklists — allOptionsByParameter has nothing for them, so they must never
 * be judged by collectAvailableOptions(). Prefers the midpoint of whatever
 * MIN/MAX the engine has already derived (see mergeValidatorBounds) — but in
 * practice `window.inputsValidators` does NOT reliably populate from a plain
 * MODEL-only cascade for every group (verified empirically: some groups never
 * set it at all, regardless of how many extra cascades are fired), so this
 * falls back to `numericDefaults[fieldName]` — the median of REAL historical
 * orders for this exact group/field (services/configuratorTester/
 * positionsSource.js:getTypicalNumericValue), which is far more likely to
 * land inside whatever range the price tables actually cover than a made-up
 * constant. Only when there is no historical data at all do we fall back to
 * NUMERIC_FIELD_FALLBACK. A numeric field is never reported as "konfigurator
 * nie puszcza dalej" — a client can always type SOME number.
 *
 * `numericDefaults` is either a plain `{FIELD: value}` map, or a resolver
 * `(fieldName, currentValues) => number|null|Promise<...>` — the resolver
 * form lets the caller condition the default on the categorical choices made
 * SO FAR (typically MODEL), since a group-wide median mixes models with very
 * different valid ranges (see positionsSource.js:getTypicalNumericValue).
 */
async function pickNumericValue(window, fieldName, numericDefaults) {
  const validators = window.inputsValidators && window.inputsValidators[fieldName];
  const bounds = mergeValidatorBounds(validators);
  if (bounds) {
    return Number.isFinite(bounds.max) ? Math.round((bounds.min + bounds.max) / 2) : (Math.ceil(bounds.min) || NUMERIC_FIELD_FALLBACK);
  }
  const typical = typeof numericDefaults === 'function'
    ? await numericDefaults(fieldName, window.formValues)
    : numericDefaults && numericDefaults[fieldName];
  if (Number.isFinite(typical) && typical > 0) return typical;
  return NUMERIC_FIELD_FALLBACK;
}

/**
 * Fills every currently-visible, fillable field with a value picked by
 * `pickValue(options, param)`, re-checking availability after each choice
 * (a choice can change which fields are visible or which options are legal
 * for later ones) until nothing changes or `maxIterations` is hit.
 *
 * @returns {{ values, blockedFields }} blockedFields = fillable, visible
 *   fields whose option list was empty when we tried them — the PDF's P1
 *   "KONFIGURATOR_NIE_PUSZCZA_DALEJ".
 */
async function fillForm(window, groupNumber, pickValue, numericDefaults = {}) {
  const params = window.params || [];
  const maxIterations = params.length + 5;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;

    for (const param of params) {
      if (!isFillableField(param)) continue;
      const name = param.NAME;
      if (hasValue(window.formValues[name])) continue;
      if (!isFormulaEnabled(window, param.ENABLE, window.formValues, name)) continue;

      let chosen;
      if (!hasDictionary(window, name)) {
        // Free-input field (no dictionary column at all). Fill numerics with a
        // plausible value; leave free TEXT alone — those are optional
        // annotations a client types, and inventing content is not this
        // tester's job.
        if (param.TYPE === 'numeric') {
          chosen = await pickNumericValue(window, name, numericDefaults);
        } else {
          continue;
        }
      } else if (param.TYPE === 'numeric') {
        // Free-input field — no dict options to look up, see pickNumericValue()
        // (always returns something, falling back to a generic value — a
        // client can always type SOME number, so this never blocks the walker).
        chosen = await pickNumericValue(window, name, numericDefaults);
      } else {
        const options = collectAvailableOptions(window, name);
        if (options.length === 0) continue; // no legal option YET — a sibling choice may unlock one later
        chosen = pickValue(options, param);
        if (!hasValue(chosen)) continue;
      }

      await formEngine.cascadeSinglePass(window, { [name]: chosen }, groupNumber);
      changed = true;
    }

    if (!changed) break;
  }

  // Final sweep, once nothing more can change: any still-empty, visible,
  // fillable field genuinely has no legal value — the PDF's P1
  // "KONFIGURATOR_NIE_PUSZCZA_DALEJ" (covers both an empty picklist AND a
  // numeric field whose MIN/MAX rule never fired).
  const blockedFields = [];
  for (const param of params) {
    if (!isFillableField(param)) continue;
    const name = param.NAME;
    if (hasValue(window.formValues[name])) continue;
    if (!isFormulaEnabled(window, param.ENABLE, window.formValues, name)) continue;
    // Only a real picklist can be "stuck with no options" — see hasDictionary().
    if (!hasDictionary(window, name)) continue;
    blockedFields.push(name);
  }

  return {
    values: Object.assign({}, window.formValues),
    blockedFields
  };
}

/**
 * Build ONE complete, valid configuration for a group — the PDF's "test
 * podstawowy". Also reports any field that got stuck with zero options (P1
 * "konfigurator nie puszcza dalej").
 *
 * `pickValue(options, param)` chooses which currently-available option to use
 * for a field; defaults to the first one. Picking blindly this way can land
 * on a combination of individually-legal options that nonetheless has no
 * price anywhere in the pricing tree (verified empirically) — the caller is
 * expected to pass a smarter picker (e.g. index.js's historical-popularity
 * picker backed by positionsSource.js) for the default "test podstawowy" to
 * avoid manufacturing BRAK_CENY noise from combinations no client would
 * realistically choose. The plain first-option default stays useful on its
 * own for "test kombinacji"/"test losowy", where exploring less common,
 * never-before-sold combinations is exactly the point.
 */
async function buildBasicConfiguration({ groupNumber, version, lang, numericDefaults = {}, pickValue = (options) => options[0] }) {
  const env = await formEngine.bootEngine({ lang: lang || 'pl' });
  try {
    await env.window.__engine.generateForm(version, groupNumber, {}, new env.window.Map(), false, lang || 'pl', false);
    const { values, blockedFields } = await fillForm(env.window, groupNumber, pickValue, numericDefaults);
    return { ok: true, groupNumber, version, lang, values, blockedFields };
  } catch (err) {
    return { ok: false, groupNumber, version, lang, error: err.message };
  } finally {
    env.dispose();
  }
}

/**
 * Build a variant configuration that starts from `baseValues` (typically
 * buildBasicConfiguration's result) and swaps ONE field to a different
 * currently-available option — used for "test kombinacji"/"test losowy"
 * without a full cartesian explosion across every field.
 *
 * @param {(options: any[]) => any} pickAlternative - selects the replacement
 *   value from the OTHER currently-available options (excludes the base one).
 */
async function buildVariantConfiguration({ groupNumber, version, lang, baseValues, fieldName, pickAlternative }) {
  const env = await formEngine.bootEngine({ lang: lang || 'pl' });
  try {
    await env.window.__engine.generateForm(version, groupNumber, Object.assign({}, baseValues), new env.window.Map(), true, lang || 'pl', false);
    await formEngine.cascadeSinglePass(env.window, baseValues, groupNumber);

    const options = collectAvailableOptions(env.window, fieldName)
      .filter((v) => String(v) !== String(env.window.formValues[fieldName]));
    if (options.length === 0) {
      return { ok: false, groupNumber, reason: `brak alternatywnej opcji dla pola ${fieldName}` };
    }

    const alternative = pickAlternative(options);
    await formEngine.cascadeSinglePass(env.window, { [fieldName]: alternative }, groupNumber);

    // Re-fill anything the swap left blank/blocked (e.g. a field only valid
    // for the previous option) the same way buildBasicConfiguration does.
    const { values, blockedFields } = await fillForm(env.window, groupNumber, (opts) => opts[0]);
    return { ok: true, groupNumber, version, lang, values, blockedFields, mutatedField: fieldName, mutatedValue: alternative };
  } catch (err) {
    return { ok: false, groupNumber, error: err.message };
  } finally {
    env.dispose();
  }
}

/** Real MIN/MAX the engine itself derived for a field, given a complete configuration. */
async function getDimensionBounds({ groupNumber, version, lang, baseValues, fieldName }) {
  const env = await formEngine.bootEngine({ lang: lang || 'pl' });
  try {
    await env.window.__engine.generateForm(version, groupNumber, Object.assign({}, baseValues), new env.window.Map(), true, lang || 'pl', false);
    await formEngine.cascadeSinglePass(env.window, baseValues, groupNumber);

    const validators = env.window.inputsValidators && env.window.inputsValidators[fieldName];
    const bounds = mergeValidatorBounds(validators);
    if (!bounds) return { ok: false, reason: `window.inputsValidators[${fieldName}] nie ma MIN/MAX` };
    return { ok: true, min: bounds.min, max: bounds.max };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    env.dispose();
  }
}

module.exports = {
  hasDictionary,
  buildBasicConfiguration,
  buildVariantConfiguration,
  getDimensionBounds,
  collectAvailableOptions,
  isFormulaEnabled,
  isFillableField
};
