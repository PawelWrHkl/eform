'use strict';

/**
 * Faktura MaizonCozy B.V. dla klientów Cozy (wzór Wiktorii Krawczyk z 23.10,
 * zaakceptowany przez KK): szablon `templates/maizoncozy/faktura.njk` + stopka
 * `stopka.njk` jako `footerTemplate`, A4 poziomo, bez formatki PDF.
 *
 * Dotyczy faktur poziomu 2, których wystawcą jest organizacja Cozy — czyli
 * każdego klienta z `user.organization_id` = Cozy. Pozostałe faktury idą dalej
 * wspólnym szablonem (`renderer.js`).
 *
 * Szablon niczego nie formatuje — `buildData` podaje gotowe napisy (kwoty
 * `1.234,56`, daty RRRR-MM-DD), opis pól: `MaizonCozy_formatka_faktury_EFOR/…/OPIS.md`.
 * ⚠️ Cennik pozycji składany z `SUB___*` (ceny Cozy dla klienta), NIGDY z
 * zapisanego `OPIS_CENY` — stare wersje skryptów grup wpisywały tam cenę HKL,
 * czyli cenę zakupu Cozy.
 */

const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');
const { TaxCategory, DocumentType } = require('../domain/constants');

const DIR = path.join(__dirname, '..', 'templates', 'maizoncozy');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(DIR), { autoescape: true, throwOnUndefined: true });

// Stałe z wzoru (OPIS.md) — stopka niesie dane wymagane na fakturze w NL
const SELLER = {
  footer_line1: 'MaizonCozy B.V., IBAN NL41INGB0108648206, BIC INGBNL2A, BTW NL866455139B01, KvK 93574797',
  footer_line2: 'Mezenlaan 5, 5301NW Zaltbommel, Nederland, tel.: +31 6 17631197, https://www.maizoncozy.eu, e-mail: info@maizoncozy.eu'
};
const PLACE = 'Zaltbommel';

const PDF_OPTIONS = {
  format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true,
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  margin: { top: '13mm', right: '0mm', bottom: '13mm', left: '0mm' }
};

const SUB_PRICES = ['SUB___CENA', 'SUB___DOPLATA', 'SUB___DOPLATA_EL'];
const SUB_RATES = ['SUB___CENA_RABAT', 'SUB___DOPLATA_RABAT', 'SUB___DOPLATA_EL_RABAT'];

/**
 * @param {{ invoice: Record<string, any>, profile?: Record<string, any> }} ctx  wynik `InvoiceService.buildRenderContext`
 * @returns {boolean}
 */
function appliesTo({ invoice, profile }) {
  return Number(invoice.level) === 2 && invoice.issuerType === 'organization'
    && String((profile && profile.orgCode) || '').toUpperCase() === 'COZY';
}

let assets = null;
function loadAssets() {
  if (!assets) {
    const uri = (file, mime) => `data:${mime};base64,${fs.readFileSync(path.join(DIR, 'assets', file)).toString('base64')}`;
    // data URI: setContent() nie ma adresu bazowego, a stopka nie widzi zasobów strony
    assets = {
      logo: uri('maizoncozy_logo.png', 'image/png'),
      strip: uri('maizoncozy_pasek.svg', 'image/svg+xml'),
      font_regular: uri('LiberationSans-Regular.ttf', 'font/ttf'),
      font_bold: uri('LiberationSans-Bold.ttf', 'font/ttf')
    };
  }
  return assets;
}

const nl = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = (minor) => nl.format(Number(minor || 0) / 100);
const eur = (minor) => `${amount(minor)} EUR`;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function parseParams(value) {
  let p = value;
  for (let i = 0; i < 2 && typeof p === 'string'; i++) {
    try { p = JSON.parse(p); } catch { return {}; }
  }
  return p && typeof p === 'object' ? p : {};
}

/** „CATALOGUSPRIJS [€] =354,TOESLAG [€] =134,CATALOGUSPRIJS KORTING=60.00%" z parametrów SUB___. */
function priceLine(params) {
  const title = (key) => String(params[`${key}___TITLE`] || key).trim();
  return [
    ...SUB_PRICES.filter((k) => num(params[k]) > 0).map((k) => `${title(k)}=${num(params[k])}`),
    ...SUB_RATES.filter((k) => num(params[k]) > 0).map((k) => `${title(k)}=${(num(params[k]) * 100).toFixed(2)}%`)
  ].join(',');
}

/**
 * @param {Record<string, any>} item     pozycja faktury (`repository.getInvoice`)
 * @param {Record<string, any>|undefined} source  wiersz `repository.getOrderItemsForPrint`
 */
function buildItem(item, source) {
  const params = parseParams(source && source.json_parameters);
  const meta = item.meta || {};
  const qty = num(meta.displayQuantity) || 1;
  const before = num(meta.priceBeforeDiscountMinor) || num(item.netAmount);

  const ref = source
    ? `EO/${source.order_idx}/${source.orderpos || item.position}/${[source.order_commision, source.commision].map((s) => String(s || '').trim()).filter(Boolean).join('-')}`
    : (item.orderNumber ? `EO/${item.orderNumber}` : '');
  // Podformularz slopów trafia do opisu jako „[object Object]" (błąd skryptu grupy) — pomijamy
  const description = String(params.OPIS_POZYCJI || item.description || '')
    .split(',').filter((part) => !part.includes('[object Object]')).join(',');

  return {
    pos: String(item.position),
    lines: [ref, `${item.name} ${description}`.trim(), priceLine(params)].filter(Boolean),
    qty: nl.format(qty),
    catalog_price: amount(before / qty),
    price: amount(num(item.netAmount) / qty),
    amount: amount(item.netAmount),
    price_group: (String(params.KOLOR_ALIAS___DESCRIPTION || '').match(/#\s*(\S+)/) || [])[1] || ''
  };
}

/**
 * Dane szablonu z faktury i pozycji zamówień.
 *
 * @param {Record<string, any>} invoice
 * @param {Array<Record<string, any>>} orderItems  `repository.getOrderItemsForPrint`
 * @param {string} [correctedNumber]  numer faktury korygowanej (korekta)
 */
function buildData(invoice, orderItems, correctedNumber = '') {
  const byId = new Map(orderItems.map((r) => [Number(r.id), r]));
  const isCorrection = invoice.documentType === DocumentType.CORRECTION;
  const buyer = invoice.buyer || {};
  const country = String(buyer.country || '').toUpperCase();
  const taxLines = invoice.taxLines || [];

  const notes = [];
  if (isCorrection) {
    notes.push(`Creditnota bij factuur ${correctedNumber || '—'}. Het bedrag wordt verrekend of terugbetaald.`);
    if (invoice.correctionReason) notes.push(`Reden van de correctie: ${invoice.correctionReason}`);
  } else {
    if (!invoice.paymentMethod || invoice.paymentMethod === 'transfer') {
      notes.push('Wij verzoeken u het betreffende bedrag over te maken op onderstaande rekening.');
    }
    notes.push('Op de goederen rust een verlengd eigendomsvoorbehoud.');
    const delivery = invoice.deliveryDate || invoice.saleDate;
    notes.push(!delivery || delivery === invoice.issueDate
      ? 'Factuurdatum komt overeen met leverdatum (verzenddatum)'
      : `Leverdatum: ${delivery}`);
  }
  if (taxLines.some((t) => t.taxCategory === TaxCategory.INTRA_EU_GOODS)) {
    notes.push(`Intracommunautaire levering, vrijgesteld van btw (0 %, art. 138 Btw-richtlijn 2006/112/EG). Btw-nummer afnemer: ${buyer.vatEuId || buyer.taxId || ''}.`);
  }
  if (taxLines.some((t) => t.taxCategory === TaxCategory.EXPORT)) {
    notes.push('Uitvoer buiten de EU, vrijgesteld van btw (0 %, art. 146 Btw-richtlijn 2006/112/EG).');
  }

  return {
    watermark: '',
    document: {
      title: isCorrection ? 'Creditnota' : 'Factuur',
      number: invoice.number || 'CONCEPT',
      place: PLACE,
      issue_date: invoice.issueDate || '',
      due_date: isCorrection ? '' : (invoice.dueDate || '')
    },
    buyer: {
      name: buyer.name || '',
      street: buyer.street || '',
      city_line: [`${buyer.zip || ''} ${buyer.city || ''}`.trim(), country && country !== 'NL' ? country : ''].filter(Boolean).join(', '),
      vat_id: buyer.vatEuId || buyer.taxId || '',
      email: buyer.email || ''
    },
    items: [...(invoice.items || [])]
      .sort((a, b) => a.position - b.position)
      .map((it) => buildItem(it, byId.get(Number(it.orderItemId)))),
    notes,
    totals: {
      net: eur(invoice.totalNet),
      // shortcut: BTW z zapisanych linii (zaokrąglenie per stawka, jak suma faktury w bazie), nie suma BTW pozycji jak PrintRight — różnica do 1 ct; zmiana = decyzja księgowa
      vat: taxLines.map((t) => ({
        label: taxLines.length > 1 ? `${t.taxRate}% BTW over ${amount(t.netAmount)}` : `${t.taxRate}% BTW`,
        amount: eur(t.taxAmount)
      })),
      gross_label: isCorrection ? 'Totaal creditnota' : 'Totaal',
      gross: eur(isCorrection && invoice.amountDue != null ? invoice.amountDue : invoice.totalGross)
    },
    seller: SELLER
  };
}

function render(data) {
  const ctx = { ...data, assets: loadAssets() };
  return { html: env.render('faktura.njk', ctx), footer: env.render('stopka.njk', ctx) };
}

/** Podgląd w panelu: strona + stopka pod treścią (numer strony jest tylko w PDF). */
function renderHtml(data) {
  const { html, footer } = render(data);
  return html.replace('</body>', `${footer}\n</body>`);
}

/** @returns {Promise<Buffer>} */
async function renderPdf(data) {
  const { html, footer } = render(data);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({ ...PDF_OPTIONS, footerTemplate: footer });
  } finally {
    await browser.close();
  }
}

module.exports = { appliesTo, buildData, priceLine, renderHtml, renderPdf };
