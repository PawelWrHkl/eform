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
  const rows = await selectQuery(
    `SELECT id, json_parameters, json_parameters_desc, parameters_short,
            lang, asortment_group_number, total_price, total_price_sub, ver
     FROM order_item
     WHERE asortment_group_number = ?
     ORDER BY id DESC
     LIMIT ?`,
    [groupNumber, limit]
  );
  return rows || [];
}

module.exports = { getRecentPositions };
