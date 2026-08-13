/**
 * Param visibility for imported orders — "hide/show" driven by `param.txt`.
 *
 * Every param in `param.txt` carries an `ENABLE` formula that decides whether
 * the field is part of *this* configuration. The form engine evaluates it and
 * `clearDisabledValues` (public/scripts/formTools/validateUtils.js) records the
 * verdict in `values['<PARAM>___VISIBLE']` while blanking the value of every
 * disabled field.
 *
 * The importer used to lose that verdict: import params were the base of
 * `json_parameters` and an engine value was only allowed to overwrite them when
 * it was non-empty, so a deliberate "" (field disabled) was indistinguishable
 * from "the engine computed nothing" and the imported value survived. Real
 * example — order 272169, group 71, `MODEL=BB24`:
 *
 *   DLUGOSC_STER  ENABLE = NOT(WSROD(MODEL,"…,BB24,…"))  → false
 *   stored:       DLUGOSC_STER = 800, DLUGOSC_STER___VISIBLE = false
 *
 * This module centralises the verdict so the insert step, the post-recalc
 * restore step and the display-value builder all read it the same way.
 *
 * ## Whose verdict is trusted
 *
 * - **Browser recalc (Playwright)** — authoritative. It is the very same save
 *   flow an admin runs by hand, with the complete form state, so `trustAll`
 *   is used for its output.
 * - **JSDOM engine at insert time** — only trusted per-param. It can report a
 *   false `___VISIBLE:false` when an `ENABLE` formula references a sibling that
 *   is not (yet) in `formValues` (see the note in services/formEngine/index.js
 *   about SZEROKOSC/SLOPE_TYPE); the parser then returns `#NAME?` → false →
 *   "field disabled". `isVisibilityTrustworthy()` therefore requires every
 *   identifier the `ENABLE` formula reads to be present and non-empty in the
 *   values we fed the engine. Anything else is left untouched and decided later
 *   by the browser step.
 *
 * Prices are never cleared here (`keepPrices`): price params are hidden for
 * plenty of legitimate reasons (HASLO locks, per-client visibility) and their
 * values feed the totals.
 *
 * Escape hatch: `IMPORT_KEEP_HIDDEN_PARAMS=1` disables all clearing (ops switch
 * for the case a group's ENABLE formulas turn out to be wrong).
 */

'use strict';

const VISIBLE_SUFFIX = '___VISIBLE';
const META_SUFFIX_RE = /___(DICT|TITLE|VISIBLE|DESCRIPTION)$/;

/** Formula-parser built-ins — identifiers that are not param references. */
const FORMULA_FUNCTIONS = new Set([
  'AND', 'OR', 'NOT', 'IF', 'TRUE', 'FALSE', 'ORAZ', 'JEZELI', 'NIE',
  'WSROD', 'NIEWSROD', 'WSROD2', 'NIEWSROD2', 'WSROD3', 'NIEWSROD3',
  'WSRODNIEWSROD', 'ZAWIERA', 'LEFT', 'RIGHT', 'FLOOR', 'CEIL', 'CEILING',
  'ZAOKR', 'ROUND', 'ABS', 'SUM', 'HASLO', 'USTAW', 'MIN', 'MAX', 'MIN2',
  'MAX2', 'DOM'
]);

/** Params whose value must never be cleared by name (prices feed the totals). */
const PRICE_NAME_RE = /^(CENA|DOPLATA|SUMA_|WARTOSC_|POW|OPIS_CENY|OPIS_RABATU)/;

const paramDefsCache = new Map();

function visibleKey(paramName) {
  return `${paramName}${VISIBLE_SUFFIX}`;
}

function isMetaKey(key) {
  return typeof key === 'string' && (META_SUFFIX_RE.test(key) || key.endsWith('_ALIAS_DESCRIPTION'));
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** `true` when the form explicitly reported this param as disabled/hidden. */
function isHiddenParam(values, paramName) {
  return !!values && !!paramName && values[visibleKey(paramName)] === false;
}

/** `true` when the form explicitly reported this param as active. */
function isShownParam(values, paramName) {
  return !!values && !!paramName && values[visibleKey(paramName)] === true;
}

/**
 * Name-only price heuristic, shared with displayValueBuilder.isPriceLikeParam
 * (which additionally consults LISTROW/LISTSUM metadata).
 */
function isPriceLikeName(paramName) {
  if (!paramName) return false;
  if (paramName.startsWith('SUB___')) return true;
  if (paramName.endsWith('_S')) return true;
  return PRICE_NAME_RE.test(paramName);
}

/**
 * Identifiers an ENABLE formula reads. String literals are stripped first —
 * otherwise the option list in `NOT(WSROD(MODEL,"AE10,BB24,…"))` would be
 * parsed as dozens of missing param references.
 *
 * @returns {Set<string>}
 */
function enableFormulaRefs(expression) {
  const out = new Set();
  if (!expression || expression === '<NULL>') return out;

  const source = String(expression)
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .toUpperCase();

  const regex = /[A-Z_][A-Z0-9_]*/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (!FORMULA_FUNCTIONS.has(match[0])) out.add(match[0]);
  }
  return out;
}

/**
 * Parse the `NAME`/`DESCRIPTION`/`ENABLE`/`FORMROW`/`LISTROW`/`TYPE`/`SOURCE`
 * columns of a `param.txt`.
 *
 * `SOURCE` is what marks a sub-form ("slope") param: `SOURCE === NAME` means the
 * field is filled from its own catalog under `data/<SOURCE>/` — see
 * `slopeSubform.js` and `public/scripts/formTools/slope.js`.
 *
 * @param {string|null} raw
 * @returns {Map<string, object>|null} null when the file is unreadable/empty.
 */
function parseParamDefinitions(raw) {
  if (!raw) return null;

  const lines = String(raw).split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return null;

  const header = lines[0].split('\t').map((column) => column.trim());
  const nameIdx = header.indexOf('NAME');
  if (nameIdx === -1) return null;

  const columnIdx = {
    DESCRIPTION: header.indexOf('DESCRIPTION'),
    ENABLE: header.indexOf('ENABLE'),
    FORMROW: header.indexOf('FORMROW'),
    LISTROW: header.indexOf('LISTROW'),
    TYPE: header.indexOf('TYPE'),
    SOURCE: header.indexOf('SOURCE')
  };

  const defs = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const name = (cells[nameIdx] || '').trim();
    if (!name) continue;

    const def = { NAME: name };
    for (const [key, idx] of Object.entries(columnIdx)) {
      const cell = idx >= 0 && cells[idx] !== undefined ? String(cells[idx]).trim() : '';
      def[key] = cell === '' || cell === '<NULL>' ? null : cell;
    }
    defs.set(name, def);
  }

  return defs.size ? defs : null;
}

/**
 * Read (and cache) the param definitions of a group in one language.
 *
 * @param {string|number} groupNumber
 * @param {string} lang
 * @param {object} [opts]
 * @param {object} [opts.fileScanner] `readDataFile` provider override (tests; bypasses the cache).
 * @returns {Promise<Map<string, object>|null>}
 */
async function readFormParamDefs(groupNumber, lang, opts = {}) {
  if (!groupNumber) return null;
  const safeLang = lang || 'pl';
  const cacheKey = `${groupNumber}::${safeLang}`;
  const useCache = !opts.fileScanner;
  if (useCache && paramDefsCache.has(cacheKey)) return paramDefsCache.get(cacheKey);

  const scanner = opts.fileScanner || require('../translationDict/fileScanner');
  let raw = null;
  try {
    raw = await scanner.readDataFile(String(groupNumber), safeLang, 'param.txt');
  } catch (_err) {
    raw = null;
  }
  // Groups are only translated into some languages; `param.txt` for the order's
  // language may be missing while `pl` (the canonical set) is always present.
  if (!raw && safeLang !== 'pl') {
    try {
      raw = await scanner.readDataFile(String(groupNumber), 'pl', 'param.txt');
    } catch (_err) {
      raw = null;
    }
  }

  const defs = parseParamDefinitions(raw);
  if (useCache) paramDefsCache.set(cacheKey, defs);
  return defs;
}

/** Test/ops helper — drops the in-memory param.txt cache. */
function clearParamDefsCache() {
  paramDefsCache.clear();
}

/**
 * Is this param's visibility actually decided by an ENABLE formula?
 *
 * ⚠️ `___VISIBLE:false` means two different things in the form, and only one of
 * them is about "this field does not apply to this configuration":
 *
 *   - `ENABLE` evaluated to false  → the field is off for this MODEL etc.; its
 *     value must go (DLUGOSC_STER on MODEL=BB24).
 *   - `FORMROW == '0'`             → the field simply isn't laid out in the form
 *     (`applyParamVisibilityFromFormulas` forces shouldEnable=false for it), yet
 *     it carries real data. Group 71's `OPIS_POZYCJI` — the customer's own
 *     position note, printed on the order — has `ENABLE=<NULL>` and `FORMROW=0`;
 *     clearing it would silently destroy imported content.
 *
 * So a param is only ever cleared when `param.txt` gives it a real ENABLE
 * formula. Without a readable `param.txt` nothing is cleared at all.
 *
 * @param {string} paramName
 * @param {Map<string, object>|null} defs  from `readFormParamDefs`
 */
function isEnableDriven(paramName, defs) {
  if (!defs || !paramName || typeof defs.get !== 'function') return false;
  const def = defs.get(paramName);
  if (!def) return false;
  return enableFormulaRefs(def.ENABLE).size > 0;
}

/**
 * A sub-form ("slope") param — `param.txt` points its `SOURCE` at its own name,
 * so the field is a whole nested form loaded from `data/<NAME>/` (see
 * `slopeSubform.js`).
 *
 * ⚠️ The JSDOM engine **cannot render these at all**: `form.js` builds a
 * `SourceWindow`, whose `init()` fetches the sub-form catalog over HTTP, and in
 * the engine that fetch fails — the `catch` there returns before the field is
 * created. The param then never enters `enabledParams`, so `clearDisabledValues`
 * reports `___VISIBLE:false` and wipes the value for *every* slope position,
 * whatever its ENABLE formula says. Real case: group 43, `MODEL=VS4_L`,
 * `ENABLE = ZAWIERA(MODEL___DESCRIPTION,"SLOPE")` with `MODEL___DESCRIPTION`
 * correctly set to "Slope" — the formula is true, the engine still said false.
 *
 * @param {string} paramName
 * @param {Map<string, object>|null} defs
 */
function isSubformParam(paramName, defs) {
  if (!defs || !paramName || typeof defs.get !== 'function') return false;
  const def = defs.get(paramName);
  return !!(def && def.SOURCE && def.SOURCE === def.NAME);
}

/**
 * Can we believe a `___VISIBLE:false` reported by the JSDOM engine for this
 * param? Only when its ENABLE formula could actually be evaluated: the param is
 * declared in `param.txt`, it has an ENABLE formula, and every identifier that
 * formula reads was supplied with a non-empty value.
 *
 * @param {string} paramName
 * @param {Map<string, object>|null} defs        from `readFormParamDefs`
 * @param {object|null} inputValues              values handed to the engine
 */
function isVisibilityTrustworthy(paramName, defs, inputValues) {
  if (!isEnableDriven(paramName, defs)) return false;

  for (const ref of enableFormulaRefs(defs.get(paramName).ENABLE)) {
    if (!hasValue(inputValues && inputValues[ref])) return false;
  }
  return true;
}

/** Keys wiped together with a disabled param — mirrors `clearDisabledValues`. */
function dependentKeys(paramName) {
  return [
    paramName,
    `${paramName}___DESCRIPTION`,
    `${paramName}_ALIAS`,
    `${paramName}_ALIAS___DESCRIPTION`,
    `${paramName}_ALIAS_DESCRIPTION`
  ];
}

/**
 * Blank every param the form reported as disabled. Mutates `target` in place
 * (and returns it) so callers can keep their existing object identity.
 *
 * @param {object} target                      params to clean (json_parameters shape)
 * @param {object} [opts]
 * @param {object} [opts.visibility]           where the `___VISIBLE` flags come from (default: `target`)
 * @param {Map<string, object>|null} [opts.defs]        param.txt definitions
 * @param {object|null} [opts.inputValues]     values the engine was fed (trust check)
 * @param {boolean} [opts.trustAll]            the verdict comes from the real browser, so skip the
 *                                             "could the formula be evaluated" check — `defs` with a
 *                                             real ENABLE formula is still required
 * @param {boolean} [opts.keepPrices]          never clear price params (default true)
 * @returns {{values: object, cleared: string[]}}
 */
function clearHiddenParams(target, opts = {}) {
  const {
    visibility = target,
    defs = null,
    inputValues = null,
    trustAll = false,
    keepPrices = true
  } = opts;

  const cleared = [];
  if (!target || typeof target !== 'object') return { values: target, cleared };
  if (process.env.IMPORT_KEEP_HIDDEN_PARAMS === '1') return { values: target, cleared };

  const hiddenNames = [];
  for (const key of Object.keys(visibility || {})) {
    if (!key.endsWith(VISIBLE_SUFFIX)) continue;
    if (visibility[key] !== false) continue;
    const name = key.slice(0, -VISIBLE_SUFFIX.length);
    if (name) hiddenNames.push(name);
  }

  for (const name of hiddenNames) {
    if (keepPrices && isPriceLikeName(name)) continue;
    // Only ENABLE formulas may empty a field — never a FORMROW=0 layout flag.
    if (!isEnableDriven(name, defs)) continue;
    // Sub-form params are invisible to the JSDOM engine by construction, so its
    // verdict about them says nothing (see isSubformParam). The browser, which
    // renders them for real, is trusted as usual.
    if (!trustAll && isSubformParam(name, defs)) continue;
    if (!trustAll && !isVisibilityTrustworthy(name, defs, inputValues)) continue;

    target[visibleKey(name)] = false;
    for (const key of dependentKeys(name)) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
      if (!hasValue(target[key])) continue;
      target[key] = '';
      if (key === name) cleared.push(name);
    }
  }

  return { values: target, cleared };
}

module.exports = {
  VISIBLE_SUFFIX,
  visibleKey,
  isMetaKey,
  isHiddenParam,
  isShownParam,
  isPriceLikeName,
  enableFormulaRefs,
  isEnableDriven,
  isSubformParam,
  parseParamDefinitions,
  readFormParamDefs,
  clearParamDefsCache,
  isVisibilityTrustworthy,
  clearHiddenParams
};
