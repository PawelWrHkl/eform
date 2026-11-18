'use strict';

/**
 * Ręczna edycja faktury (`core/manualEdit.js`): nakładka na pozycje zamówienia —
 * różnica, nałożenie na świeże pozycje, konflikty, wartość co do grosza.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffOverlay, applyOverlay, editorLines, rawFromSaved, isNoop, lineOf } = require('../core/manualEdit');

const resolveTax = ({ isService }) => (isService ? { taxRate: 0, taxCategory: 'intra_eu_service' } : { taxRate: 23, taxCategory: 'standard' });
// Pozycja z zamówienia jak z orderMapper: 1 × pełna wartość, sztuki w meta
const orderItem = (id, value, pcs = 3, extra = {}) => ({
  orderItemId: id, name: `Roleta ${id}`, description: `opis ${id}`, unit: 'szt', quantity: 1,
  unitPriceNetMinor: value, discountPercent: 0, taxRate: 23, taxCategory: 'standard',
  meta: { displayQuantity: pcs, displayUnit: 'szt', orderRef: `EO/1/${id}`, priceBeforeDiscountMinor: value * 2, discountPercent: 50 }, ...extra
});

test('bez zmian: nakładka pusta, a wartość pozycji zostaje co do grosza (100,00 / 3 szt. ≠ 3 × 33,33)', () => {
  const base = [orderItem(1, 10000), orderItem(2, 5000, 1)];
  const lines = editorLines(base);
  assert.equal(lines[0].unitPriceNet, 33.33);
  const overlay = diffOverlay(base, lines);
  assert.ok(isNoop(overlay));
  const { items, conflicts } = applyOverlay(base, overlay, { resolveTax });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(items.map((i) => [i.orderItemId, i.unitPriceNetMinor]), [[1, 10000], [2, 5000]]);
});

test('zmiana opisu istniejącej pozycji, nowa cena drugiej, linia ręczna, usunięcie i kolejność', () => {
  const base = [orderItem(1, 10000), orderItem(2, 5000, 1), orderItem(3, 700, 1)];
  const lines = editorLines(base);
  lines[0].description = 'nowy opis\nw dwóch wierszach';
  lines[1].unitPriceNet = 45.5;
  const desired = [lines[1], lines[0], { name: 'Transport', description: 'DHL', quantity: 1, unit: 'usl', unitPriceNet: 30, isService: true }];
  const overlay = diffOverlay(base, desired);
  assert.equal(isNoop(overlay), false);
  assert.deepEqual(overlay.removed, [3]);
  assert.equal(overlay.reordered, true);
  const { items, conflicts } = applyOverlay(base, overlay, { resolveTax });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(items.map((i) => i.orderItemId || i.name), [2, 1, 'Transport']);
  assert.equal(items[0].unitPriceNetMinor, 4550);
  assert.equal(items[0].meta.priceBeforeDiscountMinor, undefined, 'ręczna cena kasuje kolumny rabatu');
  assert.equal(items[1].unitPriceNetMinor, 10000, 'sam opis nie rusza wartości');
  assert.equal(items[1].description, 'nowy opis\nw dwóch wierszach');
  assert.equal(items[1].meta.orderRef, 'EO/1/1', 'referencja EO zostaje');
  assert.deepEqual([items[2].taxCategory, items[2].meta.manual, items[2].unitPriceNetMinor], ['intra_eu_service', true, 3000]);
});

test('zamówienie zmienione po edycji: ruszona pozycja → konflikt, nieruszona i nowa → bez konfliktu', () => {
  const base = [orderItem(1, 10000), orderItem(2, 5000, 1)];
  const lines = editorLines(base);
  lines[0].quantity = 4; // ilość zmieniona → wartość 4 × 33,33
  const overlay = diffOverlay(base, lines);
  assert.equal(applyOverlay(base, overlay, { resolveTax }).items[0].unitPriceNetMinor, 13332);

  const fresh = [orderItem(1, 12000), orderItem(2, 5500, 1), orderItem(9, 100, 1)];
  const r = applyOverlay(fresh, overlay, { resolveTax });
  assert.deepEqual(r.conflicts, [{ orderItemId: 1, reason: 'changed' }]);
  assert.deepEqual(r.items.map((i) => [i.orderItemId, i.unitPriceNetMinor]), [[1, 13332], [2, 5500], [9, 100]], 'nowa pozycja zamówienia na końcu');

  const gone = applyOverlay([orderItem(2, 5000, 1)], overlay, { resolveTax });
  assert.deepEqual(gone.conflicts, [{ orderItemId: 1, reason: 'removed' }]);
});

test('edycja zapisanej faktury: stare linie ręczne nie dublują się, wartości z bazy', () => {
  const saved = [
    { orderItemId: 1, name: 'Roleta', description: '', unit: 'szt', quantity: 3, netAmount: 10000, taxRate: 23, taxCategory: 'standard', meta: { displayQuantity: 3 } },
    { orderItemId: null, name: 'Transport', description: '', unit: 'usl', quantity: 1, netAmount: 3000, taxRate: 23, taxCategory: 'standard', meta: { manual: true, displayQuantity: 1 } }
  ];
  const base = saved.map(rawFromSaved);
  const lines = editorLines(base);
  lines[1].unitPriceNet = 35;
  const { items } = applyOverlay(base, diffOverlay(base, lines), { resolveTax });
  assert.deepEqual(items.map((i) => [i.orderItemId || i.name, i.unitPriceNetMinor]), [[1, 10000], ['Transport', 3500]]);
  assert.equal(lineOf(items[0]).quantity, 3);
});

test('dostęp do edycji: admin i biuro, nigdy konto grupy, klient ani organizacja; moduł wyłączony — nikt', () => {
  const { canEditInvoices, canAccessInvoices } = require('../access');
  const on = { invoices: true, invoicesAdminOnly: true };
  assert.equal(canEditInvoices({ isAdmin: true }, on), true);
  assert.equal(canEditInvoices({ isStaff: true }, on), true, 'biuro edytuje mimo INVOICES_ADMIN_ONLY');
  assert.equal(canAccessInvoices({ isStaff: true }, on), false, 'ale panelu faktur dalej nie widzi');
  assert.equal(canEditInvoices({ isStaff: true, isGroupShop: true }, on), false);
  assert.equal(canEditInvoices({ isOwner: true }, on), false);
  assert.equal(canEditInvoices({}, on), false);
  assert.equal(canEditInvoices({ isAdmin: true }, { invoices: false }), false);
});

test('żądanie edycji: cel, linie z pozycją zamówienia, przecinek dziesiętny, błędy przy polach', () => {
  const { parseEditRequest } = require('../http/routes');
  const good = parseEditRequest({ target: { orderId: '12', level: 1 }, lines: [{ orderItemId: '7', name: 'Roleta', quantity: '2', unitPriceNet: '10,50', unit: 'szt' }], notes: 'x', paymentDays: '14', version: 3 });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.params.target, { orderId: 12, level: 1 });
  assert.deepEqual([good.params.lines[0].orderItemId, good.params.lines[0].unitPriceNet, good.params.paymentDays, good.params.version], [7, 10.5, 14, 3]);
  const bad = parseEditRequest({ target: {}, lines: [{ name: '', quantity: '0', unitPriceNet: '1,234' }], paymentDays: '400' });
  assert.deepEqual(bad.fieldErrors.map((e) => e.code), ['target', 'item_name', 'item_qty', 'item_price', 'payment_days']);
});
