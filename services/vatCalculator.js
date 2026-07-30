/**
 * VAT rate resolution: domestic sale (organization country == user/client
 * country) uses that country's own VAT rate; a cross-border sale (countries
 * differ) is VAT-exempt (0%) — either an intra-EU reverse-charge supply (both
 * countries in the EU) or an export (either side outside the EU). The rate
 * table below is NOT limited to EU members — VAT is a national tax, so a
 * domestic sale must resolve to the right rate regardless of EU membership
 * (e.g. Switzerland/Norway, both present in this system's client base).
 */

const db = require('../db/db_helper.js');

/** The 27 EU member states, by ISO 3166-1 alpha-2 code — used only to label
 *  *why* a cross-border sale is exempt (intra-EU reverse charge vs export),
 *  not to decide the rate itself. */
const EU_MEMBER_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE'
]);

/** Standard VAT rates (%), by ISO 3166-1 alpha-2 country code — EU members
 *  plus other countries this system actually deals with. */
const VAT_RATES_BY_COUNTRY = {
  AT: 20,   // Austria
  BE: 21,   // Belgia
  BG: 20,   // Bułgaria
  HR: 25,   // Chorwacja
  CY: 19,   // Cypr
  CZ: 21,   // Czechy
  DK: 25,   // Dania
  EE: 24,   // Estonia (podwyżka z 22% w lipcu 2025)
  FI: 25.5, // Finlandia
  FR: 20,   // Francja
  DE: 19,   // Niemcy
  GR: 24,   // Grecja
  HU: 27,   // Węgry
  IE: 23,   // Irlandia
  IT: 22,   // Włochy
  LV: 21,   // Łotwa
  LT: 21,   // Litwa
  LU: 17,   // Luksemburg
  MT: 18,   // Malta
  NL: 21,   // Holandia
  PL: 23,   // Polska
  PT: 23,   // Portugalia
  RO: 21,   // Rumunia (podwyżka z 19%)
  SK: 23,   // Słowacja
  SI: 22,   // Słowenia
  ES: 21,   // Hiszpania
  SE: 25,   // Szwecja
  // Spoza UE, ale z własnym krajowym VAT-em — potrzebne dla sprzedaży krajowej
  // w tych krajach (klienci tej instalacji obejmują CH i NO — patrz `user.country`).
  CH: 8.1,  // Szwajcaria (MWST/TVA/IVA)
  NO: 25    // Norwegia (MVA)
};

/** @deprecated use VAT_RATES_BY_COUNTRY — kept for any external references. */
const EU_VAT_RATES = VAT_RATES_BY_COUNTRY;

/**
 * Standard VAT rate for a given country code, or 0 if unknown/unset.
 *
 * @param {string} countryCode ISO 3166-1 alpha-2 (e.g. "PL", "nl").
 * @returns {number} VAT percentage.
 */
function getVatRateForCountry(countryCode) {
  if (!countryCode) return 0;
  const code = String(countryCode).trim().toUpperCase();
  return VAT_RATES_BY_COUNTRY[code] ?? 0;
}

/**
 * Core rule with reasoning: domestic sale (same country) → that country's VAT
 * rate. Cross-border sale (different countries) → 0%, labelled as either an
 * intra-EU reverse-charge supply or an export depending on whether both
 * countries are EU members — same number either way, but the reason matters
 * for invoice wording/legal justification.
 *
 * @param {string} userCountry
 * @param {string} organizationCountry
 * @returns {{vatRate: number, reason: 'domestic'|'eu-reverse-charge'|'export'|'unknown'}}
 */
function calculateVatDetails(userCountry, organizationCountry) {
  const uc = String(userCountry || '').trim().toUpperCase();
  const oc = String(organizationCountry || '').trim().toUpperCase();

  if (!uc || !oc) {
    return { vatRate: 0, reason: 'unknown' };
  }
  if (uc === oc) {
    return { vatRate: getVatRateForCountry(oc), reason: 'domestic' };
  }
  const bothInEu = EU_MEMBER_COUNTRIES.has(uc) && EU_MEMBER_COUNTRIES.has(oc);
  return { vatRate: 0, reason: bothInEu ? 'eu-reverse-charge' : 'export' };
}

/**
 * Same rule as calculateVatDetails(), returning just the rate.
 *
 * @param {string} userCountry
 * @param {string} organizationCountry
 * @returns {number} VAT percentage.
 */
function calculateVatRate(userCountry, organizationCountry) {
  return calculateVatDetails(userCountry, organizationCountry).vatRate;
}

async function getUserCountry(userId) {
  if (!userId) return null;
  const rows = await db.selectQuery('SELECT country FROM `user` WHERE id = ?', userId);
  return rows?.[0]?.country || null;
}

async function getOrganizationCountry(orgId) {
  if (!orgId) return null;
  const rows = await db.selectQuery('SELECT country FROM organization WHERE id = ?', orgId);
  return rows?.[0]?.country || null;
}

/**
 * Resolves the VAT rate (and the reason behind it) for a given logged-in
 * user/organization pair, fetching both countries from the DB.
 *
 * @param {number} userId
 * @param {number} orgId
 * @returns {Promise<{vatRate: number, reason: string, userCountry: string|null, organizationCountry: string|null}>}
 */
async function resolveVatRateForUser(userId, orgId) {
  const [userCountry, organizationCountry] = await Promise.all([
    getUserCountry(userId),
    getOrganizationCountry(orgId)
  ]);

  const { vatRate, reason } = calculateVatDetails(userCountry, organizationCountry);

  return { vatRate, reason, userCountry, organizationCountry };
}

module.exports = {
  VAT_RATES_BY_COUNTRY,
  EU_VAT_RATES,
  EU_MEMBER_COUNTRIES,
  getVatRateForCountry,
  calculateVatRate,
  calculateVatDetails,
  getUserCountry,
  getOrganizationCountry,
  resolveVatRateForUser
};
