/**
 * Server-side runner for price calculation scripts and configurator formulas.
 *
 * The price scripts (param-CENA-A.js, param-DOPLATA-B.js, etc.) define a
 * global function `f(jsonString)` that uses `evaluateFormula()` to compute
 * prices. In the browser, these are loaded via <script> tags. Here we
 * execute them directly in a VM sandbox with the formula handler available.
 *
 * This bypasses JSDOM entirely — no DOM needed, just pure JS execution.
 *
 * `public/scripts/formula.js` is browser code: it hangs FormulaHandler on
 * `window` and keeps ONE module-level parser whose variables survive between
 * calls. The sandbox is therefore its own `window`, and every evaluation starts
 * from the parser's initial variables — otherwise a value left behind by an
 * earlier configuration silently changes the next result.
 */

'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../config');
const { log } = require('../../utils/logging');

let sources = null;

function getSources() {
  if (!sources) {
    const root = path.join(__dirname, '..', '..');
    sources = {
      parser: fs.readFileSync(path.join(root, 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'), 'utf8'),
      formula: fs.readFileSync(path.join(root, 'public', 'scripts', 'formula.js'), 'utf8')
    };
  }
  return sources;
}

/**
 * Fresh realm with the configurator's FormulaHandler.
 *
 * `setNow(iso|null)` replaces the clock seen by `new Date()` inside the realm —
 * price scripts pick their per-client increase by today's date, so a threshold
 * can be tested on any day instead of the system one.
 */
function createRealm() {
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    // USTAW(…,"DOM",…) writes into form inputs; there is no form here.
    ignoreDom: true,
    formulaContext: {},
    constValues: {},
    lockedParams: [],
    skipCountParams: [],
    __now: null
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const { parser, formula } = getSources();
  vm.runInContext(parser, context, { filename: 'formula-parser.min.js' });
  vm.runInContext(formula, context, { filename: 'formula.js' });
  vm.runInContext(
    [
      "evaluateFormula = function (e, v, m) { return FormulaHandler.evaluateFormula(e, v, m || 'formula'); };",
      'const __initialVariables = Object.assign(Object.create(null), parser.variables);',
      'function __resetVariables() { parser.variables = Object.assign(Object.create(null), __initialVariables); }',
      'const __RealDate = Date;',
      'Date = class extends __RealDate {',
      '  constructor(...a) { if (a.length) super(...a); else super(__now === null ? __RealDate.now() : __now); }',
      '  static now() { return __now === null ? __RealDate.now() : new __RealDate(__now).getTime(); }',
      '};'
    ].join('\n'),
    context
  );

  return {
    context,
    sandbox,
    setNow(iso) {
      sandbox.__now = iso || null;
    },
    /** `FormulaHandler.evaluateFormula` on a clean parser. */
    evaluate(expression, values, mode = 'formula') {
      sandbox.__expr = expression;
      sandbox.__values = values;
      sandbox.__mode = mode;
      return vm.runInContext('__resetVariables(); FormulaHandler.evaluateFormula(__expr, __values, __mode)', context);
    },
    /**
     * A `<PARAM>_PROC` procedure exactly as `getProcedures` runs it for one
     * selected option, returning what its USTAW calls stored:
     * `{ SZEROKOSC: { MIN, MAX }, WYSOKOSC: {...}, POW: {...} }`.
     */
    procedure(procedure, values, paramName, optionValue) {
      sandbox.inputsValidators = {};
      sandbox.inputsDefaults = {};
      sandbox.formulaContext = {};
      sandbox.actualParam = paramName;
      sandbox.actualValue = optionValue;
      this.evaluate(procedure, values, 'PROCEDURE');
      const byParam = sandbox.inputsValidators[paramName] || {};
      return JSON.parse(JSON.stringify(byParam[optionValue] || {}));
    }
  };
}

// Compiling one generated script costs ~0.7 s and ~65 MB (5–6 MB of if/else),
// so keep a few compiled realms keyed by path + mtime + size.
const MAX_CACHED_SCRIPTS = 4;
const scriptCache = new Map();

/** Realm with one price script loaded; `run(values, { now })` calls its `f()`. */
function loadScriptRunner(scriptPath) {
  const stat = fs.statSync(scriptPath);
  const key = `${scriptPath}|${stat.mtimeMs}|${stat.size}`;
  if (scriptCache.has(key)) return scriptCache.get(key);

  const realm = createRealm();
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), realm.context, { filename: path.basename(scriptPath) });
  if (typeof realm.sandbox.f !== 'function') throw new Error(`${path.basename(scriptPath)} nie definiuje funkcji f()`);

  const runner = {
    run(values, { now = null } = {}) {
      realm.setNow(now);
      realm.sandbox.__arg = JSON.stringify(values);
      return vm.runInContext('__resetVariables(); f(__arg)', realm.context);
    }
  };
  if (scriptCache.size >= MAX_CACHED_SCRIPTS) scriptCache.delete(scriptCache.keys().next().value);
  scriptCache.set(key, runner);
  return runner;
}

/**
 * Execute a price script file with given values.
 *
 * @param {string} scriptPath - Absolute path to the script file (e.g. param-CENA-A.js)
 * @param {object} values - The form values object
 * @returns {object|null} - Result from f() or null on error
 */
function executeScript(scriptPath, values) {
  try {
    return loadScriptRunner(scriptPath).run(values);
  } catch (err) {
    if (process.env.FORM_ENGINE_DEBUG) {
      log(`scriptRunner: error executing ${path.basename(scriptPath)}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Run all SCRIPT-type params for a group and update values/displayValues.
 *
 * @param {Array} params - The params array from the form definition
 * @param {object} values - Current form values (mutated in place)
 * @param {string} groupNumber - The group number
 * @param {string} version - The form version
 * @returns {object} - Updated values
 */
function runPriceScripts(params, values, groupNumber, version) {
  const scriptParams = params.filter(p =>
    p && p.NAME && p.SCRIPTS && p.SCRIPTS !== '<NULL>' && p.SOURCE && p.SOURCE !== '<NULL>'
  );

  for (const param of scriptParams) {
    // Script path: /data/<groupNumber>/data/<scriptFile>
    // SOURCE field contains the script filename pattern like "param-CENA-A.js"
    // But actually SOURCE == param.NAME for source-type params (slope etc.)
    // SCRIPTS field has the actual script reference
    const scriptFile = `param-${param.NAME}-${param.SCRIPTS}.js`;
    const scriptPath = path.join(dataDir, groupNumber, 'data', scriptFile);

    if (!fs.existsSync(scriptPath)) {
      // Try alternative naming patterns
      const altPath = path.join(dataDir, groupNumber, 'data', param.SCRIPTS);
      if (fs.existsSync(altPath)) {
        const result = executeScript(altPath, values);
        if (result) {
          for (const [key, val] of Object.entries(result)) {
            values[key] = val;
          }
        }
      }
      continue;
    }

    const result = executeScript(scriptPath, values);
    if (result) {
      for (const [key, val] of Object.entries(result)) {
        values[key] = val;
      }
    }
  }

  return values;
}

module.exports = { executeScript, runPriceScripts, createRealm, loadScriptRunner };
