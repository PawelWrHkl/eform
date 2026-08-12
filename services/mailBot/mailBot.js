const nodemailer = require('nodemailer');
const nunjucks = require('nunjucks');
const path = require('path');
const fs = require('fs');
const confLang = require('./conf');
const { log } = require('../../utils/logging');
const { sanitizeFilename } = require('../../utils/sanitizeFilename');
const { resolveAbLang } = require('../abType');


const transporter = nodemailer.createTransport({
  host: 'serwer2560216.home.pl',
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAILBOT_USER,
    pass: process.env.MAILBOT_PASSWORD
  },
  tls: {
    rejectUnauthorized: false
  }
});


function buildMailOptions(to, lang, pdfBuffer, attachmentsBuffer = [], templateVars = {}, cc = null, templateName = 'mailTemplate.njk', subjectKey = 'mail.subject', options = {}) {
  // JĘZYK POTWIERDZENIA: `user.ab_lang` (przekazany przez wołającego w
  // `options.abLang`) wygrywa z językiem sesji/klienta. Dotyczy CAŁEGO maila —
  // tematu, treści szablonu i nazwy załącznika — a nie tylko dokumentu PDF.
  // Brak wartości albo nieznany język = zachowanie dotychczasowe.
  //
  // ⚠️ Odczyt z bazy zostaje po stronie wołających (`services/abType.js`):
  // ta funkcja jest synchroniczna i używana także w testach, więc nie może
  // sama sięgać do MySQL-a. Normalizację ('NL' → 'nl') robi `resolveAbLang`.
  const mailLang = resolveAbLang(options.abLang) || lang;
  const i18n = confLang(mailLang);
  const __ = (key, opts) => i18n.__(key, { locale: mailLang, ...opts });
  const subject = `${__(subjectKey)} #${templateVars.orderNr} - ${templateVars.klient} `;

  nunjucks.configure(path.dirname(path.join(__dirname, templateName)), {
    autoescape: true
  });

  const htmlContent = nunjucks.render(templateName, {
    ...templateVars,
    __
  });

  const baseName = sanitizeFilename(`${__('history_order.title')}${templateVars.orderNr}.pdf`);

  const attachments = [
    {
      // Sanitized: iOS Mail can fail to open/save attachments whose filename
      // contains non-ASCII characters or spaces (e.g. "Zamówienie nr.2819.pdf").
      filename: baseName,
      content: pdfBuffer,
      contentType: 'application/pdf',
      // 'inline' zamiast domyślnego 'attachment': klienci mobilni (iOS Mail,
      // Gmail na Androidzie) otwierają wtedy PDF od razu w podglądzie zamiast
      // próbować go zapisać na dysk — zgłaszany problem „nie da się pobrać".
      contentDisposition: 'inline'
    }
  ];

  // Drugie, identyczne potwierdzenie w formie HTML — gdy renderowanie/pobieranie
  // PDF-a zawiedzie po stronie klienta poczty, ten sam dokument można otworzyć
  // w przeglądarce. Treść pochodzi z tego samego renderu `order-pdf.njk`.
  if (options.htmlContent) {
    attachments.push({
      filename: baseName.replace(/\.pdf$/i, '.html'),
      content: options.htmlContent,
      contentType: 'text/html; charset=utf-8'
    });
  }

  if (fs.existsSync(templateVars.logoPath)) {
    attachments.push({
      filename: 'logo.png',
      path: templateVars.logoPath,
      cid: 'logo_cid'
    });
  } else {
    log('Plik logo nie istnieje:', templateVars.logoPath);
  }

  if (attachmentsBuffer && Array.isArray(attachmentsBuffer)) {
    attachmentsBuffer.forEach(attachment => {
      if (attachment.filename && attachment.content) {
        attachments.push({
          filename: sanitizeFilename(attachment.filename),
          content: attachment.content
        });
      }
    });
  }

  const mailOptions = {
    from: `"${process.env.MAILBOT_ALIAS}" <${process.env.MAILBOT_USER}>`,
    to,
    subject,
    html: htmlContent,
    text: 'Twój klient poczty nie obsługuje wiadomości HTML. Odwiedź https://e-orders.eu',
    attachments
  };

  if (cc) {
    mailOptions.cc = cc;
  }

  return mailOptions;
}

function sendMailAsync(to, lang, pdfBuffer, attachmentsBuffer = [], templateVars = {}, cc = null, templateName = 'mailTemplate.njk', subjectKey = 'mail.subject', options = {}) {
  const mailOptions = buildMailOptions(to, lang, pdfBuffer, attachmentsBuffer, templateVars, cc, templateName, subjectKey, options);
  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        log('Błąd wysyłki:', error);
        reject(error);
      } else {
        log('Stylizowany e-mail wysłany:', info.response, to);
        if (cc) {
          log('CC:', cc);
        }
        resolve(info);
      }
    });
  });
}

function sendMail(to, lang, pdfBuffer, attachmentsBuffer = [], templateVars = {}, cc = null, options = {}) {
  sendMailAsync(
    to,
    lang,
    pdfBuffer,
    attachmentsBuffer,
    templateVars,
    cc,
    'mailTemplate.njk',
    'mail.subject',
    options
  ).catch(() => {});
}

function sendCorrectionMail(to, lang, pdfBuffer, attachmentsBuffer = [], templateVars = {}, cc = null, options = {}) {
  sendMailAsync(
    to,
    lang,
    pdfBuffer,
    attachmentsBuffer,
    templateVars,
    cc,
    'correctionMailTemplate.njk',
    'mail.correction_subject',
    options
  ).catch(() => {});
}

module.exports = { sendMail, sendMailAsync, sendCorrectionMail, buildMailOptions };