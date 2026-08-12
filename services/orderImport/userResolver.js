/**
 * Resolves a user record from the eform DB by `ident` and returns a normalised
 * object used to back-fill missing fields on imported orders.
 *
 * The columns mirror what the order-export query in `db/orders.js` reads
 * (`u.client_name`, `u.tax_id`, `u.street/zip/city/country/phone`, `u.email`,
 * `u.country` is also used as language hint by `db.getLanguage`).
 *
 * Language detection rules (in order):
 *   1. user.country (lowercased) if it matches an availabeLanguages entry.
 *   2. defaultLanguage from config.
 */

const { selectQuery } = require('../../db/core');
const { availabeLanguages, defaultLanguage } = require('../../config');

const USER_QUERY = `
  SELECT u.id, u.ident, u.pin, u.client_name, u.tax_id, u.email,
         u.street, u.zip, u.city, u.country, u.phone,
         u.organization_id, o.ident AS org_ident,
         -- Zasady potwierdzenia (AB) muszą jechać razem z klientem: bez tych
         -- kolumn wysyłka po imporcie nie miala z czego odczytac regul i szla
         -- z cenami, w domyslnym jezyku i na adres organizacji.
         u.ab_type, u.ab_lang, u.client_ab, u.delivery_delay
  FROM \`user\` u
  LEFT JOIN organization o ON o.id = u.organization_id
  WHERE u.ident = ?
  LIMIT 1
`;

async function findUserByIdent(ident) {
  if (!ident) return null;
  const rows = await selectQuery(USER_QUERY, [ident]);
  return rows && rows[0] ? rows[0] : null;
}

function detectLanguage(user) {
  const raw = (user && user.country ? String(user.country) : '').toLowerCase();
  if (raw && availabeLanguages.includes(raw)) return raw;
  return defaultLanguage;
}

/**
 * Fill in missing client/sendData fields on the payload using the DB user.
 * Never overwrites values that are already present (truthy) in the payload.
 *
 * Returns: { user, lang, payload } — payload is a shallow-cloned, augmented copy.
 */
async function resolveOrderUser(payload) {
  const user = await findUserByIdent(payload.userIdent);
  if (!user) {
    const err = new Error(`User not found by ident="${payload.userIdent}"`);
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const lang = detectLanguage(user);
  const filled = { ...payload };

  // Header / client section
  filled.client = filled.client || user.client_name || '';
  filled.tax = filled.tax || user.tax_id || '';
  filled.organizationIdent = filled.organizationIdent || user.org_ident || '';
  filled.userStreet = filled.userStreet || user.street || '';
  filled.userZip = filled.userZip || user.zip || '';
  filled.userCity = filled.userCity || user.city || '';
  filled.userCountry = filled.userCountry || user.country || '';
  filled.userPhone = filled.userPhone || user.phone || '';

  // Send / delivery section — fall back to client address when missing.
  filled.name = filled.name || user.client_name || '';
  filled.address = filled.address || user.street || '';
  filled.zip = filled.zip || user.zip || '';
  filled.city = filled.city || user.city || '';
  filled.country = filled.country || user.country || '';
  filled.email = filled.email || user.email || '';
  filled.phone = filled.phone || user.phone || '';

  return { user, lang, payload: filled };
}

module.exports = {
  findUserByIdent,
  detectLanguage,
  resolveOrderUser
};
