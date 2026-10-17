'use strict';

/**
 * Specyfikacja ceny zlecenia — „z czego składa się cena": cena bazowa wg
 * cennika, każda dopłata rozpisana na składniki, cena jednostkowa, wartość
 * pozycji, rabat i podsumowanie (prośba szefa, 2026-10-16).
 *
 * Źródła danych pozycji:
 *  • `json_parameters_desc` — kwoty, które użytkownik WIDZI w zleceniu
 *    (te same, z których rysuje `templates/order.njk`), i nazwy opcji,
 *  • `json_parameters` — wyrażenia `<PARAM>_S` ze skryptów cennika
 *    (zapisywane zawsze, niezależnie od `PRICE_SPEC_ENABLED`, które steruje
 *    tylko starymi wierszami „-spec").
 *
 * ⚠️ ZERO CZYNNIKÓW. Składniki są rozkładane na KWOTĘ WIDOCZNĄ w zleceniu
 * (`expression.allocateToTotal`), więc nie widać ani czynnika klienta
 * (`*1.035`), ani czynnika wariantu skryptu (`Cmul1.1`), ani narzutu grupy,
 * ani mnożnika pracownika — i nie da się ich odczytać z różnicy sum.
 *
 * ⚠️ WIDOCZNOŚĆ 1:1 Z TABELĄ ZLECENIA. `resolveSetVisibility` odwzorowuje
 * warunki z `order.njk` (wiersz cen zwykłych, wiersz `SUB___`, wiersze
 * „locked" pod kłódką), więc specyfikacja nigdy nie pokaże ceny, której
 * użytkownik nie widzi w tabeli — np. klient grupy nie zobaczy ceny zakupu,
 * a rabat pojawi się dopiero po odsłonięciu kłódki.
 */

const { parseSpecExpression, allocateToTotal } = require('./expression');
const { conditionsForParam, labelForCode, cleanTitle, optionText } = require('./scriptLabels');
const { translator, resolveLang } = require('./i18n');

/** Składniki ceny jednostkowej, w kolejności pokazywania. */
const SECTION_PARAMS = ['CENA', 'DOPLATA', 'DOPLATA_EL'];
/** Wiersze, które nie są parametrami konfiguracji (nie idą do opisu pozycji). */
const NON_CONFIG_RE = /^(SUB___|ILOSC$|VAT$|WARTOSC_|RABAT_KLIENTA$|OPIS_)/;

function parseJson(raw) {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value); } catch (_e) { return null; }
  }
  return value;
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** „300.70", „56%", „1 234,50" → liczba; puste, „-" i tekst („Według cennika") → null. */
function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\s| /g, '').replace('%', '');
  if (!text || text === '-') return null;
  const normalized = /^-?\d+(,\d+)?$/.test(text) ? text.replace(',', '.') : text;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Które zestawy cen (zwykłe / `SUB___`) i czy wiersze „locked" widzi ten
 * użytkownik przy tej pozycji — dokładnie warunki z templates/order.njk:
 *  • wiersz cen zwykłych: `not isGroupShop and not (isClient and itemHasSubPrices)
 *    and not hidePrices and not (hasSubPriceToggle and itemHasSubPrices and not showCatalogPrices)`,
 *    wiersze locked — po odblokowaniu cen (`prices`, kłódka „złotych" cen),
 *  • wiersz `SUB___`: renderowany przy `isGroup or isGroupShop or canViewSubPrices
 *    or viewAsOrganization or (isClient and itemHasSubPrices)`, a WIDOCZNY przy
 *    `isGroupShop or (isClient and itemHasSubPrices) or (hasSubPriceToggle and
 *    itemHasSubPrices) or (isGroup and showSub) or (isGroup and discountPricesUnlocked)`;
 *    jego wiersze locked: `(not isOrgView and prices) or ((isGroup or isGroupShop)
 *    and discountPricesUnlocked)`.
 *
 * @param {object} view  stan widoku (locals zlecenia + kłódki — patrz trasa)
 * @param {boolean} itemHasSubPrices  `rowObj.item.subParamValues.length > 0`
 */
function resolveSetVisibility(view, itemHasSubPrices) {
  const v = view || {};
  const isOrgView = !!(v.isOrgAccount || v.viewAsOrganization);
  const regular = !v.hidePrices && !v.isGroupShop
    && !(v.isClient && itemHasSubPrices)
    && !(v.hasSubPriceToggle && itemHasSubPrices && !v.showCatalogPrices);
  const subRendered = itemHasSubPrices
    && !!(v.isGroup || v.isGroupShop || v.canViewSubPrices || v.viewAsOrganization || v.isClient);
  const subShown = !!(v.isGroupShop || v.isClient || v.hasSubPriceToggle
    || (v.isGroup && v.showSub) || (v.isGroup && v.discountPricesUnlocked));
  const sub = !v.hidePrices && subRendered && subShown;
  return {
    regular: { visible: regular, locked: regular && !!v.prices },
    sub: {
      visible: sub,
      locked: sub && ((!isOrgView && !!v.prices) || (!!(v.isGroup || v.isGroupShop) && !!v.discountPricesUnlocked)),
      clientDiscount: sub && !!(v.isGroup || v.isGroupShop) && !!v.discountPricesUnlocked
    }
  };
}

function moneyFormatter(lang, currency) {
  let fmt;
  try {
    fmt = new Intl.NumberFormat(lang, { style: 'currency', currency: currency || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch (_e) {
    fmt = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' });
  }
  return (n) => (Number.isFinite(n) ? fmt.format(n) : '');
}

function percentText(n, lang) {
  try {
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(n) + ' %';
  } catch (_e) {
    return `${n} %`;
  }
}

/** Opis konfiguracji pozycji: kilka pierwszych wierszy z `row: 1` (jak nagłówek tabeli). */
function configSummary(descRows, limit = 6) {
  const out = [];
  for (const [key, row] of descRows) {
    if (out.length >= limit) break;
    if (!row || String(row.row) !== '1' || NON_CONFIG_RE.test(key) || /_S$/.test(key)) continue;
    const text = optionText(row);
    if (!text) continue;
    out.push({ label: cleanTitle(row.param_description) || key, value: text });
  }
  return out;
}

/** `PG4`, `U25PG4`, `H50PG1`, `TCNDPG2`, `PG5SL` → „4"; `PGE` → „E". */
function priceGroupOf(code) {
  const digits = /PG(\d+)/i.exec(code);
  if (digits) return digits[1];
  return /PGE(?![A-Za-z])/i.test(code) ? 'E' : null;
}

/**
 * Specyfikacja jednego zestawu cen (zwykłe albo `SUB___`) jednej pozycji.
 * @returns {object|null} `null`, gdy w tym zestawie nie ma żadnej kwoty do pokazania.
 */
function buildSetSpec({ prefix, factor, lockedVisible, clientDiscountVisible, values, descRows, scripts, groupNumber, t, money, lang, showCodes, dataDir }) {
  const rowOf = (key) => descRows.get(key) || null;
  const visibleRow = (key) => {
    const row = rowOf(key);
    if (!row) return null;
    if (row.locked === true && !lockedVisible) return null;
    return row;
  };
  const amountOf = (key) => {
    const row = visibleRow(key);
    const n = row ? toNumber(row.option_value) : null;
    return n === null ? null : round2(n * factor);
  };

  const sections = [];
  for (const param of SECTION_PARAMS) {
    const key = prefix + param;
    const amount = amountOf(key);
    if (!amount) continue;
    const row = rowOf(key);
    const parsed = parseSpecExpression(values[`${key}_S`]);
    const items = parsed.items.filter((i) => i.amount !== 0);
    const allocated = allocateToTotal(items, amount);
    const conditions = allocated ? conditionsForParam(groupNumber, key, { scriptFile: scripts[key] || scripts[param], dataDir }) : new Map();
    const isBase = param === 'CENA';
    const lines = [];
    if (allocated) {
      items.forEach((item, idx) => {
        if (allocated[idx] === 0) return;
        const condition = labelForCode(item.code, { conditions, values, descRows });
        const group = isBase ? priceGroupOf(item.code) : null;
        const groupText = group ? capitalize(t('price_group', { n: group })) : null;
        // Cena bazowa: wiersz = grupa cenowa, a opcje, z których wynika, pod
        // spodem jako szczegół. Dopłata: wiersz = opcja, która ją wywołała.
        const label = groupText || condition || (isBase ? t('base_price') : item.code);
        lines.push({
          label,
          detail: condition && condition !== label ? condition : null,
          code: showCodes ? item.code : null,
          amount: allocated[idx],
          amountText: money(allocated[idx])
        });
      });
    }
    sections.push({
      param,
      kind: isBase ? 'base' : 'surcharge',
      title: isBase ? t('base_price') : (cleanTitle(row && row.param_description) || t('surcharge')),
      amount,
      amountText: money(amount),
      breakdown: lines.length > 0,
      lines
    });
  }

  const sectionsSum = round2(sections.reduce((s, x) => s + x.amount, 0));
  const unitRowAmount = amountOf(prefix + 'CENA_SUMA');
  const unitPrice = unitRowAmount !== null ? unitRowAmount : (sections.length ? sectionsSum : null);
  // Składniki ceny jednostkowej spoza CENA/DOPLATA/DOPLATA_EL (np. rabat na
  // elektrykę) — pokazane jako jedna linia, żeby suma zawsze się zgadzała.
  if (unitPrice !== null && sections.length && Math.abs(unitPrice - sectionsSum) >= 0.01) {
    const diff = round2(unitPrice - sectionsSum);
    sections.push({ param: 'OTHER', kind: 'other', title: t('other_components'), amount: diff, amountText: money(diff), breakdown: false, lines: [] });
  }

  const quantity = toNumber(values.ILOSC) ?? toNumber(rowOf('ILOSC') && rowOf('ILOSC').option_value) ?? 1;
  const lineTotalRow = amountOf(prefix + 'SUMA_BRUTTO') ?? amountOf(prefix + 'SUMA_NETTO');
  const lineTotal = lineTotalRow !== null ? lineTotalRow : (unitPrice !== null ? round2(unitPrice * quantity) : null);

  const discount = [];
  if (lockedVisible) {
    const rabatRow = visibleRow(prefix + 'CENA_RABAT');
    const rabat = rabatRow ? toNumber(rabatRow.option_value) : null;
    // W opisie rabat stoi jako „56%" (FORMAT n%); bez znaku % to ułamek (0.56).
    const pct = rabat === null ? null : (String(rabatRow.option_value).includes('%') ? rabat : round2(rabat * 100));
    if (pct) discount.push({ key: 'discount', label: cleanTitle(rabatRow.param_description) || t('discount'), text: percentText(pct, lang) });
  }
  if (clientDiscountVisible) {
    const clientPct = toNumber(rowOf(prefix + 'RABAT_KLIENTA') && rowOf(prefix + 'RABAT_KLIENTA').option_value);
    if (clientPct) discount.push({ key: 'client_discount', label: cleanTitle(rowOf(prefix + 'RABAT_KLIENTA').param_description) || t('client_discount'), text: percentText(clientPct, lang) });
  }
  let unitAfter = null;
  let totalAfter = null;
  if (lockedVisible || clientDiscountVisible) {
    unitAfter = amountOf(prefix + 'CENA_KONCOWA');
    totalAfter = amountOf(prefix + 'WARTOSC_KONCOWA');
    // Bez rabatu „po rabacie" = to samo co wyżej — nie dublujemy wierszy.
    if (!discount.length) { unitAfter = null; totalAfter = null; }
  }

  // Zestaw bez żadnej dodatniej kwoty (np. ceny klienta jeszcze niepoliczone
  // — same zera) to szum, nie specyfikacja.
  if (!sections.length && !(unitPrice > 0) && !(lineTotal > 0)) return null;
  return {
    sections,
    unitPrice,
    unitPriceText: money(unitPrice),
    quantity,
    lineTotal,
    lineTotalText: money(lineTotal),
    discount,
    unitAfter,
    unitAfterText: unitAfter !== null ? money(unitAfter) : null,
    totalAfter,
    totalAfterText: totalAfter !== null ? money(totalAfter) : null
  };
}

/**
 * @param {object} params
 * @param {object} params.orderDetails
 * @param {Array}  params.orderItems  wiersze `order_item` PO `orderService.jsonTextBackToMap`
 *                                    (potrzebne `item.subParamValues`, jak w widoku)
 * @param {object} params.view        patrz `resolveSetVisibility` + `priceFactor`
 * @param {string} params.lang
 * @param {string} [params.currency]  `priceCurrency` zlecenia (services/currency.js)
 * @param {object} [params.scriptsByGroup]  `{ [grupa]: { [param]: plik skryptu klienta } }`
 * @param {boolean} [params.showCodes]  kody cennika przy składnikach (tylko dla HKL)
 * @param {string} [params.dataDir]   katalog danych grup (testy; domyślnie config.js)
 */
function buildOrderPriceSpec({ orderDetails, orderItems, view, lang, currency, scriptsByGroup = {}, showCodes = false, now = new Date(), dataDir }) {
  const language = resolveLang(lang);
  const t = translator(language);
  const money = moneyFormatter(language, currency);
  const priceFactor = Number(view && view.priceFactor) > 0 ? Number(view.priceFactor) : 1;

  const positions = [];
  (orderItems || []).forEach((item, index) => {
    const values = parseJson(item.json_parameters) || {};
    const descRaw = parseJson(item.json_parameters_desc);
    const descRows = new Map(Array.isArray(descRaw) ? descRaw : []);
    const itemHasSubPrices = Array.isArray(item.subParamValues) && item.subParamValues.length > 0;
    const visibility = resolveSetVisibility(view, itemHasSubPrices);
    const groupNumber = item.asortment_group_number;
    const scripts = scriptsByGroup[groupNumber] || {};
    const common = { values, descRows, scripts, groupNumber, t, money, lang: language, showCodes, dataDir };

    const sets = [];
    if (visibility.regular.visible) {
      const spec = buildSetSpec({ ...common, prefix: '', factor: priceFactor, lockedVisible: visibility.regular.locked, clientDiscountVisible: false });
      if (spec) sets.push({ key: 'regular', ...spec });
    }
    if (visibility.sub.visible) {
      const spec = buildSetSpec({ ...common, prefix: 'SUB___', factor: 1, lockedVisible: visibility.sub.locked, clientDiscountVisible: visibility.sub.clientDiscount });
      if (spec) sets.push({ key: 'sub', ...spec });
    }
    if (!sets.length) return;
    const both = sets.length > 1;
    for (const s of sets) s.title = both ? t(s.key === 'sub' ? 'set_client' : 'set_purchase') : null;
    positions.push({
      number: index + 1,
      id: item.id,
      name: item.group_name || null,
      commission: item.commision || null,
      config: configSummary(descRows),
      quantity: sets[0].quantity,
      quantityText: `${sets[0].quantity} ${t('pcs')}`,
      sets
    });
  });

  // Podsumowanie per zestaw — sumy wartości pokazanych przy pozycjach.
  const summary = [];
  for (const key of ['regular', 'sub']) {
    const withSet = positions.map((p) => p.sets.find((s) => s.key === key)).filter(Boolean);
    if (!withSet.length) continue;
    const total = round2(withSet.reduce((s, x) => s + (x.lineTotal || 0), 0));
    const allAfter = withSet.every((x) => x.totalAfter !== null);
    const totalAfter = allAfter ? round2(withSet.reduce((s, x) => s + x.totalAfter, 0)) : null;
    summary.push({
      key,
      title: summary.length || positions.some((p) => p.sets.length > 1) ? t(key === 'sub' ? 'set_client' : 'set_purchase') : null,
      positions: withSet.length,
      total,
      totalText: money(total),
      totalAfter,
      totalAfterText: totalAfter !== null ? money(totalAfter) : null
    });
  }
  if (summary.length === 1) summary[0].title = null;

  return {
    lang: language,
    t: templateStrings(t, currency || 'EUR'),
    currency: currency || 'EUR',
    order: {
      id: orderDetails && orderDetails.id,
      number: orderDetails && (orderDetails.order_idx || orderDetails.id),
      commission: orderDetails && orderDetails.commision,
      date: formatDate(orderDetails && (orderDetails.sent_date || orderDetails.created_date), language),
      generated: formatDate(now, language, true)
    },
    positions,
    summary,
    empty: positions.length === 0
  };
}

function formatDate(value, lang, withTime = false) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(lang, withTime
      ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' }
      : { dateStyle: 'medium', timeZone: 'Europe/Warsaw' }).format(d);
  } catch (_e) {
    return d.toISOString().slice(0, 10);
  }
}

/** Gotowe teksty dla szablonu (bez wywoływania funkcji z Nunjucks). */
function templateStrings(t, currency) {
  const keys = ['title', 'order', 'commission', 'date', 'generated', 'position', 'quantity', 'unit_price', 'line_total',
    'unit_after_discount', 'total_after_discount', 'summary', 'positions', 'total', 'total_after_discount_sum',
    'component', 'amount', 'code', 'print', 'pdf', 'close', 'empty', 'no_breakdown'];
  const out = {};
  for (const k of keys) out[k] = t(k);
  out.note = t('note', { currency });
  return out;
}

module.exports = {
  buildOrderPriceSpec,
  buildSetSpec,
  resolveSetVisibility,
  toNumber,
  priceGroupOf,
  configSummary
};
