/**
 * Administracja użytkownikami (`/admin/users`) — zapytania.
 *
 * Osobny plik, a nie dopisek do `db/admin/users.js`, bo tamten moduł obsługuje
 * logowanie i rejestrację; edycja ustawień konta ma inny zakres kolumn i inne
 * ryzyko, więc trzyma się we własnym pliku.
 */

const bcrypt = require('bcryptjs');
const { selectQuery, updateQuery, insertQuery } = require('../core');
const { POLA } = require('../../services/admin/userAdminService');

/** Kolumny pokazywane w panelu (bez `password`, bez `plain`). */
const KOLUMNY_PODGLADU = `
    u.id, u.pin, u.ident, u.client_name, u.email, u.phone, u.role,
    u.intro_needed, u.ab_type, u.ab_lang, u.delivery_delay, u.client_ab,
    u.organization_id, o.ident AS organization_ident
`;

/**
 * Wyszukiwanie użytkownika do edycji.
 *
 * ⚠️ Lista `user` ma prawie 2000 wierszy, więc panel NIE ładuje jej całej —
 * wybór idzie przez wyszukiwanie po identyfikatorze, PIN-ie, nazwie lub mailu.
 *
 * @param {string} q fraza szukana
 * @param {number} [limit]
 * @returns {Promise<Array<Object>>}
 */
async function searchUsers(q, limit = 30) {
  const fraza = `%${String(q || '').trim()}%`;
  const sql = `
        SELECT ${KOLUMNY_PODGLADU}
        FROM \`user\` u
        LEFT JOIN organization o ON o.id = u.organization_id
        WHERE u.ident LIKE ? OR u.pin LIKE ? OR u.client_name LIKE ? OR u.email LIKE ?
        ORDER BY u.ident
        LIMIT ?
    `;
  const rows = await selectQuery(sql, [fraza, fraza, fraza, fraza, Number(limit)]);
  return rows || [];
}

/**
 * @param {number|string} userId
 * @returns {Promise<Object|null>}
 */
async function getUserForAdmin(userId) {
  const sql = `
        SELECT ${KOLUMNY_PODGLADU}
        FROM \`user\` u
        LEFT JOIN organization o ON o.id = u.organization_id
        WHERE u.id = ?
    `;
  const rows = await selectQuery(sql, [userId]);
  return (rows && rows[0]) || null;
}

/**
 * Zapis ustawień konta.
 *
 * ⚠️ Nazwy kolumn wchodzą do SQL-a przez interpolację (inaczej nie da się
 * zbudować dynamicznego `SET`), więc każdy klucz jest wcześniej przefiltrowany
 * przez białą listę `POLA`. Klucz spoza listy jest błędem programisty i ma
 * wysadzić zapis, a nie trafić do zapytania.
 *
 * @param {number|string} userId
 * @param {Record<string, any>} values wynik `normalizeUserSettings`
 * @returns {Promise<Object>}
 */
async function updateUserSettings(userId, values) {
  const klucze = Object.keys(values).filter((k) => POLA.includes(k));
  const odrzucone = Object.keys(values).filter((k) => !POLA.includes(k));
  if (odrzucone.length) {
    throw new Error(`Próba zapisu kolumn spoza białej listy: ${odrzucone.join(', ')}`);
  }
  if (!klucze.length) throw new Error('Brak danych do aktualizacji');

  const sql = `UPDATE \`user\` SET ${klucze.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`;
  return updateQuery(sql, [...klucze.map((k) => values[k]), userId]);
}

/**
 * Ustawienie nowego hasła.
 *
 * Hash `bcrypt` z tym samym kosztem 12, co przy zakładaniu konta
 * (`db/admin/users.js`), żeby logowanie działało identycznie.
 *
 * ⚠️ Czyścimy przy okazji kolumnę `plain`. Trzymała ona jawne hasła z dawnej
 * synchronizacji kontrahentów (wywołanie `updatePlain` jest dziś zakomentowane
 * w `services/dbUserSync.js`) i po zmianie hasła jej treść byłaby po prostu
 * nieprawdziwa — a nieaktualne jawne hasło w bazie jest gorsze niż jego brak.
 *
 * ⚠️ Aktualizujemy też `usrtblpsswd`. To z tej tabeli (a nie z `user`) czyta
 * ekran `/user/org-pwd`, na którym owner i admin podglądają hasła swoich
 * użytkowników i wysyłają je mailem. Bez tego zapisu ekran pokazywałby po
 * zmianie STARE hasło, czyli wprost wprowadzał w błąd. Trzymanie tam jawnego
 * hasła to istniejąca konstrukcja aplikacji, nie nasz wynalazek.
 *
 * @param {number|string} userId
 * @param {string} plainPassword
 * @returns {Promise<Object>}
 */
async function setUserPassword(userId, plainPassword) {
  const hash = bcrypt.hashSync(plainPassword, 12);
  const result = await updateQuery(
    'UPDATE `user` SET password = ?, plain = NULL WHERE id = ?',
    [hash, userId]
  );
  if (!result) return result;

  const user = await getUserForAdmin(userId);
  if (user && user.ident) {
    await zapiszHasloWLustrze(user.ident, user.pin, plainPassword);
  }
  return result;
}

/**
 * Odświeżenie hasła w `usrtblpsswd` (podglądowa tabela dla `/user/org-pwd`).
 *
 * ⚠️ Nie używamy tu `updatePasswordInUsrtblpsswd` z `db/users.js`: tamten
 * zapytanie pomija kolumnę `pin`, która jest `NOT NULL` bez wartości
 * domyślnej, więc insert kończy się błędem `ER_NO_DEFAULT_FOR_FIELD`
 * (a `insertQuery` ten błąd zjada i zwraca `false` — dlatego usterka nie
 * była widoczna). Podajemy `pin` jawnie.
 *
 * @param {string} ident
 * @param {string} pin
 * @param {string} plainPassword
 * @returns {Promise<any>}
 */
async function zapiszHasloWLustrze(ident, pin, plainPassword) {
  const sql = `
        INSERT INTO usrtblpsswd (ident, pin, password) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE password = VALUES(password), pin = VALUES(pin)
    `;
  return insertQuery(sql, [ident, pin, plainPassword]);
}

module.exports = { searchUsers, getUserForAdmin, updateUserSettings, setUserPassword };
