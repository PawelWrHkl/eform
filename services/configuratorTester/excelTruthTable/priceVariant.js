/**
 * Which price-list variant a given client gets for a given price param.
 *
 * `prod.txt`'s PARAM_SCRIPTS maps `<ORG>/<USER>/<PARAM>` to a generated script
 * file whose name carries the Excel column-block letter and an optional
 * multiplier: `param-CENA-C.js` → block C, `param-CENA-Bmul0.32.js` → block B
 * scaled by 0.32. That letter is exactly the block letter labelled in row 1 of
 * the matching Excel sheet, which is why two orders for the same product can
 * legitimately price differently — they belong to different brands/clients.
 *
 * Resolution itself is NOT reimplemented here: services/formEngine/clientScripts.js
 * already parses PARAM_SCRIPTS (including the DB overlay for clients created in
 * eForm that aren't in prod.txt at all).
 */

'use strict';

const { getClientScripts } = require('../../formEngine/clientScripts');

/**
 * @param {string} fileName e.g. "param-CENA-Cmul1.2.js"
 * @param {string} paramName e.g. "CENA"
 * @returns {{letter: string, multiplier: number}|null}
 */
function parseScriptFileName(fileName, paramName) {
  if (!fileName || !paramName) return null;
  const match = new RegExp(`^param-${paramName}-(.+)\\.js$`).exec(String(fileName).trim());
  if (!match) return null;

  const suffix = match[1];
  const mul = /^(.*?)mul([0-9.]+)$/.exec(suffix);
  if (mul) {
    const multiplier = parseFloat(mul[2]);
    return { letter: mul[1], multiplier: Number.isFinite(multiplier) ? multiplier : 1 };
  }
  return { letter: suffix, multiplier: 1 };
}

/**
 * @returns {{letter: string, multiplier: number, file: string}|null} null when
 *   this client has no explicit variant for that param (then the engine falls
 *   back to whatever `param.SCRIPTS` in param.txt says — out of scope here).
 */
function resolvePriceVariant({ groupNumber, lang, orgIdent, userIdent, paramName }) {
  const resolved = getClientScripts({ groupNumber, lang, orgIdent, userIdent });
  if (!resolved) return null;

  const [, entries] = resolved;
  const entry = entries.find((e) => e.param === paramName);
  if (!entry) return null;

  const parsed = parseScriptFileName(entry.file, paramName);
  return parsed ? Object.assign({ file: entry.file }, parsed) : null;
}

/**
 * A variant token as it appears in param.txt's SCRIPTS column: `A`, `K`,
 * `Cmul1.2`, `0.55`. `true` is not a token — it means "resolve through the
 * client's prod.txt mapping instead" (dataLoader.selectPrices only overrides
 * param.SOURCE when SCRIPTS === 'true').
 */
function parseVariantToken(token) {
  if (token === null || token === undefined) return null;
  const text = String(token).trim();
  if (!text || text === 'true' || text === '<NULL>') return null;
  const mul = /^(.*?)mul([0-9.]+)$/.exec(text);
  if (mul) {
    const multiplier = parseFloat(mul[2]);
    return { letter: mul[1], multiplier: Number.isFinite(multiplier) ? multiplier : 1 };
  }
  return { letter: text, multiplier: 1 };
}

/**
 * Some params are not table-driven at all: a discount's whole definition is the
 * number in its script name (`param-CENA_RABAT-0.55.js` compiles to
 * `v = 0.55; CENA_RABAT = v * 1`). For those the reference value IS that
 * constant and no sheet is involved.
 */
function constantFromVariant(variant) {
  if (!variant) return null;
  const value = parseFloat(variant.letter);
  return Number.isFinite(value) && String(value) === String(variant.letter).trim() ? value : null;
}

module.exports = { resolvePriceVariant, parseScriptFileName, constantFromVariant, parseVariantToken };
