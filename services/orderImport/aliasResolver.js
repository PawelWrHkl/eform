/**
 * Alias Resolver for Order Import
 *
 * 3-level validation for each parameter value:
 *   1. product_group — is the group_number valid?
 *   2. translation_dictionary (value_key) — is this a known canonical value for this param+group?
 *   3. client_aliases — is this an alias that maps to a real value?
 *      Uses paramdict_aliases_config to determine which collection to search.
 *
 * IMPORTANT: Only parameters that have entries in translation_dictionary (paramdict)
 * or client_aliases are validated. Parameters without any dictionary entries are
 * free-form (numeric, calculated, descriptions) and are skipped automatically.
 */

'use strict';

const { connetToDb } = require('../../db/core');
const { log } = require('../../utils/logging');
const translationDict = require('../translationDict');

// ─── Data loaders ────────────────────────────────────────────────────────────

async function loadTranslationDictValues(groupNumber) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      `SELECT param_name, value_key FROM translation_dictionary
       WHERE group_number = ? AND source_type = 'paramdict'`,
      [groupNumber]
    );
    const paramValueSet = new Set();
    const dictParams = new Set();
    for (const r of rows) {
      paramValueSet.add(`${r.param_name}::${r.value_key}`);
      dictParams.add(r.param_name);
    }
    return { paramValueSet, dictParams };
  } finally {
    await conn.end();
  }
}

/**
 * Load client_aliases filtered by the client's collection config.
 * @param {string} groupNumber
 * @param {Map<string, string>} paramCollectionMap - parameter → collection for this client
 */
async function loadClientAliases(groupNumber, paramCollectionMap) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      'SELECT value_col, alias, description, parameter, collection FROM client_aliases WHERE group_number = ?',
      [groupNumber]
    );
    const aliasMap = new Map();
    const valueSet = new Set();
    const aliasParams = new Set();

    for (const r of rows) {
      // If we have a collection config for this param, only use aliases from that collection
      const clientCollection = paramCollectionMap.get(r.parameter);
      if (clientCollection && r.collection.toUpperCase() !== clientCollection.toUpperCase()) {
        continue;
      }

      valueSet.add(`${r.parameter}::${r.value_col}`);
      aliasParams.add(r.parameter);
      if (r.alias) {
        aliasMap.set(`${r.parameter}::${r.alias}`, r);
      }
    }
    return { aliasMap, valueSet, aliasParams };
  } finally {
    await conn.end();
  }
}

/**
 * Load the paramdict_aliases_config for a specific org/user/group.
 * Returns Map<parameter, collection>
 */
async function loadParamCollectionConfig(groupNumber, orgIdent, userIdent) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      `SELECT parameter, collection FROM paramdict_aliases_config
       WHERE group_number = ? AND UPPER(org_ident) = UPPER(?) AND UPPER(user_ident) = UPPER(?)`,
      [groupNumber, orgIdent, userIdent]
    );
    const map = new Map();
    for (const r of rows) {
      map.set(r.parameter, r.collection);
    }
    return map;
  } finally {
    await conn.end();
  }
}

/**
 * Resolve orgIdent and userIdent from the payload's userIdent field.
 */
async function resolveUserOrg(userIdent) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      `SELECT u.ident AS userIdent, o.ident AS orgIdent
       FROM user u
       JOIN organization o ON o.id = u.organization_id
       WHERE u.ident = ?`,
      [userIdent]
    );
    return rows.length > 0 ? rows[0] : null;
  } finally {
    await conn.end();
  }
}

async function isValidProductGroup(groupNumber) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      'SELECT 1 FROM product_group WHERE group_number = ? LIMIT 1',
      [groupNumber]
    );
    return rows.length > 0;
  } finally {
    await conn.end();
  }
}

// ─── Skip logic ──────────────────────────────────────────────────────────────

const SKIP_SUFFIXES = ['_ALIAS', '_ALIAS_DESCRIPTION', '___DICT', '___TITLE', '___VISIBLE', '___DESCRIPTION'];

function shouldSkipParam(paramName) {
  if (!paramName) return true;
  if (paramName.startsWith('_')) return true;
  if (paramName === 'uid') return true;
  for (const suffix of SKIP_SUFFIXES) {
    if (paramName.endsWith(suffix)) return true;
  }
  return false;
}

// ─── Main resolver ───────────────────────────────────────────────────────────

async function resolveItemAliases(parameters, groupNumber, paramCollectionMap) {
  if (!parameters || typeof parameters !== 'object') {
    return { resolved: {}, errors: [] };
  }

  const groupValid = await isValidProductGroup(groupNumber);
  if (!groupValid) {
    return {
      resolved: { ...parameters },
      errors: [`Grupa produktowa "${groupNumber}" nie istnieje w product_group`]
    };
  }

  const { paramValueSet, dictParams } = await loadTranslationDictValues(groupNumber);
  const { aliasMap, valueSet: clientAliasValues, aliasParams } = await loadClientAliases(groupNumber, paramCollectionMap);

  const validatableParams = new Set([...dictParams, ...aliasParams]);

  const resolved = {};
  const errors = [];

  for (const [paramName, rawValue] of Object.entries(parameters)) {
    // Don't overwrite _ALIAS/_ALIAS_DESCRIPTION already set by resolver
    if ((paramName.endsWith('_ALIAS') || paramName.endsWith('_ALIAS_DESCRIPTION')) && resolved[paramName] !== undefined) {
      continue;
    }

    resolved[paramName] = rawValue;

    if (shouldSkipParam(paramName)) continue;
    if (!validatableParams.has(paramName)) continue;

    if (rawValue === null || rawValue === undefined || rawValue === '') continue;
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean' || typeof rawValue === 'object') continue;

    const strValue = String(rawValue);
    if (strValue === '<NONE>' || strValue === '<NULL>') continue;

    // Handle multi-value fields (pipe-separated)
    const valueParts = strValue.includes('|') ? strValue.split('|') : [strValue];
    let allPartsValid = true;

    for (const part of valueParts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (paramValueSet.has(`${paramName}::${trimmed}`)) continue;
      if (clientAliasValues.has(`${paramName}::${trimmed}`)) continue;

      const aliasEntry = aliasMap.get(`${paramName}::${trimmed}`);
      if (aliasEntry) continue;

      allPartsValid = false;
      errors.push(`Parametr "${paramName}": wartość "${trimmed}" nie znaleziona w translation_dictionary ani client_aliases (grupa ${groupNumber})`);
    }

    // Single-value alias resolution
    if (!strValue.includes('|') && allPartsValid) {
      const aliasEntry = aliasMap.get(`${paramName}::${strValue}`);
      if (aliasEntry) {
        resolved[paramName] = aliasEntry.value_col;
        resolved[`${paramName}_ALIAS`] = aliasEntry.alias;
        resolved[`${paramName}_ALIAS_DESCRIPTION`] = aliasEntry.description || '';
      }
    }
  }

  return { resolved, errors };
}

/**
 * @param {object} [deps]  Test overrides: `resolveItemAliases`, `syncGroup`.
 */
async function resolvePayloadAliases(items, userIdent, deps = {}) {
  const resolveItem = deps.resolveItemAliases || resolveItemAliases;
  const syncGroup = deps.syncGroup || translationDict.syncGroup;

  // Resolve org/user for collection config lookup
  const userOrg = userIdent ? await resolveUserOrg(userIdent) : null;
  const orgIdent = userOrg ? userOrg.orgIdent : '';
  const resolvedUserIdent = userOrg ? userOrg.userIdent : '';

  const resolveAll = async () => {
    const allErrors = [];
    const resolvedItems = [];
    const failedGroups = new Set();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const groupNumber = item.product || item.asortment || '';

      if (!groupNumber) {
        resolvedItems.push(item);
        continue;
      }

      // Load collection config for this org/user/group
      const paramCollectionMap = (orgIdent && resolvedUserIdent)
        ? await loadParamCollectionConfig(groupNumber, orgIdent, resolvedUserIdent)
        : new Map();

      const { resolved, errors } = await resolveItem(item.parameters || {}, groupNumber, paramCollectionMap);
      resolvedItems.push({ ...item, parameters: resolved });

      if (errors.length) failedGroups.add(String(groupNumber));
      for (const err of errors) {
        allErrors.push(`Item[${i}] (group=${groupNumber}): ${err}`);
      }
    }
    return { resolvedItems, allErrors, failedGroups };
  };

  let out = await resolveAll();
  if (out.failedGroups.size) {
    // translation_dictionary is refreshed only by the admin "Synchronizuj" button,
    // while a form export changes param/paramdict at once — re-read the failing
    // groups from their files and try once more before the file goes to error/.
    const synced = [];
    for (const groupNumber of out.failedGroups) {
      try {
        const r = await syncGroup(groupNumber);
        synced.push(groupNumber);
        log(`aliasResolver: unknown value in group ${groupNumber} — translation_dictionary synced from files (${r && r.status}, ${r && r.entries} entries)`);
      } catch (err) {
        log(`aliasResolver: syncGroup(${groupNumber}) failed: ${err.message}`);
      }
    }
    out = await resolveAll();
    if (out.allErrors.length && synced.length) {
      out.allErrors.push(`Słownik grup(y) ${synced.join(', ')} zsynchronizowany z plików formularza tuż przed tą próbą — tych wartości nie ma w formularzu.`);
    }
  }

  return { items: out.resolvedItems, errors: out.allErrors };
}

module.exports = { resolveItemAliases, resolvePayloadAliases, resolveUserOrg };
