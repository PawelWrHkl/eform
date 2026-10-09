/**
 * Public API for the server-side form engine.
 *
 *   calculatePrices({ groupNumber, version, lang, values, displayValues, userIdent })
 *     → Boots a fresh JSDOM, replays the same `generateForm` pipeline the
 *       browser runs, then returns the final values, displayValues, totals
 *       and shortJson so the caller can persist real prices.
 *
 *   recalculatePosition(positionId)
 *     → Loads an existing `order_item`, recomputes prices using the engine
 *       and writes the result back via db/positions.updatePosition. Used as
 *       a maintenance hook to refresh stale prices on a single row.
 *
 * The engine is intentionally one-shot per call: each invocation builds and
 * disposes its own JSDOM instance. JSDOM is heavy (~50ms-200ms for a cold
 * boot) but this avoids the very real risk of state bleed between groups —
 * `form.js` writes copiously to `window.*` globals.
 */

'use strict';

const { bootEngine } = require('./jsdomEnv');

/**
 * Drive `updateProcedure` for every key in `values` so that every per-group
 * calculation script has a chance to run. We process keys sequentially to
 * respect the calculationQueue inside form.js.
 */
async function replayValues({ window, values }) {
  const engine = window.__engine;
  const params = window.params || [];
  const inputs = window.formInputs || {};
  const displayValues = window.formDisplayValues;
  const allOptionsByParameter = window.allOptionsByParameter || {};
  const groupNumber = window.tempGroupNumber;
  const calculatedParams = {};
  const filters = {};
  const options = {};

  // Build a quick lookup of param names this form actually knows about, so we
  // skip values that belong to other versions of the group (e.g. legacy keys
  // like `PK`/`ZY` inherited from older orders). Without this filter
  // `updateProcedure` blows up reading `FORMAT` from an undefined param entry.
  const knownParamNames = new Set();
  for (const p of params) {
    if (p && typeof p.name === 'string') knownParamNames.add(p.name);
  }
  for (const k of Object.keys(inputs || {})) knownParamNames.add(k);

  // Pre-seed formValues + DOM inputs with every incoming value BEFORE we
  // start firing updateProcedure. Otherwise the first updateProcedure call
  // runs `updateFieldStates` → `clearDisabledValues` and wipes any param
  // whose ENABLE formula references a sibling that isn't in formValues yet
  // (e.g. SZEROKOSC's ENABLE depends on SLOPE_TYPE). Mirroring the browser
  // input handler's `values[name] = value` for the whole batch up-front
  // makes the formula context coherent on the very first evaluation.
  //
  // We also default every known param name to '' so the formula parser
  // doesn't error out on unset variables (hot-formula-parser returns
  // {error:'#NAME?'} for any unknown identifier and the wrapper turns that
  // into `false`, which then disables the field and wipes its value).
  for (const p of params) {
    const n = p && p.NAME;
    if (!n) continue;
    if (window.formValues[n] === undefined) window.formValues[n] = '';
  }
  for (const [name, value] of Object.entries(values || {})) {
    if (name === 'uid') continue;
    if (knownParamNames.size > 0 && !knownParamNames.has(name)) continue;
    window.formValues[name] = value;
    const input = inputs[name];
    if (input && 'value' in input) {
      try { input.value = value == null ? '' : value; } catch (_e) { /* read-only */ }
    }
  }

  for (const [name, value] of Object.entries(values || {})) {
    if (name === 'uid') continue;
    if (knownParamNames.size > 0 && !knownParamNames.has(name)) {
      if (process.env.FORM_ENGINE_DEBUG) {
        process.stderr.write(`[formEngine] skip unknown field ${name}\n`);
      }
      continue;
    }
    const input = inputs[name];
    const tagName = input && input.tagName ? input.tagName : 'INPUT';

    // Mirror what the browser input/change handlers in form.js do BEFORE
    // calling updateProcedure: write the raw value into formValues and onto
    // the DOM input. Without this the formula parser sees SZEROKOSC/WYSOKOSC
    // (and friends) as undefined and every price formula evaluates to false.
    window.formValues[name] = value;
    if (input && 'value' in input) {
      try { input.value = value == null ? '' : value; } catch (_e) { /* read-only */ }
    }

    try {
      await engine.updateProcedure({
        params,
        inputs,
        values: window.formValues,
        displayValues,
        allOptionsByParameter,
        options,
        name,
        value,
        groupNumber,
        tagName,
        filters,
        calculatedParams,
        flags: {
          updateInputs: true,
          validate: true,
          buildValues: true,
          updateStates: true,
          percent: true
        }
      });
    } catch (err) {
      // Don't kill the whole calculation — log and continue so we still get
      // a (possibly partial) total back to the caller.
      process.stderr.write(`[formEngine] updateProcedure failed for ${name}: ${err.message}\n`);
    }
  }
}

/**
 * Pre-seed `values` into window.formValues/inputs, then fire ONE
 * updateProcedure on the first real param with a value — this cascades
 * through the full dependency graph (form.js' updateProcedure re-derives
 * dependent fields/options/validators/prices as it goes), then waits for
 * `finishFlag` exactly like the frontend's waitForCalculations(). Extracted
 * from calculatePrices()'s singlePass branch so callers that need the LIVE
 * `window` afterwards (e.g. services/configuratorTester reading
 * window.inputFlags for boundary acceptance) can reuse the exact same cheap
 * cascade instead of the much costlier per-key replayValues() loop.
 */
async function cascadeSinglePass(window, values, groupNumber) {
  const params = window.params || [];
  const inputs = window.formInputs || {};

  for (const [name, value] of Object.entries(values)) {
    if (name === 'uid') continue;
    window.formValues[name] = value;
    const input = inputs[name];
    if (input && 'value' in input) {
      try { input.value = value == null ? '' : value; } catch (_e) { /* read-only */ }
    }
  }

  let firstName = null;
  for (const p of params) {
    const n = p && p.NAME;
    if (!n || n.includes('___')) continue;
    if (!inputs[n]) continue;
    if (window.formValues[n] === undefined || window.formValues[n] === '') continue;
    firstName = n;
    break;
  }

  if (firstName) {
    await window.__engine.updateProcedure({
      params,
      inputs,
      values: window.formValues,
      displayValues: window.formDisplayValues,
      allOptionsByParameter: window.allOptionsByParameter || {},
      options: {},
      name: firstName,
      value: window.formValues[firstName],
      groupNumber,
      tagName: inputs[firstName]?.tagName || 'INPUT',
      filters: {},
      calculatedParams: {},
      flags: {
        updateInputs: true,
        validate: true,
        buildValues: true,
        updateStates: true,
        percent: true
      }
    });
  }

  const waitStart = Date.now();
  while (Date.now() - waitStart < 10000) {
    const queueEmpty = !window.calculationQueue || window.calculationQueue.length === 0;
    const finished = window.finishFlag === true;
    if (queueEmpty && finished) break;
    if (queueEmpty && (Date.now() - waitStart > 3000)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function displayValuesToObject(displayValues) {
  const out = {};
  if (!displayValues) return out;
  if (typeof displayValues.forEach === 'function') {
    displayValues.forEach((v, k) => { out[k] = v; });
  } else {
    Object.assign(out, displayValues);
  }
  return out;
}

function formatNumberForDisplay(value) {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return '0';
  if (num % 1 === 0) return num.toString();
  return num.toFixed(2);
}

function normalizeFormulaValue(result) {
  if (result === false || result === null || result === undefined || result < 0) {
    return 0;
  }

  const numeric = parseFloat(result);
  if (!Number.isFinite(numeric)) return 0;
  return parseFloat(numeric.toFixed(2));
}

function valuesEqual(a, b) {
  if (a === b) return true;
  const aNum = Number(a);
  const bNum = Number(b);
  return Number.isFinite(aNum) && Number.isFinite(bNum) && Math.abs(aNum - bNum) < 0.000001;
}

function hasUsableFormulaValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function formulaIdentifiers(expression) {
  const out = new Set();
  const fnNames = new Set([
    'AND', 'ORAZ', 'WSROD', 'NIEWSROD', 'WSROD2', 'NIEWSROD2', 'WSROD3', 'NIEWSROD3',
    'WSRODNIEWSROD', 'ZAWIERA', 'LEFT', 'RIGHT', 'FLOOR', 'CEIL', 'CEILING', 'ZAOKR',
    'HASLO', 'MIN', 'MAX', 'MIN2', 'MAX2', 'DOM'
  ]);
  const source = String(expression || '').toUpperCase();
  const regex = /\b[A-Z_][A-Z0-9_]*\b/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const token = match[0];
    if (!fnNames.has(token)) out.add(token);
  }
  return out;
}

function buildFormulaContext(values, sourceValues, expression) {
  const context = { ...(values || {}) };

  for (const [key, value] of Object.entries(sourceValues || {})) {
    if (!hasUsableFormulaValue(context[key]) && hasUsableFormulaValue(value)) {
      context[key] = value;
    }
  }

  for (const key of formulaIdentifiers(expression)) {
    if (!hasUsableFormulaValue(context[key])) {
      context[key] = 0;
    }
  }

  return context;
}

function upsertFormulaDisplayValue(window, param, value) {
  const displayValues = window.formDisplayValues;
  if (!displayValues || typeof displayValues.get !== 'function') return;

  const current = displayValues.get(param.NAME) || {};
  const optionValue = formatNumberForDisplay(value);
  const locked = Array.isArray(window.lockedParams) && window.lockedParams.includes(param.NAME);
  const sub = Array.isArray(window.subParams) && window.subParams.includes(param.NAME);

  displayValues.set(param.NAME, {
    param_description: current.param_description || param.DESCRIPTION || '',
    sub: current.sub === true || sub,
    option_value: optionValue,
    option_description: current.option_description || '',
    locked: current.locked === true || locked,
    row: current.row || param.LISTROW || '1',
    ...(param.LISTSUM === 'true' ? { listsum: true } : {})
  });
}

/**
 * `updateProcedure` calculates formulas for fields that are actively touched by
 * the replay. Imported payloads often do not contain computed params, so make a
 * final deterministic pass over every param with FORMULA and persist the same
 * value/display shape that pricesCalculator.calculateFromFormula would create.
 */
function applyFormulaParams(window, sourceValues = {}) {
  const params = Array.isArray(window.params) ? window.params : [];
  const values = window.formValues || {};
  const inputs = window.formInputs || {};
  const skipped = Array.isArray(window.skipCountParams) ? window.skipCountParams : [];
  const formulaParams = params.filter((param) => (
    param
    && param.NAME
    && param.FORMULA
    && param.FORMULA !== '<NULL>'
    && !skipped.includes(param.NAME)
  ));

  // Some formulas depend on previous formula fields (e.g. SUMA_BRUTTO uses
  // CENA_SUMA), so iterate until stable instead of relying on file order only.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;

    for (const param of formulaParams) {
      let result;
      try {
        const formulaContext = buildFormulaContext(values, sourceValues, param.FORMULA);
        result = window.FormulaHandler.evaluateFormula(param.FORMULA, formulaContext, 'formula');
      } catch (err) {
        if (process.env.FORM_ENGINE_DEBUG) {
          process.stderr.write(`[formEngine] formula failed for ${param.NAME}: ${err.message}\n`);
        }
        result = 0;
      }

      const normalized = normalizeFormulaValue(result);
      if (!valuesEqual(values[param.NAME], normalized)) {
        values[param.NAME] = normalized;
        changed = true;
      }

      const input = inputs[param.NAME];
      if (input && 'value' in input) {
        try { input.value = formatNumberForDisplay(normalized); } catch (_e) { /* read-only */ }
      }
      upsertFormulaDisplayValue(window, param, normalized);
    }

    if (!changed) break;
  }
}

function collectFormMeta(window) {
  const params = Array.isArray(window.params) ? window.params : [];
  return {
    params: params.map((param) => ({
      NAME: param && param.NAME,
      LISTROW: param && param.LISTROW,
      LISTSUM: param && param.LISTSUM,
      FORMROW: param && param.FORMROW,
      // Which price script this param resolves to. 'true' means "take it from
      // the client's prod.txt PARAM_SCRIPTS mapping" (see dataLoader.selectPrices);
      // anything else IS the variant token itself, e.g. 'A' or 'Cmul1.2'.
      SCRIPTS: param && param.SCRIPTS
    })).filter((param) => param.NAME),
    lockedParams: Array.isArray(window.lockedParams) ? [...window.lockedParams] : [],
    subParams: Array.isArray(window.subParams) ? [...window.subParams] : [],
    skipCountParams: Array.isArray(window.skipCountParams) ? [...window.skipCountParams] : []
  };
}

/**
 * Convert an in-memory displayValues object (`{KEY: {param_description,...}}`)
 * into the wire format that the UI sends and that the templates expect:
 *
 *   JSON.stringify([[key, value], [key, value], ...])
 *
 * Mirrors `JSON.stringify(Array.from(formDisplayValues.entries()))` from
 * `public/scripts/main.js`. Used by the importer so persisted rows match the
 * exact shape produced by the browser flow.
 */
function displayValuesToWireFormat(displayValues) {
  if (!displayValues) return JSON.stringify([]);
  let entries;
  // Order matters: Arrays also expose `.entries()` but it yields `[index,value]`
  // pairs which would silently corrupt the wire format. Handle them first.
  if (Array.isArray(displayValues)) {
    entries = displayValues;
  } else if (displayValues instanceof Map
    || (typeof displayValues.entries === 'function' && typeof displayValues.forEach === 'function' && typeof displayValues.size === 'number')) {
    entries = Array.from(displayValues.entries());
  } else {
    entries = Object.entries(displayValues);
  }
  return JSON.stringify(entries);
}

/**
 * Build a synthetic displayValues entry for a primitive raw value. Used when
 * the engine could not run and we have to persist *something* that follows the
 * Map-entries contract. The shape mirrors `buildValuesToDisplay` in
 * `public/scripts/formTools/updateFieldsAndValues.js`.
 */
function stubDisplayEntries(values) {
  const out = [];
  for (const [k, v] of Object.entries(values || {})) {
    if (k === 'uid') continue;
    if (k.includes('___')) continue;
    if (k.endsWith('_ALIAS')) continue;
    if (k.endsWith('_ALIAS_DESCRIPTION')) continue;
    out.push([k, {
      param_description: k,
      sub: false,
      option_value: v == null ? '' : String(v),
      option_description: '',
      locked: false,
      row: '1'
    }]);
  }
  return out;
}

/**
 * Core entry: run the engine once and return prices + final state.
 *
 * @param {object} opts
 * @param {string} opts.groupNumber       Asortment group (= item.product).
 * @param {string|number} opts.version    Form version (from prod.txt).
 * @param {string} opts.lang              Language code.
 * @param {object} opts.values            Canonical {paramName: value} map.
 * @param {object} [opts.displayValues]   Pre-existing display values (for edit).
 * @param {string} [opts.uid]             Override UID; otherwise synthetic.
 * @param {string} [opts.orgIdent]        Order owner's organization.ident — required
 *                                        to resolve per-client price scripts (see
 *                                        clientScripts.js); without it, params whose
 *                                        SCRIPTS is the literal 'true' price as blank/0.
 * @param {string} [opts.userIdent]       Order owner's user.ident (see opts.orgIdent).
 * @param {string} [opts.currency]        Client's price currency (services/currency.js:
 *                                        resolveCurrencyForOrder/ForUserIdent) — goes to
 *                                        the end of every monetary param label
 *                                        ("CENA HKL netto [PLN]"). Omitted = EUR.
 * @returns {Promise<{values, displayValues, total, shortJson}>}
 */
async function calculatePrices(opts) {
  const {
    groupNumber, version, lang, values = {}, displayValues = null, uid, singlePass = false,
    orgIdent, userIdent, isGroup, isGroupShop, currency
  } = opts || {};
  if (!groupNumber || !version) {
    throw new Error('formEngine.calculatePrices: groupNumber and version are required');
  }

  // isGroup/isGroupShop gate whether SUB___* (client-facing) params are built
  // at all — see form.js buildHtml. Callers that need those prices must ask for
  // them explicitly; the default stays as it was.
  const env = await bootEngine({ lang: lang || 'pl', uid, orgIdent, userIdent, isGroup, isGroupShop, currency });

  try {
    const initialDisplayValues = displayValues
      ? new env.window.Map(Object.entries(displayValues))
      : new env.window.Map();

    await env.window.__engine.generateForm(
      version,
      groupNumber,
      Object.assign({}, values),
      initialDisplayValues,
      true,
      lang || 'pl',
      false
    );

    if (singlePass) {
      await cascadeSinglePass(env.window, values, groupNumber);
    } else {
      await replayValues({ window: env.window, values });
    }

    // Drain the calculation queue.
    let safety = 50;
    while (env.window.calculationQueue && env.window.calculationQueue.length > 0 && safety-- > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }

    applyFormulaParams(env.window, values);

    const finalDisplayValues = env.window.formDisplayValues;
    const total = env.window.__engine.getTotal(finalDisplayValues);

    return {
      values: Object.assign({}, env.window.formValues),
      displayValues: displayValuesToObject(finalDisplayValues),
      total: {
        total: total.total || 0,
        total_hidden: total.total_hidden || 0,
        total_sub: total.total_sub || 0
      },
      shortJson: Object.assign({}, env.window.shortJson || {}),
      formMeta: collectFormMeta(env.window)
    };
  } finally {
    env.dispose();
  }
}

/**
 * Lightweight metadata loader — boots the engine and runs `generateForm`
 * (which populates `window.params`, `window.lockedParams`, `window.subParams`)
 * but does NOT replay values or run any `updateProcedure`. Returns the same
 * `formMeta` shape as `calculatePrices` so the display-value builder can
 * assign correct `row` and `locked` values without a full price calculation.
 *
 * @param {object} opts
 * @param {string} opts.groupNumber
 * @param {string|number} opts.version
 * @param {string} [opts.lang]
 * @param {string} [opts.uid]
 * @returns {Promise<{params, lockedParams, subParams}>}
 */
async function getFormMeta({ groupNumber, version, lang, uid } = {}) {
  if (!groupNumber || !version) {
    throw new Error('formEngine.getFormMeta: groupNumber and version are required');
  }

  const env = await bootEngine({ lang: lang || 'pl', uid });
  try {
    await env.window.__engine.generateForm(
      version,
      groupNumber,
      {},
      new env.window.Map(),
      false,
      lang || 'pl',
      false
    );
    return collectFormMeta(env.window);
  } finally {
    env.dispose();
  }
}

/**
 * Recalculate a single existing position by id.
 *
 * - Reads the row via db/positions.getPosition.
 * - Decodes its stored canonical values (json_parameters).
 * - Reuses the json_parameters_desc as the seed displayValues map.
 * - Runs calculatePrices.
 * - Persists the new prices via db/positions.updatePosition.
 *
 * The version is read from the stored `parameters_short.VERSION` if present
 * (every shortJson the importer/UI builds includes it). If absent, the latest
 * version on disk is used (callers should pass the version explicitly via the
 * second argument to bypass detection).
 *
 * @param {number} positionId
 * @param {object} [overrides] - { version, lang } to force values.
 */
async function recalculatePosition(positionId, overrides = {}) {
  // Lazy require — keeps the module free of DB side-effects at load time so
  // tests can run without a live MySQL pool.
  const { getPosition, updatePosition } = require('../../db/positions');
  const { selectQuery } = require('../../db/core');

  const row = await getPosition(positionId);
  if (!row) throw new Error(`recalculatePosition: position ${positionId} not found`);

  const groupNumber = row.asortment_group_number || row.asortment_group || row.product || row.group_number;
  if (!groupNumber) {
    throw new Error(`recalculatePosition: cannot determine group for position ${positionId}`);
  }

  const values = safeJsonParse(row.json_parameters, {});
  const displayValues = safeJsonParse(row.json_parameters_desc, {});
  const shortJson = safeJsonParse(row.parameters_short, {});

  const version = overrides.version || shortJson.VERSION || shortJson.version;
  if (!version) {
    throw new Error(`recalculatePosition: no version available for position ${positionId}`);
  }
  const lang = overrides.lang || row.lang || 'pl';

  // Resolve the position owner's org/client identity so per-client price
  // scripts (SCRIPTS === 'true') can be found — see clientScripts.js.
  let orgIdent = overrides.orgIdent;
  let userIdent = overrides.userIdent;
  if (!orgIdent || !userIdent) {
    const owner = await selectQuery(
      `SELECT u.ident AS user_ident, o.ident AS org_ident
       FROM order_item oi
       JOIN \`order\` ord ON ord.id = oi.order_id
       JOIN user u ON u.id = ord.user_id
       LEFT JOIN organization o ON o.id = u.organization_id
       WHERE oi.id = ?`,
      positionId
    );
    if (owner && owner[0]) {
      userIdent = userIdent || owner[0].user_ident;
      orgIdent = orgIdent || owner[0].org_ident;
    }
  }

  // Waluta klienta zamówienia — do opisów parametrów kwotowych.
  const { resolveCurrencyForOrder } = require('../currency');
  const currency = overrides.currency || await resolveCurrencyForOrder(row.order_id);

  const result = await calculatePrices({
    groupNumber,
    version,
    lang,
    values,
    displayValues,
    orgIdent,
    userIdent,
    currency
  });

  await updatePosition(
    {
      id: positionId,
      commission: row.commision,
      comment: row.comment,
      jsonValues: result.values,
      jsonValuesToDisplay: displayValuesToWireFormat(result.displayValues),
      jsonShort: result.shortJson
    },
    {
      total: result.total.total,
      total_hidden: result.total.total_hidden,
      total_sub: result.total.total_sub
    }
  );

  return result;
}

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_e) { return fallback; }
}

module.exports = {
  calculatePrices,
  recalculatePosition,
  getFormMeta,
  // Lower-level helpers exposed for tests / advanced callers (e.g.
  // services/configuratorTester, which needs the live `window` — with its
  // runtime-populated window.inputFlags/window.inputsValidators — before it's
  // disposed, so it drives bootEngine()+replayValues() directly instead of
  // going through the disposed-on-return calculatePrices()).
  bootEngine,
  replayValues,
  cascadeSinglePass,
  displayValuesToWireFormat,
  stubDisplayEntries
};
