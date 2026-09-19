'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sendImportedOrder,
  buildImportRequestContext,
  normalizeOrderItems,
  parseJsonField
} = require('../sendAfterImport');

test('parseJsonField parses string JSON and passes through objects', () => {
  assert.deepEqual(parseJsonField('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonField({ b: 2 }), { b: 2 });
  assert.equal(parseJsonField('not-json', 'x'), 'x');
});

test('normalizeOrderItems parses json fields on items', () => {
  const out = normalizeOrderItems([
    { id: 1, json_parameters: '{"KOLOR":"X"}', parameters_short: '{"data":{}}' }
  ]);
  assert.deepEqual(out[0].json_parameters, { KOLOR: 'X' });
  assert.deepEqual(out[0].parameters_short, { data: {} });
});

test('buildImportRequestContext exposes user session for OrderSender', () => {
  const req = buildImportRequestContext({
    id: 5,
    pin: 'P1',
    ident: 'U1',
    client_name: 'Acme',
    organization_id: 3,
    org_ident: 'hkl',
    _importLang: 'de'
  });
  assert.equal(req.session.user.ident, 'U1');
  assert.equal(req.session.user.organization, 'HKL');
  assert.equal(req.getLocale(), 'de');
});

test('sendImportedOrder returns error for empty order', async () => {
  const ordersDb = {
    async getOrderDataToSend() {
      return { orderDetails: {}, orderItems: [] };
    }
  };
  const result = await sendImportedOrder({
    orderId: 1,
    user: { id: 1, pin: 'P', ident: 'U', client_name: 'X', organization_id: 1, org_ident: 'ORG' },
    lang: 'pl',
    deps: { orders: ordersDb, log: () => {} }
  });
  assert.equal(result.sent, false);
  assert.equal(result.error, 'empty order');
});

test('sendImportedOrder changes status, uploads and sends mail with import flag', async () => {
  const calls = { status: null, saveToFile: 0, sendMail: 0, prodPdf: 0 };

  class FakeSender {
    constructor(_req, orderDetails) {
      this.slopePaths = [];
      this.data = { orderid: orderDetails.id, commission: orderDetails.commision };
    }
    async init() {
      this.fileName = 'ORG_U1_42';
      return this.data;
    }
    async saveToFile() {
      calls.saveToFile += 1;
    }
  }

  const ordersDb = {
    async getOrderDataToSend(orderId) {
      return {
        orderDetails: { id: orderId, commision: 'CM-1', contact_info_id: null },
        orderItems: [{
          id: 10,
          json_parameters: { KOLOR: 'X' },
          parameters_short: { data: {}, order: [] },
          json_parameters_desc: '[]'
        }]
      };
    },
    async changeOrderStatus(orderId, status) {
      calls.status = { orderId, status };
      return true;
    },
    async getUserLogo() { return 'hkl.png'; },
    async getGroupDeliveryTimes() { return {}; },
    async getUserMail() {
      return { organization_email: 'org@test', organization_email2: null, user_email: 'user@test' };
    },
    async getUserOrderId() { return 42; },
    async getTotal() { return { visible: 100, hidden: 80 }; },
    async getOrgInfo() { return { company_mail: 'a@b.c' }; }
  };

  const mailer = {
    async sendMailAsync(_to, _lang, _pdf, _attachments, templateVars) {
      calls.sendMail += 1;
      assert.equal(templateVars.isImport, true);
    }
  };

  const result = await sendImportedOrder({
    orderId: 99,
    user: {
      id: 1,
      pin: 'P1',
      ident: 'U1',
      client_name: 'Acme',
      organization_id: 3,
      org_ident: 'ORG'
    },
    lang: 'pl',
    deps: {
      orders: ordersDb,
      mailer,
      log: () => {},
      OrderSender: { OrderSender: FakeSender },
      orderService: {
        async jsonTextBackToMap(items) {
          return { cleanOrderItems: items, total: {} };
        }
      },
      getExtraAttachments: async () => [],
      // jw. — atrapa zapisu `order_item.prod_days`, test nie ma bazy
      recalcAndSaveMaxProdDays: async () => 0,
      generatePdf: async () => Buffer.from('pdf'),
      translateOrderItems: async (_items, clean) => {
        calls.prodPdf += 1;
        return clean;
      },
      generateProductionPdf: async () => Buffer.from('prod'),
      uploadProductionPdf: async (_pdf, _name, options) => {
        assert.equal(options.forceProductionSend, true);
      },
      buildItemProductionDays: () => ({ maxProdDays: 0 }),
      getProductionSendSkipClient: () => null,
      // Bez tego wiersz `user` bez kolumn AB kazałby dopytać PRAWDZIWĄ bazę
      resolveOrderAbPolicy: async () => ({ withoutPrices: false, abLang: null, clientAb: false, deliveryDelay: 0 }),
      formatSendTotals: async (data) => {
        data.total = '100€';
        return data;
      }
    }
  });

  assert.equal(result.sent, true);
  assert.equal(calls.status?.status, 'sent');
  assert.equal(calls.status?.orderId, 99);
  assert.equal(calls.saveToFile, 1);
  assert.equal(calls.sendMail, 1);
  assert.equal(calls.prodPdf, 1);
});

/* ------------------------------------------------------------------ */
/* Zasady potwierdzenia (AB) — wspólne z panelem `routes/orders.js`     */
/* ------------------------------------------------------------------ */

/** Minimalny zestaw atrap, żeby dojść do wysyłki maila i sprawdzić decyzje. */
function harnessAb() {
  const zapisane = { pdfOptions: null, docLang: null, to: null, bcc: null, mailOptions: null, delay: null };

  class FakeSender {
    constructor(_req, orderDetails) { this.slopePaths = []; this.data = { orderid: orderDetails.id }; }
    async init() { this.fileName = 'ORG_U1_42'; return this.data; }
    async saveToFile() {}
  }

  const orders = {
    async getOrderDataToSend(orderId) {
      return {
        orderDetails: { id: orderId, commision: 'CM-1', contact_info_id: null },
        orderItems: [{ id: 10, json_parameters: { KOLOR: 'X' }, parameters_short: { data: {}, order: [] }, json_parameters_desc: '[]' }]
      };
    },
    async changeOrderStatus() { return true; },
    async getUserLogo() { return 'hkl.png'; },
    async getGroupDeliveryTimes() { return {}; },
    async getUserMail() { return { organization_email: 'org@hkl.eu', organization_email2: 'szef@hkl.eu', user_email: 'klient@example.nl' }; },
    async getUserOrderId() { return 42; },
    async getTotal() { return { visible: 100, hidden: 80 }; },
    async getOrgInfo() { return { company_mail: 'a@b.c' }; }
  };

  const deps = {
    orders,
    log: () => {},
    OrderSender: { OrderSender: FakeSender },
    orderService: { async jsonTextBackToMap(items) { return { cleanOrderItems: items, total: {} }; } },
    getExtraAttachments: async () => [],
    generateOrderDocuments: async (_details, _items, docLang, ..._rest) => {
      zapisane.docLang = docLang;
      zapisane.pdfOptions = _rest[_rest.length - 1];
      return { pdf: Buffer.from('pdf'), html: '<html></html>' };
    },
    translateOrderItems: async (_items, clean) => clean,
    generateProductionPdf: async () => Buffer.from('prod'),
    uploadProductionPdf: async () => {},
    buildItemProductionDays: (_items, _times, delay) => { zapisane.delay = delay; return { maxProdDays: 0 }; },
    // Zapis `order_item.prod_days` chodzi po bazie — w teście zastępujemy go
    // atrapą, żeby wysyłka po imporcie dawała się sprawdzić bez MySQL-a.
    recalcAndSaveMaxProdDays: async () => 0,
    getProductionSendSkipClient: () => null,
    formatSendTotals: async (d) => d,
    sendMailAsync: async (to, _lang, _pdf, _att, _vars, bcc, _tpl, _subj, options) => {
      zapisane.to = to; zapisane.bcc = bcc; zapisane.mailOptions = options;
    }
  };

  return { zapisane, deps };
}

test('import: `ab_type` z bazy usuwa ceny z PDF-a potwierdzenia', async () => {
  const { zapisane, deps } = harnessAb();
  // Kolumn AB nie ma w przekazanym wierszu → moduł MUSI dopytać bazę po zamówieniu.
  deps.resolveOrderAbPolicy = async () => ({ withoutPrices: true, abLang: null, clientAb: false, deliveryDelay: 0 });

  const r = await sendImportedOrder({ orderId: 202, user: { id: 1, pin: 'P1', ident: 'U1', client_name: 'Acme', organization_id: 3, org_ident: 'ORG' }, lang: 'pl', deps });
  assert.equal(r.sent, true);
  assert.deepEqual(zapisane.pdfOptions, { withoutPrices: true }, 'flaga musi dojechać do generatora PDF');
});

test('import: `ab_lang` wymusza język dokumentu i maila', async () => {
  const { zapisane, deps } = harnessAb();
  deps.resolveOrderAbPolicy = async () => ({ withoutPrices: false, abLang: 'nl', clientAb: false, deliveryDelay: 0 });

  await sendImportedOrder({ orderId: 202, user: { id: 1, pin: 'P1', ident: 'U1', client_name: 'Acme', organization_id: 3, org_ident: 'ORG' }, lang: 'pl', deps });
  assert.equal(zapisane.docLang, 'nl', 'PDF w języku klienta, nie w języku importu');
  assert.equal(zapisane.mailOptions.abLang, 'nl', 'mail (temat/treść) w tym samym języku');
});

test('import: `client_ab` kieruje potwierdzenie do klienta, nie do organizacji', async () => {
  const { zapisane, deps } = harnessAb();
  deps.resolveOrderAbPolicy = async () => ({ withoutPrices: false, abLang: null, clientAb: true, deliveryDelay: 0 });
  deps.resolveConfirmationRecipients = (arg) => {
    // Sprawdzamy, że import podaje wspólnej funkcji WSZYSTKIE potrzebne adresy
    assert.equal(arg.clientAb, true);
    assert.equal(arg.confirmationEmail, 'klient@example.nl');
    assert.equal(arg.organizationEmail, 'org@hkl.eu');
    return { mainRecipient: arg.confirmationEmail, bccList: [], bcc: 'org@hkl.eu' };
  };

  await sendImportedOrder({ orderId: 202, user: { id: 1, pin: 'P1', ident: 'U1', client_name: 'Acme', organization_id: 3, org_ident: 'ORG' }, lang: 'pl', deps });
  assert.equal(zapisane.to, 'klient@example.nl');
  assert.equal(zapisane.bcc, 'org@hkl.eu');
});

test('import: `delivery_delay` dochodzi do wyliczenia dni produkcji', async () => {
  const { zapisane, deps } = harnessAb();
  // Wiersz Z kolumnami — wtedy czytamy z niego i nie ruszamy bazy.
  const user = { id: 1, pin: 'P1', ident: 'U1', client_name: 'Acme', organization_id: 3, org_ident: 'ORG', ab_type: null, ab_lang: null, client_ab: 0, delivery_delay: 10 };
  deps.resolveOrderAbPolicy = async () => { throw new Error('nie powinno pytać bazy, gdy wiersz ma kolumny'); };

  await sendImportedOrder({ orderId: 202, user, lang: 'pl', deps });
  assert.equal(zapisane.delay, 10);
});
