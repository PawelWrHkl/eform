'use strict';

/**
 * Stopka AB ze stoiskiem (POP-19): mail (mailTemplate.njk) i PDF/HTML (order-pdf.njk)
 * każdego AB, w języku AB, sterowana `config.features.abFooter` (AB_FOOTER_ENABLED).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const config = require('../../../config');
const { abFooter, CONFIG_PATH } = require('../abFooter');
const { buildMailOptions } = require('../mailBot');
const { renderOrderPdfHtml } = require('../pdfGenerator');

const mailHtml = (lang) => buildMailOptions(
  'test@example.com', lang, Buffer.alloc(10), [],
  { orderNr: '197', klient: 'TCN', logoPath: '/nonexistent.png' }
).html;

const pdfHtml = (lang) => renderOrderPdfHtml({
  orderDetails: { id: 1, order_idx: 197, commision: 'Salon', comment: '' },
  cleanOrderItems: [],
  sendData: { total: 'Suma: 1234,00€' },
  orderNr: '197',
  lang
});

const initial = config.features.abFooter;
test.after(() => { config.features.abFooter = initial; });

test('wyłączona: ani mail, ani PDF nie mają stopki', () => {
  config.features.abFooter = false;
  assert.equal(abFooter('pl'), null);
  assert.doesNotMatch(mailHtml('pl'), /ab-footer/);
  assert.doesNotMatch(pdfHtml('pl'), /ab-footer/);
});

test('włączona: każdy język ma własny tekst z nr stoiska — w mailu i w PDF/HTML', () => {
  config.features.abFooter = true;
  const { booth, text } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const lang of config.availabeLanguages) {
    const footer = abFooter(lang);
    assert.ok(footer, `brak treści stopki dla języka ${lang} w abFooter.json`);
    assert.equal(footer, text[lang].replaceAll('{booth}', booth));
    assert.ok(!footer.includes('{booth}'));
    assert.ok(mailHtml(lang).includes(footer), `mail ${lang} bez stopki`);
    assert.ok(pdfHtml(lang).includes(footer), `PDF ${lang} bez stopki`);
  }
});

test('nieznany język: brak stopki zamiast cudzego języka', () => {
  config.features.abFooter = true;
  assert.equal(abFooter('xx'), null);
});
