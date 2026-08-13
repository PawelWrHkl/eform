'use strict';

/**
 * Nagłówki i zawartość załączników potwierdzenia zamówienia.
 *
 * Tło: na iOS pobieranie załącznika potrafiło utknąć na kręcącej się ikonie,
 * bez żadnego komunikatu. Trzy przyczyny, każda pilnowana tu osobno:
 *   1. `Content-Disposition: inline` na PDF — klient nie wie, czy to treść
 *      wiadomości, czy plik do zapisania,
 *   2. skrypt/zasób nie do pobrania w załączniku `.html` — piaskownica WebKit
 *      wstrzymuje wtedy pobieranie,
 *   3. base64 niezgodny z RFC 2045 (linie > 76 znaków, brak CRLF).
 *
 * Testy pracują na PRAWDZIWEJ wiadomości MIME złożonej nodemailerem, nie na
 * obiekcie opcji — nagłówki powstają dopiero przy składaniu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const MailComposer = require('nodemailer/lib/mail-composer');

const { buildMailOptions } = require('../mailBot');
const { buildScreenHtmlDocument, stripUnfetchableAssets } = require('../pdfGenerator');

const HTML_DOC = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>zażółć gęślą jaźń</body></html>';

function buildMessage(options = {}) {
  const mailOptions = buildMailOptions(
    'test@example.com',
    'pl',
    Buffer.alloc(5000, 0x41),
    [{ filename: 'slope TYP1.png', content: Buffer.alloc(300, 1) }],
    { orderNr: '2819', klient: 'TCN', logoPath: '/nonexistent.png' },
    null,
    'mailTemplate.njk',
    'mail.subject',
    { htmlContent: HTML_DOC, ...options }
  );

  return new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message.toString('binary'));
    });
  });
}

/** Nagłówki `Content-*` każdej części, która deklaruje Content-Disposition. */
function attachmentParts(raw) {
  return raw
    .split(/\r\n--/)
    .map((part) => part.split('\r\n\r\n')[0])
    .filter((head) => /Content-Disposition/i.test(head))
    .map((head) => head.split('\r\n').filter((line) => /^Content-/i.test(line)).join('\n'));
}

test('PDF idzie jako attachment, base64, z nazwą pliku w obu nagłówkach', async () => {
  const parts = attachmentParts(await buildMessage());
  const pdf = parts.find((p) => /application\/pdf/i.test(p));

  assert.ok(pdf, 'brak części z PDF-em');
  assert.match(pdf, /Content-Type: application\/pdf; name="?Zamowienie_nr_2819\.pdf"?/);
  assert.match(pdf, /Content-Transfer-Encoding: base64/);
  // Sedno poprawki: NIE 'inline' — patrz komentarz w mailBot.buildMailOptions.
  assert.match(pdf, /Content-Disposition: attachment; filename="?Zamowienie_nr_2819\.pdf"?/);
});

test('załącznik HTML idzie jako attachment, base64, z charsetem UTF-8', async () => {
  const parts = attachmentParts(await buildMessage());
  const html = parts.find((p) => /text\/html/i.test(p));

  assert.ok(html, 'brak części z załącznikiem HTML');
  assert.match(html, /Content-Type: text\/html; charset=utf-8; name="?Zamowienie_nr_2819\.html"?/);
  assert.match(html, /Content-Transfer-Encoding: base64/);
  assert.match(html, /Content-Disposition: attachment; filename="?Zamowienie_nr_2819\.html"?/);
});

test('pozostałe załączniki (zdjęcia slope) też są attachment/base64', async () => {
  const parts = attachmentParts(await buildMessage());
  const png = parts.find((p) => /image\/png/i.test(p) && /slope/i.test(p));

  assert.ok(png, 'brak części ze zdjęciem');
  assert.match(png, /Content-Transfer-Encoding: base64/);
  assert.match(png, /Content-Disposition: attachment; filename="?slope_TYP1\.png"?/);
});

test('base64 spełnia RFC 2045: linie <= 76 znaków, cała wiadomość na CRLF', async () => {
  const raw = await buildMessage();

  const base64Lines = raw.split('\r\n').filter((line) => /^[A-Za-z0-9+/=]{20,}$/.test(line));
  assert.ok(base64Lines.length > 0, 'nie znaleziono linii base64');
  assert.ok(base64Lines.every((line) => line.length <= 76), 'linia base64 dłuższa niż 76 znaków');

  let loneLf = 0;
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] === '\n' && raw[i - 1] !== '\r') loneLf += 1;
  }
  assert.equal(loneLf, 0, 'w wiadomości został goły LF (treść maila renderuje się z LF-ami)');
});

test('dokument załącznika nie niesie skryptów ani zasobów nie do pobrania', () => {
  // Fragment prawdziwego renderu `order-pdf.njk`: blok `head` z <link> i blok
  // `scripts` z modułem — oba zostają w treści, bo ten sam render obsługuje
  // podgląd w aplikacji.
  const body = [
    '<link rel="stylesheet" href="styles/order-pdf.css">',
    '<div class="position-relative"><img src="data:image/png;base64,test" alt="logo"></div>',
    "<script type='module' src='/scripts/base.js'></script>"
  ].join('\n');

  const document = buildScreenHtmlDocument(body, 'Zamówienie nr 2819');

  assert.doesNotMatch(document, /<script/i);
  assert.doesNotMatch(document, /<link/i);
  assert.doesNotMatch(document, /(src|href)\s*=\s*["']https?:\/\//i);
  // To, co dokument ma nieść dalej: kodowanie, tytuł, treść i wklejony arkusz.
  assert.match(document, /<meta charset="UTF-8">/);
  assert.match(document, /<title>Zamówienie nr 2819<\/title>/);
  assert.match(document, /data:image\/png;base64,test/);
  assert.match(document, /\.h-scroll/);
});

test('stripUnfetchableAssets zostawia treść nietkniętą poza <script>/<link>', () => {
  const cleaned = stripUnfetchableAssets('<p>a</p><script>x()</script><p>b</p><link href="x.css"><p>c</p>');
  assert.equal(cleaned, '<p>a</p><p>b</p><p>c</p>');
});

/**
 * Zdekodowana treść części, której nagłówek Content-Type pasuje do wzorca:
 * od pustej linii kończącej nagłówki do najbliższej granicy (`\r\n--`).
 */
function decodePart(raw, contentTypePattern) {
  const headerAt = raw.search(contentTypePattern);
  assert.notEqual(headerAt, -1, `brak części ${contentTypePattern}`);
  const bodyAt = raw.indexOf('\r\n\r\n', headerAt) + 4;
  const endAt = raw.indexOf('\r\n--', bodyAt);
  const body = raw.slice(bodyAt, endAt === -1 ? undefined : endAt);
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64');
}

// ⚠️ Regresja, którą łatwo wprowadzić z dobrymi intencjami: nodemailerowe
// `encoding` NIE ustawia transfer encoding, tylko mówi, w jakim kodowaniu jest
// PODANA treść. `encoding: 'base64'` na stringu każe ją „odkodować" i do maila
// idą śmieci — nagłówki wtedy nadal wyglądają wzorowo, więc bez sprawdzenia
// samych bajtów błąd przechodzi niezauważony.
test('treść załącznika HTML przechodzi przez base64 bez utraty polskich znaków', async () => {
  const decoded = decodePart(await buildMessage(), /Content-Type: text\/html; charset=utf-8; name=/i);

  assert.equal(decoded.toString('utf8'), HTML_DOC);
  assert.match(decoded.toString('utf8'), /zażółć gęślą jaźń/);
});

test('PDF dojeżdża bajt w bajt', async () => {
  const decoded = decodePart(await buildMessage(), /Content-Type: application\/pdf/i);

  assert.deepEqual(decoded, Buffer.alloc(5000, 0x41));
});

test('dokument załącznika jest poprawnym, domykalnym HTML-em', () => {
  const { JSDOM } = require('jsdom');
  const { renderOrderPdfHtml } = require('../pdfGenerator');
  const { makeOrderItem } = require('../../__tests__/fixtures/subPriceOrder');

  // Prawdziwy render szablonu maila, nie ręcznie sklejony fragment.
  const body = renderOrderPdfHtml({
    orderDetails: { commision: 'HUIJBERTS' },
    cleanOrderItems: [makeOrderItem()],
    sendData: { name: 'Magazijn', total: '189.85' },
    orderNr: 2819,
    totalQuantity: 1
  });
  const document = buildScreenHtmlDocument(body, 'Zamówienie nr 2819');
  const dom = new JSDOM(document);

  assert.equal(dom.window.document.querySelectorAll('script').length, 0);
  assert.equal(dom.window.document.querySelectorAll('link').length, 0);
  assert.equal(dom.window.document.querySelector('meta[charset]').getAttribute('charset'), 'UTF-8');
  // Treść faktycznie wylądowała w kontenerze przewijania, a nie poza <body>.
  assert.ok(dom.window.document.querySelector('.h-scroll .h-inner').children.length > 0);
});
