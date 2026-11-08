'use strict';

/**
 * Czyj cennik i który zestaw cen pokazać — WYŁĄCZNIE z sesji, nigdy z adresu
 * ani parametru (wzór: routes/clientTerms.js). Decyzje właściciela 06.11.2026:
 *
 *  • klient HKL (organizacja 3), także konto grupowe HKL → ceny zwykłe CENA;
 *  • klient innej organizacji → SUB___, nigdy CENA (CENA to cena zakupu jego
 *    organizacji od HKL);
 *  • właściciel organizacji spoza HKL na WŁASNYM koncie (ident konta = ident
 *    organizacji, jak `isOwner` w middleware/loginMixture.js) → swoje CENA;
 *  • konto podrzędne grupy (sklep) → SUB___ grupy-matki (jej konto i uid —
 *    tak liczy konfigurator, `/user/uid` bierze ident po pinie rodzica);
 *  • właściciel i admin w podglądzie klienta → cennik tego klienta wg jego
 *    reguły; właściciel wyłącznie klientów WŁASNEJ organizacji;
 *  • pracownik → nic (nie ma panelu).
 */

const { HKL_ORG_ID } = require('../subPrices');

function priceSetFor({ orgId, ident, orgIdent }) {
  if (Number(orgId) === HKL_ORG_ID) return 'CENA';
  return String(ident || '').toUpperCase() === String(orgIdent || '').toUpperCase() ? 'CENA' : 'SUB';
}

/**
 * @param {object} session  `req.session`
 * @returns {{ userId:number, priceSet:'CENA'|'SUB', groupShopId?:number }|null}
 */
function resolveAudience(session) {
  const user = session && session.user;
  // Konto biura nie dostaje cenników PDF klientów (prompt biura, pkt E).
  if (!user || user.isEmployee || user.isStaff || !user.userId) return null;

  if (user.isGroupShop) return { userId: user.userId, priceSet: 'SUB', groupShopId: user.groupShopId || null };

  const ctx = (user.isOwner || user.isAdmin) && session.context_user ? session.context_user : null;
  if (ctx) {
    if (!ctx.userId) return null;
    if (!user.isAdmin && Number(ctx.orgId) !== Number(user.orgId)) return null;
    return { userId: ctx.userId, priceSet: priceSetFor({ orgId: ctx.orgId, ident: ctx.ident, orgIdent: ctx.organization }) };
  }
  return { userId: user.userId, priceSet: priceSetFor({ orgId: user.orgId, ident: user.ident, orgIdent: user.organization }) };
}

module.exports = { resolveAudience, priceSetFor };
