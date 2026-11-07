'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { expectedScriptFile, vbaUid, compareProdukt } = require('../report');

test('expectedScriptFile: nazwa jak w Worker.bas (przecinek → kropka, operator → słowo)', () => {
  assert.equal(expectedScriptFile('CENA', 'C'), 'param-CENA-C.js');
  assert.equal(expectedScriptFile('CENA', 'C*1,2'), 'param-CENA-Cmul1.2.js');
  assert.equal(expectedScriptFile('SUB___DOPLATA_EL', 'P*13,2225'), 'param-SUB___DOPLATA_EL-Pmul13.2225.js');
  assert.equal(expectedScriptFile('CENA', ' c*0,75 '), 'param-CENA-Cmul0.75.js');
});

test('vbaUid: MD5 z bajtów cp1250 — dla ASCII równy eFormowi, dla umlautów inny', () => {
  const utf8 = (s) => crypto.createHash('md5').update(s.toUpperCase()).digest('hex');
  assert.equal(vbaUid('LuxanGmbH'), utf8('LuxanGmbH'));
  assert.notEqual(vbaUid('JC-Köln-Bonner'), utf8('JC-Köln-Bonner'));
  // Sprawdzone na skryptach grupy 43: reguła „EurofiranyGorzów” ma hash cp1250 32fff945…
  assert.ok(vbaUid('EurofiranyGorzów').startsWith('32fff945'));
});

test('compareProdukt: brak w prod.txt, inny skrypt, tylko w prod.txt, twarda spacja w nazwie', () => {
  const produkt = {
    header: ['', '', '', 'Właściciel', 'Użytkownik', 'CENA-WERSJA', 'CENA_RABAT'],
    rows: [
      [null, null, null, 'HKL', 'BD-Line', 'C*1,2', 0],
      [null, null, null, 'LUXANGMBH ', 'Rieper', 'C', 0.6],
      [null, null, null, 'HKL', 'Nowy ', 'C', 0]
    ]
  };
  const prod = {
    used: new Set(['CENA', 'CENA_RABAT']),
    clients: new Map([
      ['HKL/BD-LINE', { org: 'HKL', client: 'BD-Line', scripts: { CENA: 'param-CENA-Cmul1.2.js', CENA_RABAT: 'param-CENA_RABAT-0.js' } }],
      ['LUXANGMBH/RIEPER', { org: 'LUXANGMBH', client: 'Rieper', scripts: { CENA: 'param-CENA-A.js', CENA_RABAT: 'param-CENA_RABAT-0.6.js' } }],
      ['COZY/TYLKO', { org: 'COZY', client: 'Tylko', scripts: { CENA: 'param-CENA-C.js' } }]
    ])
  };
  const diffs = compareProdukt(produkt, prod);
  assert.deepEqual(diffs.differentScript, [{ owner: 'LUXANGMBH', user: 'Rieper', param: 'CENA', produkt: 'param-CENA-C.js', prodTxt: 'param-CENA-A.js' }]);
  assert.deepEqual(diffs.onlyInProdTxt, [{ owner: 'COZY', user: 'Tylko' }]);
  assert.equal(diffs.onlyInProdukt.length, 1);
  // Spacja na końcu WŁAŚCICIELA jest nieszkodliwa (generator robi Trim, uid go nie zawiera);
  // twarda spacja w nazwie KLIENTA wchodzi do hasha uid bez obcięcia — to zgłaszamy.
  assert.deepEqual(diffs.oddNames, [{ owner: 'HKL', user: 'Nowy⍽' }]);
});
