'use strict';

// Uwagi cennikowego specjalisty 10.11: zakres jak w konfiguratorze (osobna tabela na zakres
// modelu), blok na każdą grupę cenową, nagłówek „40 cm” zamiast „do 40 cm”, „(bez)” = wykluczone.
const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../scriptModel');
const { buildTables, baseContext, resolveAxis } = require('../index');
const { tableView, itemView } = require('../pdf');
const { createRealm } = require('../../formEngine/scriptRunner');

const realm = createRealm();
const evaluate = (f, v) => realm.evaluate(f, v);

const section = (name, token, cells) => [
  `var ${name}=0;`, 'v=0;', 'n=0;',
  `if(evaluateFormula('AND(WSROD(MODEL,"VS2,VS1"),ZAWIERA(KOLOR___DESCRIPTION,"#${token}"))',obj))n=n+1;`,
  "x=evaluateFormula('SZEROKOSC/10',obj);",
  "y=evaluateFormula('WYSOKOSC/10',obj);",
  `if(x<=20){`, `if(y<=100)v=${cells[0]};`, '}',
  `else if(x<=30){`, `if(y<=100)v=${cells[1]};`, '}',
  `${name}=v*n;`,
  `if(${name}!=0){if(CENA_S!="")CENA_S+="+";CENA_S+=""+${name}+"(${name})";}`
];
const SCRIPT = [
  'function f(arg){', 'const obj = JSON.parse(arg);', 'var CENA=0;', 'var CENA_S="";', 'var n=0;', 'var v=0;', 'var x=null;', 'var y=null;',
  ...section('PG0', 0, [10, 20]), ...section('PG1', 1, [11, 21]),
  'CENA=PG0+PG1;', 'return {"CENA":CENA,"CENA_S":CENA_S};', '}', ''
].join('\r\n');

const params = { MODEL: { DEFAULT: '' }, KOLOR: { DEFAULT: '' }, SZEROKOSC: { TYPE: 'numeric' }, WYSOKOSC: { TYPE: 'numeric' } };
const options = {
  MODEL: [
    { VALUE: 'VS1', DESCRIPTION: 'od 12 cm', PROC: '=AND(USTAW("SZEROKOSC","MIN",120),USTAW("SZEROKOSC","MAX",300))' },
    { VALUE: 'VS2', DESCRIPTION: 'od 23 cm', PROC: '=AND(USTAW("SZEROKOSC","MIN",230),USTAW("SZEROKOSC","MAX",300))' }
  ],
  KOLOR: [{ VALUE: 'K0', DESCRIPTION: 'tkanina #0' }, { VALUE: 'K1', DESCRIPTION: 'tkanina #1' }]
};

function tables() {
  const model = sm.parseScript(SCRIPT);
  const notes = [];
  const list = buildTables({
    model, sections: model.sections, params, options, base: baseContext('uid', params), increase: { f: 1, fr: -1 }, evaluate, notes,
    axisOf: (axis) => resolveAxis(axis, options)
  });
  return { list, notes };
}

test('buildTables: modele o różnym min/max dostają osobne tabele z własnym zakresem', () => {
  const { list } = tables();
  assert.equal(list.length, 2);
  const byModel = Object.fromEntries(list.map((t) => [t.options.map((o) => o.value).join(','), t]));
  // VS1 (min 12 cm) zaczyna od progu 20 cm, VS2 (min 23 cm) dopiero od 30 cm — bez pustej kolumny.
  assert.deepEqual(byModel.VS1.widths, [20, 30]);
  assert.deepEqual(byModel.VS2.widths, [30]);
  assert.deepEqual(byModel.VS2.cells, { 0: { '30|100': 20 }, 1: { '30|100': 21 } });
});

test('tableView: blok na grupę cenową (PG 0, PG 1), nagłówki bez „do”', () => {
  const { list } = tables();
  const vs1 = list.find((t) => t.options[0].value === 'VS1');
  const view = tableView(vs1, { params, options, lang: 'pl' });
  assert.deepEqual(view.chunks.map((c) => c.group), ['0', '1']);
  assert.deepEqual(view.chunks[0].heads, [{ value: 20, cm: true }, { value: 30, cm: true }]);
  assert.deepEqual(view.chunks[1].rows, [{ head: { value: 100, cm: true }, cells: ['11', '21'] }]);
});

test('itemView: „(bez)” wymienia wykluczone opcje, nie dozwolone', () => {
  const item = { kind: 'amount', name: 'MPT', amount: 5, filters: [{ param: 'MODEL', options: ['VS1'], negated: true, text: 'NOT(WSROD(MODEL,"VS2"))' }] };
  const view = itemView(item, { params, options, lang: 'pl' });
  assert.equal(view.when[0].negated, true);
  assert.equal(view.when[0].values, 'VS2 – od 23 cm');
});
