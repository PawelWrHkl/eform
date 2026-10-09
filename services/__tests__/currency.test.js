'use strict';

/**
 * Waluta cen klienta — services/currency.js (serwer) i
 * public/scripts/formTools/currencyLabel.js (formularz w przeglądarce).
 *
 * Najważniejsze reguły:
 *  • waluta zawsze NA KOŃCU opisu parametru kwotowego, w formacie `[KOD]`;
 *  • stary znacznik `[€]` (param.txt sprzed 2026-10-08, grupa 76) znika;
 *  • rabaty procentowe, powierzchnia i wymiary waluty nie dostają;
 *  • `user.currency` → `organization.currency` → EUR, a brak kolumn (przed
 *    migracją) to EUR — zachowanie sprzed zmiany;
 *  • oba bliźniacze `withCurrencyLabel` (serwer i przeglądarka) dają to samo.
 *
 * Baza podmieniona przez `deps.select` (bez MySQL-a). Moduł przeglądarkowy jest
 * bundlowany esbuildem i uruchamiany w `vm` — testujemy kod, który naprawdę
 * idzie do przeglądarki, nie jego kopię.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const esbuild = require('esbuild');

const {
  DEFAULT_CURRENCY,
  CURRENCIES,
  normalizeCurrency,
  pickCurrency,
  currencySymbol,
  withCurrencyLabel,
  currencyOfLabel,
  resolveCurrencyForOrder,
  resolveCurrencyForUserIdent
} = require('../currency');

const ROOT = path.join(__dirname, '..', '..');
const BROWSER_MODULE = path.join(ROOT, 'public', 'scripts', 'formTools', 'currencyLabel.js');

let cachedBundle = null;
/** Świeża instancja modułu przeglądarkowego z podanym `window.priceCurrency`. */
function loadBrowserModule(priceCurrency) {
  if (!cachedBundle) {
    cachedBundle = esbuild.buildSync({
      entryPoints: [BROWSER_MODULE],
      bundle: true,
      format: 'iife',
      globalName: '__currencyLabel',
      write: false,
      platform: 'browser',
      target: 'es2020',
      logLevel: 'silent'
    }).outputFiles[0].text;
  }
  const window = {};
  if (priceCurrency !== undefined) window.priceCurrency = priceCurrency;
  const context = vm.createContext({ window });
  vm.runInContext(`${cachedBundle}; window.__mod = __currencyLabel;`, context);
  return context.window.__mod;
}

const cicho = () => {};

// ─── Kody walut ─────────────────────────────────────────────────────────────

test('normalizeCurrency: tylko kody z listy, wielkość liter i spacje bez znaczenia', () => {
  assert.equal(normalizeCurrency('PLN'), 'PLN');
  assert.equal(normalizeCurrency(' pln '), 'PLN');
  assert.equal(normalizeCurrency('EUR'), 'EUR');
  assert.equal(normalizeCurrency('PNL'), null, 'literówka nie może wypisać klientowi [PNL]');
  assert.equal(normalizeCurrency(''), null);
  assert.equal(normalizeCurrency(null), null);
  assert.equal(normalizeCurrency(978), null);
});

test('pickCurrency: pierwszy znany kod wygrywa, bez żadnego — EUR', () => {
  assert.equal(pickCurrency(null, 'PLN'), 'PLN');
  assert.equal(pickCurrency('EUR', 'PLN'), 'EUR', 'klient nadpisuje organizację');
  assert.equal(pickCurrency('XYZ', 'PLN'), 'PLN', 'nieznany kod klienta = jak organizacja');
  assert.equal(pickCurrency(null, null), 'EUR');
  assert.equal(pickCurrency(), DEFAULT_CURRENCY);
  assert.equal(DEFAULT_CURRENCY, 'EUR');
});

test('currencySymbol: EUR → €, PLN → zł, nieznany → EUR', () => {
  assert.equal(currencySymbol('EUR'), '€');
  assert.equal(currencySymbol('pln'), 'zł');
  assert.equal(currencySymbol('XYZ'), '€');
});

// ─── Etykiety ───────────────────────────────────────────────────────────────

const LABEL_CASES = [
  // [opis z param.txt, waluta, oczekiwany opis]
  ['CENA HKL  netto', 'PLN', 'CENA HKL netto [PLN]'],             // nowe dane: po zdjętym [€] została podwójna spacja
  ['CENA HKL [€] netto', 'EUR', 'CENA HKL netto [EUR]'],          // stare wersje reguł / grupa 76
  ['CENA HKL [€] netto', 'PLN', 'CENA HKL netto [PLN]'],
  ['WARTOŚĆ BR.[€]', 'EUR', 'WARTOŚĆ BR. [EUR]'],
  ['CENA ŁĄCZNA  [€] (za szt)', 'PLN', 'CENA ŁĄCZNA (za szt) [PLN]'],
  ['WART. NET. PO RABACIE', 'EUR', 'WART. NET. PO RABACIE [EUR]'],
  ['CENA HKL netto [EUR]', 'PLN', 'CENA HKL netto [PLN]'],        // zmiana waluty, bez dublowania
  ['CENA HKL netto [PLN]', 'PLN', 'CENA HKL netto [PLN]'],        // idempotencja
  ['WARTOŚĆ VAT [€]', 'PLN', 'WARTOŚĆ VAT [PLN]'],                // tłumaczenie form.wartosc_vat_label
  ['CENA [PCS]', 'EUR', 'CENA [PCS] [EUR]'],                      // [PCS]/[SZT] to jednostki, nie waluty
  ['', 'PLN', ''],
  ['   ', 'PLN', '']
];

test('withCurrencyLabel (serwer): waluta na końcu, stary [€] znika', () => {
  for (const [input, currency, expected] of LABEL_CASES) {
    assert.equal(withCurrencyLabel(input, currency), expected, `${JSON.stringify(input)} + ${currency}`);
  }
  assert.equal(withCurrencyLabel('CENA', 'XYZ'), 'CENA [EUR]', 'nieznana waluta = EUR');
});

test('withCurrencyLabel: przeglądarka i serwer dają to samo', () => {
  const browser = loadBrowserModule('PLN');
  for (const [input, currency, expected] of LABEL_CASES) {
    assert.equal(browser.withCurrencyLabel(input, currency), expected, `${JSON.stringify(input)} + ${currency}`);
    assert.equal(browser.withCurrencyLabel(input, currency), withCurrencyLabel(input, currency));
  }
});

test('lista walut przeglądarki = lista serwera (kody i symbole)', () => {
  const browser = loadBrowserModule();
  assert.deepEqual([...browser.KNOWN_CURRENCIES], Object.keys(CURRENCIES));
  for (const [code, meta] of Object.entries(CURRENCIES)) {
    assert.equal(browser.currencySymbol(code), meta.symbol, code);
  }
  assert.equal(browser.currencySymbol('€'), '€');
});

test('currencyOfLabel: kod z końca etykiety albo stary [€]', () => {
  assert.equal(currencyOfLabel('CENA HKL netto [PLN]'), 'PLN');
  assert.equal(currencyOfLabel('CENA HKL netto [EUR] '), 'EUR');
  assert.equal(currencyOfLabel('CENA HKL [€] netto'), 'EUR', 'pozycja zapisana przed 2026-10-08');
  assert.equal(currencyOfLabel('POW [M2]'), null);
  assert.equal(currencyOfLabel('ILOŚĆ [PCS]'), null);
  assert.equal(currencyOfLabel(''), null);
  assert.equal(currencyOfLabel(undefined), null);
});

// ─── Które parametry są kwotowe ─────────────────────────────────────────────

// Wycinek prawdziwych definicji z param.txt (grupy 71, 81, 39, 01) — bez
// czytania udziału, żeby test nie zależał od żywych danych.
const PARAMS = [
  { NAME: 'ILOSC', DESCRIPTION: 'ILOŚĆ', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '1' },
  { NAME: 'SZEROKOSC', DESCRIPTION: 'SZEROKOŚĆ [MM]', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '1' },
  { NAME: 'SZEROKOSC_DACH', DESCRIPTION: 'SZEROKOSC [MM]', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'POW', DESCRIPTION: 'POW.[M2]', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'CENA', DESCRIPTION: 'CENA HKL  netto', TYPE: '<NULL>', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'CENAPASEK', DESCRIPTION: 'CENA HKL  netto', TYPE: '<NULL>', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'DOPLATA', DESCRIPTION: 'DOPŁATA DET.  netto', TYPE: '<NULL>', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'DOPLATA_EL', DESCRIPTION: 'DOPŁATA EL DET.  netto', TYPE: '<NULL>', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'CENA_SUMA', DESCRIPTION: 'CENA ŁĄCZNA   (za szt)', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'SUMA_BRUTTO', DESCRIPTION: 'WARTOŚĆ BR.', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2', LISTSUM: 'true' },
  { NAME: 'SUMA_NETTO', DESCRIPTION: 'WARTOŚĆ netto', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2', LISTSUM: 'true' },
  { NAME: 'CENA_RABAT', DESCRIPTION: 'RABAT', TYPE: '<NULL>', FORMAT: 'n%', LISTROW: '2' },
  { NAME: 'DOPLATA_EL_RABAT', DESCRIPTION: 'RABAT EL', TYPE: '<NULL>', FORMAT: 'n%', LISTROW: '2' },
  { NAME: 'CENA_EL_RABAT', DESCRIPTION: 'RABAT EL', TYPE: '<NULL>', FORMAT: 'n%', LISTROW: '2' },
  // grupa 81: stawka rabatu (ułamek) BEZ formatu procentowego
  { NAME: 'DOPLATA_RABAT', DESCRIPTION: 'AUFPREIS RABATT', TYPE: '<NULL>', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'CENA_KONCOWA', DESCRIPTION: 'CENA NETTO PO RABACIE', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'WARTOSC_KONCOWA', DESCRIPTION: 'WART. NET. PO RABACIE', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2', LISTSUM: 'true' },
  { NAME: 'SUB___CENA', DESCRIPTION: 'CENA DET.  netto', TYPE: '<NULL>', FORMAT: '<NULL>', LISTROW: '2' },
  { NAME: 'SUB___CENA_RABAT', DESCRIPTION: 'RABAT OD CENNIKÓW', TYPE: '<NULL>', FORMAT: 'n%', LISTROW: '2' },
  { NAME: 'SUB___SUMA_BRUTTO', DESCRIPTION: 'WARTOŚĆ BR.', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2', LISTSUM: 'true' },
  { NAME: 'SUB___WARTOSC_KONCOWA', DESCRIPTION: 'WART. NET. PO RABACIE', TYPE: 'numeric', FORMAT: '<NULL>', LISTROW: '2', LISTSUM: 'true' },
  { NAME: 'OPIS_CENY', DESCRIPTION: 'OPIS_CENY', TYPE: '<NULL>', FORMAT: '<NULL>', LISTROW: '0' },
  { NAME: 'ZALACZNIK_1', DESCRIPTION: 'Załącznik 1', TYPE: 'file', FORMAT: '<NULL>', LISTROW: '0' }
];

const MONETARY = [
  'CENA', 'CENAPASEK', 'DOPLATA', 'DOPLATA_EL', 'CENA_SUMA', 'SUMA_BRUTTO', 'SUMA_NETTO',
  'CENA_KONCOWA', 'WARTOSC_KONCOWA', 'SUB___CENA', 'SUB___SUMA_BRUTTO', 'SUB___WARTOSC_KONCOWA'
];

test('isMonetaryParam: ceny, dopłaty, sumy i wartości — bez rabatów, POW, wymiarów, załączników', () => {
  const { isMonetaryParam } = loadBrowserModule();
  const got = PARAMS.filter((p) => isMonetaryParam(p)).map((p) => p.NAME);
  assert.deepEqual(got, MONETARY);
  assert.equal(isMonetaryParam(null), false);
  assert.equal(isMonetaryParam({}), false);
});

test('applyCurrencyToParams: opis dostaje walutę strony, reszta parametrów bez zmian', () => {
  const mod = loadBrowserModule('PLN');
  const params = PARAMS.map((p) => ({ ...p }));
  mod.applyCurrencyToParams(params);
  const byName = Object.fromEntries(params.map((p) => [p.NAME, p.DESCRIPTION]));
  assert.equal(byName.CENA, 'CENA HKL netto [PLN]');
  assert.equal(byName.SUMA_BRUTTO, 'WARTOŚĆ BR. [PLN]');
  assert.equal(byName.SUB___WARTOSC_KONCOWA, 'WART. NET. PO RABACIE [PLN]');
  assert.equal(byName.CENA_RABAT, 'RABAT');
  assert.equal(byName.POW, 'POW.[M2]');
  assert.equal(byName.SZEROKOSC_DACH, 'SZEROKOSC [MM]');
  assert.equal(byName.ZALACZNIK_1, 'Załącznik 1');

  const eur = loadBrowserModule(undefined);
  const plain = [{ NAME: 'CENA', DESCRIPTION: 'CENA HKL [€] netto' }];
  eur.applyCurrencyToParams(plain);
  assert.equal(plain[0].DESCRIPTION, 'CENA HKL netto [EUR]', 'strona bez waluty = EUR');
});

test('getPriceCurrency: kod ze strony, śmieci i brak = EUR', () => {
  assert.equal(loadBrowserModule('PLN').getPriceCurrency(), 'PLN');
  assert.equal(loadBrowserModule(' pln ').getPriceCurrency(), 'PLN');
  assert.equal(loadBrowserModule('').getPriceCurrency(), 'EUR');
  assert.equal(loadBrowserModule('złoty').getPriceCurrency(), 'EUR');
  assert.equal(loadBrowserModule(undefined).getPriceCurrency(), 'EUR');
  assert.equal(loadBrowserModule(undefined).hasPageCurrency(), false);
  assert.equal(loadBrowserModule('EUR').hasPageCurrency(), true);
});

test('refreshSavedCurrencyLabels: edycja poprawia sam znacznik waluty, tylko gdy strona zna walutę', () => {
  const saved = () => new Map([
    ['CENA', { param_description: 'CENA HKL [€] netto', option_value: '10' }],
    ['SUMA_BRUTTO', { param_description: 'WARTOŚĆ BR.[€]', option_value: '20', listsum: true }],
    ['CENA_RABAT', { param_description: 'RABAT', option_value: '45%' }],
    ['MODEL', { param_description: 'MODEL', option_value: 'X' }]
  ]);
  const params = PARAMS.concat([{ NAME: 'MODEL', DESCRIPTION: 'MODEL' }]);

  const pln = loadBrowserModule('PLN');
  const display = saved();
  // `___TITLE` z zapisu: z niego `param-OPIS_CENY.js` składa opis ceny już przy
  // pierwszym przeliczeniu (sprawdzone na pozycji 7521: „LISTENPREIS [€]=382”).
  const values = { CENA___TITLE: 'CENA HKL [€] netto', CENA_RABAT___TITLE: 'RABAT', MODEL___TITLE: 'MODEL' };
  pln.refreshSavedCurrencyLabels(params, display, values);
  assert.deepEqual(values, { CENA___TITLE: 'CENA HKL netto [PLN]', CENA_RABAT___TITLE: 'RABAT', MODEL___TITLE: 'MODEL' });
  assert.equal(display.get('CENA').param_description, 'CENA HKL netto [PLN]');
  assert.equal(display.get('SUMA_BRUTTO').param_description, 'WARTOŚĆ BR. [PLN]');
  assert.equal(display.get('SUMA_BRUTTO').listsum, true, 'pozostałe pola wpisu nietknięte');
  assert.equal(display.get('CENA_RABAT').param_description, 'RABAT');
  assert.equal(display.get('MODEL').param_description, 'MODEL');

  // Strona bez `window.priceCurrency` (np. stary szablon) NIE może przepisać
  // zapisanej waluty na domyślne EUR.
  const unknown = loadBrowserModule(undefined);
  const untouched = new Map([['CENA', { param_description: 'CENA HKL netto [PLN]' }]]);
  const untouchedValues = { CENA___TITLE: 'CENA HKL netto [PLN]' };
  unknown.refreshSavedCurrencyLabels(params, untouched, untouchedValues);
  assert.equal(untouched.get('CENA').param_description, 'CENA HKL netto [PLN]');
  assert.equal(untouchedValues.CENA___TITLE, 'CENA HKL netto [PLN]');
});

test('savedLabelWithCurrency: zapisany opis zostaje, gdy strona nie zna waluty', () => {
  const pln = loadBrowserModule('PLN');
  assert.equal(pln.savedLabelWithCurrency('WARTOŚĆ VAT [€]', 'x'), 'WARTOŚĆ VAT [PLN]');
  assert.equal(pln.savedLabelWithCurrency('', 'WARTOŚĆ BRUTTO [€]'), 'WARTOŚĆ BRUTTO [PLN]');
  const unknown = loadBrowserModule(undefined);
  assert.equal(unknown.savedLabelWithCurrency('WARTOŚĆ VAT [PLN]', 'x'), 'WARTOŚĆ VAT [PLN]');
  assert.equal(unknown.savedLabelWithCurrency(undefined, 'WARTOŚĆ BRUTTO [€]'), 'WARTOŚĆ BRUTTO [EUR]');
});

// ─── Baza ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = /information_schema\.COLUMNS/;

/** Atrapa `selectQuery`: najpierw schemat, potem wiersz klienta. */
function fakeDb({ columns = ['user', 'organization'], row = null, fail = false } = {}) {
  const calls = [];
  const select = async (sql, params) => {
    calls.push({ sql, params });
    if (SCHEMA_SQL.test(sql)) return columns.length ? columns.map((t) => ({ table_name: t })) : false;
    if (fail) throw new Error('boom');
    return row ? [row] : false;
  };
  return { select, calls };
}

test('resolveCurrencyForOrder: organizacja PLN, klient bez własnej waluty → PLN', async () => {
  const db = fakeDb({ row: { user_currency: null, org_currency: 'PLN' } });
  assert.equal(await resolveCurrencyForOrder(123, { select: db.select, log: cicho }), 'PLN');
  const main = db.calls.find((c) => !SCHEMA_SQL.test(c.sql));
  assert.match(main.sql, /JOIN `order` o ON o\.user_id = u\.id WHERE o\.id = \?/);
  assert.deepEqual(main.params, [123]);
});

test('resolveCurrencyForOrder: waluta klienta nadpisuje organizację', async () => {
  const db = fakeDb({ row: { user_currency: 'EUR', org_currency: 'PLN' } });
  assert.equal(await resolveCurrencyForOrder(1, { select: db.select, log: cicho }), 'EUR');
});

test('resolveCurrencyForOrder: nieznany kod w bazie → pominięty z wpisem w logu', async () => {
  const logged = [];
  const db = fakeDb({ row: { user_currency: 'PNL', org_currency: 'PLN' } });
  assert.equal(await resolveCurrencyForOrder(1, { select: db.select, log: (...a) => logged.push(a.join(' ')) }), 'PLN');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /user\.currency='PNL'/);
});

test('resolveCurrencyForOrder: przed migracją (brak kolumn) — EUR bez zapytania o klienta', async () => {
  const db = fakeDb({ columns: [] });
  assert.equal(await resolveCurrencyForOrder(1, { select: db.select, log: cicho }), 'EUR');
  assert.equal(db.calls.length, 1, 'tylko sprawdzenie schematu');
});

test('resolveCurrencyForOrder: tylko kolumna organizacji — nie odwołuje się do user.currency', async () => {
  const db = fakeDb({ columns: ['organization'], row: { user_currency: null, org_currency: 'PLN' } });
  assert.equal(await resolveCurrencyForOrder(1, { select: db.select, log: cicho }), 'PLN');
  const main = db.calls.find((c) => !SCHEMA_SQL.test(c.sql));
  assert.doesNotMatch(main.sql, /u\.currency/);
  assert.match(main.sql, /org\.currency/);
});

test('resolveCurrencyForOrder: brak zamówienia / błąd bazy / brak id → EUR', async () => {
  assert.equal(await resolveCurrencyForOrder(1, { select: fakeDb({ row: null }).select, log: cicho }), 'EUR');
  assert.equal(await resolveCurrencyForOrder(1, { select: fakeDb({ fail: true }).select, log: cicho }), 'EUR');
  const db = fakeDb();
  assert.equal(await resolveCurrencyForOrder(null, { select: db.select, log: cicho }), 'EUR');
  assert.equal(db.calls.length, 0);
});

test('resolveCurrencyForUserIdent: po identyfikatorze klienta', async () => {
  const db = fakeDb({ row: { user_currency: null, org_currency: 'PLN' } });
  assert.equal(await resolveCurrencyForUserIdent('KLIENT-1', { select: db.select, log: cicho }), 'PLN');
  const main = db.calls.find((c) => !SCHEMA_SQL.test(c.sql));
  assert.match(main.sql, /WHERE u\.ident = \?/);
  assert.deepEqual(main.params, ['KLIENT-1']);
  assert.equal(await resolveCurrencyForUserIdent('', { select: db.select, log: cicho }), 'EUR');
});
