/**
 * Zero-price repair pass for imported orders.
 *
 * An imported position that ends up with `unit_price` NULL/0 means the price
 * scripts found no matching price-group block. In practice that has one cause:
 * `json_parameters` is missing the data the gate formulas read —
 *
 *   - the "#N" price-group tag (`<PARAM>___DESCRIPTION`), which for many fabrics
 *     exists only in the client's alias collection (`client_aliases`), not in
 *     `translation_dictionary`;
 *   - or the description key itself, since `hot-formula-parser` evaluates both
 *     branches of `IF` and a missing variable turns the whole gate into `false`.
 *
 * See `paramDescriptions.js` for the full story. This module re-derives that data
 * from the DB for an order that is already committed, then re-runs the real
 * browser recalculation — the same flow a human admin would use, so the result is
 * exactly what a manual "przelicz" produces.
 *
 * Runs automatically after every import whose zero-price check fires (see
 * `index.js`), and manually via `scripts/repairOrderPrices.js`.
 */

'use strict';

const { connetToDb } = require('../../db/core');
const { log } = require('../../utils/logging');
const {
  loadClientDescriptions,
  seedParamDescriptions
} = require('./paramDescriptions');
const { readFormParamDefs, clearHiddenParams } = require('./paramVisibility');

/** Positions of an order that still have no price. */
async function findZeroPricePositions(orderId, deps = {}) {
  const connect = deps.connect || connetToDb;
  const conn = await connect();
  try {
    const [rows] = await conn.query(
      `SELECT id, orderpos, unit_price FROM order_item
        WHERE order_id = ? AND (unit_price IS NULL OR unit_price = 0)
        ORDER BY orderpos`,
      [orderId]
    );
    return rows || [];
  } finally {
    await conn.end();
  }
}

/**
 * Re-seed price-group descriptions (and re-apply param.txt visibility) on the
 * stored params of an order. Returns a per-position report.
 */
async function reseedOrderParameters(orderId, deps = {}) {
  const connect = deps.connect || connetToDb;
  const dictRepo = deps.translationRepo || require('../translationDict/dbRepository');
  const descriptionsLoader = deps.loadClientDescriptions || loadClientDescriptions;
  const defsReader = deps.readFormParamDefs || readFormParamDefs;

  const conn = await connect();
  const report = [];
  try {
    const [rows] = await conn.query(
      `SELECT oi.id, oi.asortment_group_number AS groupNumber, oi.lang, oi.json_parameters,
              u.ident AS userIdent, org.ident AS orgIdent
         FROM order_item oi
         JOIN \`order\` o ON o.id = oi.order_id
         JOIN user u ON u.id = o.user_id
         JOIN organization org ON org.id = u.organization_id
        WHERE oi.order_id = ?
        ORDER BY oi.orderpos`,
      [orderId]
    );

    for (const row of rows || []) {
      let values = row.json_parameters;
      if (typeof values === 'string') {
        try { values = JSON.parse(values); } catch { values = null; }
      }
      if (!values || typeof values !== 'object') continue;
      if (!row.groupNumber) continue;

      const group = String(row.groupNumber);
      const lang = row.lang || 'pl';

      let paramdict = {};
      try {
        const dict = await dictRepo.getGroupTranslations(group, lang);
        paramdict = (dict && dict.paramdict) || {};
      } catch (err) {
        log(`zeroPriceRepair: getGroupTranslations failed for group ${group}: ${err.message}`);
      }

      let clientDescriptions = new Map();
      try {
        clientDescriptions = await descriptionsLoader(group, row.orgIdent, row.userIdent);
      } catch (err) {
        log(`zeroPriceRepair: loadClientDescriptions failed for group ${group}: ${err.message}`);
      }

      let paramDefs = null;
      try {
        paramDefs = await defsReader(group, lang);
      } catch (err) {
        log(`zeroPriceRepair: readFormParamDefs failed for group ${group}: ${err.message}`);
      }

      const before = JSON.stringify(values);
      const { cleared } = clearHiddenParams(values, { trustAll: true, defs: paramDefs });
      const { seeded } = seedParamDescriptions(values, {
        paramdict,
        clientDescriptions,
        paramDefs
      });
      const wire = JSON.stringify(values);
      const changed = wire !== before;

      if (changed) {
        await conn.query('UPDATE order_item SET json_parameters = ? WHERE id = ?', [wire, row.id]);
      }
      report.push({ positionId: row.id, changed, seeded, cleared });
    }
    return report;
  } finally {
    await conn.end();
  }
}

/**
 * Full repair: re-seed the params, recalculate in the browser, rebuild display
 * values, then check whether any position still prices to zero.
 *
 * Safe to call on an order that is already fine — nothing is changed when there
 * is nothing to seed, and the recalculation is the same one the import runs.
 *
 * @param {number} orderId
 * @param {object} [opts]
 * @param {boolean} [opts.recalculate=true]   run the browser recalculation
 * @param {object} [opts.deps]                injection point for tests
 * @returns {Promise<{orderId, repaired: boolean, seeded: string[], cleared: string[],
 *   recalc: object|null, zeroBefore: number[], zeroAfter: number[], message: string}>}
 */
async function repairZeroPriceOrder(orderId, opts = {}) {
  const { recalculate = true, deps = {} } = opts;
  const logger = deps.log || log;

  const zeroBeforeRows = await findZeroPricePositions(orderId, deps);
  const zeroBefore = zeroBeforeRows.map((r) => r.orderpos);

  const report = await reseedOrderParameters(orderId, deps);
  const seeded = [...new Set(report.flatMap((r) => r.seeded))];
  const cleared = [...new Set(report.flatMap((r) => r.cleared))];
  const changedPositions = report.filter((r) => r.changed).map((r) => r.positionId);

  if (changedPositions.length) {
    logger(`zeroPriceRepair: order ${orderId} — uzupełniono parametry pozycji ${changedPositions.join(', ')}`
      + `${seeded.length ? ` (opisy: ${seeded.join(', ')})` : ''}`
      + `${cleared.length ? ` (wyczyszczone wyłączone pola: ${cleared.join(', ')})` : ''}`);
  } else {
    logger(`zeroPriceRepair: order ${orderId} — brak brakujących opisów do uzupełnienia`);
  }

  let recalc = null;
  if (recalculate) {
    // Required lazily so a params-only pass never has to load Playwright.
    const recalcRunner = deps.recalculateOrderInBrowser
      || require('./browserRecalculator').recalculateOrderInBrowser;
    const rebuildDisplayValues = deps.rebuildDisplayValuesForOrder
      || require('./displayValueRebuilder').rebuildDisplayValuesForOrder;

    recalc = await recalcRunner(orderId);
    logger(`zeroPriceRepair: order ${orderId} — recalc ${recalc.success ? 'OK' : 'FAIL'}: ${recalc.message}`);
    if (recalc.success) {
      try {
        await rebuildDisplayValues(orderId);
      } catch (err) {
        logger(`zeroPriceRepair: rebuildDisplayValues failed for order ${orderId}: ${err.message}`);
      }
    }
  }

  const zeroAfterRows = await findZeroPricePositions(orderId, deps);
  const zeroAfter = zeroAfterRows.map((r) => r.orderpos);
  const repaired = zeroBefore.length > 0 && zeroAfter.length === 0;

  let message;
  if (repaired) {
    message = `Naprawiono ceny wszystkich ${zeroBefore.length} pozycji`;
  } else if (zeroAfter.length === 0) {
    message = 'Brak pozycji z ceną 0';
  } else if (zeroAfter.length < zeroBefore.length) {
    message = `Częściowo naprawione — nadal cena 0 na pozycjach: ${zeroAfter.map((p) => `#${p}`).join(', ')}`;
  } else {
    message = `Nadal cena 0 na pozycjach: ${zeroAfter.map((p) => `#${p}`).join(', ')} `
      + '— wymaga sprawdzenia grupy cenowej / cennika ręcznie';
  }
  logger(`zeroPriceRepair: order ${orderId} — ${message}`);

  return { orderId, repaired, seeded, cleared, recalc, zeroBefore, zeroAfter, message };
}

module.exports = {
  repairZeroPriceOrder,
  reseedOrderParameters,
  findZeroPricePositions
};
