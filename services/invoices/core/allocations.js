'use strict';

/**
 * Częściowe fakturowanie (partial invoicing) — czysta logika ilości.
 *
 * Pozycja zamówienia ma ilość całkowitą (np. 3 rolety). Można ją fakturować
 * partiami: najpierw 2 szt., potem 1 szt. Każda partia to wiersz w
 * `invoice_item_allocation` (`order_item_id` → `invoice_item_id`,
 * `invoiced_quantity`).
 *
 * ⚠️ NADRZĘDNA REGUŁA: suma zafakturowanych ilości dla pozycji zamówienia nie
 * może przekroczyć ilości zamówionej. Baza nie potrafi tego wyrazić (to suma po
 * wielu wierszach, nie CHECK na jednym), więc walidacja MUSI być robiona w
 * transakcji zapisu faktury — wołający czyta zajętość i zapisuje alokacje w tej
 * samej transakcji, inaczej dwa równoległe wystawienia przefakturują pozycję.
 * Patrz `db/repository.js:createInvoice` i `getAllocatedQuantities`.
 *
 * Ten plik nie dotyka bazy — dostaje stan zajętości i liczy.
 */

const money = require('./money');

/** Tolerancja porównań ilości (3 miejsca po przecinku, jak kolumna DECIMAL(12,3)). */
const QTY_EPSILON = 0.0005;

/**
 * Ilość zamówiona z pozycji `order_item`.
 *
 * ⚠️ Ta sama reguła co w `mailBot/pdfGenerator.js:readQty` — źródłem prawdy jest
 * `json_parameters.ILOSC` (klucze są zawsze polskie i kanoniczne), a kolumna
 * `amount` to fallback. Rozjechanie się tych dwóch miejsc oznaczałoby, że PDF
 * zamówienia i faktura pokazują inne ilości.
 *
 * @param {Record<string, any>} item wiersz `order_item`
 * @returns {number}
 */
function orderedQuantity(item) {
  if (!item) return 0;
  let params = item.json_parameters;
  if (typeof params === 'string') {
    try { params = JSON.parse(params); } catch { params = null; }
  }
  if (params && typeof params === 'object') {
    const raw = params.ILOSC ?? params['ILOŚĆ'] ?? params.ilosc;
    const qty = Number(raw);
    if (Number.isFinite(qty) && qty > 0) return qty;
  }
  const amount = Number(item.amount);
  if (Number.isFinite(amount) && amount > 0) return amount;
  return 1;
}

/**
 * Ile z pozycji pozostało do zafakturowania.
 *
 * @param {Object} params
 * @param {Record<string, any>} params.orderItem
 * @param {number} [params.alreadyInvoiced=0] Suma z `invoice_item_allocation`.
 * @returns {{ ordered: number, invoiced: number, available: number, fullyInvoiced: boolean }}
 */
function availableQuantity({ orderItem, alreadyInvoiced = 0 }) {
  const ordered = orderedQuantity(orderItem);
  const invoiced = Number(alreadyInvoiced) || 0;
  const available = Math.max(0, Math.round((ordered - invoiced) * 1000) / 1000);
  return {
    ordered,
    invoiced,
    available,
    fullyInvoiced: available <= QTY_EPSILON
  };
}

/**
 * Waliduje żądane partie względem stanu zajętości.
 *
 * @param {Object} params
 * @param {Array<{ orderItemId: number, quantity: number }>} params.requested
 * @param {Map<number, Record<string, any>>} params.orderItemsById
 * @param {Map<number, number>} params.allocatedByOrderItem  Suma już zafakturowana.
 * @returns {{ valid: boolean, errors: string[], lines: Array<{ orderItemId: number, quantity: number, ordered: number, alreadyInvoiced: number, remainingAfter: number }> }}
 */
function validateAllocations({ requested, orderItemsById, allocatedByOrderItem }) {
  const errors = [];
  const lines = [];
  /** Sumowanie w obrębie jednego żądania — ta sama pozycja może wystąpić dwa razy. */
  const requestedPerItem = new Map();

  for (const entry of requested || []) {
    const orderItemId = Number(entry.orderItemId);
    const quantity = Number(entry.quantity);

    const orderItem = orderItemsById.get(orderItemId);
    if (!orderItem) {
      errors.push(`Pozycja zamówienia ${orderItemId} nie należy do tego zamówienia.`);
      continue;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`Nieprawidłowa ilość dla pozycji ${orderItemId}: ${entry.quantity}.`);
      continue;
    }

    const alreadyInvoiced = Number(allocatedByOrderItem.get(orderItemId) || 0);
    const inThisRequest = Number(requestedPerItem.get(orderItemId) || 0);
    const { ordered, available } = availableQuantity({ orderItem, alreadyInvoiced: alreadyInvoiced + inThisRequest });

    if (quantity - available > QTY_EPSILON) {
      errors.push(
        `Pozycja ${orderItemId}: próba zafakturowania ${quantity} przy dostępnych ${available} `
        + `(zamówiono ${ordered}, już zafakturowano ${alreadyInvoiced + inThisRequest}).`
      );
      continue;
    }

    requestedPerItem.set(orderItemId, inThisRequest + quantity);
    lines.push({
      orderItemId,
      quantity,
      ordered,
      alreadyInvoiced,
      remainingAfter: Math.round((ordered - alreadyInvoiced - inThisRequest - quantity) * 1000) / 1000
    });
  }

  if (!lines.length && !errors.length) {
    errors.push('Nie wskazano żadnej pozycji do zafakturowania.');
  }

  return { valid: errors.length === 0, errors, lines };
}

/**
 * Kwota netto partii = wartość pozycji × (ilość partii / ilość zamówiona).
 *
 * ⚠️ Proporcja liczona z WARTOŚCI pozycji, nie z ceny jednostkowej × ilość:
 * cenniki tej branży są progowe (patrz `core/orderMapper.js`), więc jedynym
 * pewnym punktem odniesienia jest kwota policzona przez silnik formularzy.
 * Reszta z dzielenia trafia do ostatniej partii — dzięki temu suma faktur
 * częściowych zgadza się co do grosza z wartością zamówienia.
 *
 * @param {Object} params
 * @param {number} params.itemNetMinor    Wartość netto całej pozycji (minor units).
 * @param {number} params.quantity        Ilość w tej partii.
 * @param {number} params.ordered         Ilość zamówiona.
 * @param {number} [params.alreadyInvoicedMinor=0] Kwota już zafakturowana z tej pozycji.
 * @param {number} [params.alreadyInvoicedQty=0]
 * @returns {number} kwota netto partii w minor units
 */
function allocatedNetAmount({ itemNetMinor, quantity, ordered, alreadyInvoicedMinor = 0, alreadyInvoicedQty = 0 }) {
  const total = Math.trunc(itemNetMinor) || 0;
  if (!ordered || ordered <= 0) return total;

  const isLastBatch = Math.abs(ordered - alreadyInvoicedQty - quantity) <= QTY_EPSILON;
  if (isLastBatch) {
    // Domknięcie: cokolwiek zostało, idzie do ostatniej partii (bez grosza reszty)
    return total - Math.trunc(alreadyInvoicedMinor);
  }
  return money.roundHalfUp((total * quantity) / ordered);
}

module.exports = {
  QTY_EPSILON,
  orderedQuantity,
  availableQuantity,
  validateAllocations,
  allocatedNetAmount
};
