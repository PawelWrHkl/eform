'use strict';

/**
 * Stopka AB ze stoiskiem (POP-19): baner `_ab_footer.njk` w mailu (mailTemplate.njk) i PDF/HTML
 * (order-pdf.njk) każdego AB, w języku AB, sterowany `config.features.abFooter` (AB_FOOTER_ENABLED).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const config = require('../../../config');
const { abFooter, CONFIG_PATH, IMAGE_CID } = require('../abFooter');
const { buildMailOptions } = require('../mailBot');
const { renderOrderPdfHtml } = require('../pdfGenerator');

const mail = (lang) => buildMailOptions(
  'test@example.com', lang, Buffer.alloc(10), [],
  { orderNr: '197', klient: 'TCN', logoPath: '/nonexistent.png' }
);

const pdfHtml = (lang) => renderOrderPdfHtml({
  orderDetails: { id: 1, order_idx: 197, commision: 'Salon', comment: '' },
  cleanOrderItems: [],
  sendData: { total: 'Suma: 1234,00€' },
  orderNr: '197',
  lang
});

// autoescape: tak jak tekst trafia do HTML-a
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const initial = config.features.abFooter;
test.after(() => { config.features.abFooter = initial; });

test('wyłączona: ani mail, ani PDF nie mają stopki ani zdjęcia', () => {
  config.features.abFooter = false;
  assert.equal(abFooter('pl'), null);
  const m = mail('pl');
  assert.doesNotMatch(m.html, /ab-footer/);
  assert.ok(!m.attachments.some((a) => a.cid === IMAGE_CID));
  assert.doesNotMatch(pdfHtml('pl'), /ab-footer/);
});

test('włączona: każdy język ma baner z tytułem i nr stoiska — w mailu (zdjęcie cid) i w PDF/HTML (data URI)', () => {
  config.features.abFooter = true;
  const { booth, company, text } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const lang of config.availabeLanguages) {
    assert.ok(text[lang], `brak tekstów stopki dla języka ${lang} w abFooter.json`);
    const m = mail(lang);
    const pdf = pdfHtml(lang);
    for (const html of [m.html, pdf]) {
      assert.ok(html.includes(esc(text[lang].title)), `${lang}: brak tytułu`);
      assert.ok(html.includes(esc(text[lang].boothLabel)) && html.includes(`>${esc(booth)}<`), `${lang}: brak stoiska`);
      assert.ok(html.includes(esc(company)), `${lang}: brak nazwy firmy`);
    }
    assert.ok(m.html.includes(`cid:${IMAGE_CID}`) && m.attachments.some((a) => a.cid === IMAGE_CID), `${lang}: mail bez zdjęcia inline`);
    assert.match(pdf, /src="data:image\/jpeg;base64,/, `${lang}: PDF bez zdjęcia`);
  }
});

test('nieznany język: brak stopki zamiast cudzego języka', () => {
  config.features.abFooter = true;
  assert.equal(abFooter('xx'), null);
});
