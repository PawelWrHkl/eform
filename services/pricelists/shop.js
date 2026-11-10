'use strict';

/**
 * Cennik konta podrzędnego grupy (sklepu / klienta grupy). Pobiera go WYŁĄCZNIE
 * właściciel grupy ze swojego panelu — samo konto podrzędne cenników nie widzi
 * (decyzja właściciela 2026-11-09).
 *
 * Kwoty jak w konfiguratorze konta podrzędnego (public/scripts/formTools/pricesCalculator.js):
 *  • narzut (`applyClientMarkup`): SUB___X = X × (1 + narzut), rabaty grupy-matki
 *    przepisane bez zmian — cena końcowa = cena zakupu grupy-matki × (1 + narzut);
 *  • rabat konta > 0 (`clientDiscountBreakdown`): zastępuje rabat cennikowy na części
 *    katalogowej, a dopłaty dostają swój rabat ze skryptu (`SUB___DOPLATA_RABAT`,
 *    gdy grupa ma taki parametr, inaczej `SUB___CENA_RABAT`; EL — `SUB___DOPLATA_EL_RABAT`);
 *    bez rabatu konta zostaje cena po rabatach cennikowych;
 *  • ekstra rabat grupy-matki (`user.extra_rabat`) mnoży kwotę po rabacie.
 * Rabat i narzut dotyczą tylko grup typu `client`; konta „sklepów” (`shop`, np. TCN)
 * widzą łańcuch `SUB___` taki, jaki liczą skrypty.
 */

const { selectQuery } = require('../../db/core');
const { isClientGroupType } = require('../groupType');
const { getGroupPriceMode, getGroupUserMarkup, PRICE_MODE_MARKUP } = require('../groupPriceMode');
const { getUserExtraDiscount } = require('../portalUsageDiscount');
const { isEnabled: portalSwitchEnabled } = require('../portalUsageDiscountSwitch');
const { mapAmounts, applyDiscount } = require('./index');

const round2 = (v) => parseFloat(v.toFixed(2));

/** Konto podrzędne właściciela z jego wyceną; null, gdy konto nie należy do właściciela. */
async function loadShopPricing(ownerUserId, shopId) {
  const rows = await selectQuery(
    `SELECT gu.id, gu.ident, gu.name, gu.discount_percent, gu.user_id, u.role, u.group_type
       FROM group_user gu JOIN user u ON u.id = gu.user_id
      WHERE gu.id = ? LIMIT 1`,
    [shopId]
  );
  const shop = rows && rows[0];
  if (!shop || Number(shop.user_id) !== Number(ownerUserId)) return null;
  const clientType = shop.role === 'group' && isClientGroupType(shop.group_type);
  const markup = clientType && (await getGroupPriceMode(ownerUserId)) === PRICE_MODE_MARKUP;
  const discount = parseFloat(shop.discount_percent);
  return {
    id: shop.id,
    ident: shop.ident,
    name: shop.name,
    mode: markup ? 'markup' : 'discount',
    markupPercent: markup ? await getGroupUserMarkup(shop.id) : 0,
    clientPct: clientType && !markup && discount > 0 ? Math.min(100, discount) : 0,
    bonusPct: portalSwitchEnabled() ? await getUserExtraDiscount(ownerUserId) : 0
  };
}

/** Zestaw cen grupy-matki, z którego konfigurator liczy konto podrzędne. */
function shopPriceSet(shop) {
  return shop.mode === 'markup' ? 'CENA' : 'SUB';
}

/**
 * @param {object} list   `buildPricelist` grupy-matki w zestawie `shopPriceSet(shop)`
 * @param {object} shop   `loadShopPricing`
 * @param {boolean} final cena końcowa konta (PDF „z rabatem”); inaczej ceny katalogowe konta
 */
function shopPricelist(list, shop, final) {
  const factor = 1 + Math.max(0, shop.markupPercent) / 100;
  const bonus = (l) => (shop.bonusPct > 0 ? mapAmounts(l, (c, a) => round2(Math.max(0, a * (1 - shop.bonusPct / 100)))) : l);
  if (shop.mode === 'markup') {
    if (!final) return mapAmounts(list, (c, a) => round2(a * factor));
    // Najpierw łańcuch grupy-matki (CENA_KONCOWA), potem narzut — jak SUB___CENA_KONCOWA = CENA_KONCOWA × f.
    return bonus(mapAmounts(applyDiscount(list) || list, (c, a) => round2(a * factor), { discounted: true }));
  }
  if (!final) return list;
  if (shop.clientPct > 0) {
    const r = (list.discount && list.discount.rebates) || {};
    const doplataRate = 'SUB___DOPLATA_RABAT' in r ? r.SUB___DOPLATA_RABAT : r.SUB___CENA_RABAT || 0;
    const rate = (component) => {
      if (component === 'SUB___DOPLATA') return doplataRate;
      if (component === 'SUB___DOPLATA_EL') return r.SUB___DOPLATA_EL_RABAT || 0;
      return shop.clientPct / 100;
    };
    return bonus(mapAmounts(list, (c, a) => round2(Math.max(0, a * (1 - rate(c)))), { discounted: true }));
  }
  return bonus(applyDiscount(list) || { ...list, discounted: true });
}

/** Czy cena końcowa konta różni się od katalogowej (drugi PDF ma sens). */
function shopHasFinalPrices(shop, parentHasRebate) {
  return shop.clientPct > 0 || shop.bonusPct > 0 || parentHasRebate;
}

module.exports = { loadShopPricing, shopPriceSet, shopPricelist, shopHasFinalPrices };
