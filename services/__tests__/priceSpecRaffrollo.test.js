'use strict';

// Raffrollo (grupa 24) w specyfikacji ceny: komplet „szycie + system” rozbity
// na szycie i system, gdy tabela skryptu to potwierdza (services/priceSpec/raffrollo.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { raffrolloItems } = require('../priceSpec/raffrollo');
const { buildOrderPriceSpec } = require('../priceSpec');

/** Sekcja skryptu w gramatyce Worker.bas: tabela X × Y, `cells` = [[x, [[y, v], …]], …]. */
function section(name, condition, axes, cells) {
  return [
    `var ${name}=0;`, 'v=0;', 'n=0;',
    `if(evaluateFormula('${condition}',obj))n=n+1;`,
    `x=evaluateFormula('${axes[0]}',obj);`,
    `y=evaluateFormula('${axes[1]}',obj);`,
    ...cells.flatMap(([xb, rows], i) => [
      `${i ? 'else ' : ''}if(x<=${xb}){`,
      ...rows.map(([yb, v], j) => `${j ? 'else ' : ''}if(y<=${yb})v=${v};`),
      '}'
    ]),
    `${name}=v*n;`,
    `if(${name}!=0){if(CENA_S!="")CENA_S+="+";CENA_S+=""+${name}+"(${name})";}`
  ];
}

// Cennik jak A: komplet = szycie + system (98 + 124 = 222), w drugiej kolumnie celowo nie (250 ≠ 180).
const FABRIC = ['SZEROKOSC/10', 'WYSOKOSC/10'];
const SCRIPT = [
  'function f(arg){', 'const obj = JSON.parse(arg);', 'var CENA=0;', 'var CENA_S="";',
  'var n=0;', 'var v=0;', 'var x=null;', 'var y=null;',
  ...section('SystemLuxan', 'AND(WSROD(KONFIGURACJA,"S"),WSROD(SYSTEM,"L,LXL"))', ['SZER_SYS/10', 'WYS_SYS/10'], [[200, [[100, 124]]], [300, [[100, 100]]]]),
  ...section('SamoSzycie', 'WSROD(KONFIGURACJA,"N")', FABRIC, [[200, [[100, 98]]], [300, [[100, 80]]]]),
  ...section('RRLKV_VS2', 'AND(WSROD(KONFIGURACJA,"S_N"),WSROD(SYSTEM,"L,LXL"))', FABRIC, [[200, [[100, 222]]], [300, [[100, 250]]]]),
  'CENA=SystemLuxan+SamoSzycie+RRLKV_VS2;',
  'return {"CENA":CENA,"CENA_S":CENA_S};', '}'
].join('\n');

function makeDataDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pricespec-rr-'));
  fs.mkdirSync(path.join(root, '24', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, '24', 'data', 'param-CENA-A.js'), SCRIPT);
  return root;
}
const dataDir = makeDataDir();
const kit = (amount, values) => raffrolloItems([{ code: 'RRLKV_VS2', amount }], {
  groupNumber: '24', paramName: 'CENA', dataDir,
  values: { KONFIGURACJA: 'S_N', SYSTEM: 'L', SZEROKOSC: '1500', WYSOKOSC: '1000', ...values }
});

test('RR: komplet rozbity na szycie i system w proporcji tabeli, czynnik _S zostaje', () => {
  const items = kit(244.2, { CENA_S: '(222(RRLKV_VS2))*1.1' });
  assert.deepEqual(items.map((i) => [i.code, i.rr, Math.round(i.amount * 100) / 100]), [
    ['SamoSzycie', 'rr_sewing', 107.8],
    ['SystemLuxan', 'rr_system', 136.4]
  ]);
});

test('RR: bez rozbicia, gdy tabela się nie sumuje albo kwota jest z innej wersji cennika', () => {
  assert.deepEqual(kit(250, { SZEROKOSC: '2500', CENA_S: '250(RRLKV_VS2)' }), [{ code: 'RRLKV_VS2', amount: 250, rr: 'rr_sewing_system' }]);
  assert.deepEqual(kit(230, { CENA_S: '230(RRLKV_VS2)' }), [{ code: 'RRLKV_VS2', amount: 230, rr: 'rr_sewing_system' }]);
});

test('RR: inne grupy bez zmian', () => {
  const items = [{ code: 'RRLKV_VS2', amount: 222 }];
  assert.equal(raffrolloItems(items, { groupNumber: '39', paramName: 'CENA', values: {}, dataDir }), items);
});

test('RR: specyfikacja pokazuje „Szycie” i „System” zamiast kompletu', () => {
  const values = { ILOSC: 1, KONFIGURACJA: 'S_N', SYSTEM: 'L', SZEROKOSC: '1500', WYSOKOSC: '1000', CENA_S: '222(RRLKV_VS2)' };
  const desc = [
    ['SYSTEM', { param_description: 'SYSTEM', option_value: 'L', option_description: 'SYSTEM LUX', row: '1' }],
    ['CENA', { param_description: 'HKL PREIS', option_value: '222', option_description: '', locked: false, row: '2' }]
  ];
  const spec = buildOrderPriceSpec({
    orderDetails: { id: 1 },
    orderItems: [{ asortment_group_number: '24', json_parameters: JSON.stringify(values), json_parameters_desc: JSON.stringify(desc), subParamValues: [] }],
    view: { prices: true, isClient: true, showCatalogPrices: true },
    lang: 'pl', currency: 'EUR', dataDir
  });
  const lines = spec.positions[0].sets[0].sections[0].lines;
  assert.deepEqual(lines.map((l) => [l.label, l.detail, l.amount]), [
    ['Szycie', null, 98],
    ['System', 'SYSTEM: L – SYSTEM LUX', 124]
  ]);
});
