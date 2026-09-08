/**
 * Public API of the Excel truth table: "what SHOULD this configuration cost,
 * according to the authoring workbook in /mnt/eformconf?"
 *
 * This is the independent reference the PDF brief asks for. It reads the source
 * spreadsheet the price lists are authored in, and deliberately does NOT read
 * the generated `param-*.js` the portal runs — so a mismatch means the built
 * price scripts drifted from the workbook (stale build, bad generation, or
 * unpublished edits), which is exactly the class of error that otherwise only
 * shows up as money lost on real orders.
 *
 * Verified against the live engine on 47 real orders across groups 71 and 43
 * (7 different client price-list variants, with and without multipliers):
 * 47/47 identical to the cent.
 */

'use strict';

const formEngine = require('../../formEngine');
const { parsePriceSheet } = require('./excelParser');
const { resolvePriceVariant, constantFromVariant, parseVariantToken } = require('./priceVariant');
const { computePrice } = require('./truthTableLookup');

// Excel/DSL function names and literals that look like param names but are not.
const FORMULA_KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IF', 'IFS', 'WSROD', 'ZAWIERA', 'HASLO', 'USTAW', 'ROUND',
  'ROUNDUP', 'ROUNDDOWN', 'MIN', 'MAX', 'SUM', 'ABS', 'INT', 'TRUE', 'FALSE',
  'NULL', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TEXT', 'VALUE', 'CONCATENATE'
]);

/**
 * The workbook's formulas use the authoring dialect (`KOLOR_ALIAS_OPIS`,
 * `..._TYTUL`) while the engine's values use `___DESCRIPTION`/`___TITLE`. The
 * script generator rewrites one into the other; expose both spellings so the
 * same formula text evaluates identically here.
 */
function withAuthoringDialect(values) {
  const context = Object.assign({}, values);
  for (const [key, value] of Object.entries(values)) {
    if (key.endsWith('___DESCRIPTION')) context[key.replace(/___DESCRIPTION$/, '_OPIS')] = value;
    if (key.endsWith('___TITLE')) context[key.replace(/___TITLE$/, '_TYTUL')] = value;
  }
  return context;
}

// Cache scoped to ONE group at a time, on purpose. A parsed sheet keeps its
// exceljs worksheet alive through the `valueAt`/`formulaAt` closures, and these
// workbooks are 7 MB+ on disk / hundreds of MB parsed. Caching across groups
// made a full sweep die with "heap limit Allocation failed" after the very
// first group, so switching groups drops everything held for the previous one.
const sheetCache = new Map();
let cachedGroup = null;

async function getSheet(groupNumber, paramName) {
  if (cachedGroup !== groupNumber) {
    sheetCache.clear();
    cachedGroup = groupNumber;
  }
  if (!sheetCache.has(paramName)) sheetCache.set(paramName, await parsePriceSheet(groupNumber, paramName));
  return sheetCache.get(paramName);
}

/** Drop every parsed workbook held in memory (called between groups by index.js). */
function clearSheetCache() {
  sheetCache.clear();
  cachedGroup = null;
}

// ONE long-lived JSDOM for formula evaluation, not one per lookup: the engine's
// windows run their own async work, so disposing one mid-run while another
// engine call is in flight left `document` undefined inside the bundle and took
// the whole process down. We only need window.FormulaHandler here, which is
// stateless with respect to the form, so a single shared realm is also cheaper.
let evaluatorEnv = null;
let evaluatorLang = null;

async function getEvaluator(lang) {
  if (evaluatorEnv && evaluatorLang === lang) return evaluatorEnv;
  if (evaluatorEnv) {
    evaluatorEnv.dispose();
    evaluatorEnv = null;
  }
  evaluatorEnv = await formEngine.bootEngine({ lang });
  evaluatorLang = lang;
  return evaluatorEnv;
}

/** Release the shared formula-evaluation realm (call once a run is finished). */
function disposeEvaluator() {
  if (!evaluatorEnv) return;
  evaluatorEnv.dispose();
  evaluatorEnv = null;
  evaluatorLang = null;
}

// Variables the formula handler and the parser set up themselves, and which a
// context must therefore never blank out.
const RESERVED_IDENTIFIERS = new Set(['TRUE', 'FALSE', 'NULL', 'MIN', 'MAX', 'MIN2', 'MAX2', 'DOM', 'UID']);

/**
 * Neutralise variables left over from a previous evaluation.
 *
 * `public/scripts/formula.js` evaluates against a MODULE-LEVEL parser and only
 * ever calls `parser.setVariable()` for the keys of the context it is given —
 * it never clears the rest. With one long-lived evaluator realm (getEvaluator)
 * that makes values leak between positions: group 73's #6376 has no
 * `SZEROKOSC_POTRZEBNA` at all, so its `Os-x` formula `SZEROKOSC_POTRZEBNA/10`
 * resolved against a value left behind by an earlier position, priced the
 * workbook at a coordinate the deployed script never used, and produced five
 * P1 "CENA_ZANIZONA" that vanish when the same position is checked on its own.
 *
 * The fix uses nothing but the public function: every identifier the formula
 * mentions is added to the context, `undefined` when we genuinely do not have
 * it. `setVariable(key, undefined)` makes the parser report `#NAME?`, which
 * `sectionAxes` already treats as "coordinate unknown" — the honest answer.
 */
function withDeclaredIdentifiers(context, formula) {
  const declared = context;
  for (const match of String(formula || '').matchAll(/\b([A-Z][A-Z0-9_]{1,})\b/g)) {
    const name = match[1];
    if (FORMULA_KEYWORDS.has(name) || RESERVED_IDENTIFIERS.has(name)) continue;
    if (!(name in declared)) declared[name] = undefined;
  }
  return declared;
}

/**
 * Reference price for one configuration.
 *
 * @param {object} opts
 * @param {string} opts.groupNumber
 * @param {string} [opts.lang]
 * @param {string} opts.orgIdent   order owner's organization.ident
 * @param {string} opts.userIdent  order owner's user.ident
 * @param {string} [opts.paramName] price param to reference (default CENA)
 * @param {object} opts.values     the configuration (engine-shaped values)
 * @returns {Promise<{found:true, price:number, ...}|{found:false, reason:string}>}
 */
async function getReferencePrice({ groupNumber, lang = 'pl', orgIdent, userIdent, paramName = 'CENA', values, scriptsField }) {
  // param.txt's SCRIPTS column wins unless it literally says 'true', which is
  // the marker for "use the client's prod.txt mapping" — verified against
  // dataLoader.selectPrices(). Getting this backwards made group 75 read block
  // K (all zeros for that section) while the engine priced from block A.
  const variantForConstant = parseVariantToken(scriptsField)
    || resolvePriceVariant({ groupNumber, lang, orgIdent, userIdent, paramName });
  const constant = constantFromVariant(variantForConstant);
  if (constant !== null) {
    // Flat per-client value (discounts): no table lookup, the constant IS the
    // reference — see priceVariant.constantFromVariant().
    return { found: true, price: constant, constant: true, derived: false, letter: variantForConstant.letter, multiplier: 1, contributions: [] };
  }

  const widthMm = parseInt(values.SZEROKOSC, 10);
  const heightMm = parseInt(values.WYSOKOSC, 10);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)) {
    return { found: false, kind: 'no-dimensions', reason: 'konfiguracja bez SZEROKOSC/WYSOKOSC — cennik jest indeksowany wymiarami' };
  }

  // SUB___ params (client/list prices) are priced from the SAME sheet as their
  // base param — only the client's block letter differs. Verified against
  // param-SUB___CENA-J.js: identical section labels, conditions and axes as
  // param-CENA-*.js.
  const sheetName = paramName.replace(/^SUB___/, '');
  const sheet = await getSheet(groupNumber, sheetName);
  // `kind: 'no-sheet'` means this group simply does not price that param in its
  // workbook — a fact about the configuration, not a per-position problem, so
  // callers skip it silently instead of repeating it for every order.
  if (!sheet.ok) return { found: false, kind: 'no-sheet', reason: sheet.reason };

  const variant = variantForConstant;
  if (!variant) {
    return { found: false, kind: 'no-variant', reason: `brak wariantu cennika (${paramName}) dla klienta ${orgIdent}/${userIdent} w prod.txt` };
  }

  // Section conditions are evaluated by the engine's OWN formula evaluator, so
  // WSROD/ZAWIERA/alias semantics cannot drift from the real thing.
  const env = await getEvaluator(lang);
  const context = withAuthoringDialect(values);
  const evaluateCondition = (formula) => {
    try {
      const result = env.window.FormulaHandler.evaluateFormula(
        formula, withDeclaredIdentifiers(context, formula), 'formula'
      );
      return result === true || result === 1 || result === '1';
    } catch (_err) {
      return false;
    }
  };

  // Some surcharge cells are defined relatively (e.g. `ROUND(CENA*0.1,2)`),
  // exactly as the generated scripts evaluate them. Note the mild circularity:
  // such a formula reads CENA out of the configuration, i.e. the engine's own
  // base price — acceptable because CENA itself is verified against the
  // workbook by its own check, so a wrong base surfaces there rather than
  // hiding here.
  const evaluateNumber = (formula) => {
    try {
      const result = env.window.FormulaHandler.evaluateFormula(
        formula, withDeclaredIdentifiers(context, formula), 'formula'
      );
      return parseFloat(result);
    } catch (_err) {
      return NaN;
    }
  };

  const computed = computePrice({
    sheet,
    letter: variant.letter,
    multiplier: variant.multiplier,
    widthMm,
    heightMm,
    evaluateCondition,
    evaluateNumber
  });
  // computePrice's own kind (e.g. 'unknown-axis') wins — Object.assign order
  // matters here, it must not be flattened into a plain 'no-match'.
  return computed.found ? computed : Object.assign({ kind: 'no-match' }, computed);
}

/**
 * The dimension grid the price list itself defines for ONE configuration —
 * i.e. which widths and heights it actually has prices for.
 *
 * This is the independent MIN/MAX source the boundary tests always lacked.
 * `window.inputsValidators` was the original plan, but it was verified empty
 * for SZEROKOSC/WYSOKOSC even after three cascades, so the engine cannot be
 * asked what the legal range is. The workbook can: the section's width scale
 * and height axis ARE the range, per model family and colour price group.
 *
 * Union across every section that applies, because a configuration legitimately
 * sums several (a two-fabric product matches its section twice) and a price
 * exists wherever any of them covers the point.
 *
 * @returns {Promise<{ok:true, widthsCm:number[], heightsCm:number[], letter:string, sections:string[]}
 *   |{ok:false, reason:string, kind?:string}>}
 */
async function getDimensionGrid({ groupNumber, lang = 'pl', orgIdent, userIdent, paramName = 'CENA', values, scriptsField }) {
  const variant = parseVariantToken(scriptsField)
    || resolvePriceVariant({ groupNumber, lang, orgIdent, userIdent, paramName });
  if (!variant) {
    return { ok: false, kind: 'no-variant', reason: `brak wariantu cennika (${paramName}) dla klienta ${orgIdent}/${userIdent}` };
  }
  if (constantFromVariant(variant) !== null) {
    return { ok: false, kind: 'constant', reason: `${paramName} to stała z nazwy skryptu, nie tabela wymiarów` };
  }

  const sheet = await getSheet(groupNumber, paramName.replace(/^SUB___/, ''));
  if (!sheet.ok) return { ok: false, kind: 'no-sheet', reason: sheet.reason };

  const block = sheet.blocks.find((b) => b.letter === variant.letter);
  if (!block) return { ok: false, kind: 'no-block', reason: `arkusz nie ma bloku ${variant.letter}` };

  const env = await getEvaluator(lang);
  const context = withAuthoringDialect(values);
  const matches = (formula) => {
    try {
      const result = env.window.FormulaHandler.evaluateFormula(
        formula, withDeclaredIdentifiers(context, formula), 'formula'
      );
      return result === true || result === 1 || result === '1';
    } catch (_err) {
      return false;
    }
  };

  const widths = new Set();
  const heights = new Set();
  const sections = [];
  const axisVars = { x: new Set(), y: new Set() };
  // Which params the section gates actually read. Sweeping any other field
  // cannot change which cell is looked up, so this is what makes an option
  // sweep targeted instead of a guess (`WSROD(MODEL,…)`,
  // `ZAWIERA(KOLOR_OPIS,"#2")` → MODEL, KOLOR).
  const conditionParams = new Set();
  const collectParams = (formula) => {
    for (const match of String(formula || '').matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      const name = match[1];
      if (FORMULA_KEYWORDS.has(name)) continue;
      // The gates read the description mirrors; the field itself is what a
      // sweep can set, so map them back.
      conditionParams.add(name.replace(/(_ALIAS)?(_OPIS|___DESCRIPTION|_TYTUL|___TITLE)$/, ''));
    }
  };

  for (const section of sheet.sections) {
    if (!section.conditions.length) continue;
    if (!section.conditions.some(matches)) continue;
    for (const condition of section.conditions) collectParams(condition);

    const shape = (section.shapeByBlock && section.shapeByBlock[variant.letter]) || null;
    // A scalar section has no dimension grid to contribute — it is a flat
    // surcharge, priced the same at every size.
    if (!shape || shape.kind === 'scalar') continue;

    sections.push(section.label);
    for (const w of shape.widths || []) widths.add(w.widthCm);
    for (const h of shape.heightRows || []) heights.add(h.heightCm);

    // Which VALUE moves the lookup along each axis. Usually SZEROKOSC/WYSOKOSC,
    // but not always: group 73's CENA sheet is indexed by
    // `SZEROKOSC_POTRZEBNA/10`, so changing SZEROKOSC alone leaves the lookup
    // on the same cell. A caller sweeping the table has to know which param to
    // move.
    const axisVar = (formula) => {
      const m = /^\s*([A-Z0-9_]+)\s*\/\s*10\s*$/.exec(String(formula || ''));
      return m ? m[1] : null;
    };
    const xVar = axisVar(section.axisX);
    const yVar = axisVar(section.axisY);
    if (xVar) axisVars.x.add(xVar);
    if (yVar) axisVars.y.add(yVar);
  }

  if (!widths.size) {
    return { ok: false, kind: 'no-grid', reason: 'żadna pasująca sekcja cennika nie ma tabeli wymiarów dla tej konfiguracji' };
  }

  const asc = (a, b) => a - b;
  return {
    ok: true,
    letter: variant.letter,
    sections,
    widthsCm: [...widths].sort(asc),
    // grid1d sections price by width alone; then there is no height grid and
    // the caller must not invent one.
    heightsCm: [...heights].sort(asc),
    // Only when every matching section agrees on the axis variable — a mixed
    // answer would mean one value cannot move all of them and the caller must
    // not pretend otherwise. Defaults to the plain dimension.
    widthParam: axisVars.x.size === 1 ? [...axisVars.x][0] : 'SZEROKOSC',
    heightParam: axisVars.y.size === 1 ? [...axisVars.y][0] : 'WYSOKOSC',
    axisAmbiguous: axisVars.x.size > 1 || axisVars.y.size > 1,
    conditionParams: [...conditionParams]
  };
}

module.exports = { getReferencePrice, getDimensionGrid, withAuthoringDialect, withDeclaredIdentifiers, getEvaluator, disposeEvaluator, clearSheetCache };
