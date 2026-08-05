'use strict';

/**
 * Reguły podatkowe: jaka kategoria i stawka dla danej pary sprzedawca–nabywca.
 *
 * Moduł NIE duplikuje tabeli stawek — korzysta z istniejącego
 * `services/vatCalculator.js` (27 państw UE + CH/NO, z komentarzem skąd stawki).
 * Tutaj siedzi tylko warstwa decyzyjna: krajowa / WDT / reverse charge / eksport,
 * bo faktura wymaga czegoś więcej niż samej liczby — potrzebuje uzasadnienia
 * prawnego drukowanego na dokumencie.
 *
 * @typedef {import('../domain/types').Party} Party
 * @typedef {import('../domain/types').TaxCategoryValue} TaxCategoryValue
 */

const {
  VAT_RATES_BY_COUNTRY,
  EU_MEMBER_COUNTRIES,
  getVatRateForCountry
} = require('../../vatCalculator');
const { TaxCategory, LEGAL_NOTE_KEYS } = require('../domain/constants');

/**
 * Stawki obniżone per kraj — świadomie wąska lista, tylko to, co ta branża
 * realnie stosuje (montaż w budownictwie objętym społecznym programem
 * mieszkaniowym: 8% w PL). PUNKT ROZSZERZENIA: dokładaj kraje/stawki tutaj,
 * a nie w kodzie wywołującym.
 */
const REDUCED_RATES_BY_COUNTRY = Object.freeze({
  PL: 8
});

/**
 * @param {string|null|undefined} country
 * @returns {string} kod kraju ISO alpha-2, wielkimi literami (`''` gdy brak)
 */
function normalizeCountry(country) {
  return String(country || '').trim().toUpperCase().slice(0, 2);
}

/**
 * Czy numer VAT-UE wygląda na poprawny formalnie (prefiks kraju + 2–12 znaków).
 * ⚠️ To jest wyłącznie walidacja FORMATU. Potwierdzenie w VIES to osobna sprawa —
 * podepnij je przez `opts.vatEuVerified` (patrz `resolveTaxTreatment`), bo
 * stawka 0% przy WDT zależy od *zweryfikowanego* numeru, nie od jego kształtu.
 *
 * @param {string|null|undefined} vatEuId
 * @param {string} [expectedCountry]
 * @returns {boolean}
 */
function looksLikeVatEuId(vatEuId, expectedCountry) {
  const value = String(vatEuId || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9A-Z]{2,12}$/.test(value)) return false;
  const prefix = value.slice(0, 2);
  // Grecja w VIES występuje jako EL, nie GR — klasyczna pułapka.
  const country = normalizeCountry(expectedCountry) === 'GR' ? 'EL' : normalizeCountry(expectedCountry);
  if (country && prefix !== country) return false;
  return EU_MEMBER_COUNTRIES.has(prefix === 'EL' ? 'GR' : prefix);
}

/**
 * Rozstrzyga sposób opodatkowania pozycji.
 *
 * Kolejność decyzji (świadoma, odzwierciedla hierarchię przepisów):
 *  1. Sprzedaż krajowa (ten sam kraj) → stawka krajowa; `reduced` gdy pozycja
 *     jest usługą montażu i kraj ma stawkę obniżoną.
 *  2. Nabywca poza UE → eksport, 0%.
 *  3. Sprzedawca i nabywca w UE, RÓŻNE kraje → **0%**: towar jako WDT, usługa
 *     jako odwrotne obciążenie (art. 28b). Decyduje PARA KRAJÓW
 *     (`organization.country` vs `user.country`) — tak jak w istniejącym
 *     `services/vatCalculator.js`, który tę regułę stosuje w całej aplikacji.
 *     ⚠️ Formalnie WDT wymaga ważnego numeru VAT-UE nabywcy. Wynik sprawdzenia
 *     w VIES (`core/vies.js`) zapisujemy na dokumencie jako dowód należytej
 *     staranności, ale NIE warunkuje on stawki. Brak numeru albo brak
 *     potwierdzenia → ostrzeżenie w `notes` (trafia do logu).
 *
 * @param {Object} params
 * @param {Party} params.seller
 * @param {Party} params.buyer
 * @param {Object} [params.opts]
 * @param {boolean} [params.opts.isService]      Pozycja jest usługą (montaż, szycie).
 * @param {boolean} [params.opts.isInstallation] Usługa montażu — kandydat do stawki obniżonej.
 * @param {boolean} [params.opts.vatEuVerified]  Numer VAT-UE nabywcy potwierdzony w VIES.
 * @param {number}  [params.opts.forcedRate]     Ręczne nadpisanie stawki (np. korekta).
 * @returns {{ taxCategory: TaxCategoryValue, taxRate: number, legalNoteKey: string|null, notes: string[] }}
 */
function resolveTaxTreatment({ seller, buyer, opts = {} }) {
  const sellerCountry = normalizeCountry(seller && seller.country);
  const buyerCountry = normalizeCountry(buyer && buyer.country) || sellerCountry;
  const notes = [];

  if (!sellerCountry) {
    notes.push('Brak kraju sprzedawcy — przyjęto stawkę 0% i kategorię "np".');
    return { taxCategory: TaxCategory.NOT_SUBJECT, taxRate: 0, legalNoteKey: LEGAL_NOTE_KEYS[TaxCategory.NOT_SUBJECT], notes };
  }

  if (Number.isFinite(opts.forcedRate)) {
    const rate = Number(opts.forcedRate);
    notes.push(`Stawka nadpisana ręcznie: ${rate}%.`);
    return {
      taxCategory: rate === 0 ? TaxCategory.NOT_SUBJECT : TaxCategory.STANDARD,
      taxRate: rate,
      legalNoteKey: rate === 0 ? LEGAL_NOTE_KEYS[TaxCategory.NOT_SUBJECT] : null,
      notes
    };
  }

  // 1. Krajowa
  if (sellerCountry === buyerCountry) {
    const reduced = REDUCED_RATES_BY_COUNTRY[sellerCountry];
    if (opts.isInstallation && reduced !== undefined) {
      notes.push('Stawka obniżona dla usługi montażu — wymaga spełnienia warunków budownictwa objętego społecznym programem mieszkaniowym.');
      return { taxCategory: TaxCategory.REDUCED, taxRate: reduced, legalNoteKey: null, notes };
    }
    return {
      taxCategory: TaxCategory.STANDARD,
      taxRate: getVatRateForCountry(sellerCountry) ?? VAT_RATES_BY_COUNTRY[sellerCountry] ?? 0,
      legalNoteKey: null,
      notes
    };
  }

  const sellerInEu = EU_MEMBER_COUNTRIES.has(sellerCountry);
  const buyerInEu = EU_MEMBER_COUNTRIES.has(buyerCountry);

  // 2. Poza UE → eksport
  if (!buyerInEu) {
    return { taxCategory: TaxCategory.EXPORT, taxRate: 0, legalNoteKey: LEGAL_NOTE_KEYS[TaxCategory.EXPORT], notes };
  }

  // Sprzedawca spoza UE do UE — nie nasza procedura krajowa
  if (!sellerInEu) {
    notes.push('Sprzedawca spoza UE — transakcja nie podlega VAT w kraju sprzedawcy.');
    return { taxCategory: TaxCategory.NOT_SUBJECT, taxRate: 0, legalNoteKey: LEGAL_NOTE_KEYS[TaxCategory.NOT_SUBJECT], notes };
  }

  // 3. Oba kraje w UE i różne → 0% (WDT dla towaru, odwrotne obciążenie dla usługi)
  const hasVatEu = looksLikeVatEuId(buyer && (buyer.vatEuId || buyer.taxId), buyerCountry);
  if (!hasVatEu) {
    notes.push('Nabywca z UE bez numeru VAT-UE w danych — 0% zastosowane na podstawie różnych krajów sprzedawcy i nabywcy. Uzupełnij numer VAT-UE, żeby udokumentować prawo do stawki 0%.');
  } else if (opts.vatEuVerified === false) {
    notes.push('Numeru VAT-UE nabywcy nie potwierdzono w VIES — 0% zastosowane na podstawie pary krajów. Zweryfikuj numer, żeby mieć dowód należytej staranności.');
  }

  return opts.isService
    ? { taxCategory: TaxCategory.INTRA_EU_SERVICE, taxRate: 0, legalNoteKey: LEGAL_NOTE_KEYS[TaxCategory.INTRA_EU_SERVICE], notes }
    : { taxCategory: TaxCategory.INTRA_EU_GOODS, taxRate: 0, legalNoteKey: LEGAL_NOTE_KEYS[TaxCategory.INTRA_EU_GOODS], notes };
}

/**
 * Czy para krajów daje transakcję wewnątrzwspólnotową ze stawką 0%.
 * Wydzielone, bo tej samej odpowiedzi potrzebuje UI panelu („ta faktura wyjdzie
 * 0% — WDT") bez liczenia całego dokumentu.
 *
 * @param {string} sellerCountry
 * @param {string} buyerCountry
 * @returns {boolean}
 */
function isIntraEuZeroRate(sellerCountry, buyerCountry) {
  const s = normalizeCountry(sellerCountry);
  const b = normalizeCountry(buyerCountry);
  if (!s || !b || s === b) return false;
  return EU_MEMBER_COUNTRIES.has(s) && EU_MEMBER_COUNTRIES.has(b);
}

module.exports = {
  REDUCED_RATES_BY_COUNTRY,
  normalizeCountry,
  looksLikeVatEuId,
  isIntraEuZeroRate,
  resolveTaxTreatment
};
