/**
 * Waluta w opisach parametrów kwotowych konfiguratora.
 *
 * Każdy parametr kwotowy (cena, dopłata, suma, wartość — patrz
 * `isMonetaryParam`) dostaje w opisie NA KOŃCU kod waluty klienta:
 * „CENA HKL netto [PLN]”, „WARTOŚĆ BR. [EUR]”. Opis idzie dalej do
 * `displayValues.param_description` (zapis pozycji → podgląd zlecenia, PDF,
 * mail) i do `<PARAM>___TITLE` (skrypty `param-OPIS_CENY.js`).
 *
 * Waluta przychodzi z serwera jako `window.priceCurrency` (services/currency.js:
 * `user.currency` → `organization.currency` → EUR, liczone dla klienta
 * ZAMÓWIENIA). Brak — EUR, ale WTEDY zapisanych opisów nie ruszamy
 * (`refreshSavedCurrencyLabels`), żeby strona bez tej informacji nie
 * przepisała „[PLN]” na „[EUR]”.
 *
 * ⚠️ Autorzy danych zdjęli 2026-10-08 `[€]` ze środka opisów w param.txt
 * („CENA HKL [€] netto” → „CENA HKL  netto”). Stare wersje reguł i grupa 76
 * wciąż je mają, więc znacznik jest usuwany przed dopisaniem waluty.
 *
 * ⚠️ `withCurrencyLabel` ma bliźniaka w services/currency.js (tłumaczenie
 * tabel pozycji na serwerze) — services/__tests__/currency.test.js pilnuje,
 * że oba dają to samo.
 */

export const DEFAULT_CURRENCY = 'EUR';

/**
 * Kod → symbol; ta sama lista co `CURRENCIES` w services/currency.js (test
 * pilnuje zgodności). Symbol czyta widok B konfiguratora (uiVariantView.js).
 */
const CURRENCY_SYMBOLS = Object.freeze({ EUR: '€', PLN: 'zł' });
export const KNOWN_CURRENCIES = Object.freeze(Object.keys(CURRENCY_SYMBOLS));

/** Symbol waluty („PLN” → „zł”, „€” → „€”); nieznany kod zostaje kodem. */
export function currencySymbol(code) {
  const key = String(code ?? '').trim().toUpperCase();
  if (key === '€') return CURRENCY_SYMBOLS.EUR;
  return CURRENCY_SYMBOLS[key] || key || CURRENCY_SYMBOLS[DEFAULT_CURRENCY];
}

const CODE_RE = /^[A-Z]{3}$/;

function pageCurrencyCode() {
  const raw = typeof window !== 'undefined' ? window.priceCurrency : undefined;
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return CODE_RE.test(code) ? code : null;
}

/** Waluta cen na tej stronie (`window.priceCurrency`), inaczej EUR. */
export function getPriceCurrency() {
  return pageCurrencyCode() || DEFAULT_CURRENCY;
}

/** Czy serwer podał walutę — tylko wtedy wolno poprawić opisy zapisanej pozycji. */
export function hasPageCurrency() {
  return pageCurrencyCode() !== null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Znaczniki do zdjęcia: `[€]`, znane kody i bieżąca waluta. Świadomie BEZ
 * ogólnego `[A-Z]{3}` — w opisach param.txt są też jednostki `[PCS]`, `[SZT]`.
 */
function markerRe(currency) {
  const codes = new Set(['€', ...KNOWN_CURRENCIES, currency]);
  return new RegExp(`\\s*\\[(?:${[...codes].map(escapeRegExp).join('|')})\\]`, 'g');
}

/**
 * „CENA HKL [€] netto” + PLN → „CENA HKL netto [PLN]”. Waluta zawsze na końcu,
 * podwójne spacje (ślad po zdjętym `[€]`) ściągnięte, pusty opis zostaje pusty.
 */
export function withCurrencyLabel(description, currency = getPriceCurrency()) {
  const code = CODE_RE.test(String(currency || '')) ? currency : DEFAULT_CURRENCY;
  const base = String(description ?? '').replace(markerRe(code), ' ').replace(/\s+/g, ' ').trim();
  if (!base) return base;
  return `${base} [${code}]`;
}

/** Rdzeń nazwy parametru kwotowego (po zdjęciu `SUB___`). */
const MONETARY_NAME_RE = /^(CENA|DOPLATA|SUMA|WARTOSC)/;

/**
 * Parametr kwotowy = nazwa z rodziny CENA/DOPLATA/SUMA/WARTOSC (także `SUB___`),
 * który NIE jest stawką rabatu. Dokładnie te parametry miały `[€]` w opisie,
 * zanim autorzy danych go zdjęli (sprawdzone na wszystkich grupach 2026-10-08).
 *
 * Poza: rabaty (`*_RABAT` — ułamek/procent, nie kwota; w grupie 81 bez
 * `FORMAT n%`, stąd warunek na nazwę), wszystko z formatem procentowym,
 * powierzchnia `POW`, wymiary, załączniki.
 */
export function isMonetaryParam(param) {
  if (!param || typeof param.NAME !== 'string') return false;
  if (param.TYPE === 'file') return false;
  if (String(param.FORMAT ?? '').includes('%')) return false;
  // `_S` = specyfikacja ceny (`CENA_S`, `CENA_RABAT_S`) — liczy się jej rodzic.
  const base = param.NAME.replace(/^SUB___/, '').replace(/_S$/, '');
  if (/RABAT$/.test(base)) return false;
  return MONETARY_NAME_RE.test(base);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '' && value !== '<NULL>';
}

/** Dopisuje walutę do opisów parametrów kwotowych (mutuje i zwraca `params`). */
export function applyCurrencyToParams(params, currency = getPriceCurrency()) {
  for (const param of params || []) {
    if (!isMonetaryParam(param)) continue;
    if (hasText(param.DESCRIPTION)) param.DESCRIPTION = withCurrencyLabel(param.DESCRIPTION, currency);
    if (hasText(param.ALIAS_DESCRIPTION)) param.ALIAS_DESCRIPTION = withCurrencyLabel(param.ALIAS_DESCRIPTION, currency);
  }
  return params;
}

/**
 * Opis wiersza liczonego poza param.txt (VAT/brutto): opis już zapisany
 * z pozycją dostaje walutę tylko, gdy strona ją zna (jak w
 * `refreshSavedCurrencyLabels`); bez zapisanego — `fallback` z walutą.
 */
export function savedLabelWithCurrency(saved, fallback) {
  if (hasText(saved)) return hasPageCurrency() ? withCurrencyLabel(saved) : saved;
  return withCurrencyLabel(fallback);
}

/**
 * Edycja / „Przelicz”: zapisane `displayValues` i `values` niosą opis z dnia
 * zapisu („CENA HKL [€] netto”), a formularz przy edycji go nie odtwarza.
 * Poprawiamy WYŁĄCZNIE znacznik waluty w opisach parametrów kwotowych — reszta
 * tekstu (także język zapisu) zostaje. Nic nie robi, gdy strona nie zna waluty.
 *
 * `<PARAM>___TITLE` też, bo skrypty `param-OPIS_CENY.js` składają z niego
 * opis ceny już przy PIERWSZYM przeliczeniu — a `fillInputDescription`
 * odświeża tytuły dopiero na końcu `updateProcedure`.
 */
export function refreshSavedCurrencyLabels(params, displayValues, values = null, currency = getPriceCurrency()) {
  if (!hasPageCurrency()) return;
  const hasDisplay = displayValues && typeof displayValues.get === 'function';
  for (const param of params || []) {
    if (!isMonetaryParam(param)) continue;
    const entry = hasDisplay ? displayValues.get(param.NAME) : null;
    if (entry && typeof entry === 'object' && hasText(entry.param_description)) {
      entry.param_description = withCurrencyLabel(entry.param_description, currency);
    }
    const titleKey = `${param.NAME}___TITLE`;
    if (values && hasText(values[titleKey])) {
      values[titleKey] = withCurrencyLabel(values[titleKey], currency);
    }
  }
}
