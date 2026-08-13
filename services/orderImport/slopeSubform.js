/**
 * Server-side counterpart of `public/scripts/formTools/slope.js` (`SourceWindow`).
 *
 * A "slope" param is a whole sub-form inside one field: `param.txt` marks it with
 * `SOURCE === NAME` (e.g. `WYMIAROWANIE_SLOPOW`) and its own catalog lives in
 * `data/<SOURCE>/data/<lang>/param.txt|paramdict.txt`. In the browser the modal
 * builds a *nested object* out of it — sub-values plus the very same meta suffixes
 * the main form uses:
 *
 *   { TYP: 'TYP20', WYM_B: 1232, …,
 *     TYP___DICT: true, TYP___TITLE: 'TYPE', TYP___VISIBLE: false,
 *     TYP___DESCRIPTION: 'TYP 20', TYP_ALIAS: '', TYP_ALIAS___DESCRIPTION: '', … }
 *
 * and the display entry is built from the *titles*, never from the meta keys:
 *
 *   option_value: ''          (the object has no single scalar value)
 *   option_description: 'TYPE:TYP20 / B:1232 / B1:123 / H1:1232 / H2:500'
 *
 * The importer had no equivalent, so an imported slope position went through the
 * JSDOM engine, whose `SourceWindow` starts from an *empty* sub-form (nothing
 * seeds it with the payload), and what landed in the DB was that empty model —
 * every sub-value blank and the display entry built from the leftover meta keys:
 *
 *   option_value: '[object Object],[object Object],… / TYP / false / … / B [mm] / …'
 *   option_description: 'TYP___DICT:[object Object],… / TYP___TITLE:TYP / …'
 *
 * This module rebuilds the model the same way the modal does, straight from the
 * import payload, so the engine/browser get a complete slope object to start from
 * and the display entry matches a hand-made order.
 *
 * Formulas: sub-param visibility (`WYM_H1` only exists for some `TYP`s) is decided
 * by the sub-form's own ENABLE formulas, evaluated with the real
 * `public/scripts/formula.js` in a VM sandbox — same code the browser runs.
 */

'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const { parseParamDefinitions } = require('./paramVisibility');

const META_SUFFIX_RE = /___(DICT|TITLE|VISIBLE|DESCRIPTION)$/;

function isMetaKey(key) {
  return typeof key === 'string'
    && (META_SUFFIX_RE.test(key) || key.endsWith('_ALIAS') || key.endsWith('_ALIAS_DESCRIPTION'));
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ formulas */

let formulaSandbox = null;

/**
 * `evaluateFormula` from `public/scripts/formula.js`, running in a VM sandbox
 * that fakes just enough of `window` for it (the parser plus the globals the
 * HASLO/USTAW branches write to). Returns null when the sandbox cannot be built
 * — callers then fall back to the flags the payload carries.
 *
 * @returns {((expr: string, values: object, type: string, param?: string) => any)|null}
 */
function getFormulaEvaluator() {
  if (formulaSandbox !== null) return formulaSandbox.evaluate;

  formulaSandbox = { evaluate: null };
  try {
    const parserSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'),
      'utf8'
    );
    const formulaSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'public', 'scripts', 'formula.js'),
      'utf8'
    );

    const sandbox = {
      console: { log() {}, error() {}, warn() {} },
      // formula.js writes these while evaluating HASLO/USTAW/PROCEDURE branches.
      inputsValidators: {},
      inputsDefaults: {},
      lockedParams: [],
      skipCountParams: [],
      constValues: {},
      actualParam: '',
      actualValue: '',
      paramPassword: ''
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(parserSrc, sandbox, { filename: 'formula-parser.min.js' });
    vm.runInContext(formulaSrc, sandbox, { filename: 'formula.js' });

    if (sandbox.FormulaHandler && typeof sandbox.FormulaHandler.evaluateFormula === 'function') {
      formulaSandbox.evaluate = (expr, values, type, param) =>
        sandbox.FormulaHandler.evaluateFormula(expr, values, type, param);
    }
  } catch (_err) {
    formulaSandbox.evaluate = null;
  }

  return formulaSandbox.evaluate;
}

/** Mirrors `components/htmlManipulator.isEnabled` (a password gate is not "enabled"). */
function isEnabled(formula, values, paramName) {
  const evaluate = getFormulaEvaluator();
  if (!evaluate) return null;
  try {
    const result = evaluate(formula, values, 'paramdict', paramName);
    return result === 'password' ? false : !!result;
  } catch (_err) {
    return null;
  }
}

/* ------------------------------------------------------------- catalog files */

/**
 * Options of the sub-form, parsed out of its `paramdict.txt` the same way
 * `DataLoader.convertDictValues` does: columns come in `<PARAM>_VALUE` /
 * `<PARAM>_DESCRIPTION` pairs.
 *
 * @param {string|null} raw
 * @returns {Object<string, Array<{VALUE: string, DESCRIPTION: string}>>}
 */
function parseDictOptions(raw) {
  const options = {};
  if (!raw) return options;

  const lines = String(raw).split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return options;

  const header = lines[0].split('\t').map((column) => column.trim());
  const valueColumns = [];
  header.forEach((column, idx) => {
    if (!column.endsWith('_VALUE')) return;
    const paramName = column.slice(0, -'_VALUE'.length).trim();
    if (!paramName) return;
    valueColumns.push({ paramName, valueIdx: idx, descIdx: header.indexOf(`${paramName}_DESCRIPTION`) });
  });

  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    for (const { paramName, valueIdx, descIdx } of valueColumns) {
      const rawValue = cells[valueIdx] === undefined ? '' : String(cells[valueIdx]).trim();
      const rawDesc = descIdx >= 0 && cells[descIdx] !== undefined ? String(cells[descIdx]).trim() : '';
      const value = rawValue === '<NULL>' ? '' : rawValue;
      const description = rawDesc === '<NULL>' ? '' : rawDesc;
      if (!value && !description) continue;
      if (!options[paramName]) options[paramName] = [];
      options[paramName].push({ VALUE: value, DESCRIPTION: description });
    }
  }

  return options;
}

/**
 * Read one catalog file of a sub-form, the same way the browser's `DataLoader`
 * fetches it: `data/<SOURCE>/data/versions/<version>/<lang>/<file>`.
 *
 * ⚠️ The version matters. `data/WYMIAROWANIE_SLOPOW/data/versions/` holds the
 * whole history, and the oldest entries are a *different form* (0.3.1 has
 * WYM_A…WYM_E and no ENABLE formulas, today's 0.3.34 has WYM_B/WYM_B1/WYM_H…).
 * Reading a wrong version would silently produce a model whose fields the real
 * form does not even know.
 *
 * @param {string} sourceName
 * @param {string} lang
 * @param {string} fileName    'param.txt' | 'paramdict.txt'
 * @param {string|null} version  null → the unversioned "current" directory
 * @returns {Promise<string|null>}
 */
async function readCatalogFile(sourceName, lang, fileName, version) {
  const { dataDir } = require('../../config');
  const dir = version
    ? path.join(dataDir, String(sourceName), 'data', 'versions', String(version), lang)
    : path.join(dataDir, String(sourceName), 'data', lang);
  try {
    return await fs.promises.readFile(path.join(dir, fileName), 'utf-8');
  } catch (_err) {
    return null;
  }
}

/** Form version of a sub-form catalog — same lookup as `GET /position/version/:groupNr`. */
async function readCatalogVersion(sourceName) {
  try {
    const { getAppVersion } = require('../../db/positions');
    return await getAppVersion(sourceName, process.env.NODE_ENV || 'dev');
  } catch (_err) {
    return null;
  }
}

const definitionCache = new Map();

/**
 * Load a sub-form catalog — a form of its own, exactly like an asortment group:
 * `param.txt` (fields) + `paramdict.txt` (their options), picked from the
 * version the app currently serves.
 *
 * Falls back, in order: the order's language → `pl` (the canonical set) →
 * the unversioned "current" directory, so a group translated into fewer
 * languages, or a version directory that was never materialised on disk, still
 * yields a usable catalog instead of nothing.
 *
 * @param {string} sourceName            e.g. 'WYMIAROWANIE_SLOPOW'
 * @param {string} lang
 * @param {object} [deps]
 * @param {Function} [deps.readCatalogFile]     `(source, lang, file, version)` override (tests; bypasses the cache)
 * @param {Function} [deps.readCatalogVersion]  `(source)` override (tests)
 * @returns {Promise<{params: Array<object>, options: object, version: string|null}|null>}
 */
async function loadSubformDefinition(sourceName, lang, deps = {}) {
  if (!sourceName) return null;
  const safeLang = lang || 'pl';
  const useCache = !deps.readCatalogFile && !deps.readCatalogVersion;
  const cacheKey = `${sourceName}::${safeLang}`;
  if (useCache && definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);

  const readFile = deps.readCatalogFile || readCatalogFile;
  const readVersion = deps.readCatalogVersion || readCatalogVersion;

  const version = await readVersion(sourceName);
  const langs = safeLang === 'pl' ? ['pl'] : [safeLang, 'pl'];
  const candidates = [];
  for (const candidateLang of langs) candidates.push([candidateLang, version || null]);
  // Last resort: the unversioned directory the importer's other file readers use.
  for (const candidateLang of langs) candidates.push([candidateLang, null]);

  let definition = null;
  for (const [candidateLang, candidateVersion] of candidates) {
    const defs = parseParamDefinitions(await readFile(sourceName, candidateLang, 'param.txt', candidateVersion));
    if (!defs) continue;
    definition = {
      params: Array.from(defs.values()),
      options: parseDictOptions(await readFile(sourceName, candidateLang, 'paramdict.txt', candidateVersion)),
      version: candidateVersion
    };
    break;
  }

  if (useCache) definitionCache.set(cacheKey, definition);
  return definition;
}

/** Test/ops helper — drops the in-memory sub-form catalog cache. */
function clearSubformCache() {
  definitionCache.clear();
}

/* ---------------------------------------------------------------- the model */

/**
 * Sub-form params the browser builds a field for: `createObject()` keeps every
 * param that has a DESCRIPTION (its label) and a declared ENABLE column.
 */
function modelParams(definition) {
  return (definition && Array.isArray(definition.params) ? definition.params : [])
    .filter((param) => param && param.NAME && param.DESCRIPTION);
}

/** Plain (non-meta) sub-values of whatever the payload sent for a slope param. */
function extractSubValues(rawValue) {
  const out = {};
  let source = rawValue;

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed || trimmed === '[object Object]') return out;
    try { source = JSON.parse(trimmed); } catch (_err) { return out; }
  }
  if (!isPlainObject(source)) return out;

  for (const [key, value] of Object.entries(source)) {
    if (isMetaKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Rebuild the nested slope model — the server-side `processSourceValues()`.
 *
 * @param {*} rawValue                       what the payload holds for the param
 * @param {{params: Array, options: object}} definition
 * @returns {object} sub-values + `___DICT`/`___TITLE`/`___VISIBLE`/`___DESCRIPTION`/`_ALIAS`
 */
function buildSlopeModel(rawValue, definition) {
  const params = modelParams(definition);
  const incoming = extractSubValues(rawValue);
  const options = (definition && definition.options) || {};

  // Values first: the ENABLE formulas of the sub-form read their siblings
  // (`WYM_H1` is only on for some `TYP`s), so the whole set must be known before
  // any visibility verdict is taken.
  const values = {};
  for (const param of params) {
    const value = incoming[param.NAME];
    values[param.NAME] = value === undefined || value === null ? '' : value;
  }

  const model = {};
  for (const param of params) {
    const name = param.NAME;
    const paramOptions = Array.isArray(options[name]) ? options[name] : [];
    const value = values[name];
    const selected = hasValue(value)
      ? paramOptions.find((option) => String(option.VALUE) === String(value))
      : null;

    // The sub-form's own ENABLE formula decides visibility; when it cannot be
    // evaluated we keep whatever flag the payload carried (default: visible).
    let visible = isEnabled(param.ENABLE, values, name);
    if (visible === null) {
      const sent = isPlainObject(rawValue) ? rawValue[`${name}___VISIBLE`] : undefined;
      visible = typeof sent === 'boolean' ? sent : true;
    }

    model[name] = value;
    model[`${name}_ALIAS`] = '';
    model[`${name}_ALIAS___DESCRIPTION`] = '';
    model[`${name}___DESCRIPTION`] = selected ? (selected.DESCRIPTION || '') : '';
    model[`${name}___DICT`] = paramOptions.length > 0;
    model[`${name}___TITLE`] = param.DESCRIPTION || name;
    model[`${name}___VISIBLE`] = visible;
  }

  return model;
}

/**
 * Display entry for a slope param, byte-for-byte what `buildValuesToDisplay`
 * produces from the modal's `sourceDisplayValues`: labels are the sub-param
 * titles cut at the first space (`B [mm]` → `B`), empty sub-values are skipped,
 * and the entry carries no scalar `option_value`.
 *
 * @param {object} model  output of `buildSlopeModel` (or an equivalent object)
 * @returns {{option_value: string, option_description: string}}
 */
function buildSlopeDisplayValue(model) {
  const parts = [];

  for (const [key, value] of Object.entries(model || {})) {
    if (isMetaKey(key)) continue;
    if (!hasValue(value)) continue;
    const title = model[`${key}___TITLE`] || key;
    parts.push(`${String(title).split(' ')[0]}:${value}`);
  }

  return { option_value: '', option_description: parts.join(' / ') };
}

/**
 * `true` when a value is a sub-form model that actually carries dimensions —
 * as opposed to the blank model an unseeded `SourceWindow` produces.
 *
 * @param {*} value
 */
function isFilledSlopeModel(value) {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, sub]) => !isMetaKey(key) && hasValue(sub));
}

/**
 * Names of the group's sub-form params (`SOURCE === NAME`).
 *
 * @param {Map<string, object>|null} paramDefs  from `paramVisibility.readFormParamDefs`
 * @returns {string[]}
 */
function findSourceParamNames(paramDefs) {
  if (!paramDefs || typeof paramDefs.values !== 'function') return [];
  const out = [];
  for (const def of paramDefs.values()) {
    if (def && def.NAME && def.SOURCE && def.SOURCE === def.NAME) out.push(def.NAME);
  }
  return out;
}

/**
 * Normalise every slope param of an imported position in place.
 *
 * @param {object} values                        item params (mutated)
 * @param {Map<string, object>|null} paramDefs   the group's `param.txt` defs
 * @param {string} lang
 * @param {object} [deps]                        `{ fileScanner }` for tests
 * @returns {Promise<{values: object, rebuilt: string[], notes: string[]}>}
 */
async function normalizeSlopeParams(values, paramDefs, lang, deps = {}) {
  const rebuilt = [];
  const notes = [];
  if (!values || typeof values !== 'object') return { values, rebuilt, notes };

  for (const name of findSourceParamNames(paramDefs)) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
    // Most positions of a slope-capable group are not slopes at all — an empty
    // field is the normal case and says nothing worth logging.
    if (!Object.keys(extractSubValues(values[name])).length) continue;

    const definition = await loadSubformDefinition(name, lang, deps);
    if (!definition) {
      notes.push(`${name}: brak katalogu podformularza (data/${name}/data/[versions/<ver>/]${lang || 'pl'}/param.txt)`);
      continue;
    }

    const model = buildSlopeModel(values[name], definition);
    const filled = Object.keys(model).filter((key) => !isMetaKey(key) && hasValue(model[key]));
    if (!filled.length) {
      // The payload carried something the catalog does not know (renamed
      // sub-params?) — leave it untouched rather than replacing it with an empty
      // model, which is exactly the bug this module exists to fix.
      notes.push(`${name}: wartości z importu nie pasują do żadnego pola podformularza`);
      continue;
    }

    values[name] = model;
    rebuilt.push(`${name} v${definition.version || 'current'} (${filled.join(', ')})`);
  }

  return { values, rebuilt, notes };
}

module.exports = {
  normalizeSlopeParams,
  buildSlopeModel,
  buildSlopeDisplayValue,
  isFilledSlopeModel,
  findSourceParamNames,
  loadSubformDefinition,
  clearSubformCache,
  readCatalogFile,
  readCatalogVersion,
  parseDictOptions,
  _internals: { extractSubValues, isEnabled, modelParams }
};
