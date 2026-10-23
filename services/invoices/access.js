'use strict';

/**
 * Kto widzi moduł faktur — JEDNA reguła dla wszystkich wejść:
 *   - menu i sekcja odbiorcy w zamówieniu (`server.js` → `res.locals.invoicesEnabled`),
 *   - trasy `/invoices` i `/api/v1/invoices` (`server.js`, strażnik przed routerami),
 *   - asystent Eforek (`services/assistant/tools.js` — strony, `knowledge.js` — rozdział o fakturach).
 * Gdyby każde z tych miejsc liczyło to po swojemu, tryb „tylko admin" przeciekłby
 * np. przez asystenta, który podsuwałby klientowi link do niedostępnego panelu.
 *
 * Reguła:
 *   - `INVOICES_ENABLED=true` (`features.invoices`) — moduł w ogóle istnieje,
 *   - konto podrzędne grupy (`isGroupShop`) — nigdy (składa wyłącznie zamówienia),
 *   - `INVOICES_ADMIN_ONLY=true` (`features.invoicesAdminOnly`) — wyłącznie
 *     administrator. Tryb na start produkcji: admin widzi, co wystawia automat,
 *     zanim faktury zobaczą organizacje i salony. Automat i maile z fakturami
 *     działają w tym trybie normalnie — flaga dotyczy tylko tego, kto widzi moduł.
 *
 * @param {{ isAdmin?: boolean, isGroupShop?: boolean }|null|undefined} sessionUser  `req.session.user`
 * @param {{ invoices?: boolean, invoicesAdminOnly?: boolean }} [feats]  domyślnie `config.features`
 * @returns {boolean}
 */
function canAccessInvoices(sessionUser, feats = require('../../config').features || {}) {
  if (!feats.invoices) return false;
  const user = sessionUser || {};
  if (user.isGroupShop) return false;
  if (feats.invoicesAdminOnly && !user.isAdmin) return false;
  return true;
}

module.exports = { canAccessInvoices };
