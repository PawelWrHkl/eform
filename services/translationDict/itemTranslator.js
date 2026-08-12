/**
 * Translates order items (cleanOrderItems) from their source language
 * into a target language using the translation_dictionary DB table.
 *
 * Works with the post-removeEmptyColumns structure where rows use:
 *   row.row1 = { displayName: cellValue, ... }
 *   row.row2 = { displayName: cellValue, ... }
 * and tables have headerKeys1/headerKeys2 arrays (displayName||paramName).
 */

const repo = require('./dbRepository');
const { log } = require('../../utils/logging');

/**
 * Translate cleanOrderItems into the target language.
 *
 * @param {Array} orderItems - Raw order items from DB (with asortment_group_number)
 * @param {Array} cleanOrderItems - Processed items from orderService.jsonTextBackToMap
 * @param {string} targetLang - Target language code (e.g. 'en', 'de')
 * @returns {Promise<Array>} - Translated cleanOrderItems (deep copy)
 */
async function translateOrderItems(orderItems, cleanOrderItems, targetLang) {
  const groupNumbers = [...new Set(orderItems.map(i => i.asortment_group_number).filter(Boolean))];
  if (groupNumbers.length === 0) return cleanOrderItems;

  // Load translations for all groups
  const translationsByGroup = {};
  for (const groupNumber of groupNumbers) {
    translationsByGroup[groupNumber] = await repo.getGroupTranslations(groupNumber, targetLang);
  }

  // Build item id → group number mapping
  const itemGroupMap = {};
  for (const item of orderItems) {
    itemGroupMap[item.id] = item.asortment_group_number;
  }

  // Nazwy DZIAŁU i GRUPY (kolumny „Produkt" i „Grupa" na dokumencie).
  // ⚠️ Nie ma ich w `translation_dictionary` — to nie parametry konfiguratora,
  // a wartości zapisane na pozycji w języku jej autora. Tłumaczenia trzymają
  // tabele `product_group` / `department`; bez tego dokument wymuszony np. na
  // niderlandzki miał nagłówki i parametry po niderlandzku, a „Produkt"
  // i „Grupę" nadal po polsku.
  const nazwyGrup = await repo.getGroupDepartmentNames(groupNumbers, targetLang);

  // Deep clone
  const translated = JSON.parse(JSON.stringify(cleanOrderItems));

  // Podmiana nazw działu i grupy — NIEZALEŻNIE od słownika parametrów: grupa
  // może nie mieć wpisów w `translation_dictionary`, a nazwę i tak trzeba
  // przetłumaczyć.
  for (const table of translated) {
    for (const rowObj of table.rows || []) {
      const numer = itemGroupMap[rowObj.item.id || rowObj.item.posId];
      const nazwy = numer != null ? nazwyGrup.get(String(numer)) : null;
      if (!nazwy) continue;
      if (nazwy.department) rowObj.item.department = nazwy.department;
      if (nazwy.group) rowObj.item.group_name = nazwy.group;
    }
  }

  for (const table of translated) {
    if (table.rows.length === 0) continue;

    const firstItemId = table.rows[0].item.id || table.rows[0].item.posId;
    const firstItemGroup = itemGroupMap[firstItemId];
    const dict = firstItemGroup ? translationsByGroup[firstItemGroup] : null;

    if (!dict) continue;

    // Build display→paramName map from headerKeys
    const displayToParam1 = buildDisplayParamMap(table.headerKeys1);
    const displayToParam2 = buildDisplayParamMap(table.headerKeys2);

    // Translate headers1 display names
    table.headers1 = table.headers1.map(display => {
      const paramName = displayToParam1[display];
      return (paramName && dict.params[paramName]) || display;
    });

    // Translate headers2 display names
    if (table.headers2) {
      table.headers2 = table.headers2.map(display => {
        const paramName = displayToParam2[display];
        return (paramName && dict.params[paramName]) || display;
      });
    }

    // Build old display → new display map for row key remapping
    const remap1 = {};
    for (const [oldDisplay, paramName] of Object.entries(displayToParam1)) {
      remap1[oldDisplay] = (paramName && dict.params[paramName]) || oldDisplay;
    }
    const remap2 = {};
    for (const [oldDisplay, paramName] of Object.entries(displayToParam2)) {
      remap2[oldDisplay] = (paramName && dict.params[paramName]) || oldDisplay;
    }

    // Update headerKeys to match translated display names
    if (table.headerKeys1) {
      table.headerKeys1 = table.headerKeys1.map(hk => {
        const paramName = hk.split('||')[1];
        const newDisplay = dict.params[paramName] || hk.split('||')[0];
        return newDisplay + '||' + paramName;
      });
    }
    if (table.headerKeys2) {
      table.headerKeys2 = table.headerKeys2.map(hk => {
        const paramName = hk.split('||')[1];
        const newDisplay = dict.params[paramName] || hk.split('||')[0];
        return newDisplay + '||' + paramName;
      });
    }

    // Translate row values
    for (const rowObj of table.rows) {
      const itemId = rowObj.item.id || rowObj.item.posId;
      const groupNumber = itemGroupMap[itemId];
      const rowDict = groupNumber ? translationsByGroup[groupNumber] : null;
      if (!rowDict) continue;

      // Translate row1 cells
      if (rowObj.row.row1) {
        rowObj.row.row1 = translateRowCells(
          rowObj.row.row1, displayToParam1, remap1, rowDict
        );
      }

      // Translate row2 cells
      if (rowObj.row.row2) {
        rowObj.row.row2 = translateRowCells(
          rowObj.row.row2, displayToParam2, remap2, rowDict
        );
      }

      // Translate lockedParams so template checks still match translated headers
      if (rowObj.item.lockedParams) {
        rowObj.item.lockedParams = rowObj.item.lockedParams.map(
          name => remap1[name] || remap2[name] || name
        );
      }
    }

    // Translate table.locked to match translated header names
    if (table.locked) {
      table.locked = table.locked.map(
        name => remap1[name] || remap2[name] || name
      );
    }
  }

  return translated;
}

/**
 * Build a map from display name to param name from headerKeys array.
 * headerKeys format: "Display Name||PARAM_NAME"
 */
function buildDisplayParamMap(headerKeys) {
  const map = {};
  if (!headerKeys) return map;
  for (const hk of headerKeys) {
    const parts = hk.split('||');
    if (parts.length === 2) {
      map[parts[0]] = parts[1];
    }
  }
  return map;
}

/**
 * Translate row cells: remap display-name keys and translate cell values.
 *
 * @param {Object} rowCells - { displayName: cellValue, ... }
 * @param {Object} displayToParam - { oldDisplayName: paramName }
 * @param {Object} displayRemap - { oldDisplayName: newDisplayName }
 * @param {Object} dict - { params: {...}, paramdict: {...} }
 * @returns {Object} - Translated row cells with new display name keys
 */
function translateRowCells(rowCells, displayToParam, displayRemap, dict) {
  const result = {};
  for (const [oldDisplay, cellValue] of Object.entries(rowCells)) {
    const newDisplay = displayRemap[oldDisplay] || oldDisplay;
    const paramName = displayToParam[oldDisplay];

    if (paramName && typeof cellValue === 'string') {
      result[newDisplay] = translateCellValue(cellValue, paramName, dict.paramdict);
    } else {
      result[newDisplay] = cellValue;
    }
  }
  return result;
}

/**
 * Translate a cell value string like "VS2_M - o stałym naciągu magnetyczna"
 * by looking up the value key in paramdict translations.
 */
function translateCellValue(cellValue, paramName, paramdict) {
  if (!paramdict[paramName] || cellValue === '-') return cellValue;

  const dictValues = paramdict[paramName];

  const dashIdx = cellValue.indexOf(' - ');
  if (dashIdx !== -1) {
    const valueKey = cellValue.substring(0, dashIdx).trim();
    const translatedDesc = dictValues[valueKey];
    if (translatedDesc) {
      return `${valueKey} - ${translatedDesc}`;
    }
  } else {
    const translatedDesc = dictValues[cellValue.trim()];
    if (translatedDesc) {
      return `${cellValue.trim()} - ${translatedDesc}`;
    }
  }

  return cellValue;
}

module.exports = { translateOrderItems };
