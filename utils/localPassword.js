/**
 * Rozpoznanie hasła zarządzanego lokalnie (w aplikacji), a nie przez ERP.
 *
 * Osobny moduł bez zależności od warstwy bazy, żeby dał się testować —
 * `services/dbUserSync.js` ciąga `db/db_helper.js`, a to tworzy pulę MySQL,
 * która nie pozwala procesowi testowemu się zakończyć.
 */

/**
 * Hash bcrypt (`$2a$`/`$2b$`/`$2y$`) powstaje wyłącznie w kodzie eForma —
 * przy zakładaniu konta i przy zmianie hasła z panelu `/admin/users`.
 * `contractors.txt` trzyma hasła jawnym tekstem, więc hash w bazie oznacza,
 * że właścicielem hasła jest aplikacja i synchronizacja ma go nie ruszać.
 *
 * @param {string|null|undefined} dbPassword wartość kolumny `user.password`
 * @returns {boolean}
 */
function isLocallyManagedPassword(dbPassword) {
  return /^\$2[aby]?\$\d{2}\$/.test(String(dbPassword || ''));
}

module.exports = { isLocallyManagedPassword };
