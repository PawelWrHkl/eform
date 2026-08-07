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
 *   poziom 1  producent/HKL → organizacja        → ceny BAZOWE
 *   poziom 2  organizacja = HKL → użytkownik     → ceny BAZOWE (HKL sprzedaje bezpośrednio)
 *   poziom 2  organizacja ≠ HKL → użytkownik     → ceny SUB
 *   poziom 4  organizacja = HKL → odb. końcowy   → ceny BAZOWE
 *   poziom 4  organizacja ≠ HKL → odb. końcowy   → ceny SUB
 *   poziom 3  użytkownik → odbiorca końcowy      → patrz ograniczenie niżej
 *
 * ⚠️ OGRANICZENIE poziomu 3: system nie przechowuje ceny detalicznej salonu.
 * Dokument dla odbiorcy końcowego wychodzi więc po cenie, po której salon sam
 * kupuje (SUB, gdy jego organizacja ≠ HKL; bazowa, gdy kupuje wprost od HKL).
 * Marża salonu wymagałaby osobnej warstwy cenowej, której w danych nie ma.
 */

const { HKL_ORG_ID } = require('../../subPrices');
const { InvoiceLevel, IssuerType } = require('./hierarchy');

/** Nazwy warstw cenowych — trafiają na dokument i do kolumny `invoice.price_basis`. */
const PriceBasis = Object.freeze({
  BASE: 'base',
  SUB: 'sub'
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
 * @returns {{ basis: string, useSubPrices: boolean, reason: string }}
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
      basis: PriceBasis.BASE,
      useSubPrices: false,
      reason: 'Sprzedaż producenta/HKL do organizacji — ceny bazowe (CENA/DOPLATA/RABAT)'
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
      reason: 'Organizacja inna niż HKL sprzedaje bezpośrednio odbiorcy końcowemu — ceny SUB___'
    };
  }

  // Poziom 3: brak warstwy detalicznej — bierzemy cenę zakupu salonu
  if (isHklOrganization(organizationId)) {
    return {
      basis: PriceBasis.BASE,
      useSubPrices: false,
      reason: 'Salon kupuje wprost od HKL — dokument dla odbiorcy końcowego po cenach bazowych (brak warstwy detalicznej w danych)'
    };
  }
  return {
    basis: PriceBasis.SUB,
    useSubPrices: true,
    reason: 'Salon kupuje po cenach SUB___ — dokument dla odbiorcy końcowego po tych samych cenach (brak warstwy detalicznej w danych)'
  };
}

module.exports = { PriceBasis, HKL_ORG_ID, isHklOrganization, resolvePriceBasis };
