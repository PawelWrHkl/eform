/**
 * `<PARAM>___DESCRIPTION` resolution for imported orders.
 *
 * Every price script reads the price group out of a *description*, not out of
 * the value. `param-CENA-K.js` (TCN, group 71) gates each price-group block with:
 *
 *   AND( NOT(WSROD(MODEL,"AO40L,…")),
 *        IF(KOLOR_ALIAS___DESCRIPTION<>"", zawiera(KOLOR_ALIAS___DESCRIPTION,"#1"),
 *                                          zawiera(KOLOR___DESCRIPTION,"#1")),
 *        zawiera(KOLOR,"W") )
 *
 * Two things follow, and the importer used to get both wrong:
 *
 * 1. **The tag has to be there.** For Duette fabrics the base `paramdict.txt`
 *    (→ `translation_dictionary`) carries no description at all — the price group
 *    lives only in the client's alias collection (`paramdict-KOLOR-ZONNELUX.txt`
 *    → `client_aliases`, matched to the client through
 *    `paramdict_aliases_config`). Order 272115 / group 71 / `KOLOR=6877-W32`:
 *    `translation_dictionary.description = NULL`, `client_aliases.description =
 *    "PG#1"`. Reading only the dictionary left the tag empty and every price
 *    computed as 0 ("Według cennika").
 *
 * 2. **The key has to exist even when empty.** `hot-formula-parser` evaluates
 *    *both* branches of `IF`, so the untaken `zawiera(KOLOR___DESCRIPTION,"#1")`
 *    still resolves `KOLOR___DESCRIPTION`. A missing variable makes the parse
 *    return `#NAME?`, and `evaluateFormula` swallows that into `false`
 *    (public/scripts/formula.js) — the whole gate collapses and, again, the price
 *    is 0. Verified on the real script: identical values, key absent → `CENA: 0`;
 *    key present but empty → `CENA: 108`.
 *
 * A natively created position (order_item 7008) carries one `___DESCRIPTION` and
 * one `_ALIAS___DESCRIPTION` per param — 58 of each in group 71 — because the
 * browser's DataLoader seeds them all. This module reproduces that shape from the
 * DB: `translation_dictionary` first, `client_aliases` (client's collection)
 * second, payload as last resort, empty string as the floor.
 */

'use strict';

const NO_VALUE_SENTINELS = new Set(['<NONE>', '<NULL>']);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** Base params only — skip meta keys, aliases and internals. */
function isBaseParamKey(key) {
  if (!key || key === 'uid') return false;
  if (key.startsWith('_')) return false;
  if (key.includes('___')) return false;
  if (key.endsWith('_ALIAS')) return false;
  if (key.endsWith('_ALIAS_DESCRIPTION')) return false;
  return true;
}

function descriptionKey(paramName) {
  return `${paramName}___DESCRIPTION`;
}

function aliasKey(paramName) {
  return `${paramName}_ALIAS`;
}

function aliasDescriptionKey(paramName) {
  return `${paramName}_ALIAS___DESCRIPTION`;
}

/**
 * Client alias descriptions for one order owner, keyed by param → value.
 *
 * Joins `client_aliases` to `paramdict_aliases_config` so only the collection
 * this client actually uses is returned — the same rule
 * `aliasResolver.loadClientAliases` and the browser's `loadDataPerClient` apply.
 *
 * @param {string|number} groupNumber
 * @param {string} orgIdent    organization.ident, e.g. "HKL"
 * @param {string} userIdent   user.ident, e.g. "TCN"
 * @param {object} [deps]
 * @param {Function} [deps.connect]  connection factory override (tests)
 * @returns {Promise<Map<string, Map<string, {alias: string, description: string}>>>}
 */
async function loadClientDescriptions(groupNumber, orgIdent, userIdent, deps = {}) {
  const result = new Map();
  if (!groupNumber || !orgIdent || !userIdent) return result;

  const connect = deps.connect || require('../../db/core').connetToDb;
  const conn = await connect();
  try {
    const [rows] = await conn.query(
      `SELECT ca.parameter, ca.value_col, ca.alias, ca.description
         FROM client_aliases ca
         JOIN paramdict_aliases_config pac
           ON pac.group_number = ca.group_number
          AND pac.parameter = ca.parameter
          AND UPPER(pac.collection) = UPPER(ca.collection)
        WHERE ca.group_number = ?
          AND UPPER(pac.org_ident) = UPPER(?)
          AND UPPER(pac.user_ident) = UPPER(?)`,
      [String(groupNumber), orgIdent, userIdent]
    );

    for (const row of rows || []) {
      if (!row.parameter || row.value_col === null || row.value_col === undefined) continue;
      if (!result.has(row.parameter)) result.set(row.parameter, new Map());
      result.get(row.parameter).set(String(row.value_col), {
        alias: row.alias || '',
        description: row.description || ''
      });
    }
    return result;
  } finally {
    await conn.end();
  }
}

function lookupClientEntry(clientDescriptions, paramName, value) {
  if (!clientDescriptions || typeof clientDescriptions.get !== 'function') return null;
  const byValue = clientDescriptions.get(paramName);
  if (!byValue) return null;
  return byValue.get(String(value)) || null;
}

function lookupDictDescription(paramdict, paramName, value) {
  const byValue = paramdict && paramdict[paramName];
  if (!byValue) return '';
  const desc = byValue[String(value)];
  return hasValue(desc) ? String(desc) : '';
}

/**
 * Seed `<PARAM>___DESCRIPTION`, `<PARAM>_ALIAS` and `<PARAM>_ALIAS___DESCRIPTION`
 * for every param that carries a value, then guarantee the description keys exist
 * for every param the form declares.
 *
 * Never overwrites a description that is already filled.
 *
 * @param {object} values                     Mutated in place.
 * @param {object} [opts]
 * @param {object} [opts.paramdict]           `translation_dictionary` paramdict: `{param: {value: description}}`.
 * @param {Map} [opts.clientDescriptions]     Output of `loadClientDescriptions`.
 * @param {Map<string, object>|null} [opts.paramDefs]  `param.txt` definitions (which keys to guarantee).
 * @param {object} [opts.sourceValues]        Raw payload params — last-resort source of an alias description.
 * @param {boolean} [opts.ensureKeys=true]    Also create the empty description keys.
 * @returns {{values: object, seeded: string[]}}  `seeded` lists `PARAM=source` for logging.
 */
function seedParamDescriptions(values, opts = {}) {
  const {
    paramdict = null,
    clientDescriptions = null,
    paramDefs = null,
    sourceValues = null,
    ensureKeys = true
  } = opts;

  const seeded = [];
  if (!values || typeof values !== 'object') return { values, seeded };

  for (const key of Object.keys(values)) {
    if (!isBaseParamKey(key)) continue;

    const rawValue = values[key];
    if (!hasValue(rawValue)) continue;
    if (typeof rawValue === 'object') continue;
    if (NO_VALUE_SENTINELS.has(String(rawValue))) continue;

    const dictDesc = lookupDictDescription(paramdict, key, rawValue);
    const client = lookupClientEntry(clientDescriptions, key, rawValue);
    const payloadAliasDesc = sourceValues
      ? (sourceValues[`${key}_ALIAS_DESCRIPTION`] || sourceValues[aliasDescriptionKey(key)])
      : '';

    // 1. Base description — the fallback branch of every price-group gate.
    if (!hasValue(values[descriptionKey(key)])) {
      if (dictDesc) {
        values[descriptionKey(key)] = dictDesc;
        seeded.push(`${key}=translation_dictionary`);
      } else if (client && hasValue(client.description)) {
        values[descriptionKey(key)] = client.description;
        seeded.push(`${key}=client_aliases`);
      }
    }

    // 2. Client alias — what the customer's own price list calls this value.
    if (!hasValue(values[aliasKey(key)]) && client && hasValue(client.alias)) {
      values[aliasKey(key)] = client.alias;
    }

    // 3. Alias description — the branch the gates prefer when it is non-empty.
    if (!hasValue(values[aliasDescriptionKey(key)])) {
      const aliasDesc = (client && hasValue(client.description))
        ? client.description
        : (hasValue(payloadAliasDesc) ? String(payloadAliasDesc) : values[descriptionKey(key)]);
      if (hasValue(aliasDesc)) values[aliasDescriptionKey(key)] = aliasDesc;
    }
  }

  if (ensureKeys) ensureDescriptionKeys(values, paramDefs);
  return { values, seeded };
}

/**
 * Make sure `<PARAM>___DESCRIPTION` / `<PARAM>_ALIAS___DESCRIPTION` exist (empty
 * is fine) for every param of the form, so no formula can hit `#NAME?` on the
 * untaken branch of an `IF`. Mirrors the shape of a natively created position.
 *
 * @param {object} values                              Mutated in place.
 * @param {Map<string, object>|null} paramDefs          `param.txt` definitions.
 * @returns {object} the same `values`.
 */
function ensureDescriptionKeys(values, paramDefs) {
  if (!values || typeof values !== 'object') return values;

  const names = new Set();
  if (paramDefs && typeof paramDefs.keys === 'function') {
    for (const name of paramDefs.keys()) names.add(name);
  }
  // Even without param.txt, cover every param present in the values.
  for (const key of Object.keys(values)) {
    if (isBaseParamKey(key)) names.add(key);
  }

  for (const name of names) {
    if (values[descriptionKey(name)] === undefined) values[descriptionKey(name)] = '';
    if (values[aliasDescriptionKey(name)] === undefined) values[aliasDescriptionKey(name)] = '';
  }
  return values;
}

module.exports = {
  loadClientDescriptions,
  seedParamDescriptions,
  ensureDescriptionKeys,
  _internals: { isBaseParamKey, lookupClientEntry, lookupDictDescription }
};
