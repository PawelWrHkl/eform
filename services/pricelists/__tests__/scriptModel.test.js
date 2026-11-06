'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sm = require('../scriptModel');
const { createRealm, loadScriptRunner } = require('../../formEngine/scriptRunner');

const md5 = (s) => require('crypto').createHash('md5').update(s.toUpperCase()).digest('hex');
const UID_A = md5('KLIENT_A');
const UID_B = md5('KLIENT_B');

// Skrypt w formacie emitera Worker.bas (CRLF jak na udziale): tabela X×Y,
// tabela tylko X, stała, wartość-wzór, powtórzona sekcja (pusta linia zamiast
// `var`), mnożnik wariantu i blok podwyżek z pustą najnowszą gałęzią,
// zdublowanym uid i przecinkiem dziesiętnym.
const SCRIPT = [
  '//var {evaluateFormula}=require("../../lib/formula.js");',
  'function f(arg){',
  'const obj = JSON.parse(arg);',
  'var CENA=0;',
  'var CENA_S="";',
  'var n=0;',
  'var n=0;',
  'var v=0;',
  'var x=null;',
  'var y=null;',
  'var PG1=0;',
  'v=0;',
  'n=0;',
  'if(evaluateFormula(\'AND(WSROD(MODEL,"VS2,VS1"),ZAWIERA(KOLOR___DESCRIPTION,"#1"))\',obj))n=n+1;',
  'if(evaluateFormula(\'AND(WSROD(MODEL,"VS2,VS1"),ZAWIERA(KOLOR_DODATKOWY___DESCRIPTION,"#1"))\',obj))n=n+1;',
  "x=evaluateFormula('SZEROKOSC/10',obj);",
  "y=evaluateFormula('WYSOKOSC/10',obj);",
  'if(x<=50){',
  'if(y<=100)v=10.5;',
  'else if(y<=200)v=12.25;',
  '}',
  'else if(x<=100){',
  'if(y<=100)v=20.1;',
  'else if(y<=200)v=0;',
  '}',
  'PG1=v*n;',
  'if(PG1!=0){if(CENA_S!="")CENA_S+="+";CENA_S+=""+PG1+"(PG1)";}',
  'var LISTWA=0;',
  'v=0;',
  'n=0;',
  'if(evaluateFormula(\'WSROD(LISTWA,"L1")\',obj))n=n+1;',
  "x=evaluateFormula('SZEROKOSC/10',obj);",
  'if(x<=50)v=3;',
  'else if(x<=100)v=6;',
  'LISTWA=v*n;',
  'if(LISTWA!=0){if(CENA_S!="")CENA_S+="+";CENA_S+=""+LISTWA+"(LISTWA)";}',
  'var KLEMM=0;',
  'v=0;',
  'n=0;',
  'if(evaluateFormula(\'WSROD(MONTAZ,"KT")\',obj))n=n+1;',
  'v=evaluateFormula(\'IF(ZAWIERA(MODEL,"VS"),8.38,4.19)\',obj);',
  'KLEMM=v*n;',
  'if(KLEMM!=0){if(CENA_S!="")CENA_S+="+";CENA_S+=""+KLEMM+"(KLEMM)";}',
  'var PVC=0;',
  'v=0;',
  'n=0;',
  'if(evaluateFormula(\'WSROD(ART,"PVCO")\',obj))n=n+1;',
  'v=8.2;',
  'PVC=v*n;',
  'if(PVC!=0){if(CENA_S!="")CENA_S+="+";CENA_S+=""+PVC+"(PVC)";}',
  '',
  'v=0;',
  'n=0;',
  'if(evaluateFormula(\'WSROD(ART,"PVCU")\',obj))n=n+1;',
  'v=8.2;',
  'PVC=v*n;',
  'if(PVC!=0){if(CENA_S!="")CENA_S+="+";CENA_S+=""+PVC+"(PVC)";}',
  'CENA=PG1+LISTWA+KLEMM+PVC;',
  'CENA=CENA*1.2;',
  'var uid = obj.uid;',
  'var date = new Date();',
  'var day = String(date.getDate()).padStart(2, "0");',
  'var month = String(date.getMonth() + 1).padStart(2, "0");',
  'var year = date.getFullYear();',
  'var dateKey = parseInt(`${year}${month}${day}`);',
  'var f=1; fr=-1;',
  'if(dateKey>=20260901){',
  `if(uid=="${UID_B}"){f=f+0,028; fr=0;}`,
  '}else if(dateKey>=20260101){',
  `if(uid=="${UID_A}"){f=f+0.05; fr=0;}`,
  `else if(uid=="${UID_A}"){f=f+0.5; fr=-1;}`,
  `else if(uid=="${UID_B}"){f=f+0.03; fr=-1;}`,
  '}',
  'CENA=CENA*f;',
  'if(fr!=-1)CENA=CENA.toFixed(fr);',
  'if(f!=1)CENA_S="("+CENA_S+")*"+""+f',
  'return {"CENA":CENA,"CENA_S":CENA_S};',
  '}',
  ''
].join('\r\n');

function writeScript(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelist-'));
  const file = path.join(dir, 'param-CENA-Cmul1.2.js');
  fs.writeFileSync(file, text);
  return file;
}

test('parseScript: rozpoznaje wszystkie formy emitera bez nieznanych linii', () => {
  const model = sm.parseScript(SCRIPT);
  assert.deepEqual(model.unknown, []);
  assert.equal(model.param, 'CENA');
  assert.deepEqual(model.sections.map((s) => [s.name, s.value.kind]), [['PG1', 'xy'], ['LISTWA', 'x'], ['KLEMM', 'const'], ['PVC', 'const'], ['PVC', 'const']]);
  assert.deepEqual(model.sum, ['PG1', 'LISTWA', 'KLEMM', 'PVC']);
  assert.deepEqual(model.factor, { op: '*', value: 1.2 });
  assert.equal(model.increase.rounding, true);
  assert.deepEqual(model.increase.branches.map((b) => [b.from, b.rules.length]), [[20260901, 1], [20260101, 3]]);
  assert.match(model.increase.branches[0].rules[0].defect, /przecinek/);
});

test('increaseFor: nowsza pusta gałąź wyłącza starszą, wygrywa pierwsza reguła uid, przecinek = +0', () => {
  const model = sm.parseScript(SCRIPT);
  assert.deepEqual(sm.increaseFor(model, UID_A, 20260815), { f: 1.05, fr: 0, branch: 20260101, rule: model.increase.branches[1].rules[0] });
  assert.equal(sm.increaseFor(model, UID_A, 20261106).f, 1, 'od 01.09 nie ma reguły dla A');
  assert.equal(sm.increaseFor(model, UID_B, 20261106).f, 1, '`f=f+0,028` w JS dodaje 0');
  assert.equal(sm.increaseFor(model, UID_B, 20251231).branch, null);
});

test('finalAmount: mnożnik, podwyżka, toFixed(fr) skryptu i zaokrąglenie przeglądarki', () => {
  const model = sm.parseScript(SCRIPT);
  assert.equal(sm.finalAmount(model, 10.5, { f: 1, fr: -1 }), 12.6);
  assert.equal(sm.finalAmount(model, 10.5, { f: 1.05, fr: 0 }), 13);
  assert.equal(sm.finalAmount(model, 10.5, { f: 1.03, fr: -1 }), 12.98);
});

test('runModel ≡ prawdziwy skrypt w sandboxie dla różnych konfiguracji i dat', () => {
  const model = sm.parseScript(SCRIPT);
  const runner = loadScriptRunner(writeScript(SCRIPT));
  const realm = createRealm();
  const configs = [
    { MODEL: 'VS2', KOLOR___DESCRIPTION: 'Tkanina #1', KOLOR_DODATKOWY___DESCRIPTION: '', SZEROKOSC: 450, WYSOKOSC: 1500 },
    { MODEL: 'VS1', KOLOR___DESCRIPTION: 'Tkanina #1', KOLOR_DODATKOWY___DESCRIPTION: 'Druga #1', SZEROKOSC: 999, WYSOKOSC: 800 },
    { MODEL: 'VS2', KOLOR___DESCRIPTION: '#1', LISTWA: 'L1', MONTAZ: 'KT', SZEROKOSC: 700, WYSOKOSC: 1500 },
    { MODEL: 'F1', MONTAZ: 'KT', ART: 'PVCO', SZEROKOSC: 1200, WYSOKOSC: 3000 },
    { MODEL: 'F1', ART: 'PVCU', SZEROKOSC: 100, WYSOKOSC: 100 }
  ];
  for (const values of configs) {
    for (const [uid, now] of [[UID_A, '2026-08-15T12:00:00'], [UID_A, '2026-11-06T12:00:00'], [UID_B, '2026-05-05T12:00:00'], ['obcy', '2026-11-06T12:00:00']]) {
      const obj = { ...values, uid };
      const script = sm.configuratorRound(runner.run(obj, { now }).CENA, 'CENA');
      const inc = sm.increaseFor(model, uid, sm.dateKeyOf(new Date(now)));
      const mine = sm.runModel(model, obj, (e, v) => realm.evaluate(e, v), inc);
      assert.equal(String(mine.amount), String(script), `${JSON.stringify(obj)} @ ${now}`);
    }
  }
});

test('powtórzona sekcja: ostatni blok nadpisuje wcześniejszy (PVCO nigdy nie jest liczone)', () => {
  const model = sm.parseScript(SCRIPT);
  const realm = createRealm();
  const run = sm.runModel(model, { ART: 'PVCO', uid: 'x' }, (e, v) => realm.evaluate(e, v));
  assert.equal(run.amount, 0);
});

test('parseScript: blok podwyżek bez gałęzi dat to błąd składni JS (grupa 76)', () => {
  const broken = SCRIPT.replace(/var f=1; fr=-1;[\s\S]*?\r\n\}\r\nCENA=CENA\*f;/, 'var f = 1;\r\n}\r\nCENA=CENA*f;');
  const model = sm.parseScript(broken);
  assert.match(model.unknown[0].msg, /bez gałęzi dat/);
  assert.throws(() => loadScriptRunner(writeScript(broken)), /Illegal return statement/);
});

test('lookupEntry: próg-zmienna inna niż oś daje „nieznane”, a nie zmyśloną kwotę', () => {
  const section = { value: { kind: 'y', entries: [{ op: '<=', bound: 100, value: { num: 5 } }, { op: '<=', bound: { ref: 'PG3' }, value: { str: '' } }] } };
  assert.deepEqual(sm.lookupEntry(section, null, 90).value, { num: 5 });
  assert.deepEqual(sm.lookupEntry(section, null, 150), { unknown: 'PG3' });
});
