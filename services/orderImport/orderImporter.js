/**
 * Imports a single, already-validated and user-resolved order payload into
 * the eform DB using the same primitives as the regular create-order flow:
 *
 *   - `db.insertSendAddress`  — destination address (send_address row)
 *   - `db.insertNewOrder`     — `order` row (status='active'; order_idx
 *                               assigned by the BEFORE-INSERT trigger)
 *   - `db.insertNewForm`      — one `order_item` row per position
 *   - `db.updateOrderPrice`   — recomputes total_* columns from items
 *
 * Each item's `parameters` is first reverse-translated to canonical Polish
 * keys/values via `parameterTranslator`, so an external system may send the
 * payload in its own language.
 *
 * Quantities default to the value of the canonical `ILOSC` parameter when
 * present, or to 1 — matching `pdfGenerator.readQty`.
 */

const orders = () => require('../../db/orders');
const positions = () => require('../../db/positions');
const itemBuilder = () => require('../itemBuilder');
const formEngine = () => require('../formEngine');
const translationRepo = () => require('../translationDict/dbRepository');
const { translateParametersToCanonical } = require('./parameterTranslator');
const { validateParameterValues } = require('./optionValidator');
const { resolveTwinParameters } = require('./twinParamResolver');
const {
  buildDisplayValuesFromDictionary,
  getProductGroupName,
  getDepartmentName
} = require('./displayValueBuilder');
const log = (...args) => require('../../utils/logging').log(...args);

/**
 * Seed `<PARAM>___DESCRIPTION` from our `translation_dictionary` (paramdict) for
 * every base param value that doesn't already carry one.
 *
 * Why: per-client price scripts (param-CENA-*.js) pick the price group by reading
 * e.g. `KOLOR___DESCRIPTION` and matching a "#N" tag. When that description is
 * absent (e.g. a colour that isn't in the client's loaded option collection), the
 * price silently computes to 0 and the position shows "Według cennika". The import
 * JSON does carry a `___DESCRIPTION`, but the sender's price-group tag can differ
 * from ours, so we source it from our dictionary — the agreed source of truth — and
 * inject it into json_parameters so the post-import browser recalc prices correctly.
 *
 * @param {object} values      Mutated in place; base-param descriptions added.
 * @param {object} paramdict   `{ paramName: { valueKey: description } }`.
 * @returns {object} the same `values` object.
 */
function seedDictionaryDescriptions(values, paramdict) {
  if (!values || !paramdict) return values;
  for (const [key, val] of Object.entries(values)) {
    if (key.includes('___')) continue;      // skip meta keys (___DESCRIPTION/___DICT/…)
    if (key.endsWith('_ALIAS')) continue;    // alias values are handled via base param
    if (val === undefined || val === null || val === '') continue;
    if (typeof val === 'object') continue;
    const descKey = `${key}___DESCRIPTION`;
    // Never clobber a description the engine already resolved.
    if (values[descKey] !== undefined && values[descKey] !== '') continue;
    const byValue = paramdict[key];
    if (!byValue) continue;
    const desc = byValue[String(val)];
    if (desc !== undefined && desc !== null && desc !== '') {
      values[descKey] = desc;
    }
  }
  return values;
}

/**
 * DLUGSTER and DLUGOSC_STER are two names for the same concept ("control
 * length") — mutually exclusive per MODEL (each is only ENABLE'd for a
 * different, non-overlapping set of models, see param.txt), so exactly one of
 * them is ever actually required/validated for a given position. Import
 * payloads sometimes omit both entirely (the sender didn't send a control
 * length), which fails form validation on save (whichever one applies is
 * required, MIN 100 / MAX 6000) and blocks the position from ever being
 * recalculated/saved. When that happens, approximate it from the blind
 * height: 2/3 of WYSOKOSC, rounded down to the nearest hundred. Set both
 * names since we don't know here which model-specific one will actually be
 * enabled — the inactive one is simply never read/validated.
 *
 * @param {object} values  Mutated in place.
 * @returns {object} the same `values` object.
 */
function seedControlLengthDefault(values) {
  if (!values) return values;
  const hasValue = (v) => v !== undefined && v !== null && v !== '';
  if (hasValue(values.DLUGSTER) || hasValue(values.DLUGOSC_STER)) return values;

  const wysokosc = parseFloat(values.WYSOKOSC);
  if (!Number.isFinite(wysokosc)) return values;

  const controlLength = Math.floor((wysokosc * 2 / 3) / 100) * 100;
  values.DLUGSTER = controlLength;
  values.DLUGOSC_STER = controlLength;
  return values;
}

function readQuantity(parameters) {
  if (!parameters) return 1;
  const raw = parameters.ILOSC != null
    ? parameters.ILOSC
    : (parameters['ILOŚĆ'] != null ? parameters['ILOŚĆ'] : parameters.ilosc);
  const qty = Number(raw);
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
}

function buildShortJson(parameters) {
  // Mirrors the loose shape used by sendOrderService for parameters_short.
  return {
    data: { ...parameters },
    order: Object.keys(parameters).sort()
  };
}

/** Keys that should never be copied from import payloads into json_parameters. */
function isMetaParameterKey(key) {
  return key.includes('___') || key.endsWith('_ALIAS_DESCRIPTION');
}

/** Non-meta params from import JSON used to preserve user-provided values. */
function extractImportParams(values) {
  const out = {};
  for (const [key, val] of Object.entries(values || {})) {
    if (isMetaParameterKey(key)) continue;
    if (val === undefined || val === null || val === '') continue;
    out[key] = val;
  }
  return out;
}

/**
 * Build json_parameters for DB insert: import params are the base, engine overlays
 * computed prices and meta flags (___VISIBLE, ___TITLE, …).
 */
function buildPersistedParameters(importValues, engineValues) {
  const out = {};
  for (const [key, val] of Object.entries(importValues || {})) {
    if (isMetaParameterKey(key)) continue;
    out[key] = val;
  }
  for (const [key, val] of Object.entries(engineValues || {})) {
    if (key.includes('___')) {
      out[key] = val;
      continue;
    }
    if (val !== undefined && val !== null && val !== '') {
      out[key] = val;
    }
  }
  return out;
}

/** @deprecated use buildPersistedParameters */
function mergeImportParameters(engineValues, importValues) {
  return buildPersistedParameters(importValues, engineValues);
}

/** Restore params cleared by browser recalculate (Playwright import step). */
function restoreParametersAfterRecalc(before, after) {
  const out = { ...(after || {}) };
  for (const [key, val] of Object.entries(before || {})) {
    if (isMetaParameterKey(key)) continue;
    if (val === undefined || val === null || val === '') continue;
    const current = out[key];
    if (current === undefined || current === null || current === '') {
      out[key] = val;
    }
  }
  return out;
}

async function snapshotOrderParameters(orderId) {
  const { connetToDb } = require('../../db/core');
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      'SELECT id, json_parameters FROM order_item WHERE order_id = ? ORDER BY orderpos',
      [orderId]
    );
    const snapshot = new Map();
    for (const row of rows || []) {
      let params = row.json_parameters;
      if (typeof params === 'string') {
        try { params = JSON.parse(params); } catch { params = {}; }
      }
      snapshot.set(row.id, params || {});
    }
    return snapshot;
  } finally {
    await conn.end();
  }
}

async function restoreOrderParametersAfterRecalc(orderId, snapshot) {
  if (!snapshot || snapshot.size === 0) return 0;
  const { connetToDb } = require('../../db/core');
  const conn = await connetToDb();
  let updated = 0;
  try {
    const [rows] = await conn.query(
      'SELECT id, json_parameters FROM order_item WHERE order_id = ?',
      [orderId]
    );
    for (const row of rows || []) {
      const before = snapshot.get(row.id);
      if (!before) continue;
      let current = row.json_parameters;
      if (typeof current === 'string') {
        try { current = JSON.parse(current); } catch { current = {}; }
      }
      const merged = restoreParametersAfterRecalc(before, current);
      const wire = JSON.stringify(merged);
      if (wire !== JSON.stringify(current || {})) {
        await conn.query(
          'UPDATE order_item SET json_parameters = ? WHERE id = ?',
          [wire, row.id]
        );
        updated += 1;
      }
    }
    return updated;
  } finally {
    await conn.end();
  }
}

function buildSendAddress(payload) {
  return {
    name: payload.name || payload.client || '',
    street: payload.address || '',
    city: payload.city || '',
    zip: payload.zip || '',
    country: payload.country || '',
    phone: payload.phone || '',
    email: payload.email || ''
  };
}

/**
 * @param {object} ctx
 * @param {object} ctx.payload   Output of `resolveOrderUser({ payload }).payload`.
 * @param {object} ctx.user      DB user row from `userResolver`.
 * @param {string} ctx.lang      Language code for parameter translation.
 * @param {object} [ctx.deps]    Dependency injection for tests.
 * @returns {Promise<{orderId: number, sendAddressId: number|null, itemIds: number[]}>}
 */
async function importResolvedOrder({ payload, user, lang, deps = {} }) {
  const ordersDb = deps.orders || orders();
  const positionsDb = deps.positions || positions();
  const builder = deps.itemBuilder || itemBuilder();
  const translator = deps.translator || translateParametersToCanonical;
  const optionValidator = deps.optionValidator || validateParameterValues;
  const twinResolver = deps.twinResolver || resolveTwinParameters;
  const engine = deps.formEngine || formEngine();
  const displayBuilder = deps.displayBuilder || buildDisplayValuesFromDictionary;
  const groupNameResolver = deps.groupNameResolver || getProductGroupName;
  const departmentNameResolver = deps.departmentNameResolver || getDepartmentName;
  const dictRepo = deps.translationRepo || translationRepo();
  const logger = deps.log || log;

  // Per-group+lang paramdict cache so we hit translation_dictionary once per
  // group even when an order has many items of the same product.
  const paramdictCache = new Map();
  async function getParamdict(groupNumber) {
    const cacheKey = `${groupNumber}::${lang || 'pl'}`;
    if (paramdictCache.has(cacheKey)) return paramdictCache.get(cacheKey);
    let paramdict = {};
    try {
      const dict = await dictRepo.getGroupTranslations(groupNumber, lang || 'pl');
      paramdict = (dict && dict.paramdict) || {};
    } catch (err) {
      logger(`seedDictionaryDescriptions: getGroupTranslations failed for group ${groupNumber}: ${err.message}`);
    }
    paramdictCache.set(cacheKey, paramdict);
    return paramdict;
  }

  if (!payload || !user) {
    throw new Error('importResolvedOrder: payload and user are required');
  }

  // 0. Translate + validate every item BEFORE writing anything. This makes the
  // import fail fast (and prevents orphan order/send_address rows) when any
  // parameter value is not a valid option for its group. Validation runs on the
  // canonical params (post-translation) because the option dictionary is keyed
  // by canonical param_name/value_key. Translated params are reused below so we
  // don't translate twice.
  const preparedItems = [];
  for (const item of payload.items) {
    const groupNumber = item.product || item.asortment || '';
    const translatedParams = await translator(item.parameters || {}, groupNumber, lang);

    // Select/input twin pairs (same description, e.g. DLUGOSC_STER vs DLUGSTER)
    // are sent with the same value in both keys; route the value to the twin it
    // is actually valid for before the option gate runs.
    const twinFix = await twinResolver(groupNumber, translatedParams, lang);
    const canonicalParams = twinFix.parameters;
    for (const note of twinFix.notes || []) {
      logger(`orderImport twin params (item ${item.posid != null ? item.posid : '?'}): ${note}`);
    }

    const optionCheck = await optionValidator(groupNumber, canonicalParams, lang);
    if (!optionCheck.ok) {
      throw new Error(
        `Parameter validation failed for group ${groupNumber} (item ${item.posid != null ? item.posid : '?'}): ${optionCheck.errors.join('; ')}`
      );
    }

    preparedItems.push({ item, groupNumber, canonicalParams });
  }

  // 1. Send address — only if any field is non-empty.
  const addr = buildSendAddress(payload);
  let sendAddressId = null;
  if (addr.street || addr.city || addr.name) {
    sendAddressId = await ordersDb.insertSendAddress(addr);
    if (!sendAddressId) throw new Error('insertSendAddress failed');
  }

  // 2. Order header.
  const orderId = await ordersDb.insertNewOrder(
    payload.commission || '',     // commision
    null,                          // delivery_address_id (use send_address only)
    user.id,                       // user_id
    payload.comment || '',         // comment
    sendAddressId,                 // send_address_id
    0,                             // totalPrice (recomputed below)
    null,                          // employee_id
    null,                          // contact_info_id (mailId param name in fn)
    null                           // group_user_id
  );
  if (!orderId) throw new Error('insertNewOrder failed');

  // 3. Items.
  const itemIds = [];
  for (const { item, groupNumber, canonicalParams } of preparedItems) {
    // Resolve form version (mirrors what main.js getAppVersion does in the UI).
    const version = await positionsDb.getAppVersion(
      groupNumber,
      process.env.NODE_ENV || 'dev'
    );
    if (!version) {
      throw new Error(`importResolvedOrder: no app version for group ${groupNumber}`);
    }

    // Filter out meta-fields from values before persisting — they pollute displayValues.
    // Only drop the dictionary/label meta suffixes (___DICT/___TITLE/___VISIBLE/
    // ___DESCRIPTION). SUB___* keys are real sub-price parameters and MUST be kept,
    // otherwise the sub prices (and, via getTotal, the main total) compute to 0.
    const META_SUFFIX = /___(DICT|TITLE|VISIBLE|DESCRIPTION)$/;
    const cleanValues = {};
    for (const [k, v] of Object.entries(canonicalParams)) {
      if (META_SUFFIX.test(k)) continue;
      if (k.endsWith('_ALIAS_DESCRIPTION')) continue;
      cleanValues[k] = v;
    }

    // Re-attach `<PARAM>___DESCRIPTION` price-group tags from our dictionary so
    // the price scripts can resolve the price group (see seedDictionaryDescriptions).
    const paramdict = await getParamdict(groupNumber);
    seedDictionaryDescriptions(cleanValues, paramdict);
    seedControlLengthDefault(cleanValues);

    // Run the full server-side form engine (singlePass) to get authoritative
    // row/locked/sub/listsum and real prices. Falls back to lightweight
    // getFormMeta + stubs when the engine fails (e.g. missing group scripts).
    let priced;
    try {
      priced = await engine.calculatePrices({
        groupNumber,
        version,
        lang,
        values: cleanValues,
        singlePass: true,
        // Required to resolve per-client price scripts (SCRIPTS === 'true' params,
        // e.g. CENA for TCN) — see services/formEngine/clientScripts.js. Without
        // these the script never loads and the price silently persists as blank/0.
        orgIdent: user.org_ident,
        userIdent: user.ident
      });
    } catch (calcErr) {
      logger(`calculatePrices failed for group ${groupNumber}: ${calcErr.message} — falling back to getFormMeta + stub`);
      let formMeta = null;
      try {
        formMeta = await engine.getFormMeta({ groupNumber, version, lang });
      } catch (metaErr) {
        logger(`getFormMeta also failed for group ${groupNumber}: ${metaErr.message}`);
      }
      priced = {
        values: cleanValues,
        displayValues: engine.stubDisplayEntries(cleanValues),
        formMeta,
        total: { total: 0, total_hidden: 0, total_sub: 0 },
        shortJson: buildShortJson(cleanValues)
      };
    }

    const persistedValues = buildPersistedParameters(cleanValues, priced.values);
    // Guarantee the price-group descriptions survive into json_parameters — the
    // post-import browser recalc reads them to select the correct price group.
    seedDictionaryDescriptions(persistedValues, paramdict);

    // Persist displayValues in the same wire format the browser sends:
    // JSON.stringify(Array.from(map.entries())). insertNewForm will JSON.stringify
    // it again, producing the double-encoded shape the GET /:positionId route
    // (and downstream templates) expect.
    const engineDisplayValues = priced.displayValues instanceof Map
      ? Array.from(priced.displayValues.entries())
      : Array.isArray(priced.displayValues)
        ? priced.displayValues
        : Object.entries(priced.displayValues || {});

    const displayValues = await displayBuilder({
      groupNumber,
      lang,
      values: persistedValues,
      displayValues: engineDisplayValues,
      shortJson: priced.shortJson || buildShortJson(persistedValues),
      formMeta: priced.formMeta,
      importValues: cleanValues
    });
    const displayValuesWire = engine.displayValuesToWireFormat(displayValues);
    const groupName = await groupNameResolver(groupNumber, lang)
      || item.product_description
      || '';
    const department = await departmentNameResolver(groupNumber, lang)
      || item.department
      || '';

    const formData = builder.buildOrderItemStructure(
      orderId,                                       // order
      {},                                            // listPrice
      0,                                             // discountPercentage
      0,                                             // discount
      priced.total.total,                            // unitPrice
      priced.total.total_hidden,                     // totalPrice
      priced.total.total_sub,                        // totalPriceSub
      item.commission || payload.commission || '',  // name (used as commission alias)
      item.commission || '',                         // commission
      persistedValues,                             // jsonValues -> json_parameters
      displayValuesWire,                             // jsonValuesToDisplay -> json_parameters_desc
      readQuantity(canonicalParams),                 // amount
      item.comment || '',                            // comment
      version,                                       // version
      groupNumber,                                   // groupNumber -> asortment_group_number
      lang,                                          // lang
      department,                                    // department (localized from DB)
      groupName,                                     // groupName -> group_name
      priced.shortJson || buildShortJson(persistedValues)
    );

    const result = await positionsDb.insertNewForm(formData);
    const insertId = result && result[0] ? result[0].insertId : null;
    if (!insertId) throw new Error(`insertNewForm failed for item ${item.posid}`);
    itemIds.push(insertId);
  }

  // 4. Reindex positions and recompute totals so the order matches what the
  // UI shows for orders created interactively.
  await positionsDb.reindexOrderPositions(orderId);
  await positionsDb.updateOrderPrice(orderId, null);

  logger(`Imported order id=${orderId} for user=${user.ident} positions=${itemIds.length}`);
  return { orderId, sendAddressId, itemIds };
}

module.exports = {
  importResolvedOrder,
  readQuantity,
  buildShortJson,
  buildSendAddress,
  buildPersistedParameters,
  mergeImportParameters,
  extractImportParams,
  restoreParametersAfterRecalc,
  snapshotOrderParameters,
  restoreOrderParametersAfterRecalc,
  seedDictionaryDescriptions
};
