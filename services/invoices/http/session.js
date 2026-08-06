'use strict';

/**
 * Odczyt kontekstu organizacji z sesji — wspólny dla API (`routes.js`) i panelu
 * (`panel.js`), żeby reguła multi-tenancy istniała w jednym miejscu.
 *
 * ⚠️ PUŁAPKA, na którą się nadziałem: kształt `session.user` zależy od TYPU
 * logowania (patrz `services/authService.js`):
 *   - owner:    `{ organization: 'HKL' /* ident tekstowy *\/, orgId: 3, isOwner: true }`
 *   - klient:   `{ organization: 3   /* numeryczne id  *\/ }`
 *   - pracownik:`{ organization: 3, isEmployee: true }`
 * Czyli `organization` jest raz stringiem, raz liczbą. Naiwne
 * `Number(user.organization ?? user.orgId)` dla ownera daje `NaN`, bo `??`
 * przepuszcza tylko `null`/`undefined` — a `'HKL'` jest wartością. Efekt:
 * panel ownera odpowiadał „Brak kontekstu organizacji". Dlatego bierzemy
 * PIERWSZĄ wartość, która faktycznie jest liczbą.
 */

/**
 * @param {import('express').Request} req
 * @returns {number|null} numeryczne `organization.id` albo `null`
 */
function organizationIdFromSession(req) {
  const user = req.session && req.session.user;
  if (!user) return null;

  for (const candidate of [user.orgId, user.organization, user.organization_id]) {
    const id = Number(candidate);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

/**
 * Czy dokument należy do organizacji z sesji. Multi-tenancy musi być pilnowane
 * na każdym wejściu, nie tylko przy tworzeniu.
 *
 * @param {import('express').Request} req
 * @param {{ organizationId: number }} invoice
 * @returns {boolean}
 */
function belongsToSessionOrganization(req, invoice) {
  const orgId = organizationIdFromSession(req);
  return !!orgId && Number(invoice && invoice.organizationId) === orgId;
}


/**
 * Zakres uprawnień do dokumentów dla sesji.
 *
 * ⚠️ Fakturowanie NIE jest wyłącznie operacją organizacji: na poziomie 3
 * wystawcą jest zwykły użytkownik (salon) i on musi móc wystawić fakturę
 * swojemu odbiorcy końcowemu. Dlatego autoryzacja jest DWUTOROWA:
 *   - owner/admin → wszystko w obrębie swojej organizacji,
 *   - zwykły użytkownik → wyłącznie dokumenty, których wystawcą jest on sam
 *     (`issuer_type = 'user'` i `issuer_id = jego user.id`).
 *
 * @param {import('express').Request} req
 * @returns {{ isOrgScope: boolean, organizationId: number|null, userId: number|null }}
 */
function scopeFromSession(req) {
  const user = req.session && req.session.user;
  const isOrgScope = !!(user && (user.isOwner || user.isAdmin));
  const userId = Number(user?.userId);
  return {
    isOrgScope,
    organizationId: organizationIdFromSession(req),
    userId: Number.isInteger(userId) && userId > 0 ? userId : null
  };
}

/**
 * Czy sesja może działać na tym dokumencie.
 *
 * @param {import('express').Request} req
 * @param {{ organizationId: number, issuerType?: string, issuerId?: number }} invoice
 * @returns {boolean}
 */
function canAccessInvoice(req, invoice) {
  if (!invoice) return false;
  const scope = scopeFromSession(req);

  if (scope.isOrgScope) {
    return !!scope.organizationId && Number(invoice.organizationId) === scope.organizationId;
  }
  return invoice.issuerType === 'user'
    && !!scope.userId
    && Number(invoice.issuerId) === scope.userId;
}

/**
 * Czy sesja może wystawić dokument na danym poziomie.
 * Poziomy 1 i 2 to relacje organizacji (owner/admin); poziom 3 należy do salonu,
 * ale tylko dla JEGO WŁASNYCH zamówień — to sprawdza wołający, mając wiersz
 * zamówienia (`order.user_id`).
 *
 * @param {import('express').Request} req
 * @param {number} level
 * @returns {boolean}
 */
function canIssueAtLevel(req, level) {
  const scope = scopeFromSession(req);
  const lvl = Number(level) || 2;
  if (lvl === 3) return !!scope.userId;
  return scope.isOrgScope;
}

module.exports = {
  organizationIdFromSession,
  belongsToSessionOrganization,
  scopeFromSession,
  canAccessInvoice,
  canIssueAtLevel
};
