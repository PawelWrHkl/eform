const test = require('node:test');
const assert = require('node:assert/strict');

const { isLocallyManagedPassword } = require('../localPassword');

/*
 * Zapora przed nadpisaniem hasła ustawionego w aplikacji przez wartość
 * z `contractors.txt`. Bez niej zmiana hasła z panelu /admin/users żyła do
 * pierwszego wejścia na stronę logowania (tam odpala się `updateClients`).
 */

test('hash bcrypt = hasło zarządzane lokalnie, plik go nie nadpisuje', () => {
  [
    '$2a$12$abcdefghijklmnopqrstuv',
    '$2b$12$abcdefghijklmnopqrstuv',
    '$2y$12$abcdefghijklmnopqrstuv',
    '$2$10$abcdefghijklmnopqrstuv'
  ].forEach((h) => assert.equal(isLocallyManagedPassword(h), true, h));
});

test('jawne hasło z ERP nie jest chronione — synchronizacja działa jak dotąd', () => {
  // Realne wartości z contractors.txt (kolumna PASSWORD).
  ['t06', 'imxbn', '', null, undefined, '$2', 'haslo$2a$12$', '2a$12$xxx']
    .forEach((v) => assert.equal(isLocallyManagedPassword(v), false, String(v)));
});
