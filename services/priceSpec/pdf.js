'use strict';

/**
 * Specyfikacja ceny → PDF (Playwright/Chromium, jak services/mailBot/pdfGenerator.js).
 * Osobna, mała funkcja zamiast generatora zamówień: tamten jest związany
 * z `order-pdf.njk` i poziomym A4 tabeli pozycji — specyfikacja to dokument
 * pionowy, ze stopką „strona X z Y".
 */

const { chromium } = require('playwright');

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {string} html  pełny dokument HTML (style wbudowane — bez zasobów z sieci)
 * @param {object} [opts]
 * @param {string} [opts.footerLeft]  tekst w lewej części stopki (np. „Specyfikacja ceny · Zlecenie 273039")
 * @returns {Promise<Buffer>}
 */
async function renderPriceSpecPdf(html, opts = {}) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const footerStyle = 'font-family: Arial, sans-serif; font-size: 8px; color: #64748b; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;';
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="${footerStyle}"><span>${escapeHtml(opts.footerLeft || '')}</span>`
        + '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      margin: { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' }
    });
  } finally {
    await browser.close();
  }
}

module.exports = { renderPriceSpecPdf };
