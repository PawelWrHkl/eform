'use strict';

/**
 * Nazwy parametrów pozycji zamówienia (`order_item.json_parameters`), z których
 * korzysta moduł fakturowania.
 *
 * ⚠️ To są klucze pochodzące z KONFIGURATORA produktu, nie z naszej bazy —
 * mogą się zmienić przy zmianie konfiguracji po stronie produkcji, a wtedy
 * faktury po cichu policzą się z fallbacków (np. wartość 0 albo ilość 1).
 * Trzymanie ich w jednym miejscu sprawia, że taka zmiana to poprawka JEDNEJ
 * linii, a nie polowanie po `core/*`.
 *
 * Konwencja: klucz stałej mówi, CO to jest w języku domeny faktur; wartość to
 * dosłowna nazwa parametru w danych.
 */

/** Klucze parametrów odczytywane z `json_parameters`. */
const OrderParam = Object.freeze({
  /** Liczba sztuk — jedyne źródło ilości na fakturze (żaden produkt nie jest liczony na m²). */
  QUANTITY: 'ILOSC',

  /**
   * Wartość pozycji sprzed rabatu handlowego — cennik katalogowy poziomu 1.
   *
   * ⚠️ NAZWA MYLĄCA: mimo słowa „BRUTTO" jest to kwota **NETTO** (potwierdzone
   * przez właściciela systemu). VAT dolicza dopiero `core/calculator.js`.
   */
  LIST_VALUE: 'SUMA_BRUTTO',

  /** Powierzchnia w m² — dana techniczna konfiguracji, NIE ilość do rozliczenia. */
  AREA: 'POW',
  /** Szerokość w mm — do kolumny „Wymiary". */
  WIDTH_MM: 'SZEROKOSC',
  /** Wysokość w mm — do kolumny „Wymiary". */
  HEIGHT_MM: 'WYSOKOSC'
});

/**
 * Prefiks parametrów warstwy SUB (ceny w relacji organizacja ≠ HKL → jej user).
 * Patrz `services/subPrices.js` i `core/pricing.js`.
 */
const SUB_PARAM_PREFIX = 'SUB___';

/**
 * Odczyt parametru po nazwie z tabeli `OrderParam`.
 * Zwraca `undefined`, gdy parametru nie ma — decyzję o fallbacku podejmuje
 * wołający, bo dla ilości i dla wartości jest ona różna.
 *
 * @param {Record<string, any>} params  sparsowane `json_parameters`
 * @param {string} key                  wartość z `OrderParam`
 * @returns {any}
 */
function readParam(params, key) {
  return params ? params[key] : undefined;
}

module.exports = { OrderParam, SUB_PARAM_PREFIX, readParam };
