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

  // ⚠️ ADMIN PRZEŁĄCZA KONTEKST ORGANIZACJI (`GET /set-organization/:id`, patrz
  // `routes/index.js`) — endpoint wpisuje wybrane id do `user.organization`.
  // Dla admina to ono jest aktualną organizacją, nie `orgId` (które zostaje
  // jego macierzystym HKL). Ta sama reguła działa już w `db/owner.js`
  // (`getUsersByOwner`); moduł faktur jej nie znał, więc admin po przełączeniu
  // na inną organizację nadal dostawał klientów i zamówienia HKL.
  // Kolejność dla pozostałych ról zostaje bez zmian: owner ma w `organization`
  // IDENT tekstowy ('HKL'), który nie jest liczbą i musi ustąpić `orgId`.
  const candidates = user.isAdmin
    ? [user.organization, user.orgId, user.organization_id]
    : [user.orgId, user.organization, user.organization_id];

  for (const candidate of candidates) {
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
    // ⚠️ Admin pracuje w PRZEŁĄCZANYM kontekście organizacji i tak ma dostęp do
    // wszystkich zamówień. Gdyby dokumenty ograniczyć do bieżącego kontekstu,
    // przełączenie organizacji odcinałoby go od faktur, które sam wystawił —
    // dotyczy to też poziomu 1, zapisanego w kontekście organizacji-NABYWCY.
    const user = req.session && req.session.user;
    if (user && user.isAdmin) return true;
    return !!scope.organizationId && Number(invoice.organizationId) === scope.organizationId;
  }
  return invoice.issuerType === 'user'
    && !!scope.userId
    && Number(invoice.issuerId) === scope.userId;
}

/**
 * Czy sesja może wystawić dokument na danym poziomie.
 * Poziomy 1, 2 i 4 to relacje organizacji (admin: 1 i 2, owner: 2 i 4);
 * poziom 3 należy do salonu, ale tylko dla JEGO WŁASNYCH zamówień — to sprawdza
 * wołający, mając wiersz zamówienia (`order.user_id`).
 *
 * @param {import('express').Request} req
 * @param {number} level
 * @returns {boolean}
 */
function canIssueAtLevel(req, level) {
  const { allowedLevelsForSession } = require('../core/hierarchy');
  const scope = scopeFromSession(req);
  const lvl = Number(level) || 2;
  // Jedna lista dozwolonych poziomów dla API, panelu i UI — gdyby każde miejsce
  // liczyło ją po swojemu, rozjechałyby się przy dodaniu poziomu 4.
  if (!allowedLevelsForSession(req.session && req.session.user).includes(lvl)) return false;
  return lvl === 3 ? !!scope.userId : scope.isOrgScope;
}

/**
 * Czy sesja może operować na tym zamówieniu.
 *
 * ⚠️ ADMIN MUSI PRZEJŚĆ ZAWSZE. Na poziomie 1 (HKL → organizacja) zamówienie
 * należy do organizacji-NABYWCY, a `scope.organizationId` to bieżący kontekst
 * admina (np. HKL) — porównanie organizacji odrzucało więc dokładnie tę
 * operację, dla której poziom 1 istnieje: „brak dostępu do zamówienia" przy
 * fakturze dla innej organizacji. Admin i tak przełącza kontekst dowolnie
 * i widzi wszystkie zamówienia, więc to była bariera pozorna.
 *
 * @param {import('express').Request} req
 * @param {{ user_id: number, organization_id: number }} order wiersz z `getOrderOwnership`
 * @returns {boolean}
 */
function canAccessOrder(req, order) {
  if (!order) return false;
  const user = req.session && req.session.user;
  if (user && user.isAdmin) return true;

  const scope = scopeFromSession(req);
  if (scope.isOrgScope) {
    return !!scope.organizationId && Number(order.organization_id) === scope.organizationId;
  }
  return !!scope.userId && Number(order.user_id) === scope.userId;
}

module.exports = {
  organizationIdFromSession,
  belongsToSessionOrganization,
  scopeFromSession,
  canAccessInvoice,
  canAccessOrder,
  canIssueAtLevel
};
