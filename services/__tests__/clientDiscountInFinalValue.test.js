'use strict';

/**
 * Rabat eForma (rabat klienta + 1% za korzystanie z serwisu) w cenie
 * jednostkowej `SUB___CENA_KONCOWA` („PREIS N. RABATT [€] netto").
 *
 * ⚠️ DLACZEGO AKURAT TEN PARAMETR: z ceny jednostkowej wystawiana jest faktura
 * (decyzja właściciela 2026-09-11) — systemy zewnętrzne mnożą ją przez ilość.
 * `SUB___WARTOSC_KONCOWA` idzie za nią jako `cena × ilość`, bo to z tego
 * wiersza (`listsum`) liczy się suma zamówienia. Do 2026-09-11 rabat miał
 * własny wiersz `SUB___WARTOSC_PO_RABACIE`, więc oba parametry pokazywały
 * kwotę sprzed rabatu — pozycja 7277 miała 113.20 zamiast 110.37.
 *
 * ⚠️ Drugi warunek: **procenty rabatów się DODAJĄ**, bo rabat liczy się od
 * ceny KATALOGOWEJ `SUB___CENA_SUMA` — tej samej, od której liczy się rabat
 * cennikowy `SUB___CENA_RABAT`.
 *
 * Test uruchamia PRAWDZIWE moduły przeglądarkowe (`formTools/pricesCalculator.js`
 * i `form.js`) — zbundlowane esbuildem i odpalone w JSDOM, tak samo jak robi to
 * `services/formEngine/jsdomEnv.js`. Kopia logiki w teście byłaby bezwartościowa:
 * pilnujemy tu właśnie tego, co robi kod wysyłany do przeglądarki.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const PRICES = path.join(ROOT, 'public', 'scripts', 'formTools', 'pricesCalculator.js');
const FORM = path.join(ROOT, 'public', 'scripts', 'form.js');

let cachedFormula = null;
/**
 * `public/scripts/formula.js` to KLASYCZNY skrypt definiujący globalny
 * `window.FormulaHandler` — ten sam, który ładuje przeglądarka i
 * `services/formEngine/jsdomEnv.js`. `applyClientDiscount` używa go do
 * przeliczenia łańcucha cenowego po podbiciu rabatu.
 */
function buildFormulaHandler() {
  if (cachedFormula === null) {
    const fs = require('fs');
    // `formula.js` buduje się na `hot-formula-parser` (globalny
    // `window.formulaParser`) — ta sama para i ta sama kolejność, co w
    // `services/formEngine/jsdomEnv.js`.
    const parser = fs.readFileSync(
      path.join(ROOT, 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'), 'utf8');
    cachedFormula = parser + '\n;' + fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'formula.js'), 'utf8');
  }
  return cachedFormula;
}

let cachedBundle = null;
function buildBundle() {
  if (cachedBundle) return cachedBundle;
  const result = esbuild.buildSync({
    stdin: {
      contents: `
        export { applyClientDiscount, applyVatToGrossValue } from ${JSON.stringify(PRICES)};
        export { getTotal } from ${JSON.stringify(FORM)};
      `,
      resolveDir: ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: '__discountTest',
    write: false,
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  });
  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

/**
 * Minimalna przeglądarka: tyle globali, ile moduły czytają na starcie.
 * Świadomie BEZ pól formularza (`getElementById` zwraca null) — `applyClientDiscount`
 * ma działać także na ekranach, które ich nie budują (edit_form/admin_edit_form).
 */
function makeWindow({ clientDiscountPercent = 0, portalUsageDiscountPercent = 0 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.t = (key) => key;
  // `form.js` odpala przy imporcie kilka zapytań (`/env`, logo, nazwa
  // użytkownika). Odpowiadamy na wszystkie tym samym, pełnym kształtem
  // odpowiedzi — inaczej ich obsługa błędów zasypuje wynik testu logami.
  window.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, body: { version: 'Testowa' } }),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new window.Blob([]))
  });
  window.console.log = () => {};
  window.console.error = () => {};
  window.clientDiscountPercent = clientDiscountPercent;
  window.portalUsageDiscountPercent = portalUsageDiscountPercent;
  // `components/toast.js` sięga po globalny `toastr` już przy imporcie —
  // ten sam no-op co w services/formEngine/jsdomEnv.js.
  const noop = () => {};
  window.toastr = { success: noop, error: noop, warning: noop, info: noop, options: {}, clear: noop, remove: noop };
  window.vatEnabled = false;
  window.subParams = [];
  window.lockedParams = [];
  window.eval(buildFormulaHandler());
  window.eval(buildBundle());
  window.params = PARAMS_GRUPY_39;
  window.formInputs = {};
  window.allOptionsByParameter = {};
  window.tempGroupNumber = '39';
  return window;
}

/** Wiersze `displayValues` grupy 39 tuż przed rabatem (kwoty z pozycji 7277). */
function displayValuesFixture(window, cenaJednostkowa, ilosc = 1, rabatOpis = '60%') {
  const dv = new window.Map();
  dv.set('SUB___CENA_RABAT', {
    param_description: 'RABATT', option_value: rabatOpis, locked: true, sub: true, row: '2'
  });
  dv.set('SUB___CENA_KONCOWA', {
    param_description: 'CENA NETTO PO RABACIE [€]',
    option_value: String(cenaJednostkowa),
    locked: true, sub: true, row: '2'
  });
  dv.set('SUB___WARTOSC_KONCOWA', {
    param_description: 'WART. NET. PO RABACIE [€]',
    option_value: String(parseFloat((cenaJednostkowa * ilosc).toFixed(2))),
    locked: true, sub: true, listsum: true, row: '2'
  });
  return dv;
}

/**
 * `values` tej samej pozycji — silnik trzyma obie kwoty osobno.
 *
 * `cenaKatalogowa` (`SUB___CENA_SUMA`) domyślnie równa cenie po rabacie, bo
 * większość klientów nie ma rabatu cennikowego; podanie jej osobno odwzorowuje
 * pozycję z `SUB___CENA_RABAT` > 0.
 */
function valuesFixture(cenaJednostkowa, ilosc = 1, cenaKatalogowa = cenaJednostkowa) {
  const rabat = cenaKatalogowa > 0
    ? parseFloat((1 - cenaJednostkowa / cenaKatalogowa).toFixed(6))
    : 0;
  return {
    ILOSC: ilosc,
    SUB___CENA: cenaKatalogowa,
    SUB___DOPLATA: 0,
    SUB___DOPLATA_EL: 0,
    SUB___DOPLATA_EL_RABAT: 0,
    SUB___CENA_SUMA: cenaKatalogowa,
    SUB___CENA_RABAT: rabat,
    SUB___CENA_KONCOWA: cenaJednostkowa,
    SUB___WARTOSC_KONCOWA: parseFloat((cenaJednostkowa * ilosc).toFixed(2))
  };
}

/**
 * `window.params` grupy 39 — tyle, ile potrzeba, by `applyClientDiscount` mogło
 * przeliczyć łańcuch PRAWDZIWYMI formułami z `param.txt` po podbiciu rabatu.
 */
const PARAMS_GRUPY_39 = [
  { NAME: 'SUB___CENA_RABAT', FORMAT: 'n%' },
  {
    NAME: 'SUB___CENA_KONCOWA',
    FORMULA: '=(SUB___CENA+SUB___DOPLATA)*(1-SUB___CENA_RABAT)+SUB___DOPLATA_EL*(1-SUB___DOPLATA_EL_RABAT)'
  },
  { NAME: 'SUB___WARTOSC_KONCOWA', FORMULA: '=SUB___CENA_KONCOWA*ILOSC' }
];

test('rabat 1% schodzi z ceny jednostkowej — parametr fakturowy, wiersz i suma to ta sama liczba', () => {
  // Prawdziwa pozycja 7277 (zam. 3078): katalog 283, rabat cennikowy 60%
  // → 113.20; z bonusem 1% należne jest 283 × 0.39 = 110.37.
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(113.2, 1, 283);
  const dv = displayValuesFixture(window, 113.2);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 110.37, 'PREIS N. RABATT — z niego idzie faktura');
  assert.equal(dv.get('SUB___CENA_KONCOWA').option_value, '110.37', 'wiersz ceny jednostkowej');
  assert.equal(values.SUB___WARTOSC_KONCOWA, 110.37, 'wartość idzie za ceną');
  assert.equal(window.__discountTest.getTotal(dv).total_sub, 110.37, 'order_item.total_price_sub');
});

test('klient BEZ rabatu cennikowego — wynik jak dotąd, czyli cena × (1 − rabat)', () => {
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(113.2);
  const dv = displayValuesFixture(window, 113.2);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 112.07, '113.20 − 1%');
  assert.equal(window.__discountTest.getTotal(dv).total_sub, 112.07);
});

test('przy ilości > 1 wartość pozycji to DOKŁADNIE cena po rabacie × ilość', () => {
  // Systemy zewnętrzne mnożą cenę jednostkową przez ilość — gdyby wartość
  // liczyła się osobno, dokument przeczyłby sam sobie o grosze.
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(50, 3);
  const dv = displayValuesFixture(window, 50, 3);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 49.5, '50 − 1%');
  assert.equal(values.SUB___WARTOSC_KONCOWA, 148.5, '49.50 × 3');
  assert.equal(window.__discountTest.getTotal(dv).total_sub, 148.5);
});

test('bonus 1% DOKŁADA SIĘ do rabatu cennikowego, a nie mnoży — pozycja 7302', () => {
  // `SUB___CENA_SUMA` = 207, `SUB___CENA_RABAT` = 0.6 → cena po cenniku 82.80.
  // Właściciel liczy 207 × 0.39 = 80.73, czyli 1% od ceny KATALOGOWEJ.
  // Mnożenie (82.80 × 0.99 = 81.97) było błędem.
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(82.8, 1, 207);
  const dv = displayValuesFixture(window, 82.8);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 80.73, '207 × 0.39');
  assert.equal(values.SUB___WARTOSC_KONCOWA, 80.73);
  assert.equal(window.__discountTest.getTotal(dv).total_sub, 80.73);
});

test('rabat klienta ZASTĘPUJE rabat cennikowy — pozycja 7189 (979 @ 15% → 832.15)', () => {
  // ⚠️ Ta reguła jest inna niż dla bonusu i to NIE pomyłka: decyzja właściciela
  // z 2026-08-24. Cennik dawał tu 391.60, a należne jest 979 × 0.85.
  // Potraktowanie rabatu klienta jak bonusu dałoby 979 × 0.25 = 244.75.
  const window = makeWindow({ clientDiscountPercent: 15, portalUsageDiscountPercent: 0 });
  const values = valuesFixture(391.6, 1, 979);
  const dv = displayValuesFixture(window, 391.6);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 832.15);
  assert.equal(window.__discountTest.getTotal(dv).total_sub, 832.15);
});

test('rabat klienta 60% na 2 szt. — pozycja 7198 (468.60 → 187.44)', () => {
  const window = makeWindow({ clientDiscountPercent: 60, portalUsageDiscountPercent: 0 });
  const values = valuesFixture(100.11, 2, 234.3);
  const dv = displayValuesFixture(window, 100.11, 2);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 93.72, '234.30 × 0.40');
  assert.equal(values.SUB___WARTOSC_KONCOWA, 187.44, 'tyle samo, co w bazie');
});

test('rabat klienta 15% + bonus 1% = 16% od ceny katalogowej', () => {
  // Ten sam wynik, co opisuje services/portalUsageDiscount.js: procenty
  // łączą się w jeden, liczony od katalogu.
  const window = makeWindow({ clientDiscountPercent: 16, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(391.6, 1, 979);
  const dv = displayValuesFixture(window, 391.6);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 822.36, '979 × 0.84');
});

test('cena nie schodzi poniżej zera, choćby procenty sumowały się powyżej 100', () => {
  const window = makeWindow({ clientDiscountPercent: 100, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(82.8, 1, 207);
  const dv = displayValuesFixture(window, 82.8);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 0);
  assert.equal(values.SUB___WARTOSC_KONCOWA, 0);
});

test('wiersz rabatu jest DOKŁADNIE JEDEN, ukryty pod kłódką', () => {
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const dv = displayValuesFixture(window, 113.2);

  window.__discountTest.applyClientDiscount(valuesFixture(113.2), dv);

  // `SUB___CENA_RABAT` to sam procent cennikowy (już podbity o bonus) — KWOTĘ
  // rabatu niesie dokładnie jeden wiersz.
  const wiersze = Array.from(dv.keys()).filter((k) => /RABAT|PO_RABACIE/.test(k));
  assert.deepEqual(wiersze, ['SUB___CENA_RABAT', 'SUB___RABAT_KLIENTA'], 'żadnej drugiej kwoty rabatu');
  assert.equal(dv.get('SUB___RABAT_KLIENTA').locked, true);
  assert.equal(dv.get('SUB___RABAT_KLIENTA').option_value, '1%');
  assert.equal(dv.get('SUB___RABAT_KLIENTA').param_description, 'form.portal_usage_discount_label');
});

test('rabat klienta i bonus portalowy razem: jeden wiersz, oba w opisie', () => {
  const window = makeWindow({ clientDiscountPercent: 16, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(100);
  const dv = displayValuesFixture(window, 100);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 84, '16% liczone RAZ, nie 15% + 1% po kolei');
  const opis = dv.get('SUB___RABAT_KLIENTA').param_description;
  assert.match(opis, /client_discount_label/);
  assert.match(opis, /portal_usage_discount_label/);
});

test('dwa przeliczenia pod rząd nie kumulują rabatu', () => {
  // Silnik przelicza formuły od zera przy każdej zmianie pola, więc
  // `applyClientDiscount` dostaje za każdym razem kwotę SPRZED rabatu.
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const dv = displayValuesFixture(window, 113.2);

  window.__discountTest.applyClientDiscount(valuesFixture(113.2), dv);
  const values = valuesFixture(113.2);
  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 112.07);
  assert.equal(dv.get('SUB___CENA_KONCOWA').option_value, '112.07');
  assert.equal(dv.get('SUB___WARTOSC_KONCOWA').option_value, '112.07');
});

test('bez rabatu nic się nie zmienia i nie przybywa żaden wiersz', () => {
  const window = makeWindow({ clientDiscountPercent: 0 });
  const values = valuesFixture(113.2);
  const dv = displayValuesFixture(window, 113.2);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 113.2);
  assert.equal(values.SUB___WARTOSC_KONCOWA, 113.2);
  assert.equal(dv.has('SUB___RABAT_KLIENTA'), false);
  assert.equal(window.__discountTest.getTotal(dv).total_sub, 113.2);
});

test('stary wiersz kwoty rabatu znika przy edycji pozycji zapisanej wcześniej', () => {
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const dv = displayValuesFixture(window, 113.2);
  // tak wyglądała pozycja zapisana przed 2026-09-11
  dv.set('SUB___WARTOSC_PO_RABACIE', { option_value: '999', locked: true, sub: true, row: '2' });

  window.__discountTest.applyClientDiscount(valuesFixture(113.2), dv);

  assert.equal(dv.has('SUB___WARTOSC_PO_RABACIE'), false, 'zamrożona stara kwota nie może zostać');
  assert.equal(window.__discountTest.getTotal(dv).total_sub, 112.07);
});

test('VAT: bonus wchodzi do podstawy (jest w cenniku), rabat klienta NIE', () => {
  // Grupa 39 nie ma `SUB___SUMA_BRUTTO`, więc `applyVatToGrossValue` sięga po
  // `SUB___WARTOSC_KONCOWA`. Bonus jest częścią rabatu cennikowego, więc
  // podstawa VAT za nim idzie; rabat klienta VAT-u nie rusza (decyzja
  // właściciela z 2026-08-21) — stąd zapamiętana kwota sprzed niego.
  const window = makeWindow({ clientDiscountPercent: 16, portalUsageDiscountPercent: 1 });
  window.vatEnabled = true;
  window.vatRate = 19;
  const bruttoInput = window.document.createElement('input');
  bruttoInput.id = 'WARTOSC_BRUTTO';
  window.document.body.appendChild(bruttoInput);

  const values = valuesFixture(100, 1, 100);
  const dv = displayValuesFixture(window, 100);

  window.__discountTest.applyClientDiscount(values, dv);
  window.__discountTest.applyVatToGrossValue(values, dv);

  assert.equal(values.SUB___CENA_KONCOWA, 84, '100 − 16%');
  // podstawa VAT: 99 (po bonusie), nie 84 (po rabacie klienta)
  assert.equal(values.WARTOSC_BRUTTO, 117.81, '99 × 1.19');
  assert.equal(values.WARTOSC_VAT, 18.81);
});

test('liczone 61%, pokazywane 60% + 1% — i bonus stoi zaraz ZA rabatem cennikowym', () => {
  // ⚠️ Wiersz cennika ZOSTAJE na 60%, bo tuż pod nim stoi wiersz bonusu 1%.
  // Pokazanie 61% obok 1% czytałoby się jak 62% (uwaga właściciela).
  const window = makeWindow({ clientDiscountPercent: 1, portalUsageDiscountPercent: 1 });
  const values = valuesFixture(82.8, 1, 207);
  const dv = displayValuesFixture(window, 82.8);

  window.__discountTest.applyClientDiscount(values, dv);

  assert.equal(values.SUB___CENA_RABAT, 0.61, 'do liczenia: 61%');
  assert.equal(dv.get('SUB___CENA_RABAT').option_value, '60%', 'na liście: surowy cennik');
  assert.equal(dv.get('SUB___RABAT_KLIENTA').option_value, '1%', 'bonus osobno');
  assert.equal(values.SUB___CENA_KONCOWA, 80.73, '207 × 0.39');

  const klucze = Array.from(dv.keys());
  assert.equal(
    klucze[klucze.indexOf('SUB___CENA_RABAT') + 1],
    'SUB___RABAT_KLIENTA',
    'bonus zaraz za rabatem cennikowym, nie na końcu listy'
  );
});

test('wiersz bonusu zostaje w parametrach UKRYTYCH także przy zerowym rabacie', () => {
  // ⚠️ `hideSub`/`hideLocked` przepisują flagi z `window.subParams`/
  // `window.lockedParams` przy KAŻDYM przeliczeniu — również w cyklach bez
  // rabatu. Bez rejestracji kluczy przed wyjściem wiersz wypadał z ukrytych
  // (pozycja 7302 zapisała się z `locked: false, sub: false`).
  const window = makeWindow({ clientDiscountPercent: 0 });

  window.__discountTest.applyClientDiscount(valuesFixture(100), new window.Map());

  assert.ok(window.lockedParams.includes('SUB___RABAT_KLIENTA'));
  assert.ok(window.subParams.includes('SUB___RABAT_KLIENTA'));
});
