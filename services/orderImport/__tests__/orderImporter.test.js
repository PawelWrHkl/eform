'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { importResolvedOrder, readQuantity, buildSendAddress } = require('../orderImporter');

test('readQuantity falls back to 1 for missing/invalid values', () => {
  assert.equal(readQuantity({}), 1);
  assert.equal(readQuantity({ ILOSC: 'abc' }), 1);
  assert.equal(readQuantity({ ILOSC: 0 }), 1);
  assert.equal(readQuantity({ ILOSC: -3 }), 1);
});

test('readQuantity reads canonical and Polish-accent variants', () => {
  assert.equal(readQuantity({ ILOSC: 4 }), 4);
  assert.equal(readQuantity({ 'ILOŚĆ': '6' }), 6);
});

test('buildSendAddress maps payload to send_address columns', () => {
  const out = buildSendAddress({
    name: 'Acme', client: 'Acme', address: 'Main 1', city: 'Berlin',
    zip: '10115', country: 'de', phone: '+49', email: 'x@y.z'
  });
  assert.deepEqual(out, {
    name: 'Acme', street: 'Main 1', city: 'Berlin', zip: '10115',
    country: 'de', phone: '+49', email: 'x@y.z'
  });
});

test('buildPersistedParameters keeps all import params and overlays engine prices', () => {
  const { buildPersistedParameters, restoreParametersAfterRecalc } = require('../orderImporter');
  const out = buildPersistedParameters(
    { SZEROKOSC: 1320, WYSOKOSC: 1860, MODEL: 'H50', ILOSC: 1 },
    { MODEL: 'H50', CENA: 276, SZEROKOSC: '', WYSOKOSC: '', SZEROKOSC___VISIBLE: false }
  );
  assert.equal(out.SZEROKOSC, 1320);
  assert.equal(out.WYSOKOSC, 1860);
  assert.equal(out.CENA, 276);
  assert.equal(out.SZEROKOSC___VISIBLE, false);

  // The browser said nothing about SZEROKOSC/WYSOKOSC this time, so an empty
  // value there is an accident and must be restored from the snapshot.
  const afterRecalc = restoreParametersAfterRecalc(out, {
    MODEL: 'H50', CENA: 280, ILOSC: 1
  });
  assert.equal(afterRecalc.SZEROKOSC, 1320);
  assert.equal(afterRecalc.WYSOKOSC, 1860);
  assert.equal(afterRecalc.CENA, 280);
});

test('importResolvedOrder runs the full pipeline with stubs', async () => {
  const calls = { sendAddress: [], order: [], items: [] };

  const ordersDb = {
    async insertSendAddress(addr) { calls.sendAddress.push(addr); return 77; },
    async insertNewOrder(commision, addressId, userId, comment, sendAddressId) {
      calls.order.push({ commision, addressId, userId, comment, sendAddressId });
      return 999;
    }
  };
  const positionsDb = {
    async insertNewForm(formData) {
      calls.items.push(formData);
      return [{ insertId: 1000 + calls.items.length }];
    },
    async reindexOrderPositions() {},
    async updateOrderPrice() {},
    async getAppVersion() { return '1'; }
  };
  const itemBuilder = {
    buildOrderItemStructure(...args) {
      // Project to the keys our importer relies on for the assertions.
      // Signature: order, listPrice, discountPct, discount, unitPrice, totalPrice,
      // totalPriceSub, name, commission, jsonValues, jsonValuesToDisplay, amount,
      // comment, version, groupNumber, lang, department, groupName, shortJson
      return {
        order: args[0],
        amount: args[11],
        groupNumber: args[14],
        lang: args[15],
        department: args[16],
        groupName: args[17],
        jsonValues: args[9],
        jsonValuesToDisplay: args[10]
      };
    }
  };
  const translator = async (params) => {
    // Simulate description→canonical mapping.
    const remap = { Color: 'KOLOR', Quantity: 'ILOSC' };
    const out = {};
    for (const [k, v] of Object.entries(params)) out[remap[k] || k] = v;
    return out;
  };
  const formEngine = {
    async calculatePrices() {
      return {
        values: { KOLOR: 'Black', ILOSC: 3 },
        displayValues: { KOLOR: 'Black', ILOSC: 3 },
        total: { total: 100, total_hidden: 120, total_sub: 0 },
        shortJson: { data: { KOLOR: 'Black' }, order: ['KOLOR'] }
      };
    },
    displayValuesToWireFormat: (dv) => JSON.stringify(Object.entries(dv || {})),
    stubDisplayEntries: (v) => Object.entries(v || {}).map(([k, val]) => [k, { option_value: String(val) }])
  };
  const displayBuilder = async ({ values }) => ({
    KOLOR: {
      param_description: 'Color',
      option_value: values.KOLOR,
      option_description: 'Black',
      row: '1',
      locked: false,
      sub: false
    },
    ILOSC: {
      param_description: 'Quantity',
      option_value: values.ILOSC,
      option_description: '',
      row: '1',
      locked: false,
      sub: false
    }
  });

  const payload = {
    userIdent: 'U1', commission: 'CM-1', comment: 'hi',
    name: 'Acme', address: 'Main 1', city: 'Berlin', zip: '1', country: 'de',
    items: [
      { product: 'SLOPE', commission: 'POS-1',
        parameters: { Color: 'Black', Quantity: 3 } }
    ]
  };
  const user = { id: 42, ident: 'U1' };

  const res = await importResolvedOrder({
    payload, user, lang: 'de',
    deps: {
      orders: ordersDb,
      positions: positionsDb,
      itemBuilder,
      translator,
      formEngine,
      displayBuilder,
      groupNameResolver: async () => 'COSIFLOR',
      departmentNameResolver: async () => 'JALOEZIEËN',
      optionValidator: async () => ({ ok: true, errors: [] }),
      log: () => {}
    }
  });

  assert.equal(res.orderId, 999);
  assert.equal(res.sendAddressId, 77);
  assert.deepEqual(res.itemIds, [1001]);

  assert.equal(calls.sendAddress.length, 1);
  assert.equal(calls.order[0].userId, 42);
  assert.equal(calls.order[0].sendAddressId, 77);
  assert.equal(calls.order[0].commision, 'CM-1');

  assert.equal(calls.items.length, 1);
  assert.equal(calls.items[0].order, 999);
  assert.equal(calls.items[0].groupNumber, 'SLOPE');
  assert.equal(calls.items[0].lang, 'de');
  assert.equal(calls.items[0].department, 'JALOEZIEËN');
  assert.equal(calls.items[0].groupName, 'COSIFLOR');
  assert.equal(calls.items[0].amount, 3);
  // The persisted values carry the engine's description/alias mirror keys
  // alongside the imported params — they are created empty and filled in by the
  // form pipeline, so assert the payload content plus their presence rather
  // than an exact-shape match that breaks whenever a mirror key is added.
  assert.equal(calls.items[0].jsonValues.KOLOR, 'Black');
  assert.equal(calls.items[0].jsonValues.ILOSC, 3);
  assert.equal(calls.items[0].jsonValues.KOLOR___DESCRIPTION, '');
  assert.equal(calls.items[0].jsonValues.ILOSC___DESCRIPTION, '');
  assert.match(calls.items[0].jsonValuesToDisplay, /Color/);
  assert.match(calls.items[0].jsonValuesToDisplay, /Quantity/);
});

test('importResolvedOrder skips send_address when payload has none', async () => {
  let sendAddressCalled = false;
  const ordersDb = {
    async insertSendAddress() { sendAddressCalled = true; return 1; },
    async insertNewOrder() { return 5; }
  };
  const positionsDb = {
    async insertNewForm() { return [{ insertId: 1 }]; },
    async reindexOrderPositions() {},
    async updateOrderPrice() {},
    async getAppVersion() { return '1'; }
  };
  const itemBuilder = { buildOrderItemStructure: () => ({}) };
  const translator = async (p) => p;
  const formEngine = {
    async calculatePrices() {
      return {
        values: { KOLOR: 'X' },
        displayValues: { KOLOR: 'X' },
        total: { total: 0, total_hidden: 0, total_sub: 0 },
        shortJson: {}
      };
    },
    displayValuesToWireFormat: (dv) => JSON.stringify(Object.entries(dv || {})),
    stubDisplayEntries: (v) => Object.entries(v || {}).map(([k, val]) => [k, { option_value: String(val) }])
  };
  const displayBuilder = async ({ values }) => ({ KOLOR: { option_value: values.KOLOR } });

  const res = await importResolvedOrder({
    payload: {
      userIdent: 'U1',
      items: [{ product: 'SLOPE', parameters: { KOLOR: 'X' } }]
    },
    user: { id: 1 },
    lang: 'pl',
    deps: {
      orders: ordersDb,
      positions: positionsDb,
      itemBuilder,
      translator,
      formEngine,
      displayBuilder,
      groupNameResolver: async () => '',
      optionValidator: async () => ({ ok: true, errors: [] }),
      log: () => {}
    }
  });

  assert.equal(sendAddressCalled, false);
  assert.equal(res.sendAddressId, null);
  assert.equal(res.orderId, 5);
});

test('importResolvedOrder throws and inserts nothing when option validation fails', async () => {
  const calls = { sendAddress: 0, order: 0, items: 0 };
  const ordersDb = {
    async insertSendAddress() { calls.sendAddress += 1; return 1; },
    async insertNewOrder() { calls.order += 1; return 5; }
  };
  const positionsDb = {
    async insertNewForm() { calls.items += 1; return [{ insertId: 1 }]; },
    async reindexOrderPositions() {},
    async updateOrderPrice() {},
    async getAppVersion() { return '1'; }
  };
  const itemBuilder = { buildOrderItemStructure: () => ({}) };
  const translator = async (p) => p;
  const formEngine = {
    displayValuesToWireFormat: (dv) => JSON.stringify(Object.entries(dv || {})),
    stubDisplayEntries: (v) => Object.entries(v || {}).map(([k, val]) => [k, { option_value: String(val) }])
  };
  const displayBuilder = async () => ({});

  await assert.rejects(
    importResolvedOrder({
      payload: {
        userIdent: 'U1',
        items: [{ product: 'SLOPE', posid: 7, parameters: { KOLOR: 'nieistniejacy' } }]
      },
      user: { id: 1, ident: 'U1' },
      lang: 'pl',
      deps: {
        orders: ordersDb,
        positions: positionsDb,
        itemBuilder,
        translator,
        formEngine,
        displayBuilder,
        groupNameResolver: async () => '',
        optionValidator: async () => ({
          ok: false,
          errors: ['Parameter "KOLOR": value "nieistniejacy" not found in available options (group SLOPE)']
        }),
        log: () => {}
      }
    }),
    /Parameter validation failed for group SLOPE \(item 7\).*KOLOR.*nieistniejacy/
  );

  // Hard guarantee: a failed validation must not create the order or its items.
  assert.equal(calls.order, 0);
  assert.equal(calls.items, 0);
});

// --- Field visibility from param.txt (ENABLE) -------------------------------
// Regression: order 272169 / group 71 stored DLUGOSC_STER=800 together with
// DLUGOSC_STER___VISIBLE=false — the engine had disabled the field for
// MODEL=BB24 but the import re-injected the value at every step.

const GROUP71_PARAM_TXT = [
  'NAME\tDESCRIPTION\tTYPE\tPROC\tENABLE\tSOURCE\tFORMROW\tLISTROW',
  'MODEL\tMODEL\tdict\t<NULL>\t<NULL>\t<NULL>\t1\t1',
  'WYSOKOSC\tWYSOKOŚĆ [MM]\tnumeric\t<NULL>\t<NULL>\t<NULL>\t1\t1',
  'DLUGOSC_STER\tDŁUGOŚĆ STEROWANIA [MM]\tnumeric\t<NULL>\t=NOT(WSROD(MODEL,"AE10,BB24,DB30"))\t<NULL>\t1\t1'
].join('\n');

function group71Defs() {
  const { parseParamDefinitions } = require('../paramVisibility');
  return parseParamDefinitions(GROUP71_PARAM_TXT);
}

test('seedControlLengthDefault only seeds control-length names the group declares', () => {
  const { seedControlLengthDefault } = require('../orderImporter');

  // Group 71 declares DLUGOSC_STER only — DLUGSTER=800 there is a phantom param.
  const group71 = seedControlLengthDefault({ WYSOKOSC: 1220 }, group71Defs());
  assert.equal(group71.DLUGOSC_STER, 800);
  assert.equal(group71.DLUGSTER, undefined);

  // Without a readable param.txt we cannot tell — keep the old both-names behaviour.
  const unknownGroup = seedControlLengthDefault({ WYSOKOSC: 1220 }, null);
  assert.equal(unknownGroup.DLUGOSC_STER, 800);
  assert.equal(unknownGroup.DLUGSTER, 800);

  // A control length that came with the payload is never overwritten.
  const provided = seedControlLengthDefault({ WYSOKOSC: 1220, DLUGOSC_STER: 1500 }, group71Defs());
  assert.equal(provided.DLUGOSC_STER, 1500);
});

test('importResolvedOrder persists no value for a param disabled by param.txt', async () => {
  const inserted = [];
  const displayCalls = [];

  const positionsDb = {
    async insertNewForm(formData) { inserted.push(formData); return [{ insertId: 1 }]; },
    async reindexOrderPositions() {},
    async updateOrderPrice() {},
    async getAppVersion() { return '0.3.494'; }
  };
  const itemBuilder = {
    buildOrderItemStructure: (...args) => ({ jsonValues: args[9] })
  };
  const formEngine = {
    // Mirrors clearDisabledValues: the disabled field comes back empty with a
    // ___VISIBLE:false verdict next to it.
    async calculatePrices({ values }) {
      return {
        values: {
          ...values,
          DLUGOSC_STER: '',
          DLUGOSC_STER___DESCRIPTION: '',
          DLUGOSC_STER___VISIBLE: false,
          MODEL___VISIBLE: true,
          CENA: 276
        },
        displayValues: { MODEL: { option_value: 'BB24' } },
        total: { total: 276, total_hidden: 276, total_sub: 0 },
        shortJson: { data: {}, order: [] },
        formMeta: { params: [], lockedParams: [], subParams: [], skipCountParams: [] }
      };
    },
    displayValuesToWireFormat: (dv) => JSON.stringify(Object.entries(dv || {})),
    stubDisplayEntries: (v) => Object.entries(v || {}).map(([k, val]) => [k, { option_value: String(val) }])
  };

  await importResolvedOrder({
    payload: {
      userIdent: 'TCN',
      items: [{
        product: '71',
        posid: 1,
        parameters: { MODEL: 'BB24', WYSOKOSC: 1220, DLUGOSC_STER: 900, ILOSC: 1 }
      }]
    },
    user: { id: 1, ident: 'TCN', org_ident: 'TCN' },
    lang: 'pl',
    deps: {
      orders: {
        async insertSendAddress() { return null; },
        async insertNewOrder() { return 2905; }
      },
      positions: positionsDb,
      itemBuilder,
      translator: async (p) => p,
      twinResolver: async (_g, parameters) => ({ parameters, notes: [] }),
      optionValidator: async () => ({ ok: true, errors: [] }),
      formEngine,
      displayBuilder: async (args) => { displayCalls.push(args); return {}; },
      groupNameResolver: async () => 'EOS',
      departmentNameResolver: async () => 'PLISY',
      translationRepo: { async getGroupTranslations() { return { params: {}, paramdict: {} }; } },
      loadClientDescriptions: async () => new Map(),
      readFormParamDefs: async () => group71Defs(),
      log: () => {}
    }
  });

  const values = inserted[0].jsonValues;
  assert.equal(values.DLUGOSC_STER, '');
  assert.equal(values.DLUGOSC_STER___VISIBLE, false);
  assert.equal(values.MODEL, 'BB24');
  assert.equal(values.WYSOKOSC, 1220);
  assert.equal(values.CENA, 276);

  // The display builder must not be told "the customer ordered this" either.
  assert.equal(displayCalls[0].importValues.DLUGOSC_STER, '');
  assert.equal(displayCalls[0].importValues.MODEL, 'BB24');
});

test('restoreParametersAfterRecalc keeps the browser verdict and drops phantom params', () => {
  const { restoreParametersAfterRecalc } = require('../orderImporter');

  const before = {
    MODEL: 'BB24', WYSOKOSC: 1220, SZEROKOSC: 650,
    DLUGOSC_STER: 800,        // disabled for BB24 — must stay empty
    DLUGSTER: 800,            // not a param of group 71 at all
    KOLOR: '6992-W25', KOLOR_ALIAS: '8919-W25'
  };
  const after = {
    MODEL: 'BB24', WYSOKOSC: 1220, SZEROKOSC: '',
    DLUGOSC_STER: '', DLUGOSC_STER___VISIBLE: false,
    KOLOR: '6992-W25', KOLOR_ALIAS: '',
    CENA: 280
  };

  const report = {};
  const out = restoreParametersAfterRecalc(before, after, { defs: group71Defs(), report });

  assert.equal(out.DLUGOSC_STER, '');
  assert.equal(out.DLUGSTER, undefined);
  assert.equal(out.SZEROKOSC, 650);        // blanked without a verdict → accident, restored
  assert.equal(out.KOLOR_ALIAS, '8919-W25');
  assert.equal(out.CENA, 280);
  assert.equal(report.skipped.length, 2);
  assert.match(report.skipped.join(' '), /DLUGOSC_STER \(wyłączone w param\.txt\)/);
  assert.match(report.skipped.join(' '), /DLUGSTER \(brak w param\.txt\)/);
});

test('restoreParametersAfterRecalc drops an alias of a disabled param', () => {
  const { restoreParametersAfterRecalc } = require('../orderImporter');
  const out = restoreParametersAfterRecalc(
    { DLUGOSC_STER: 800, DLUGOSC_STER_ALIAS: '800MM' },
    { DLUGOSC_STER: '', DLUGOSC_STER_ALIAS: '', DLUGOSC_STER___VISIBLE: false }
  );
  assert.equal(out.DLUGOSC_STER, '');
  assert.equal(out.DLUGOSC_STER_ALIAS, '');
});

test('importResolvedOrder seeds price-group descriptions from client_aliases', async () => {
  // Regression: order 272115 / group 71 priced to 0 because the "#1" price group
  // for KOLOR=6877-W32 lives only in the client's alias collection, and because
  // KOLOR___DESCRIPTION was missing entirely (→ #NAME? → gate false → CENA 0).
  const inserted = [];
  const engineInputs = [];

  const formEngine = {
    async calculatePrices({ values }) {
      engineInputs.push(values);
      return {
        values: { ...values, CENA: 108 },
        displayValues: {},
        total: { total: 118.8, total_hidden: 118.8, total_sub: 0 },
        shortJson: { data: {}, order: [] },
        formMeta: { params: [], lockedParams: [], subParams: [], skipCountParams: [] }
      };
    },
    displayValuesToWireFormat: (dv) => JSON.stringify(Object.entries(dv || {})),
    stubDisplayEntries: () => []
  };

  await importResolvedOrder({
    payload: {
      userIdent: 'TCN',
      items: [{
        product: '71',
        posid: 1,
        parameters: { MODEL: 'BB24', KOLOR: '6877-W32', SZEROKOSC: 910, WYSOKOSC: 1160, ILOSC: 1 }
      }]
    },
    user: { id: 1, ident: 'TCN', org_ident: 'HKL' },
    lang: 'nl',
    deps: {
      orders: {
        async insertSendAddress() { return null; },
        async insertNewOrder() { return 2920; }
      },
      positions: {
        async insertNewForm(formData) { inserted.push(formData); return [{ insertId: 1 }]; },
        async reindexOrderPositions() {},
        async updateOrderPrice() {},
        async getAppVersion() { return '0.3.691'; }
      },
      itemBuilder: { buildOrderItemStructure: (...args) => ({ jsonValues: args[9] }) },
      translator: async (p) => p,
      twinResolver: async (_g, parameters) => ({ parameters, notes: [] }),
      optionValidator: async () => ({ ok: true, errors: [] }),
      formEngine,
      displayBuilder: async () => ({}),
      groupNameResolver: async () => 'EOS',
      departmentNameResolver: async () => 'PLISY',
      // translation_dictionary knows MODEL but has no description for this fabric.
      translationRepo: {
        async getGroupTranslations() {
          return { params: {}, paramdict: { MODEL: { BB24: 'BB 24' } } };
        }
      },
      loadClientDescriptions: async (groupNumber, orgIdent, userIdent) => {
        assert.deepEqual([groupNumber, orgIdent, userIdent], ['71', 'HKL', 'TCN']);
        return new Map([
          ['KOLOR', new Map([['6877-W32', { alias: '6877-W32', description: 'PG#1' }]])]
        ]);
      },
      readFormParamDefs: async () => group71Defs(),
      log: () => {}
    }
  });

  // The engine must already see the price group, or it prices at 0 on insert.
  assert.equal(engineInputs[0].KOLOR___DESCRIPTION, 'PG#1');
  assert.equal(engineInputs[0].KOLOR_ALIAS___DESCRIPTION, 'PG#1');

  const values = inserted[0].jsonValues;
  assert.equal(values.KOLOR___DESCRIPTION, 'PG#1');
  assert.equal(values.KOLOR_ALIAS, '6877-W32');
  assert.equal(values.MODEL___DESCRIPTION, 'BB 24');
  assert.equal(values.CENA, 108);
  // Empty description keys for every declared param — the browser recalc reads
  // json_parameters, and a missing key there reproduces the #NAME? failure.
  assert.equal(values.WYSOKOSC___DESCRIPTION, '');
  assert.equal(values.WYSOKOSC_ALIAS___DESCRIPTION, '');
});

// ---------------------------------------------------------------------------
// Sub-form ("slope") params — services/orderImport/slopeSubform.js
// ---------------------------------------------------------------------------

const SLOPE_GROUP_PARAM_TXT = [
  'NAME\tDESCRIPTION\tTYPE\tPROC\tENABLE\tSOURCE\tFORMROW\tLISTROW',
  'MODEL\tMODEL\tdict\t<NULL>\t<NULL>\t<NULL>\t1\t1',
  'WYMIAROWANIE_SLOPOW\tAFMETINGEN VOOR SLOPE\tbutton\t<NULL>\t<NULL>\tWYMIAROWANIE_SLOPOW\t1\t1'
].join('\n');

function slopeGroupDefs() {
  const { parseParamDefinitions } = require('../paramVisibility');
  return parseParamDefinitions(SLOPE_GROUP_PARAM_TXT);
}

/** What the modal (and slopeSubform) produce for a filled slope field. */
function slopeModel() {
  return {
    TYP: 'TYP1', TYP___TITLE: 'TYPE', TYP___DICT: true, TYP___VISIBLE: false,
    WYM_B: 979, WYM_B___TITLE: 'B [mm]', WYM_B___DICT: false, WYM_B___VISIBLE: true
  };
}

/** What an unseeded SourceWindow produces — same shape, no dimensions. */
function blankSlopeModel() {
  return {
    TYP: '', TYP___TITLE: 'TYPE', TYP___DICT: true, TYP___VISIBLE: false,
    WYM_B: '', WYM_B___TITLE: 'B [mm]', WYM_B___DICT: false, WYM_B___VISIBLE: true
  };
}

test('restoreSlopeParams keeps the imported model over the engine blank one', () => {
  const { restoreSlopeParams } = require('../orderImporter');

  const importValues = { MODEL: 'FSlope1_L', WYMIAROWANIE_SLOPOW: slopeModel() };
  // buildPersistedParameters lets any non-empty engine value win, and a blank
  // model is "non-empty" — hence this explicit restore.
  const persisted = { MODEL: 'FSlope1_L', WYMIAROWANIE_SLOPOW: blankSlopeModel() };

  restoreSlopeParams(persisted, importValues, slopeGroupDefs());

  assert.equal(persisted.WYMIAROWANIE_SLOPOW.WYM_B, 979);
  assert.equal(persisted.WYMIAROWANIE_SLOPOW.TYP, 'TYP1');
});

test('restoreParametersAfterRecalc keeps slope dimensions the browser blanked', () => {
  const { restoreParametersAfterRecalc } = require('../orderImporter');

  const out = restoreParametersAfterRecalc(
    { MODEL: 'FSlope1_L', WYMIAROWANIE_SLOPOW: slopeModel() },
    { MODEL: 'FSlope1_L', WYMIAROWANIE_SLOPOW: blankSlopeModel(), CENA: 501 },
    { defs: slopeGroupDefs() }
  );

  assert.equal(out.WYMIAROWANIE_SLOPOW.WYM_B, 979);
  assert.equal(out.CENA, 501);
});

test('restoreParametersAfterRecalc accepts a slope model the browser did fill', () => {
  const { restoreParametersAfterRecalc } = require('../orderImporter');

  const recalculated = { ...blankSlopeModel(), TYP: 'TYP20', WYM_B: 1232 };
  const out = restoreParametersAfterRecalc(
    { MODEL: 'FSlope1_L', WYMIAROWANIE_SLOPOW: slopeModel() },
    { MODEL: 'FSlope1_L', WYMIAROWANIE_SLOPOW: recalculated },
    { defs: slopeGroupDefs() }
  );

  assert.equal(out.WYMIAROWANIE_SLOPOW.WYM_B, 1232);
});

test('restoreSlopeParams overrides the engine ___VISIBLE artefact', () => {
  const { restoreSlopeParams } = require('../orderImporter');

  // The engine never renders a sub-form, so its ___VISIBLE:false says nothing —
  // persisting it would also drop the field from json_parameters_desc.
  const persisted = { WYMIAROWANIE_SLOPOW: '', WYMIAROWANIE_SLOPOW___VISIBLE: false };
  restoreSlopeParams(persisted, { WYMIAROWANIE_SLOPOW: slopeModel() }, slopeGroupDefs());

  assert.equal(persisted.WYMIAROWANIE_SLOPOW___VISIBLE, true);
  assert.equal(persisted.WYMIAROWANIE_SLOPOW.WYM_B, 979);
});

test('restoreParametersAfterRecalc honours a browser verdict of "no slope here"', () => {
  const { restoreParametersAfterRecalc } = require('../orderImporter');

  const out = restoreParametersAfterRecalc(
    { MODEL: 'VS1', WYMIAROWANIE_SLOPOW: slopeModel() },
    { MODEL: 'VS1', WYMIAROWANIE_SLOPOW: '', WYMIAROWANIE_SLOPOW___VISIBLE: false },
    { defs: slopeGroupDefs() }
  );

  assert.equal(out.WYMIAROWANIE_SLOPOW, '');
});
