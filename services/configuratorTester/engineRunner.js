/**
 * Thin wrapper around services/formEngine — the ONLY place this tester talks
 * to the real pricing engine. No pricing/validation logic is duplicated here;
 * everything below just drives generateForm/updateProcedure/calculatePrices
 * exactly like the browser (public/scripts/form.js, main.js) does, and reads
 * back whatever those functions already computed (window.inputFlags for
 * accept/reject, window.formValues/getTotal for prices).
 *
 * Read-only: nothing here ever writes to the database.
 */

'use strict';

const formEngine = require('../formEngine');
const { hasRules } = require('../rulesVersion');

/**
 * Czy reguły tej wersji w ogóle są na dysku — cienki alias na
 * `services/rulesVersion.hasRules`, żeby nie mieć dwóch implementacji tej samej
 * reguły w projekcie.
 *
 * ⚠️ Tester CELOWO tylko POMIJA takie pozycje, choć aplikacja od 2026-09-21
 * potrafi podmienić wersję na najnowszą dostępną (`rulesVersion`): przeliczenie
 * archiwalnej pozycji INNYMI regułami i porównanie go z ceną z dnia zamówienia
 * dałoby fałszywe „cena zaniżona". Pomijamy i liczymy — to brak danych
 * historycznych, nie usterka wyceny.
 */
const hasRulesOnDisk = hasRules;

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_e) { return fallback; }
}

/**
 * Decode a saved order_item row into { groupNumber, version, lang, values, displayValues }
 * — the same decoding formEngine.recalculatePosition uses, minus the DB write.
 */
function decodePositionRow(row) {
  const groupNumber = row.asortment_group_number;
  const values = safeJsonParse(row.json_parameters, {});
  const displayValues = safeJsonParse(row.json_parameters_desc, {});
  const shortJson = safeJsonParse(row.parameters_short, {});
  const version = row.ver || shortJson.VERSION || shortJson.version;
  const lang = row.lang || 'pl';
  // Price scripts are per client (prod.txt PARAM_SCRIPTS → param-CENA-<LETTER>.js),
  // so without the owner's identity the engine cannot resolve this position's
  // own price list and silently prices it from a different variant.
  return { groupNumber, version, lang, values, displayValues, orgIdent: row.org_ident, userIdent: row.user_ident };
}

/**
 * Recompute a saved position's prices from scratch (read-only) and compare
 * against what was actually saved — the "cena zaniżona" / "brak ceny" signal
 * from the PDF brief, using a real historical, human-confirmed configuration
 * as its own reference point instead of an external truth table (Faza 2).
 */
async function recomputeFromPositionRow(row, { isGroup = false, withDisplayValues = true } = {}) {
  const { groupNumber, version, lang, values, displayValues, orgIdent, userIdent } = decodePositionRow(row);
  if (!groupNumber || !version) {
    return { ok: false, error: `pozycja #${row.id}: brak groupNumber/version do przeliczenia`, positionId: row.id, groupNumber };
  }

  // Brak reguł tej wersji na dysku → pozycja jest nie do odtworzenia i NIE jest
  // to zgłoszenie (patrz `hasRulesOnDisk`). Osobna flaga, żeby wołający policzył
  // pominięcie zamiast zgłaszać „brak ceny".
  if (!hasRulesOnDisk(groupNumber, version, lang)) {
    return {
      ok: false,
      missingRules: true,
      positionId: row.id,
      groupNumber,
      version,
      lang,
      error: `pozycja #${row.id}: brak reguł wersji ${version}/${lang} na dysku — pozycja archiwalna, pominięta`
    };
  }

  // `isGroup` makes the form build SUB___* (client-facing) params too, so one
  // pass can serve every price param — verified not to change the
  // organization's own CENA/DOPLATA.
  const result = await formEngine.calculatePrices({
    groupNumber, version, lang, values,
    // Seeding the saved display values changes the outcome for some groups, so
    // the caller decides. (The price comparison no longer depends on this: it
    // reads the deployed script instead — see deployedScript.js.)
    displayValues: withDisplayValues ? displayValues : null,
    singlePass: true, orgIdent, userIdent, isGroup
  });

  return {
    ok: true,
    positionId: row.id,
    groupNumber,
    version,
    lang,
    inputValues: values,
    savedTotal: {
      total: parseFloat(row.total_price) || 0,
      total_sub: parseFloat(row.total_price_sub) || 0
    },
    recomputedTotal: result.total,
    result
  };
}

/**
 * Run the SAME recompute twice from the same input values — the "koszyk vs
 * konfiguracja" consistency check (PDF sekcja 2): a deterministic engine must
 * return the identical total both times.
 */
async function recomputeTwice(row) {
  const first = await recomputeFromPositionRow(row);
  if (!first.ok) return { ok: false, error: first.error, positionId: row.id, groupNumber: row.asortment_group_number };
  const second = await recomputeFromPositionRow(row);
  return { ok: true, positionId: row.id, groupNumber: row.asortment_group_number, first, second };
}

/**
 * Boundary test: replay a real historical configuration through the engine,
 * then override ONE numeric field (e.g. SZEROKOSC/WYSOKOSC) with a candidate
 * value and ask the engine's OWN runtime validator (public/scripts/formTools/
 * validateUtils.js validateFormInput -> window.inputFlags[name]) whether it
 * accepts or rejects it. We never guess min/max ourselves — we only read back
 * what the real client-side validation code decided, exactly as a user
 * would see it (red border / blocked "Dalej").
 *
 * @returns {Promise<{ok:true, accepted:boolean}|{ok:false, error:string}>}
 */
async function checkBoundaryAcceptance({ groupNumber, version, lang, baseValues, fieldName, testValue, orgIdent, userIdent }) {
  if (!groupNumber || !version) {
    return { ok: false, error: 'checkBoundaryAcceptance: brak groupNumber/version' };
  }

  const env = await formEngine.bootEngine({ lang: lang || 'pl', orgIdent, userIdent });
  try {
    const initialDisplayValues = new env.window.Map();
    await env.window.__engine.generateForm(version, groupNumber, Object.assign({}, baseValues), initialDisplayValues, true, lang || 'pl', false);

    if (!(fieldName in (env.window.formInputs || {}))) {
      return { ok: false, error: `pole ${fieldName} nie istnieje w tej grupie/wersji formularza` };
    }

    // Cascade the real configuration first so any per-model MIN/MAX validators
    // (populated dynamically by getProcedures() as MODEL etc. get selected)
    // are in place before we test the boundary value. cascadeSinglePass is the
    // same cheap "seed + one updateProcedure" trick calculatePrices() uses in
    // singlePass mode — the full per-key replayValues() loop is unnecessarily
    // expensive here since we only need the final settled state, not to
    // observe every intermediate step.
    await formEngine.cascadeSinglePass(env.window, baseValues, groupNumber);

    // Fire updateProcedure at THIS field, not via cascadeSinglePass: that
    // helper validates whichever param it picks as the cascade entry point, so
    // our field's inputFlags entry could stay at its initial `false` — which is
    // indistinguishable from a real rejection and produced false P1s.
    const input = env.window.formInputs[fieldName];
    env.window.formValues[fieldName] = testValue;
    if (input && 'value' in input) {
      try { input.value = testValue; } catch (_e) { /* read-only */ }
    }
    await env.window.__engine.updateProcedure({
      params: env.window.params || [],
      inputs: env.window.formInputs || {},
      values: env.window.formValues,
      displayValues: env.window.formDisplayValues,
      allOptionsByParameter: env.window.allOptionsByParameter || {},
      options: {},
      name: fieldName,
      value: testValue,
      groupNumber,
      tagName: (input && input.tagName) || 'INPUT',
      filters: {},
      calculatedParams: {},
      flags: { updateInputs: true, validate: true, buildValues: true, updateStates: true, percent: true }
    });

    const overriddenValues = Object.assign({}, env.window.formValues);
    const flag = env.window.inputFlags ? env.window.inputFlags[fieldName] : undefined;
    if (flag === undefined) {
      return { ok: false, error: `brak informacji o walidacji pola ${fieldName} (inputFlags nie ustawione)` };
    }
    const accepted = flag !== false;

    return { ok: true, accepted, fieldName, testValue, finalValues: overriddenValues };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    env.dispose();
  }
}

/**
 * List of option values the engine currently considers available for a
 * param, given a base configuration — used to build "kombinacji"/"losowy"
 * test cases by swapping ONE field for a different legal value rather than
 * inventing values from nothing.
 */
/**
 * Full option entries for several fields at once, from ONE form build.
 *
 * `{ VALUE, DESCRIPTION, ENABLE, PROC, ATTRIBUTES }` — the shape
 * `window.allOptionsByParameter` holds. The DESCRIPTION is the part that
 * matters for pricing and is the reason this exists alongside
 * getAvailableOptionValues(): every price-list section gates on the
 * description, not the value (`ZAWIERA(KOLOR___DESCRIPTION,"#2")`), and for
 * group 73's colours it reads literally "PG #2". Because the engine is booted
 * with the order owner's identity, these descriptions are already the ones
 * THIS client's dictionary/alias collection gives — so a sweep over options
 * does not have to re-derive them from the database and risk disagreeing with
 * what the configurator would show.
 *
 * ENABLE comes along because an option is only offered when its formula holds
 * (`TASMA G01` is `=WSROD(MODEL,"TAPE")`); generating combinations without
 * honouring it would invent configurations no customer can pick.
 */
async function getAvailableOptions({ groupNumber, version, lang, baseValues, fieldNames, orgIdent, userIdent }) {
  const env = await formEngine.bootEngine({ lang: lang || 'pl', orgIdent, userIdent });
  try {
    await env.window.__engine.generateForm(version, groupNumber, Object.assign({}, baseValues), new env.window.Map(), true, lang || 'pl', false);
    const all = env.window.allOptionsByParameter || {};
    const result = {};
    for (const fieldName of fieldNames) {
      const options = all[fieldName];
      if (!Array.isArray(options)) continue;
      result[fieldName] = options
        .filter((opt) => opt && typeof opt === 'object' && opt.VALUE !== undefined && opt.VALUE !== null && opt.VALUE !== '')
        .map((opt) => ({
          value: opt.VALUE,
          description: opt.DESCRIPTION == null ? '' : opt.DESCRIPTION,
          enable: opt.ENABLE == null || opt.ENABLE === '<NULL>' ? null : opt.ENABLE,
          // PROC reconfigures the REST of the form when this option is chosen
          // (MODEL's is `=AND(USTAW("SZEROKOSC","MIN",300),…)`). Its presence
          // is the readable signal that swapping this value in a value set is
          // not equivalent to choosing it in the configurator.
          proc: opt.PROC == null || opt.PROC === '<NULL>' ? null : opt.PROC
        }));
    }
    return result;
  } catch (_err) {
    return {};
  } finally {
    env.dispose();
  }
}

async function getAvailableOptionValues({ groupNumber, version, lang, baseValues, fieldName, orgIdent, userIdent }) {
  const env = await formEngine.bootEngine({ lang: lang || 'pl', orgIdent, userIdent });
  try {
    await env.window.__engine.generateForm(version, groupNumber, Object.assign({}, baseValues), new env.window.Map(), true, lang || 'pl', false);
    const options = (env.window.allOptionsByParameter && env.window.allOptionsByParameter[fieldName]) || [];
    return options
      .map((opt) => (opt && typeof opt === 'object' ? opt.VALUE : opt))
      .filter((v) => v !== undefined && v !== null && v !== '');
  } catch (_err) {
    return [];
  } finally {
    env.dispose();
  }
}

module.exports = {
  hasRulesOnDisk,
  decodePositionRow,
  recomputeFromPositionRow,
  recomputeTwice,
  checkBoundaryAcceptance,
  getAvailableOptionValues,
  getAvailableOptions
};
