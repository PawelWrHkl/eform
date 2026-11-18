'use strict';

/**
 * Ręczna edycja faktury z zamówienia — admin i biuro (Paweł, 17.11.2026).
 *
 * LINIA (edytor) = { orderItemId?, name, description, quantity, unit, unitPriceNet (EUR),
 * isService }. Do edycji jest wszystko, także istniejące pozycje zamówienia
 * (uwaga Pawła: „istniejące pozycje też… wszystko do edycji”).
 *
 * POZYCJA (kalkulator) — jak z `orderMapper`: 1 × pełna wartość netto, ilość do druku
 * w `meta.displayQuantity`. Zmiana samego opisu nie rusza wartości: cenniki są progowe,
 * więc `ilość × cena jedn.` nie odtworzyłoby jej co do grosza.
 *
 * NAKŁADKA = różnica między pozycjami zbudowanymi z zamówienia a ustawionymi przez
 * człowieka: kolejność, zmienione pola pozycji zamówienia, usunięte pozycje i linie
 * ręczne. Nakładana przy KAŻDYM budowaniu dokumentu z zamówienia (per zlecenie,
 * dzienna, zbiorcza, „Przelicz dzienne ponownie”), więc przeżywa zmiany zamówienia
 * przed wysyłką. Pozycja, którą człowiek ruszył, a zamówienie potem zmieniło albo
 * usunęło, to konflikt — dokumentu nie wystawiamy, tylko „do przejrzenia”.
 */

const money = require('./money');

const MANUAL_EDIT_CONFLICT_CODE = 'INVOICE_MANUAL_EDIT_CONFLICT';
const FIELDS = ['name', 'description', 'quantity', 'unit', 'valueMinor'];

const text = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * Pozycja (świeżo zbudowana albo zapisana w bazie) → linia z wartością netto w groszach.
 * @param {Record<string, any>} item
 */
function lineOf(item) {
  const meta = item.meta || {};
  const quantity = Number(meta.displayQuantity ?? item.quantity) || 1;
  const valueMinor = item.netAmount != null
    ? Number(item.netAmount)
    : Math.round(Number(item.unitPriceNetMinor) * Number(item.quantity || 1) * (100 - Number(item.discountPercent || 0)) / 100);
  return {
    orderItemId: item.orderItemId ? Number(item.orderItemId) : null,
    name: text(item.name),
    description: text(item.description),
    quantity,
    unit: text(meta.displayUnit || item.unit),
    valueMinor,
    isService: !!meta.isService
  };
}

/** Cena jedn. netto pokazywana w edytorze (grosze). */
const unitPriceMinorOf = (line) => Math.round(line.valueMinor / (line.quantity || 1));

/** Czym była pozycja, kiedy człowiek ją zmieniał — do wykrycia zmian zamówienia. */
const fingerprint = (l) => [l.name, l.description, l.quantity, l.unit, l.valueMinor].join('\u0001');

/**
 * Wartość netto linii z edytora. Ilość i cena jedn. bez zmian → wartość pozycji
 * bazowej co do grosza (zaokrąglona cena jedn. × ilość mogłaby dać inny grosz).
 */
function valueOf(desired, base) {
  const unitMinor = money.toMinor(Number(desired.unitPriceNet));
  const quantity = Number(desired.quantity);
  if (base && quantity === base.quantity && unitMinor === unitPriceMinorOf(base)) return base.valueMinor;
  return Math.round(quantity * unitMinor);
}

/**
 * Pozycje bazowe + linie z edytora → nakładka.
 * @param {Array<Record<string, any>>} baseItems  pozycje zbudowane z zamówienia (albo zapisane)
 * @param {Array<Record<string, any>>} desiredLines  linie z edytora, w kolejności
 */
function diffOverlay(baseItems, desiredLines) {
  const base = new Map(baseItems.map(lineOf).filter((l) => l.orderItemId).map((l) => [l.orderItemId, l]));
  const overlay = { lines: [], removed: [], base: {} };
  const seen = new Set();
  for (const d of desiredLines) {
    const b = d.orderItemId ? base.get(Number(d.orderItemId)) : null;
    if (b && !seen.has(b.orderItemId)) {
      seen.add(b.orderItemId);
      const want = { name: text(d.name), description: text(d.description), quantity: Number(d.quantity), unit: text(d.unit), valueMinor: valueOf(d, b) };
      const overrides = {};
      for (const f of FIELDS) if (want[f] !== b[f]) overrides[f] = want[f];
      overlay.lines.push({ orderItemId: b.orderItemId, overrides });
      if (Object.keys(overrides).length) overlay.base[b.orderItemId] = fingerprint(b);
    } else {
      // Linia ręczna — także kopia pozycji zamówienia (⧉) i pozycja spoza bazy
      overlay.lines.push({
        manual: { name: text(d.name), description: text(d.description), quantity: Number(d.quantity), unit: text(d.unit) || 'szt', valueMinor: valueOf(d, null), isService: !!d.isService }
      });
    }
  }
  for (const [id, b] of base) {
    if (!seen.has(id)) { overlay.removed.push(id); overlay.base[id] = fingerprint(b); }
  }
  const kept = overlay.lines.filter((l) => !l.manual).map((l) => l.orderItemId);
  overlay.reordered = kept.join(',') !== [...base.keys()].filter((id) => seen.has(id)).join(',');
  return overlay;
}

/** Czy nakładka niczego nie zmienia względem bazy (zapis bez zmian). */
function isNoop(overlay) {
  return !overlay || (!overlay.removed.length && !overlay.reordered
    && overlay.lines.every((l) => !l.manual && !Object.keys(l.overrides || {}).length));
}

function withOverrides(item, ov) {
  const meta = { ...(item.meta || {}), edited: Object.keys(ov) };
  const out = { ...item, meta };
  if ('name' in ov) out.name = ov.name;
  if ('description' in ov) out.description = ov.description;
  if ('unit' in ov) { out.unit = ov.unit; meta.displayUnit = ov.unit; }
  if ('quantity' in ov) meta.displayQuantity = ov.quantity;
  if ('valueMinor' in ov) {
    out.quantity = 1;
    out.unitPriceNetMinor = ov.valueMinor;
    out.discountPercent = 0;
    // Trzy kolumny rabatu (cena przed / rabat / po) nie pasowałyby do ręcznej ceny
    delete meta.priceBeforeDiscountMinor;
    delete meta.discountPercent;
  }
  return out;
}

function manualItem(m, resolveTax) {
  const tax = resolveTax({ isService: !!m.isService, isInstallation: false });
  return {
    name: m.name,
    description: m.description,
    unit: m.unit,
    quantity: 1,
    unitPriceNetMinor: m.valueMinor,
    discountPercent: 0,
    taxRate: tax.taxRate,
    taxCategory: tax.taxCategory,
    meta: { manual: true, isService: !!m.isService, displayQuantity: m.quantity, displayUnit: m.unit }
  };
}

/**
 * Nakładka na pozycje bazowe. Pozycje dopisane do zamówienia po edycji idą na
 * koniec bez zmian; pozycja bez `orderItemId` z bazy (stara linia ręczna zapisanej
 * faktury) znika — linie ręczne niesie sama nakładka.
 *
 * @param {Array<Record<string, any>>} baseItems
 * @param {ReturnType<typeof diffOverlay>|null} overlay
 * @param {{ resolveTax: (opts: { isService: boolean, isInstallation: boolean }) => { taxRate: number, taxCategory: string } }} deps
 * @returns {{ items: Array<Record<string, any>>, conflicts: Array<{ orderItemId: number, reason: 'changed'|'removed' }> }}
 */
function applyOverlay(baseItems, overlay, { resolveTax }) {
  if (!overlay) return { items: baseItems, conflicts: [] };
  const byId = new Map(baseItems.filter((it) => it.orderItemId).map((it) => [Number(it.orderItemId), it]));
  const changedSince = (id) => !!(overlay.base && overlay.base[id]) && byId.has(id) && fingerprint(lineOf(byId.get(id))) !== overlay.base[id];
  const used = new Set();
  const items = [];
  const conflicts = [];
  for (const ol of overlay.lines || []) {
    if (ol.manual) { items.push(manualItem(ol.manual, resolveTax)); continue; }
    const id = Number(ol.orderItemId);
    const it = byId.get(id);
    const touched = Object.keys(ol.overrides || {}).length > 0;
    if (!it) {
      if (touched) conflicts.push({ orderItemId: id, reason: 'removed' });
      continue;
    }
    used.add(id);
    if (touched && changedSince(id)) conflicts.push({ orderItemId: id, reason: 'changed' });
    items.push(touched ? withOverrides(it, ol.overrides) : it);
  }
  for (const id of overlay.removed || []) {
    if (!byId.has(Number(id))) continue;
    used.add(Number(id));
    if (changedSince(Number(id))) conflicts.push({ orderItemId: Number(id), reason: 'changed' });
  }
  for (const it of baseItems) {
    if (it.orderItemId && !used.has(Number(it.orderItemId))) items.push(it);
  }
  return { items, conflicts };
}

/** Błąd „nakładka nie pasuje do zamówienia” — automat rozpoznaje go po kodzie. */
function conflictError(conflicts, ref) {
  const err = new Error(`Ręczna edycja faktury (${ref}) nie pasuje do zamówienia — pozycje ${conflicts.map((c) => `${c.orderItemId} (${c.reason === 'removed' ? 'usunięta' : 'zmieniona'})`).join(', ')}. Do przejrzenia w edytorze.`);
  err.code = MANUAL_EDIT_CONFLICT_CODE;
  err.conflicts = conflicts;
  return err;
}

/**
 * Pozycja zapisana w bazie → postać kalkulatora (1 × wartość netto), żeby edycja
 * wystawionej faktury liczyła się tym samym kodem co budowanie z zamówienia.
 */
function rawFromSaved(item) {
  return {
    ...item,
    quantity: 1,
    unitPriceNetMinor: Number(item.netAmount),
    discountPercent: 0,
    meta: { ...(item.meta || {}), displayQuantity: item.meta?.displayQuantity ?? item.quantity, displayUnit: item.meta?.displayUnit || item.unit }
  };
}

/** Linie do edytora (cena jedn. w EUR) z pozycji bazowych albo zapisanych. */
function editorLines(items) {
  return items.map(lineOf).map((l) => ({
    orderItemId: l.orderItemId,
    name: l.name,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit || 'szt',
    unitPriceNet: unitPriceMinorOf(l) / 100,
    valueNet: l.valueMinor / 100,
    isService: l.isService
  }));
}

module.exports = {
  MANUAL_EDIT_CONFLICT_CODE,
  lineOf,
  diffOverlay,
  applyOverlay,
  conflictError,
  rawFromSaved,
  editorLines,
  isNoop
};
