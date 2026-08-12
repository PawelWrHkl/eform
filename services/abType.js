/**
 * `user.ab_type` / `user.ab_lang` — tryb i JĘZYK dokumentu
 * (AB = Auftragsbestätigung / potwierdzenie zamówienia) ustawiane per klient.
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
 *
 * ⚠️ Ten plik zawiera WYŁĄCZNIE funkcje czyste (odczyt pojedynczej wartości).
 * Wcześniejsze osłony `orderHidesPrices`/`userAbLang`/`orderClientAb` zostały
 * usunięte celowo: każdy tor wysyłki wołał inny podzbiór, a import czytał je
 * z wiersza `user` bez tych kolumn i reguły cicho nie działały. Zasady składa
 * teraz jedno miejsce — `services/confirmationPolicy.js`.
 */

const { availabeLanguages } = require('../config');
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
 * Język potwierdzenia z `user.ab_lang`.
 *
 * ⚠️ Normalizacja jest konieczna: w bazie wartość zapisana jest WIELKIMI
 * literami (`"NL"`), a aplikacja i pliki tłumaczeń używają małych (`nl`).
 * Wartość poza listą `availabeLanguages` traktujemy jak brak ustawienia —
 * literówka w kolumnie nie może wywalić generowania dokumentu ani wysłać
 * potwierdzenia w nieistniejącym języku.
 *
 * @param {string|null|undefined} abLang wartość kolumny `user.ab_lang`
 * @returns {string|null} kod języka albo `null`, gdy brak/nieznany
 */
function resolveAbLang(abLang) {
  if (!abLang) return null;
  const kod = String(abLang).trim().toLowerCase();
  if (!kod) return null;
  if (!availabeLanguages.includes(kod)) {
    log(`[ab_lang] nieznany język potwierdzenia: ${JSON.stringify(abLang)} — używam domyślnego`);
    return null;
  }
  return kod;
}



/**
 * `user.client_ab` — czy potwierdzenie ma iść WPROST DO KLIENTA.
 *
 * Kolumna jest `tinyint(1)`, więc z bazy przychodzi `0`/`1` (albo `null`).
 * Traktujemy jako włączone tylko jawną prawdę — brak wartości zostawia
 * dotychczasowy tor wysyłki (na organizację).
 *
 * @param {number|boolean|string|null|undefined} value
 * @returns {boolean}
 */
function isClientAb(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const liczba = Number(value);
  return Number.isFinite(liczba) ? liczba === 1 : String(value).trim().toLowerCase() === 'true';
}



module.exports = { isWithoutPrices, resolveAbLang, isClientAb, BEZ_CEN };
