/**
 * Imports a single, already-validated and user-resolved order payload into
 * the eform DB using the same primitives as the regular create-order flow:
 *
 *   - `db.insertSendAddress`  — destination address (send_address row)
 *   - `db.insertNewOrder`     — `order` row (status='active'; order_idx is the
 *                               payload's `orderno` when it has one, otherwise
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
const { normalizeOrderNo } = require('./orderValidator');
const { primeClientOverlay } = require('../formEngine/clientScripts');
const { resolveTwinParameters } = require('./twinParamResolver');
const {
  readFormParamDefs,
  clearHiddenParams,
  isHiddenParam,
  VISIBLE_SUFFIX
} = require('./paramVisibility');
const {
  loadClientDescriptions,
  seedParamDescriptions
} = require('./paramDescriptions');
const {
  normalizeSlopeParams,
  findSourceParamNames,
  isFilledSlopeModel
} = require('./slopeSubform');
const {
  buildDisplayValuesFromDictionary,
  getProductGroupName,
  getDepartmentName
} = require('./displayValueBuilder');
const log = (...args) => require('../../utils/logging').log(...args);

/**
 * Seed `<PARAM>___DESCRIPTION` from our `translation_dictionary` (paramdict) only.
 *
 * Kept as the dictionary-only entry point; the import flow uses
 * `paramDescriptions.seedParamDescriptions`, which adds `client_aliases` (the
 * client's own price-group tags) and guarantees the description keys exist — see
 * that module for why both matter for pricing.
 *
 * @param {object} values      Mutated in place; base-param descriptions added.
 * @param {object} paramdict   `{ paramName: { valueKey: description } }`.
 * @returns {object} the same `values` object.
 */
function seedDictionaryDescriptions(values, paramdict) {
  if (!values || !paramdict) return values;
  seedParamDescriptions(values, { paramdict, ensureKeys: false });
  return values;
}

/** The two interchangeable names for "control length" (see below). */
const CONTROL_LENGTH_PARAMS = ['DLUGSTER', 'DLUGOSC_STER'];

/**
 * DLUGSTER and DLUGOSC_STER are two names for the same concept ("control
 * length") — mutually exclusive per MODEL (each is only ENABLE'd for a
 * different, non-overlapping set of models, see param.txt), so exactly one of
 * them is ever actually required/validated for a given position. Import
 * payloads sometimes omit both entirely (the sender didn't send a control
 * length), which fails form validation on save (whichever one applies is
 * required, MIN 100 / MAX 6000) and blocks the position from ever being
 * recalculated/saved. When that happens, approximate it from the blind
 * height: 2/3 of WYSOKOSC, rounded down to the nearest hundred.
 *
 * Only names the group's `param.txt` actually declares are seeded: group 71
 * ships `DLUGOSC_STER` only, and a stray `DLUGSTER=800` there is a phantom
 * param no form will ever show, validate or clear. Which of the declared ones
 * is *enabled* for this MODEL is not decided here — the disabled one is blanked
 * right after the engine run (see `clearHiddenParams` in `importResolvedOrder`).
 *
 * @param {object} values                        Mutated in place.
 * @param {Map<string, object>|null} [paramDefs] `param.txt` definitions; when
 *                                               absent both names are seeded.
 * @returns {object} the same `values` object.
 */
function seedControlLengthDefault(values, paramDefs = null) {
  if (!values) return values;
  const hasValue = (v) => v !== undefined && v !== null && v !== '';
  if (hasValue(values.DLUGSTER) || hasValue(values.DLUGOSC_STER)) return values;

  const wysokosc = parseFloat(values.WYSOKOSC);
  if (!Number.isFinite(wysokosc)) return values;

  const targets = paramDefs
    ? CONTROL_LENGTH_PARAMS.filter((name) => paramDefs.has(name))
    : CONTROL_LENGTH_PARAMS;
  if (!targets.length) return values;

  const controlLength = Math.floor((wysokosc * 2 / 3) / 100) * 100;
  for (const name of targets) {
    values[name] = controlLength;
  }
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
 *
 * An empty engine value never overwrites an import value here — "the engine
 * computed nothing" must not wipe what the customer ordered. Values the engine
 * blanked *on purpose* (disabled by an ENABLE formula) are handled separately,
 * from the `___VISIBLE` flags, by `paramVisibility.clearHiddenParams`.
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

/**
 * Put the rebuilt sub-form ("slope") models back after the engine merge.
 *
 * `buildPersistedParameters` lets any non-empty engine value win, and the
 * engine's own `SourceWindow` always returns an object — an *empty* one, since
 * nothing seeds it with the payload. That object is non-empty as far as the
 * merge is concerned, so it would silently replace the dimensions the customer
 * ordered. The model built by `slopeSubform` from the payload is authoritative.
 *
 * @param {object} persisted                     mutated in place
 * @param {object} importValues                  values holding the rebuilt models
 * @param {Map<string, object>|null} paramDefs   the group's `param.txt` defs
 * @returns {object} the same `persisted` object
 */
function restoreSlopeParams(persisted, importValues, paramDefs) {
  if (!persisted || !importValues) return persisted;
  for (const name of findSourceParamNames(paramDefs)) {
    const model = importValues[name];
    if (model && typeof model === 'object' && !Array.isArray(model)) {
      persisted[name] = model;
      // The engine never rendered this field (see paramVisibility.isSubformParam),
      // so its `___VISIBLE:false` is an artefact, not a verdict — and persisting
      // it would drop the field from the display values too. We hold a filled
      // sub-form from the payload, so the field applies; the browser recalc
      // corrects this later if the configuration says otherwise.
      if (isFilledSlopeModel(model)) persisted[`${name}${VISIBLE_SUFFIX}`] = true;
    }
  }
  return persisted;
}

/** @deprecated use buildPersistedParameters */
function mergeImportParameters(engineValues, importValues) {
  return buildPersistedParameters(importValues, engineValues);
}

/**
 * Restore params the browser recalculate (Playwright import step) left empty
 * *by accident* — and keep the ones it emptied *on purpose*.
 *
 * The browser runs the real form: whatever it blanked while reporting
 * `<PARAM>___VISIBLE:false` is a field param.txt disables for this
 * configuration (e.g. DLUGOSC_STER on MODEL=BB24), exactly as a manual admin
 * save would leave it. Restoring those from the pre-recalc snapshot is what used
 * to resurrect values the engine had correctly cleared, so they are skipped —
 * and any that slipped through earlier are blanked at the end.
 *
 * Params the form does not know at all (absent from `param.txt` *and* from the
 * browser's own value set, e.g. `DLUGSTER` in group 71) are dropped too: no form
 * will ever render, validate or clear them.
 *
 * @param {object} before                        pre-recalc json_parameters
 * @param {object} after                         post-recalc json_parameters
 * @param {object} [opts]
 * @param {Map<string, object>|null} [opts.defs] `param.txt` definitions of the item's group
 * @param {object} [opts.report]                 mutated with `{skipped, cleared}` for logging
 * @returns {object} merged params
 */
function restoreParametersAfterRecalc(before, after, opts = {}) {
  const { defs = null, report = null } = opts;
  const out = { ...(after || {}) };
  const skipped = [];

  // Sub-form ("slope") params are objects, so the "the browser left it empty"
  // test below never fires for them: a blank model — what the form produces when
  // its SourceWindow could not be seeded — looks just as non-empty as a filled
  // one. Compare the models themselves and keep the dimensions we imported.
  for (const name of findSourceParamNames(defs)) {
    // The browser did render the sub-form, so a `___VISIBLE:false` from it is a
    // real verdict ("this configuration has no slope") and must be honoured.
    if (isHiddenParam(out, name)) continue;
    if (isFilledSlopeModel(before && before[name]) && !isFilledSlopeModel(out[name])) {
      out[name] = before[name];
    }
  }

  for (const [key, val] of Object.entries(before || {})) {
    if (isMetaParameterKey(key)) continue;
    if (val === undefined || val === null || val === '') continue;
    const current = out[key];
    if (!(current === undefined || current === null || current === '')) continue;

    // An alias follows the visibility of its base param (KOLOR_ALIAS → KOLOR).
    const baseName = key.endsWith('_ALIAS') ? key.slice(0, -'_ALIAS'.length) : key;

    if (isHiddenParam(out, baseName)) {
      skipped.push(`${key} (wyłączone w param.txt)`);
      continue;
    }
    if (defs && !defs.has(baseName) && !Object.prototype.hasOwnProperty.call(out, baseName)) {
      skipped.push(`${key} (brak w param.txt)`);
      continue;
    }

    out[key] = val;
  }

  // `defs` is required, not optional: without param.txt we cannot tell an
  // ENABLE-disabled field from a FORMROW=0 one, and nothing may be cleared.
  const { cleared } = clearHiddenParams(out, { trustAll: true, defs });

  if (report) {
    report.skipped = skipped;
    report.cleared = cleared;
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

async function restoreOrderParametersAfterRecalc(orderId, snapshot, deps = {}) {
  if (!snapshot || snapshot.size === 0) return 0;
  const logger = deps.log || log;
  const readDefs = deps.readFormParamDefs || readFormParamDefs;
  const slopeNormalizer = deps.normalizeSlopeParams || normalizeSlopeParams;
  const { connetToDb } = require('../../db/core');
  const conn = await connetToDb();
  let updated = 0;
  try {
    const [rows] = await conn.query(
      'SELECT id, asortment_group_number, lang, json_parameters FROM order_item WHERE order_id = ?',
      [orderId]
    );
    for (const row of rows || []) {
      const before = snapshot.get(row.id);
      if (!before) continue;
      let current = row.json_parameters;
      if (typeof current === 'string') {
        try { current = JSON.parse(current); } catch { current = {}; }
      }
      const defs = row.asortment_group_number
        ? await readDefs(String(row.asortment_group_number), row.lang || 'pl')
        : null;
      const report = {};
      const merged = restoreParametersAfterRecalc(before, current, { defs, report });
      // Rebuild the sub-form models from their catalog: whoever filled the
      // dimensions (payload or browser) keeps them, but the meta comes out clean
      // — a browser that still runs the old `processSourceValues` writes the
      // whole option array into `<SUB>___DICT`.
      await slopeNormalizer(merged, defs, row.lang || 'pl');
      if (report.skipped && report.skipped.length) {
        logger(`Import visibility: position ${row.id} — nie przywrócono ${report.skipped.join(', ')}`);
      }
      if (report.cleared && report.cleared.length) {
        logger(`Import visibility: position ${row.id} — wyczyszczono wyłączone pole(a) ${report.cleared.join(', ')}`);
      }
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
 * @param {object} [ctx.deps]    Dependency injection for tests. A payload with
 *                               `orderno` needs the transactional `orders`
 *                               (findOrderByIdx, hasExternalOrderIdxColumn).
 * @returns {Promise<{orderId: number, orderIdx: string|null, sendAddressId: number|null,
 *   itemIds: number[], warnings: string[]}>}
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
  const paramDefsReader = deps.readFormParamDefs || readFormParamDefs;
  const clientDescriptionsLoader = deps.loadClientDescriptions || loadClientDescriptions;
  const slopeNormalizer = deps.normalizeSlopeParams || normalizeSlopeParams;
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

  // Price-group tags from the client's own alias collection (client_aliases ∩
  // paramdict_aliases_config). For many fabrics this is the ONLY place the "#N"
  // price group exists — translation_dictionary has NULL there — so without it
  // every price script matches no block and the position prices to 0.
  const clientDescriptionsCache = new Map();
  async function getClientDescriptions(groupNumber) {
    if (clientDescriptionsCache.has(groupNumber)) return clientDescriptionsCache.get(groupNumber);
    let descriptions = new Map();
    try {
      descriptions = await clientDescriptionsLoader(groupNumber, user.org_ident, user.ident);
    } catch (err) {
      logger(`loadClientDescriptions failed for group ${groupNumber} (${user.org_ident}/${user.ident}): ${err.message}`);
    }
    clientDescriptionsCache.set(groupNumber, descriptions);
    return descriptions;
  }

  // `param.txt` definitions (NAME + ENABLE) per group+lang — the source of truth
  // for which fields exist at all and which ENABLE formulas drive their
  // visibility. Cached the same way as the paramdict above.
  const paramDefsCache = new Map();
  async function getParamDefs(groupNumber) {
    const cacheKey = `${groupNumber}::${lang || 'pl'}`;
    if (paramDefsCache.has(cacheKey)) return paramDefsCache.get(cacheKey);
    let defs = null;
    try {
      defs = await paramDefsReader(groupNumber, lang || 'pl');
    } catch (err) {
      logger(`readFormParamDefs failed for group ${groupNumber}: ${err.message}`);
    }
    if (!defs) {
      logger(`WARN: no readable param.txt for group ${groupNumber} (${lang || 'pl'}) — `
        + 'pola wyłączone formułą ENABLE nie zostaną wyczyszczone przy zapisie');
    }
    paramDefsCache.set(cacheKey, defs);
    return defs;
  }

  if (!payload || !user) {
    throw new Error('importResolvedOrder: payload and user are required');
  }

  const warnings = [];

  // The client's own order number becomes our order_idx, so the order carries
  // the same number in eForm, in the production file `<org>_<user>_<order_idx>`
  // and in the production statuses keyed by it. A number this client already
  // has would make two orders share all of that — refuse the file instead.
  let externalOrderIdx = normalizeOrderNo(payload.orderno);
  if (externalOrderIdx && !(await ordersDb.hasExternalOrderIdxColumn())) {
    // Without the migration the trigger would count this number and give the
    // client's next manual order the one right after it — a number from the
    // client's own range. Keep eForm numbering until the migration is in.
    const warning = `Numer zlecenia klienta ${externalOrderIdx} NIE został użyty — brak migracji `
      + 'migrations/add_order_idx_external.sql, zamówienie dostało numer eForm.';
    logger(`WARN: ${warning}`);
    warnings.push(warning);
    externalOrderIdx = null;
  }
  if (externalOrderIdx) {
    const existing = await ordersDb.findOrderByIdx(user.id, externalOrderIdx);
    if (existing) {
      throw new Error(
        `Order number ${externalOrderIdx} already exists for client ${user.ident} `
        + `(order id=${existing.id}, status=${existing.status}) — not importing it again`
      );
    }
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

  // 2. Order header. Only the transactional insert takes the options argument —
  // db/orders.js would read a 10th argument as created_by_group_user_id.
  const insertOptions = externalOrderIdx ? [{ orderIdx: externalOrderIdx }] : [];
  const orderId = await ordersDb.insertNewOrder(
    payload.commission || '',     // commision
    null,                          // delivery_address_id (use send_address only)
    user.id,                       // user_id
    payload.comment || '',         // comment
    sendAddressId,                 // send_address_id
    0,                             // totalPrice (recomputed below)
    null,                          // employee_id
    null,                          // contact_info_id (mailId param name in fn)
    null,                          // group_user_id
    ...insertOptions
  );
  if (!orderId) throw new Error('insertNewOrder failed');
  const orderIdx = externalOrderIdx || await ordersDb.getOrderNo(orderId) || null;

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
    const paramDefs = await getParamDefs(groupNumber);
    const clientDescriptions = await getClientDescriptions(groupNumber);
    const descriptionSources = {
      paramdict,
      clientDescriptions,
      paramDefs,
      sourceValues: canonicalParams
    };
    const { seeded } = seedParamDescriptions(cleanValues, descriptionSources);
    if (seeded.length) {
      logger(`orderImport descriptions (item ${item.posid != null ? item.posid : '?'}, group ${groupNumber}): `
        + `uzupełniono opisy (grupy cenowe) ${seeded.join(', ')}`);
    }
    seedControlLengthDefault(cleanValues, paramDefs);

    // Rebuild sub-form ("slope") params — a whole nested form inside one field —
    // from the payload, the way the browser modal does. The engine's own
    // SourceWindow starts empty and would otherwise overwrite the imported
    // dimensions with a blank model (see slopeSubform.js).
    const slopeReport = await slopeNormalizer(cleanValues, paramDefs, lang);
    if (slopeReport.rebuilt.length) {
      logger(`orderImport slope (item ${item.posid != null ? item.posid : '?'}, group ${groupNumber}): `
        + `zbudowano podformularz ${slopeReport.rebuilt.join('; ')}`);
    }
    for (const note of slopeReport.notes || []) {
      logger(`orderImport slope (item ${item.posid != null ? item.posid : '?'}, group ${groupNumber}): ${note}`);
    }

    // Klienci zakładani w eFormie nie mają wpisów w `prod.txt` (ten plik generuje
    // aplikacja zewnętrzna), więc ich cennik siedzi w nakładce `customer_group_terms`.
    // `getClientScripts` czyta ją synchronicznie z pamięci — trzeba ją wsypać PRZED
    // uruchomieniem silnika, inaczej `selectPrices()` nie znajdzie skryptu ceny
    // i pozycja policzy się na 0.
    try {
      await primeClientOverlay({
        userId: user.id,
        orgIdent: user.org_ident,
        userIdent: user.ident,
        groupNumber
      });
    } catch (overlayErr) {
      logger(`primeClientOverlay failed for user ${user.ident} / group ${groupNumber}: ${overlayErr.message}`);
    }

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
    restoreSlopeParams(persistedValues, cleanValues, paramDefs);

    // Honour the ENABLE formulas: blank every param the engine reported as
    // disabled for this configuration (`<PARAM>___VISIBLE:false`), which
    // buildPersistedParameters cannot do on its own — an empty engine value is
    // indistinguishable there from "nothing computed". Only verdicts the engine
    // could actually reach are trusted (see paramVisibility); the rest is decided
    // by the browser recalc that runs right after the commit.
    const visibilityOpts = {
      visibility: priced.values,
      defs: paramDefs,
      inputValues: cleanValues
    };
    const { cleared } = clearHiddenParams(persistedValues, visibilityOpts);
    if (cleared.length) {
      logger(`orderImport visibility (item ${item.posid != null ? item.posid : '?'}, group ${groupNumber}): `
        + `wyczyszczono pole(a) wyłączone w param.txt: ${cleared.join(', ')}`);
    }
    // The display builder treats import params as "the customer ordered this, keep
    // it visible" — so it must see the cleaned set, not the raw payload.
    const displayImportValues = clearHiddenParams({ ...cleanValues }, visibilityOpts).values;

    // Guarantee the price-group descriptions survive into json_parameters — the
    // post-import browser recalc reads them to select the correct price group, and
    // the empty `___DESCRIPTION` keys keep its formulas from hitting `#NAME?`.
    seedParamDescriptions(persistedValues, descriptionSources);

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
      importValues: displayImportValues
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

  logger(`Imported order id=${orderId} nr=${orderIdx}${externalOrderIdx ? ' (orderno klienta)' : ''} `
    + `for user=${user.ident} positions=${itemIds.length}`);
  return { orderId, orderIdx, sendAddressId, itemIds, warnings };
}

module.exports = {
  importResolvedOrder,
  readQuantity,
  buildShortJson,
  buildSendAddress,
  buildPersistedParameters,
  restoreSlopeParams,
  mergeImportParameters,
  extractImportParams,
  restoreParametersAfterRecalc,
  snapshotOrderParameters,
  restoreOrderParametersAfterRecalc,
  seedDictionaryDescriptions,
  seedControlLengthDefault
};
