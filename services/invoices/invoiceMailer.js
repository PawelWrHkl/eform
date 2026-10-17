'use strict';

/**
 * Maile z fakturami wystawionymi przez automat (`autoInvoicing.js`).
 *
 * Wołane z cyklu tła (`services/prodStatusCycle.js`) zaraz po automacie — ten
 * sam przebieg, który wystawia fakturę, wysyła ją mailem (PDF w załączniku).
 * Faktura, której mail się nie udał, wraca w kolejnym przebiegu (najwyżej
 * `MAX_ATTEMPTS` prób).
 *
 * „Wysłane" to wpis w `invoice_event` (`mail_sent` / `mail_redirected` /
 * `mail_failed`) — bez migracji bazy, z historią: do kogo, kiedy, jaki błąd.
 *
 * DWA TRYBY — o tym, czy mail może trafić do klienta, decyduje wyłącznie `.env`:
 *   - TESTOWY (`INVOICE_MAIL_REDIRECT=a@x,b@y`): każdy mail idzie WYŁĄCZNIE na
 *     te adresy, z banerem „ten mail trafiłby do: <adres nabywcy>". Wygrywa
 *     zawsze, nawet przy `INVOICE_MAIL_TO_BUYER=true`.
 *   - DO NABYWCY (`INVOICE_MAIL_TO_BUYER=true` i puste REDIRECT): adres z faktury
 *     (`invoice.buyer_email`), odpowiedź do wystawcy (Reply-To z profilu).
 * Bez żadnego z nich mail nie wychodzi. ⚠️ Baza testowa jest kopią produkcji —
 * faktury mają tam PRAWDZIWE adresy klientów, więc poza produkcją zawsze REDIRECT.
 *
 * Konfiguracja (`.env`, domyślnie WYŁĄCZONE):
 *   INVOICE_MAIL_ENABLED=true          włącznik
 *   INVOICE_MAIL_SINCE=2026-10-16      WYMAGANE: tylko faktury utworzone od tego dnia
 *                                      (włączenie nie roześle zaległej historii)
 *   INVOICE_MAIL_REDIRECT=a@x,b@y      tryb testowy — patrz wyżej
 *   INVOICE_MAIL_TO_BUYER=true         tryb do nabywcy — patrz wyżej
 *   INVOICE_MAIL_BCC=ksiegowosc@x      opcjonalnie: ukryta kopia maili do nabywców
 *   INVOICE_MAIL_MAX_PER_RUN=50        bezpiecznik na jeden przebieg
 *
 * ⚠️ Przejście z trybu testowego na „do nabywcy": przesuń `INVOICE_MAIL_SINCE`
 * na dzień przełączenia. Tryby mają osobne znaczniki (`mail_redirected` nie
 * blokuje `mail_sent`), więc stara data rozesłałaby klientom faktury, które
 * widzieli dotąd tylko testerzy. Dodatkowo nic starszego niż `MAX_AGE_DAYS`
 * dni nie wychodzi automatycznie.
 */

const nodemailer = require('nodemailer');
const defaultRepository = require('./db/repository');
const renderer = require('./render/renderer');
const { AUTO_ACTOR } = require('./autoInvoicing');
const { sanitizeFilename } = require('../../utils/sanitizeFilename');
const { log: defaultLog } = require('../../utils/logging');

const MailEvent = Object.freeze({
  SENT: 'mail_sent',
  REDIRECTED: 'mail_redirected',
  FAILED: 'mail_failed'
});

const MailMode = Object.freeze({ REDIRECT: 'redirect', BUYER: 'buyer' });

/** Po tylu nieudanych próbach faktura przestaje wracać (np. błędny adres nabywcy). */
const MAX_ATTEMPTS = 3;
/** Faktury starsze niż tyle dni nie wychodzą automatycznie, niezależnie od `SINCE`. */
const MAX_AGE_DAYS = 14;
const DEFAULT_MAX_PER_RUN = 50;

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * „a@x.pl; b@y.pl" → ['a@x.pl', 'b@y.pl'] — w kartotekach klientów zdarza się
 * kilka adresów w jednym polu.
 *
 * @param {string|null|undefined} value
 * @returns {{ valid: string[], invalid: string[] }}
 */
function parseEmailList(value) {
  const parts = String(value || '').split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean);
  return {
    valid: parts.filter((p) => EMAIL_RE.test(p)),
    invalid: parts.filter((p) => !EMAIL_RE.test(p))
  };
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ enabled: boolean, active: boolean, mode: string|null, since: string|null, redirect: string[], bcc: string[], maxPerRun: number, from: string, problems: string[] }}
 */
function readInvoiceMailConfig(env = process.env) {
  const enabled = String(env.INVOICE_MAIL_ENABLED).toLowerCase() === 'true';
  const problems = [];

  const rawSince = String(env.INVOICE_MAIL_SINCE || '').trim();
  const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSince) ? new Date(`${rawSince}T00:00:00Z`) : null;
  const since = sinceDate && !Number.isNaN(sinceDate.getTime()) && sinceDate.toISOString().slice(0, 10) === rawSince
    ? rawSince
    : null;

  const redirect = parseEmailList(env.INVOICE_MAIL_REDIRECT);
  const bcc = parseEmailList(env.INVOICE_MAIL_BCC);
  const toBuyer = String(env.INVOICE_MAIL_TO_BUYER).toLowerCase() === 'true';
  const rawRedirect = String(env.INVOICE_MAIL_REDIRECT || '').trim();
  // Wpisane, ale całe błędne REDIRECT NIE może przełączyć na wysyłkę do klientów
  const mode = rawRedirect ? MailMode.REDIRECT : (toBuyer ? MailMode.BUYER : null);

  const maxPerRun = Number(env.INVOICE_MAIL_MAX_PER_RUN);
  const from = String(env.MAILBOT_USER || '').trim();

  if (enabled) {
    if (!since) problems.push(`INVOICE_MAIL_SINCE musi być datą RRRR-MM-DD (jest: „${rawSince}")`);
    if (!mode) problems.push('brak adresatów: ustaw INVOICE_MAIL_REDIRECT (tryb testowy) albo INVOICE_MAIL_TO_BUYER=true');
    if (redirect.invalid.length) problems.push(`INVOICE_MAIL_REDIRECT: niepoprawne adresy ${redirect.invalid.join(', ')}`);
    if (mode === MailMode.REDIRECT && !redirect.valid.length) problems.push('INVOICE_MAIL_REDIRECT nie zawiera żadnego poprawnego adresu');
    if (bcc.invalid.length) problems.push(`INVOICE_MAIL_BCC: niepoprawne adresy ${bcc.invalid.join(', ')}`);
    if (!from) problems.push('brak MAILBOT_USER — nie ma z czego wysyłać');
  }

  return {
    enabled,
    // Każdy błąd adresu blokuje całość: lepiej nie wysłać nic niż wysłać nie tam
    active: enabled && !!since && !!mode && !!from && problems.length === 0,
    mode,
    since,
    redirect: redirect.valid,
    bcc: bcc.valid,
    maxPerRun: Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : DEFAULT_MAX_PER_RUN,
    from,
    problems
  };
}

/** Późniejsza z dat: próg z konfiguracji albo „dziś minus MAX_AGE_DAYS". */
function effectiveSince(since, now = new Date()) {
  const floor = new Date(now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return since > floor ? since : floor;
}

/** RFC 2045: łamanie linii w treści maila to CRLF (jak w `mailBot.js`). */
function toCrlf(text) {
  return String(text).replace(/\r\n|\r|\n/g, '\r\n');
}

const TEXT_TEMPLATE = `{% if redirect %}TRYB TESTOWY — ten mail NIE trafił do klienta. {% if redirect.intendedTo %}Adresat w trybie produkcyjnym: {{ redirect.intendedTo }}{% else %}Nabywca nie ma adresu e-mail.{% endif %} (nabywca: {{ invoice.buyer.name }})

{% endif %}{{ t('mail.greeting') }}
{{ t('mail.intro') }}

{{ t('header.number') }}: {{ invoice.number }}
{{ t('header.issue_date') }}: {{ invoice.issueDate | date }}
{% if invoice.orderRef %}{{ t('header.order_ref') }}: {{ invoice.orderRef }}
{% endif %}{{ t('header.due_date') }}: {{ invoice.dueDate | date }}
{{ t('totals.amount_due') }}: {{ (invoice.amountDue if invoice.amountDue is not none else invoice.totalGross) | money }} {{ invoice.currency }}

{{ t('mail.attachment') }}{% if hasReplyTo %} {{ t('mail.questions') }}{% endif %}

{{ t('mail.regards') }}
{{ invoice.seller.name }}`;

/**
 * Wiadomość dla jednej faktury (bez wysyłki). Adresata wybiera WYŁĄCZNIE tryb
 * z konfiguracji — w trybie testowym adres nabywcy trafia tylko do treści.
 *
 * @param {Object} params
 * @param {Record<string, any>} params.invoice   wynik `repository.getInvoice`
 * @param {{ buffer: Buffer }|null} params.pdf   `null` = bez załącznika (podgląd)
 * @param {string} [params.issuerEmail]          adres wystawcy (Reply-To)
 * @param {ReturnType<typeof readInvoiceMailConfig>} params.config
 * @returns {{ message: Record<string, any>, to: string[], intendedTo: string[] }}
 */
function buildInvoiceMail({ invoice, pdf, issuerEmail = '', config }) {
  const lang = invoice.lang || 'pl';
  const env = renderer.createEnvironment({ lang, currency: invoice.currency, localCurrency: invoice.localCurrency });
  const t = renderer.createTranslator(lang);
  const docLabel = t(`doc.${invoice.documentType}`);
  const intendedTo = parseEmailList(invoice.buyer && invoice.buyer.email).valid;
  const replyTo = parseEmailList(issuerEmail).valid[0] || '';
  const redirect = config.mode === MailMode.REDIRECT
    ? { intendedTo: intendedTo.join(', '), replyTo }
    : null;

  const vars = { invoice, docLabel, redirect, hasReplyTo: !!replyTo };
  const html = env.render('mail/invoice-mail.njk', vars);
  const text = env.renderString(TEXT_TEMPLATE, vars);

  const sellerName = (invoice.seller && invoice.seller.name) || '';
  const subject = `${docLabel} ${invoice.number}${sellerName ? ` — ${sellerName}` : ''}`;
  const to = redirect ? [...config.redirect] : intendedTo;

  const message = {
    // Nadawca to skrzynka systemu (SPF/DKIM), w nazwie wystawca faktury
    from: { name: sellerName || 'eForm', address: config.from },
    to: to.join(', '),
    subject: redirect ? `[TEST → ${redirect.intendedTo || 'brak adresu nabywcy'}] ${subject}` : subject,
    html: toCrlf(html),
    text: toCrlf(text),
    attachments: pdf
      ? [{
        filename: sanitizeFilename(`${docLabel}_${invoice.number}.pdf`),
        content: pdf.buffer,
        contentType: 'application/pdf',
        // Te same ustawienia co potwierdzenie zamówienia (`mailBot.js`) — iOS Mail
        contentDisposition: 'attachment',
        contentTransferEncoding: 'base64'
      }]
      : []
  };
  // W trybie testowym bez Reply-To i BCC: odpowiedź testera nie może trafić
  // do wystawcy (np. innej organizacji), a kopia — do księgowości.
  if (!redirect && replyTo) message.replyTo = replyTo;
  if (!redirect && config.bcc.length) message.bcc = config.bcc.join(', ');

  return { message, to, intendedTo };
}

let transporter = null;
function defaultSendMail(message) {
  if (!transporter) {
    // Ten sam serwer i konto co pozostałe maile systemu (`mailBot/mailBot.js`)
    transporter = nodemailer.createTransport({
      host: 'serwer2560216.home.pl',
      port: 587,
      secure: false,
      auth: { user: process.env.MAILBOT_USER, pass: process.env.MAILBOT_PASSWORD },
      tls: { rejectUnauthorized: false }
    });
  }
  return transporter.sendMail(message);
}

/**
 * Jeden przebieg: wszystkie faktury automatu czekające na mail.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]  tylko lista, nic nie wysyła i nie zapisuje
 * @param {ReturnType<typeof readInvoiceMailConfig>} [opts.config]
 * @param {Object} [opts.deps] `{ repository, service, sendMail, log, now }` — podmiana w testach
 * @returns {Promise<{ skipped?: string, sent: object[], failed: object[], planned: object[] }>}
 */
async function runInvoiceMailing({ dryRun = false, config = readInvoiceMailConfig(), deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const now = deps.now || (() => new Date());
  const sendMail = deps.sendMail || defaultSendMail;
  const result = { sent: [], failed: [], planned: [] };

  config.problems.forEach((p) => log(`[invoices:mail] konfiguracja: ${p}`));
  if (!config.active) {
    if (config.enabled) log('[invoices:mail] wysyłka NIE ruszyła — popraw konfigurację powyżej');
    return { ...result, skipped: config.enabled ? 'config' : 'disabled' };
  }

  // Leniwie: InvoiceService ciągnie VIES/NBP, a przy pustej kolejce nie jest potrzebny
  const getService = () => deps.service || new (require('./main').InvoiceService)({ repository, log });
  const doneEvent = config.mode === MailMode.REDIRECT ? MailEvent.REDIRECTED : MailEvent.SENT;
  const since = effectiveSince(config.since, now());
  const modeLabel = config.mode === MailMode.REDIRECT
    ? `tryb testowy → ${config.redirect.join(', ')}`
    : 'do nabywców';

  const pending = await repository.findInvoicesToMail({
    since,
    doneEvent,
    failedEvent: MailEvent.FAILED,
    maxAttempts: MAX_ATTEMPTS,
    createdByPin: AUTO_ACTOR,
    limit: config.maxPerRun
  });

  let service = null;
  for (const row of pending) {
    const label = `faktura ${row.number} (id ${row.id}, ${row.buyer_name})`;
    if (dryRun) {
      result.planned.push({ invoiceId: row.id, number: row.number });
      log(`[invoices:mail] DRY-RUN: wysłałbym — ${label}`);
      continue;
    }

    try {
      const invoice = await repository.getInvoice(row.id);
      if (!invoice) throw new Error('faktura zniknęła z bazy');
      const issuer = invoice.issuerType
        ? await repository.getIssuerProfile({ issuerType: invoice.issuerType, issuerId: invoice.issuerId, level: invoice.level })
        : null;
      const issuerEmail = (issuer && issuer.email) || '';

      // Adresat znany przed renderem PDF — bez adresu nie ma po co uruchamiać Chromium
      const preview = buildInvoiceMail({ invoice, pdf: null, issuerEmail, config });
      if (!preview.to.length) throw new Error('nabywca nie ma poprawnego adresu e-mail (invoice.buyer_email)');

      service = service || getService();
      const pdf = await service.renderPdf(row.id);
      const { message, to, intendedTo } = buildInvoiceMail({ invoice, pdf, issuerEmail, config });
      const info = await sendMail(message);

      const payload = { mode: config.mode, to, intendedTo, messageId: (info && info.messageId) || null };
      try {
        await repository.addInvoiceEvent({ invoiceId: row.id, eventType: doneEvent, actorPin: AUTO_ACTOR, payload });
      } catch (err) {
        // Mail wyszedł — błąd zapisu znacznika oznacza ryzyko powtórki w następnym przebiegu
        log(`[invoices:mail] UWAGA — ${label}: mail wysłany, ale nie zapisano znacznika (${err.message}); może pójść ponownie`);
      }
      result.sent.push({ invoiceId: row.id, number: row.number, to, intendedTo });
      log(`[invoices:mail] ${label} → ${to.join(', ')}`
        + (config.mode === MailMode.REDIRECT ? ` (nabywca: ${intendedTo.join(', ') || 'brak adresu'})` : ''));
    } catch (err) {
      result.failed.push({ invoiceId: row.id, number: row.number, error: err.message });
      log(`[invoices:mail] BŁĄD — ${label}: ${err.message} (próba ${Number(row.failures || 0) + 1}/${MAX_ATTEMPTS})`);
      try {
        await repository.addInvoiceEvent({ invoiceId: row.id, eventType: MailEvent.FAILED, actorPin: AUTO_ACTOR, payload: { mode: config.mode, error: err.message } });
      } catch (err2) {
        log(`[invoices:mail] nie zapisano nieudanej próby — ${label}: ${err2.message}`);
      }
    }
  }

  if (pending.length >= config.maxPerRun) {
    log(`[invoices:mail] wyczerpany limit ${config.maxPerRun} maili na przebieg (INVOICE_MAIL_MAX_PER_RUN) — reszta w następnym`);
  }
  log(`[invoices:mail] ${dryRun ? `DRY-RUN: do wysłania ${result.planned.length}` : `wysłano ${result.sent.length}, błędy ${result.failed.length}`}`
    + ` (${modeLabel}; faktury od ${since})`);
  return result;
}

module.exports = {
  MailEvent,
  MailMode,
  MAX_ATTEMPTS,
  MAX_AGE_DAYS,
  parseEmailList,
  readInvoiceMailConfig,
  effectiveSince,
  buildInvoiceMail,
  runInvoiceMailing
};
