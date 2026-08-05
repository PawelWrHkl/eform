'use strict';

/**
 * Renderowanie dokumentu: kontekst → Nunjucks → HTML → (Playwright) → PDF.
 *
 * Wzorowane na `services/mailBot/pdfGenerator.js` (ta sama instalacja Chromium,
 * te same flagi `--no-sandbox`), ale z własnym środowiskiem Nunjucks — dzięki
 * temu filtry faktur (`money`, `qty`, `t`) nie wyciekają do globalnego env
 * szablonów aplikacji i odwrotnie.
 *
 * ⚠️ `nunjucks.configure()` w tym repo jest wywoływane w wielu miejscach i
 * KAŻDE wywołanie podmienia konfigurację globalną. Dlatego tutaj używamy
 * `new nunjucks.Environment(...)` — izolowana instancja, bez efektów ubocznych
 * na `mailBot`/`server.js`.
 *
 * @typedef {import('../domain/types').Invoice} Invoice
 */

const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');
const money = require('../core/money');
const { DocumentType, PaymentMethod } = require('../domain/constants');
const { log } = require('../../../utils/logging');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const I18N_DIR = path.join(__dirname, '..', 'i18n');

/** Języki z gotowym słownikiem. Brakujący język → fallback na `pl`. */
const SUPPORTED_LANGS = ['pl', 'en', 'de'];

/** @type {Map<string, Record<string, string>>} */
const dictionaryCache = new Map();

/**
 * @param {string} lang
 * @returns {Record<string, string>}
 */
function loadDictionary(lang) {
  const code = SUPPORTED_LANGS.includes(lang) ? lang : 'pl';
  if (dictionaryCache.has(code)) return dictionaryCache.get(code);
  const dict = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${code}.json`), 'utf8'));
  dictionaryCache.set(code, dict);
  return dict;
}

/**
 * Tłumacz dla danego języka. Nieznany klucz zwraca sam klucz — na wydruku widać
 * wtedy `items.foo` zamiast pustego miejsca, co jest łatwiejsze do wyłapania.
 *
 * @param {string} lang
 * @returns {(key: string) => string}
 */
function createTranslator(lang) {
  const dict = loadDictionary(lang);
  const fallback = lang === 'pl' ? dict : loadDictionary('pl');
  return (key) => dict[key] ?? fallback[key] ?? key;
}

/**
 * Izolowane środowisko Nunjucks z filtrami dokumentu.
 *
 * @param {Object} params
 * @param {string} params.lang
 * @param {string} params.currency
 * @param {string} params.localCurrency
 * @returns {nunjucks.Environment}
 */
function createEnvironment({ lang, currency, localCurrency }) {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(TEMPLATES_DIR, { noCache: true }), {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true
  });

  const t = createTranslator(lang);
  env.addGlobal('t', t);
  env.addGlobal('DocumentType', DocumentType);
  env.addGlobal('PaymentMethod', PaymentMethod);

  /** Kwota w minor units → sformatowany string w walucie dokumentu. */
  env.addFilter('money', (minor, cur) => money.format(Math.trunc(Number(minor) || 0), cur || currency, lang));
  /** Kwota w walucie lokalnej sprzedawcy (podsumowanie VAT). */
  env.addFilter('moneyLocal', (minor) => money.format(Math.trunc(Number(minor) || 0), localCurrency, lang));
  /** Ilość: max 3 miejsca po przecinku, bez zbędnych zer (2.5 m², nie 2.500). */
  env.addFilter('qty', (value) => new Intl.NumberFormat(lang, { maximumFractionDigits: 3 }).format(Number(value) || 0));
  /** Stawka VAT: 23 → „23%", 0 → „0%" (kategorie zerowe opisuje adnotacja prawna). */
  env.addFilter('rate', (value) => `${new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(Number(value) || 0)}%`);
  /** Data `YYYY-MM-DD` → format lokalny. */
  env.addFilter('date', (value) => {
    if (!value) return '';
    const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat(lang).format(d);
  });
  /** Jednostka miary → etykieta z i18n. */
  env.addFilter('unitLabel', (value) => t(`unit.${value}`));

  return env;
}

/**
 * Zmienne motywu jako deklaracje CSS custom properties.
 * Kolejność: motyw szablonu → nadpisania organizacji.
 *
 * @param {Record<string, string>} templateVars
 * @param {Record<string, string>} orgVars
 * @returns {string}
 */
function buildThemeCss(templateVars = {}, orgVars = {}) {
  const merged = { ...templateVars, ...orgVars };
  const decls = Object.entries(merged)
    // Twarda walidacja nazw i wartości — `theme_vars` przychodzi z bazy i trafia
    // do <style>, więc nie może być wektorem wstrzyknięcia CSS.
    .filter(([k, v]) => /^[a-z0-9-]+$/i.test(k) && typeof v === 'string' && !/[<>{};]/.test(v))
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n');
  return decls ? `:root {\n${decls}\n}` : '';
}

/**
 * Buduje kompletny dokument HTML faktury (CSS inline, logo jako data URI).
 *
 * @param {Object} params
 * @param {Invoice} params.invoice
 * @param {Object} [params.profile]                Profil organizacji (stopka, bank).
 * @param {{ templateFile: string, stylesheet: string, themeVars?: object }} [params.template]
 * @param {string} [params.logoDataUri]
 * @returns {string}
 */
function renderInvoiceHtml({ invoice, profile = {}, template = {}, logoDataUri = '' }) {
  const lang = invoice.lang || profile.defaultLang || 'pl';
  const env = createEnvironment({
    lang,
    currency: invoice.currency,
    localCurrency: invoice.localCurrency || invoice.currency
  });

  const templateFile = template.templateFile || 'invoice-main.njk';
  const stylesheet = template.stylesheet || 'styles/invoice.css';
  const cssPath = path.join(TEMPLATES_DIR, stylesheet);
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
  const themeCss = buildThemeCss(template.themeVars, profile.themeVars);

  const footerNote = (profile.footerNotes && (profile.footerNotes[lang] || profile.footerNotes.pl)) || '';

  const body = env.render(templateFile, {
    invoice,
    profile,
    logoDataUri,
    footerNote,
    lang
  });

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${invoice.number || 'draft'}</title>
  <style>
${css}
${themeCss}
  </style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * HTML → PDF przez Chromium.
 *
 * Playwright jest wymagany dopiero tutaj (`require` wewnątrz funkcji), żeby
 * podglądy HTML i testy jednostkowe nie ciągnęły całej przeglądarki.
 *
 * @param {string} html
 * @param {Object} [opts]
 * @param {boolean} [opts.landscape=false]  Faktura domyślnie portret A4.
 * @param {string} [opts.format='A4']
 * @returns {Promise<Buffer>}
 */
async function renderPdfFromHtml(html, opts = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await page.pdf({
      format: opts.format || 'A4',
      landscape: !!opts.landscape,
      printBackground: true,
      margin: { top: '12mm', right: '10mm', bottom: '14mm', left: '10mm' }
    });
  } catch (err) {
    log(`[invoices] renderPdfFromHtml error: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Skrót: dokument → PDF w jednym kroku.
 * @param {Parameters<typeof renderInvoiceHtml>[0] & { pdfOptions?: object }} params
 * @returns {Promise<Buffer>}
 */
async function renderInvoicePdf(params) {
  const html = renderInvoiceHtml(params);
  return renderPdfFromHtml(html, params.pdfOptions || {});
}

/**
 * Logo organizacji jako data URI (Chromium nie ma dostępu do sieci w tym torze).
 * @param {string} photoPathValue Nazwa pliku z `organization.photo_path`.
 * @returns {string} data URI albo pusty string
 */
function loadLogoDataUri(photoPathValue) {
  if (!photoPathValue) return '';
  const file = path.join(__dirname, '..', '..', '..', 'img', photoPathValue);
  if (!fs.existsSync(file)) {
    log(`[invoices] logo nie istnieje: ${file}`);
    return '';
  }
  const ext = path.extname(file).slice(1).toLowerCase() || 'png';
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(file, { encoding: 'base64' })}`;
}

module.exports = {
  SUPPORTED_LANGS,
  loadDictionary,
  createTranslator,
  createEnvironment,
  buildThemeCss,
  renderInvoiceHtml,
  renderPdfFromHtml,
  renderInvoicePdf,
  loadLogoDataUri
};
