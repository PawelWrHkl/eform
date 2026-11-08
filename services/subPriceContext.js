/**
 * Kto widzi WSZYSTKIE warstwy cen (katalogowa HKL, SUB, rabaty pod kłódką,
 * specyfikacja ceny): admin i konto biura (`staff`, decyzja właściciela 1).
 * ⚠️ Tylko widoczność cen — uprawnienia (panel admina, korekty, ustawienia
 * klientów) zostają na `isAdmin`/`isOwner`, które konto biura ma = false.
 */
function canSeeAllPriceLayers(sessionUser) {
  return !!(sessionUser && (sessionUser.isAdmin || sessionUser.isStaff));
}

/**
 * Resolve effective organization id for price/SUB display.
 * Admin uses selected organization or context client's org — not HKL admin orgId.
 */
function getEffectiveOrgId(req) {
  const sessionUser = req.session?.user;
  const contextUser = req.session?.context_user;
  if (!sessionUser) return null;

  if (canSeeAllPriceLayers(sessionUser)) {
    if (contextUser?.orgId != null) return contextUser.orgId;
    if (sessionUser.organization != null && sessionUser.organization !== '') {
      const parsed = parseInt(sessionUser.organization, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  if (contextUser?.orgId != null) return contextUser.orgId;
  return sessionUser.orgId ?? null;
}

/**
 * Set res.locals for SUB price visibility (org vs client view).
 * Klient: tylko SUB___.
 * Org owner / admin z kontekstem (nie-HKL): domyślnie SUB___, po keychain także ceny katalogowe.
 */
function applySubPriceLocals(req, res) {
  const sessionUser = req.session?.user;
  const contextUser = req.session?.context_user;
  const effectiveOrgId = getEffectiveOrgId(req);
  const nonHklOrg = effectiveOrgId != null && Number(effectiveOrgId) !== 3;

  let canViewSubPrices = false;
  let viewAsOrganization = false;
  let isClient = false;

  const allLayers = canSeeAllPriceLayers(sessionUser);

  if (sessionUser) {
    if (allLayers && contextUser && nonHklOrg) {
      viewAsOrganization = true;
    } else if (sessionUser.isOwner && !sessionUser.isAdmin) {
      const orgId = contextUser?.orgId ?? sessionUser.orgId;
      canViewSubPrices = orgId != null && Number(orgId) !== 3;
    }

    isClient = !sessionUser.isOwner
      && !allLayers
      && !sessionUser.isEmployee
      && sessionUser.orgId != null
      && Number(sessionUser.orgId) !== 3;
  }

  // Pure HKL client (organization_id === 3, not owner/admin/staff/employee) — no price padlock.
  const isHklClient = !!sessionUser
    && !sessionUser.isOwner
    && !allLayers
    && !sessionUser.isEmployee
    && sessionUser.orgId != null
    && Number(sessionUser.orgId) === 3;

  const showSub = sessionUser?.showSubParams || false;
  const hasSubPriceToggle = nonHklOrg && (
    (sessionUser?.isOwner && !sessionUser?.isAdmin) ||
    (allLayers && !!contextUser)
  );

  let showCatalogPrices = true;
  if (isClient) {
    showCatalogPrices = false;
  } else if (hasSubPriceToggle) {
    showCatalogPrices = showSub;
  }

  res.locals.canViewSubPrices = canViewSubPrices;
  res.locals.viewAsOrganization = viewAsOrganization;
  res.locals.isClient = isClient;
  res.locals.isHklClient = isHklClient;
  res.locals.showSub = showSub;
  res.locals.hasSubPriceToggle = hasSubPriceToggle;
  res.locals.showCatalogPrices = showCatalogPrices;

  if (contextUser) {
    res.locals.selectedUser = {
      client_name: contextUser.clientName,
      ident: contextUser.ident
    };
    res.locals.selectedUserIdent = contextUser.ident;
  }
}

module.exports = { getEffectiveOrgId, applySubPriceLocals, canSeeAllPriceLayers };
