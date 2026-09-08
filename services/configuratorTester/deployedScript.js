/**
 * Runs the DEPLOYED price script (`/mnt/eform/data/<group>/data/param-<NAME>-<variant>.js`)
 * on a given configuration — the artefact the portal actually serves, sitting
 * between the authoring workbook and the customer.
 *
 * Why this exists, measured on real data (group 73, position #6449):
 *
 *   workbook /mnt/eformconf        → 62.4 × 1.4 = 87.36
 *   deployed param-CENA-Cmul1.4.js → 87.36   (same value set)
 *   real browser, admin-redit      → 96.28   (SZEROKOSC_POTRZEBNA settles at 2830)
 *   headless services/formEngine   → 38.02   (the script ran while it was still "")
 *
 * `SZEROKOSC_POTRZEBNA` is a FORMULA param the CENA sheet is indexed by, and
 * `calculatePrices()` runs `applyFormulaParams()` AFTER the pricing cascade —
 * so headless, the price script sees an empty axis and nothing re-prices
 * afterwards. The live configurator converges because every user interaction
 * fires another `updateProcedure`.
 *
 * That made the headless engine price the wrong thing to compare a price list
 * against: it produced five P1 "CENA_ZANIZONA" on group 73 for a configurator
 * that is, on screen, consistent with its own price list. So the price check
 * compares the workbook with THIS — the deployed script, on the same value set,
 * which is what the brief's "czy cennik trafił do konfiguratora" actually asks —
 * and the engine's own disagreement with its script is reported separately as a
 * recompute problem, never as underpricing.
 *
 * Read-only: loads and evaluates files, writes nothing.
 */

'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../config');
const { resolvePriceVariant, parseVariantToken } = require('./excelTruthTable/priceVariant');

// Same two files jsdomEnv.js loads before any price script, in the same order:
// the generated scripts call a bare global `evaluateFormula()`.
let formulaSources = null;

function getFormulaSources() {
  if (!formulaSources) {
    const root = path.join(__dirname, '..', '..');
    formulaSources = {
      parser: fs.readFileSync(path.join(root, 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'), 'utf8'),
      formula: fs.readFileSync(path.join(root, 'public', 'scripts', 'formula.js'), 'utf8')
    };
  }
  return formulaSources;
}

// Compiling one of these scripts costs ~0.7 s and ~65 MB (they are 5-6 MB of
// generated if/else), so keep the context and reuse it for every position in
// the group. Bounded and group-scoped for the same reason the sheet cache is:
// a full sweep must not accumulate them.
const MAX_CACHED_CONTEXTS = 4;
const contextCache = new Map();
let cachedGroup = null;

/** Drop every compiled price script held in memory (called between groups). */
function clearScriptCache() {
  contextCache.clear();
  cachedGroup = null;
}

/**
 * Which file this client/param actually runs. Mirrors excelTruthTable's
 * resolution exactly: param.txt's SCRIPTS column wins unless it literally says
 * `true`, which means "resolve through the client's prod.txt mapping".
 */
function resolveScriptFile({ groupNumber, lang, orgIdent, userIdent, paramName, scriptsField }) {
  const token = parseVariantToken(scriptsField);
  if (token) {
    // Use the raw token, not letter+multiplier reassembled — `Cmul1.40` and
    // `Cmul1.4` are different filenames and only the original text is certain.
    const raw = String(scriptsField).trim();
    return { file: `param-${paramName}-${raw}.js` };
  }

  const variant = resolvePriceVariant({ groupNumber, lang, orgIdent, userIdent, paramName });
  return variant ? { file: variant.file } : null;
}

function getContext(groupNumber, file) {
  if (cachedGroup !== groupNumber) clearScriptCache();
  cachedGroup = groupNumber;

  if (contextCache.has(file)) return contextCache.get(file);

  const scriptPath = path.join(dataDir, String(groupNumber), 'data', file);
  if (!fs.existsSync(scriptPath)) return { ok: false, reason: `brak wdrożonego skryptu ${file}` };

  const { parser, formula } = getFormulaSources();
  // `formula.js` is browser code and reaches for `window`; a self-referencing
  // sandbox is enough — it only needs the global object to hang FormulaHandler
  // on. (services/formEngine/scriptRunner.js omits this and fails with
  // "window is not defined" on every script; it is unused dead code, left
  // alone rather than changed from here.)
  const sandbox = { console: { log() {}, error() {}, warn() {} }, evaluateFormula: null, f: null };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  let entry;
  try {
    const context = vm.createContext(sandbox);
    vm.runInContext(parser, context, { filename: 'formula-parser.min.js' });
    vm.runInContext(formula, context, { filename: 'formula.js' });
    vm.runInContext(
      "evaluateFormula = function (expr, vals, mode) { return FormulaHandler.evaluateFormula(expr, vals, mode || 'formula'); };",
      context
    );
    vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: file });
    entry = typeof sandbox.f === 'function'
      ? { ok: true, context, file }
      : { ok: false, reason: `${file} nie definiuje funkcji f()` };
  } catch (err) {
    entry = { ok: false, reason: `${file} nie dał się uruchomić: ${err.message}` };
  }

  if (contextCache.size >= MAX_CACHED_CONTEXTS) {
    contextCache.delete(contextCache.keys().next().value);
  }
  contextCache.set(file, entry);
  return entry;
}

/**
 * The per-uid surcharge the script applied, read off the label it returns.
 *
 * These scripts end with a table of customer uids (`else if (uid=="c94cb…")
 * { f = f + 0.03; }`), then `CENA = CENA * f`, and when `f != 1` they rewrite
 * the label as `"(304(TCNDPG2))*1.045"`. That factor exists nowhere in the
 * authoring workbook — by design, it is a per-customer arrangement, not a price
 * list entry — so a reference read from the workbook has to be scaled by it
 * before the two numbers mean the same thing.
 *
 * Measured on group 71 position #7262: workbook 304, browser 317.68, ratio
 * exactly 1.045. Headless the same script returns a flat 304, because the
 * engine invents a synthetic `uid` (`engine_1788786937956`) that is not in the
 * table — which is why this only ever surfaced in the browser pass.
 *
 * Parsed rather than looked up: the script is the authority on which factor it
 * used, and re-deriving it from a uid table would be a second implementation of
 * the same decision.
 */
function factorFromLabel(label) {
  const match = /\)\s*\*\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(String(label || ''));
  if (!match) return 1;
  const factor = parseFloat(match[1]);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * @param {object} opts
 * @param {string} opts.groupNumber
 * @param {string} [opts.lang]
 * @param {string} opts.orgIdent      order owner's organization.ident
 * @param {string} opts.userIdent     order owner's user.ident
 * @param {string} opts.paramName     e.g. CENA, SUB___DOPLATA
 * @param {string} [opts.scriptsField] param.txt SCRIPTS column for that param
 * @param {object} opts.values        engine-shaped values (the settled ones)
 * @returns {{ok:true, value:number, label:string, file:string}|{ok:false, reason:string}}
 */
function runDeployedScript({ groupNumber, lang = 'pl', orgIdent, userIdent, paramName, scriptsField, values }) {
  const resolved = resolveScriptFile({ groupNumber, lang, orgIdent, userIdent, paramName, scriptsField });
  if (!resolved) return { ok: false, reason: `brak przypisania skryptu ${paramName} dla ${orgIdent}/${userIdent}` };

  const entry = getContext(groupNumber, resolved.file);
  if (!entry.ok) return entry;

  try {
    const payload = JSON.stringify(JSON.stringify(values));
    const result = vm.runInContext(`f(${payload})`, entry.context);
    if (!result || typeof result !== 'object') return { ok: false, reason: `${resolved.file} nie zwrócił wyniku` };

    const value = parseFloat(result[paramName]);
    if (!Number.isFinite(value)) return { ok: false, reason: `${resolved.file} nie zwrócił liczby w ${paramName}` };

    const label = result[`${paramName}_S`];
    return { ok: true, value, label, factor: factorFromLabel(label), file: resolved.file };
  } catch (err) {
    return { ok: false, reason: `${resolved.file} zgłosił błąd: ${err.message}` };
  }
}

module.exports = { runDeployedScript, resolveScriptFile, factorFromLabel, clearScriptCache };
