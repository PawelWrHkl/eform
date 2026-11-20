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
