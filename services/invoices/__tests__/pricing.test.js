'use strict';

/**
 * Warstwa cenowa: która kwota z pozycji zamówienia jest ceną sprzedaży.
 *
 * ⚠️ Testy pilnują reguły handlowej, nie implementacji: ceny `SUB___` należą do
 * relacji „organizacja ≠ HKL → jej użytkownik". Pomyłka tutaj to faktura po
 * cudzym cenniku — w bazie różnica sięga 5× (pozycja 7017: 181,33 vs 887,00).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePriceBasis, PriceBasis, HKL_ORG_ID, isHklOrganization } = require('../core/pricing');
const { InvoiceLevel, IssuerType } = require('../core/hierarchy');

test('poziom 1: HKL sprzedaje organizacji po cenach bazowych', () => {
  const r = resolvePriceBasis({
    level: InvoiceLevel.MANUFACTURER_TO_ORGANIZATION,
    issuerType: IssuerType.MANUFACTURER,
    issuerId: 0,
    organizationId: 1
  });
  assert.equal(r.basis, PriceBasis.BASE);
  assert.equal(r.useSubPrices, false);
});

test('poziom 2: organizacja ≠ HKL fakturuje użytkownika po cenach SUB', () => {
  const r = resolvePriceBasis({
    level: InvoiceLevel.ORGANIZATION_TO_USER,
    issuerType: IssuerType.ORGANIZATION,
    issuerId: 1,
    organizationId: 1
  });
  assert.equal(r.basis, PriceBasis.SUB);
  assert.equal(r.useSubPrices, true);
});

test('poziom 2: HKL sprzedaje bezpośrednio swojemu klientowi po cenach bazowych', () => {
  const r = resolvePriceBasis({
    level: InvoiceLevel.ORGANIZATION_TO_USER,
    issuerType: IssuerType.ORGANIZATION,
    issuerId: HKL_ORG_ID,
    organizationId: HKL_ORG_ID
  });
  assert.equal(r.basis, PriceBasis.BASE);
  assert.equal(r.useSubPrices, false);
});

test('poziom 4: sprzedaż bezpośrednia idzie po cenniku WYSTAWCY, nie kupującego', () => {
  const hkl = resolvePriceBasis({
    level: InvoiceLevel.ORGANIZATION_TO_END_CLIENT,
    issuerType: IssuerType.ORGANIZATION,
    issuerId: HKL_ORG_ID,
    organizationId: HKL_ORG_ID
  });
  const other = resolvePriceBasis({
    level: InvoiceLevel.ORGANIZATION_TO_END_CLIENT,
    issuerType: IssuerType.ORGANIZATION,
    issuerId: 1,
    organizationId: 1
  });
  assert.equal(hkl.useSubPrices, false);
  assert.equal(other.useSubPrices, true);
});

test('poziom 3: salon fakturuje odbiorcę po swoim cenniku zakupu', () => {
  const podHkl = resolvePriceBasis({
    level: InvoiceLevel.USER_TO_END_CLIENT, issuerType: IssuerType.USER, issuerId: 500, organizationId: HKL_ORG_ID
  });
  const podInna = resolvePriceBasis({
    level: InvoiceLevel.USER_TO_END_CLIENT, issuerType: IssuerType.USER, issuerId: 500, organizationId: 1
  });
  assert.equal(podHkl.useSubPrices, false);
  assert.equal(podInna.useSubPrices, true);
  // Ograniczenie musi być widoczne w uzasadnieniu — trafia do logu i do panelu
  assert.match(podInna.reason, /detalicznej/);
});

test('jawne nadpisanie ma pierwszeństwo, ale jest opisane jako ręczne', () => {
  const r = resolvePriceBasis({
    level: InvoiceLevel.ORGANIZATION_TO_USER, issuerType: IssuerType.ORGANIZATION, issuerId: 1, organizationId: 1, override: false
  });
  assert.equal(r.useSubPrices, false);
  assert.match(r.reason, /ręcznie/);
});

test('rozpoznanie HKL nie łapie null/undefined', () => {
  assert.equal(isHklOrganization(HKL_ORG_ID), true);
  assert.equal(isHklOrganization(String(HKL_ORG_ID)), true);
  assert.equal(isHklOrganization(null), false);
  assert.equal(isHklOrganization(undefined), false);
});
