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
 * ⚠️ ZERO CZYNNIKÓW. Składnik = jego kwota × czynnik `_S`, zaokrąglona jak
 * cennik, a suma zawsze równa KWOCIE WIDOCZNEJ w zleceniu
 * (`expression.allocateToTotal`); czynniki spoza `_S` (wariant skryptu
 * `Cmul1.1`, narzut grupy, mnożnik pracownika) idą proporcją. Klient widzi
 * gotowe kwoty — ani czynnika, ani sposobu, by go odczytać z różnicy sum.
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
const { isDisabledDefaultRow } = require('../orderService');

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
 * Które zestawy cen (zwykłe / `SUB___`) i czy wiersze „locked" (rabaty, ceny
 * po rabacie) widzi ten użytkownik przy tej pozycji — dokładnie warunki
 * szablonu, który ten użytkownik ma przed sobą:
 *
 * BEZ kłódki cen (`prices` = false) → templates/order.njk:
 *  • wiersz cen zwykłych: `not isGroupShop and not (isClient and itemHasSubPrices)
 *    and not hidePrices and not (hasSubPriceToggle and itemHasSubPrices and not showCatalogPrices)`,
 *  • wiersz `SUB___`: renderowany przy `isGroup or isGroupShop or canViewSubPrices
 *    or viewAsOrganization or (isClient and itemHasSubPrices)`, a WIDOCZNY przy
 *    `isGroupShop or (isClient and itemHasSubPrices) or (hasSubPriceToggle and
 *    itemHasSubPrices) or (isGroup and showSub) or (isGroup and discountPricesUnlocked)`;
 *    jego wiersze locked: kłódka rabatu grupy (`(isGroup or isGroupShop) and discountPricesUnlocked`).
 *
 * PO kłódce cen (`prices` = true — trasa renderuje templates/order_prices.njk,
 * który ma WŁASNE reguły):
 *  • ceny zwykłe: `not (isClient and hasSubPrices) and showCatalogPrices`
 *    (hasSubPrices = całego zlecenia), ich wiersze locked tylko `not hasSubPriceToggle`;
 *    pozycja BEZ cen `SUB___` u klienta/ownera/admina — ceny zwykłe z locked,
 *  • ceny `SUB___`: `(isClient and hasSubPrices) or hasSubPriceToggle` — razem
 *    z wierszami locked (owner/admin na kliencie spoza HKL widzi rabaty klienta).
 *
 * @param {object} view  stan widoku (locals zlecenia + kłódki — patrz trasa)
 * @param {boolean} itemHasSubPrices   `rowObj.item.subParamValues.length > 0`
 * @param {boolean} [orderHasSubPrices] to samo dla całego zlecenia (`hasSubPrices`)
 */
function resolveSetVisibility(view, itemHasSubPrices, orderHasSubPrices = itemHasSubPrices) {
  const v = view || {};
  const none = { regular: { visible: false, locked: false }, sub: { visible: false, locked: false, clientDiscount: false } };
  if (v.hidePrices) return none;
  const groupish = !!(v.isGroup || v.isGroupShop);

  if (v.prices) {
    const regularMain = !(v.isClient && orderHasSubPrices) && !!v.showCatalogPrices;
    const regularNoSub = !itemHasSubPrices && !!(v.isClient || v.hasSubPriceToggle || v.canViewSubPrices || v.viewAsOrganization);
    const regular = regularMain || regularNoSub;
    const regularLocked = (regularMain && !v.hasSubPriceToggle) || regularNoSub;
    const sub = itemHasSubPrices && (!!(v.isClient && orderHasSubPrices) || !!v.hasSubPriceToggle);
    return {
      regular: { visible: regular, locked: regular && regularLocked },
      sub: { visible: sub, locked: sub, clientDiscount: sub && groupish }
    };
  }

  const regular = !v.isGroupShop
    && !(v.isClient && itemHasSubPrices)
    && !(v.hasSubPriceToggle && itemHasSubPrices && !v.showCatalogPrices);
  const subRendered = itemHasSubPrices
    && !!(v.isGroup || v.isGroupShop || v.canViewSubPrices || v.viewAsOrganization || v.isClient);
  const subShown = !!(v.isGroupShop || v.isClient || v.hasSubPriceToggle
    || (v.isGroup && v.showSub) || (v.isGroup && v.discountPricesUnlocked));
  const sub = subRendered && subShown;
  const groupUnlocked = groupish && !!v.discountPricesUnlocked;
  return {
    regular: { visible: regular, locked: false },
    sub: { visible: sub, locked: sub && groupUnlocked, clientDiscount: sub && groupUnlocked }
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
function configSummary(descRows, limit = 6, values = null) {
  const out = [];
  for (const [key, row] of descRows) {
    if (out.length >= limit) break;
    if (!row || String(row.row) !== '1' || NON_CONFIG_RE.test(key) || /_S$/.test(key)) continue;
    if (values && isDisabledDefaultRow(key, row, values)) continue; // wyłączony, domyślne „0”
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
 * Specyfikacja zaawansowana (polecenie właściciela 2026-10-27): przy każdym
 * składniku ceny — sekcji (parametr) i jej składnikach (konkretne dopłaty) —
 * rabat i wartość po rabacie. Stawki (`rates`, param → ułamek) wylicza
 * `buildSetSpec` tą samą regułą co linie rabatów, więc obie specyfikacje
 * mówią to samo. Rabat składnika = kwota × stawka do grosza; suma rabatów
 * UZGADNIANA z ceną po rabacie z zlecenia (`target`) — grosz z zaokrągleń
 * trafia do największego rabatu. Gdy reguła się nie spina (`rates` = null:
 * ekstra rabat, pozycja liczona po staremu), składniki bez rabatu („—”),
 * a rzeczywista kwota rabatu tylko przy cenie jednostkowej i wartości.
 *
 * Dopisuje `adv` do sekcji i ich linii; zwraca kolumny wierszy sum.
 */
function advancedColumns({ sections, rates, target, unitPrice, unitAfter, lineTotal, totalAfter, quantity, money, lang }) {
  const cell = (amount, discountAmount, rate) => {
    const after = round2(amount - discountAmount);
    return {
      rate,
      rateText: discountAmount && rate ? percentText(round2(rate * 100), lang) : null,
      discount: discountAmount,
      discountText: discountAmount ? `− ${money(discountAmount)}` : null,
      after,
      afterText: money(after)
    };
  };
  const clear = () => sections.forEach((s) => { s.adv = null; s.lines.forEach((l) => { l.adv = null; }); });

  let unitDiscount = null;
  let byComponent = false;
  if (rates) {
    const entries = [];
    for (const s of sections) {
      const rate = rates.get(s.param) || 0;
      const holders = s.lines.length ? s.lines : [s];
      for (const h of holders) entries.push({ holder: h, amount: h.amount, rate, discount: round2(h.amount * rate) });
    }
    const computed = round2(entries.reduce((sum, e) => sum + e.discount, 0));
    const diff = target !== null ? round2(target - computed) : 0;
    if (Math.abs(diff) <= 0.01 * (entries.length + 1)) {
      if (diff && entries.length) {
        const biggest = entries.reduce((a, b) => (Math.abs(b.discount) > Math.abs(a.discount) ? b : a));
        biggest.discount = round2(biggest.discount + diff);
      }
      for (const e of entries) e.holder.adv = cell(e.amount, e.discount, e.rate);
      for (const s of sections) {
        if (!s.lines.length) continue;
        const d = round2(s.lines.reduce((sum, l) => sum + l.adv.discount, 0));
        s.adv = cell(s.amount, d, rates.get(s.param) || 0);
      }
      unitDiscount = round2(computed + diff);
      byComponent = true;
    }
  }
  if (!byComponent) {
    clear();
    if (target === null) return null;
    unitDiscount = target;
  }

  const unitAfterValue = unitAfter !== null ? unitAfter : round2(unitPrice - unitDiscount);
  const totalAfterValue = totalAfter !== null
    ? totalAfter
    : (lineTotal !== null ? round2(lineTotal - unitDiscount * quantity) : null);
  const totalDiscount = lineTotal !== null && totalAfterValue !== null ? round2(lineTotal - totalAfterValue) : null;
  return {
    byComponent,
    unit: { discount: unitDiscount, discountText: unitDiscount ? `− ${money(unitDiscount)}` : null, after: unitAfterValue, afterText: money(unitAfterValue) },
    total: totalAfterValue === null ? null : {
      discount: totalDiscount,
      discountText: totalDiscount ? `− ${money(totalDiscount)}` : null,
      after: totalAfterValue,
      afterText: money(totalAfterValue)
    }
  };
}

/**
 * Specyfikacja jednego zestawu cen (zwykłe albo `SUB___`) jednej pozycji.
 * @returns {object|null} `null`, gdy w tym zestawie nie ma żadnej kwoty do pokazania.
 */
function buildSetSpec({ prefix, factor, lockedVisible, clientDiscountVisible, values, descRows, scripts, groupNumber, t, money, lang, showCodes, dataDir, advanced = false }) {
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

  // ── Rabaty — tylko gdy wiersze „locked" są widoczne (kłódka) ──────────
  // Model z formuł `CENA_KONCOWA` w param.txt wszystkich grup:
  //   (CENA + DOPLATA)·(1 − CENA_RABAT) + DOPLATA_EL·(1 − DOPLATA_EL_RABAT)
  // a gdzie jest `DOPLATA_RABAT` (grupa 71) — CENA·(1 − CENA_RABAT)
  // + DOPLATA·(1 − DOPLATA_RABAT) + DOPLATA_EL·(1 − DOPLATA_EL_RABAT);
  // grupa 01 ma dla elektryki `CENA_EL_RABAT` zamiast `CENA_RABAT`.
  // Każdy udzielony rabat = osobna linia (procent, podstawa, kwota). Suma
  // linii jest UZGADNIANA z ceną po rabacie z zlecenia (`CENA_KONCOWA`) —
  // reguła zgadza się z ~93% zapisanych pozycji; gdy się nie spina (rabat
  // klienta grupy ZASTĘPUJE cennikowy — pricesCalculator.applyClientDiscount —
  // albo pozycja liczona po staremu), pokazujemy rzeczywistą kwotę, a nie
  // zmyślone rozbicie.
  const discount = [];
  let unitAfter = null;
  let totalAfter = null;
  // Stawka rabatu każdej sekcji (param → ułamek) dla specyfikacji zaawansowanej —
  // ta sama reguła co linie rabatów niżej; `null` = rabat bez rozbicia na składniki.
  let rates = null;
  let target = null;
  let adv = null;
  const discountVisible = !!(lockedVisible || clientDiscountVisible);
  if (discountVisible) {
    const sectionAmount = (param) => (sections.find((x) => x.param === param) || {}).amount || 0;
    const rateOf = (param) => {
      const row = visibleRow(prefix + param);
      if (!row) return null;
      // `values` niesie ułamek (0.6) dokładniej niż opis („60%", obcięty do całości).
      const raw = toNumber(values[prefix + param]);
      let rate = raw !== null ? (raw > 1 ? raw / 100 : raw) : null;
      if (rate === null) {
        const shown = toNumber(row.option_value);
        if (shown === null) return null;
        rate = String(row.option_value).includes('%') || shown > 1 ? shown / 100 : shown;
      }
      return rate > 0 ? rate : null;
    };
    const separateSurcharge = descRows.has(prefix + 'DOPLATA_RABAT') || values[prefix + 'DOPLATA_RABAT'] !== undefined;
    const elPriceRate = rateOf('CENA_EL_RABAT');
    const priceRate = elPriceRate || rateOf('CENA_RABAT');
    const rules = [];
    if (priceRate) {
      const base = round2(sectionAmount('CENA') + (separateSurcharge ? 0 : sectionAmount('DOPLATA') + sectionAmount('OTHER')));
      rules.push({ key: elPriceRate ? 'discount_el' : 'discount_price_list', rate: priceRate, base });
    }
    const surchargeRate = rateOf('DOPLATA_RABAT');
    if (surchargeRate && sectionAmount('DOPLATA')) rules.push({ key: 'discount_surcharge', rate: surchargeRate, base: sectionAmount('DOPLATA') });
    const elRate = rateOf('DOPLATA_EL_RABAT');
    if (elRate && sectionAmount('DOPLATA_EL')) rules.push({ key: 'discount_el', rate: elRate, base: sectionAmount('DOPLATA_EL') });

    const lineOf = (label, ratePct, base, amount) => ({
      label,
      detail: ratePct !== null && base !== null ? t('discount_of', { pct: percentText(ratePct, lang), base: money(base) }) : (ratePct !== null ? percentText(ratePct, lang) : null),
      amount,
      amountText: `− ${money(amount)}`
    });
    let lines = rules.filter((r) => r.base > 0).map((r) => lineOf(t(r.key), round2(r.rate * 100), r.base, round2(r.base * r.rate)));
    const ruleRates = () => new Map([
      ['CENA', priceRate || 0],
      ['OTHER', separateSurcharge ? 0 : (priceRate || 0)],
      ['DOPLATA', separateSurcharge ? (surchargeRate || 0) : (priceRate || 0)],
      ['DOPLATA_EL', elRate || 0]
    ]);

    const clientRow = clientDiscountVisible ? rowOf(prefix + 'RABAT_KLIENTA') : null;
    const clientPct = clientRow ? toNumber(clientRow.option_value) : null;

    unitAfter = amountOf(prefix + 'CENA_KONCOWA');
    totalAfter = amountOf(prefix + 'WARTOSC_KONCOWA');
    if (unitAfter !== null && unitPrice !== null) {
      const actual = round2(unitPrice - unitAfter);
      const computed = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      target = Math.max(0, actual);
      if (actual <= 0.004) {
        lines = [];
        rates = new Map();
      } else if (clientPct) {
        // Rabat klienta grupy (od 2026-10-27 — pricesCalculator.clientDiscountBreakdown)
        // ZASTĘPUJE cennikowy tylko na CENIE KATALOGOWEJ; dopłaty mają swoje rabaty
        // z konfiguratora: `DOPLATA` — osobny `DOPLATA_RABAT` (grupa 71), inaczej
        // cennikowy (stoi w nawiasie z ceną), dopłata EL — `DOPLATA_EL_RABAT` („RABAT
        // EL”). Każdy rabat osobną linią; pozycja liczona po staremu (rabat klienta od
        // całej ceny z dopłatami) albo z ekstra rabatem nie spina się — wtedy jedna
        // linia z rzeczywistą kwotą, bez zmyślonego rozbicia.
        const clientLabel = cleanTitle(clientRow.param_description) || t('client_discount');
        const doplata = sectionAmount('DOPLATA');
        const doplataEl = sectionAmount('DOPLATA_EL');
        const catalogBase = round2(unitPrice - doplata - doplataEl);
        const doplataRate = separateSurcharge ? rateOf('DOPLATA_RABAT') : rateOf('CENA_RABAT');
        const groupLines = [lineOf(clientLabel, clientPct, catalogBase, round2(catalogBase * clientPct / 100))];
        if (doplata && doplataRate) groupLines.push(lineOf(t('discount_surcharge'), round2(doplataRate * 100), doplata, round2(doplata * doplataRate)));
        if (doplataEl && elRate) groupLines.push(lineOf(t('discount_el'), round2(elRate * 100), doplataEl, round2(doplataEl * elRate)));
        const groupSum = round2(groupLines.reduce((sum, l) => sum + l.amount, 0));
        if (catalogBase > 0 && Math.abs(groupSum - actual) <= 0.01 * (groupLines.length + 1)) {
          // Zaokrąglenia — ostatni grosz trafia do największego rabatu.
          const biggest = groupLines.reduce((a, b) => (b.amount > a.amount ? b : a));
          const fixed = round2(biggest.amount + actual - groupSum);
          Object.assign(biggest, { amount: fixed, amountText: `− ${money(fixed)}` });
          lines = groupLines;
          rates = new Map([
            ['CENA', clientPct / 100],
            ['OTHER', clientPct / 100],
            ['DOPLATA', doplata && doplataRate ? doplataRate : 0],
            ['DOPLATA_EL', doplataEl && elRate ? elRate : 0]
          ]);
        } else {
          lines = [lineOf(clientLabel, clientPct, unitPrice, actual)];
        }
      } else if (lines.length && Math.abs(computed - actual) <= 0.01 * (lines.length + 1)) {
        // Zaokrąglenia — ostatni grosz trafia do największego rabatu.
        const biggest = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
        const fixed = round2(biggest.amount + actual - computed);
        Object.assign(biggest, { amount: fixed, amountText: `− ${money(fixed)}` });
        rates = ruleRates();
      } else {
        const percents = rules.map((r) => percentText(round2(r.rate * 100), lang)).join(' · ');
        lines = [{ label: t('discount'), detail: percents || null, amount: actual, amountText: `− ${money(actual)}` }];
      }
    } else if (unitPrice !== null && lines.length) {
      // Brak widocznej ceny po rabacie — liczymy ją z rabatów (ta sama reguła co formuła).
      unitAfter = round2(unitPrice - lines.reduce((sum, l) => sum + l.amount, 0));
      totalAfter = round2(unitAfter * quantity);
      rates = ruleRates();
      target = round2(unitPrice - unitAfter);
    } else if (unitPrice !== null) {
      rates = new Map(); // ani stawek, ani ceny po rabacie — rabatu nie ma
    }
    if (advanced && unitPrice !== null) {
      adv = advancedColumns({ sections, rates, target, unitPrice, unitAfter, lineTotal, totalAfter, quantity, money, lang });
    }
    discount.push(...lines);
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
    totalAfterText: totalAfter !== null ? money(totalAfter) : null,
    discountVisible,
    adv
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
 * @param {boolean} [params.advanced] specyfikacja zaawansowana — przy każdym składniku
 *                                    rabat i wartość po rabacie (`advancedColumns`)
 */
function buildOrderPriceSpec({ orderDetails, orderItems, view, lang, currency, scriptsByGroup = {}, showCodes = false, now = new Date(), dataDir, advanced = false }) {
  const language = resolveLang(lang);
  const t = translator(language);
  const money = moneyFormatter(language, currency);
  const priceFactor = Number(view && view.priceFactor) > 0 ? Number(view.priceFactor) : 1;

  // `hasSubPrices` widoku zlecenia (order_prices.njk liczy je dla CAŁEGO zlecenia).
  const orderHasSubPrices = (orderItems || []).some((i) => Array.isArray(i.subParamValues) && i.subParamValues.length > 0);
  const positions = [];
  (orderItems || []).forEach((item, index) => {
    const values = parseJson(item.json_parameters) || {};
    const descRaw = parseJson(item.json_parameters_desc);
    const descRows = new Map(Array.isArray(descRaw) ? descRaw : []);
    const itemHasSubPrices = Array.isArray(item.subParamValues) && item.subParamValues.length > 0;
    const visibility = resolveSetVisibility(view, itemHasSubPrices, orderHasSubPrices);
    const groupNumber = item.asortment_group_number;
    const scripts = scriptsByGroup[groupNumber] || {};
    const common = { values, descRows, scripts, groupNumber, t, money, lang: language, showCodes, dataDir, advanced };

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
      config: configSummary(descRows, 6, values),
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
    // Zaawansowana: wartość po rabacie z kolumn pozycji (bez rabatu = wartość pozycji).
    const advAll = advanced && withSet.every((x) => x.adv && x.adv.total);
    const advAfter = advAll ? round2(withSet.reduce((s, x) => s + x.adv.total.after, 0)) : null;
    const advDiscount = advAll ? round2(total - advAfter) : null;
    summary.push({
      key,
      title: summary.length || positions.some((p) => p.sets.length > 1) ? t(key === 'sub' ? 'set_client' : 'set_purchase') : null,
      positions: withSet.length,
      total,
      totalText: money(total),
      totalAfter,
      totalAfterText: totalAfter !== null ? money(totalAfter) : null,
      adv: advAll ? {
        discount: advDiscount,
        discountText: advDiscount ? `− ${money(advDiscount)}` : null,
        after: advAfter,
        afterText: money(advAfter)
      } : null
    });
  }
  if (summary.length === 1) summary[0].title = null;

  return {
    lang: language,
    advanced: !!advanced,
    // Kłódka cen już otwarta (order_prices.njk) — zestaw bez kolumn rabatu nie dostaje
    // podpowiedzi „po kłódce” (np. cena zakupu przy przełączniku SUB nie ma rabatów).
    pricesUnlocked: !!(view && view.prices),
    t: templateStrings(t, currency || 'EUR', advanced),
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
    summaryDiscounts: summary.some((s) => s.adv),
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
function templateStrings(t, currency, advanced = false) {
  const keys = ['title', 'order', 'commission', 'date', 'generated', 'position', 'quantity', 'unit_price', 'line_total', 'discounts',
    'unit_after_discount', 'total_after_discount', 'summary', 'positions', 'total', 'total_after_discount_sum',
    'component', 'amount', 'code', 'print', 'pdf', 'close', 'empty', 'no_breakdown',
    'col_component', 'col_value', 'col_discount', 'col_after', 'discounts_hidden', 'discount_total_only'];
  const out = {};
  for (const k of keys) out[k] = t(k);
  if (advanced) out.title = t('advanced_title');
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
