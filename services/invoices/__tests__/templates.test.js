'use strict';

/**
 * Szablon faktury per organizacja: formatka (papier firmowy w PDF), marginesy,
 * bezpieczne ścieżki z bazy i wybór szablonu WYSTAWCY przy tworzeniu dokumentu.
 * Bez bazy i bez Chromium — PDF-y składane w pamięci przez pdf-lib.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const templates = require('../core/templates');
const renderer = require('../render/renderer');
const { HKL_ORG_ID } = require('../core/pricing');

const quiet = () => {};

test('pickTemplateCode: „default" znaczy „nie ustawiono" — wygrywa pierwszy własny', () => {
  assert.equal(templates.pickTemplateCode('default', 'LUXANGMBH'), 'LUXANGMBH');
  assert.equal(templates.pickTemplateCode('HKL_SPECIAL', 'LUXANGMBH'), 'HKL_SPECIAL');
  assert.equal(templates.pickTemplateCode(null, undefined, ''), 'default');
});

test('templateOrganizationId: szablon wystawcy, nie organizacji zamówienia', () => {
  const ctx = { orderOrganizationId: 5, manufacturerOrganizationId: 3 };
  assert.equal(templates.templateOrganizationId({ level: 1, ...ctx }), 3, 'poziom 1 wystawia HKL');
  assert.equal(templates.templateOrganizationId({ level: 2, ...ctx }), 5);
  assert.equal(templates.templateOrganizationId({ level: 4, ...ctx }), 5);
  assert.equal(templates.templateOrganizationId({ level: 3, ...ctx }), null, 'salon nie jest organizacją');
});

test('normalizeTemplatePath: tylko pliki wewnątrz katalogu i z właściwym rozszerzeniem', () => {
  assert.equal(templates.normalizeTemplatePath('LUXANGMBH.pdf', '.pdf'), 'LUXANGMBH.pdf');
  assert.equal(templates.normalizeTemplatePath('organizations/./cozy.njk', '.njk'), 'organizations/cozy.njk');
  for (const bad of ['../../server.js', '/etc/passwd.pdf', 'a/../../x.pdf', 'x\\y.pdf', 'x.pdf\0', 'LUXAN GMBH.pdf', 'x.PDF.exe', '']) {
    assert.equal(templates.normalizeTemplatePath(bad, '.pdf'), null, bad);
  }
  assert.equal(templates.normalizeTemplatePath('invoice-main.njk', '.pdf'), null, 'złe rozszerzenie');
});

test('parsePageMargins: JSON z bazy, braki i bzdury → wartości domyślne', () => {
  const d = templates.DEFAULT_BACKGROUND_MARGINS;
  assert.deepEqual(templates.parsePageMargins(null), { ...d });
  assert.deepEqual(templates.parsePageMargins('{"top":24,"bottom":27}'), { ...d, top: 24, bottom: 27 });
  assert.deepEqual(templates.parsePageMargins({ top: -5, right: 'x', bottom: 500, left: 0 }), { ...d, left: 0 });
  assert.deepEqual(templates.parsePageMargins('nie-json'), { ...d });
});

test('resolveTemplateFiles: brakujący albo niedozwolony plik → szablon domyślny z ostrzeżeniem', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.deepEqual(
    renderer.resolveTemplateFiles({ code: 'X', templateFile: 'brak.njk', stylesheet: '../../../.env.css' }, { warn }),
    { templateFile: 'invoice-main.njk', stylesheet: 'styles/invoice.css' }
  );
  assert.equal(warnings.length, 2);
  // Istniejący plik w podkatalogu przechodzi bez ostrzeżeń
  const ok = renderer.resolveTemplateFiles({ code: 'Y', templateFile: 'partials/header.njk' }, { warn });
  assert.equal(ok.templateFile, 'partials/header.njk');
  assert.equal(warnings.length, 2);
});

test('resolveBackgroundFile: formatka z img/invoice-background albo null', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(renderer.resolveBackgroundFile(null, { warn }), null);
  assert.equal(renderer.resolveBackgroundFile('NIE_MA.pdf', { warn }), null);
  assert.equal(renderer.resolveBackgroundFile('../../../package.json', { warn }), null);
  assert.equal(warnings.length, 2);
  // Prawdziwe formatki z repo
  assert.equal(
    renderer.resolveBackgroundFile('LUXANGMBH.pdf', { warn }),
    path.join(renderer.BACKGROUNDS_DIR, 'LUXANGMBH.pdf')
  );
});

test('backgroundPageSize: rozmiar i orientacja strony z formatki', async () => {
  const fs = require('fs');
  const lux = await renderer.backgroundPageSize(fs.readFileSync(path.join(renderer.BACKGROUNDS_DIR, 'LUXANGMBH.pdf')));
  assert.ok(Math.abs(lux.widthMm - 290) < 1 && Math.abs(lux.heightMm - 210) < 1, JSON.stringify(lux));
});

async function pdfWithPages(count, [w, h]) {
  const doc = await PDFDocument.create();
  // Strona musi mieć treść — pdf-lib nie osadza pustych (Chromium zawsze coś rysuje)
  for (let i = 0; i < count; i++) doc.addPage([w, h]).drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
  return Buffer.from(await doc.save());
}

test('overlayOnBackground: każda strona treści dostaje formatkę i jej rozmiar', async () => {
  const background = await pdfWithPages(1, [822, 595]);
  // Chromium zaokrągla mm → pt, więc treść bywa o ułamek punktu inna
  const content = await pdfWithPages(3, [821.6, 595.4]);
  const merged = await PDFDocument.load(await renderer.overlayOnBackground(content, background));
  assert.equal(merged.getPageCount(), 3, 'formatka na każdej stronie faktury');
  for (const page of merged.getPages()) {
    assert.deepEqual(page.getSize(), { width: 822, height: 595 });
  }
});

/**
 * Atrapa repozytorium dla `createFromOrder` — profile organizacji per id,
 * żeby było widać, CZYJ szablon trafia na dokument.
 */
function fakeRepository({ orgTemplates = {}, issuerTemplate = 'default' } = {}) {
  const saved = [];
  const orgProfile = (id) => ({
    organizationId: id, orgCode: `ORG${id}`, seller: { name: `Org ${id}`, country: 'PL' },
    localCurrency: 'PLN', defaultCurrency: 'EUR', defaultPaymentDays: 14, defaultLang: 'pl',
    templateCode: orgTemplates[id] || 'default', numberPatterns: {}, footerNotes: {}
  });
  return {
    saved,
    async getOrderInvoiceSource() {
      return {
        order: { id: 1, organization_id: 5, order_idx: '11', status: 'sent', prod_status: '!sent!' },
        orderItems: [{ id: 1, total_price: '0.00', json_parameters: {} }],
        organization: { id: 5, name: 'Luxan GmbH', country: 'DE' },
        user: { id: 9, client_name: 'Salon', country: 'DE' },
        groupShop: null
      };
    },
    async getOrganizationProfile(id) { return orgProfile(Number(id)); },
    async getIssuerProfile({ issuerType, issuerId, level }) {
      return {
        issuerType, issuerId, level, name: 'Wystawca', country: 'DE', taxId: 'DE1',
        registryNumbers: {}, currency: 'EUR', localCurrency: 'PLN', paymentDays: 14,
        defaultLang: 'pl', templateCode: issuerTemplate, themeVars: {},
        numberPattern: '{YYYY}/{NR:5}', legalSettings: {}, footerNotes: {}
      };
    },
    async getAllocatedQuantities() { return new Map(); },
    async getEndClient() { return { id: 7, name: 'Odbiorca', country: 'DE', owner_user_id: 9 }; },
    async getAdvanceInvoicesForOrder() { return []; },
    async createInvoice(invoice) { saved.push(invoice); return { id: saved.length, number: null }; }
  };
}

async function templateCodeFor(level, repoOpts) {
  const { InvoiceService } = require('../main');
  const repository = fakeRepository(repoOpts);
  const service = new InvoiceService({ repository, log: quiet, vies: { check: async () => ({ checked: false, valid: false }) } });
  await service.createFromOrder({ orderId: 1, level, allowZeroTotal: true, skipVies: true, endClientId: level === 3 ? 7 : undefined });
  return repository.saved[0].templateCode;
}

test('createFromOrder: poziom 2 — formatka organizacji zamówienia', async () => {
  assert.equal(await templateCodeFor(2, { orgTemplates: { 5: 'LUXANGMBH', [HKL_ORG_ID]: 'HKL' } }), 'LUXANGMBH');
});

test('createFromOrder: poziom 1 — formatka HKL, nie organizacji-nabywcy', async () => {
  assert.equal(await templateCodeFor(1, { orgTemplates: { 5: 'LUXANGMBH', [HKL_ORG_ID]: 'HKL' } }), 'HKL');
});

test('createFromOrder: poziom 3 (salon) — szablon domyślny, nie formatka organizacji', async () => {
  assert.equal(await templateCodeFor(3, { orgTemplates: { 5: 'LUXANGMBH' } }), 'default');
});

test('createFromOrder: własny szablon w profilu wystawcy wygrywa z organizacją', async () => {
  assert.equal(await templateCodeFor(2, { orgTemplates: { 5: 'LUXANGMBH' }, issuerTemplate: 'LUXANGMBH_2027' }), 'LUXANGMBH_2027');
});
