'use strict';

/**
 * Konto HKL do wpłaty z kartoteki księgowości (19.11.2026, „to obowiązek”): dopasowanie po NIP,
 * domyślne konto + ostrzeżenie dla nabywcy spoza pliku, tylko faktury HKL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { HKL_ORG_ID } = require('../core/pricing');
const { DEFAULT_ACCOUNT, normalizeTaxId, isValidIban, formatIban, hklPaymentAccount, withPaymentAccountWarning, accountFromContractor, cleanValue } = require('../core/contractorAccounts');

const TABLE = { '869751876B01': { ident: 'RYVER BLINDS BV', bankName: 'ING BANK ŚLĄSKI S.A.', iban: 'PL34 1050 1559 1000 0090 3311 9596', swift: 'INGBPLPW' },
  8513194309: { ident: 'LUXAN EWA KRAWCZYK', bankName: 'ING BANK ŚLĄSKI S.A.', iban: 'PL56 1050 1559 1000 0090 3311 9588', swift: 'INGBPLPW' } };

test('NIP: bez kodu kraju, spacji i myślników', () => {
  assert.equal(normalizeTaxId('PL 851-319-43-09'), '8513194309');
  assert.equal(normalizeTaxId('NL869751876B01'), '869751876B01');
  assert.equal(normalizeTaxId('869751876B01'), '869751876B01');
  assert.equal(normalizeTaxId(null), '');
});

test('IBAN: suma kontrolna; NRB bez PL dostaje kod kraju', () => {
  assert.equal(isValidIban('PL91 1910 1048 2793 2107 1341 0001'), true);
  assert.equal(isValidIban('56 1050 1559 1000 0090 3311 9588'), true);
  // Konto PLN z dawnej formatki HKL — zła suma kontrolna
  assert.equal(isValidIban('PL64 1910 1048 2793 2107 1341 0001'), false);
  assert.equal(formatIban('56105015591000009033119588'), 'PL56 1050 1559 1000 0090 3311 9588');
});

test('konto: faktura HKL → z pliku po NIP; spoza pliku → domyślne; inny wystawca → nic', () => {
  const hkl = (buyer, issuer = { issuerType: 'manufacturer', issuerId: 0 }) => hklPaymentAccount({ ...issuer, buyer }, TABLE);
  assert.deepEqual(hkl({ vatEuId: 'NL869751876B01' }), { bankName: 'ING BANK ŚLĄSKI S.A.', iban: 'PL34 1050 1559 1000 0090 3311 9596', swift: 'INGBPLPW', matched: true });
  assert.equal(hkl({ taxId: 'PL 851-319-43-09' }, { issuerType: 'organization', issuerId: HKL_ORG_ID }).iban, 'PL56 1050 1559 1000 0090 3311 9588');
  assert.deepEqual(hkl({ name: 'MaizonCozy B.V.', vatEuId: 'NL866455139B01' }), { ...DEFAULT_ACCOUNT, matched: false });
  assert.equal(hklPaymentAccount({ issuerType: 'organization', issuerId: 1, buyer: { vatEuId: 'NL869751876B01' } }, TABLE), null);
});

test('ostrzeżenie tylko dla nabywcy HKL spoza pliku', () => {
  const missing = withPaymentAccountWarning({ warnings: ['inne'] }, { issuerType: 'manufacturer', buyer: { name: 'MaizonCozy B.V.', vatEuId: 'NL866455139B01' } }, TABLE);
  assert.equal(missing.warnings.length, 2);
  assert.match(missing.warnings[1], /MaizonCozy B\.V\. \(NIP NL866455139B01\) bez konta w pliku księgowości.*PL34 1050/);
  assert.deepEqual(withPaymentAccountWarning({ warnings: [] }, { issuerType: 'manufacturer', buyer: { vatEuId: 'NL869751876B01' } }, TABLE).warnings, []);
  assert.deepEqual(withPaymentAccountWarning({ warnings: [] }, { issuerType: 'organization', issuerId: 1, buyer: {} }, TABLE).warnings, []);
});

test('plik danych z księgowości: same poprawne IBAN-y, klucze to znormalizowane NIP-y', () => {
  const { accounts } = require('../data/hkl-contractor-accounts.json');
  const entries = Object.entries(accounts);
  assert.ok(entries.length >= 30);
  for (const [nip, a] of entries) {
    assert.equal(normalizeTaxId(nip), nip, nip);
    assert.equal(isValidIban(a.iban), true, `${a.ident}: ${a.iban}`);
  }
  assert.equal(accounts['869751876B01'].iban, 'PL34 1050 1559 1000 0090 3311 9596'); // Ryver
});

test('contractors.txt: konto z bazy (płatnik/klient) i zapisane w fakturze mają pierwszeństwo przed plikiem po NIP', () => {
  assert.equal(cleanValue(' - '), '');
  assert.deepEqual(accountFromContractor({ bank_name: 'ING BANK ŚLĄSKI S.A.', bank_account: '56 1050 1559 1000 0090 3311 9588', swift: 'INGBPLPW' }),
    { bankName: 'ING BANK ŚLĄSKI S.A.', iban: 'PL56 1050 1559 1000 0090 3311 9588', swift: 'INGBPLPW' });
  assert.equal(accountFromContractor({ bank_name: '-', bank_account: '-', swift: '-' }), null);
  assert.equal(accountFromContractor({ bank_account: 'PL64 1910 1048 2793 2107 1341 0001' }), null, 'zła suma kontrolna');
  const erste = { bankName: 'Erste Bank Polska S.A.', iban: 'PL81 1090 0004 0004 8001 0000 8394', swift: 'WBKPPLPP' };
  const hkl = { issuerType: 'manufacturer', issuerId: 0, buyer: { vatEuId: 'NL869751876B01' } };
  assert.equal(hklPaymentAccount({ ...hkl, contractorAccount: erste }, TABLE).iban, erste.iban);
  assert.equal(hklPaymentAccount({ ...hkl, compliance: { paymentAccount: erste } }, TABLE).iban, erste.iban);
  assert.equal(hklPaymentAccount(hkl, TABLE).iban, 'PL34 1050 1559 1000 0090 3311 9596');
  // Konto z bazy = brak ostrzeżenia, nawet gdy nabywcy nie ma w pliku księgowości
  assert.deepEqual(withPaymentAccountWarning({ warnings: [] }, { issuerType: 'manufacturer', buyer: { vatEuId: 'NL1' }, contractorAccount: erste }, TABLE).warnings, []);
});
