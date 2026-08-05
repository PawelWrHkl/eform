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

module.exports = { organizationIdFromSession, belongsToSessionOrganization };
