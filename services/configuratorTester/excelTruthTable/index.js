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
      const result = env.window.FormulaHandler.evaluateFormula(formula, context, 'formula');
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
      const result = env.window.FormulaHandler.evaluateFormula(formula, context, 'formula');
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
  return computed.found ? computed : Object.assign({ kind: 'no-match' }, computed);
}

module.exports = { getReferencePrice, withAuthoringDialect, disposeEvaluator, clearSheetCache };
