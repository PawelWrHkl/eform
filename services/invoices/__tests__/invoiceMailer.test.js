'use strict';

/**
 * Maile z fakturami automatu (`invoiceMailer.js`) — konfiguracja z env, budowa
 * wiadomości, blokada adresów w trybie testowym i przebieg na atrapach
 * repozytorium/serwisu/poczty (bez bazy, bez Chromium, bez SMTP).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MailEvent,
  MailMode,
  MAX_ATTEMPTS,
  MAX_AGE_DAYS,
  parseEmailList,
  environmentLabel,
  readInvoiceMailConfig,
  effectiveSince,
  assertRecipientsAllowed,
  buildInvoiceMail,
  runInvoiceMailing
} = require('../invoiceMailer');
const { AUTO_ACTOR } = require('../autoInvoicing');

const quiet = () => {};
const PAWEL = 'pawel.woroniecki@hkl.eu';
const BASE_ENV = {
  INVOICE_MAIL_ENABLED: 'true',
  INVOICE_MAIL_SINCE: '2026-10-22',
  INVOICE_MAIL_REDIRECT: PAWEL,
  MAILBOT_USER: 'test-orders@e-orders.eu',
  NODE_ENV: 'test'
};

function invoiceFixture(overrides = {}) {
  return {
    id: 501,
    number: '2026/00121',
    lang: 'pl',
    level: 2,
    orderId: 4242,
    documentType: 'invoice',
    currency: 'EUR',
    localCurrency: 'PLN',
    issueDate: '2026-10-22',
    dueDate: '2026-11-05',
    totalGross: 30295,
    amountDue: 30295,
    orderRef: '777',
    orderName: 'Rolety salon',
    issuerType: 'organization',
    issuerId: 3,
    seller: { name: 'HKL Dekoracja Okien Sp. z o.o.' },
    buyer: { name: 'KLIENT B.V.', email: 'orders@klient.nl' },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Konfiguracja
// ---------------------------------------------------------------------------

test('konfiguracja: bez zmiennych wysyłka jest wyłączona', () => {
  const cfg = readInvoiceMailConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.active, false);
  assert.deepEqual(cfg.problems, []);
});

test('konfiguracja: tryb testowy — tylko adresy z REDIRECT', () => {
  const cfg = readInvoiceMailConfig(BASE_ENV);
  assert.equal(cfg.active, true);
  assert.equal(cfg.mode, MailMode.REDIRECT);
  assert.deepEqual(cfg.redirect, [PAWEL]);
  assert.equal(cfg.since, '2026-10-22');
  assert.equal(cfg.maxPerRun, 50);
});

test('konfiguracja: REDIRECT wygrywa z INVOICE_MAIL_TO_BUYER=true', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_TO_BUYER: 'true' });
  assert.equal(cfg.mode, MailMode.REDIRECT);
  assert.equal(cfg.active, true);
});

test('konfiguracja: całkowicie błędny REDIRECT NIE przełącza na wysyłkę do klientów', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: 'pawel-bez-malpy', INVOICE_MAIL_TO_BUYER: 'true' });
  assert.equal(cfg.mode, MailMode.REDIRECT);
  assert.equal(cfg.active, false);
  assert.match(cfg.problems.join(' '), /niepoprawne adresy pawel-bez-malpy/);
});

test('konfiguracja: jeden błędny adres obok poprawnego blokuje całą wysyłkę', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: `${PAWEL}, zly@` });
  assert.equal(cfg.active, false);
});

test('konfiguracja: bez daty progowej i bez adresatów nie rusza', () => {
  const noSince = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_SINCE: '' });
  assert.equal(noSince.active, false);
  assert.match(noSince.problems.join(' '), /INVOICE_MAIL_SINCE/);

  const badDate = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_SINCE: '2026-02-30' });
  assert.equal(badDate.since, null);
  assert.equal(badDate.active, false);

  const noRecipients = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: '' });
  assert.equal(noRecipients.mode, null);
  assert.equal(noRecipients.active, false);
  assert.match(noRecipients.problems.join(' '), /brak adresatów/);
});

test('konfiguracja: wysyłka do nabywców tylko jawnie (TO_BUYER=true i puste REDIRECT)', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: '', INVOICE_MAIL_TO_BUYER: 'true', INVOICE_MAIL_BCC: 'ksiegowosc@hkl.eu' });
  assert.equal(cfg.mode, MailMode.BUYER);
  assert.equal(cfg.active, true);
  assert.deepEqual(cfg.bcc, ['ksiegowosc@hkl.eu']);
});

test('konfiguracja: bez MAILBOT_USER nie ma z czego wysyłać', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, MAILBOT_USER: '' });
  assert.equal(cfg.active, false);
  assert.match(cfg.problems.join(' '), /MAILBOT_USER/);
});

test('środowisko: NODE_ENV=prod → PRODUKCJA, reszta → TEST', () => {
  assert.equal(environmentLabel({ NODE_ENV: 'prod' }), 'PRODUKCJA');
  assert.equal(environmentLabel({ NODE_ENV: 'test' }), 'TEST');
  assert.equal(environmentLabel({}), 'TEST');
  assert.equal(readInvoiceMailConfig({ ...BASE_ENV, NODE_ENV: 'prod' }).envLabel, 'PRODUKCJA');
});

test('adresy: kilka w jednym polu, śmieci odrzucone', () => {
  assert.deepEqual(parseEmailList('a@x.pl; b@y.de, c@z.nl'), { valid: ['a@x.pl', 'b@y.de', 'c@z.nl'], invalid: [] });
  assert.deepEqual(parseEmailList('brak'), { valid: [], invalid: ['brak'] });
  assert.deepEqual(parseEmailList(null), { valid: [], invalid: [] });
});

test('próg: nic starszego niż MAX_AGE_DAYS, nawet przy starej dacie w .env', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  assert.equal(effectiveSince('2026-10-22', now), '2026-10-22');
  const floor = new Date(now.getTime() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
  assert.equal(effectiveSince('2026-01-01', now), floor);
});

// ---------------------------------------------------------------------------
// Budowa wiadomości
// ---------------------------------------------------------------------------

test('wiadomość (tryb testowy): adresat tylko z REDIRECT, nabywca w temacie i banerze, bez Reply-To/BCC', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_BCC: 'ksiegowosc@hkl.eu' });
  const { message, to, intendedTo } = buildInvoiceMail({
    invoice: invoiceFixture(),
    pdf: { buffer: Buffer.from('%PDF-1.4') },
    issuerEmail: 'biuro@hkl.eu',
    config: cfg
  });
  assert.deepEqual(to, [PAWEL]);
  assert.equal(message.to, PAWEL);
  assert.deepEqual(intendedTo, ['orders@klient.nl']);
  assert.equal(message.replyTo, undefined);
  assert.equal(message.bcc, undefined);
  assert.equal(message.cc, undefined);
  assert.equal(message.subject, '[TEST · do klienta: orders@klient.nl] Faktura VAT 2026/00121 — HKL Dekoracja Okien Sp. z o.o.');
  assert.deepEqual(message.from, { name: 'HKL Dekoracja Okien Sp. z o.o.', address: 'test-orders@e-orders.eu' });
  assert.match(message.html, /TRYB TESTOWY \(TEST\)/);
  assert.match(message.html, /Normalnie trafiłby do: <strong>orders@klient.nl<\/strong>/);
  assert.match(message.text, /^TRYB TESTOWY \(TEST\) — ten mail NIE trafił do klienta\./);
  assert.match(message.text, /Do zapłaty: 302,95 EUR/);
  // Pusta linia przed pozdrowieniem (trimBlocks zjada pierwszy znak nowej linii)
  assert.match(message.text, /\r\n\r\nZ poważaniem\r\n/);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].filename, 'Faktura_VAT_2026_00121.pdf');
  assert.equal(message.attachments[0].contentType, 'application/pdf');
  assert.equal(message.attachments[0].contentDisposition, 'attachment');
});

test('wiadomość (tryb testowy, produkcja): w temacie PRODUKCJA, nabywca bez adresu opisany wprost', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, NODE_ENV: 'prod' });
  const { message, to, intendedTo } = buildInvoiceMail({
    invoice: invoiceFixture({ buyer: { name: 'BEZ MAILA', email: '' } }),
    pdf: null,
    config: cfg
  });
  assert.deepEqual(to, [PAWEL]);
  assert.deepEqual(intendedTo, []);
  assert.match(message.subject, /^\[PRODUKCJA · do klienta: brak adresu\] /);
  assert.match(message.html, /Nabywca nie ma adresu e-mail/);
  assert.deepEqual(message.attachments, []);
});

test('wiadomość (do nabywcy): adres z faktury, Reply-To wystawcy, BCC, bez banera testowego', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: '', INVOICE_MAIL_TO_BUYER: 'true', INVOICE_MAIL_BCC: 'ksiegowosc@hkl.eu' });
  const { message, to } = buildInvoiceMail({
    invoice: invoiceFixture({ buyer: { name: 'KLIENT', email: 'a@klient.nl; b@klient.nl' }, lang: 'de' }),
    pdf: { buffer: Buffer.from('%PDF') },
    issuerEmail: 'biuro@hkl.eu',
    config: cfg
  });
  assert.deepEqual(to, ['a@klient.nl', 'b@klient.nl']);
  assert.equal(message.replyTo, 'biuro@hkl.eu');
  assert.equal(message.bcc, 'ksiegowosc@hkl.eu');
  assert.equal(message.subject, 'Rechnung 2026/00121 — HKL Dekoracja Okien Sp. z o.o.');
  assert.equal(message.attachments[0].filename, 'Rechnung_2026_00121.pdf');
  assert.doesNotMatch(message.html, /TRYB TESTOWY/);
  assert.match(message.html, /Guten Tag,/);
});

// ---------------------------------------------------------------------------
// Ostatnia kontrola adresatów
// ---------------------------------------------------------------------------

test('blokada: w trybie testowym adres klienta, DW albo UDW zatrzymuje wysyłkę', () => {
  const cfg = readInvoiceMailConfig(BASE_ENV);
  assert.doesNotThrow(() => assertRecipientsAllowed({ to: PAWEL }, cfg));
  assert.doesNotThrow(() => assertRecipientsAllowed({ to: 'Pawel.Woroniecki@HKL.eu' }, cfg));
  assert.throws(() => assertRecipientsAllowed({ to: 'orders@klient.nl' }, cfg), /zablokowano wysyłkę.*orders@klient.nl/);
  assert.throws(() => assertRecipientsAllowed({ to: `${PAWEL}, orders@klient.nl` }, cfg), /orders@klient.nl/);
  assert.throws(() => assertRecipientsAllowed({ to: PAWEL, cc: 'orders@klient.nl' }, cfg), /zablokowano/);
  assert.throws(() => assertRecipientsAllowed({ to: PAWEL, bcc: PAWEL }, cfg), /DW\/UDW/);
  assert.throws(() => assertRecipientsAllowed({ to: [{ name: 'X', address: 'orders@klient.nl' }] }, cfg), /orders@klient.nl/);
  assert.throws(() => assertRecipientsAllowed({ to: '' }, cfg), /bez adresata/);
});

test('blokada: w trybie do nabywcy przepuszcza adres klienta', () => {
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: '', INVOICE_MAIL_TO_BUYER: 'true' });
  assert.doesNotThrow(() => assertRecipientsAllowed({ to: 'orders@klient.nl', bcc: 'ksiegowosc@hkl.eu' }, cfg));
});

// ---------------------------------------------------------------------------
// Przebieg
// ---------------------------------------------------------------------------

function fakeDeps({ pending = [], invoices = {}, sendMail, addInvoiceEvent, renderPdf } = {}) {
  const calls = { find: [], events: [], sent: [], rendered: [], logs: [] };
  const repository = {
    findInvoicesToMail: async (params) => { calls.find.push(params); return pending; },
    getInvoice: async (id) => invoices[id] || null,
    getIssuerProfile: async () => ({ email: 'biuro@hkl.eu' }),
    addInvoiceEvent: addInvoiceEvent || (async (event) => { calls.events.push(event); })
  };
  const service = {
    renderPdf: renderPdf || (async (id) => { calls.rendered.push(id); return { buffer: Buffer.from(`%PDF-${id}`), filename: `${id}.pdf` }; })
  };
  return {
    calls,
    deps: {
      repository,
      service,
      log: (m) => calls.logs.push(m),
      now: () => new Date('2026-10-22T10:00:00Z'),
      sendMail: sendMail || (async (message) => { calls.sent.push(message); return { messageId: `<m${calls.sent.length}@test>` }; })
    }
  };
}

test('przebieg: wyłączona wysyłka nie dotyka bazy', async () => {
  const { calls, deps } = fakeDeps();
  const result = await runInvoiceMailing({ config: readInvoiceMailConfig({}), deps });
  assert.equal(result.skipped, 'disabled');
  assert.equal(calls.find.length, 0);
});

test('przebieg: błędna konfiguracja — nic nie wychodzi, powód w logu', async () => {
  const { calls, deps } = fakeDeps({ pending: [{ id: 1 }] });
  const result = await runInvoiceMailing({ config: readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: '' }), deps });
  assert.equal(result.skipped, 'config');
  assert.equal(calls.find.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.ok(calls.logs.some((m) => /brak adresatów/.test(m)));
});

test('przebieg (tryb testowy): faktury automatu → PDF → mail tylko do Pawła → znacznik mail_redirected', async () => {
  const pending = [
    { id: 501, number: '2026/00121', buyer_name: 'KLIENT B.V.', failures: 0 },
    { id: 502, number: '2026/00122', buyer_name: 'INNY', failures: 1 }
  ];
  const { calls, deps } = fakeDeps({
    pending,
    invoices: {
      501: invoiceFixture(),
      502: invoiceFixture({ id: 502, number: '2026/00122', buyer: { name: 'INNY', email: 'inny@firma.de' } })
    }
  });
  const result = await runInvoiceMailing({ config: readInvoiceMailConfig(BASE_ENV), deps });

  assert.equal(calls.find.length, 1);
  assert.deepEqual(calls.find[0], {
    since: '2026-10-22',
    doneEvent: MailEvent.REDIRECTED,
    failedEvent: MailEvent.FAILED,
    maxAttempts: MAX_ATTEMPTS,
    createdByPin: AUTO_ACTOR,
    limit: 50
  });
  assert.equal(result.sent.length, 2);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(calls.rendered, [501, 502]);
  assert.deepEqual(calls.sent.map((m) => m.to), [PAWEL, PAWEL]);
  assert.ok(calls.sent.every((m) => !m.cc && !m.bcc && !m.replyTo));
  assert.equal(calls.sent[0].attachments[0].content.toString(), '%PDF-501');
  assert.deepEqual(calls.events.map((e) => [e.invoiceId, e.eventType, e.actorPin]), [
    [501, MailEvent.REDIRECTED, AUTO_ACTOR],
    [502, MailEvent.REDIRECTED, AUTO_ACTOR]
  ]);
  assert.deepEqual(calls.events[1].payload, {
    mode: MailMode.REDIRECT, to: [PAWEL], intendedTo: ['inny@firma.de'], messageId: '<m2@test>'
  });
  assert.ok(calls.logs.some((m) => /wysłano 2, błędy 0 \(tryb testowy → pawel\.woroniecki@hkl\.eu; faktury od 2026-10-22\)/.test(m)));
});

test('przebieg: nieudana wysyłka → mail_failed, bez znacznika wysłania, reszta idzie dalej', async () => {
  let n = 0;
  const { calls, deps } = fakeDeps({
    pending: [{ id: 501, number: 'A', buyer_name: 'X', failures: 2 }, { id: 502, number: 'B', buyer_name: 'Y', failures: 0 }],
    invoices: { 501: invoiceFixture(), 502: invoiceFixture({ id: 502, number: 'B' }) },
    sendMail: async () => { n++; if (n === 1) throw new Error('SMTP 451'); return { messageId: 'ok' }; }
  });
  const result = await runInvoiceMailing({ config: readInvoiceMailConfig(BASE_ENV), deps });
  assert.equal(result.failed.length, 1);
  assert.equal(result.sent.length, 1);
  assert.deepEqual(calls.events.map((e) => [e.invoiceId, e.eventType]), [[501, MailEvent.FAILED], [502, MailEvent.REDIRECTED]]);
  assert.match(calls.events[0].payload.error, /SMTP 451/);
  assert.ok(calls.logs.some((m) => /BŁĄD — faktura A .*SMTP 451 \(próba 3\/3\)/.test(m)));
});

test('przebieg (do nabywcy): bez adresu nabywcy — błąd, bez renderu PDF i bez wysyłki', async () => {
  const { calls, deps } = fakeDeps({
    pending: [{ id: 501, number: 'A', buyer_name: 'X', failures: 0 }],
    invoices: { 501: invoiceFixture({ buyer: { name: 'X', email: null } }) }
  });
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: '', INVOICE_MAIL_TO_BUYER: 'true' });
  const result = await runInvoiceMailing({ config: cfg, deps });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /nie ma poprawnego adresu/);
  assert.equal(calls.rendered.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.events[0].eventType, MailEvent.FAILED);
});

test('przebieg (do nabywcy): znacznik mail_sent, adres klienta, Reply-To wystawcy', async () => {
  const { calls, deps } = fakeDeps({
    pending: [{ id: 501, number: 'A', buyer_name: 'X', failures: 0 }],
    invoices: { 501: invoiceFixture() }
  });
  const cfg = readInvoiceMailConfig({ ...BASE_ENV, INVOICE_MAIL_REDIRECT: '', INVOICE_MAIL_TO_BUYER: 'true' });
  await runInvoiceMailing({ config: cfg, deps });
  assert.equal(calls.find[0].doneEvent, MailEvent.SENT);
  assert.equal(calls.sent[0].to, 'orders@klient.nl');
  assert.equal(calls.sent[0].replyTo, 'biuro@hkl.eu');
  assert.equal(calls.events[0].eventType, MailEvent.SENT);
});

test('przebieg: dry-run tylko wypisuje — bez PDF, wysyłki i zapisów', async () => {
  const { calls, deps } = fakeDeps({
    pending: [{ id: 501, number: 'A', buyer_name: 'X', failures: 0 }],
    invoices: { 501: invoiceFixture() }
  });
  const result = await runInvoiceMailing({ dryRun: true, config: readInvoiceMailConfig(BASE_ENV), deps });
  assert.deepEqual(result.planned, [{ invoiceId: 501, number: 'A' }]);
  assert.equal(calls.rendered.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.events.length, 0);
});

test('przebieg: mail wyszedł, ale znacznik się nie zapisał — liczony jako wysłany, ostrzeżenie w logu', async () => {
  const { calls, deps } = fakeDeps({
    pending: [{ id: 501, number: 'A', buyer_name: 'X', failures: 0 }],
    invoices: { 501: invoiceFixture() },
    addInvoiceEvent: async () => { throw new Error('lock wait timeout'); }
  });
  const result = await runInvoiceMailing({ config: readInvoiceMailConfig(BASE_ENV), deps });
  assert.equal(result.sent.length, 1);
  assert.equal(result.failed.length, 0);
  assert.ok(calls.logs.some((m) => /mail wysłany, ale nie zapisano znacznika/.test(m)));
});

test('przebieg: faktura zniknęła z bazy — błąd tej jednej, bez wysyłki', async () => {
  const { calls, deps } = fakeDeps({ pending: [{ id: 999, number: 'Z', buyer_name: 'X', failures: 0 }], invoices: {} });
  const result = await runInvoiceMailing({ config: readInvoiceMailConfig(BASE_ENV), deps });
  assert.equal(result.failed.length, 1);
  assert.equal(calls.sent.length, 0);
});
