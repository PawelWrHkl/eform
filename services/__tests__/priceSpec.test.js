'use strict';

/**
 * Specyfikacja ceny zlecenia (services/priceSpec) — prośba szefa 2026-10-16:
 * „cena z cennika głównego i wszystkie dopłaty, każda dopłata rozpisana,
 * podsumowanie ceny pozycji" — a klient NIE może zobaczyć czynników (np. *1,3).
 *
 * Pilnujemy:
 *  • parsera wyrażeń `<PARAM>_S` na wszystkich kształtach spotykanych w bazie,
 *  • rozkładu na kwotę WIDOCZNĄ w zleceniu (suma co do grosza, zero czynników),
 *  • widoczności zestawów cen 1:1 z templates/order.njk (per rola i kłódka),
 *  • nazw składników z warunków skryptu cennika (jak formula.js),
 *  • kompletu tłumaczeń w 5 językach.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseSpecExpression, allocateToTotal } = require('../priceSpec/expression');
const { extractCodeConditions, conditionHolds, labelForCode, clearCache } = require('../priceSpec/scriptLabels');
const { buildOrderPriceSpec, resolveSetVisibility, toNumber, priceGroupOf } = require('../priceSpec');
const { STRINGS } = require('../priceSpec/i18n');
const { resolveScriptsByGroup } = require('../priceSpec/orderContext');

const codes = (expr) => parseSpecExpression(expr).items.map((i) => [i.code, Math.round(i.amount * 10000) / 10000]);

// ── parser ────────────────────────────────────────────────────────────────
test('parser: wszystkie kształty z bazy, czynnik przeniesiony na składniki', () => {
  assert.deepEqual(codes('267(PLISOWANE)'), [['PLISOWANE', 267]]);
  assert.deepEqual(codes('(42.06(SCHIENE89))*1.035'), [['SCHIENE89', 43.5321]]);
  assert.deepEqual(codes('(195(RRLKV2)+127(PG1))*1.035'), [['RRLKV2', 201.825], ['PG1', 131.445]]);
  assert.deepEqual(codes('469(M67)+20(P01)+34(R02)+216(A07)'), [['M67', 469], ['P01', 20], ['R02', 34], ['A07', 216]]);
  assert.deepEqual(codes('(55(A)+-12(B))*1.1'), [['A', 60.5], ['B', -13.2]]);
  assert.deepEqual(codes('()*1.035'), []);
  assert.deepEqual(codes(''), []);
  assert.deepEqual(codes(null), []);
});

test('parser: rabat `x(VALUE)`, powtórzony kod zsumowany, śmieci bez wyjątku', () => {
  const rabat = parseSpecExpression('0.6(VALUE)');
  assert.equal(rabat.isFraction, true);
  assert.deepEqual(rabat.items, []);
  assert.deepEqual(codes('10(A)+5(A)+1(B)'), [['A', 15], ['B', 1]]);
  for (const junk of ['zepsute((', '(10(A)', '10(A)*', '10(A)*2(B)']) {
    const r = parseSpecExpression(junk);
    assert.equal(r.ok, false, junk);
    assert.deepEqual(r.items, []);
  }
});

// ── rozkład na kwotę widoczną ─────────────────────────────────────────────
test('rozkład: suma co do grosza = kwota z zlecenia, proporcje ze skryptu, ukryty czynnik znika', () => {
  // `param-DOPLATA-Cmul1.1.js`: DOPLATA = (22.42 + 17.9) * 1.1 * 1.045, a w _S jest tylko *1.045
  const items = parseSpecExpression('(22.42(DLUX2)+17.9(TruFit))*1.045').items;
  const shown = 46.35;
  const out = allocateToTotal(items, shown);
  assert.equal(Math.round(out.reduce((s, x) => s + x, 0) * 100), 4635);
  assert.ok(Math.abs(out[0] / out[1] - 22.42 / 17.9) < 0.01, 'proporcje składników zachowane');
  // Żaden składnik nie zdradza czynnika: wartości nie są „cena × 1.045".
  assert.notEqual(out[0], Math.round(22.42 * 1.045 * 100) / 100);
});

test('rozkład: grosze metodą największej reszty, ujemny składnik, brak proporcji → null', () => {
  assert.deepEqual(allocateToTotal([{ amount: 1 }, { amount: 1 }, { amount: 1 }], 0.02), [0.01, 0.01, 0]);
  assert.deepEqual(allocateToTotal([{ amount: 1 }, { amount: 1 }, { amount: 1 }], 100), [33.34, 33.33, 33.33]);
  const neg = allocateToTotal([{ amount: 60.5 }, { amount: -13.2 }], 47.3);
  assert.equal(Math.round((neg[0] + neg[1]) * 100), 4730);
  assert.ok(neg[1] < 0);
  assert.equal(allocateToTotal([], 10), null);
  assert.equal(allocateToTotal([{ amount: 0 }], 10), null);
  assert.equal(allocateToTotal([{ amount: 5 }, { amount: -5 }], 10), null);
});

test('rozkład: każdy składnik × czynnik osobno, zaokrąglony jak cennik — nie suma rozbita proporcją', () => {
  // Poz. 8989 (zlecenie 3300): skrypt robi toFixed(0) na SUMIE → 115.44 → 115.
  // Proporcją wychodziło 25.90 + 89.10 — kwoty, których nie ma żaden cennik.
  const sub = parseSpecExpression('(25(SF)+86(ELMONO))*1.04').items;
  assert.deepEqual(allocateToTotal(sub, 115), [26, 89]);
  // Ceny w groszach (fr = -1): 3.4903 + 19.82365 → 23.31.
  assert.deepEqual(allocateToTotal(parseSpecExpression('(3.34(SF)+18.97(ELMONO))*1.045').items, 23.31), [3.49, 19.82]);
  assert.deepEqual(allocateToTotal(parseSpecExpression('(195(RRLKV2)+127(PG1))*1.035').items, 333.27), [201.83, 131.44]);
  // Końcówka z zaokrąglenia sumy — w obie strony, suma zawsze = kwota widoczna.
  assert.deepEqual(allocateToTotal([{ amount: 10.3 }, { amount: 20.4 }, { amount: 30.2 }], 61), [10, 21, 30]);
  assert.deepEqual(allocateToTotal([{ amount: 10.6 }, { amount: 20.2 }], 30), [10, 20]);
  const down = allocateToTotal([{ amount: 10.1 }, { amount: 20.1 }, { amount: 30.1 }], 59);
  assert.equal(down.reduce((s, x) => s + x, 0), 59);
});

// ── widoczność 1:1 z templates/order.njk ──────────────────────────────────
test('widoczność: klient końcowy grupy widzi tylko ceny klienta, rabat dopiero po kłódce', () => {
  const closed = resolveSetVisibility({ isGroupShop: true }, true);
  assert.equal(closed.regular.visible, false, 'nigdy ceny zakupu');
  assert.equal(closed.sub.visible, true);
  assert.equal(closed.sub.locked, false);
  const open = resolveSetVisibility({ isGroupShop: true, discountPricesUnlocked: true }, true);
  assert.equal(open.sub.locked, true);
  assert.equal(open.sub.clientDiscount, true);
});

test('widoczność: klient z cenami SUB___ — bez cen zakupu; klient HKL — ceny zwykłe', () => {
  const sub = resolveSetVisibility({ isClient: true }, true);
  assert.equal(sub.regular.visible, false);
  assert.equal(sub.sub.visible, true);
  const unlocked = resolveSetVisibility({ isClient: true, prices: true }, true);
  assert.equal(unlocked.sub.locked, true, 'klient (nie widok organizacji) po kłódce widzi wiersze locked');
  const hkl = resolveSetVisibility({ isHklClient: true, showCatalogPrices: true }, false);
  assert.equal(hkl.regular.visible, true);
  assert.equal(hkl.sub.visible, false);
  const hklUnlocked = resolveSetVisibility({ isHklClient: true, showCatalogPrices: true, prices: true }, false);
  assert.equal(hklUnlocked.regular.locked, true, 'klient HKL po kłódce widzi rabaty cen zwykłych');
  const subClientOrder = resolveSetVisibility({ isClient: true, prices: true }, false, true);
  // order_prices.njk: wiersz główny ukryty (isClient and hasSubPrices), ale pozycję
  // bez cen SUB___ pokazuje osobny blok `isClient and not itemHasSubVals` — z locked.
  assert.equal(subClientOrder.regular.visible, true);
  assert.equal(subClientOrder.regular.locked, true);
  assert.equal(subClientOrder.sub.visible, false);
});

test('widoczność: owner/admin z przełącznikiem SUB — ceny zakupu tylko przy „pokaż ceny katalogowe"', () => {
  const base = { hasSubPriceToggle: true, canViewSubPrices: true, isOrgAccount: true };
  const hidden = resolveSetVisibility({ ...base, showCatalogPrices: false }, true);
  assert.equal(hidden.regular.visible, false);
  assert.equal(hidden.sub.visible, true);
  const both = resolveSetVisibility({ ...base, showCatalogPrices: true }, true);
  assert.equal(both.regular.visible, true);
  assert.equal(both.sub.visible, true);
  // Po kłódce (order_prices.njk): ceny klienta Z rabatami, ceny zakupu bez wierszy locked.
  const unlocked = resolveSetVisibility({ ...base, showCatalogPrices: true, prices: true }, true);
  assert.equal(unlocked.regular.locked, false, 'order_prices.njk: locked zwykłe tylko bez przełącznika SUB');
  assert.equal(unlocked.sub.visible, true);
  assert.equal(unlocked.sub.locked, true, 'owner/admin na kliencie spoza HKL widzi po kłódce rabaty klienta');
  const unlockedNoCatalog = resolveSetVisibility({ ...base, showCatalogPrices: false, prices: true }, true);
  assert.equal(unlockedNoCatalog.regular.visible, false);
  assert.equal(unlockedNoCatalog.sub.locked, true);
});

test('widoczność: grupa bez przełącznika SUB nie widzi wiersza SUB; ukryte ceny = nic', () => {
  assert.equal(resolveSetVisibility({ isGroup: true }, true).sub.visible, false);
  assert.equal(resolveSetVisibility({ isGroup: true, showSub: true }, true).sub.visible, true);
  const none = resolveSetVisibility({ hidePrices: true, isClient: true }, true);
  assert.equal(none.regular.visible, false);
  assert.equal(none.sub.visible, false);
});

// ── nazwy składników z warunków skryptu ───────────────────────────────────
const SCRIPT = `
var DOPLATA_S="";
var TruFit=0;
v=0;
n=0;
if(evaluateFormula('WSROD(MONTAZ,"TF1858,TF1859")',obj))n=n+1;
y=evaluateFormula('WYSOKOSC/10',obj);
if(y<=100)v=10.4;
TruFit=v*n;
if(TruFit!=0){if(DOPLATA_S!="")DOPLATA_S+="+";DOPLATA_S+=""+TruFit+"(TruFit)";}
var M17=0;
v=0;
n=0;
if(evaluateFormula('ZAWIERA(MOTOR,"M17")',obj))n=n+1;
v=149;
M17=v*n;
if(M17!=0){if(DOPLATA_S!="")DOPLATA_S+="+";DOPLATA_S+=""+M17+"(M17)";}
var PG4=0;
n=0;
if(evaluateFormula('IF(KOLOR_ALIAS___DESCRIPTION<>"",ZAWIERA(KOLOR_ALIAS___DESCRIPTION,"#4"),ZAWIERA(KOLOR___DESCRIPTION,"#4"))',obj))n=n+1;
PG4=100*n;
if(PG4!=0){if(DOPLATA_S!="")DOPLATA_S+="+";DOPLATA_S+=""+PG4+"(PG4)";}
return {"DOPLATA":0,"DOPLATA_S":DOPLATA_S};
`;

test('warunki: kod → parametr i opcje z linii warunku (bez linii wymiarów)', () => {
  const map = extractCodeConditions(SCRIPT);
  assert.deepEqual(map.get('TruFit'), [{ fn: 'WSROD', param: 'MONTAZ', arg: 'TF1858,TF1859' }]);
  assert.deepEqual(map.get('M17'), [{ fn: 'ZAWIERA', param: 'MOTOR', arg: 'M17' }]);
  assert.equal(map.get('PG4').length, 2);
});

test('warunki: WSROD = dokładne dopasowanie z listy, ZAWIERA = zawieranie (jak formula.js)', () => {
  assert.equal(conditionHolds({ fn: 'WSROD', param: 'M', arg: 'TF1858,TF1859' }, { M: 'tf1858' }), true);
  assert.equal(conditionHolds({ fn: 'WSROD', param: 'M', arg: 'TF' }, { M: 'TF1858' }), false);
  assert.equal(conditionHolds({ fn: 'ZAWIERA', param: 'M', arg: 'M17' }, { M: 'M17,P14' }), true);
  assert.equal(conditionHolds({ fn: 'ZAWIERA', param: 'M', arg: 'X' }, {}), false);
});

test('nazwa składnika: opcja, która go wywołała — z opisu pozycji, w jej języku', () => {
  const conditions = extractCodeConditions(SCRIPT);
  const values = { MONTAZ: 'TF1858', MOTOR: 'M17', KOLOR___DESCRIPTION: 'PRIJSGROEP #4' };
  const descRows = new Map([
    ['MONTAZ', { param_description: 'INSTALLATIETYPE', option_value: 'TF1858', option_description: 'TRUFIT ZWART' }],
    ['MOTOR', { param_description: 'MOTOR [EUR]', option_value: 'M17', option_description: 'Somfy Tilt&Lift RTS' }],
    ['KOLOR', { param_description: 'KLEUR', option_value: '4049-25', option_description: 'PG #4' }]
  ]);
  assert.equal(labelForCode('TruFit', { conditions, values, descRows }), 'INSTALLATIETYPE: TF1858 – TRUFIT ZWART');
  assert.equal(labelForCode('M17', { conditions, values, descRows }), 'MOTOR: M17 – Somfy Tilt&Lift RTS', 'bez znacznika waluty');
  assert.equal(labelForCode('PG4', { conditions, values, descRows }), 'KLEUR: 4049-25 – PG #4', '___DESCRIPTION → parametr bazowy');
  assert.equal(labelForCode('NIEZNANY', { conditions, values, descRows }), null);
});

test('grupa cenowa z kodu cennika', () => {
  for (const [code, want] of [['PG4', '4'], ['U25PG4', '4'], ['TCNDPG2', '2'], ['PG5SL', '5'], ['PGE', 'E'], ['RRLKV2', null], ['PGEL', null]]) {
    assert.equal(priceGroupOf(code), want, code);
  }
  assert.equal(toNumber('300.70'), 300.7);
  assert.equal(toNumber('56%'), 56);
  assert.equal(toNumber('1 234,50'), 1234.5);
  assert.equal(toNumber('Według cennika'), null);
  assert.equal(toNumber('-'), null);
});

// ── cała specyfikacja na pozycji ──────────────────────────────────────────
function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricespec-'));
  fs.mkdirSync(path.join(dir, '39', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, '39', 'data', 'param-DOPLATA-Cmul1.1.js'), SCRIPT);
  fs.writeFileSync(path.join(dir, '39', 'data', 'param-SUB___DOPLATA-A.js'), SCRIPT);
  return dir;
}

function row(param_description, option_value, extra = {}) {
  return { param_description, option_value, option_description: '', locked: false, row: '2', ...extra };
}

function item(overrides = {}) {
  const values = {
    ILOSC: 2, MONTAZ: 'TF1858', MODEL: 'U25DLX2',
    CENA_S: '(56.76(U25PG4))*1.045', DOPLATA_S: '(17.9(TruFit))*1.045',
    SUB___CENA_S: '(278(U25PG4))*1.045', SUB___DOPLATA_S: '(75(TruFit))*1.045',
    ...overrides.values
  };
  const desc = [
    ['ILOSC', { param_description: 'AANTAL', option_value: '2', row: '1' }],
    ['MODEL', { param_description: 'MODEL', option_value: 'U25DLX2', option_description: 'DUOLUX 25 MM', row: '1' }],
    ['MONTAZ', { param_description: 'INSTALLATIETYPE', option_value: 'TF1858', option_description: 'TRUFIT ZWART', row: '1' }],
    ['CENA', row('HKL PREIS [EUR]', '72.18')],
    ['DOPLATA', row('AUFPREIS [EUR]', '3.92')],
    ['CENA_SUMA', row('GES.STÜCKPREIS [EUR]', '76.10')],
    ['SUMA_BRUTTO', row('GES.WERT [EUR]', '152.20')],
    ['SUB___CENA', row('LISTENPREIS [EUR]', '285', { sub: true })],
    ['SUB___DOPLATA', row('AUFPREIS [EUR]', '15.7', { sub: true })],
    ['SUB___CENA_SUMA', row('GES.STÜCKPREIS [EUR]', '300.70', { sub: true })],
    ['SUB___SUMA_BRUTTO', row('GES.WERT [EUR]', '601.40', { sub: true })],
    ['SUB___CENA_RABAT', row('RABATT', '56%', { sub: true, locked: true })],
    ['SUB___CENA_KONCOWA', row('PREIS N. RABATT [EUR]', '132.31', { sub: true, locked: true })],
    ['SUB___WARTOSC_KONCOWA', row('GES.WERT N. RABATT [EUR]', '264.62', { sub: true, locked: true })],
    ...(overrides.desc || [])
  ];
  return {
    id: 9080, asortment_group_number: '39', group_name: 'ALUMINIUM JALOEZIEËN',
    json_parameters: JSON.stringify(values), json_parameters_desc: JSON.stringify(desc),
    subParamValues: overrides.noSub ? [] : [{ key: 'SUB___CENA' }]
  };
}

function build(view, opts = {}) {
  clearCache();
  return buildOrderPriceSpec({
    orderDetails: { id: 4109, order_idx: 9, commision: 'Düding', created_date: '2026-10-08T13:50:36Z' },
    orderItems: [opts.item || item()],
    view,
    lang: opts.lang || 'pl',
    currency: 'EUR',
    scriptsByGroup: { 39: { DOPLATA: 'param-DOPLATA-Cmul1.1.js', SUB___DOPLATA: 'param-SUB___DOPLATA-A.js' } },
    showCodes: !!opts.showCodes,
    advanced: !!opts.advanced,
    dataDir: opts.dataDir || makeDataDir(),
    now: new Date('2026-10-16T12:00:00Z')
  });
}

test('specyfikacja: klient końcowy — tylko ceny klienta, rozbicie sumuje się do ceny, zero czynników', () => {
  const spec = build({ isGroupShop: true });
  assert.equal(spec.positions.length, 1);
  const [set] = spec.positions[0].sets;
  assert.equal(spec.positions[0].sets.length, 1);
  assert.equal(set.key, 'sub');
  assert.equal(set.title, null, 'jeden zestaw — bez podtytułu');
  const [base, surcharge] = set.sections;
  assert.equal(base.amount, 285);
  assert.equal(base.lines[0].label, 'Grupa cenowa 4');
  assert.equal(surcharge.title, 'AUFPREIS', 'tytuł z pozycji, bez [EUR]');
  assert.equal(surcharge.lines[0].label, 'INSTALLATIETYPE: TF1858 – TRUFIT ZWART');
  assert.equal(surcharge.lines[0].amount, 15.7);
  assert.equal(set.unitPrice, 300.7);
  assert.equal(set.lineTotal, 601.4);
  assert.deepEqual(set.discount, [], 'rabat pod kłódką — zamkniętą');
  assert.equal(set.totalAfter, null);
  const text = JSON.stringify(spec);
  for (const leak of ['1.045', '1.1', '*', 'HKL PREIS', '72.18', 'U25PG4', 'TruFit"']) assert.ok(!text.includes(leak), `wyciek: ${leak}`);
});

test('specyfikacja: kilka dopłat z czynnikiem — każda × czynnik osobno, w pełnych euro jak cennik klienta', () => {
  const spec = build({ isGroupShop: true }, {
    item: item({
      values: { SUB___DOPLATA_S: '(25(SF)+86(ELMONO))*1.04' },
      desc: [
        ['SUB___DOPLATA', row('AUFPREIS [EUR]', '115', { sub: true })],
        ['SUB___CENA_SUMA', row('GES.STÜCKPREIS [EUR]', '400', { sub: true })]
      ]
    })
  });
  const [, surcharge] = spec.positions[0].sets[0].sections;
  assert.equal(surcharge.amount, 115);
  assert.deepEqual(surcharge.lines.map((l) => l.amount), [26, 89], '25 × 1.04 = 26, 86 × 1.04 = 89.44 → 89 (nie 25.90 + 89.10)');
});

test('specyfikacja: kłódka rabatu odsłania rabat i kwoty po rabacie', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.discount.map((d) => [d.label, d.detail, d.amount]), [['Rabat cennikowy', '56 % od 300,70\u00a0€', 168.39]]);
  assert.equal(set.unitPrice - set.discount[0].amount, set.unitAfter, 'rabat uzgodniony z ceną po rabacie z zlecenia');
  assert.equal(set.unitAfter, 132.31);
  assert.equal(set.totalAfter, 264.62);
  assert.equal(spec.summary[0].totalAfter, 264.62);
});

test('specyfikacja: owner z cenami katalogowymi — oba zestawy z podtytułami, mnożnik pracownika w cenach zwykłych', () => {
  const spec = build({ hasSubPriceToggle: true, canViewSubPrices: true, isOrgAccount: true, showCatalogPrices: true, priceFactor: 1.2 });
  const sets = spec.positions[0].sets;
  assert.deepEqual(sets.map((s) => s.title), ['Cena zakupu', 'Cena klienta']);
  assert.equal(sets[0].sections[0].amount, 86.62, '72.18 × 1.2 — jak filtr applyFactor w order.njk');
  assert.equal(sets[1].sections[0].amount, 285, 'ceny SUB___ bez mnożnika (jak w order.njk)');
  assert.equal(spec.summary.length, 2);
});

test('specyfikacja: brak wyrażenia _S — kwota bez rozbicia; różnica do ceny jednostkowej jako osobna linia', () => {
  const spec = build({ isGroupShop: true }, {
    item: item({ values: { SUB___DOPLATA_S: '' }, desc: [['SUB___CENA_SUMA', row('GES.STÜCKPREIS', '310.70', { sub: true })]] })
  });
  const set = spec.positions[0].sets[0];
  const surcharge = set.sections.find((s) => s.param === 'DOPLATA');
  assert.equal(surcharge.breakdown, false);
  const other = set.sections.find((s) => s.kind === 'other');
  assert.equal(other.amount, 10);
  assert.equal(Math.round(set.sections.reduce((s, x) => s + x.amount, 0) * 100), Math.round(set.unitPrice * 100));
});

test('specyfikacja: kody cennika tylko na żądanie (HKL), zestaw z samymi zerami pominięty', () => {
  const withCodes = build({ isGroupShop: true }, { showCodes: true });
  assert.equal(withCodes.positions[0].sets[0].sections[1].lines[0].code, 'TruFit');
  const zeros = build({ isGroupShop: true }, {
    item: item({ desc: ['SUB___CENA', 'SUB___DOPLATA', 'SUB___CENA_SUMA', 'SUB___SUMA_BRUTTO'].map((k) => [k, row(k, '0', { sub: true })]) })
  });
  assert.equal(zeros.empty, true);
});

test('specyfikacja: teksty ramki w języku użytkownika', () => {
  const de = build({ isGroupShop: true }, { lang: 'de-DE' });
  assert.equal(de.lang, 'de');
  assert.equal(de.t.title, 'Preisaufstellung');
  assert.equal(de.positions[0].sets[0].sections[0].lines[0].label, 'Preisgruppe 4');
  assert.match(de.t.note, /EUR/);
});

test('tłumaczenia: 5 języków z kompletem tych samych kluczy', () => {
  const keys = Object.keys(STRINGS.pl).sort();
  for (const lang of ['en', 'de', 'fr', 'nl']) assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, lang);
  for (const lang of Object.keys(STRINGS)) for (const [k, v] of Object.entries(STRINGS[lang])) assert.ok(v && v.trim(), `${lang}.${k}`);
});

test('skrypty klienta: nakładka z bazy przed prod.txt, mapa parametr → plik', async () => {
  const calls = [];
  const out = await resolveScriptsByGroup({ orderId: 4109, groups: ['39', '39', '71'] }, {
    ownerQuery: async () => ({ userId: 2462, userIdent: 'Büker_Gardinen_SV', orgIdent: 'LUXANGMBH' }),
    primeClientOverlay: async (p) => { calls.push(p.groupNumber); return true; },
    getClientScripts: ({ groupNumber }) => (groupNumber === '39'
      ? ['/data/39/data/', [{ param: 'CENA', file: 'param-CENA-C.js' }, { param: 'DOPLATA', file: 'param-DOPLATA-Cmul1.1.js' }]]
      : null)
  });
  assert.deepEqual(calls, ['39', '71'], 'każda grupa raz');
  assert.deepEqual(out, { 39: { CENA: 'param-CENA-C.js', DOPLATA: 'param-DOPLATA-Cmul1.1.js' } });
  assert.deepEqual(await resolveScriptsByGroup({ orderId: 1, groups: ['39'] }, { ownerQuery: async () => null }), {});
});

// ── rabaty: każdy udzielony osobno, uzgodnione z ceną po rabacie ─────────
function discountItem({ values = {}, desc = [] }) {
  return item({
    values: { SUB___DOPLATA_S: '', ...values },
    desc: [
      ['SUB___CENA', row('LISTENPREIS', '200', { sub: true })],
      ['SUB___DOPLATA', row('AUFPREIS', '50', { sub: true })],
      ['SUB___CENA_SUMA', row('GES.STÜCKPREIS', '250', { sub: true })],
      ['SUB___SUMA_BRUTTO', row('GES.WERT', '500', { sub: true })],
      ...desc
    ]
  });
}

test('rabaty: grupa 71 — cennikowy na cenę bazową, osobny na dopłaty i na elektrykę', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    item: discountItem({
      values: { SUB___CENA_RABAT: 0.6, SUB___DOPLATA_RABAT: 0.3, SUB___DOPLATA_EL_RABAT: 0.4 },
      desc: [
        ['SUB___DOPLATA_EL', row('AUFPREIS EL', '100', { sub: true })],
        ['SUB___CENA_SUMA', row('GES.STÜCKPREIS', '350', { sub: true })],
        ['SUB___SUMA_BRUTTO', row('GES.WERT', '700', { sub: true })],
        ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
        ['SUB___DOPLATA_RABAT', row('RABATT AUFPREIS', '30%', { sub: true, locked: true })],
        ['SUB___DOPLATA_EL_RABAT', row('RABATT EL', '40%', { sub: true, locked: true })],
        // 200·0.4 + 50·0.7 + 100·0.6 = 80 + 35 + 60
        ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '175', { sub: true, locked: true })],
        ['SUB___WARTOSC_KONCOWA', row('GES.WERT N. RABATT', '350', { sub: true, locked: true })]
      ]
    })
  });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.discount.map((d) => [d.label, d.amount]), [
    ['Rabat cennikowy', 120], ['Rabat na dopłaty', 15], ['Rabat na elektrykę', 40]
  ]);
  assert.equal(set.discount[0].detail, '60 % od 200,00\u00a0€', 'grupa 71: cennikowy tylko od ceny bazowej');
  assert.equal(set.unitAfter, 175);
  assert.equal(set.totalAfter, 350);
});

test('rabaty: bez kłódki nie ma żadnego rabatu ani ceny po rabacie', () => {
  const spec = build({ isGroupShop: true }, {
    item: discountItem({ values: { SUB___CENA_RABAT: 0.5 }, desc: [
      ['SUB___CENA_RABAT', row('RABATT', '50%', { sub: true, locked: true })],
      ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '125', { sub: true, locked: true })]
    ] })
  });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.discount, []);
  assert.equal(set.unitAfter, null);
  assert.ok(!JSON.stringify(spec).includes('125'));
});

test('rabaty: rabat klienta grupy zastępuje cennikowy — jedna linia z rzeczywistą kwotą', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    item: discountItem({ values: { SUB___CENA_RABAT: 0.6 }, desc: [
      ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
      ['SUB___RABAT_KLIENTA', row('Rabat klienta', '15%', { sub: true, locked: true })],
      ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '212.5', { sub: true, locked: true })]
    ] })
  });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.discount.map((d) => [d.label, d.detail, d.amount]), [['Rabat klienta', '15 % od 250,00\u00a0€', 37.5]]);
});

test('rabaty: pozycja liczona po staremu (reguła się nie spina) — jedna linia z rzeczywistą kwotą', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    item: discountItem({ values: { SUB___CENA_RABAT: 0.6 }, desc: [
      ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
      ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '200', { sub: true, locked: true })]
    ] })
  });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.discount.map((d) => [d.label, d.amount]), [['Rabat', 50]]);
  assert.equal(set.unitAfter, 200);
});

// ── rabat klienta grupy od 2026-10-27: tylko cena katalogowa, dopłaty ze swoimi
// rabatami z konfiguratora (pricesCalculator.clientDiscountBreakdown) — każdy osobno

test('rabaty: konto podrzędne, grupa 71 — rabat klienta od ceny katalogowej, rabat na dopłaty i RABAT EL osobno', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    item: discountItem({
      values: { SUB___CENA_RABAT: 0.6, SUB___DOPLATA_RABAT: 0.3, SUB___DOPLATA_EL_RABAT: 0.4 },
      desc: [
        ['SUB___DOPLATA_EL', row('AUFPREIS EL', '100', { sub: true })],
        ['SUB___CENA_SUMA', row('GES.STÜCKPREIS', '350', { sub: true })],
        ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
        ['SUB___DOPLATA_RABAT', row('RABATT AUFPREIS', '30%', { sub: true, locked: true })],
        ['SUB___DOPLATA_EL_RABAT', row('RABAT EL', '40%', { sub: true, locked: true })],
        ['SUB___RABAT_KLIENTA', row('Rabat klienta', '50%', { sub: true, locked: true })],
        // 200·0.5 + 50·0.7 + 100·0.6 = 100 + 35 + 60
        ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '195', { sub: true, locked: true })]
      ]
    })
  });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.discount.map((d) => [d.label, d.detail, d.amount]), [
    ['Rabat klienta', '50 % od 200,00 €', 100],
    ['Rabat na dopłaty', '30 % od 50,00 €', 15],
    ['Rabat na elektrykę', '40 % od 100,00 €', 40]
  ]);
  assert.equal(set.unitAfter, 195);
});

test('rabaty: konto podrzędne, grupa bez osobnego rabatu na dopłatę — dopłata z rabatem cennikowym, RABAT EL osobno', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    item: discountItem({
      values: { SUB___CENA_RABAT: 0.6, SUB___DOPLATA_EL_RABAT: 0.4 },
      desc: [
        ['SUB___DOPLATA_EL', row('AUFPREIS EL', '100', { sub: true })],
        ['SUB___CENA_SUMA', row('GES.STÜCKPREIS', '350', { sub: true })],
        ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
        ['SUB___DOPLATA_EL_RABAT', row('RABAT EL', '40%', { sub: true, locked: true })],
        ['SUB___RABAT_KLIENTA', row('Rabat klienta', '50%', { sub: true, locked: true })],
        // 200·0.5 + 50·0.4 + 100·0.6 = 100 + 20 + 60
        ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '180', { sub: true, locked: true })]
      ]
    })
  });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.discount.map((d) => [d.label, d.amount]), [
    ['Rabat klienta', 100], ['Rabat na dopłaty', 30], ['Rabat na elektrykę', 40]
  ]);
  assert.equal(set.unitAfter, 180);
});

// ── specyfikacja zaawansowana: składnik | wartość | rabat | wartość po rabacie ──
const advRow = (a) => (a ? [a.rateText, a.discount, a.after] : null);

test('zaawansowana: grupa 71 — przy każdym składniku jego rabat i wartość po rabacie, sumy = zlecenie', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    advanced: true,
    item: discountItem({
      values: { SUB___CENA_RABAT: 0.6, SUB___DOPLATA_RABAT: 0.3, SUB___DOPLATA_EL_RABAT: 0.4 },
      desc: [
        ['SUB___DOPLATA_EL', row('AUFPREIS EL', '100', { sub: true })],
        ['SUB___CENA_SUMA', row('GES.STÜCKPREIS', '350', { sub: true })],
        ['SUB___SUMA_BRUTTO', row('GES.WERT', '700', { sub: true })],
        ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
        ['SUB___DOPLATA_RABAT', row('RABATT AUFPREIS', '30%', { sub: true, locked: true })],
        ['SUB___DOPLATA_EL_RABAT', row('RABATT EL', '40%', { sub: true, locked: true })],
        ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '175', { sub: true, locked: true })],
        ['SUB___WARTOSC_KONCOWA', row('GES.WERT N. RABATT', '350', { sub: true, locked: true })]
      ]
    })
  });
  assert.equal(spec.advanced, true);
  assert.equal(spec.t.title, 'Specyfikacja zaawansowana');
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.sections.map((s) => [s.param, ...advRow(s.adv)]), [
    ['CENA', '60 %', 120, 80], ['DOPLATA', '30 %', 15, 35], ['DOPLATA_EL', '40 %', 40, 60]
  ]);
  assert.deepEqual(advRow(set.sections[0].lines[0].adv), ['60 %', 120, 80], 'linia grupy cenowej');
  assert.equal(set.adv.byComponent, true);
  assert.deepEqual([set.adv.unit.discount, set.adv.unit.after], [175, 175]);
  assert.deepEqual([set.adv.total.discount, set.adv.total.after], [350, 350]);
  assert.deepEqual([spec.summary[0].adv.discount, spec.summary[0].adv.after], [350, 350]);
});

test('zaawansowana: kilka dopłat — każda z rabatem osobno, grosz z zaokrągleń uzgodniony z ceną po rabacie', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    advanced: true,
    item: item({
      values: { SUB___DOPLATA_S: '(25(SF)+86(ELMONO))*1.04', SUB___CENA_RABAT: 0.6 },
      desc: [
        ['SUB___DOPLATA', row('AUFPREIS [EUR]', '115', { sub: true })],
        ['SUB___CENA_SUMA', row('GES.STÜCKPREIS [EUR]', '400', { sub: true })],
        ['SUB___SUMA_BRUTTO', row('GES.WERT [EUR]', '800', { sub: true })],
        ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
        ['SUB___CENA_KONCOWA', row('PREIS N. RABATT [EUR]', '160', { sub: true, locked: true })],
        ['SUB___WARTOSC_KONCOWA', row('GES.WERT N. RABATT [EUR]', '320', { sub: true, locked: true })]
      ]
    })
  });
  const [base, surcharge] = spec.positions[0].sets[0].sections;
  assert.deepEqual(advRow(base.adv), ['60 %', 171, 114]);
  assert.deepEqual(surcharge.lines.map((l) => [l.amount, ...advRow(l.adv)]), [[26, '60 %', 15.6, 10.4], [89, '60 %', 53.4, 35.6]]);
  assert.deepEqual(advRow(surcharge.adv), ['60 %', 69, 46], 'sekcja = suma swoich dopłat');
  const set = spec.positions[0].sets[0];
  assert.deepEqual([set.adv.unit.discount, set.adv.unit.after, set.adv.total.after], [240, 160, 320]);
});

test('zaawansowana: rabat klienta grupy — cena katalogowa z rabatem klienta, dopłaty ze swoimi rabatami', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    advanced: true,
    item: discountItem({
      values: { SUB___CENA_RABAT: 0.6, SUB___DOPLATA_RABAT: 0.3, SUB___DOPLATA_EL_RABAT: 0.4 },
      desc: [
        ['SUB___DOPLATA_EL', row('AUFPREIS EL', '100', { sub: true })],
        ['SUB___CENA_SUMA', row('GES.STÜCKPREIS', '350', { sub: true })],
        ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
        ['SUB___DOPLATA_RABAT', row('RABATT AUFPREIS', '30%', { sub: true, locked: true })],
        ['SUB___DOPLATA_EL_RABAT', row('RABAT EL', '40%', { sub: true, locked: true })],
        ['SUB___RABAT_KLIENTA', row('Rabat klienta', '50%', { sub: true, locked: true })],
        ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '195', { sub: true, locked: true })]
      ]
    })
  });
  const set = spec.positions[0].sets[0];
  assert.deepEqual(set.sections.map((s) => advRow(s.adv)), [['50 %', 100, 100], ['30 %', 15, 35], ['40 %', 40, 60]]);
  assert.equal(set.adv.unit.after, 195);
});

test('zaawansowana: reguła się nie spina — składniki bez rabatu, rzeczywista kwota przy cenie jednostkowej', () => {
  const spec = build({ isGroupShop: true, discountPricesUnlocked: true }, {
    advanced: true,
    item: discountItem({ values: { SUB___CENA_RABAT: 0.6 }, desc: [
      ['SUB___CENA_RABAT', row('RABATT', '60%', { sub: true, locked: true })],
      ['SUB___CENA_KONCOWA', row('PREIS N. RABATT', '200', { sub: true, locked: true })]
    ] })
  });
  const set = spec.positions[0].sets[0];
  assert.equal(set.adv.byComponent, false);
  assert.ok(set.sections.every((s) => s.adv === null));
  assert.deepEqual([set.adv.unit.discount, set.adv.unit.after], [50, 200]);
});

test('zaawansowana: bez kłódki — tylko składnik i wartość, bez kolumn rabatu; szablon 4 kolumny po kłódce', () => {
  const nunjucks = require('nunjucks');
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, '..', '..', 'templates')), { autoescape: true });
  const closed = build({ isGroupShop: true }, { advanced: true });
  assert.equal(closed.positions[0].sets[0].adv, null);
  assert.equal(closed.positions[0].sets[0].discountVisible, false);
  const closedHtml = env.render('partials/price_spec_body.njk', { spec: closed });
  assert.ok(closedHtml.includes('Rabaty i wartości po rabacie pokazują się po odblokowaniu cen'));
  assert.ok(!closedHtml.includes('Wartość po rabacie'));
  assert.ok(!closedHtml.includes('132,31'), 'cena po rabacie nie wychodzi bez kłódki');

  const open = build({ isGroupShop: true, discountPricesUnlocked: true }, { advanced: true });
  const html = env.render('partials/price_spec_body.njk', { spec: open });
  for (const head of ['Składnik ceny', 'Wartość', 'Rabat', 'Wartość po rabacie']) assert.ok(html.includes(`<th scope="col">${head}</th>`), head);
  assert.ok(html.includes('price-spec--advanced'));
  assert.ok(html.includes('132,31'), 'wartość po rabacie z zlecenia');
  // prosta specyfikacja bez zmian — bez kolumn
  const simple = env.render('partials/price_spec_body.njk', { spec: build({ isGroupShop: true, discountPricesUnlocked: true }) });
  assert.ok(!simple.includes('<th scope="col">Rabat</th>'));
  assert.ok(!simple.includes('price-spec--advanced'));
});

// PDF specyfikacji (29.10): pozycja zajmuje zwykle 50–110% strony A4, a Chromium
// przenosi blok z `break-inside: avoid` w całości na następną stronę — pierwsza
// strona zostawała z samym nagłówkiem dokumentu. Pozycja płynie, łamie się
// tylko między sekcjami.
test('arkusz: pozycja specyfikacji nie jest nierozdzielna, sekcje są', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles', 'priceSpec.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].split(',').map((s) => s.trim()), body: m[2] }));
  const avoids = (sel) => rules.some((r) => r.sel.includes(sel) && /break-inside:\s*avoid/.test(r.body));
  assert.equal(avoids('.price-spec__position'), false);
  for (const sel of ['.price-spec__section', '.price-spec__totals', '.price-spec__table tr']) assert.ok(avoids(sel), sel);
});
