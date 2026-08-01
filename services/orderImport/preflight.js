/**
 * Read-only "preflight" check for an incoming order payload.
 *
 * It runs the exact same validation stages the real import (index.js) performs
 * BEFORE the DB transaction, but never writes anything and never moves files:
 *
 *   1. structural — validateOrderPayload (shape / required fields)
 *   2. alias      — resolvePayloadAliases (KOLOR/MONTAZ/... resolvable against
 *                   translation_dictionary + client_aliases for the client)
 *   3. user       — resolveOrderUser (user exists; language detection)
 *   4. options    — validateParameterValues on the canonical params (the same
 *                   gate that now rejects bad values inside orderImporter)
 *
 * The result is a structured, per-stage report so a CLI / cron can surface
 * *why* a file would be rejected instead of letting it sit silently on the FTP.
 *
 * Pure orchestration over injectable deps — easy to unit-test with stubs.
 */

'use strict';

const { validateOrderPayload } = require('./orderValidator');
const { resolvePayloadAliases } = require('./aliasResolver');
const { resolveOrderUser } = require('./userResolver');
const { translateParametersToCanonical } = require('./parameterTranslator');
const { validateParameterValues } = require('./optionValidator');
const { resolveTwinParameters } = require('./twinParamResolver');

const STAGES = ['structural', 'alias', 'user', 'options'];

function emptyReport(payload) {
  const report = {
    ok: true,
    userIdent: payload && payload.userIdent ? payload.userIdent : null,
    itemCount: Array.isArray(payload && payload.items) ? payload.items.length : 0,
    stages: {},
    errors: []
  };
  for (const stage of STAGES) report.stages[stage] = { ok: true, errors: [] };
  return report;
}

/**
 * @param {object} payload   Parsed order JSON (same shape as the import reads).
 * @param {object} [opts]
 * @param {object} [opts.deps]  Dependency overrides for tests.
 * @returns {Promise<{ok, userIdent, itemCount, stages, errors}>}
 */
async function preflightPayload(payload, { deps = {} } = {}) {
  const validate = deps.validateOrderPayload || validateOrderPayload;
  const resolveAliases = deps.resolvePayloadAliases || resolvePayloadAliases;
  const resolveUser = deps.resolveOrderUser || resolveOrderUser;
  const translate = deps.translator || translateParametersToCanonical;
  const validateOptions = deps.optionValidator || validateParameterValues;
  const twinResolver = deps.twinResolver || resolveTwinParameters;

  const report = emptyReport(payload);

  const fail = (stage, errs) => {
    const list = Array.isArray(errs) ? errs : [errs];
    if (!list.length) return;
    report.stages[stage].ok = false;
    report.stages[stage].errors.push(...list);
    report.ok = false;
    report.errors.push(...list);
  };

  // 1. Structural — if this fails nothing downstream is meaningful.
  const structural = validate(payload);
  if (!structural.ok) {
    fail('structural', structural.errors);
    return report;
  }
  const data = structural.data;

  // 2. Alias resolution (the gate that rejected the previous TCN orders).
  let items = data.items;
  try {
    const aliasResult = await resolveAliases(data.items, data.userIdent);
    items = aliasResult.items;
    fail('alias', aliasResult.errors);
  } catch (err) {
    fail('alias', `alias resolver error: ${err.message}`);
  }

  // 3. User resolution — existence + language (used for option translation).
  let lang = 'pl';
  try {
    const resolved = await resolveUser(data);
    lang = resolved.lang || 'pl';
  } catch (err) {
    fail('user', err.message);
  }

  // 4. Option validation on canonical params — mirrors orderImporter's gate.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const groupNumber = item.product || item.asortment || '';
    try {
      const canonical = await translate(item.parameters || {}, groupNumber, lang);
      // Mirror orderImporter: fix select/input twins before the option gate.
      const { parameters: fixed } = await twinResolver(groupNumber, canonical, lang);
      const check = await validateOptions(groupNumber, fixed, lang);
      if (!check.ok) {
        fail('options', check.errors.map((e) => `Item[${i}] (group=${groupNumber}): ${e}`));
      }
    } catch (err) {
      fail('options', `Item[${i}] (group=${groupNumber}): option validation error: ${err.message}`);
    }
  }

  return report;
}

module.exports = { preflightPayload, STAGES };
