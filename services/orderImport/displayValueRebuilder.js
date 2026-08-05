/**
 * Display Value Rebuilder
 *
 * After Playwright recalculates (which sets correct row/locked/listsum/prices
 * but may lose client aliases in option_value), this module patches
 * json_parameters_desc: for params that have _ALIAS in json_parameters,
 * it replaces option_value with the alias and option_description with alias_description.
 *
 * Does NOT rebuild from scratch — preserves row, locked, listsum, sub from Playwright.
 */

'use strict';

const { connetToDb } = require('../../db/core');
const { displayValuesToWireFormat } = require('../formEngine');
const {
  buildDisplayValuesFromDictionary,
  _internals: { finalizeDisplayEntry }
} = require('./displayValueBuilder');
const { buildPersistedParameters, extractImportParams } = require('./orderImporter');
const { clearHiddenParams, readFormParamDefs } = require('./paramVisibility');
const { log } = require('../../utils/logging');

/**
 * Patch displayValues for all positions in an order — replace option_value
 * with alias where _ALIAS exists in json_parameters.
 * @param {number} orderId
 */
async function rebuildDisplayValuesForOrder(orderId) {
  const conn = await connetToDb();
  try {
    const [positions] = await conn.query(
      'SELECT id, asortment_group_number, lang, ver, json_parameters, json_parameters_desc, parameters_short FROM order_item WHERE order_id = ?',
      [orderId]
    );

    if (!positions || positions.length === 0) return;

    for (const pos of positions) {
      let values = pos.json_parameters;
      if (typeof values === 'string') {
        try { values = JSON.parse(values); } catch { values = {}; }
      }
      if (!values || typeof values !== 'object') continue;

      // Parse existing displayValues (from Playwright — has correct row/locked/listsum)
      let displayRaw = pos.json_parameters_desc;
      if (typeof displayRaw === 'string') {
        try {
          displayRaw = JSON.parse(displayRaw);
          if (typeof displayRaw === 'string') displayRaw = JSON.parse(displayRaw);
        } catch { displayRaw = []; }
      }

      // Convert to Map-like structure for patching
      let entries;
      if (Array.isArray(displayRaw)) {
        entries = displayRaw; // [[key, value], ...]
      } else if (displayRaw && typeof displayRaw === 'object') {
        entries = Object.entries(displayRaw);
      } else {
        continue;
      }

      let changed = false;

      for (let i = 0; i < entries.length; i++) {
        const [paramName, entry] = entries[i];
        if (!paramName || !entry || typeof entry !== 'object') continue;

        const aliasKey = `${paramName}_ALIAS`;
        const aliasDescKey = `${paramName}_ALIAS_DESCRIPTION`;

        // If this param has an alias in values, patch option_value and option_description
        if (values[aliasKey] && values[aliasKey] !== '') {
          if (entry.option_value !== values[aliasKey]) {
            entry.option_value = values[aliasKey];
            changed = true;
          }
          if (values[aliasDescKey] && entry.option_description !== values[aliasDescKey]) {
            entry.option_description = values[aliasDescKey];
            changed = true;
          }
        }

        const fixed = finalizeDisplayEntry(entry, paramName);
        if (fixed.locked !== entry.locked) {
          entry.locked = fixed.locked;
          changed = true;
        }
      }

      if (changed) {
        // Store DOUBLE-encoded (a JSON string scalar) to match the shape written
        // by insertNewForm/updatePosition. `json_parameters_desc` is a MySQL JSON
        // column, so writing the bare wire array would make it read back as an
        // array and break readers that expect the canonical string form.
        const wire = JSON.stringify(JSON.stringify(entries));
        await conn.query(
          'UPDATE order_item SET json_parameters_desc = ? WHERE id = ?',
          [wire, pos.id]
        );
      }

      // Rebuild displayValues after Playwright: apply aliases, locked flags and
      // drop empty / zero-hidden params the browser leaves in the map.
      if (pos.asortment_group_number) {
        const displayObject = Object.fromEntries(entries);
        let shortJson = pos.parameters_short;
        if (typeof shortJson === 'string') {
          try { shortJson = JSON.parse(shortJson); } catch { shortJson = null; }
        }

        let formMeta = null;
        if (pos.ver) {
          try {
            const { getFormMeta } = require('../formEngine');
            formMeta = await getFormMeta({
              groupNumber: String(pos.asortment_group_number),
              version: pos.ver,
              lang: pos.lang || 'pl'
            });
          } catch (err) {
            log(`displayValueRebuilder: getFormMeta failed for position ${pos.id}: ${err.message}`);
          }
        }

        // Params the browser disabled (`___VISIBLE:false`) must not come back as
        // "import values" here — that is exactly the privilege that used to make
        // a disabled field (e.g. DLUGOSC_STER on MODEL=BB24) render as a config
        // card. The browser's verdict is authoritative (trustAll), but only for
        // params param.txt actually gates with an ENABLE formula — hence defs.
        const visibilityDefs = await readFormParamDefs(
          String(pos.asortment_group_number),
          pos.lang || 'pl'
        );
        const visibleValues = clearHiddenParams(
          { ...values },
          { trustAll: true, defs: visibilityDefs }
        ).values;
        const importParams = extractImportParams(visibleValues);
        const rebuilt = await buildDisplayValuesFromDictionary({
          groupNumber: String(pos.asortment_group_number),
          lang: pos.lang || 'pl',
          values: buildPersistedParameters(importParams, visibleValues),
          displayValues: entries,
          shortJson,
          formMeta,
          importValues: importParams
        });
        const rebuiltWire = displayValuesToWireFormat(rebuilt);
        const currentWire = displayValuesToWireFormat(displayObject);
        if (rebuiltWire !== currentWire) {
          // Double-encode (JSON string scalar) so the JSON column reads back as a
          // string, consistent with insertNewForm and the non-imported flow.
          await conn.query(
            'UPDATE order_item SET json_parameters_desc = ? WHERE id = ?',
            [JSON.stringify(rebuiltWire), pos.id]
          );
        }
      }
    }
  } finally {
    await conn.end();
  }
}

module.exports = { rebuildDisplayValuesForOrder };
