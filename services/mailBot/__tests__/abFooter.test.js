'use strict';

/**
 * Stopka AB ze stoiskiem (POP-19): baner `_ab_footer.njk` w mailu (mailTemplate.njk) i PDF/HTML
 * (order-pdf.njk) każdego AB, w języku AB, sterowany `config.features.abFooter` (AB_FOOTER_ENABLED),
 * tylko dla zleceń organizacji z `organizations` w abFooter.json (dziś HKL — sendData.organizationIdent).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const config = require('../../../config');
const { abFooter, ensureAbFooterBanner, CONFIG_PATH, IMAGE_CID, BANNER_CID } = require('../abFooter');
const { buildMailOptions } = require('../mailBot');
const { renderOrderPdfHtml } = require('../pdfGenerator');

const mail = (lang, org = 'HKL') => buildMailOptions(
  'test@example.com', lang, Buffer.alloc(10), [],
  { orderNr: '197', klient: 'TCN', logoPath: '/nonexistent.png', orderDetails: { organizationIdent: org } }
);

const pdfHtml = (lang, org = 'HKL') => renderOrderPdfHtml({
  orderDetails: { id: 1, order_idx: 197, commision: 'Salon', comment: '' },
  cleanOrderItems: [],
  sendData: { total: 'Suma: 1234,00€', organizationIdent: org },
  orderNr: '197',
  lang
});

// autoescape: tak jak tekst trafia do HTML-a
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const initial = config.features.abFooter;
test.after(() => { config.features.abFooter = initial; });

test('wyłączona: ani mail, ani PDF nie mają stopki ani zdjęcia', () => {
  config.features.abFooter = false;
  assert.equal(abFooter('pl', 'data', 'HKL'), null);
  const m = mail('pl');
  assert.doesNotMatch(m.html, /ab-footer/);
  assert.ok(!m.attachments.some((a) => a.cid === IMAGE_CID || a.cid === BANNER_CID));
  assert.doesNotMatch(pdfHtml('pl'), /ab-footer/);
});

test('włączona: każdy język ma baner targów z terminem i nr stoiska — w mailu (logo cid) i w PDF/HTML (data URI)', () => {
  config.features.abFooter = true;
  const { fair, booth, company, text } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const lang of config.availabeLanguages) {
    assert.ok(text[lang], `brak tekstów stopki dla języka ${lang} w abFooter.json`);
    const m = mail(lang);
    const pdf = pdfHtml(lang);
    // PDF/HTML zawsze baner HTML; mail — obrazek banera, gdy już wyrenderowany, inaczej baner HTML z logo
    const mailHasBanner = !!abFooter(lang, 'cid', 'HKL').bannerPath;
    for (const html of mailHasBanner ? [pdf] : [m.html, pdf]) {
      assert.ok(html.includes(esc(fair)) && html.includes(esc(text[lang].dates)), `${lang}: brak targów/terminu`);
      assert.ok(html.includes(esc(text[lang].boothLabel)) && html.includes(`>${esc(booth)}<`), `${lang}: brak stoiska`);
      assert.ok(html.includes(esc(company)), `${lang}: brak nazwy firmy`);
    }
    const cid = mailHasBanner ? BANNER_CID : IMAGE_CID;
    assert.ok(m.html.includes(`cid:${cid}`) && m.attachments.some((a) => a.cid === cid), `${lang}: mail bez obrazka stopki inline`);
    assert.match(pdf, /src="data:image\/(png|jpeg);base64,/, `${lang}: PDF bez logo`);
  }
});

test('obrazek banera do maila (odporny na tryb ciemny Outlooka): PNG raz na treść, w mailu z opisem alt', async (t) => {
  config.features.abFooter = true;
  const file = await ensureAbFooterBanner('de', 'HKL');
  if (!file) return t.skip('brak Chromium (Playwright) — mail idzie z banerem HTML');
  assert.ok(fs.readFileSync(file).subarray(1, 4).toString() === 'PNG', 'to nie PNG');
  assert.equal(await ensureAbFooterBanner('de', 'HKL'), file, 'drugi raz ten sam plik z pamięci podręcznej');
  const { fair, booth } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const m = mail('de');
  assert.ok(m.html.includes(`cid:${BANNER_CID}`) && m.attachments.some((a) => a.cid === BANNER_CID && a.path === file));
  assert.ok(!m.attachments.some((a) => a.cid === IMAGE_CID), 'z obrazkiem banera samo logo jest zbędne');
  assert.match(m.html, new RegExp(`alt="[^"]*${esc(fair).replace(/[+]/g, '\\+')}[^"]*${booth}`), 'alt bez targów/stoiska');
});

test('nieznany język: brak stopki zamiast cudzego języka', () => {
  config.features.abFooter = true;
  assert.equal(abFooter('xx', 'data', 'HKL'), null);
});

test('tylko organizacja HKL: zlecenia Luxan i bez organizacji — bez stopki w mailu i PDF', async () => {
  config.features.abFooter = true;
  assert.ok(abFooter('de', 'data', 'hkl'), 'ident bez względu na wielkość liter');
  for (const org of ['LUXANGMBH', 'Cozy', null]) {
    assert.equal(abFooter('de', 'data', org), null, `${org}: stopka nie dla tej organizacji`);
    const m = mail('de', org);
    assert.doesNotMatch(m.html, /ab-footer/, `${org}: mail ze stopką`);
    assert.ok(!m.attachments.some((a) => a.cid === IMAGE_CID || a.cid === BANNER_CID), `${org}: obrazek stopki w mailu`);
    assert.doesNotMatch(pdfHtml('de', org), /ab-footer/, `${org}: PDF ze stopką`);
    assert.equal(await ensureAbFooterBanner('de', org), null, `${org}: baner renderowany niepotrzebnie`);
  }
});
