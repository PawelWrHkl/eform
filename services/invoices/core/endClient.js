'use strict';

/**
 * Reguły danych odbiorcy końcowego (`invoice_end_client`) niezależne od bazy.
 */

/**
 * Numery, które ma tylko firma: NIP, NIP UE i numery rejestrowe
 * (REGON, KVK, SIREN, Steuernummer… — `core/compliance.js:REGISTRY_FIELDS`).
 */
const COMPANY_ONLY_FIELDS = Object.freeze(['tax_id', 'vat_eu_id', 'registry_numbers']);

/**
 * Osoba prywatna nie ma numerów firmowych — czyścimy je przy zapisie.
 *
 * ⚠️ Formularz je ukrywa, ale to nie wystarcza: odbiorca zapisany jako firma
 * i przestawiony na osobę zachowałby w bazie stary NIP, a ten trafia na fakturę
 * (`core/hierarchy.js:resolveParties` → `buyer.taxId`) i do weryfikacji VIES.
 *
 * @param {Record<string, any>} data dane z formularza/API
 * @returns {Record<string, any>} kopia z wyczyszczonymi numerami dla `person`
 */
function normalizeEndClientData(data) {
  if (!data || data.client_type !== 'person') return data;
  const out = { ...data };
  for (const field of COMPANY_ONLY_FIELDS) out[field] = null;
  return out;
}

module.exports = { COMPANY_ONLY_FIELDS, normalizeEndClientData };
