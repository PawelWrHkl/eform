'use strict';

/**
 * Hierarchia fakturowania — cztery niezależne relacje handlowe.
 *
 *   Poziom 1: Producent/HKL        → Organizacja (dystrybutor/partner B2B)
 *   Poziom 2: Organizacja          → Użytkownik (salon dekoracji)
 *   Poziom 3: Użytkownik           → Odbiorca końcowy (klient detaliczny/firma)
 *   Poziom 4: Organizacja          → Odbiorca końcowy (sprzedaż bezpośrednia)
 *
 * ⚠️ Poziom 4 istnieje, bo organizacja bywa sprzedawcą dla klienta detalicznego
 * BEZ pośrednictwa salonu — a wtedy to ona, nie salon, jest stroną dokumentu
 * i to jej seria numeracji obowiązuje. Wcześniej owner chcący zafakturować
 * odbiorcę końcowego musiał użyć poziomu 3, gdzie sprzedawcą jest użytkownik —
 * czyli wystawiał dokument w cudzym imieniu.
 *
 * Każdy poziom ma własny profil wystawcy (`invoice_issuer_profile`): waluta,
 * termin płatności, szablon, wzorzec numeracji, dane rejestrowe, klauzule.
 * Numeracja jest odizolowana per (wystawca, poziom, rok) — patrz
 * `invoice_issuer_sequence` i `core/numbering.js`.
 *
 * ⚠️ Ten sam podmiot występuje na dwóch poziomach w różnych rolach: organizacja
 * jest NABYWCĄ na poziomie 1 i WYSTAWCĄ na poziomie 2; użytkownik jest nabywcą
 * na 2 i wystawcą na 3. Dlatego identyfikacja podmiotu to zawsze PARA
 * `(type, id)`, nigdy samo id — inaczej nie da się rozróżnić „organizacja 3 jako
 * sprzedawca" od „organizacja 3 jako nabywca" w numeracji i w filtrach.
 *
 * @typedef {import('../domain/types').Party} Party
 */

/** Poziomy relacji. */
const InvoiceLevel = Object.freeze({
  MANUFACTURER_TO_ORGANIZATION: 1,
  ORGANIZATION_TO_USER: 2,
  USER_TO_END_CLIENT: 3,
  ORGANIZATION_TO_END_CLIENT: 4
});

/** Typ podmiotu wystawiającego. */
const IssuerType = Object.freeze({
  MANUFACTURER: 'manufacturer',
  ORGANIZATION: 'organization',
  USER: 'user'
});

/** Typ nabywcy. */
const BuyerType = Object.freeze({
  ORGANIZATION: 'organization',
  USER: 'user',
  GROUP_USER: 'group_user',
  END_CLIENT: 'end_client'
});

/**
 * Definicja poziomu: kto wystawia, kto kupuje, skąd brać dane obu stron.
 * PUNKT ROZSZERZENIA: nowy poziom = nowy wpis tutaj + mapper danych stron
 * w `resolveParties` (i nic więcej w rdzeniu).
 */
const LEVELS = Object.freeze({
  [InvoiceLevel.MANUFACTURER_TO_ORGANIZATION]: {
    level: InvoiceLevel.MANUFACTURER_TO_ORGANIZATION,
    issuerType: IssuerType.MANUFACTURER,
    buyerType: BuyerType.ORGANIZATION,
    labelKey: 'level.manufacturer_to_organization',
    /** Producent jest jeden — nie ma własnej tabeli, więc id jest stałe. */
    issuerIdFrom: () => 0,
    buyerIdFrom: (ctx) => ctx.organization?.id ?? null
  },
  [InvoiceLevel.ORGANIZATION_TO_USER]: {
    level: InvoiceLevel.ORGANIZATION_TO_USER,
    issuerType: IssuerType.ORGANIZATION,
    buyerType: BuyerType.USER,
    labelKey: 'level.organization_to_user',
    issuerIdFrom: (ctx) => ctx.organization?.id ?? null,
    buyerIdFrom: (ctx) => ctx.user?.id ?? null
  },
  [InvoiceLevel.USER_TO_END_CLIENT]: {
    level: InvoiceLevel.USER_TO_END_CLIENT,
    issuerType: IssuerType.USER,
    buyerType: BuyerType.END_CLIENT,
    labelKey: 'level.user_to_end_client',
    issuerIdFrom: (ctx) => ctx.user?.id ?? null,
    buyerIdFrom: (ctx) => ctx.endClient?.id ?? null
  },
  [InvoiceLevel.ORGANIZATION_TO_END_CLIENT]: {
    level: InvoiceLevel.ORGANIZATION_TO_END_CLIENT,
    issuerType: IssuerType.ORGANIZATION,
    buyerType: BuyerType.END_CLIENT,
    labelKey: 'level.organization_to_end_client',
    issuerIdFrom: (ctx) => ctx.organization?.id ?? null,
    buyerIdFrom: (ctx) => ctx.endClient?.id ?? null
  }
});

/**
 * @param {number} level
 * @returns {{ level: number, issuerType: string, buyerType: string, labelKey: string, issuerIdFrom: Function, buyerIdFrom: Function }}
 */
function getLevel(level) {
  const def = LEVELS[Number(level)];
  if (!def) {
    throw new Error(`Nieznany poziom fakturowania: ${level}. Dozwolone: ${Object.keys(LEVELS).join(', ')}`);
  }
  return def;
}

/**
 * Buduje strony transakcji dla danego poziomu.
 *
 * Dane wystawcy pochodzą z jego profilu (`invoice_issuer_profile`) — to on
 * decyduje, co jest na fakturze; dane nabywcy z odpowiedniej tabeli
 * (`organization`, `user`, `invoice_end_client`). Wszystko jest KOPIOWANE na
 * dokument, nigdy wiązane referencją (patrz `db/schema.sql`).
 *
 * @param {Object} params
 * @param {number} params.level
 * @param {Object} params.issuerProfile   Wiersz `invoice_issuer_profile` (znormalizowany).
 * @param {Object} params.context         `{ manufacturer?, organization?, user?, endClient?, groupShop? }`
 * @returns {{ level: number, issuerType: string, issuerId: number, buyerType: string, buyerId: number|null, seller: Party, buyer: Party }}
 */
function resolveParties({ level, issuerProfile, context }) {
  const def = getLevel(level);
  const ctx = context || {};

  /** @type {Party & { registry?: Record<string, string> }} */
  const seller = {
    name: issuerProfile?.name || '',
    taxId: issuerProfile?.taxId || '',
    vatEuId: issuerProfile?.vatEuId || '',
    street: issuerProfile?.street || '',
    zip: issuerProfile?.zip || '',
    city: issuerProfile?.city || '',
    country: String(issuerProfile?.country || '').toUpperCase().slice(0, 2),
    email: issuerProfile?.email || '',
    phone: issuerProfile?.phone || '',
    registry: issuerProfile?.registryNumbers || {}
  };

  let buyerSource;
  switch (def.buyerType) {
    case BuyerType.ORGANIZATION:
      buyerSource = ctx.organization
        ? {
          name: ctx.organization.name,
          taxId: ctx.organization.tax_id,
          street: ctx.organization.street,
          zip: ctx.organization.zip,
          city: ctx.organization.city,
          country: ctx.organization.country,
          email: ctx.organization.company_mail || ctx.organization.email,
          phone: ctx.organization.company_phone,
          registry: {}
        }
        : null;
      break;
    case BuyerType.END_CLIENT:
      buyerSource = ctx.endClient
        ? {
          name: ctx.endClient.name,
          taxId: ctx.endClient.tax_id,
          vatEuId: ctx.endClient.vat_eu_id,
          street: ctx.endClient.street,
          zip: ctx.endClient.zip,
          city: ctx.endClient.city,
          country: ctx.endClient.country,
          email: ctx.endClient.email,
          phone: ctx.endClient.phone,
          registry: ctx.endClient.registry_numbers || {},
          clientType: ctx.endClient.client_type
        }
        : null;
      break;
    case BuyerType.USER:
    default: {
      // Sklep grupowy z własnym NIP-em jest nabywcą zamiast konta-parenta
      const source = ctx.groupShop && (ctx.groupShop.tax_id || ctx.groupShop.name) ? ctx.groupShop : ctx.user;
      buyerSource = source
        ? {
          name: source.name || source.client_name,
          taxId: source.tax_id,
          vatEuId: source.tax_id,
          street: source.street,
          zip: source.zip,
          city: source.city,
          country: source.country,
          email: source.email,
          phone: source.phone,
          registry: {}
        }
        : null;
    }
  }

  if (!buyerSource || !buyerSource.name) {
    throw new Error(`Brak danych nabywcy dla poziomu ${level} (typ nabywcy: ${def.buyerType})`);
  }

  /** @type {Party & { registry?: Record<string, string>, clientType?: string }} */
  const buyer = {
    name: buyerSource.name,
    taxId: buyerSource.taxId || '',
    vatEuId: buyerSource.vatEuId || buyerSource.taxId || '',
    street: buyerSource.street || '',
    zip: buyerSource.zip || '',
    city: buyerSource.city || '',
    country: String(buyerSource.country || '').toUpperCase().slice(0, 2),
    email: buyerSource.email || '',
    phone: buyerSource.phone || '',
    registry: buyerSource.registry || {},
    clientType: buyerSource.clientType
  };

  const issuerId = Number(def.issuerIdFrom(ctx) ?? 0);
  const buyerId = def.buyerIdFrom(ctx);

  if (def.issuerType !== IssuerType.MANUFACTURER && !issuerId) {
    throw new Error(`Brak identyfikatora wystawcy dla poziomu ${level} (typ: ${def.issuerType})`);
  }

  return {
    level: def.level,
    issuerType: def.issuerType,
    issuerId,
    buyerType: def.buyerType,
    buyerId: buyerId === null || buyerId === undefined ? null : Number(buyerId),
    seller,
    buyer
  };
}

/**
 * Który poziom dotyczy danego użytkownika sesji dla zamówienia.
 * Podpowiedź dla UI: właściciel organizacji fakturuje poziom 2, salon poziom 3.
 *
 * @param {{ isOwner?: boolean, isAdmin?: boolean }} sessionUser
 * @returns {number[]} dozwolone poziomy, od najbardziej naturalnego
 */
function allowedLevelsForSession(sessionUser) {
  if (!sessionUser) return [];
  // Admin działa z poziomu HKL — organizacji matki: sprzedaje albo do innej
  // organizacji (poziom 1), albo bezpośrednio swojemu klientowi (poziom 2,
  // wystawcą jest wtedy HKL). W obu przypadkach obowiązują ceny BAZOWE.
  if (sessionUser.isAdmin) {
    return [InvoiceLevel.MANUFACTURER_TO_ORGANIZATION, InvoiceLevel.ORGANIZATION_TO_USER];
  }
  // Owner organizacji: swojemu użytkownikowi (poziom 2) albo bezpośrednio
  // odbiorcy końcowemu (poziom 4). Dla organizacji ≠ HKL oba idą po cenach SUB.
  if (sessionUser.isOwner) {
    return [InvoiceLevel.ORGANIZATION_TO_USER, InvoiceLevel.ORGANIZATION_TO_END_CLIENT];
  }
  // Zwykły użytkownik (salon) fakturuje wyłącznie swoich odbiorców końcowych
  return [InvoiceLevel.USER_TO_END_CLIENT];
}

module.exports = {
  InvoiceLevel,
  IssuerType,
  BuyerType,
  LEVELS,
  getLevel,
  resolveParties,
  allowedLevelsForSession
};
