'use strict';

/**
 * Kontekst prawno-podatkowy faktury dla PL, DE, NL i FR.
 *
 * Buduje strukturę, którą szablon (`templates/partials/tax_compliance.njk`)
 * drukuje bez żadnej logiki: jakie numery rejestrowe pokazać, jakie klauzule są
 * obowiązkowe, czy wymagana jest data dostawy, czy trzeba podać VAT w walucie
 * krajowej.
 *
 * ⚠️ Wymogi są **kraju WYSTAWCY** — to jego prawo określa treść faktury. Kraj
 * nabywcy wpływa tylko na to, czy transakcja jest krajowa / WDT / eksport
 * (o tym decyduje `core/taxRules.js`), a więc które klauzule się aktywują.
 *
 * ⚠️ Teksty klauzul są zapisane wprost w oryginalnym języku prawnym (niemiecka
 * faktura musi mieć niemieckie brzmienie „Steuerfreie innergemeinschaftliche
 * Lieferung", nawet gdy reszta dokumentu jest po polsku), dlatego NIE idą przez
 * i18n. To celowe: tłumaczenie tych fraz zmieniłoby ich skutek prawny.
 *
 * @typedef {import('../domain/types').Party} Party
 * @typedef {import('../domain/types').TaxCategoryValue} TaxCategoryValue
 */

const { TaxCategory } = require('../domain/constants');

/**
 * Definicje numerów rejestrowych per kraj: klucz w `registry_numbers`,
 * etykieta drukowana na dokumencie, czy wymagany.
 */
const REGISTRY_FIELDS = Object.freeze({
  PL: [
    { key: 'NIP', label: 'NIP', required: true, fromTaxId: true },
    { key: 'REGON', label: 'REGON', required: false }
  ],
  DE: [
    { key: 'STEUERNUMMER', label: 'Steuernummer', required: false },
    { key: 'USTIDNR', label: 'USt-IdNr.', required: true, fromVatEu: true }
  ],
  NL: [
    { key: 'KVK', label: 'KVK-nummer', required: true },
    { key: 'BTW', label: 'Btw-identificatienummer', required: true, fromVatEu: true }
  ],
  FR: [
    { key: 'SIREN', label: 'N° SIREN', required: true },
    { key: 'SIRET', label: 'N° SIRET', required: false },
    { key: 'NAF', label: 'Code NAF/APE', required: false },
    { key: 'TVA', label: 'N° TVA intracommunautaire', required: true, fromVatEu: true }
  ],
  AT: [
    { key: 'UID', label: 'UID-Nr.', required: true, fromVatEu: true }
  ]
});

/**
 * Kraj spoza tabeli (DK, CH, BE…) — neutralny numer VAT. Wcześniej działał tu
 * fallback na PL, więc np. austriacki nabywca dostawał „NIP: ATU44756402"
 * (2026-10-22). PL zostaje tylko dla pustego kraju.
 */
const GENERIC_REGISTRY_FIELDS = Object.freeze([
  { key: 'VAT', label: 'VAT ID', required: false, fromVatEu: true }
]);

/** Stawki VAT drukowane w podsumowaniu — kolejność ma znaczenie na dokumencie. */
const RATE_TABLES = Object.freeze({
  PL: { label: 'VAT', rates: ['23%', '8%', '5%', '0%', 'zw.', 'np.'] },
  DE: { label: 'USt.', rates: ['19%', '7%', '0%'] },
  NL: { label: 'BTW', rates: ['21%', '9%', '0%'] },
  FR: { label: 'TVA', rates: ['20%', '10%', '5,5%', '2,1%', '0%'] }
});

/**
 * Klauzule per kraj wystawcy. Każda ma warunek aktywacji zależny od kategorii
 * podatkowej albo od ustawień podmiotu (`legalSettings`).
 * `text` jest w języku prawnym kraju — patrz komentarz na górze pliku.
 */
const CLAUSES = Object.freeze({
  PL: [
    {
      id: 'pl_wdt',
      text: 'Wewnątrzwspólnotowa dostawa towarów — stawka 0% (art. 42 ustawy o VAT).',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_GOODS)
    },
    {
      id: 'pl_reverse_charge',
      text: 'Odwrotne obciążenie — podatek rozlicza nabywca (art. 28b ustawy o VAT).',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_SERVICE)
    },
    {
      id: 'pl_export',
      text: 'Eksport towarów — stawka 0% (art. 41 ust. 4 ustawy o VAT).',
      when: ({ categories }) => categories.has(TaxCategory.EXPORT)
    },
    {
      id: 'pl_split_payment',
      text: 'Mechanizm podzielonej płatności.',
      // Obowiązkowa adnotacja przy sprzedaży towarów z załącznika 15 powyżej
      // 15 000 zł brutto. Moduł nie zna klasyfikacji towarów, więc decyzję
      // podejmuje wystawca ustawieniem `split_payment` w profilu.
      when: ({ legalSettings, domestic }) => domestic && legalSettings.split_payment === true
    },
    {
      id: 'pl_exempt',
      text: 'Sprzedaż zwolniona z VAT.',
      when: ({ categories }) => categories.has(TaxCategory.EXEMPT)
    }
  ],
  DE: [
    {
      id: 'de_wdt',
      text: 'Steuerfreie innergemeinschaftliche Lieferung.',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_GOODS)
    },
    {
      id: 'de_reverse_charge',
      text: 'Steuerschuldnerschaft des Leistungsempfängers.',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_SERVICE)
    },
    {
      id: 'de_export',
      text: 'Steuerfreie Ausfuhrlieferung.',
      when: ({ categories }) => categories.has(TaxCategory.EXPORT)
    },
    {
      id: 'de_kleinunternehmer',
      text: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).',
      when: ({ legalSettings }) => legalSettings.kleinunternehmer === true
    }
  ],
  NL: [
    {
      id: 'nl_wdt',
      text: 'Intracommunautaire levering — 0% btw (art. 138 Btw-richtlijn).',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_GOODS)
    },
    {
      id: 'nl_reverse_charge',
      text: 'Btw verlegd naar de afnemer.',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_SERVICE)
    },
    {
      id: 'nl_export',
      text: 'Uitvoer buiten de EU — 0% btw.',
      when: ({ categories }) => categories.has(TaxCategory.EXPORT)
    }
  ],
  FR: [
    {
      id: 'fr_wdt',
      text: 'Livraison intracommunautaire exonérée de TVA (art. 262 ter I du CGI).',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_GOODS)
    },
    {
      id: 'fr_reverse_charge',
      text: 'Autoliquidation de la TVA par le preneur (art. 283-2 du CGI).',
      when: ({ categories }) => categories.has(TaxCategory.INTRA_EU_SERVICE)
    },
    {
      id: 'fr_export',
      text: 'Exportation exonérée de TVA (art. 262 I du CGI).',
      when: ({ categories }) => categories.has(TaxCategory.EXPORT)
    },
    {
      id: 'fr_vat_exempt_293b',
      text: 'TVA non applicable, art. 293 B du CGI.',
      when: ({ legalSettings }) => legalSettings.vat_exempt_293b === true
    },
    {
      id: 'fr_late_penalty',
      // Wskaźnik kary za opóźnienie jest OBOWIĄZKOWY na fakturze francuskiej;
      // stawka pochodzi z ustawień podmiotu, bo zależy od umowy (domyślnie
      // ustawowa stopa BCE + 10 pkt proc.).
      text: null,
      textFrom: ({ legalSettings }) => `Taux des pénalités de retard : ${legalSettings.late_penalty_rate || 'taux BCE + 10 points'}.`,
      when: () => true
    },
    {
      id: 'fr_recovery_indemnity',
      text: 'Indemnité forfaitaire pour frais de recouvrement : 40 €.',
      when: () => true
    }
  ]
});

/**
 * Czy kraj wystawcy wymaga daty dostawy/usługi na dokumencie.
 * DE: `Leistungsdatum` jest obowiązkowe (§ 14 Abs. 4 UStG).
 */
const DELIVERY_DATE_REQUIRED = Object.freeze({ PL: false, DE: true, NL: false, FR: false });

/** Język, w którym brzmią klauzule kraju wystawcy (`CLAUSES`). */
const CLAUSE_LANGUAGE = Object.freeze({ PL: 'pl', DE: 'de', NL: 'nl', FR: 'fr' });

/**
 * Klauzule, które powtarzają adnotację z podsumowania VAT (`legal.*` w języku
 * dokumentu, z artykułem dyrektywy 2006/112/WE — art. 226 pkt 11 dopuszcza takie
 * odesłanie): WDT, odwrotne obciążenie, eksport, zwolnienie.
 */
const CLAUSES_COVERED_BY_LEGAL_NOTE = new Set([
  'pl_wdt', 'pl_reverse_charge', 'pl_export', 'pl_exempt',
  'de_wdt', 'de_reverse_charge', 'de_export',
  'nl_wdt', 'nl_reverse_charge', 'nl_export',
  'fr_wdt', 'fr_reverse_charge', 'fr_export'
]);

/**
 * Klauzule do wydruku w danym języku dokumentu. Od 2026-10-23 faktura jest w języku
 * KLIENTA (`core/language.js`), a klauzule zapisane na dokumencie brzmią w języku
 * kraju wystawcy — powtórzenia adnotacji VAT drukujemy więc tylko wtedy, gdy oba
 * języki się zgadzają; w pozostałych podstawa jest już w adnotacji, w języku klienta
 * (inaczej np. faktura dla holenderskiego klienta HKL miałaby zdanie po polsku).
 * Klauzule bez odpowiednika (podzielona płatność, Kleinunternehmer, kary FR) zostają.
 * Liczone przy wydruku — działa także dla dokumentów wystawionych wcześniej.
 *
 * @param {{ sellerCountry?: string, clauses?: Array<{ id: string, text: string }> }|null|undefined} context  `invoice.compliance`
 * @param {string} lang  język dokumentu
 * @returns {Array<{ id: string, text: string }>}
 */
function visibleClauses(context, lang) {
  const clauses = context && Array.isArray(context.clauses) ? context.clauses : [];
  if (CLAUSE_LANGUAGE[normalize(context && context.sellerCountry)] === lang) return clauses;
  return clauses.filter((clause) => !CLAUSES_COVERED_BY_LEGAL_NOTE.has(clause.id));
}

/**
 * @param {string|null|undefined} country
 * @returns {string}
 */
function normalize(country) {
  return String(country || '').trim().toUpperCase().slice(0, 2);
}

/**
 * Numery rejestrowe do wydruku dla danej strony.
 *
 * Uzupełnia braki z pól ogólnych: `NIP` z `taxId`, numery VAT-UE (`USt-IdNr.`,
 * `Btw-id`, `N° TVA`) z `vatEuId` — dzięki temu wystawca, który wypełnił tylko
 * standardowe pola, dostaje poprawny nagłówek bez dodatkowej konfiguracji.
 *
 * ⚠️ `missing` (a więc i ostrzeżenie) wyliczamy WYŁĄCZNIE dla wystawcy
 * (`asSeller`). Numery rejestrowe nabywcy są informacją, nie obowiązkiem
 * wystawcy: francuska faktura nie musi podawać SIREN kontrahenta, a przy
 * transakcji wewnątrzwspólnotowej i tak liczy się jego numer VAT — o którego
 * brak ostrzega już `core/taxRules.js`. Bez tego rozróżnienia panel zalewały
 * ostrzeżenia o „brakujących" numerach, których nikt nie ma obowiązku znać.
 *
 * @param {Party & { registry?: Record<string, string> }} party
 * @param {string} country Kraj, którego wymogi stosujemy.
 * @param {{ asSeller?: boolean }} [opts]
 * @returns {Array<{ key: string, label: string, value: string, required: boolean, missing: boolean }>}
 */
function buildRegistryRows(party, country, opts = {}) {
  const code = normalize(country);
  const fields = REGISTRY_FIELDS[code] || (code ? GENERIC_REGISTRY_FIELDS : REGISTRY_FIELDS.PL);
  const registry = (party && party.registry) || {};

  return fields.map((field) => {
    let value = registry[field.key] || '';
    if (!value && field.fromTaxId) value = party?.taxId || '';
    if (!value && field.fromVatEu) value = party?.vatEuId || party?.taxId || '';
    return {
      key: field.key,
      label: field.label,
      value: String(value || ''),
      required: !!field.required,
      missing: !!opts.asSeller && !!field.required && !value
    };
  });
}

/**
 * Pełny kontekst zgodności dokumentu.
 *
 * @param {Object} params
 * @param {Party} params.seller
 * @param {Party} params.buyer
 * @param {Array<{ taxCategory: TaxCategoryValue, taxRate: number }>} params.taxLines
 * @param {Record<string, any>} [params.legalSettings] `legal_settings` z profilu wystawcy.
 * @param {string} [params.currency]
 * @param {string} [params.localCurrency]
 * @param {string} [params.deliveryDate] `YYYY-MM-DD`
 * @returns {{
 *   sellerCountry: string, buyerCountry: string, domestic: boolean,
 *   rateTable: { label: string, rates: string[] },
 *   sellerRegistry: Array<Object>, buyerRegistry: Array<Object>,
 *   clauses: Array<{ id: string, text: string }>,
 *   requiresDeliveryDate: boolean, deliveryDate: string|null,
 *   requiresLocalVatAmount: boolean, warnings: string[]
 * }}
 */
function buildComplianceContext({ seller, buyer, taxLines, legalSettings = {}, currency, localCurrency, deliveryDate }) {
  const sellerCountry = normalize(seller && seller.country) || 'PL';
  const buyerCountry = normalize(buyer && buyer.country) || sellerCountry;
  const domestic = sellerCountry === buyerCountry;
  const categories = new Set((taxLines || []).map((l) => l.taxCategory));
  const settings = legalSettings || {};
  const warnings = [];

  const definitions = CLAUSES[sellerCountry] || CLAUSES.PL;
  const clauses = definitions
    .filter((clause) => {
      try {
        return clause.when({ categories, legalSettings: settings, domestic, sellerCountry, buyerCountry });
      } catch {
        return false;
      }
    })
    .map((clause) => ({
      id: clause.id,
      text: clause.textFrom ? clause.textFrom({ legalSettings: settings }) : clause.text
    }))
    .filter((clause) => !!clause.text);

  const sellerRegistry = buildRegistryRows(seller, sellerCountry, { asSeller: true });
  // Numery nabywcy pokazujemy w formacie wymaganym w JEGO kraju — kontrahent
  // niemiecki ma na fakturze „USt-IdNr.", nawet jeśli wystawca jest z Polski.
  // Puste wiersze odfiltrowujemy: pusta etykieta na dokumencie wygląda na błąd.
  const buyerRegistry = buildRegistryRows(buyer, buyerCountry).filter((row) => !!row.value);

  for (const row of sellerRegistry) {
    if (row.missing) warnings.push(`Brak wymaganego numeru ${row.label} sprzedawcy (kraj ${sellerCountry}).`);
  }

  const requiresDeliveryDate = !!DELIVERY_DATE_REQUIRED[sellerCountry];
  if (requiresDeliveryDate && !deliveryDate) {
    warnings.push(`Faktura wystawcy z ${sellerCountry} wymaga daty dostawy/usługi (Leistungsdatum).`);
  }

  // Polska: przy fakturze w walucie obcej kwota VAT musi być podana też w PLN
  const requiresLocalVatAmount = sellerCountry === 'PL' && !!currency && !!localCurrency && currency !== localCurrency;

  return {
    sellerCountry,
    buyerCountry,
    domestic,
    rateTable: RATE_TABLES[sellerCountry] || RATE_TABLES.PL,
    sellerRegistry,
    buyerRegistry,
    clauses,
    requiresDeliveryDate,
    deliveryDate: deliveryDate || null,
    requiresLocalVatAmount,
    warnings
  };
}

module.exports = {
  REGISTRY_FIELDS,
  RATE_TABLES,
  CLAUSES,
  DELIVERY_DATE_REQUIRED,
  buildRegistryRows,
  buildComplianceContext,
  visibleClauses
};
