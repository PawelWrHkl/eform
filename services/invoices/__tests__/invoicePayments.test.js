'use strict';

/**
 * Płatności z księgowości (plik Wiktorii `platnosci.tsv` na FTP, 19.11.2026): parsowanie, plan zmian,
 * przebieg z podmienionym FTP i bazą.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, parsePaymentsTsv, planPayments, runPaymentSync, PAYMENTS_HEADER } = require('../invoicePayments');

const FILE = `﻿${PAYMENTS_HEADER.join('\t')}\r\n`
  + '1\t26000002\tLUXANGMBH\t442,18\t2026-11-20\r\n'
  + '2\t26000009\tHKL\t1 000.00\t2026-11-21\r\n'
  + '2\t26000009\tCozy\t0\t\r\n'
  + 'zły wiersz\r\n';

const INVOICES = [
  { id: 1, number: '26000002', level: 1, status: 'issued', amount_due: '442.18', paid_amount: '0.00', organization_ident: 'LUXANGMBH' },
  { id: 2, number: '26000009', level: 2, status: 'overdue', amount_due: '1628.31', paid_amount: '0.00', organization_ident: 'HKL' },
  { id: 3, number: '26000009', level: 2, status: 'issued', amount_due: '500.00', paid_amount: '0.00', organization_ident: 'Cozy' }
];

test('kwota: przecinek, kropka, spacje tysięcy; zła → NaN', () => {
  assert.equal(parseAmount('442,18'), 442.18);
  assert.equal(parseAmount('1 234.5'), 1234.5);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.ok(Number.isNaN(parseAmount('abc')));
});

test('plik: nagłówek po nazwach, BOM i CRLF, złe wiersze osobno', () => {
  const { rows, errors } = parsePaymentsTsv(FILE);
  assert.deepEqual(rows[0], { level: 1, number: '26000002', organization: 'LUXANGMBH', paid: 442.18, date: '2026-11-20' });
  assert.equal(rows.length, 3);
  assert.equal(errors.length, 1);
  assert.match(parsePaymentsTsv('LEVEL\tINVOICENO\n1\t2').errors[0], /brak kolumn ORGANIZATIONIDENT, PAIDAMOUNT, PAIDDATE/);
});

test('plan: pełna wpłata → opłacona; częściowa → kwota; ten sam numer u dwóch wystawców rozróżniony organizacją', () => {
  const { rows } = parsePaymentsTsv(FILE);
  const { updates, unknown } = planPayments(rows, INVOICES);
  assert.deepEqual(updates, [
    { id: 1, number: '26000002', fromStatus: 'issued', status: 'paid', paidAmount: 442.18, paidAt: '2026-11-20' },
    { id: 2, number: '26000009', fromStatus: 'overdue', status: 'overdue', paidAmount: 1000, paidAt: '2026-11-21' }
  ]);
  assert.deepEqual(unknown, []);
  // Opłaconej nie cofamy; nieznana faktura → lista „bez faktury”
  const paid = planPayments([{ level: 1, number: '26000002', organization: 'LUXANGMBH', paid: 0, date: null }, { level: 1, number: '99', organization: 'X', paid: 1, date: '2026-11-20' }],
    [{ ...INVOICES[0], status: 'paid', paid_amount: '442.18' }]);
  assert.deepEqual(paid.updates, []);
  assert.equal(paid.unknown.length, 1);
  assert.match(paid.warnings[0], /26000002: w eFormie opłacona/);
});

test('przebieg: wyłączony nic nie robi; brak pliku na FTP to nie błąd; zmiany idą do bazy', async () => {
  const env = { INVOICE_PAYMENTS_ENABLED: 'true', FTP_HOST: 'ftp.example.test', FTP_USER: 'u', FTP_PASSWORD: 'p', INVOICE_FTP_DIR: '/invoices-test' };
  assert.equal((await runPaymentSync({ env: {}, deps: { connect: () => { throw new Error('nie łączyć'); } } })).skipped, 'disabled');

  const client = (content) => ({
    async downloadTo(sink, remote) {
      assert.equal(remote, '/invoices-test/platnosci.tsv');
      if (content === null) { const e = new Error('550 No such file'); e.code = 550; throw e; }
      sink.write(Buffer.from(content)); sink.end();
    },
    close() {}
  });
  const quiet = () => {};
  assert.equal((await runPaymentSync({ env, deps: { connect: async () => client(null), log: quiet } })).skipped, 'no-file');

  const applied = [];
  const repository = { findInvoicesByNumbers: async (numbers) => { assert.deepEqual(numbers.sort(), ['26000002', '26000009']); return INVOICES; },
    applyPayment: async (p) => { applied.push(p); return true; } };
  const result = await runPaymentSync({ env, deps: { connect: async () => client(FILE), repository, log: quiet } });
  assert.deepEqual(applied.map((a) => [a.number, a.status, a.paidAmount, a.payload.source]), [['26000002', 'paid', 442.18, 'platnosci.tsv'], ['26000009', 'overdue', 1000, 'platnosci.tsv']]);
  assert.equal(result.updated.length, 2);
  assert.equal(result.errors.length, 1);
});
