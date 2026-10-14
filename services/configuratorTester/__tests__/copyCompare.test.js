'use strict';

/**
 * Robot kopiowania pozycji (copyLineRunner.js) — wyrocznia „kopia bez zmian
 * = oryginał" (copyCompare.js), przydział przypadków, zgłoszenia i sekcja
 * maila. Część przeglądarkowa chodzi w nocy na żywym :8000.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareSavedPositions, summarizeDifferences, missingDescriptions, sameValue, KIND } = require('../copyCompare');
const { allocateCases, caseFindings, collapseSystemic, refuseReason, summarize } = require('../copyLineRunner');
const { categorize, splitByCategory, CATEGORY } = require('../reportCategories');

function row(values, desc, extra = {}) {
  return {
    json_parameters: JSON.stringify(values),
    json_parameters_desc: JSON.stringify(desc),
    unit_price: '43.53', total_price: '43.53', total_price_sub: '43.53', amount: 1, comment: '',
    ...extra
  };
}

const VERTICAL = {
  values: {
    MODEL: '1R', MODEL___VISIBLE: true, MODEL___DESCRIPTION: 'PAKIET I STEROWANIE PRAWA', MODEL___TITLE: 'MODEL',
    PASEK: 'B2', PASEK___VISIBLE: true, PASEK___DESCRIPTION: '89MM', PASEK___DICT: true,
    SZEROKOSC: 1780, SZEROKOSC___VISIBLE: true,
    ILOSC_PASK: 1, ILOSC_PASK___VISIBLE: true,
    CENA: 43.53, SUB___CENA: 43.53, uid: 'abc'
  },
  desc: [
    ['MODEL', { option_value: '1R', option_description: 'PAKIET I STEROWANIE PRAWA', row: '1' }],
    ['PASEK', { option_value: 'B2', option_description: '89MM', row: '1' }],
    ['SZEROKOSC', { option_value: '1780', row: '1' }],
    ['ILOSC_PASK', { option_value: '1', row: '1' }],
    ['CENA', { option_value: '43.53', row: '2' }]
  ]
};

const clone = (o) => JSON.parse(JSON.stringify(o));

test('kopia identyczna z oryginałem — zero różnic, liczba porównań > 0', () => {
  const r = compareSavedPositions(row(VERTICAL.values, VERTICAL.desc), row(VERTICAL.values, VERTICAL.desc));
  assert.deepEqual(r.differences, []);
  assert.ok(r.compared > 10);
});

test('910 i "910", 43.53 i "43.530", "" i brak klucza to te same wartości', () => {
  assert.ok(sameValue(910, '910'));
  assert.ok(sameValue(43.53, '43.530'));
  assert.ok(sameValue('', undefined));
  assert.ok(!sameValue('0', ''));
  assert.ok(!sameValue('B2', 'B3'));
});

test('zgubione pole (zgłoszenie Ryver) → BRAK_POLA, P1', () => {
  const v = clone(VERTICAL.values);
  v.ILOSC_PASK = '';
  const d = compareSavedPositions(row(VERTICAL.values, VERTICAL.desc), row(v, VERTICAL.desc)).differences;
  assert.deepEqual(d.map((x) => [x.kind, x.field]), [[KIND.MISSING, 'ILOSC_PASK']]);
  const s = summarizeDifferences(d);
  assert.equal(s[0].priority, 'P1');
  assert.match(s[0].text, /zgubione pola: ILOSC_PASK 1 → \(puste\)/);
});

test('opis bez option_value w kopii → OPIS_BEZ_WARTOSCI; ten sam brak w oryginale nie jest winą kopii', () => {
  const broken = clone(VERTICAL.desc);
  delete broken[1][1].option_value;
  const d = compareSavedPositions(row(VERTICAL.values, VERTICAL.desc), row(VERTICAL.values, broken)).differences;
  assert.ok(d.some((x) => x.kind === KIND.NO_OPTION_VALUE && x.field === 'PASEK'));
  assert.deepEqual(missingDescriptions(row(VERTICAL.values, broken)), ['PASEK']);
  const same = compareSavedPositions(row(VERTICAL.values, broken), row(VERTICAL.values, broken)).differences;
  assert.deepEqual(same, []);
});

test('inna cena w parametrach i w kolumnie wiersza → ZMIANA_CENY', () => {
  const v = clone(VERTICAL.values);
  v.CENA = 0;
  const d = compareSavedPositions(row(VERTICAL.values, VERTICAL.desc), row(v, VERTICAL.desc, { unit_price: '0.00' })).differences;
  assert.ok(d.every((x) => x.kind === KIND.PRICE), JSON.stringify(d));
  assert.deepEqual(d.map((x) => x.field).sort(), ['CENA', 'unit_price (kolumna)']);
});

test('zmieniona wartość nie dubluje się jako zmiana opisu; tytuły i flagi słownika są pomijane', () => {
  const v = clone(VERTICAL.values);
  v.MODEL = '2L';
  v.MODEL___DESCRIPTION = 'Controle links';
  v.MODEL___TITLE = 'INNY TYTUŁ';
  v.PASEK___DICT = false;
  const desc = clone(VERTICAL.desc);
  desc[0][1] = { option_value: '2L', option_description: 'Controle links', row: '1' };
  const d = compareSavedPositions(row(VERTICAL.values, VERTICAL.desc), row(v, desc)).differences;
  assert.deepEqual(d.map((x) => `${x.kind}|${x.field}`), [`${KIND.CHANGED}|MODEL`]);
});

test('sam opis zmieniony przy tej samej wartości → ZMIANA_OPISU; pole liczone → ZMIANA_POLA_LICZONEGO', () => {
  const v = clone(VERTICAL.values);
  v.PASEK___DESCRIPTION = '127MM';
  v.SZEROKOSC = 1790;
  const d = compareSavedPositions(row(VERTICAL.values, VERTICAL.desc), row(v, VERTICAL.desc),
    { meta: { calculated: new Set(['SZEROKOSC']), price: new Set(['CENA']) } }).differences;
  assert.deepEqual(d.map((x) => x.kind).sort(), [KIND.CALCULATED, KIND.DESCRIPTION].sort());
});

test('pola VAT / rabatu klienta osobno i nisko (zależą od VAT_ENABLED, nie od kopiowania)', () => {
  const v = clone(VERTICAL.values);
  v.WARTOSC_BRUTTO = 1.91;
  v.WARTOSC_VAT = 0.36;
  const desc = clone(VERTICAL.desc).concat([['VAT', { option_value: '23%', row: '2' }]]);
  const d = compareSavedPositions(row(VERTICAL.values, VERTICAL.desc), row(v, desc)).differences;
  assert.deepEqual([...new Set(d.map((x) => x.kind))], [KIND.VAT]);
  assert.equal(summarizeDifferences(d)[0].priority, 'MEDIUM');
});

test('komentarz porównywany tylko na żądanie („Duplikuj" go przenosi, ostatnia konfiguracja nie)', () => {
  const a = row(VERTICAL.values, VERTICAL.desc, { comment: 'pilne' });
  const b = row(VERTICAL.values, VERTICAL.desc, { comment: '' });
  assert.deepEqual(compareSavedPositions(a, b).differences, []);
  assert.equal(compareSavedPositions(a, b, { compareComment: true }).differences[0].field, 'comment (komentarz)');
});

test('kody KOPIA_* mają własną kategorię raportu, reszta bez zmian', () => {
  assert.equal(categorize('KOPIA_BRAK_POLA'), CATEGORY.COPY);
  assert.equal(categorize('KOPIA_BLAD_TESTU'), CATEGORY.COPY);
  assert.equal(categorize('BLOKADA_ZAPISU'), CATEGORY.DEAD_END);
  const k = splitByCategory([{ code: 'KOPIA_ZMIANA_CENY', priority: 'P1' }, { code: 'NOWY', priority: 'MEDIUM' }]);
  assert.equal(k[CATEGORY.COPY].length, 1);
  assert.equal(k[CATEGORY.OTHER].length, 1);
});

test('przydział przypadków: grupy Ryver podwójnie, tylko grupy widoczne dla konta', () => {
  const plan = allocateCases(['39', '14', '24', '71'], 8, ['14', '24', '59']);
  assert.deepEqual(plan, ['14', '24', '14', '24', '39', '71', '14', '24']);
  assert.deepEqual(allocateCases([], 5), []);
});

test('zgłoszenia z przypadku: kod KOPIA_<rodzaj>, ścieżka i przeglądarka w treści, przerwany przypadek = MEDIUM', () => {
  const findings = caseFindings({
    kind: 'generated', key: 'grupa-14', group: '14', browser: 'chromium', sourceId: 6663, status: 'blad', reason: 'Timeout',
    checks: [{ path: 'ostatnia', iteration: 2, problems: [{ kind: 'BRAK_POLA', priority: 'P1', text: 'zgubione pola: ILOSC_PASK 1 → (puste)', fields: ['ILOSC_PASK'] }] }]
  });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].code, 'KOPIA_BRAK_POLA');
  assert.equal(findings[0].priority, 'P1');
  assert.equal(findings[0].positionId, 6663);
  assert.match(findings[0].message, /Chromium · „wczytaj ostatnią konfigurację" \(kopia 2\) · pozycja wzorcowa #6663/);
  assert.equal(findings[1].code, 'KOPIA_BLAD_TESTU');
  assert.equal(findings[1].priority, 'MEDIUM');
});

test('różnica systemowa (VAT po edycji) w wielu przypadkach = jedno zgłoszenie zbiorcze; reszta bez zmian', () => {
  const vat = (group, id) => ({ code: 'KOPIA_ZMIANA_VAT_RABATU', priority: 'MEDIUM', groupNumber: group, positionId: id,
    message: 'Chromium · „Duplikuj" → edycja → zapis · pozycja wzorcowa #1: pola VAT', copy: { path: 'duplikat', browser: 'chromium' } });
  const out = collapseSystemic([vat('14', 1), vat('24', 2), vat('59', 3), { code: 'KOPIA_BRAK_POLA', priority: 'P1', groupNumber: '14' }]);
  assert.equal(out.length, 2);
  const merged = out.find((f) => f.code === 'KOPIA_ZMIANA_VAT_RABATU');
  assert.match(merged.message, /w 3 przypadkach \(grupy 14, 24, 59/);
  assert.equal(collapseSystemic([vat('14', 1)])[0].groupNumber, '14');
});

test('statystyki: podział na grupy, przeglądarki i ścieżki; „nie dotyczy" nie liczy się jako kontrola', () => {
  const st = summarize([
    { kind: 'generated', group: '14', browser: 'chromium', status: 'bledy', fieldsCompared: 100,
      checks: [{ path: 'ostatnia', problems: [{}] }, { path: 'wymagane', problems: [], notApplicable: 'sam uzupełnił' }] },
    { kind: 'scenario', group: '59', browser: 'chromium', status: 'ok', fieldsCompared: 5, checks: [{ path: 'duplikat', problems: [] }] },
    { kind: 'generated', group: '24', browser: 'chromium', status: 'pominiety', checks: [] }
  ], [{ name: 'chromium' }, { name: 'firefox', skipped: 'nie uruchomiła się' }]);
  assert.equal(st.copyCases, 2);
  assert.equal(st.copyCasesFailed, 1);
  assert.equal(st.copyCasesSkipped, 1);
  assert.equal(st.copyChecks, 2);
  assert.equal(st.byGroup['14'].failed, 1);
  assert.equal(st.byBrowser.firefox.skipped, 'nie uruchomiła się');
  assert.deepEqual(Object.keys(st.byPath).sort(), ['duplikat', 'ostatnia']);
});

test('robot odmawia na produkcji (NODE_ENV=prod, adres produkcji)', () => {
  const saved = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'prod';
    assert.match(refuseReason('http://localhost:8000'), /NODE_ENV=prod/);
    process.env.NODE_ENV = 'test';
    assert.match(refuseReason('http://31.70.87.147:8000'), /produkcja/);
  } finally {
    process.env.NODE_ENV = saved;
  }
});

test('mail: sekcja kopiowania z zakresem, licznikiem narastającym i uwagą o 6 dniach', () => {
  const { buildHtml } = require('../mailer');
  const stats = summarize([
    { kind: 'generated', group: '14', browser: 'chromium', status: 'ok', fieldsCompared: 50, checks: [{ path: 'ostatnia', problems: [] }] }
  ], [{ name: 'chromium' }]);
  stats.durationMin = 1.5;
  stats.history = { since: '2026-10-14T00:00:00Z', runs: 1, cases: 1, checks: 1, failed: 0 };
  const report = {
    finishedAt: '2026-10-14T03:00:00Z', groupsChecked: 1, groups: [{ groupNumber: 'kopiowanie', skipped: false, stats }],
    findings: [{ priority: 'P1', code: 'KOPIA_BRAK_POLA', groupNumber: '14', positionId: 6663, message: 'Chromium · test', copy: {} }],
    totals: { copyCases: 1, copyChecks: 1, copyCasesFailed: 0 }
  };
  const html = buildHtml(report, '/tmp/x.json', new Map([['14', { product: 'VERTIKAL', department: 'VERTIKAL' }]]));
  assert.match(html, /3\. 📋 Kopiowanie pozycji/);
  assert.match(html, /4\. ⚙️ Pozostałe/);
  assert.match(html, /6 dni ciągłej pracy/);
  assert.match(html, /Narastająco od/);
  assert.match(html, /wzorzec #6663/);
  // Bez warstwy kopiowania mail wygląda jak dotąd — trzy sekcje.
  const plain = buildHtml({ finishedAt: '2026-10-14T03:00:00Z', groupsChecked: 1, groups: [], findings: [], totals: {} }, '/tmp/x.json');
  assert.doesNotMatch(plain, /Kopiowanie pozycji/);
  assert.match(plain, /3\. ⚙️ Pozostałe/);
});
