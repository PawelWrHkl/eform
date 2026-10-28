'use strict';

/**
 * Stawka VAT CEN ZWYKŁYCH (P) — `vatCalculator.resolveRegularVatRateForOrder`
 * (właściciel 2026-10-27): klient organizacji HKL (id 3) po staremu (kraj konta
 * vs kraj HKL); klient innej organizacji — sprzedaż HKL → organizacja (kraj HKL
 * vs kraj organizacji), kraj klienta bez znaczenia. Baza i config na atrapach.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ORDERS = { 1: { user_id: 10, organization_id: 3 }, 2: { user_id: 20, organization_id: 5 }, 3: { user_id: 30, organization_id: 4 }, 4: { user_id: 40, organization_id: 1 } };
const USERS = { 10: 'DE', 20: 'DE', 30: 'DE', 40: 'NL' };
const ORGS = { 3: 'PL', 5: 'DE', 4: 'PL', 1: 'NL' };

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../../db/db_helper.js', {
  async selectQuery(sql, id) {
    if (sql.includes('FROM `order`')) return ORDERS[id] ? [ORDERS[id]] : false;
    if (sql.includes('FROM `user`')) return [{ country: USERS[id] }];
    if (sql.includes('FROM organization')) return [{ country: ORGS[id] }];
    return false;
  }
});
stub('../../config', { features: { vat: true } });
const { resolveRegularVatRateForOrder } = require('../vatCalculator');

test('ceny zwykłe: klient HKL po staremu (kraj konta vs PL)', async () => {
  const r = await resolveRegularVatRateForOrder(1); // klient z DE w HKL
  assert.equal(r.vatRate, 0);
  assert.equal(r.reason, 'eu-reverse-charge');
});

test('ceny zwykłe: klient innej organizacji — HKL (PL) → kraj organizacji, kraj klienta bez znaczenia', async () => {
  assert.equal((await resolveRegularVatRateForOrder(2)).vatRate, 0, 'LUXANGMBH (DE) — 0%, mimo klienta z DE');
  assert.equal((await resolveRegularVatRateForOrder(3)).vatRate, 23, 'organizacja z PL — 23%, mimo klienta z DE');
  assert.equal((await resolveRegularVatRateForOrder(4)).vatRate, 0, 'COZY (NL) — 0%, mimo klienta z NL');
});

test('ceny zwykłe: nieznane zlecenie — bez stawki', async () => {
  assert.equal((await resolveRegularVatRateForOrder(99)).vatRate, null);
});
