'use strict';

/**
 * Termin płatności (Paweł 20.11.2026, „jedno i drugie”): ręczna zmiana → przeliczona wystawiona faktura
 * zachowuje swój → contractors.txt PAYMENT_DAYS (płatnik → klient; poziom 1: konto organizacji-nabywcy)
 * → wystawca → 14. Baza bez migracji (`payment_days` brak) = jak dotąd, 14 dni.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { InvoiceService } = require('../main');
const { paymentDaysOf } = require('../core/contractorAccounts');

test('paymentDaysOf: liczba z bazy; brak kolumny, NULL, „-”, ujemne → null', () => {
  assert.equal(paymentDaysOf({ payment_days: 60 }), 60);
  assert.equal(paymentDaysOf({ payment_days: 0 }), 0, '0 dni (przedpłata) to termin, nie brak');
  for (const row of [{}, { payment_days: null }, { payment_days: '' }, { payment_days: '-' }, { payment_days: -1 }, null]) {
    assert.equal(paymentDaysOf(row), null, JSON.stringify(row));
  }
});

/** Faktura z zamówienia (dryRun) — zwraca termin w dniach od daty wystawienia. */
async function dueDays({ level = 2, user = {}, organizationPaymentDays, params = {} } = {}) {
  const repository = {
    async getOrderInvoiceSource() {
      return {
        order: { id: 1, organization_id: 1, order_idx: '7', status: 'sent', prod_status: '!sent!' },
        orderItems: [{ id: 1, total_price: '50.00', total_price_sub: '50.00', json_parameters: { ILOSC: '1' } }],
        organization: { id: 1, ident: 'Cozy', name: 'MaizonCozy B.V.', country: 'NL' },
        organizationPaymentDays,
        user: { id: 9, client_name: 'Klant', country: 'NL', ...user },
        groupShop: null
      };
    },
    async getOrganizationProfile(id) {
      return { organizationId: id, orgCode: 'Cozy', templateCode: 'COZY', seller: { name: 'MaizonCozy B.V.', country: 'NL' }, localCurrency: 'EUR', defaultCurrency: 'EUR', defaultPaymentDays: 14, defaultLang: 'nl', numberPatterns: {}, footerNotes: {} };
    },
    async getIssuerProfile({ issuerType }) {
      return {
        issuerType, issuerId: 1, level, name: issuerType === 'manufacturer' ? 'HKL' : 'MaizonCozy B.V.', country: issuerType === 'manufacturer' ? 'PL' : 'NL',
        taxId: 'X', registryNumbers: {}, currency: 'EUR', localCurrency: 'EUR', paymentDays: 14,
        templateCode: 'COZY', themeVars: {}, numberPattern: '{YY}{NR:6}', legalSettings: {}, footerNotes: {}
      };
    },
    async getAllocatedQuantities() { return new Map(); },
    async getEndClient() { return null; },
    async getAdvanceInvoicesForOrder() { return []; },
    async createInvoice() { throw new Error('dryRun nie zapisuje'); }
  };
  const service = new InvoiceService({
    repository, log: () => {}, vies: { check: async () => ({ checked: false, valid: false }) },
    currency: { getRate: async () => 1 }, now: () => new Date('2026-11-20T10:00:00Z')
  });
  const { invoice } = await service.createFromOrder({ orderId: 1, level, skipVies: true, dryRun: true, ...params });
  return Math.round((Date.parse(invoice.dueDate) - Date.parse(invoice.issueDate)) / 86400000);
}

test('termin: klient/płatnik z contractors.txt; bez kolumny jak dotąd 14 dni z profilu wystawcy', async () => {
  assert.equal(await dueDays(), 14, 'baza bez migracji / pusty PAYMENT_DAYS — bez zmian');
  assert.equal(await dueDays({ user: { paymentDays: 30 } }), 30, 'poziom 2: termin klienta (płatnik łączy repozytorium)');
  assert.equal(await dueDays({ user: { paymentDays: 0 } }), 0);
  assert.equal(await dueDays({ user: { paymentDays: 30 }, organizationPaymentDays: 60 }), 30, 'poziom 2: termin organizacji nie dotyczy klienta');
});

test('termin: poziom 1 (HKL → organizacja) z konta organizacji-nabywcy, klient zamówienia się nie liczy', async () => {
  assert.equal(await dueDays({ level: 1, organizationPaymentDays: 60, user: { paymentDays: 30 } }), 60, 'HKL → Cozy: 60 jak na PROD');
  assert.equal(await dueDays({ level: 1, user: { paymentDays: 30 } }), 14);
});

test('termin: ręczna zmiana wygrywa; przeliczona wystawiona faktura zachowuje swój termin', async () => {
  assert.equal(await dueDays({ user: { paymentDays: 30 }, params: { paymentDays: 7 } }), 7);
  assert.equal(await dueDays({ user: { paymentDays: 30 }, params: { overlay: { header: { paymentDays: 21 } } } }), 21, 'nakładka edytora (nagłówek)');
  const replace = { id: 5, number: '26000002', issueDate: '2026-11-18', dueDate: '2026-12-02' };
  assert.equal(await dueDays({ level: 1, organizationPaymentDays: 60, params: { replace } }), 14, 'wystawiona 18.11 z 14 dniami — po przebudowie dalej 02.12');
  assert.equal(await dueDays({ level: 1, organizationPaymentDays: 60, params: { replace: { ...replace, dueDate: undefined } } }), 60, 'stary replace bez terminu — liczy jak nowa');
});
