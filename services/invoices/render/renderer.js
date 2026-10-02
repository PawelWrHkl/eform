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
const { DEFAULT_TEMPLATE, normalizeTemplatePath, parsePageMargins } = require('../core/templates');
const { log } = require('../../../utils/logging');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
/** Formatki organizacji (papier firmowy w PDF) — `invoice_template.background_file`. */
const BACKGROUNDS_DIR = path.join(__dirname, '..', '..', '..', 'img', 'invoice-background');

/**
 * CSS doklejany, gdy treść idzie na formatkę: strona przezroczysta (inaczej
 * biały `body` z `invoice.css` zakryłby papier firmowy) i treść na całą
 * szerokość pola, które formatka zostawia między marginesami.
 */
const BACKGROUND_CSS = `
body, .invoice { background: transparent !important; }
.invoice { max-width: none !important; }`;
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
 * Pliki szablonu wskazane w bazie (`invoice_template`) → pliki, które naprawdę
 * wyrenderujemy.
 *
 * ⚠️ Zły albo brakujący plik NIE blokuje dokumentu: bierzemy szablon domyślny
 * i zostawiamy ostrzeżenie w logu. Dane faktury są te same w każdym szablonie,
 * a 500 przy podglądzie/PDF-ie (np. wdrożenie bez nowego pliku organizacji)
 * oznaczałoby fakturę, której nie da się wysłać klientowi.
 *
 * @param {{ code?: string, templateFile?: string, stylesheet?: string }} [template]
 * @param {{ exists?: (absPath: string) => boolean, warn?: (msg: string) => void }} [opts]
 * @returns {{ templateFile: string, stylesheet: string }}
 */
function resolveTemplateFiles(template = {}, { exists = fs.existsSync, warn = log } = {}) {
  const pick = (value, extension, fallback, kind) => {
    if (!value) return fallback;
    const rel = normalizeTemplatePath(value, extension);
    const abs = rel ? path.resolve(TEMPLATES_DIR, rel) : null;
    if (!abs || !abs.startsWith(TEMPLATES_DIR + path.sep)) {
      warn(`[invoices] szablon „${template.code || '?'}": niedozwolona ścieżka ${kind} „${value}" — używam ${fallback}`);
      return fallback;
    }
    if (!exists(abs)) {
      warn(`[invoices] szablon „${template.code || '?'}": brak pliku ${kind} ${rel} w ${TEMPLATES_DIR} — używam ${fallback}`);
      return fallback;
    }
    return rel;
  };
  return {
    templateFile: pick(template.templateFile, '.njk', DEFAULT_TEMPLATE.templateFile, 'szablonu'),
    stylesheet: pick(template.stylesheet, '.css', DEFAULT_TEMPLATE.stylesheet, 'arkusza')
  };
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
function renderInvoiceHtml({ invoice, profile = {}, template = {}, logoDataUri = '', onBackground = false }) {
  const lang = invoice.lang || profile.defaultLang || 'pl';
  const env = createEnvironment({
    lang,
    currency: invoice.currency,
    localCurrency: invoice.localCurrency || invoice.currency
  });

  const { templateFile, stylesheet } = resolveTemplateFiles(template);
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
${onBackground ? BACKGROUND_CSS : ''}
  </style>
</head>
<body>${body}</body>
</html>`;
}

const PX_PER_MM = 96 / 25.4;

/**
 * Skala, przy której treść mieści się na JEDNEJ stronie — o ile wystarczy
 * niewielkie pomniejszenie.
 *
 * Pole treści na formatce jest niższe niż na czystym A4 (pasy nagłówka
 * i stopki: Luxan 159 mm zamiast 184 mm), więc jednopozycyjna faktura
 * wypychała blok „Płatność + podpisy" na drugą, prawie pustą stronę.
 * Długie faktury i tak mają kilka stron — dla nich zostaje skala 1, żeby
 * pomniejszenie nie było kosztem bez zysku.
 *
 * Pomiar: układ w trybie druku na szerokości pola treści. Przy skali `s`
 * Chromium układa stronę na szerokości `W / s`, więc wiersze się nie
 * wydłużają, a wysokość spada co najmniej proporcjonalnie.
 *
 * @param {import('playwright').Page} page
 * @param {{ contentWidthMm: number, availableHeightMm: number, minScale?: number }} fit
 * @returns {Promise<number>}
 */
async function fitScale(page, { contentWidthMm, availableHeightMm, minScale = 0.8 }) {
  // Wysokość okna minimalna: `scrollHeight` dokumentu nigdy nie schodzi poniżej
  // okna, więc mierzymy samo `body` (marginesy 0 w `invoice.css`).
  await page.setViewportSize({ width: Math.round(contentWidthMm * PX_PER_MM), height: 100 });
  await page.emulateMedia({ media: 'print' });
  const neededMm = (await page.evaluate(() => document.body.getBoundingClientRect().height)) / PX_PER_MM;
  if (neededMm <= availableHeightMm) return 1;
  // 2% luzu na zaokrąglenia i podział strony po `break-inside: avoid`
  const scale = (availableHeightMm / neededMm) * 0.98;
  return scale >= minScale ? Number(scale.toFixed(3)) : 1;
}

/**
 * HTML → PDF przez Chromium.
 *
 * Playwright jest wymagany dopiero tutaj (`require` wewnątrz funkcji), żeby
 * podglądy HTML i testy jednostkowe nie ciągnęły całej przeglądarki.
 *
 * @param {string} html
 * @param {Object} [opts]
 * @param {boolean} [opts.landscape=true]  Faktura jest POZIOMA (A4 landscape) —
 *        tak jak PDF zamówienia, bo tabela pozycji niesie dużo kolumn (numer
 *        zamówienia, wymiary, ilość, netto, stawka, VAT, brutto). W pionie
 *        kolumny robiły się nieczytelnie wąskie.
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
    if (opts.transparent) {
      // Chromium maluje pod stroną białe tło niezależnie od CSS — bez tego
      // treść nałożona na formatkę zasłoniłaby ją w całości. Playwright nie ma
      // opcji `omitBackground` (Puppeteer ma), więc wprost przez CDP.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const scale = opts.fit ? await fitScale(page, opts.fit) : 1;
    const size = opts.width && opts.height
      ? { width: opts.width, height: opts.height }
      : { format: opts.format || 'A4', landscape: opts.landscape === undefined ? true : !!opts.landscape };
    return await page.pdf({
      ...size,
      scale,
      printBackground: true,
      margin: opts.margin || { top: '12mm', right: '10mm', bottom: '14mm', left: '10mm' }
    });
  } catch (err) {
    log(`[invoices] renderPdfFromHtml error: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Formatka z bazy → ścieżka bezwzględna albo `null` (dokument bez formatki).
 * Zła nazwa albo brak pliku nie blokuje PDF-a — patrz `resolveTemplateFiles`.
 *
 * @param {string|null|undefined} name  np. `LUXANGMBH.pdf`
 * @param {{ exists?: (absPath: string) => boolean, warn?: (msg: string) => void, code?: string }} [opts]
 * @returns {string|null}
 */
function resolveBackgroundFile(name, { exists = fs.existsSync, warn = log, code = '?' } = {}) {
  if (!name) return null;
  const rel = normalizeTemplatePath(name, '.pdf');
  const abs = rel ? path.resolve(BACKGROUNDS_DIR, rel) : null;
  if (!abs || !abs.startsWith(BACKGROUNDS_DIR + path.sep)) {
    warn(`[invoices] szablon „${code}": niedozwolona nazwa formatki „${name}" — PDF bez formatki`);
    return null;
  }
  if (!exists(abs)) {
    warn(`[invoices] szablon „${code}": brak formatki ${rel} w ${BACKGROUNDS_DIR} — PDF bez formatki`);
    return null;
  }
  return abs;
}

const PT_PER_MM = 72 / 25.4;

/**
 * Nakłada strony treści na formatkę: każda strona wyniku = strona formatki
 * (wektorowo, jako XObject — bez rasteryzacji) + strona treści na wierzchu.
 * Formatka ma jedną stronę, a faktura bywa wielostronicowa — papier firmowy
 * trafia na każdą stronę.
 *
 * @param {Buffer|Uint8Array} contentPdf  treść wyrenderowana na rozmiarze formatki, z przezroczystym tłem
 * @param {Buffer|Uint8Array} backgroundPdf
 * @returns {Promise<Buffer>}
 */
async function overlayOnBackground(contentPdf, backgroundPdf) {
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  const [background] = await out.embedPdf(backgroundPdf, [0]);
  const content = await PDFDocument.load(contentPdf);
  const pages = await out.embedPdf(contentPdf, content.getPageIndices());

  for (const page of pages) {
    const target = out.addPage([background.width, background.height]);
    target.drawPage(background, { x: 0, y: 0, width: background.width, height: background.height });
    // Treść jest renderowana dokładnie na rozmiar formatki; skalowanie do jej
    // wymiarów zbiera tylko zaokrąglenia mm → pt z Chromium (ułamki punktu).
    target.drawPage(page, { x: 0, y: 0, width: background.width, height: background.height });
  }
  return Buffer.from(await out.save());
}

/**
 * Rozmiar pierwszej strony formatki w mm (z niego bierze się rozmiar i
 * orientacja PDF-a faktury).
 *
 * @param {Buffer|Uint8Array} backgroundPdf
 * @returns {Promise<{ widthMm: number, heightMm: number }>}
 */
async function backgroundPageSize(backgroundPdf) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(backgroundPdf);
  const { width, height } = doc.getPage(0).getSize();
  return { widthMm: width / PT_PER_MM, heightMm: height / PT_PER_MM };
}

/**
 * Skrót: dokument → PDF w jednym kroku.
 *
 * Gdy szablon ma formatkę (`template.backgroundFile`), strona dostaje jej
 * rozmiar i orientację, treść mieści się w `template.pageMargins`, a całość
 * jest nakładana na papier firmowy. Bez formatki — A4 poziomo jak dotąd.
 *
 * @param {Parameters<typeof renderInvoiceHtml>[0] & { pdfOptions?: object }} params
 * @returns {Promise<Buffer>}
 */
async function renderInvoicePdf(params) {
  const template = params.template || {};
  const backgroundPath = resolveBackgroundFile(template.backgroundFile, { code: template.code });
  if (!backgroundPath) {
    return renderPdfFromHtml(renderInvoiceHtml(params), params.pdfOptions || {});
  }

  const backgroundPdf = fs.readFileSync(backgroundPath);
  const { widthMm, heightMm } = await backgroundPageSize(backgroundPdf);
  const m = parsePageMargins(template.pageMargins);
  const contentPdf = await renderPdfFromHtml(renderInvoiceHtml({ ...params, onBackground: true }), {
    width: `${widthMm.toFixed(2)}mm`,
    height: `${heightMm.toFixed(2)}mm`,
    margin: { top: `${m.top}mm`, right: `${m.right}mm`, bottom: `${m.bottom}mm`, left: `${m.left}mm` },
    transparent: true,
    fit: { contentWidthMm: widthMm - m.left - m.right, availableHeightMm: heightMm - m.top - m.bottom }
  });
  return overlayOnBackground(contentPdf, backgroundPdf);
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
  TEMPLATES_DIR,
  BACKGROUNDS_DIR,
  resolveTemplateFiles,
  resolveBackgroundFile,
  overlayOnBackground,
  backgroundPageSize,
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
