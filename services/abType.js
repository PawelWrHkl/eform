/**
 * `user.ab_type` — tryb dokumentu (AB = Auftragsbestätigung / potwierdzenie
 * zamówienia) ustawiany per klient.
 *
 * Na razie obsługujemy jeden tryb: klient, którego potwierdzenie ma być
 * BEZ JAKICHKOLWIEK CEN — bez cen katalogowych, bez cen SUB, bez kwot
 * zablokowanych („złotych"), bez sum i bez rabatu. Zostaje tylko wiersz
 * parametrów pozycji (`row1`).
 *
 * ⚠️ W bazie wartość zapisana jest jako `without_price`, a w wymaganiu
 * pojawiła się jako `without_prices`. Przyjmujemy OBA zapisy (bez rozróżniania
 * wielkości liter i z obcięciem spacji) — literówka przy ręcznym ustawianiu
 * kolumny nie może cicho przywrócić cen na dokumencie klienta.
 */

const { selectQuery } = require('../db/core');
const { log } = require('../utils/logging');

/** Wartości `ab_type` oznaczające dokument bez cen. */
const BEZ_CEN = ['without_prices', 'without_price'];

/**
 * @param {string|null|undefined} abType wartość kolumny `user.ab_type`
 * @returns {boolean}
 */
function isWithoutPrices(abType) {
  if (!abType) return false;
  return BEZ_CEN.includes(String(abType).trim().toLowerCase());
}

/**
 * Czy potwierdzenie dla WŁAŚCICIELA tego zamówienia ma być bez cen.
 *
 * ⚠️ Liczy się właściciel zamówienia, nie osoba klikająca „wyślij": dokument
 * trafia do klienta, a admin czy owner mogą wysyłać w jego imieniu.
 *
 * @param {number|string} orderId
 * @returns {Promise<boolean>}
 */
async function orderHidesPrices(orderId) {
  if (!orderId) return false;
  try {
    const rows = await selectQuery(
      'SELECT u.ab_type FROM `order` o JOIN `user` u ON u.id = o.user_id WHERE o.id = ?',
      [orderId]
    );
    return isWithoutPrices(rows && rows[0] && rows[0].ab_type);
  } catch (err) {
    // Brak informacji nie może wstrzymać wysyłki — logujemy i zostawiamy ceny
    // (zachowanie dotychczasowe), bo to stan wyjątkowy, nie reguła.
    log('[ab_type] nie udało się odczytać trybu dokumentu:', err.message);
    return false;
  }
}

/**
 * Wariant dla znanego już użytkownika (import, korekty) — bez dodatkowego
 * zapytania, gdy wiersz `user` jest pod ręką.
 *
 * @param {{ ab_type?: string }|null} user
 * @returns {boolean}
 */
function userHidesPrices(user) {
  return isWithoutPrices(user && user.ab_type);
}

module.exports = { isWithoutPrices, orderHidesPrices, userHidesPrices, BEZ_CEN };
