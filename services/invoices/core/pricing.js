'use strict';

/**
 * Dobór warstwy cenowej dla dokumentu — która kwota z pozycji zamówienia jest
 * ceną sprzedaży w danej relacji handlowej.
 *
 * W eForm każda pozycja niesie DWIE ceny (patrz `services/subPrices.js`):
 *   - **bazowa** (`CENA`, `DOPLATA`, `RABAT` → `order_item.total_price`)
 *     — po tej cenie sprzedaje **HKL** (organizacja matka),
 *   - **SUB** (`SUB___*` → `order_item.total_price_sub`)
 *     — cena w relacji **organizacja (inna niż HKL) → jej użytkownik/salon**.
 *
 * ⚠️ Wybór NIE MOŻE być ręcznym przełącznikiem w formularzu: wynika wprost
 * z tego, kto komu wystawia dokument. Pomyłka to faktura na złą kwotę —
 * realny przykład z bazy: pozycja 7017 ma cenę bazową 181,33 i SUB 887,00.
 *
 * Reguła:
 *   poziom 1  producent/HKL → organizacja        → wartości KATALOGOWE (SUMA_BRUTTO)
 *   poziom 2  organizacja = HKL → użytkownik     → ceny BAZOWE (HKL sprzedaje bezpośrednio)
 *   poziom 2  organizacja ≠ HKL → użytkownik     → ceny SUB
 *   poziom 4  organizacja = HKL → odb. końcowy   → ceny BAZOWE
 *   poziom 4  organizacja ≠ HKL → odb. końcowy   → ceny SUB
 *   poziom 3  użytkownik → odbiorca końcowy      → ceny DETALICZNE + rabat klienta
 *
 * ⚠️ SPROSTOWANIE wcześniejszego założenia: warstwa detaliczna JEST w danych.
 * To wartości „widoczne" zamówienia (`unit_price`/`SUMA_BRUTTO`, a przy cenach
 * SUB widoczne `SUB___` z `json_parameters_desc`) — te same, które sumuje
 * `db.getTotal().visible` i od których `services/getDiscount.js` liczy rabat
 * dla odbiorcy. Wcześniej poziom 3 wystawiał cenę ZAKUPU salonu, czyli jego
 * koszt zamiast ceny sprzedaży.
 */

const { HKL_ORG_ID } = require('../../subPrices');
const { InvoiceLevel, IssuerType } = require('./hierarchy');

/** Nazwy warstw cenowych — trafiają na dokument i do kolumny `invoice.price_basis`. */
const PriceBasis = Object.freeze({
  BASE: 'base',
  SUB: 'sub',
  /**
   * Wartość pozycji z parametru `SUMA_BRUTTO`.
   *
   * ⚠️ NAZWA PARAMETRU JEST MYLĄCA — potwierdzone przez właściciela systemu:
   * mimo słowa „BRUTTO" jest to kwota **NETTO**, bez podatku. Nie wolno od niej
   * odejmować ani do niej doliczać VAT-u; VAT liczy dopiero `core/calculator.js`
   * według stawki z `core/taxRules.js`, tak samo jak dla pozostałych warstw.
   *
   * Merytorycznie to wartość pozycji sprzed rabatu handlowego
   * (`SUMA_BRUTTO = CENA + DOPLATA`), podczas gdy `order_item.total_price` jest
   * już po rabacie. Obowiązuje w relacji producent → organizacja: rabat należy
   * do relacji organizacja ↔ jej klient i nie wpływa na rozliczenie z producentem.
   */
  LIST: 'list',

  /**
   * Cena widoczna dla odbiorcy końcowego (detaliczna) — warstwa, po której
   * salon sprzedaje swojemu klientowi.
   *
   * ⚠️ Do niedawna moduł twierdził, że tej warstwy w danych NIE MA i wystawiał
   * poziom 3 po cenie zakupu salonu. Istnieje: to `order_item.unit_price`
   * (= `SUMA_BRUTTO`) dla organizacji HKL, a dla pozostałych widoczna wartość
   * `SUB___` z `json_parameters_desc` — dokładnie ta, którą sumuje
   * `db.getTotal().visible` / `subPrices.calcSubTotals().subVisible` i od
   * której liczony jest rabat dla odbiorcy w podglądzie zamówienia.
   */
  RETAIL: 'retail'
});

/**
 * @param {number|null|undefined} organizationId
 * @returns {boolean}
 */
function isHklOrganization(organizationId) {
  return organizationId != null && Number(organizationId) === Number(HKL_ORG_ID);
}

/**
 * Która warstwa cenowa obowiązuje w tej relacji.
 *
 * @param {Object} params
 * @param {number} params.level
 * @param {string} params.issuerType    `manufacturer` | `organization` | `user`
 * @param {number} params.issuerId      id organizacji albo użytkownika-wystawcy
 * @param {number} params.organizationId Organizacja, w której kontekście działa zamówienie.
 * @param {boolean} [params.override]   Jawne wymuszenie (`true` = SUB, `false` = bazowe).
 * @returns {{ basis: string, useSubPrices: boolean, useListPrices?: boolean, useRetailPrices?: boolean, reason: string }}
 */
function resolvePriceBasis({ level, issuerType, issuerId, organizationId, override }) {
  if (typeof override === 'boolean') {
    return {
      basis: override ? PriceBasis.SUB : PriceBasis.BASE,
      useSubPrices: override,
      reason: 'Warstwa cenowa wymuszona ręcznie przez wołającego'
    };
  }

  const lvl = Number(level) || InvoiceLevel.ORGANIZATION_TO_USER;

  if (lvl === InvoiceLevel.MANUFACTURER_TO_ORGANIZATION || issuerType === IssuerType.MANUFACTURER) {
    return {
      basis: PriceBasis.LIST,
      useSubPrices: false,
      useListPrices: true,
      reason: 'Sprzedaż producenta/HKL do organizacji — wartości katalogowe z SUMA_BRUTTO (bez rabatu klienta)'
    };
  }

  if (lvl === InvoiceLevel.ORGANIZATION_TO_USER) {
    if (isHklOrganization(issuerId)) {
      return {
        basis: PriceBasis.BASE,
        useSubPrices: false,
        reason: 'HKL sprzedaje bezpośrednio swojemu klientowi — ceny bazowe'
      };
    }
    return {
      basis: PriceBasis.SUB,
      useSubPrices: true,
      useListPrices: false,
      reason: 'Organizacja inna niż HKL sprzedaje swojemu użytkownikowi — ceny SUB___'
    };
  }

  if (lvl === InvoiceLevel.ORGANIZATION_TO_END_CLIENT) {
    // Sprzedaż bezpośrednia organizacji do klienta detalicznego — obowiązuje
    // cennik tej organizacji, czyli ten sam, po którym rozlicza swoje salony.
    if (isHklOrganization(issuerId)) {
      return {
        basis: PriceBasis.BASE,
        useSubPrices: false,
        reason: 'HKL sprzedaje bezpośrednio odbiorcy końcowemu — ceny bazowe'
      };
    }
    return {
      basis: PriceBasis.SUB,
      useSubPrices: true,
      useListPrices: false,
      reason: 'Organizacja inna niż HKL sprzedaje bezpośrednio odbiorcy końcowemu — ceny SUB___'
    };
  }

  // Poziom 3: salon sprzedaje swojemu klientowi po cenie DETALICZNEJ — tej
  // samej, którą klient widzi na zamówieniu i od której liczony jest jego rabat.
  return {
    basis: PriceBasis.RETAIL,
    useSubPrices: false,
    useListPrices: false,
    useRetailPrices: true,
    reason: 'Salon sprzedaje odbiorcy końcowemu po cenach detalicznych (wartości widoczne na zamówieniu), pomniejszonych o rabat klienta'
  };
}

module.exports = { PriceBasis, HKL_ORG_ID, isHklOrganization, resolvePriceBasis };
