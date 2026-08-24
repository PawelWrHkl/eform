const { getEffectiveOrgId } = require('./subPriceContext');

const HKL_ORG_ID = 3;

/**
 * Bazowa kwota do rabatu klienta: HKL → zwykłe ceny, inne org → SUB___ (subVisible).
 */
function resolveDiscountBaseTotal(orgId, totals, subTotals) {
  const isHkl = orgId == null || Number(orgId) === HKL_ORG_ID;
  if (isHkl) {
    return parseFloat(totals?.visible) || 0;
  }
  const subVisible = subTotals?.subVisible ?? parseFloat(totals?.sub);
  if (subVisible != null && !Number.isNaN(subVisible) && Number(subVisible) !== 0) {
    return Number(subVisible);
  }
  return parseFloat(totals?.visible) || 0;
}

/**
 * Zwraca true jeśli przynajmniej jedna pozycja ma niepuste subParamValues.
 */
function orderHasSubPrices(cleanOrderItems) {
  if (!Array.isArray(cleanOrderItems)) return false;
  for (const table of cleanOrderItems) {
    if (!table?.rows) continue;
    for (const rowObj of table.rows) {
      const subVals = rowObj?.item?.subParamValues;
      if (Array.isArray(subVals) && subVals.length > 0) return true;
    }
  }
  return false;
}

/**
 * Suma „wartości po rabacie klienta grupy" ze WSZYSTKICH pozycji zamówienia —
 * dokładnie tych liczb, które widok pokazuje przy pozycjach jako „Wartość po
 * rabacie" (`SUB___WARTOSC_PO_RABACIE`, patrz
 * public/scripts/formTools/pricesCalculator.js).
 *
 * ⚠️ Nie da się jej zastąpić `SUM(order_item.total_price_sub)`: ta kolumna
 * powstaje z `form.js getTotal()` i dla pozycji zapisanych przed zmianą
 * podstawy rabatu bywa policzona z innej liczby (np. 14,27 zamiast 40,77) —
 * stopka rozjeżdżałaby się z wierszami pozycji. Tu sumujemy to samo, co widać.
 *
 * ⚠️ Klucz bez prefiksu (`WARTOSC_PO_RABACIE`) też liczymy — tak nazywały się
 * wiersze rabatu zapisane przed 2026-08-21 (patrz services/orderService.js).
 */
function calcClientDiscountTotal(orderItems) {
  let total = 0;
  let found = false;
  if (!Array.isArray(orderItems)) return { total: 0, found: false };

  for (const item of orderItems) {
    let parsed = item?.json_parameters_desc;
    try {
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const entries = parsed instanceof Map
      ? Array.from(parsed.entries())
      : (Array.isArray(parsed) ? parsed : Object.entries(parsed));

    for (const [key, param] of entries) {
      if (key !== 'SUB___WARTOSC_PO_RABACIE' && key !== 'WARTOSC_PO_RABACIE') continue;
      const val = parseFloat(param && typeof param === 'object' ? param.option_value : param);
      if (!isFinite(val)) continue;
      total += val;
      found = true;
    }
  }
  return { total: parseFloat(total.toFixed(2)), found };
}

/**
 * Wylicza dwa osobne sumy SUB cen z `orderItems`:
 *  - subVisible: suma SUB params z listsum=true i NIE-locked
 *  - subLocked: suma SUB params z listsum=true i locked=true
 * Per pozycja bierzemy ostatnią wartość listsum (overwrite semantics).
 */
function calcSubTotals(orderItems) {
  let subVisible = 0;
  let subLocked = 0;
  if (!Array.isArray(orderItems)) return { subVisible, subLocked };

  for (const item of orderItems) {
    let parsed = item?.json_parameters_desc;
    try {
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const entries = parsed instanceof Map
      ? Array.from(parsed.entries())
      : (Array.isArray(parsed) ? parsed : Object.entries(parsed));

    let itemVisible = 0;
    let itemLocked = 0;
    for (const [key, param] of entries) {
      if (!key || !key.startsWith('SUB___') || !param || typeof param !== 'object') continue;
      if (!param.listsum) continue;
      const val = parseFloat(param.option_value);
      if (!isFinite(val)) continue;
      if (param.locked === true) {
        itemLocked = val;
      } else {
        itemVisible = val;
      }
    }
    subVisible += itemVisible;
    subLocked += itemLocked;
  }
  return {
    subVisible: parseFloat(subVisible.toFixed(2)),
    subLocked: parseFloat(subLocked.toFixed(2))
  };
}

/**
 * Określa tryb wyświetlania cen SUB w PDF / mailu (zgodny z widokiem strony).
 */
function resolveSubPricePdfView(req, hasSubPrices) {
  const effectiveOrgId = getEffectiveOrgId(req);
  const nonHklOrg = effectiveOrgId != null && Number(effectiveOrgId) !== 3;
  const sessionUser = req.session?.user;
  const contextUser = req.session?.context_user;
  const showSubActive = sessionUser?.showSubParams || false;

  const isPureClient = !sessionUser?.isOwner && !sessionUser?.isAdmin
    && !sessionUser?.isEmployee && !sessionUser?.isGroup && !sessionUser?.isGroupShop
    && nonHklOrg;

  const hasSubToggle = nonHklOrg && (
    (sessionUser?.isOwner && !sessionUser?.isAdmin) ||
    (sessionUser?.isAdmin && !!contextUser)
  );

  // Użytkownik grupowy (np. TCN — klient HKL z rolą "group"): na stronie sub params
  // są sterowane togglem showSub niezależnie od organizacji (isGroup and showSub).
  // isGroup jest liczone tak samo jak w widoku (routes/orders.js): sesja LUB kontekst.
  // PDF ma odwzorować ten sam widok — ceny zwykłe + sub params, gdy odkryte.
  const isGroup = sessionUser?.isGroup || contextUser?.isGroup || false;
  const groupShowBoth = isGroup && showSubActive && hasSubPrices;

  const isClientView = (isPureClient || (hasSubToggle && !showSubActive)) && hasSubPrices;
  const showBoth = (hasSubToggle && showSubActive && hasSubPrices) || groupShowBoth;

  return { isClientView, showBoth, hasSubToggle, isPureClient, showSubActive, nonHklOrg };
}

/**
 * Buduje etykietowane totale do PDF / maila — ta sama logika co na stronie zamówienia.
 */
function buildPdfSendDataTotals({
  isClientView,
  showBoth,
  orderItems,
  totalPrice,
  translate,
  showGoldPrices = true
}) {
  const __ = translate || ((key) => key);

  if (isClientView) {
    const subTotals = calcSubTotals(orderItems);
    return {
      total: subTotals.subVisible && subTotals.subVisible !== 0
        ? `${__('order.total')}: ${subTotals.subVisible}€` : null,
      total_hidden: subTotals.subLocked && subTotals.subLocked !== 0
        ? `${__('order.total_hidden')}: ${subTotals.subLocked}€ netto` : null
    };
  }

  if (showBoth) {
    const subTotals = calcSubTotals(orderItems);
    return {
      total: totalPrice?.visible && Number(totalPrice.visible) !== 0
        ? `${__('order.total')}: ${totalPrice.visible}€` : null,
      total_hidden: subTotals.subLocked && subTotals.subLocked !== 0
        ? `${__('order.total_hidden')}: ${subTotals.subLocked}€ netto` : null
    };
  }

  const result = { total: null, total_hidden: null };
  if (totalPrice?.visible && Number(totalPrice.visible) !== 0) {
    result.total = `${__('order.total')}: ${totalPrice.visible}€`;
  }
  if (showGoldPrices) {
    if (totalPrice?.hidden && Number(totalPrice.hidden) !== 0) {
      result.total_hidden = `${__('order.total_hidden')}: ${totalPrice.hidden}€ netto`;
    } else if (totalPrice?.visible && Number(totalPrice.visible) !== 0) {
      result.total_hidden = `${__('order.total_hidden')}: ${totalPrice.visible}€ netto`;
    }
  }
  return result;
}

module.exports = {
  HKL_ORG_ID,
  orderHasSubPrices,
  calcSubTotals,
  calcClientDiscountTotal,
  resolveDiscountBaseTotal,
  resolveSubPricePdfView,
  buildPdfSendDataTotals
};
