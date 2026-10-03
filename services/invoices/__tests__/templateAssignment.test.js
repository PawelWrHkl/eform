'use strict';

/**
 * Przypisanie formatki organizacji (`templateAssignment.js`) — panel
 * `/invoices/profile` i `scripts/setInvoiceTemplate.js`. Atrapa repozytorium,
 * bez bazy; pliki formatek prawdziwe (`img/invoice-background/`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { assignOrganizationTemplate, listBackgrounds, baseCodeFor, versionedCode } = require('../templateAssignment');

function fakeRepository({ templateCode = 'default', rows = {}, usage = {}, orgCode = 'LUXANGMBH' } = {}) {
  const state = { templateCode, rows: { ...rows }, writes: [] };
  return {
    state,
    async getOrganizationProfile(id) {
      return { organizationId: id, orgCode, seller: { name: 'Luxan GmbH' }, templateCode: state.templateCode };
    },
    async getTemplateRow(code) { return state.rows[code] || null; },
    async countInvoicesWithTemplate(code) { return usage[code] || 0; },
    async upsertTemplate(row) { state.writes.push(['template', row.code]); state.rows[row.code] = row; },
    async upsertOrganizationProfile(id, patch) { state.writes.push(['profile', patch.template_code]); state.templateCode = patch.template_code; return true; }
  };
}

const NOW = () => new Date(2026, 9, 2, 10, 15);
const LUX = { backgroundFile: 'LUXANGMBH.pdf', pageMargins: { top: 24, right: 12, bottom: 27, left: 12 } };

test('pierwsza formatka: kod = ident organizacji, profil wskazuje ten kod', async () => {
  const repository = fakeRepository();
  const result = await assignOrganizationTemplate({ organizationId: 5, ...LUX }, { repository, now: NOW });
  assert.deepEqual(result, { code: 'LUXANGMBH', changed: true, versioned: false, previousCode: 'default' });
  assert.equal(repository.state.rows.LUXANGMBH.backgroundFile, 'LUXANGMBH.pdf');
  assert.deepEqual(repository.state.rows.LUXANGMBH.pageMargins, LUX.pageMargins);
  assert.equal(repository.state.templateCode, 'LUXANGMBH');
});

test('zmiana marginesów przed pierwszą fakturą — w miejscu, bez nowej wersji', async () => {
  const repository = fakeRepository({ templateCode: 'LUXANGMBH', rows: { LUXANGMBH: { code: 'LUXANGMBH', templateFile: 'invoice-main.njk', stylesheet: 'styles/invoice.css', ...LUX } } });
  const result = await assignOrganizationTemplate({ organizationId: 5, backgroundFile: 'LUXANGMBH.pdf', pageMargins: { ...LUX.pageMargins, top: 26 } }, { repository, now: NOW });
  assert.equal(result.code, 'LUXANGMBH');
  assert.equal(result.versioned, false);
  assert.equal(repository.state.rows.LUXANGMBH.pageMargins.top, 26);
});

test('kod z wystawionymi fakturami — nowa wersja, stary wiersz nietknięty', async () => {
  const original = { code: 'LUXANGMBH', templateFile: 'invoice-main.njk', stylesheet: 'styles/invoice.css', ...LUX };
  const repository = fakeRepository({ templateCode: 'LUXANGMBH', rows: { LUXANGMBH: original }, usage: { LUXANGMBH: 12 } });
  const result = await assignOrganizationTemplate({ organizationId: 5, backgroundFile: 'COZY.pdf', pageMargins: LUX.pageMargins }, { repository, now: NOW });
  assert.equal(result.code, 'LUXANGMBH_202610021015');
  assert.equal(result.versioned, true);
  assert.equal(repository.state.rows.LUXANGMBH, original, 'faktury z kodem LUXANGMBH drukują się dalej na starej formatce');
  assert.equal(repository.state.templateCode, 'LUXANGMBH_202610021015');
});

test('te same ustawienia — nic nie zapisujemy', async () => {
  const repository = fakeRepository({ templateCode: 'LUXANGMBH', rows: { LUXANGMBH: { code: 'LUXANGMBH', templateFile: 'invoice-main.njk', stylesheet: 'styles/invoice.css', ...LUX } }, usage: { LUXANGMBH: 3 } });
  const result = await assignOrganizationTemplate({ organizationId: 5, ...LUX }, { repository, now: NOW });
  assert.equal(result.changed, false);
  assert.deepEqual(repository.state.writes, []);
});

test('nieistniejąca albo niedozwolona formatka — błąd i ZERO zapisów', async () => {
  for (const backgroundFile of ['NIE_MA.pdf', '../../package.json']) {
    const repository = fakeRepository();
    await assert.rejects(assignOrganizationTemplate({ organizationId: 5, backgroundFile }, { repository }), /Formatka/);
    assert.deepEqual(repository.state.writes, [], backgroundFile);
  }
});

test('bez formatki — organizacja wraca do szablonu domyślnego, wiersz formatki zostaje', async () => {
  const row = { code: 'LUXANGMBH', ...LUX };
  const repository = fakeRepository({ templateCode: 'LUXANGMBH', rows: { LUXANGMBH: row } });
  const result = await assignOrganizationTemplate({ organizationId: 5, backgroundFile: '' }, { repository });
  assert.equal(result.code, 'default');
  assert.equal(repository.state.templateCode, 'default');
  assert.equal(repository.state.rows.LUXANGMBH, row);
});

test('cudzy kod przypisany skryptem nie jest edytowany w miejscu', async () => {
  const shared = { code: 'WSPOLNY', templateFile: 'invoice-main.njk', stylesheet: 'styles/invoice.css', backgroundFile: 'HKL.pdf', pageMargins: null };
  const repository = fakeRepository({ templateCode: 'WSPOLNY', rows: { WSPOLNY: shared } });
  const result = await assignOrganizationTemplate({ organizationId: 5, ...LUX }, { repository, now: NOW });
  assert.equal(result.code, 'LUXANGMBH');
  assert.equal(repository.state.rows.WSPOLNY, shared);
});

test('kody: ident → bazowy kod, wersja z datą i godziną', () => {
  assert.equal(baseCodeFor('Cozy', 1), 'COZY');
  assert.equal(baseCodeFor('LUXAN EWA', 4), 'LUXAN_EWA');
  assert.equal(baseCodeFor('', 9), 'ORG9');
  assert.equal(versionedCode('HKL', NOW()), 'HKL_202610021015');
});

test('listBackgrounds: formatki z katalogu z rozmiarem i orientacją', async () => {
  const list = await listBackgrounds();
  const byFile = Object.fromEntries(list.map((b) => [b.file, b]));
  assert.equal(byFile['LUXANGMBH.pdf'].orientation, 'landscape');
  assert.equal(byFile['HKL.pdf'].orientation, 'portrait');
  assert.equal(byFile['COZY.pdf'].widthMm, 290);
});
