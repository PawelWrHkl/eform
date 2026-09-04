/**
 * Read-only access to real, already-saved `order_item` rows, used as seed
 * configurations for the tester (see engineRunner.js). No INSERT/UPDATE/DELETE
 * here, ever — this module must stay safe to run against the live DB.
 */

'use strict';

const { selectQuery } = require('../../db/core');

/**
 * Most recent saved positions for a group, newest first.
 * @param {string} groupNumber
 * @param {number} [limit]
 * @returns {Promise<Array<object>>}
 */
async function getRecentPositions(groupNumber, limit = 5) {
  // org/user ident come along because the price list variant (Excel column
  // block + multiplier) is per client — see excelTruthTable/priceVariant.js.
  const rows = await selectQuery(
    `SELECT oi.id, oi.json_parameters, oi.json_parameters_desc, oi.parameters_short,
            oi.lang, oi.asortment_group_number, oi.total_price, oi.total_price_sub, oi.ver,
            u.ident AS user_ident, org.ident AS org_ident
     FROM order_item oi
     JOIN \`order\` o ON o.id = oi.order_id
     JOIN user u ON u.id = o.user_id
     LEFT JOIN organization org ON org.id = u.organization_id
     WHERE oi.asortment_group_number = ?
     ORDER BY oi.id DESC
     LIMIT ?`,
    [groupNumber, limit]
  );
  return rows || [];
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = numbers.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// mysql2 auto-deserializes JSON-typed columns into objects — only parse when
// it comes back as a raw string (see engineRunner.js's own safeJsonParse).
function decodeJsonParameters(row) {
  if (!row.json_parameters) return null;
  if (typeof row.json_parameters !== 'string') return row.json_parameters;
  try { return JSON.parse(row.json_parameters); } catch (_e) { return null; }
}

/**
 * Median real-world value of a numeric field (e.g. SZEROKOSC/WYSOKOSC) across
 * recent saved positions for a group — used by formWalker.js as a plausible
 * default when the engine hasn't derived a MIN/MAX rule for that field by
 * pick-time (see formWalker.js's NUMERIC_FIELD_FALLBACK comment). A median of
 * real, previously-priced orders is far more likely to land inside whatever
 * range the price tables actually cover than any single made-up constant.
 *
 * @param {string} groupNumber
 * @param {string} fieldName
 * @param {number} [sampleSize]
 * @param {Object<string,string>} [matchFields] - only consider positions whose
 *   decoded values match these fields exactly (e.g. {MODEL: 'VS2SLC'}) — a
 *   group-wide median mixes models with very different valid width/height
 *   ranges, so a value typical for the WRONG model can land outside the
 *   RIGHT model's price table and produce a spurious 0 price. Falls back to
 *   the unfiltered group-wide median when no position matches.
 * @returns {Promise<number|null>} null when no historical data exists at all
 */
async function getTypicalNumericValue(groupNumber, fieldName, sampleSize = 20, matchFields = null) {
  const rows = await getRecentPositions(groupNumber, sampleSize);
  const values = [];
  const matchedValues = [];
  for (const row of rows) {
    const parsed = decodeJsonParameters(row);
    if (!parsed) continue;
    const num = parseFloat(parsed[fieldName]);
    if (!Number.isFinite(num) || num <= 0) continue;
    values.push(num);
    if (matchFields && Object.entries(matchFields).every(([k, v]) => String(parsed[k]) === String(v))) {
      matchedValues.push(num);
    }
  }
  if (matchFields && matchedValues.length) return median(matchedValues);
  return median(values);
}

/**
 * Value-frequency count per field across recent saved positions —
 * `{ fieldName: { value: count } }`. Used to pick "the option a real client
 * usually chooses" for a field instead of an arbitrary first-in-list option
 * (see formWalker.js's buildBasicConfiguration doc comment: blindly combining
 * individually-legal options can land on a combination the pricing tree has
 * no price for at all, even though no single field is at fault).
 *
 * @param {string} groupNumber
 * @param {number} [sampleSize]
 */
async function getFieldValueFrequencies(groupNumber, sampleSize = 30) {
  const rows = await getRecentPositions(groupNumber, sampleSize);
  const freq = {};
  for (const row of rows) {
    const parsed = decodeJsonParameters(row);
    if (!parsed) continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (key.includes('___') || key.endsWith('_ALIAS') || key === 'uid') continue;
      if (value === '' || value === null || value === undefined) continue;
      if (!freq[key]) freq[key] = {};
      const k = String(value);
      freq[key][k] = (freq[key][k] || 0) + 1;
    }
  }
  return freq;
}

/** Most frequent historical value for a field that is still among `allowedOptions` (or any value when omitted). */
function mostPopularValue(freq, fieldName, allowedOptions = null) {
  const counts = freq[fieldName];
  if (!counts) return null;
  const allowedSet = allowedOptions ? new Set(allowedOptions.map(String)) : null;
  let best = null;
  let bestCount = -1;
  for (const [value, count] of Object.entries(counts)) {
    if (allowedSet && !allowedSet.has(value)) continue;
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

module.exports = {
  getRecentPositions,
  getTypicalNumericValue,
  getFieldValueFrequencies,
  mostPopularValue
};
