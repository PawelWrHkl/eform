const ExcelJS = require('exceljs');
const nunjucks = require('nunjucks');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const confLang = require('./conf');
const { localesDir, availabeLanguages, defaultLanguage, outputData } = require('../../config');
const { log } = require('../../utils/logging');
const { translateToPolish } = require('./commentTranslator');
const { isProductionVersion, shouldForceProductionSend } = require('../../utils/productionSendGuard');
const { pdfValueParts } = require('../../utils/pdfValueParts');

function registerPdfNunjucksFilters(env) {
  env.addFilter('pdfValueParts', pdfValueParts);
}

async function generateExcel(orderData) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Zamówienie');

  worksheet.addRow(['ID', 'Nazwa', 'Ilość']);

  orderData.items.forEach(item => {
    worksheet.addRow([item.id, item.name, item.quantity]);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

// Dokument podawany Chromium do wydruku PDF: body z `order-pdf.njk` + `order-pdf.css`.
function buildPdfHtmlDocument(bodyHtml) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <style>
      /* Import głównego CSS */
      ${fs.readFileSync(path.join(__dirname, 'styles/order-pdf.css'), 'utf8')}
    </style>
  </head>
  <body>${bodyHtml}</body>
  </html>
`;
}

// Dokument załącznika .html: ta sama treść i ten sam arkusz co PDF
// (`order-pdf.njk` + `order-pdf.css`) — widok „jak zawsze", również na telefonie.
// Jedyna różnica wobec dokumentu do druku: opakowanie w kontener z poziomym
// przewijaniem. `order-pdf.css` liczy tabelę w procentach szerokości, więc na
// telefonie bez `min-width` kolumny zgniotłyby się do nieczytelnej szerokości
// zamiast wyjechać za ekran — dlatego stała szerokość treści + przesuwanie
// palcem w lewo/prawo (`-webkit-overflow-scrolling: touch`).
function buildScreenHtmlDocument(bodyHtml, title = '') {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${title ? `<title>${title}</title>` : ''}
    <style>
      /* Import głównego CSS */
      ${fs.readFileSync(path.join(__dirname, 'styles/order-pdf.css'), 'utf8')}
    </style>
    <style>
      @media screen {
        html, body { margin: 0; padding: 0; background: #fff; }
        .h-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .h-inner { min-width: 1100px; }
      }
    </style>
  </head>
  <body><div class="h-scroll"><div class="h-inner">${bodyHtml}</div></div></body>
  </html>
`;
}

// Generuje potwierdzenie zamówienia w obu formatach z jednego renderu szablonu:
// { pdf: Buffer, html: string }. `generatePdf` to cienki wrapper zwracający tylko PDF.
async function generateOrderDocuments(orderData, cleanOrderItems, lang, logoPath, sendData, orderIdx, prices = true, maxProdDays = 0, showGoldPrices = true, clientView = false, showBoth = false, discountInfo = null) {
  log('zaczynam', logoPath)
  const logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });
  const logoDataUri = `data:image/png;base64,${logoBase64}`;
  // 1. Konfiguracja i18n
  const i18n = confLang(lang);
  const __ = (key) => i18n.__(key, { locale: lang });

  const templatesDir = path.dirname(path.join(__dirname, 'order-pdf.njk'));
  const env = nunjucks.configure(templatesDir, {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true
  });

  env.addGlobal('__', __);
  registerPdfNunjucksFilters(env);
  const data = await sendData
  log('sendDAta', data)

  // Sum of ordered quantities (ILOŚĆ) across all positions.
  // Source of truth: order_item.json_parameters — always stored in Polish keys
  // (json_parameters_desc is the translated/displayed variant). Key: "ILOSC".
  // Fallbacks: order_item.amount column, then 1 per row.
  const readQty = (item) => {
    if (!item) return 1;
    let jp = item.json_parameters;
    if (typeof jp === 'string') {
      try { jp = JSON.parse(jp); } catch { jp = null; }
    }
    if (jp && typeof jp === 'object') {
      const raw = jp.ILOSC ?? jp['ILOŚĆ'] ?? jp.ilosc;
      const qty = Number(raw);
      if (Number.isFinite(qty) && qty > 0) return qty;
    }
    const amt = Number(item.amount);
    if (Number.isFinite(amt) && amt > 0) return amt;
    return 1;
  };

  let totalQuantity = 0;
  for (const table of (cleanOrderItems || [])) {
    for (const rowObj of (table.rows || [])) {
      totalQuantity += readQty(rowObj && rowObj.item);
    }
  }

  // Kontekst renderowania `order-pdf.njk` — wspólny dla PDF-a i załącznika .html
  const renderContext = {
    orderDetails: orderData,
    cleanOrderItems: cleanOrderItems,
    logoPath: logoDataUri,
    sendData: data,
    orderNr: orderIdx,
    prices: prices,
    maxProdDays: maxProdDays,
    totalQuantity: totalQuantity,
    showGoldPrices: showGoldPrices,
    clientView: clientView,
    showBoth: showBoth,
    discountInfo: discountInfo
  };

  const html = env.render('order-pdf.njk', renderContext);

  // Prevent single-letter orphans: replace space after single-letter word with non-breaking space
  // e.g. "w Polsce" -> "w\u00a0Polsce", "i tak" -> "i\u00a0tak"
  const fixOrphans = (str) => str.replace(/(^|[ \u00a0])([a-zA-Z\u00c0-\u017e])[ ]/g, '$1$2\u00a0');
  const htmlFixed = fixOrphans(html);
  let browser;
  if (process.env.NODE_ENV == 'live-dev') {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
  }
  else {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  // Suppress non-critical console messages during PDF generation
  page.on('console', (msg) => {
    // Only log critical errors, not warnings or info about missing resources
    if (msg.type() !== 'error' || !msg.text().includes('net::ERR_NAME_NOT_RESOLVED')) {
      return;
    }
  });

  try {
    await page.setContent(buildPdfHtmlDocument(htmlFixed), {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
  } catch (error) {
    log('Błąd podczas wstrzykiwania treści:', error);
    await browser.close();
    throw error;
  }

  const pdfBuffer = await page.pdf({
    format: 'A4',
    landscape: true,
    printBackground: true,
    scale: 0.8,
    margin: { top: '1mm', right: '1mm', bottom: '1mm', left: '1mm' }
  });

  await browser.close();

  return {
    pdf: pdfBuffer,
    html: buildScreenHtmlDocument(htmlFixed, `${__('history_order.title')}${orderIdx}`)
  };
}

async function generatePdf(...args) {
  const { pdf } = await generateOrderDocuments(...args);
  return pdf;
}

function renderOrderPdfHtml({
  orderDetails,
  cleanOrderItems,
  sendData,
  orderNr = 1,
  prices = true,
  maxProdDays = 0,
  totalQuantity,
  showGoldPrices = true,
  clientView = false,
  showBoth = false,
  lang = 'pl'
}) {
  const i18n = confLang(lang);
  const __ = (key) => i18n.__(key, { locale: lang });
  const templatesDir = path.dirname(path.join(__dirname, 'order-pdf.njk'));
  const env = nunjucks.configure(templatesDir, {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true
  });
  env.addGlobal('__', __);
  registerPdfNunjucksFilters(env);
  return env.render('order-pdf.njk', {
    orderDetails,
    cleanOrderItems,
    logoPath: 'data:image/png;base64,test',
    sendData,
    orderNr,
    prices,
    maxProdDays,
    totalQuantity,
    showGoldPrices,
    clientView,
    showBoth
  });
}

module.exports = { generateExcel, generatePdf, generateOrderDocuments, generateProductionPdf, uploadProductionPdf, renderOrderPdfHtml };

async function generateProductionPdf(orderData, cleanOrderItems, logoPath, orderIdx, clientName) {
  const lang = 'pl';
  const logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });
  const logoDataUri = `data:image/png;base64,${logoBase64}`;

  const env = nunjucks.configure(__dirname, {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true
  });
  registerPdfNunjucksFilters(env);

  const readQty = (item) => {
    if (!item) return 1;
    let jp = item.json_parameters;
    if (typeof jp === 'string') {
      try { jp = JSON.parse(jp); } catch { jp = null; }
    }
    if (jp && typeof jp === 'object') {
      const raw = jp.ILOSC ?? jp['ILOŚĆ'] ?? jp.ilosc;
      const qty = Number(raw);
      if (Number.isFinite(qty) && qty > 0) return qty;
    }
    const amt = Number(item.amount);
    if (Number.isFinite(amt) && amt > 0) return amt;
    return 1;
  };

  let totalQuantity = 0;
  for (const table of (cleanOrderItems || [])) {
    for (const rowObj of (table.rows || [])) {
      totalQuantity += readQty(rowObj && rowObj.item);
    }
  }

  // Translate comments to Polish
  for (const table of (cleanOrderItems || [])) {
    for (const rowObj of (table.rows || [])) {
      if (rowObj && rowObj.item && rowObj.item.comment) {
        rowObj.item.comment = await translateToPolish(rowObj.item.comment);
      }
    }
  }
  if (orderData && orderData.comment) {
    orderData = { ...orderData, comment: await translateToPolish(orderData.comment) };
  }

  const html = env.render('production-pdf.njk', {
    orderDetails: orderData,
    cleanOrderItems,
    logoPath: logoDataUri,
    orderNr: orderIdx,
    totalQuantity,
    clientName: clientName || null,
  });

  const fixOrphans = (str) => str.replace(/(^|[ \u00a0])([a-zA-Z\u00c0-\u017e])[ ]/g, '$1$2\u00a0');
  const htmlFixed = fixOrphans(html);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Suppress non-critical console messages during PDF generation
  page.on('console', (msg) => {
    // Only log critical errors, not warnings or info about missing resources
    if (msg.type() !== 'error' || !msg.text().includes('net::ERR_NAME_NOT_RESOLVED')) {
      return;
    }
  });

  try {
    await page.setContent(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${fs.readFileSync(path.join(__dirname, 'styles/production-pdf.css'), 'utf8')}</style></head>
<body>${htmlFixed}</body></html>`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    log('Błąd podczas wstrzykiwania treści (production PDF):', error);
    await browser.close();
    throw error;
  }

  const pdfBuffer = await page.pdf({
    format: 'A4',
    landscape: false,
    printBackground: true,
    scale: 1.0,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
  });

  await browser.close();
  return pdfBuffer;
}

async function uploadProductionPdf(pdfBuffer, jsonFileName, options = {}) {
  const useProductionFtp = isProductionVersion() || shouldForceProductionSend(options.forceProductionSend);

  if (!useProductionFtp) {
    // Tryb dev/test — zapis lokalny do outputData/pdf_out
    const localDir = path.join(outputData, 'pdf_out');
    const localPath = path.join(localDir, `${jsonFileName}.pdf`);
    try {
      await fs.promises.mkdir(localDir, { recursive: true });
      await fs.promises.writeFile(localPath, pdfBuffer);
      log(`Production PDF saved locally: ${localPath}`);
    } catch (err) {
      log(`Production PDF local save failed: ${err.message}`);
    }
    return;
  }

  // Tryb produkcyjny — upload na FTP
  if (!process.env.FTP_HOST) {
    log('FTP_HOST not configured, skipping production PDF upload');
    return;
  }

  const ftp = require('basic-ftp');
  const tempPath = path.join(os.tmpdir(), `prod_pdf_${jsonFileName}_${Date.now()}.pdf`);
  const remotePath = `/orders-pdf/${jsonFileName}_pdf.pdf`;

  await fs.promises.writeFile(tempPath, pdfBuffer);

  const client = new ftp.Client();
  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASSWORD,
      secure: false,
    });
    await client.ensureDir('/orders-pdf');
    await client.uploadFrom(tempPath, remotePath);
    log(`Production PDF uploaded to FTP: ${remotePath}`);
  } catch (err) {
    log(`Production PDF FTP upload failed: ${err.message}`);
  } finally {
    client.close();
    fs.promises.unlink(tempPath).catch(() => {});
  }
}
