'use strict';

/**
 * Skrypty cennika, którymi liczono ceny klienta zlecenia — potrzebne tylko do
 * nazw składników (`scriptLabels.conditionsForParam`).
 *
 * Ta sama ścieżka co import zamówień (services/orderImport/orderImporter.js):
 * najpierw nakładka z bazy (`customer_group_terms` — klienci założeni w eFormie
 * nie mają wpisów w `prod.txt`), potem `getClientScripts`.
 */

const { primeClientOverlay, getClientScripts } = require('../formEngine/clientScripts');
const { log } = require('../../utils/logging');

async function defaultOwnerQuery(orderId) {
  const { selectQuery } = require('../../db/core');
  const rows = await selectQuery(
    `SELECT u.id AS userId, u.ident AS userIdent, org.ident AS orgIdent
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
       LEFT JOIN organization org ON org.id = u.organization_id
      WHERE o.id = ?`,
    [orderId]
  );
  return rows && rows[0] ? rows[0] : null;
}

/**
 * @param {object} params
 * @param {number|string} params.orderId
 * @param {Array<string|number>} params.groups  numery grup pozycji zlecenia
 * @param {object} [deps]  `{ ownerQuery, primeClientOverlay, getClientScripts }` do testów
 * @returns {Promise<object>} `{ [grupa]: { [param]: plik } }` — pusty obiekt, gdy
 *   nie da się ustalić klienta (wtedy nazwy biorą się z pierwszego wariantu skryptu).
 */
async function resolveScriptsByGroup({ orderId, groups }, deps = {}) {
  const ownerQuery = deps.ownerQuery || defaultOwnerQuery;
  const prime = deps.primeClientOverlay || primeClientOverlay;
  const lookup = deps.getClientScripts || getClientScripts;
  const out = {};
  let owner = null;
  try {
    owner = await ownerQuery(orderId);
  } catch (err) {
    log(`[priceSpec] Nie ustalono klienta zlecenia ${orderId}: ${err.message}`);
    return out;
  }
  if (!owner || !owner.userIdent || !owner.orgIdent) return out;

  for (const groupNumber of new Set((groups || []).filter(Boolean).map(String))) {
    try {
      await prime({ userId: owner.userId, orgIdent: owner.orgIdent, userIdent: owner.userIdent, groupNumber });
    } catch (_err) { /* bez nakładki zostaje prod.txt */ }
    const resolved = lookup({ groupNumber, lang: 'pl', orgIdent: owner.orgIdent, userIdent: owner.userIdent });
    if (!resolved) continue;
    const map = {};
    for (const entry of resolved[1] || []) if (entry && entry.param && entry.file) map[entry.param] = entry.file;
    out[groupNumber] = map;
  }
  return out;
}

module.exports = { resolveScriptsByGroup };
