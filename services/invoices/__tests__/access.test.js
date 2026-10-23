'use strict';

/**
 * Kto widzi moduł faktur (`access.js`) — jedna reguła dla menu, tras i asystenta.
 * Tryb `INVOICES_ADMIN_ONLY` (start produkcji): wyłącznie administrator.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { canAccessInvoices } = require('../access');
const { flagsFor } = require('../../assistant/knowledge');

const ADMIN = { isAdmin: true, isOwner: true };
const OWNER = { isOwner: true };
const SALON = {};
const GROUP_SHOP = { isGroupShop: true };

test('moduł wyłączony (INVOICES_ENABLED≠true) — nikt, także admin', () => {
  const feats = { invoices: false, invoicesAdminOnly: false };
  for (const user of [ADMIN, OWNER, SALON, GROUP_SHOP, null]) {
    assert.equal(canAccessInvoices(user, feats), false);
  }
});

test('moduł włączony, bez trybu „tylko admin" — wszyscy poza kontem podrzędnym grupy', () => {
  const feats = { invoices: true, invoicesAdminOnly: false };
  assert.equal(canAccessInvoices(ADMIN, feats), true);
  assert.equal(canAccessInvoices(OWNER, feats), true);
  assert.equal(canAccessInvoices(SALON, feats), true);
  assert.equal(canAccessInvoices(GROUP_SHOP, feats), false);
});

test('INVOICES_ADMIN_ONLY — wyłącznie administrator', () => {
  const feats = { invoices: true, invoicesAdminOnly: true };
  assert.equal(canAccessInvoices(ADMIN, feats), true);
  assert.equal(canAccessInvoices(OWNER, feats), false);
  assert.equal(canAccessInvoices(SALON, feats), false);
  assert.equal(canAccessInvoices(GROUP_SHOP, feats), false);
  assert.equal(canAccessInvoices(null, feats), false);
  assert.equal(canAccessInvoices({ isAdmin: true, isGroupShop: true }, feats), false);
});

test('INVOICES_ADMIN_ONLY bez INVOICES_ENABLED niczego nie włącza', () => {
  assert.equal(canAccessInvoices(ADMIN, { invoices: false, invoicesAdminOnly: true }), false);
});

test('asystent: rozdział o fakturach tylko tam, gdzie menu pokazuje faktury', () => {
  const adminOnly = { features: { invoices: true, invoicesAdminOnly: true } };
  assert.equal(flagsFor({ type: 'admin' }, adminOnly).invoices, true);
  // Typy z `services/assistant/sessionContext.js:describeAccount`
  for (const type of ['owner', 'owner_as_client', 'client', 'employee', 'group', 'group_shop']) {
    assert.equal(flagsFor({ type }, adminOnly).invoices, false, `typ ${type}`);
  }

  const forAll = { features: { invoices: true, invoicesAdminOnly: false } };
  assert.equal(flagsFor({ type: 'owner' }, forAll).invoices, true);
  assert.equal(flagsFor({ type: 'group_shop' }, forAll).invoices, false);

  assert.equal(flagsFor({ type: 'admin' }, { features: { invoices: false } }).invoices, false);
});
