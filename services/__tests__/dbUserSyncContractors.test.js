'use strict';

/**
 * contractors.txt z 19.11.2026 (Tomek): COUNTRY zamiast KRAJ, EMAIL, PAYMASTER_IDENT, BANK_NAME,
 * BANK_ACCOUNT, SWIFT — synchronizacja aktualizuje wszystkie pola (Paweł), pusty email nie kasuje bazy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareClients, parseClients, EXTRA_FIELDS } = require('../dbUserSync');

test('plik: COUNTRY albo dawne KRAJ → country; właściciel → organizacja', () => {
  const [nowy, stary] = parseClients([
    { IDENT: 'Ryver', COUNTRY: 'NL', OWNER: 'HKL', PAYMASTER_IDENT: '-', BANK_ACCOUNT: 'PL34 1050 1559 1000 0090 3311 9596' },
    { IDENT: 'X', KRAJ: 'DE', OWNER: 'LUXANGMBH' }
  ]);
  assert.equal(nowy.country, 'NL');
  assert.equal(nowy.organization_id, 3);
  assert.equal(nowy.bank_account, 'PL34 1050 1559 1000 0090 3311 9596');
  assert.equal(stary.country, 'DE');
  assert.equal(stary.kraj, undefined);
  assert.equal(stary.organization_id, 5);
});

test('porównanie: email, kraj, płatnik i bank do aktualizacji; „-” w emailu nie kasuje bazy; bez migracji pola pomijane', () => {
  const plik = [
    { pin: '1', ident: 'TCN', name: 'TCN', email: 'nowy@tcn.nl', country: 'NL', paymaster_ident: 'TCN_RECH', bank_name: '-', bank_account: '-', swift: '-', password: 'p' },
    { pin: '2', ident: 'TCN_RECH', name: 'TCN B.V.', email: '-', country: 'NL', paymaster_ident: '-', bank_name: 'ING BANK ŚLĄSKI S.A.', bank_account: 'PL34 1050 1559 1000 0090 3311 9596', swift: 'INGBPLPW', password: 'p' }
  ];
  const baza = [
    { pin: '1', ident: 'TCN', name: 'TCN', email: 'stary@tcn.nl', country: 'NL', paymaster_ident: null, bank_name: null, bank_account: null, swift: null, password: 'p' },
    { pin: '2', ident: 'TCN_RECH', name: 'TCN B.V.', email: 'faktury@tcn.nl', country: 'nl', paymaster_ident: '-', bank_name: '-', bank_account: '-', swift: '-', password: 'p' }
  ];
  const diff = compareClients(plik, baza, { extraFields: EXTRA_FIELDS });
  const byIdent = Object.fromEntries(diff.toUpdate.map((u) => [u.ident, u.changes]));
  assert.deepEqual(byIdent.TCN, { email: 'nowy@tcn.nl', paymaster_ident: 'TCN_RECH', bank_name: '-', bank_account: '-', swift: '-' });
  assert.deepEqual(byIdent.TCN_RECH, { country: 'NL', bank_name: 'ING BANK ŚLĄSKI S.A.', bank_account: 'PL34 1050 1559 1000 0090 3311 9596', swift: 'INGBPLPW' });
  // Bez kolumn w bazie (kod przed migracją) — nowe pola nie wchodzą do UPDATE
  const bez = compareClients(plik, baza);
  assert.ok(bez.toUpdate.every((u) => !Object.keys(u.changes).some((k) => EXTRA_FIELDS.includes(k))));
});

test('INVOICE_EMAIL (Wiktoria 19.11.2026): adres do faktur → invoice_email; plik bez kolumny niczego nie kasuje', () => {
  const baza = [{ pin: '1', ident: 'Golser', name: 'G', email: 'login@golser.at', country: 'AT', invoice_email: 'rechnung@golser.at', password: 'p' }];
  const nowy = compareClients([{ pin: '1', ident: 'Golser', name: 'G', email: 'login@golser.at', country: 'AT', invoice_email: 'buchhaltung@golser.at', password: 'p' }], baza, { extraFields: ['invoice_email'] });
  assert.deepEqual(nowy.toUpdate[0].changes, { invoice_email: 'buchhaltung@golser.at' });
  // Starszy plik (bez kolumny) — nic do zmiany, adres w bazie zostaje
  const stary = compareClients([{ pin: '1', ident: 'Golser', name: 'G', email: 'login@golser.at', country: 'AT', password: 'p' }], baza, { extraFields: ['invoice_email'] });
  assert.equal(stary.toUpdate.length, 0);
});

test('PAYMENT_DAYS (Paweł 20.11.2026): liczba dni → payment_days, „-”/puste = NULL; plik bez kolumny i baza bez kolumny niczego nie ruszają', () => {
  const [z60, kreska, pusty, bez] = parseClients([
    { IDENT: 'Cozy', OWNER: 'COZY', PAYMENT_DAYS: ' 060 ' },
    { IDENT: 'A', OWNER: 'HKL', PAYMENT_DAYS: '-' },
    { IDENT: 'B', OWNER: 'HKL', PAYMENT_DAYS: '' },
    { IDENT: 'C', OWNER: 'HKL' }
  ]);
  assert.deepEqual([z60.payment_days, kreska.payment_days, pusty.payment_days, bez.payment_days], ['60', '', '', undefined]);

  const baza = [
    { pin: '1', ident: 'Cozy', name: 'C', password: 'p', payment_days: 14 },
    { pin: '2', ident: 'A', name: 'A', password: 'p', payment_days: 30 },
    { pin: '3', ident: 'B', name: 'B', password: 'p', payment_days: null },
    { pin: '4', ident: 'C', name: 'C', password: 'p', payment_days: 60 }
  ];
  const plik = [
    { pin: '1', ident: 'Cozy', name: 'C', password: 'p', payment_days: '60' },
    { pin: '2', ident: 'A', name: 'A', password: 'p', payment_days: '' },
    { pin: '3', ident: 'B', name: 'B', password: 'p', payment_days: '' },
    { pin: '4', ident: 'C', name: 'C', password: 'p' }
  ];
  const diff = compareClients(plik, baza, { extraFields: ['payment_days'] });
  assert.deepEqual(Object.fromEntries(diff.toUpdate.map((u) => [u.ident, u.changes])), { Cozy: { payment_days: '60' }, A: { payment_days: '' } },
    'liczba z bazy porównana jako tekst; puste w pliku czyści (NULL), plik bez kolumny nie kasuje 60');
  // Baza bez migracji: `supportsContractorExtras` nie zwraca payment_days — pole nie trafia do UPDATE
  assert.equal(compareClients(plik, baza, { extraFields: ['invoice_email'] }).toUpdate.length, 0);
});
