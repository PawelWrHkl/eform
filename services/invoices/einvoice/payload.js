'use strict';

/**
 * Treść żądania `POST /v1/documents` (i `/check`) usługi e-faktur — kontrakt
 * „EFOR_E-Rechnung_Kontrakt” v1.4, pkt 4 i 11.
 *
 * Funkcja czysta: dokument (`repository.getInvoice` albo `createFromOrder({ dryRun })`)
 * + wiersze źródłowe (`repository.getEinvoiceSources`) → JSON zgodny z kontraktem.
 * Bez bazy i sieci, więc w całości pokryta testami (`__tests__/einvoicePayload.test.js`).
 *
 * Zasady formatu (kontrakt pkt 4):
 *   - kwoty: napis z dwoma miejscami po kropce w EUR („214.80”), nigdy float ani grosze,
 *   - ilości do trzech miejsc („2”, „2.5”), stawki w procentach („19”, „0”),
 *   - daty RRRR-MM-DD, kraje ISO-2 — przekazywane tak, jak są w EFOR (wolny tekst
 *     typu „Austria” ma dostać HOLD w usłudze, a nie być po cichu obcięty tutaj),
 *   - nieznane pola usługa odrzuca (400), więc wysyłamy wyłącznie pola z kontraktu,
 *   - pola tekstowe NIGDY null (schemat usługi, sprawdzone 19.11.2026: 400 „Input should be
 *     a valid string”) — brak wartości = „”; null wolno w datach, `payment.days`, wymiarach
 *     i numerach pozycji/zamówienia.
 *
 * Czego EFOR jeszcze nie ma (kontrakt pkt 6.6, przed trybem live): adres do faktur
 * nabywcy (`invoice_email` = „”), skonto (null), mandat SEPA, umowa bonusowa (false),
 * osobna uwaga do faktury (`notes_de` = „”), niemieckie nazwy towarów (idzie nazwa
 * z faktury), numer taryfy celnej (`hs_code` = „”). W trybie cienia usługa zgłasza
 * je jako ostrzeżenia — nie blokują porównania.
 */

const money = require('../core/money');
const { toIsoDay } = require('../core/dates');
const { DocumentType } = require('../domain/constants');
const { alignStatusesToItems } = require('../../prodStatus');

const SCHEMA_VERSION = '1';
const SOURCE = 'efor';
const ENVS = Object.freeze(['dev', 'test', 'prod']);
/** Kontrakt pkt 4: numer — litery, cyfry, `/`, `-`, do 40 znaków (`_` zajęty przez URL). */
const NUMBER_RE = /^[A-Za-z0-9/-]{1,40}$/;

/** Grosze → „214.80”. */
function amount(minor) {
  if (!Number.isFinite(Number(minor))) throw new Error(`e-faktura: kwota „${minor}” nie jest liczbą`);
  return money.toMajor(Number(minor), 'EUR').toFixed(2);
}

/** Ilość do trzech miejsc, bez zbędnych zer: 2 → „2”, 2.5 → „2.5”. */
function quantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`e-faktura: ilość „${value}” nie jest liczbą`);
  return String(Math.round(n * 1000) / 1000);
}

/** Stawka VAT w procentach: 19 → „19”, 0 → „0”. */
function rate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`e-faktura: stawka „${value}” nie jest liczbą`);
  return String(n);
}

const day = (value) => toIsoDay(value) || null;
const text = (value) => (value === null || value === undefined ? '' : String(value).trim());

/**
 * Numer VAT-UE sprzedawcy taki, jaki jest NA WYDRUKU: `vatEuId`, a gdy go nie ma —
 * USt-IdNr. z kontekstu prawnego zapisanego przy wystawieniu (Luxan GmbH bez
 * profilu wystawcy trzyma DE814603367 w `tax_id`, a wydruk pokazuje go jako USt-IdNr.).
 */
function sellerVatId(invoice) {
  const seller = invoice.seller || {};
  if (text(seller.vatEuId)) return text(seller.vatEuId);
  const registry = (invoice.compliance && invoice.compliance.sellerRegistry) || [];
  const printed = registry.find((r) => r && r.key === 'USTIDNR' && text(r.value));
  return printed ? text(printed.value) : '';
}

/** Rodzaj nabywcy jak w EFOR: `user`, `group_user` (sklep grupy), `organization`, `end_client`. */
function buyerSourceType(invoice) {
  if (invoice.buyerGroupUserId) return 'group_user';
  return invoice.buyerType || 'user';
}

/** Dni między wystawieniem a terminem płatności (gdy klient nie ma własnego terminu). */
function daysBetween(fromIso, toIso) {
  const from = toIsoDay(fromIso);
  const to = toIsoDay(toIso);
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** Grupa cenowa z parametrów pozycji (`KOLOR_ALIAS___DESCRIPTION` „… #2”), jak we wzorze MaizonCozy. */
function priceGroup(jsonParameters) {
  let p = jsonParameters;
  for (let i = 0; i < 2 && typeof p === 'string'; i++) {
    try { p = JSON.parse(p); } catch { return ''; }
  }
  const desc = p && typeof p === 'object' ? String(p.KOLOR_ALIAS___DESCRIPTION || '') : '';
  return (desc.match(/#\s*(\S+)/) || [])[1] || '';
}

/**
 * Statusy produkcji per pozycja zamówienia (`position_statuses`) — przypięte po
 * numerze pozycji (`prodStatus.alignStatusesToItems`, ta sama reguła co widok
 * zamówienia: z kilku podpozycji wygrywa blokująca, a gdy wszystkie wysłane —
 * najpóźniejsza data).
 *
 * @param {Array<Record<string, any>>} orderItems wiersze `order_item` + `order_idx`, `user_ident`
 * @param {Array<Record<string, any>>} statuses   wiersze `position_statuses`
 * @returns {Map<number, { status: string, shipping_date: any }>} po `order_item.id`
 */
function statusesByOrderItem(orderItems, statuses) {
  const result = new Map();
  const byOrder = new Map();
  for (const row of orderItems) {
    const key = `${row.user_ident}\u0000${row.order_idx}`;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(row);
  }
  for (const [key, rows] of byOrder) {
    const own = statuses.filter((s) => `${s.user_ident}\u0000${s.order_idx}` === key);
    const aligned = alignStatusesToItems(own, rows);
    // Bez numerów pozycji funkcja oddaje statusy w oryginalnej kolejności — tego nie
    // przypinamy (cudzy status przy pozycji to gorzej niż brak statusu)
    if (aligned === own) continue;
    rows.forEach((row, i) => { if (aligned[i]) result.set(Number(row.id), aligned[i]); });
  }
  return result;
}

/**
 * @typedef {Object} EinvoiceSources  wynik `repository.getEinvoiceSources(invoice)`
 * @property {{ ident: string, email: string }} issuer
 * @property {{ ident: string|null, email: string|null, phone: string|null }} buyer
 * @property {number|null} paymentTermsDays  `customer_commercial_terms.payment_terms_days`
 * @property {Array<Record<string, any>>} orders      `order` + `user_ident` właściciela
 * @property {Array<Record<string, any>>} orderItems  `order_item` + `order_idx`, `user_ident`
 * @property {Array<Record<string, any>>} statuses    `position_statuses` tych zamówień
 * @property {Array<Record<string, any>>} sendAddresses
 * @property {{ number: string, issueDate: string, deliveryDate: string }|null} corrected
 */

/**
 * @param {Object} p
 * @param {import('../domain/types').Invoice & Record<string, any>} p.invoice
 * @param {'dev'|'test'|'prod'} p.env           `efor_env` — musi pasować do klucza
 * @param {EinvoiceSources} p.sources
 * @param {string|null} [p.number]              domyślnie `invoice.number`; `null` tylko dla `/check`
 * @param {[string, string]|null} [p.period]    okres faktury zbiorczej (`invoiceFtpExport.collectivePeriod`)
 * @returns {Record<string, any>}
 */
function buildPayload({ invoice, env, sources, number = invoice.number, period = null }) {
  if (!ENVS.includes(env)) throw new Error(`e-faktura: efor_env musi być jednym z ${ENVS.join('|')} (jest: „${env}”)`);
  if (number !== null && !NUMBER_RE.test(String(number))) {
    throw new Error(`e-faktura: numer „${number}” — dozwolone litery, cyfry, „/”, „-”, do 40 znaków`);
  }
  // Usługa wymaga liczby (null → 400); skrypt wsadowy podaje -order_id (Wiktoria, 19.11.2026)
  if (!Number.isInteger(Number(invoice.id)) || invoice.id === null || invoice.id === undefined) {
    throw new Error('e-faktura: invoice_id musi być liczbą (dokument bez id — skrypt wsadowy podaje -order_id)');
  }
  if (invoice.currency && invoice.currency !== 'EUR') throw new Error(`e-faktura: tylko EUR (dokument w ${invoice.currency})`);

  const orderItemsById = new Map((sources.orderItems || []).map((r) => [Number(r.id), r]));
  const statusByItem = statusesByOrderItem(sources.orderItems || [], sources.statuses || []);
  const orders = sources.orders || [];

  // Data dostawy SUROWA z zamówień (max `order.delivery_date` = max daty wysyłki pozycji);
  // nigdy data sprzedaży (kontrakt pkt 4) — brak = null
  const deliveryDates = orders.map((o) => day(o.delivery_date)).filter(Boolean).sort();
  const deliveryDate = deliveryDates.length ? deliveryDates[deliveryDates.length - 1] : null;

  // Adres dostawy: wspólny adres wysyłki zamówień (`send_address`), inaczej adres
  // odbiorcy z faktury; różne adresy w zbiorczej → null (pozycje i tak niosą zamówienie)
  const sendIds = [...new Set(orders.map((o) => o.send_address_id).filter(Boolean).map(Number))];
  const sendAddress = sendIds.length === 1 && orders.every((o) => Number(o.send_address_id) === sendIds[0])
    ? (sources.sendAddresses || []).find((a) => Number(a.id) === sendIds[0])
    : null;
  const deliverySource = sendAddress || (sendIds.length ? null : invoice.deliveryAddress) || null;

  const paymentDays = Number.isInteger(sources.paymentTermsDays) && sources.paymentTermsDays >= 0
    ? sources.paymentTermsDays
    : daysBetween(invoice.issueDate, invoice.dueDate);

  const isCorrective = invoice.documentType === DocumentType.CORRECTION || invoice.documentType === 'credit_note';
  const corrected = isCorrective && sources.corrected
    ? {
      number: sources.corrected.number,
      issue_date: day(sources.corrected.issueDate),
      delivery_date: day(sources.corrected.deliveryDate),
      reason: text(invoice.correctionReason)
    }
    : null;

  const seller = invoice.seller || {};
  const buyer = invoice.buyer || {};

  const payload = {
    schema_version: SCHEMA_VERSION,
    source: SOURCE,
    efor_env: env,
    invoice_id: Number(invoice.id),
    level: Number(invoice.level),
    issuer: { type: invoice.issuerType, id: Number(invoice.issuerId) || 0, ident: sources.issuer.ident },
    document_type: invoice.documentType,
    number: number === null ? null : String(number),
    issue_date: day(invoice.issueDate),
    sale_date: day(invoice.saleDate),
    ...(period && period[0] && period[1] ? { period_from: day(period[0]), period_to: day(period[1]) } : {}),
    delivery_date: deliveryDate,
    due_date: day(invoice.dueDate),
    currency: 'EUR',
    lang: text(invoice.lang),
    seller: {
      name: text(seller.name),
      street: text(seller.street),
      zip: text(seller.zip),
      city: text(seller.city),
      country: text(seller.country),
      vat_eu_id: sellerVatId(invoice),
      tax_id: text(seller.taxId),
      email: text(sources.issuer.email),
      ident: sources.issuer.ident
    },
    buyer: {
      name: text(buyer.name),
      street: text(buyer.street),
      zip: text(buyer.zip),
      city: text(buyer.city),
      country: text(buyer.country),
      vat_eu_id: text(buyer.vatEuId),
      tax_id: text(buyer.taxId),
      invoice_email: '',
      email: text(sources.buyer.email) || text(buyer.email),
      phone: text(sources.buyer.phone),
      ident: text(sources.buyer.ident),
      source_type: buyerSourceType(invoice)
    },
    delivery_address: deliverySource
      ? {
        name: text(deliverySource.name),
        street: text(deliverySource.street),
        zip: text(deliverySource.zip),
        city: text(deliverySource.city),
        country: text(deliverySource.country)
      }
      : null,
    payment: {
      method: invoice.paymentMethod || 'transfer',
      days: paymentDays,
      skonto: null,
      mandate_ref: ''
    },
    orders: orders.map((o) => ({
      order_id: Number(o.id),
      order_idx: text(o.order_idx),
      commission: text(o.commision),
      user_ident: text(o.user_ident)
    })),
    items: invoice.items.map((item) => {
      const meta = item.meta || {};
      const row = item.orderItemId ? orderItemsById.get(Number(item.orderItemId)) : null;
      const status = row ? statusByItem.get(Number(row.id)) : null;
      const orderPosition = Number(meta.orderPosition || (row && row.orderpos)) || null;
      return {
        position: Number(item.position),
        order_idx: row ? text(row.order_idx) : text(item.orderNumber),
        order_item_id: item.orderItemId ? Number(item.orderItemId) : null,
        order_position: orderPosition,
        name_de: text(item.name),
        description_de: text(item.description),
        quantity: quantity(item.quantity),
        unit: item.unit,
        net_amount: amount(item.netAmount),
        price_source: meta.priceSource || invoice.priceBasis || 'base',
        tax_category: item.taxCategory,
        tax_rate: rate(item.taxRate),
        shipping_date: status ? day(status.shipping_date) : null,
        shipping_status: status ? text(status.status) : '',
        width_mm: Number(meta.widthMm) || null,
        height_mm: Number(meta.heightMm) || null,
        kom: row ? text(row.commision) : '',
        hs_code: '',
        price_group: row ? priceGroup(row.json_parameters) : '',
        user_ident: row ? text(row.user_ident) : ''
      };
    }),
    tax_lines: invoice.taxLines.map((l) => ({
      tax_category: l.taxCategory,
      tax_rate: rate(l.taxRate),
      net_amount: amount(l.netAmount),
      tax_amount: amount(l.taxAmount),
      gross_amount: amount(l.grossAmount)
    })),
    totals: {
      net: amount(invoice.totalNet),
      tax: amount(invoice.totalTax),
      gross: amount(invoice.totalGross),
      advance_settled: amount(invoice.advanceSettled || 0),
      amount_due: amount(invoice.amountDue ?? invoice.totalGross)
    },
    vies: {
      checked_at: invoice.viesCheckedAt || null,
      valid: invoice.viesValid === undefined ? null : invoice.viesValid
    },
    corrected,
    notes_de: '',
    bonus_agreement: false
  };
  return payload;
}

module.exports = {
  SCHEMA_VERSION,
  ENVS,
  NUMBER_RE,
  amount,
  quantity,
  rate,
  sellerVatId,
  priceGroup,
  statusesByOrderItem,
  buildPayload
};
