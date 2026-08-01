/**
 * Resolves "twin" parameters — two (or more) params in the same group that mean
 * the same physical field but differ in how they are filled: one is a dictionary
 * select (has paramdict options), the other(s) are free inputs.
 *
 * Real-world case (group 39, lang nl):
 *
 *   DLUGOSC_STER  "BEDIENINGSLENGTE [MM]"  select  → EC100, KG150, KO200, …
 *   DLUGSTER      "BEDIENINGSLENGTE [MM]"  input   → free numeric (mm)
 *
 * Which of the two is active depends on MODEL (the ENABLE formula in param.txt),
 * but a sending system does not evaluate those formulas — it writes the same
 * value into *both* keys. The raw length ("900") is then rejected by
 * `optionValidator` for the select twin, even though the value is perfectly
 * valid for the input twin. The import failed with:
 *
 *   Parameter "DLUGOSC_STER": value "900" not found in available options
 *
 * Rule implemented here (runs BEFORE option validation):
 *   When a select twin holds a value that is not one of its options, the value
 *   belongs to the input twin → put it there (if the input is empty) and clear
 *   the select, so validation no longer trips. The reverse also holds: a
 *   dictionary key sitting in the input twin while the select is empty is moved
 *   into the select.
 *
 * Twins are discovered from `translation_dictionary` (same group + lang +
 * identical description), so no per-group hardcoding is needed. Only sets with
 * exactly one select twin are touched — anything else is left alone.
 *
 * ⚠️ "Has no options in the dictionary" alone does NOT make a param an input:
 * group 20 declares `RODZAJ_DACH_VALUE` in `paramdict.txt` but currently ships
 * zero option rows for it, and it shares its description with `MODEL`. Treating
 * it as an input twin would move a genuinely invalid MODEL value into it and
 * import a model-less order instead of rejecting bad data. So a twin counts as
 * a free input only when `paramdict.txt` declares no `<PARAM>_VALUE` column for
 * it at all (group 39: `DLUGSTER` — no column; `DLUGOSC_STER` — 31 options).
 * When that header cannot be read we skip the fix rather than guess, keeping the
 * pre-existing "reject the order" behaviour.
 *
 * Pure data-in / data-out apart from the dictionary + paramdict-header reads;
 * inject `repo`/`dict`/`declaredDictParams` in tests.
 */

'use strict';

function getDefaultRepo() {
  return require('../translationDict/dbRepository');
}

function getDefaultFileScanner() {
  return require('../translationDict/fileScanner');
}

/**
 * Param names that `paramdict.txt` declares an option column for — whether or
 * not any row currently carries a value.
 *
 * @returns {Promise<Set<string>|null>} null when the header is unreadable.
 */
async function readDeclaredDictParams(groupNumber, lang, scanner) {
  let raw;
  try {
    raw = await scanner.readDataFile(String(groupNumber), lang, 'paramdict.txt');
  } catch (_err) {
    return null;
  }
  if (!raw) return null;

  const header = String(raw).split(/\r?\n/)[0];
  if (!header) return null;

  const declared = new Set();
  for (const column of header.split('\t')) {
    const match = /^(.+)_VALUE$/.exec(column.trim());
    if (match) declared.add(match[1]);
  }
  return declared.size ? declared : null;
}

function normalizeDescription(desc) {
  return String(desc || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isEmptyValue(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Group param names by their (normalized) description.
 * @returns {Map<string, string[]>}
 */
function groupParamsByDescription(params) {
  const byDesc = new Map();
  for (const [paramName, description] of Object.entries(params || {})) {
    const key = normalizeDescription(description);
    if (!key) continue;
    if (!byDesc.has(key)) byDesc.set(key, []);
    byDesc.get(key).push(paramName);
  }
  return byDesc;
}

function sharedPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * When several empty input twins compete for the value, prefer the one whose
 * name is closest to the select's (DLUGOSC_STER → DLUGSTER, not STEROWANIE).
 * Deterministic: longest shared prefix, then alphabetical.
 */
function pickInputTwin(inputNames, selectName) {
  return [...inputNames].sort((a, b) => {
    const diff = sharedPrefixLength(b, selectName) - sharedPrefixLength(a, selectName);
    return diff !== 0 ? diff : a.localeCompare(b);
  })[0];
}

function clearParam(parameters, paramName) {
  parameters[paramName] = '';
  const descKey = `${paramName}___DESCRIPTION`;
  if (Object.prototype.hasOwnProperty.call(parameters, descKey)) {
    parameters[descKey] = '';
  }
}

/**
 * @param {string} groupNumber      asortment_group_number (e.g. "39").
 * @param {object} parameters       Canonical params (post `parameterTranslator`).
 * @param {string} lang             Language code of the dictionary to read.
 * @param {object} [opts]
 * @param {object} [opts.repo]      Repository override (tests).
 * @param {object} [opts.dict]      Pre-fetched `{ params, paramdict }` (skips the read).
 * @param {object} [opts.fileScanner]          `readDataFile` provider override (tests).
 * @param {Set<string>} [opts.declaredDictParams]  Pre-resolved paramdict columns (tests).
 * @returns {Promise<{parameters: object, notes: string[]}>}
 */
async function resolveTwinParameters(groupNumber, parameters, lang, opts = {}) {
  if (!parameters || typeof parameters !== 'object') return { parameters, notes: [] };

  const result = { ...parameters };
  const notes = [];

  let dict = opts.dict;
  if (!dict) {
    const repo = opts.repo || getDefaultRepo();
    try {
      dict = await repo.getGroupTranslations(groupNumber, lang || 'pl');
    } catch (_err) {
      return { parameters: result, notes };
    }
  }
  if (!dict || !dict.params) return { parameters: result, notes };

  const paramdict = dict.paramdict || {};
  const hasOptions = (name) => Object.keys(paramdict[name] || {}).length > 0;

  // Candidate twin sets first — the paramdict header is only read when a group
  // actually has same-description params worth resolving.
  const twinSets = [...groupParamsByDescription(dict.params).values()]
    .filter((twinNames) => twinNames.length >= 2 && twinNames.some(hasOptions));
  if (!twinSets.length) return { parameters: result, notes };

  let declaredDictParams = opts.declaredDictParams;
  if (!declaredDictParams) {
    const scanner = opts.fileScanner || getDefaultFileScanner();
    declaredDictParams = await readDeclaredDictParams(groupNumber, lang || 'pl', scanner);
  }
  // Without the header we cannot tell a free input from an option-less select —
  // leave everything to the option validator, as before this module existed.
  if (!declaredDictParams) return { parameters: result, notes };

  const isFreeInput = (name) => !hasOptions(name) && !declaredDictParams.has(name);

  for (const twinNames of twinSets) {
    const selects = twinNames.filter((name) => !isFreeInput(name));
    const inputs = twinNames.filter(isFreeInput);
    // Only the unambiguous shape "one select + at least one input" is safe to fix.
    if (selects.length !== 1 || inputs.length === 0) continue;
    if (!hasOptions(selects[0])) continue;   // nothing to validate against

    const selectName = selects[0];
    const selectValue = result[selectName];
    const options = new Set(Object.keys(paramdict[selectName] || {}));

    if (!isEmptyValue(selectValue)) {
      if (options.has(String(selectValue).trim())) continue;   // valid selection, nothing to do

      const filledInputs = inputs.filter((name) => !isEmptyValue(result[name]));
      if (filledInputs.length) {
        // The input twin already carries the value (senders usually write both),
        // so dropping the invalid selection loses nothing.
        clearParam(result, selectName);
        notes.push(
          `group ${groupNumber}: "${selectName}"="${selectValue}" is not a valid option; `
          + `value kept in input twin(s) ${filledInputs.map((n) => `"${n}"="${result[n]}"`).join(', ')} `
          + `and "${selectName}" cleared`
        );
      } else {
        const target = pickInputTwin(inputs, selectName);
        result[target] = selectValue;
        clearParam(result, selectName);
        notes.push(
          `group ${groupNumber}: "${selectName}"="${selectValue}" is not a valid option; `
          + `moved to input twin "${target}" and "${selectName}" cleared`
        );
      }
      continue;
    }

    // Reverse direction: a dictionary key ended up in the free input while the
    // select is empty — only acted on when it matches an option key exactly.
    const misplaced = inputs.find(
      (name) => !isEmptyValue(result[name]) && options.has(String(result[name]).trim())
    );
    if (misplaced) {
      result[selectName] = String(result[misplaced]).trim();
      notes.push(
        `group ${groupNumber}: "${misplaced}"="${result[misplaced]}" is an option of the empty `
        + `select twin "${selectName}"; copied into "${selectName}"`
      );
    }
  }

  return { parameters: result, notes };
}

module.exports = {
  resolveTwinParameters,
  normalizeDescription,
  pickInputTwin
};
