'use strict';

/**
 * Numery KSeF faktur HKL (`invoiceKsef.js`, plik Wiktorii `numery_ksef.tsv`): parser, plan zmian,
 * przebieg na atrapie FTP i repozytorium, kod QR i numer na wydruku, blokada wysyłki PDF.
 * Bez bazy i sieci. Numery faktur zmyślone (26999901/26999902 jak w przykładzie Wiktorii).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseKsefTsv, planKsef, runKsefSync, ksefQrDataUri, KsefEvent } = require('../invoiceKsef');
const { InvoiceService } = require('../main');
const { renderInvoiceHtml } = require('../render/renderer');
const { readInvoiceMailConfig, runInvoiceMailing } = require('../invoiceMailer');

const URL_OK = 'https://qr-test.ksef.mf.gov.pl/invoice/9551942642/19-11-2026/PRZYKLAD-26999903';
const HEADER = 'LEVEL\tINVOICENO\tORGANIZATIONIDENT\tINVOICEDATE\tKSEFSTATUS\tKSEFNUMBER\tKSEFDATE\tVERIFYURL\tREASON';
const FILE = [
  HEADER,
  `2\t26999903\tHKL\t2026-11-19\tACCEPTED\t9551942642-20261119-EEEEEE999903-11\t2026-11-19T12:34:56+01:00\t${URL_OK}\t`,
  '2\t26999901\tHKL\t2026-11-19\tREJECTED\t\t\t\t450 Błąd weryfikacji semantycznej dokumentu',
  '1\t26999902\tLUXANGMBH\t2026-11-19\tWITHHELD\t\t\t\tNie wyślemy do KSeF: pozycje są już na fakturze PROD',
  '1\t26999904\tCozy\t2026-11-19\tACCEPTED\t\t\t\t',
  '2\t26999905\tHKL\t19.11.2026\tACCEPTED\tX\t\thttps://x\t'
].join('\r\n') + '\r\n';

const invoiceRow = (id, number, level, org, issueDate = '2026-11-19') => ({ id, number, level, organization_ident: org, issue_date: issueDate });

test('parser: CRLF, nagłówek, trzy stany; ACCEPTED bez numeru/linku i zła data = złe wiersze', () => {
  const { rows, errors } = parseKsefTsv(`﻿${FILE}`);
  assert.deepEqual(rows.map((r) => [r.level, r.number, r.organization, r.status]), [
    [2, '26999903', 'HKL', 'ACCEPTED'],
    [2, '26999901', 'HKL', 'REJECTED'],
    [1, '26999902', 'LUXANGMBH', 'WITHHELD']
  ]);
  assert.equal(rows[0].verifyUrl, URL_OK);
  assert.equal(rows[1].reason, '450 Błąd weryfikacji semantycznej dokumentu');
  assert.equal(errors.length, 2);
  assert.match(parseKsefTsv('LEVEL\tINVOICENO\n1\t2').errors[0], /brak kolumn/);
});

test('przykład Wiktorii z 19.11.2026: wszystkie 8 wierszy poprawne (plik nie jest w repo — prawdziwe numery)', (t) => {
  const file = path.join(process.env.KSEF_EXAMPLE_DIR || '/nonexistent', 'numery_ksef_PRZYKLAD_20261119.tsv');
  if (!fs.existsSync(file)) return t.skip('brak pliku przykładu (KSEF_EXAMPLE_DIR)');
  const { rows, errors } = parseKsefTsv(fs.readFileSync(file));
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => r.status).sort(), ['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'REJECTED', 'WITHHELD']);
});

test('plan: zdarzenie przy zmianie stanu; ten sam stan nic; inna data = inna faktura; ACCEPTED ostateczny', () => {
  const { rows } = parseKsefTsv(FILE);
  const invoices = [
    invoiceRow(1, '26999903', 2, 'HKL'),
    invoiceRow(2, '26999901', 2, 'HKL'),
    invoiceRow(3, '26999902', 1, 'LUXANGMBH', '2026-11-18') // ten sam numer, inna faktura (np. inna baza)
  ];
  const fresh = planKsef(rows, invoices, new Map());
  assert.deepEqual(fresh.changes.map((c) => [c.id, c.eventType]), [[1, KsefEvent.ACCEPTED], [2, KsefEvent.REJECTED]]);
  assert.equal(fresh.changes[0].payload.ksefNumber, '9551942642-20261119-EEEEEE999903-11');
  assert.equal(fresh.changes[0].payload.verifyUrl, URL_OK);
  assert.match(fresh.warnings[0], /26999902: data faktury w pliku 2026-11-19, w eFormie 2026-11-18/);

  // Ten sam stan (ponowny przebieg całego pliku) — nic
  const same = planKsef(rows, invoices, new Map([[1, { status: 'ACCEPTED', ksefNumber: '9551942642-20261119-EEEEEE999903-11' }], [2, { status: 'REJECTED', reason: '450 Błąd weryfikacji semantycznej dokumentu' }]]));
  assert.deepEqual(same.changes, []);

  // REJECTED → poprawiona i przyjęta: nowe zdarzenie; przyjętej nie cofamy
  const later = parseKsefTsv([HEADER, `2\t26999901\tHKL\t2026-11-19\tACCEPTED\t9551942642-20261120-EEEEEE999901-22\t2026-11-20T09:00:00+01:00\t${URL_OK}\t`, '2\t26999903\tHKL\t2026-11-19\tREJECTED\t\t\t\t500 coś'].join('\n')).rows;
  const plan = planKsef(later, invoices, new Map([[1, { status: 'ACCEPTED', ksefNumber: 'K1' }], [2, { status: 'REJECTED', reason: '450' }]]));
  assert.deepEqual(plan.changes.map((c) => [c.id, c.eventType]), [[2, KsefEvent.ACCEPTED]]);
  assert.match(plan.warnings[0], /26999903: w eFormie przyjęta w KSeF \(K1\)/);

  // Brak faktury w eFormie
  assert.equal(planKsef(rows, [], new Map()).unknown.length, 3);
});

function fakeFtp(buffer) {
  return async () => ({
    async downloadTo(sink) {
      if (!buffer) throw Object.assign(new Error('550 No such file'), { code: 550 });
      await new Promise((resolve) => sink.write(buffer, resolve));
    },
    close() {}
  });
}

const ENV = { INVOICE_KSEF_ENABLED: 'true', FTP_HOST: 'ftp.example.test', FTP_USER: 'u', FTP_PASSWORD: 'p', NODE_ENV: 'test' };

test('przebieg: plik z FTP (katalog środowiska) → zdarzenia ksef_*; dry-run i brak pliku nic nie zapisują; domyślnie wyłączone', async () => {
  const events = [];
  const repository = {
    async findInvoicesByNumbers(numbers) { assert.ok(numbers.includes('26999903')); return [invoiceRow(1, '26999903', 2, 'HKL')]; },
    async getKsefStates(ids) { assert.deepEqual(ids, [1]); return new Map(); },
    async addInvoiceEvent(e) { events.push(e); }
  };
  const logs = [];
  const r = await runKsefSync({ env: ENV, deps: { repository, connect: fakeFtp(Buffer.from(FILE)), log: (m) => logs.push(m) } });
  assert.deepEqual(events.map((e) => [e.invoiceId, e.eventType, e.payload.status]), [[1, 'ksef_accepted', 'ACCEPTED']]);
  assert.equal(r.unknown.length, 2);
  assert.equal(r.errors.length, 2);
  assert.ok(logs.some((l) => l.includes('/invoices-test/numery_ksef.tsv')), 'poza produkcją katalog testowy');

  events.length = 0;
  await runKsefSync({ dryRun: true, env: ENV, deps: { repository, connect: fakeFtp(Buffer.from(FILE)), log: () => {} } });
  assert.deepEqual(events, []);
  assert.equal((await runKsefSync({ env: ENV, deps: { repository, connect: fakeFtp(null), log: () => {} } })).skipped, 'no-file');
  assert.equal((await runKsefSync({ env: { ...ENV, INVOICE_KSEF_ENABLED: '' }, deps: { repository } })).skipped, 'disabled');
});

test('wydruk: kod QR z linku bez zmian i numer KSeF pod nim — tylko przy ACCEPTED', async () => {
  const qr = ksefQrDataUri(URL_OK);
  assert.match(qr, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(qr.split(',')[1], 'base64').toString(), /<svg[^>]*viewBox/);

  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'invoice-payload.json'), 'utf8'));
  const html = renderInvoiceHtml({ invoice: { ...payload.invoice, ksef: { number: '9551942642-20261119-EEEEEE999903-11', qrDataUri: qr } }, profile: payload.profile, template: {}, logoDataUri: '' });
  assert.match(html, /class="ksef__qr" src="data:image\/svg\+xml;base64,/);
  // Faktura z przykładu jest po niemiecku — etykieta w języku wydruku
  assert.match(html, /<div class="ksef__label">KSeF-Nummer<\/div>\s*<div class="ksef__number">9551942642-20261119-EEEEEE999903-11</);
  assert.doesNotMatch(renderInvoiceHtml({ invoice: payload.invoice, profile: payload.profile, template: {}, logoDataUri: '' }), /class="ksef"/);

  // Kontekst renderowania doczytuje stan KSeF faktury
  const service = (status) => new InvoiceService({
    log: () => {},
    repository: {
      async getInvoice() { return { id: 7, organizationId: 3 }; },
      async getOrganizationProfile() { return {}; },
      async getTemplate() { return {}; },
      async getKsefStates() { return new Map([[7, { status, ksefNumber: 'K-7', verifyUrl: URL_OK }]]); }
    }
  });
  assert.equal((await service('ACCEPTED').buildRenderContext(7)).invoice.ksef.number, 'K-7');
  assert.equal((await service('REJECTED').buildRenderContext(7)).invoice.ksef, undefined);
});

test('maile: INVOICE_KSEF_MAIL_GATE domyślnie wyłączony; włączony idzie do zapytania kolejki', async () => {
  const BASE = { INVOICE_MAIL_ENABLED: 'true', INVOICE_MAIL_SINCE: '2026-10-22', INVOICE_MAIL_REDIRECT: 'pawel.woroniecki@hkl.eu', MAILBOT_USER: 'test-orders@e-orders.eu', NODE_ENV: 'test' };
  assert.equal(readInvoiceMailConfig(BASE).ksefGate, false);
  const queries = [];
  const repository = { async findInvoicesToMail(q) { queries.push(q); return []; } };
  await runInvoiceMailing({ config: readInvoiceMailConfig({ ...BASE, INVOICE_KSEF_MAIL_GATE: 'true' }), deps: { repository, log: () => {} } });
  await runInvoiceMailing({ config: readInvoiceMailConfig(BASE), deps: { repository, log: () => {} } });
  assert.deepEqual(queries.map((q) => q.ksefGate), [true, false]);
});
