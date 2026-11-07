'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAudience } = require('../audience');

// Sesje w kształcie z services/authService.js (buildOwnerSession / grupa / pracownik).
const hklClient = { userId: 198, orgId: 3, organization: 'HKL', ident: 'BD-Line', isOwner: false, isAdmin: false };
const luxanClient = { userId: 708, orgId: 5, organization: 'LUXANGMBH', ident: 'JC-Köln-Bonner', isOwner: false, isAdmin: false };
const luxanOwner = { userId: 836, orgId: 5, organization: 'LUXANGMBH', ident: 'LuxanGmbH', isOwner: true, isAdmin: false };
const admin = { userId: 2434, orgId: 3, organization: 'HKL', ident: 'SZEF', isOwner: true, isAdmin: true };
const ctx = (user) => ({ userId: user.userId, orgId: user.orgId, organization: user.organization, ident: user.ident });

test('klient widzi wyłącznie swój cennik — w sesji nie ma nic, czym wskazałby cudze konto', () => {
  assert.deepEqual(resolveAudience({ user: hklClient }), { userId: 198, priceSet: 'CENA' });
  assert.deepEqual(resolveAudience({ user: luxanClient }), { userId: 708, priceSet: 'SUB' });
  // `context_user` u zwykłego klienta jest ignorowany (ustawiają go tylko właściciel/admin).
  assert.deepEqual(resolveAudience({ user: luxanClient, context_user: ctx(luxanOwner) }), { userId: 708, priceSet: 'SUB' });
});

test('klient spoza HKL nigdy nie dostaje CENA; właściciel spoza HKL na swoim koncie — tak', () => {
  assert.equal(resolveAudience({ user: luxanClient }).priceSet, 'SUB');
  assert.equal(resolveAudience({ user: luxanOwner }).priceSet, 'CENA');
  assert.equal(resolveAudience({ user: { ...luxanClient, ident: 'luxangmbh_x' } }).priceSet, 'SUB');
});

test('właściciel w podglądzie: klient własnej organizacji wg jego reguły, cudzej — nic', () => {
  assert.deepEqual(resolveAudience({ user: luxanOwner, context_user: ctx(luxanClient) }), { userId: 708, priceSet: 'SUB' });
  assert.equal(resolveAudience({ user: luxanOwner, context_user: ctx(hklClient) }), null);
});

test('admin w podglądzie widzi dowolnego klienta wg jego reguły', () => {
  assert.deepEqual(resolveAudience({ user: admin, context_user: ctx(luxanClient) }), { userId: 708, priceSet: 'SUB' });
  assert.deepEqual(resolveAudience({ user: admin, context_user: ctx(luxanOwner) }), { userId: 836, priceSet: 'CENA' });
  assert.deepEqual(resolveAudience({ user: admin }), { userId: 2434, priceSet: 'CENA' });
});

test('konto podrzędne grupy → SUB___ grupy-matki; pracownik i brak sesji → nic', () => {
  assert.deepEqual(resolveAudience({ user: { userId: 65, isGroupShop: true, groupShopId: 12, orgId: 3 } }), { userId: 65, priceSet: 'SUB', groupShopId: 12 });
  assert.equal(resolveAudience({ user: { userId: 9, isEmployee: true } }), null);
  assert.equal(resolveAudience({}), null);
  assert.equal(resolveAudience(null), null);
});
