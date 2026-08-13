'use strict';

const { isHiddenParam, isPriceLikeName } = require('./paramVisibility');
const { buildSlopeDisplayValue } = require('./slopeSubform');

const SUPPORTED_LANGS = new Set(['pl', 'en', 'de', 'fr', 'nl']);

function getDefaultTranslationRepo() {
  return require('../translationDict/dbRepository');
}

function normalizeLang(lang) {
  const normalized = String(lang || 'pl').toLowerCase();
  return SUPPORTED_LANGS.has(normalized) ? normalized : 'pl';
}

function normalizeDisplayValues(displayValues) {
  const result = {};
  if (!displayValues) return result;

  if (Array.isArray(displayValues)) {
    for (const entry of displayValues) {
      if (Array.isArray(entry) && entry.length >= 2) {
        result[entry[0]] = entry[1];
      }
    }
    return result;
  }

  if (displayValues instanceof Map) {
    for (const [key, value] of displayValues.entries()) {
      result[key] = value;
    }
    return result;
  }

  if (typeof displayValues === 'object') {
    return { ...displayValues };
  }

  return result;
}

function extractExistingKeyOrder(displayValues) {
  if (!displayValues) return [];

  if (Array.isArray(displayValues)) {
    return displayValues
      .filter((entry) => Array.isArray(entry) && entry.length >= 2)
      .map((entry) => entry[0]);
  }

  if (displayValues instanceof Map) {
    return Array.from(displayValues.keys());
  }

  if (typeof displayValues === 'object') {
    return Object.keys(displayValues);
  }

  return [];
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

// Sentinels the form uses for "no value / no selection". They must never reach
// the rendered order: e.g. `SZEROKOSC_DACH="<NULL>"` on the price row (row 2)
// otherwise duplicates the real width/height label with an empty value.
const NO_VALUE_SENTINELS = new Set(['<NONE>', '<NULL>']);

function stripSentinelValue(entry) {
  if (entry && typeof entry === 'object' && NO_VALUE_SENTINELS.has(String(entry.option_value))) {
    return { ...entry, option_value: '' };
  }
  return entry;
}

function hasImportValue(importValues, paramName) {
  if (!importValues || !Object.prototype.hasOwnProperty.call(importValues, paramName)) {
    return false;
  }
  const value = importValues[paramName];
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

/**
 * An import value only earns its "keep me visible, the customer ordered this"
 * privileges while the form still considers the field active. A param the real
 * form disabled via its `param.txt` ENABLE formula (`___VISIBLE:false`) must not
 * be shown, re-labelled or pulled back onto row 1 from the payload — e.g.
 * DLUGOSC_STER on MODEL=BB24 (group 71).
 */
function hasActiveImportValue(importValues, paramName, values) {
  if (isHiddenParam(values, paramName)) return false;
  return hasImportValue(importValues, paramName);
}

function shouldSkipParam(paramName) {
  if (!paramName || paramName === 'uid') return true;
  if (paramName.startsWith('_')) return true;
  if (paramName.endsWith('___DICT')) return true;
  if (paramName.endsWith('___TITLE')) return true;
  if (paramName.endsWith('___VISIBLE')) return true;
  if (paramName.endsWith('___DESCRIPTION')) return true;
  if (paramName.endsWith('_ALIAS')) return true;
  return false;
}

function buildParamMetaMap(formMeta) {
  const result = {};
  const params = formMeta && Array.isArray(formMeta.params) ? formMeta.params : [];

  for (const param of params) {
    if (param && param.NAME) {
      result[param.NAME] = param;
    }
  }

  return result;
}

function hasExistingOwnValue(entry, key) {
  return entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, key);
}

function boolFromFormValue(value) {
  return value === true || value === 'true';
}

function isSkippedCountParam(paramName, formMeta) {
  const skipped = formMeta && Array.isArray(formMeta.skipCountParams)
    ? formMeta.skipCountParams
    : [];
  return skipped.includes(paramName);
}

function isLockedRabatParam(paramName) {
  return !!paramName && paramName.includes('RABAT');
}

function isMandatoryLockedElRabatParam(paramName) {
  return paramName === 'DOPLATA_EL_RABAT' || paramName === 'SUB___DOPLATA_EL_RABAT';
}

function finalizeDisplayEntry(entry) {
  // Faithful to formTools: `locked` is set exclusively by hideLocked() from
  // lockedParams. The server must never re-derive it from param-name heuristics
  // (e.g. "contains RABAT"), otherwise it diverges from the real form output.
  // Kept as a pass-through so displayValueRebuilder's import stays valid.
  return entry;
}

function isZeroSurchargeBaseParam(paramName) {
  return paramName === 'DOPLATA' || paramName === 'SUB___DOPLATA';
}

function isZeroSurchargeSpecParam(paramName) {
  return paramName === 'DOPLATA_S' || paramName === 'SUB___DOPLATA_S';
}

function isZeroElSurchargeParam(paramName) {
  return paramName === 'DOPLATA_EL' || paramName === 'SUB___DOPLATA_EL';
}

function isZeroElRabatParam(paramName) {
  return paramName === 'DOPLATA_EL_RABAT' || paramName === 'SUB___DOPLATA_EL_RABAT';
}

function isEffectivelyZeroValue(value) {
  if (value === undefined || value === null || value === '') return true;
  const asString = String(value).trim();
  const percentMatch = asString.match(/^(-?\d+(?:[.,]\d+)?)\s*%$/);
  if (percentMatch) {
    const num = Number(percentMatch[1].replace(',', '.'));
    return Number.isFinite(num) && Math.abs(num) < 0.000001;
  }
  const num = Number(asString.replace(',', '.'));
  return Number.isFinite(num) && Math.abs(num) < 0.000001;
}

function shouldHideZeroSurcharge(paramName, values) {
  if (isZeroSurchargeBaseParam(paramName)) {
    return isEffectivelyZeroValue(values && values[paramName]);
  }

  if (isZeroSurchargeSpecParam(paramName)) {
    const baseName = paramName.startsWith('SUB___') ? 'SUB___DOPLATA' : 'DOPLATA';
    return isEffectivelyZeroValue(values && values[baseName]);
  }

  if (isZeroElSurchargeParam(paramName)) {
    return isEffectivelyZeroValue(values && values[paramName]);
  }

  return false;
}

function shouldHideZeroFromDisplayEntry(paramName, entry) {
  if (!entry) return false;
  const optionValue = entry.option_value;

  if (isLockedRabatParam(paramName)) {
    if (!hasValue(optionValue)) return true;
    return isEffectivelyZeroValue(optionValue);
  }

  if (isZeroSurchargeBaseParam(paramName) || isZeroElSurchargeParam(paramName)) {
    return isEffectivelyZeroValue(optionValue);
  }

  if (isZeroElRabatParam(paramName)) {
    if (!hasValue(optionValue)) return true;
    return isEffectivelyZeroValue(optionValue);
  }

  return false;
}

function isPriceLikeParam(paramName, paramMeta, existingEntry, formMeta) {
  if (!paramName) return false;
  if (isSkippedCountParam(paramName, formMeta)) return false;
  // Name-based rules live in paramVisibility so the importer's clearing pass and
  // this builder can never disagree about what counts as a price field.
  if (isPriceLikeName(paramName)) return true;
  if (paramMeta && (paramMeta.LISTROW === '2' || boolFromFormValue(paramMeta.LISTSUM))) return true;
  if (existingEntry && String(existingEntry.row) === '2') return true;
  return false;
}

function resolveLocked(paramName, existingEntry, formMeta) {
  // HASLO-gated params stay hidden in skipCountParams until unlocked.
  if (isSkippedCountParam(paramName, formMeta)) {
    return existingEntry?.locked === true;
  }

  if (hasExistingOwnValue(existingEntry, 'locked')) {
    return existingEntry.locked === true;
  }

  const lockedParams = formMeta && Array.isArray(formMeta.lockedParams)
    ? formMeta.lockedParams
    : [];

  if (lockedParams.includes(paramName)) return true;
  if (paramName.startsWith('SUB___') && lockedParams.includes(paramName.slice(6))) return true;
  return false;
}

function resolveSub(paramName, existingEntry, formMeta) {
  if (hasExistingOwnValue(existingEntry, 'sub')) {
    return existingEntry.sub === true;
  }

  // Spec suffix fields (SUB___CENA_S) mirror parent prices — not sub line items.
  if (paramName.endsWith('_S')) return false;

  const subParams = formMeta && Array.isArray(formMeta.subParams)
    ? formMeta.subParams
    : [];

  return paramName.startsWith('SUB___') || subParams.includes(paramName);
}

function resolvePriceListRow(paramName, existingEntry, paramMeta, formMeta) {
  if (!isPriceLikeParam(paramName, paramMeta, existingEntry, formMeta)) return null;

  // Browser hides many price fields (___VISIBLE:false) as row 0 in displayValues,
  // but templates still render them on LISTROW 2 — same as the reference orders.
  if (paramMeta && (paramMeta.LISTROW === '2' || boolFromFormValue(paramMeta.LISTSUM))) {
    return '2';
  }
  if (existingEntry && String(existingEntry.row) === '2') return '2';
  return String((paramMeta && paramMeta.LISTROW) || '2');
}

function resolveRow(paramName, values, existingEntry, paramMeta, locked, importValues, formMeta) {
  if (isSkippedCountParam(paramName, formMeta) || shouldHideZeroSurcharge(paramName, values)) {
    return '0';
  }

  const priceListRow = resolvePriceListRow(paramName, existingEntry, paramMeta, formMeta);
  if (priceListRow !== null) return priceListRow;

  const importedConfig = hasActiveImportValue(importValues, paramName, values)
    && !isPriceLikeParam(paramName, paramMeta, existingEntry, formMeta)
    && !locked;

  // Imported config params must stay visible even when the engine hid them (row 0).
  if (importedConfig) {
    if (paramMeta && paramMeta.FORMROW === '0') return '0';
    if (hasValue(existingEntry && existingEntry.row) && existingEntry.row !== '0') {
      return String(existingEntry.row);
    }
    return String((paramMeta && paramMeta.LISTROW) || '1');
  }

  if (hasExistingOwnValue(existingEntry, 'row') || hasValue(existingEntry && existingEntry.row)) {
    return String(existingEntry.row);
  }

  const visibleKey = `${paramName}___VISIBLE`;
  if (!locked && values && values[visibleKey] === false) return '0';
  if (paramMeta && paramMeta.FORMROW === '0') return '0';
  return String((paramMeta && paramMeta.LISTROW) || '1');
}

function stringifyValue(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Display entry for a sub-form ("slope") param, whose value is a nested model
 * rather than a scalar — see services/orderImport/slopeSubform.js.
 *
 * Delegated so the importer and the browser modal describe a slope the same way:
 * labels are the sub-param titles cut at the first space (`B [mm]` → `B`), meta
 * keys (`___DICT`/`___TITLE`/`___VISIBLE`/`___DESCRIPTION`/`_ALIAS`) never leak
 * into the text, and the entry carries no scalar `option_value`.
 */
function buildObjectDisplayValue(value) {
  return buildSlopeDisplayValue(value);
}

function resolveOptionDescription({
  paramName,
  rawValue,
  optionValue,
  safeValues,
  paramdict,
  existingEntry
}) {
  const aliasKey = `${paramName}_ALIAS`;
  const aliasDesc = safeValues[`${aliasKey}___DESCRIPTION`] || safeValues[`${paramName}_ALIAS_DESCRIPTION`];
  const metaDesc = safeValues[`${paramName}___DESCRIPTION`];

  if (hasValue(safeValues[aliasKey]) && optionValue === stringifyValue(safeValues[aliasKey]) && hasValue(aliasDesc)) {
    return stringifyValue(aliasDesc);
  }
  if (hasValue(metaDesc)) return stringifyValue(metaDesc);
  if (hasValue(existingEntry && existingEntry.option_description)) {
    return String(existingEntry.option_description);
  }

  const valueMap = paramdict[paramName] || {};
  return valueMap[stringifyValue(rawValue)] || valueMap[optionValue] || '';
}

function orderedParamNames(values, shortJson, importValues, existingKeyOrder, formMeta) {
  const seen = new Set();
  const result = [];

  const add = (name) => {
    if (shouldSkipParam(name) || seen.has(name)) return;
    seen.add(name);
    result.push(name);
  };

  (existingKeyOrder || []).forEach(add);

  if (shortJson && Array.isArray(shortJson.order)) {
    shortJson.order.forEach(add);
  }

  if (formMeta && Array.isArray(formMeta.params)) {
    formMeta.params.forEach((param) => add(param && param.NAME));
  }

  const metaLists = ['lockedParams', 'subParams', 'skipCountParams'];
  for (const listName of metaLists) {
    const list = formMeta && Array.isArray(formMeta[listName]) ? formMeta[listName] : [];
    list.forEach(add);
  }

  Object.keys(importValues || {}).forEach(add);
  Object.keys(values || {}).forEach(add);
  return result;
}

function orderDisplayValues(output, shortJson, existingKeyOrder) {
  const ordered = {};
  const seen = new Set();

  const add = (name) => {
    if (!output[name] || seen.has(name)) return;
    seen.add(name);
    ordered[name] = output[name];
  };

  (existingKeyOrder || []).forEach(add);
  if (shortJson && Array.isArray(shortJson.order)) {
    shortJson.order.forEach(add);
  }
  Object.keys(output).forEach(add);

  // Faithful to the UI-created form output: config params (row=1) first, then
  // price rows (row=2), then hidden (row=0). Without this, imports whose
  // authoritative browser-recalc set only emits price entries would list every
  // price before any config field, breaking the preview layout.
  const rowRank = (entry) => {
    const row = entry && entry.row !== undefined ? String(entry.row) : '1';
    if (row === '1') return 0;
    if (row === '2') return 1;
    return 2;
  };
  const sorted = {};
  const keys = Object.keys(ordered);
  const indexed = keys.map((k, i) => ({ k, i, rank: rowRank(ordered[k]) }));
  indexed.sort((a, b) => a.rank - b.rank || a.i - b.i);
  for (const { k } of indexed) sorted[k] = ordered[k];
  return sorted;
}

function buildHiddenSkippedEntry(baseEntry, existingEntry, paramName, formMeta) {
  const merged = {
    param_description: baseEntry.param_description,
    sub: resolveSub(paramName, existingEntry, formMeta),
    locked: resolveLocked(paramName, existingEntry, formMeta),
    row: '0'
  };

  if (existingEntry && typeof existingEntry === 'object') {
    if (hasExistingOwnValue(existingEntry, 'sub')) merged.sub = existingEntry.sub === true;
  }

  return finalizeDisplayEntry(merged, paramName);
}

function shouldHideDisplayEntry(paramName, values, formMeta, entry = null) {
  if (isSkippedCountParam(paramName, formMeta)) return true;
  if (shouldHideZeroSurcharge(paramName, values)) return true;
  if (shouldHideZeroFromDisplayEntry(paramName, entry)) return true;
  return false;
}

function hasDisplayableContent(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (hasValue(entry.option_description)) return true;
  const optionValue = entry.option_value;
  if (!hasValue(optionValue)) return false;
  if (isEffectivelyZeroValue(optionValue)) return false;
  return true;
}

function shouldOmitDisplayEntry(entry, paramName, values, formMeta) {
  if (shouldHideDisplayEntry(paramName, values, formMeta, entry)) {
    return true;
  }
  return !hasDisplayableContent(entry);
}

function mergeEntry(baseEntry, existingEntry, paramName, importValues, paramMeta, formMeta, safeValues) {
  if (!existingEntry || typeof existingEntry !== 'object') {
    return baseEntry;
  }

  const imported = hasActiveImportValue(importValues, paramName, safeValues);
  const priceLike = isPriceLikeParam(paramName, paramMeta, existingEntry, formMeta);
  const merged = { ...existingEntry };

  if (hasValue(baseEntry.param_description)) {
    merged.param_description = baseEntry.param_description;
  }

  if (!priceLike && imported && hasValue(baseEntry.option_value)) {
    merged.option_value = baseEntry.option_value;
  } else if (!priceLike && !hasValue(merged.option_value) && hasValue(baseEntry.option_value)) {
    // Price values are computed by the real form (engine/browser). When it leaves
    // a price field empty — e.g. an invisible POW cleared by clearDisabledValues —
    // that emptiness is intentional, so we must not refill it from the raw values.
    merged.option_value = baseEntry.option_value;
  }

  if (!priceLike && hasValue(baseEntry.option_description)) {
    if (!hasValue(merged.option_description) || imported) {
      merged.option_description = baseEntry.option_description;
    }
  } else if (!hasValue(merged.option_description) && hasValue(baseEntry.option_description)) {
    merged.option_description = baseEntry.option_description;
  }

  const importedConfig = imported && !priceLike && !merged.locked;
  if (importedConfig && (merged.row === '0' || !hasValue(merged.row))) {
    merged.row = baseEntry.row;
  } else if (!hasExistingOwnValue(existingEntry, 'row') && !hasValue(merged.row)) {
    merged.row = baseEntry.row;
  }

  if (!hasExistingOwnValue(existingEntry, 'locked')) merged.locked = baseEntry.locked;
  if (!hasExistingOwnValue(existingEntry, 'sub')) merged.sub = baseEntry.sub;
  if (!hasExistingOwnValue(existingEntry, 'listsum') && baseEntry.listsum) {
    merged.listsum = baseEntry.listsum;
  }

  return merged;
}

async function getProductGroupName(groupNumber, lang) {
  if (!groupNumber) return '';

  const safeLang = normalizeLang(lang);
  const column = `name_${safeLang}`;
  const { connetToDb } = require('../../db/core');
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      `SELECT ${column} AS name, name_pl FROM product_group WHERE group_number = ? LIMIT 1`,
      [groupNumber]
    );
    if (!rows || !rows[0]) return '';
    return rows[0].name || rows[0].name_pl || '';
  } finally {
    await conn.end();
  }
}

async function getDepartmentName(groupNumber, lang) {
  if (!groupNumber) return '';

  const safeLang = normalizeLang(lang);
  const column = `d.name_${safeLang}`;
  const { connetToDb } = require('../../db/core');
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      `SELECT ${column} AS name, d.name_pl AS name_pl
       FROM product_group pg
       JOIN department d ON d.id = pg.department_id
       WHERE pg.group_number = ?
       LIMIT 1`,
      [groupNumber]
    );
    if (!rows || !rows[0]) return '';
    return rows[0].name || rows[0].name_pl || '';
  } finally {
    await conn.end();
  }
}

async function buildDisplayValuesFromDictionary({
  groupNumber,
  lang,
  values,
  displayValues = null,
  shortJson = null,
  formMeta = null,
  importValues = null,
  repo = null
}) {
  const safeLang = normalizeLang(lang);
  const safeValues = values || {};
  const safeImportValues = importValues || null;
  const existingKeyOrder = extractExistingKeyOrder(displayValues);
  const existing = normalizeDisplayValues(displayValues);
  const paramMetaMap = buildParamMetaMap(formMeta);
  const translationsRepo = repo || getDefaultTranslationRepo();
  const dict = await translationsRepo.getGroupTranslations(groupNumber, safeLang);
  const paramsDict = (dict && dict.params) || {};
  const paramdict = (dict && dict.paramdict) || {};

  const output = {};
  const names = orderedParamNames(safeValues, shortJson, safeImportValues, [
    ...existingKeyOrder,
    ...Object.keys(existing)
  ], formMeta);

  // The real form (engine/browser) decides which params get a display entry: it
  // only emits the ones active for this configuration. When we have that
  // authoritative set, we mirror it exactly and never invent extra entries from
  // formMeta/values (e.g. inactive SUB___DOPLATA_EL_RABAT surcharges or price
  // fields for options the customer did not choose), which the form omitted.
  const hasAuthoritativeSet = Object.keys(existing).length > 0;

  for (const paramName of names) {
    const existingEntry = existing[paramName];
    const paramMeta = paramMetaMap[paramName] || null;
    if (hasAuthoritativeSet && !(paramName in existing)) {
      // The post-import browser recalc's `getTotal` returns ONLY the price row
      // entries (CENA, SUMA_BRUTTO, SUB___*, POW, OPIS_*). If we treat that as
      // the full authoritative set, every configuration param the user actually
      // ordered (MODEL, KOLOR, SZEROKOSC, WYSOKOSC, BLENDA…) is dropped from
      // json_parameters_desc, leaving the order preview blank. Let import-only
      // configuration params (non-price, present in the source JSON) through so
      // they still appear in the config card.
      const isImportConfig = hasActiveImportValue(safeImportValues, paramName, safeValues)
        && !isPriceLikeParam(paramName, paramMeta, existingEntry, formMeta);
      if (!isImportConfig) continue;
    }
    const aliasKey = `${paramName}_ALIAS`;
    const titleKey = `${paramName}___TITLE`;
    const priceLikeEarly = isPriceLikeParam(paramName, paramMeta, existingEntry, formMeta);
    const rawValue = priceLikeEarly
      ? safeValues[paramName]
      : (hasActiveImportValue(safeImportValues, paramName, safeValues)
        ? safeImportValues[paramName]
        : safeValues[paramName]);
    const priceLike = isPriceLikeParam(paramName, paramMeta, existingEntry, formMeta);
    const locked = resolveLocked(paramName, existingEntry, formMeta);
    const sub = resolveSub(paramName, existingEntry, formMeta);
    const row = resolveRow(paramName, safeValues, existingEntry, paramMeta, locked, safeImportValues, formMeta);
    // The group-specific, already-translated label produced by the real form
    // (engine/browser) is authoritative — e.g. "CENA HKL [€] netto". The generic
    // translation dictionary carries a single label per param name across ALL
    // groups (e.g. "CENA DET. [€] brutto"), so it must only be a fallback, never
    // an override. `stubDisplayEntries` seeds param_description with the raw param
    // name, which we treat as "no real label" and translate via the dictionary.
    const existingParamDesc = existingEntry && existingEntry.param_description;
    const hasGroupSpecificLabel = hasValue(existingParamDesc) && existingParamDesc !== paramName;
    const paramDescription = hasGroupSpecificLabel
      ? existingParamDesc
      : (paramsDict[paramName] || (hasValue(existingParamDesc) ? existingParamDesc : '') || safeValues[titleKey] || paramName);

    let optionValue = '';
    let optionDescription = '';
    // A nested model (sub-form / "slope" param) describes itself — see
    // buildObjectDisplayValue — and that description wins over anything the
    // engine emitted, which for an unseeded SourceWindow is a blank model
    // stringified through its meta keys.
    const isObjectValue = !priceLike && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue);

    if (priceLike) {
      if (hasValue(existingEntry && existingEntry.option_value)) {
        optionValue = String(existingEntry.option_value);
        optionDescription = hasValue(existingEntry.option_description)
          ? String(existingEntry.option_description)
          : '';
      } else if (hasValue(rawValue)) {
        optionValue = stringifyValue(rawValue);
      }
    } else if (isObjectValue) {
      const objectDisplay = buildObjectDisplayValue(rawValue);
      optionValue = objectDisplay.option_value;
      optionDescription = objectDisplay.option_description;
    } else {
      const useAlias = !priceLike && hasValue(safeValues[aliasKey]);
      optionValue = stringifyValue(useAlias ? safeValues[aliasKey] : rawValue);
      optionDescription = resolveOptionDescription({
        paramName,
        rawValue,
        optionValue,
        safeValues,
        paramdict,
        existingEntry
      });

      const rawValueKey = stringifyValue(rawValue);
      // `<NONE>` is the "no selection" sentinel. The real form renders it as an
      // empty value (no card, no price row). Emitting the literal "<NONE>" — or
      // pairing it with a description — produces a bogus config card.
      if (rawValueKey === '<NONE>' || optionValue === '<NONE>') {
        optionValue = '';
        optionDescription = '';
      }
    }

    const baseEntry = {
      param_description: stringifyValue(paramDescription),
      sub,
      option_value: optionValue,
      option_description: stringifyValue(optionDescription),
      locked,
      row
    };

    if (paramMeta && boolFromFormValue(paramMeta.LISTSUM)) {
      baseEntry.listsum = true;
    }
    if (existingEntry && existingEntry.listsum === true) {
      baseEntry.listsum = true;
    }

    const merged = mergeEntry(
      baseEntry,
      existingEntry,
      paramName,
      safeImportValues,
      paramMeta,
      formMeta,
      safeValues
    );
    if (isObjectValue) {
      merged.option_value = baseEntry.option_value;
      merged.option_description = baseEntry.option_description;
    }
    // Faithful to formTools: the real form keeps every param in formDisplayValues.
    // Visibility is decided by the template (empty value / row '0' / locked), never
    // by dropping entries here. Dropping is what made prices vanish and reordered
    // the remaining rows in the imported view.
    output[paramName] = stripSentinelValue(merged);
  }

  for (const [key, value] of Object.entries(existing)) {
    if (output[key]) continue;
    output[key] = stripSentinelValue(finalizeDisplayEntry(value));
  }

  return orderDisplayValues(output, shortJson, existingKeyOrder);
}

module.exports = {
  buildDisplayValuesFromDictionary,
  getProductGroupName,
  getDepartmentName,
  _internals: {
    normalizeDisplayValues,
    orderedParamNames,
    shouldSkipParam,
    buildParamMetaMap,
    isPriceLikeParam,
    isSkippedCountParam,
    isLockedRabatParam,
    isMandatoryLockedElRabatParam,
    finalizeDisplayEntry,
    resolvePriceListRow,
    shouldHideZeroSurcharge,
    shouldOmitDisplayEntry,
    hasDisplayableContent,
    isEffectivelyZeroValue,
    mergeEntry,
    orderDisplayValues,
    extractExistingKeyOrder,
    hasImportValue,
    hasActiveImportValue,
    resolveRow
  }
};
