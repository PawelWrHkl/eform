'use strict';

/**
 * Mapowanie zamówienia eForm (`order` + `order_item`) na pozycje faktury.
 *
 * To jedyne miejsce w module, które zna schemat zamówień — reszta operuje już na
 * neutralnym modelu z `domain/types.js`. Wymiana źródła danych (import z innego
 * systemu, faktura „z ręki") = napisanie drugiego mappera, bez dotykania rdzenia.
 *
 * ⚠️ Ceny w eForm są **netto** (kolumny `order_item.unit_price` / `total_price`
 * oraz parametry `CENA`/`CENA_SUMA`); pola `WARTOSC_VAT`/`SUMA_BRUTTO` w
 * `json_parameters` są opcjonalne i pojawiają się tylko przy włączonym
 * `features.vat` — moduł ich NIE używa do liczenia podatku, bo VAT na fakturze
 * musi wynikać z reguł `core/taxRules.js`, a nie z wartości zamrożonej w pozycji.
 *
 * ⚠️ Klucze w `json_parameters` są ZAWSZE polskie i kanoniczne (`ILOSC`, `POW`,
 * `SZEROKOSC`) — wariant przetłumaczony leży w `json_parameters_desc`. Dlatego
 * mapper czyta wyłącznie `json_parameters`.
 *
 * @typedef {import('./calculator').RawItem} RawItem
 * @typedef {import('../domain/types').Party} Party
 */

const { Unit } = require('../domain/constants');
const money = require('./money');

/**
 * ⚠️ NIE MA w `json_parameters` flagi „usługa montażu".
 *
 * Parametr `MONTAZ` to **kod sposobu montażu** (rodzaj uchwytu/wspornika), a nie
 * informacja o sprzedaży usługi. Sprawdzone na produkcyjnych danych — rozkład
 * wartości w `order_item`: `297800` (×323), `SPSCH` (×426), `PCV` (×134),
 * `VS2SL` (×107), `MP` (×106), `2` (×987), `307` (×761), `''` (×430).
 * W PDF-ie renderuje się to jako „MONTAŻ: 297800 — Uchwyt uniwersalny EOS".
 *
 * Wcześniejsza heurystyka („MONTAZ niepuste ⇒ usługa") klasyfikowała niemal
 * każdą pozycję jako usługę i przestawiała opodatkowanie z WDT (towar, 0%) na
 * odwrotne obciążenie dla usług — czyli podawała na fakturze zły stan prawny.
 *
 * Dlatego: **każda pozycja zamówienia eForm jest towarem**. Usługę (montaż,
 * szycie, transport) dokłada się jawnie przez `serviceItems` w
 * `InvoiceService.createFromOrder` — decyzja o tym, czy sprzedano usługę,
 * nie może wynikać z odgadywania parametru technicznego.
 */
const GOODS_ONLY_NOTE = 'order_item = towar; usługi dokładane jawnie przez serviceItems';

/** Parametry opisowe wchodzące do opisu pozycji na fakturze, w tej kolejności. */
const DESCRIPTION_KEYS = Object.freeze(['MODEL', 'KOLOR', 'KOLOR_SYSTE', 'STEROWANIE', 'FUNKCJA']);

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return /** @type {any} */ (value);
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Jednostka miary i ilość pozycji.
 *
 * ⚠️ ILOŚĆ POCHODZI WYŁĄCZNIE Z `json_parameters.ILOSC` — czyli z liczby sztuk.
 * Żaden produkt w tym systemie nie jest rozliczany na m² ani na metry bieżące:
 * powierzchnia (`POW`) i wymiary (`SZEROKOSC`/`WYSOKOSC`) są danymi
 * technicznymi konfiguracji, a nie miarą sprzedaży.
 *
 * Wcześniejsza wersja wyliczała `m²` z `POW × ILOSC` i drukowała to jako ilość,
 * przez co faktura pokazywała np. „1,76 m²" dla pozycji, którą częściowe
 * fakturowanie rozliczało jako **1 sztukę** (`core/allocations.js` zawsze czyta
 * `ILOSC`). Dokument przeczył więc własnym alokacjom. Teraz oba miejsca liczą
 * to samo — sztuki.
 *
 * Wymiary trafiają do `meta` i mają na dokumencie osobną kolumnę „Wymiary".
 *
 * @param {Record<string, any>} params  `json_parameters`
 * @param {number} amount               `order_item.amount` (fallback)
 * @returns {{ unit: string, quantity: number, isInstallation: boolean }}
 */
function resolveUnitAndQuantity(params, amount) {
  const pieces = Math.max(1, num(params.ILOSC) || num(amount) || 1);
  // `isInstallation` zawsze false — patrz GOODS_ONLY_NOTE na górze pliku.
  return { unit: Unit.PIECE, quantity: pieces, isInstallation: false };
}

/**
 * Nazwa pozycji na fakturze. Priorytet: nazwa własna pozycji → dział + grupa
 * asortymentowa → sam dział.
 *
 * @param {Record<string, any>} item wiersz `order_item`
 * @returns {string}
 */
function buildItemName(item) {
  const own = String(item.name || '').trim();
  const dept = String(item.department || '').trim();
  const group = String(item.group_name || '').trim();
  const context = [dept, group].filter(Boolean).join(' ');

  // ⚠️ `order_item.name` bywa gołym kodem katalogowym (realne dane: „272116").
  // Sam kod na fakturze nie spełnia wymogu „nazwa towaru lub usługi", dlatego
  // wartość bez ani jednej litery poprzedzamy działem i grupą asortymentową.
  if (own && !/\p{L}/u.test(own)) return context ? `${context} ${own}` : own;
  if (own) return own;
  return context || 'Pozycja zamówienia';
}

/**
 * Opis pozycji: wymiary + wybrane parametry + komentarz.
 * Krótko i konkretnie — faktura nie jest kartą technologiczną.
 *
 * @param {Record<string, any>} item
 * @param {Record<string, any>} params
 * @returns {string}
 */
function buildItemDescription(item, params) {
  // ⚠️ BEZ wymiarów: mają własną kolumnę na dokumencie (`items_table.njk`
  // + `invoice_item.width_mm/height_mm`). Powtarzanie ich w opisie zawijało
  // wiersz na dwie linie i wypychało dokument na kolejną stronę.
  const parts = [];

  for (const key of DESCRIPTION_KEYS) {
    const value = params[key];
    if (value === undefined || value === '' || value === '-') continue;
    parts.push(`${key}: ${value}`);
  }

  const ownRef = String(item.commision || '').trim();
  if (ownRef) parts.push(ownRef);
  const comment = String(item.comment || '').trim();
  if (comment) parts.push(comment);

  return parts.join(' · ');
}

/**
 * Zamienia wiersze `order_item` na pozycje wejściowe kalkulatora.
 *
 * @param {Object} params
 * @param {Array<Record<string, any>>} params.orderItems  Wiersze `order_item`.
 * @param {(opts: { isService: boolean, isInstallation: boolean }) => { taxCategory: string, taxRate: number }} params.resolveTax
 *        Wstrzykiwana decyzja podatkowa — mapper nie zna reguł VAT, tylko pyta.
 * @param {string} [params.currency='EUR']
 * @param {boolean} [params.useSubPrices=false]
 *        `true` → wartości z `total_price_sub` (ceny klienta, patrz `services/subPrices.js`).
 * @returns {RawItem[]}
 */
function mapOrderItemsToInvoiceItems({ orderItems, resolveTax, currency = 'EUR', useSubPrices = false }) {
  return (orderItems || []).map((item) => {
    const params = parseJson(item.json_parameters);
    const { unit, quantity, isInstallation } = resolveUnitAndQuantity(params, item.amount);

    // Wartość netto pozycji — źródło prawdy o cenie (patrz komentarz wyżej).
    const totalNetMinor = money.toMinor(
      useSubPrices && item.total_price_sub != null ? item.total_price_sub : item.total_price,
      currency
    );

    // Cena jednostkowa liczona wstecz z wartości, żeby ilość × cena = wartość.
    // Reszta z dzielenia trafia do ostatniego grosza wartości — dlatego
    // kalkulator dostaje `unitPriceNetMinor` i `quantity: 1`, a prawdziwą ilość
    // pokazujemy w kolumnie „ilość" jako informację.
    const unitPriceNetMinor = totalNetMinor;

    const tax = resolveTax({ isService: isInstallation, isInstallation });

    return {
      name: buildItemName(item),
      description: buildItemDescription(item, params),
      unit,
      // ⚠️ Świadomie: kalkulator dostaje ilość 1 × pełną wartość pozycji, bo
      // cenniki są progowe i `ILOSC × cena jednostkowa` nie odtworzyłoby wyceny.
      // Na dokumencie drukujemy `meta.displayQuantity`, czyli liczbę SZTUK.
      quantity: 1,
      unitPriceNetMinor,
      discountPercent: 0,
      taxRate: tax.taxRate,
      taxCategory: tax.taxCategory,
      orderItemId: item.id,
      meta: {
        displayQuantity: quantity,
        displayUnit: unit,
        pieces: num(params.ILOSC) || num(item.amount) || 1,
        area: num(params.POW) || null,
        widthMm: num(params.SZEROKOSC) || null,
        heightMm: num(params.WYSOKOSC) || null,
        asortmentGroup: item.asortment_group_number || null,
        department: item.department || null,
        orderPosition: item.orderpos || null,
        discountPercentSource: item.discount_percentage != null ? Number(item.discount_percentage) : null
      }
    };
  });
}

/**
 * Buduje strony transakcji z danych eForm.
 *
 * Sprzedawcą jest organizacja (`organization`), nabywcą klient (`user`) —
 * z możliwością nadpisania danymi adresu z zamówienia, bo faktura idzie na dane
 * rejestrowe, a nie na adres dostawy.
 *
 * @param {Object} params
 * @param {Record<string, any>} params.organization  Wiersz `organization`.
 * @param {Record<string, any>} params.user          Wiersz `user`.
 * @param {Record<string, any>} [params.groupShop]   Wiersz `group_user`, gdy zamówienie złożył sklep.
 * @returns {{ seller: Party, buyer: Party }}
 */
function mapParties({ organization, user, groupShop }) {
  /** @type {Party} */
  const seller = {
    name: organization?.name || '',
    taxId: organization?.tax_id || '',
    street: organization?.street || '',
    zip: organization?.zip || '',
    city: organization?.city || '',
    country: organization?.country || '',
    email: organization?.company_mail || organization?.email || '',
    phone: organization?.company_phone || ''
  };

  // Sklep grupowy (np. subkonto TCN) jest nabywcą, jeśli zamówienie do niego należy —
  // wtedy dane rejestrowe brane są z `group_user`, a nie z użytkownika-parenta.
  const source = groupShop && (groupShop.tax_id || groupShop.name) ? groupShop : user;

  /** @type {Party} */
  const buyer = {
    name: source?.name || source?.client_name || '',
    taxId: source?.tax_id || '',
    vatEuId: source?.tax_id || '',
    street: source?.street || '',
    zip: source?.zip || '',
    city: source?.city || '',
    country: source?.country || '',
    email: source?.email || '',
    phone: source?.phone || ''
  };

  return { seller, buyer };
}

module.exports = {
  GOODS_ONLY_NOTE,
  DESCRIPTION_KEYS,
  parseJson,
  resolveUnitAndQuantity,
  buildItemName,
  buildItemDescription,
  mapOrderItemsToInvoiceItems,
  mapParties
};
