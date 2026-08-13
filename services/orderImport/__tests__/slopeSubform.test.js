'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSlopeParams,
  buildSlopeModel,
  buildSlopeDisplayValue,
  isFilledSlopeModel,
  findSourceParamNames,
  loadSubformDefinition,
  parseDictOptions
} = require('../slopeSubform');
const { parseParamDefinitions } = require('../paramVisibility');

// Real group 59 rows (trimmed): the slope field points its SOURCE at itself.
const GROUP_PARAM_TXT = [
  'NAME\tDESCRIPTION\tTYPE\tPROC\tENABLE\tSOURCE\tFORMROW\tLISTROW',
  'MODEL\tMODEL\tdict\t<NULL>\t<NULL>\t<NULL>\t1\t1',
  'WYMIAROWANIE_SLOPOW\tAFMETINGEN VOOR SLOPE\tbutton\t<NULL>\t=WSROD(MODEL,"FSlope1_L,VS4_L")\tWYMIAROWANIE_SLOPOW\t1\t1'
].join('\n');

// Real WYMIAROWANIE_SLOPOW catalog rows (trimmed): TYP is a picture field that
// is never editable (=1=2), the dimensions come and go with the chosen TYP.
const SLOPE_PARAM_TXT = [
  'NAME\tDESCRIPTION\tTYPE\tPROC\tENABLE\tSOURCE\tFORMROW\tLISTROW',
  'TYP\tTYPE\tpicture\t<NULL>\t=1=2\t<NULL>\t1\t1',
  'WYM_B\tB [mm]\tnumeric\t<NULL>\t<NULL>\t<NULL>\t1\t1',
  'WYM_B1\tB1 [mm]\tnumeric\t<NULL>\t=WSROD(TYP,"TYP2,TYP20")\t<NULL>\t1\t1',
  'WYM_H\tH [mm]\tnumeric\t<NULL>\t=WSROD(TYP,"TYP4,TYP5")\t<NULL>\t1\t1',
  'WYM_H1\tH1 [mm]\tnumeric\t<NULL>\t=WSROD(TYP,"TYP1,TYP20")\t<NULL>\t1\t1',
  'WYM_H2\tH2 [mm]\tnumeric\t<NULL>\t=WSROD(TYP,"TYP1,TYP20")\t<NULL>\t1\t1'
].join('\n');

const SLOPE_PARAMDICT_TXT = [
  'ROW_NUM\tTYP_VALUE\tTYP_DESCRIPTION\tTYP_ENABLE\tTYP_PROC',
  '1\tTYP1\tTYP 1\t<NULL>\t<NULL>',
  '2\tTYP20\tTYP 20\t<NULL>\t<NULL>'
].join('\n');

// The catalog is version-pinned, exactly like an asortment group: the form
// reads `data/<SOURCE>/data/versions/<version>/<lang>/`.
const CATALOG_VERSION = '0.3.34';

function fakeCatalog(files = {}) {
  const defaults = {
    [`WYMIAROWANIE_SLOPOW/${CATALOG_VERSION}/nl/param.txt`]: SLOPE_PARAM_TXT,
    [`WYMIAROWANIE_SLOPOW/${CATALOG_VERSION}/nl/paramdict.txt`]: SLOPE_PARAMDICT_TXT
  };
  const all = { ...defaults, ...files };
  return async (sourceName, lang, fileName, version) =>
    all[`${sourceName}/${version || 'current'}/${lang}/${fileName}`] || null;
}

const deps = (files) => ({
  readCatalogFile: fakeCatalog(files),
  readCatalogVersion: async () => CATALOG_VERSION
});

async function definition() {
  return loadSubformDefinition('WYMIAROWANIE_SLOPOW', 'nl', deps());
}

test('findSourceParamNames picks the params whose SOURCE is their own name', () => {
  const defs = parseParamDefinitions(GROUP_PARAM_TXT);
  assert.deepEqual(findSourceParamNames(defs), ['WYMIAROWANIE_SLOPOW']);
  assert.deepEqual(findSourceParamNames(null), []);
});

test('parseDictOptions reads VALUE/DESCRIPTION column pairs', () => {
  const options = parseDictOptions(SLOPE_PARAMDICT_TXT);
  assert.deepEqual(options.TYP, [
    { VALUE: 'TYP1', DESCRIPTION: 'TYP 1' },
    { VALUE: 'TYP20', DESCRIPTION: 'TYP 20' }
  ]);
});

test('buildSlopeModel rebuilds the modal model: values, dict flags, titles, visibility', async () => {
  const model = buildSlopeModel(
    { TYP: 'TYP20', WYM_B: 1232, WYM_B1: 123, WYM_H: '', WYM_H1: 1232, WYM_H2: 500 },
    await definition()
  );

  assert.equal(model.TYP, 'TYP20');
  assert.equal(model.WYM_B, 1232);
  assert.equal(model.WYM_H, '');
  // ___DICT is a boolean — the browser used to leak the whole options array here,
  // which is what produced "[object Object],[object Object],…" in the DB.
  assert.equal(model.TYP___DICT, true);
  assert.equal(model.WYM_B___DICT, false);
  assert.equal(model.TYP___TITLE, 'TYPE');
  assert.equal(model.WYM_B___TITLE, 'B [mm]');
  // Description of the selected option, straight from the catalog paramdict.
  assert.equal(model.TYP___DESCRIPTION, 'TYP 20');
  assert.equal(model.WYM_B___DESCRIPTION, '');
  assert.equal(model.TYP_ALIAS, '');
  // Visibility comes from the sub-form's own ENABLE formulas, evaluated with the
  // whole sub-value set: TYP20 has B1/H1/H2 but no H, and TYP itself is =1=2.
  assert.equal(model.TYP___VISIBLE, false);
  assert.equal(model.WYM_B___VISIBLE, true);
  assert.equal(model.WYM_B1___VISIBLE, true);
  assert.equal(model.WYM_H___VISIBLE, false);
  assert.equal(model.WYM_H1___VISIBLE, true);
});

test('buildSlopeModel ignores the meta keys of an incoming model', async () => {
  const model = buildSlopeModel(
    {
      TYP: 'TYP1',
      WYM_B: 979,
      // stale/wrong meta from an earlier save must not survive
      TYP___DICT: [{ VALUE: 'TYP1' }],
      WYM_B___TITLE: 'nonsense',
      WYM_B___VISIBLE: false
    },
    await definition()
  );

  assert.equal(model.TYP___DICT, true);
  assert.equal(model.WYM_B___TITLE, 'B [mm]');
  assert.equal(model.WYM_B___VISIBLE, true);
});

test('buildSlopeDisplayValue describes the dimensions the way the modal does', async () => {
  const model = buildSlopeModel(
    { TYP: 'TYP20', WYM_B: 1232, WYM_B1: 123, WYM_H1: 1232, WYM_H2: 500 },
    await definition()
  );

  assert.deepEqual(buildSlopeDisplayValue(model), {
    option_value: '',
    option_description: 'TYPE:TYP20 / B:1232 / B1:123 / H1:1232 / H2:500'
  });
});

test('buildSlopeDisplayValue also accepts the modal title map', () => {
  assert.deepEqual(
    buildSlopeDisplayValue({ TYPE: 'TYP20', 'B [mm]': 1232, 'H1 [mm]': 1232 }),
    { option_value: '', option_description: 'TYPE:TYP20 / B:1232 / H1:1232' }
  );
});

test('normalizeSlopeParams rebuilds a slope param in place', async () => {
  const defs = parseParamDefinitions(GROUP_PARAM_TXT);
  const values = {
    MODEL: 'FSlope1_L',
    WYMIAROWANIE_SLOPOW: { TYP: 'TYP1', WYM_B: 979, WYM_H1: 2346, WYM_H2: 1338 }
  };

  const report = await normalizeSlopeParams(values, defs, 'nl', deps());

  assert.equal(report.rebuilt.length, 1);
  assert.deepEqual(report.notes, []);
  assert.equal(values.WYMIAROWANIE_SLOPOW.WYM_B, 979);
  assert.equal(values.WYMIAROWANIE_SLOPOW.WYM_B___TITLE, 'B [mm]');
  assert.equal(
    buildSlopeDisplayValue(values.WYMIAROWANIE_SLOPOW).option_description,
    'TYPE:TYP1 / B:979 / H1:2346 / H2:1338'
  );
});

test('normalizeSlopeParams accepts a JSON-encoded model', async () => {
  const defs = parseParamDefinitions(GROUP_PARAM_TXT);
  const values = { WYMIAROWANIE_SLOPOW: JSON.stringify({ TYP: 'TYP1', WYM_B: 979 }) };

  await normalizeSlopeParams(values, defs, 'nl', deps());

  assert.equal(values.WYMIAROWANIE_SLOPOW.WYM_B, 979);
});

test('normalizeSlopeParams leaves a position without slope dimensions alone', async () => {
  const defs = parseParamDefinitions(GROUP_PARAM_TXT);
  for (const empty of ['', '[object Object]', {}, null]) {
    const values = { WYMIAROWANIE_SLOPOW: empty };
    const report = await normalizeSlopeParams(values, defs, 'nl', deps());
    assert.deepEqual(report.rebuilt, []);
    assert.deepEqual(report.notes, []);
    assert.equal(values.WYMIAROWANIE_SLOPOW, empty);
  }
});

test('normalizeSlopeParams keeps the payload when the catalog is missing', async () => {
  const defs = parseParamDefinitions(GROUP_PARAM_TXT);
  const values = { WYMIAROWANIE_SLOPOW: { TYP: 'TYP1', WYM_B: 979 } };

  const report = await normalizeSlopeParams(values, defs, 'nl', {
    readCatalogFile: async () => null,
    readCatalogVersion: async () => CATALOG_VERSION
  });

  assert.deepEqual(report.rebuilt, []);
  assert.equal(report.notes.length, 1);
  assert.deepEqual(values.WYMIAROWANIE_SLOPOW, { TYP: 'TYP1', WYM_B: 979 });
});

test('isFilledSlopeModel separates a real model from the blank one', async () => {
  const filled = buildSlopeModel({ TYP: 'TYP1', WYM_B: 979 }, await definition());
  const blank = buildSlopeModel({}, await definition());

  assert.equal(isFilledSlopeModel(filled), true);
  assert.equal(isFilledSlopeModel(blank), false);
  assert.equal(isFilledSlopeModel(''), false);
  assert.equal(isFilledSlopeModel(null), false);
});

test('loadSubformDefinition reads the version the app serves, not the current dir', async () => {
  // `versions/` keeps the whole history and its old entries are a different form
  // (0.3.1 has WYM_A…WYM_E), so picking the right version is not cosmetic.
  const OLD_PARAM_TXT = [
    'NAME\tDESCRIPTION\tTYPE\tPROC\tENABLE\tSOURCE',
    'TYP\tTYPE\t<NULL>\t<NULL>\t<NULL>\t<NULL>',
    'WYM_A\tA\tnumeric\t<NULL>\t<NULL>\t<NULL>'
  ].join('\n');

  const definition = await loadSubformDefinition('WYMIAROWANIE_SLOPOW', 'nl', deps({
    'WYMIAROWANIE_SLOPOW/current/nl/param.txt': OLD_PARAM_TXT
  }));

  assert.equal(definition.version, CATALOG_VERSION);
  assert.deepEqual(definition.params.map((p) => p.NAME), ['TYP', 'WYM_B', 'WYM_B1', 'WYM_H', 'WYM_H1', 'WYM_H2']);
});

test('loadSubformDefinition falls back to the unversioned catalog', async () => {
  const definition = await loadSubformDefinition('WYMIAROWANIE_SLOPOW', 'nl', {
    readCatalogVersion: async () => '9.9.9',   // never materialised on disk
    readCatalogFile: async (source, lang, file, version) => {
      if (version) return null;
      return file === 'param.txt' ? SLOPE_PARAM_TXT : SLOPE_PARAMDICT_TXT;
    }
  });

  assert.equal(definition.version, null);
  assert.equal(definition.params.length, 6);
});

test('loadSubformDefinition falls back to pl when the order language has no catalog', async () => {
  const definition = await loadSubformDefinition('WYMIAROWANIE_SLOPOW', 'fr', {
    readCatalogVersion: async () => CATALOG_VERSION,
    readCatalogFile: async (source, lang, file, version) => {
      if (lang !== 'pl' || !version) return null;
      return file === 'param.txt' ? SLOPE_PARAM_TXT : SLOPE_PARAMDICT_TXT;
    }
  });

  assert.equal(definition.version, CATALOG_VERSION);
  assert.equal(definition.params.length, 6);
});
