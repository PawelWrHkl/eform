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
const { features } = require('../config');

/** THE switch for the whole feature — see `features.vat` in config.js.
 *  Off on production unless VAT_ENABLED=true. */
const vatFeatureEnabled = !!features?.vat;

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
  // Feature off (production default): no DB lookups, no rate — callers must
  // not render anything VAT-related. `reason: 'disabled'` is deliberately
  // distinct from the real reasons so a stray usage is obvious.
  if (!vatFeatureEnabled) {
    return { vatRate: null, reason: 'disabled', userCountry: null, organizationCountry: null };
  }

  const [userCountry, organizationCountry] = await Promise.all([
    getUserCountry(userId),
    getOrganizationCountry(orgId)
  ]);

  const { vatRate, reason } = calculateVatDetails(userCountry, organizationCountry);

  return { vatRate, reason, userCountry, organizationCountry };
}

/**
 * Stawka VAT zlecenia KONTA PODRZĘDNEGO GRUPY (`order.group_user_id`) — albo
 * null, gdy zlecenie nie jest grupowe.
 *
 * ⚠️ Cena klienta grupy (`SUB___`) to sprzedaż GRUPY-MATKI jej klientowi, nie
 * HKL grupie (decyzja właściciela 2026-10-27): sprzedawcą jest grupa
 * (`order.user_id`, `user.country`), nabywcą konto podrzędne
 * (`group_user.country`). Kraj konta podrzędnego w bazie bywa pusty — wtedy
 * to klient z kraju grupy, czyli sprzedaż krajowa. Ogólna reguła
 * (`resolveVatRateForUser`: kraj grupy vs kraj organizacji HKL) dawała grupom
 * spoza Polski 0%, jak przy dostawie HKL → grupa.
 *
 * @param {number} orderId
 * @returns {Promise<{vatRate: number, reason: string}|null>}
 */
async function resolveGroupVatRateForOrder(orderId) {
  if (!orderId) return null;
  const rows = await db.selectQuery(
    `SELECT u.role, u.country AS group_country, gu.country AS client_country
     FROM \`order\` o
     JOIN group_user gu ON gu.id = o.group_user_id
     JOIN \`user\` u ON u.id = o.user_id
     WHERE o.id = ?`,
    orderId
  );
  const row = rows?.[0];
  if (!row || row.role !== 'group') return null;
  const sellerCountry = row.group_country;
  return calculateVatDetails(row.client_country || sellerCountry, sellerCountry);
}

/**
 * Stawka VAT zlecenia — dla jego WŁAŚCICIELA (`order.user_id` /
 * `order.organization_id`), nie dla zalogowanego: admin czy grupa-matka
 * oglądają cudze zlecenia. Ta sama reguła co `resolveVatRateForUser`, a dla
 * zlecenia konta podrzędnego grupy — `resolveGroupVatRateForOrder`.
 *
 * @param {number} orderId
 * @returns {Promise<{vatRate: number|null, reason: string}>}
 */
async function resolveVatRateForOrder(orderId) {
  if (!vatFeatureEnabled) return { vatRate: null, reason: 'disabled' };
  const group = await resolveGroupVatRateForOrder(orderId);
  if (group) return group;
  const rows = await db.selectQuery('SELECT user_id, organization_id FROM `order` WHERE id = ?', orderId);
  const order = rows?.[0];
  if (!order) return { vatRate: null, reason: 'unknown' };
  return resolveVatRateForUser(order.user_id, order.organization_id);
}

/**
 * Template locals for every view that shows the VAT block (new position,
 * position edit, admin-redit). Returns `{}` when the feature is off, so a
 * caller spreading the result into res.render() leaves no VAT locals behind.
 *
 * isHklOrg: HKL (org id 3) is the "home" org — SUB___ prices don't apply to it
 * (see services/subPriceContext.js's nonHklOrg check), so VAT there must be
 * computed from the plain SUMA_BRUTTO, not SUB___SUMA_BRUTTO.
 *
 * `orderId` (gdy znany): zlecenie konta podrzędnego grupy dostaje stawkę
 * sprzedaży grupa → klient (`resolveGroupVatRateForOrder`) — ta sama, którą
 * pokazuje stopka zlecenia, niezależnie od tego, czy pozycję konfiguruje
 * klient, czy grupa w jego kontekście.
 *
 * @param {import('express').Request} req
 * @param {number} [orderId]
 * @returns {Promise<{vatEnabled?: boolean, vatRate?: number, vatReason?: string, isHklOrg?: boolean}>}
 */
async function resolveVatLocals(req, orderId) {
  if (!vatFeatureEnabled) return {};

  const ownerService = require('./owner.js');
  const currentUser = ownerService.getCurrentUser(req);
  const group = await resolveGroupVatRateForOrder(orderId);
  const { vatRate, reason: vatReason } = group
    || await resolveVatRateForUser(currentUser?.userId, currentUser?.orgId);

  return { vatEnabled: true, vatRate, vatReason, isHklOrg: Number(currentUser?.orgId) === 3 };
}

module.exports = {
  vatFeatureEnabled,
  resolveVatLocals,
  resolveVatRateForOrder,
  resolveGroupVatRateForOrder,
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
