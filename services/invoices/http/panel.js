'use strict';

/**
 * Panel ownera — widoki HTML modułu fakturowania.
 *
 * Oddzielony od `http/routes.js` (REST/JSON) świadomie: kontroler API zwraca
 * dane, kontroler panelu renderuje szablony. Strona konsumuje to samo API
 * przez `public/scripts/owner/invoices.js`, więc nie ma tu drugiej implementacji
 * przypadków użycia — tylko przygotowanie kontekstu widoku.
 *
 * Montowanie w `server.js`: `app.use('/invoices', invoicePanelRoutes);`
 *
 * ⚠️ Etykiety NIE idą przez globalne `__()`: aplikacja czyta tłumaczenia z
 * `/mnt/eform/languages` (mount kontenera synchronizowany z panelu admina),
 * więc klucze dodane w repo nie dotarłyby do działającej instancji. Panel
 * dostaje słownik `L` z `services/invoices/i18n/panel.json`.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireLogin, requireOwner } = require('../../../middleware/loginMixture');
const { InvoiceService, DocumentType, InvoiceStatus, DOCUMENT_CURRENCY, money, taxRules } = require('../main');
const repository = require('../db/repository');
const { selectQuery } = require('../../../db/core');
const { organizationIdFromSession, scopeFromSession, canAccessInvoice } = require('./session');
const hierarchy = require('../core/hierarchy');
const { resolvePriceBasis, PriceBasis, HKL_ORG_ID } = require('../core/pricing');
const { log } = require('../../../utils/logging');

const router = express.Router();
const service = new InvoiceService();

const PANEL_LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', 'panel.json'), 'utf8'));

/**
 * @param {import('express').Request} req
 * @returns {{ lang: string, L: Record<string, string> }}
 */
function labelsFor(req) {
  const lang = (typeof req.getLocale === 'function' ? req.getLocale() : 'pl') || 'pl';
  const dict = PANEL_LABELS[lang] || PANEL_LABELS.pl;
  return { lang, L: dict };
}

/**
 * Dane wybranego klienta + skutek podatkowy dla pary krajów
 * (sprzedawca z profilu organizacji, nabywca to ten klient).
 *
 * @param {number} organizationId
 * @param {number} clientId
 * @returns {Promise<Record<string, any>|null>}
 */
async function loadClientContext(organizationId, clientId) {
  const rows = await selectQuery(
    `SELECT u.id, u.client_name, u.ident, u.country, u.tax_id, u.street, u.zip, u.city, u.email, u.phone,
            org.country AS seller_country
       FROM \`user\` u
       JOIN organization org ON org.id = u.organization_id
      WHERE u.id = ? AND u.organization_id = ?`,
    [clientId, organizationId]
  );
  const client = rows && rows[0];
  if (!client) return null;

  // Liczniki policzone TYLKO dla wybranego klienta — przy tysiącach klientów
  // liczenie ich dla całej listy byłoby N+1 w SQL-u.
  const counts = await selectQuery(
    `SELECT
       (SELECT COUNT(*) FROM \`order\` o
         LEFT JOIN invoice i ON i.order_id = o.id
                            AND i.document_type IN ('invoice', 'final')
                            AND i.status <> 'cancelled'
                            -- ⚠️ TYLKO dokumenty TEJ relacji: faktura salonu dla
                            -- jego klienta nie zamyka sprzedaży organizacji do
                            -- salonu. Bez tego licznik pokazywał „0 do
                            -- zafakturowania", choć zamówienie czekało.
                            AND i.issuer_type = 'organization' AND i.issuer_id = ? AND i.level = 2
         WHERE o.user_id = ? AND o.organization_id = ? AND o.status = 'sent' AND i.id IS NULL) AS pending_orders,
       (SELECT COUNT(*) FROM invoice v
         WHERE v.buyer_user_id = ? AND v.organization_id = ? AND v.level = 2) AS documents`,
    [organizationId, clientId, organizationId, clientId, organizationId]
  );

  const zeroRate = taxRules.isIntraEuZeroRate(client.seller_country, client.country);
  const sameCountry = taxRules.normalizeCountry(client.seller_country) === taxRules.normalizeCountry(client.country);
  return {
    ...client,
    pendingOrders: counts && counts[0] ? Number(counts[0].pending_orders) : 0,
    documents: counts && counts[0] ? Number(counts[0].documents) : 0,
    zeroRate,
    taxHint: zeroRate ? 'zero_rate_hint' : (sameCountry ? 'domestic_hint' : 'export_hint'),
    hasVatEuId: taxRules.looksLikeVatEuId(client.tax_id, client.country)
  };
}


/**
 * Kontekst wybranego ODBIORCY KOŃCOWEGO (tryb salonu, poziom 3).
 *
 * Sprzedawcą jest tu użytkownik, więc skutek podatkowy liczymy dla pary
 * (kraj salonu, kraj odbiorcy) — nie kraju organizacji.
 *
 * @param {{ organizationId: number, endClientId: number, ownerUserId: number }} params
 * @returns {Promise<Record<string, any>|null>}
 */
async function loadEndClientContext({ organizationId, endClientId, ownerUserId, level = 3 }) {
  const orgScope = level === hierarchy.InvoiceLevel.ORGANIZATION_TO_END_CLIENT;
  if (!ownerUserId && !orgScope) return null;
  const client = await repository.getEndClient(
    orgScope ? { id: endClientId, organizationId } : { id: endClientId, ownerUserId }
  );
  if (!client) return null;

  // Sprzedawcą jest salon (poziom 3) albo organizacja (poziom 4) — od tego
  // zależy para krajów, a więc i skutek podatkowy pokazywany na karcie klienta.
  const sellerRows = orgScope
    ? await selectQuery('SELECT country FROM organization WHERE id = ?', [organizationId])
    : await selectQuery('SELECT country FROM `user` WHERE id = ?', [ownerUserId]);
  const sellerCountry = (sellerRows && sellerRows[0] && sellerRows[0].country) || '';

  // Zamówienia do zafakturowania: te salonu, który obsługuje tego odbiorcę
  const ordersOwner = orgScope ? Number(client.owner_user_id) || 0 : ownerUserId;
  const counts = await selectQuery(
    `SELECT
       (SELECT COUNT(*) FROM \`order\` o
         LEFT JOIN invoice i ON i.order_id = o.id AND i.level = ? AND i.issuer_id = ?
                            AND i.document_type IN ('invoice', 'final') AND i.status <> 'cancelled'
         WHERE o.user_id = ? AND o.organization_id = ? AND o.status = 'sent' AND i.id IS NULL) AS pending_orders,
       (SELECT COUNT(*) FROM invoice v WHERE v.buyer_end_client_id = ? AND v.level = ?) AS documents`,
    [level, orgScope ? organizationId : ownerUserId, ordersOwner, organizationId, endClientId, level]
  );

  const zeroRate = taxRules.isIntraEuZeroRate(sellerCountry, client.country);
  const sameCountry = taxRules.normalizeCountry(sellerCountry) === taxRules.normalizeCountry(client.country);
  return {
    id: client.id,
    client_name: client.name,
    country: client.country,
    tax_id: client.tax_id,
    street: client.street,
    zip: client.zip,
    city: client.city,
    seller_country: sellerCountry,
    pendingOrders: counts && counts[0] ? Number(counts[0].pending_orders) : 0,
    documents: counts && counts[0] ? Number(counts[0].documents) : 0,
    zeroRate,
    taxHint: zeroRate ? 'zero_rate_hint' : (sameCountry ? 'domestic_hint' : 'export_hint'),
    hasVatEuId: taxRules.looksLikeVatEuId(client.vat_eu_id || client.tax_id, client.country),
    isEndClient: true,
    ownerUserId: Number(client.owner_user_id) || null
  };
}

/**
 * Kontekst ORGANIZACJI jako nabywcy (poziom 1: HKL → inna organizacja).
 *
 * @param {{ sellerOrganizationId: number, buyerOrganizationId: number }} params
 * @returns {Promise<Record<string, any>|null>}
 */
async function loadOrganizationContext({ sellerOrganizationId, buyerOrganizationId }) {
  const rows = await selectQuery(
    `SELECT o.id, o.name AS client_name, o.ident, o.country, o.tax_id, o.street, o.zip, o.city,
            (SELECT country FROM organization WHERE id = ?) AS seller_country
       FROM organization o
      WHERE o.id = ? AND o.id <> ?`,
    [sellerOrganizationId, buyerOrganizationId, sellerOrganizationId]
  );
  const client = rows && rows[0];
  if (!client) return null;

  const counts = await selectQuery(
    `SELECT
       (SELECT COUNT(*) FROM \`order\` o
         LEFT JOIN invoice i ON i.order_id = o.id AND i.level = 1
                            AND i.document_type IN ('invoice', 'final') AND i.status <> 'cancelled'
         WHERE o.organization_id = ? AND o.status = 'sent' AND i.id IS NULL) AS pending_orders,
       (SELECT COUNT(*) FROM invoice v WHERE v.organization_id = ? AND v.level = 1) AS documents`,
    [buyerOrganizationId, buyerOrganizationId]
  );

  const zeroRate = taxRules.isIntraEuZeroRate(client.seller_country, client.country);
  const sameCountry = taxRules.normalizeCountry(client.seller_country) === taxRules.normalizeCountry(client.country);
  return {
    ...client,
    pendingOrders: counts && counts[0] ? Number(counts[0].pending_orders) : 0,
    documents: counts && counts[0] ? Number(counts[0].documents) : 0,
    zeroRate,
    taxHint: zeroRate ? 'zero_rate_hint' : (sameCountry ? 'domestic_hint' : 'export_hint'),
    hasVatEuId: taxRules.looksLikeVatEuId(client.tax_id, client.country),
    isOrganization: true
  };
}

/** Lista dokumentów z kwotami sformatowanymi do wyświetlenia. */
function decorateInvoices(rows, lang) {
  return (rows || []).map((r) => ({
    ...r,
    netFmt: money.format(money.toMinor(r.total_net, r.currency), r.currency, lang),
    grossFmt: money.format(money.toMinor(r.total_gross, r.currency), r.currency, lang),
    dueFmt: money.format(money.toMinor(r.amount_due, r.currency), r.currency, lang),
    issueDateFmt: r.issue_date ? String(new Date(r.issue_date).toLocaleDateString(lang)) : '',
    dueDateFmt: r.due_date ? String(new Date(r.due_date).toLocaleDateString(lang)) : ''
  }));
}

// ---------------------------------------------------------------------------
// Widoki
// ---------------------------------------------------------------------------

// ⚠️ Bez `requireOwner`: panel ma DWA TRYBY.
//   owner/admin  → poziom 2 (organizacja → użytkownik): nabywcą jest klient
//                  organizacji, wybierany z `search/clients`,
//   zwykły user  → poziom 3 (salon → odbiorca końcowy): nabywcą jest jego własny
//                  odbiorca z `end-clients/search`, a zamówienia to jego zamówienia.
// Bez trybu 3 salon nie mógłby wystawić faktury swojemu klientowi — czyli
// formularz odbiorców końcowych nie miałby po co istnieć.
/**
 * Kontekst wspólny dla ekranu wyboru i widoku pojedynczego nabywcy.
 *
 * Jedno miejsce, w którym poziom, klient, filtr dokumentów i warstwa cenowa
 * są wyliczane — dwa widoki muszą pokazywać dokładnie to samo, inaczej
 * „faktury klienta" różniłyby się od tego, co widać po jego wybraniu.
 *
 * @param {import('express').Request} req
 * @param {number|null} clientId
 * @returns {Promise<Object>}
 */
async function buildPanelContext(req, clientId) {
  const organizationId = organizationIdFromSession(req);
  const scope = scopeFromSession(req);
  const allowedLevels = hierarchy.allowedLevelsForSession(req.session.user);
  const requestedLevel = Number(req.query.level);
  const level = allowedLevels.includes(requestedLevel) ? requestedLevel : (allowedLevels[0] || 3);
  const buyerIsEndClient = level === hierarchy.InvoiceLevel.USER_TO_END_CLIENT
    || level === hierarchy.InvoiceLevel.ORGANIZATION_TO_END_CLIENT;

  let client = null;
  if (clientId) {
    if (level === hierarchy.InvoiceLevel.MANUFACTURER_TO_ORGANIZATION) {
      client = await loadOrganizationContext({ sellerOrganizationId: HKL_ORG_ID, buyerOrganizationId: clientId });
    } else if (buyerIsEndClient) {
      client = await loadEndClientContext({ organizationId, endClientId: clientId, ownerUserId: scope.userId, level });
    } else {
      client = await loadClientContext(organizationId, clientId);
    }
  }

  let invoiceFilter;
  if (level === hierarchy.InvoiceLevel.MANUFACTURER_TO_ORGANIZATION) {
    invoiceFilter = { organizationId: client ? client.id : organizationId, level, limit: 100 };
  } else if (level === hierarchy.InvoiceLevel.USER_TO_END_CLIENT) {
    invoiceFilter = { organizationId, issuerType: 'user', issuerId: scope.userId, level, buyerEndClientId: client ? client.id : null, limit: 100 };
  } else if (level === hierarchy.InvoiceLevel.ORGANIZATION_TO_END_CLIENT) {
    invoiceFilter = { organizationId, issuerType: 'organization', issuerId: organizationId, level, buyerEndClientId: client ? client.id : null, limit: 100 };
  } else {
    // Poziom 2 bez filtra `level`: dokumenty z v1 mają kolumnę domyślną,
    // a wykluczenie ich z listy wyglądałoby jak utrata faktur.
    invoiceFilter = { organizationId, buyerUserId: client ? client.id : null, limit: 100 };
  }

  const priceBasis = resolvePriceBasis({
    level,
    issuerType: level === hierarchy.InvoiceLevel.MANUFACTURER_TO_ORGANIZATION ? 'manufacturer' : (level === 3 ? 'user' : 'organization'),
    issuerId: level === 3 ? scope.userId : organizationId,
    organizationId
  });

  return { organizationId, scope, allowedLevels, level, buyerIsEndClient, client, invoiceFilter, priceBasis };
}

router.get('/', requireLogin, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).send('Brak kontekstu organizacji');

  const { lang, L } = labelsFor(req);
  // ⚠️ `base.njk` czyta `owner`/`admin` z res.locals, ale ustawia je middleware
  // routera `/user` — poza nim nawigacja nie wiedziałaby, że to owner.
  res.locals.owner = !!req.session.user?.isOwner;
  res.locals.admin = !!req.session.user?.isAdmin;

  try {
    // ⚠️ Zgodność wstecz i wygoda: `?clientId=` (tak wysyła formularz wyboru)
    // PRZENOSI na własny ekran klienta, zamiast doklejać jego faktury tutaj.
    const clientId = Number(req.query.clientId) || null;
    if (clientId) {
      return res.redirect(`/invoices/client/${clientId}?level=${Number(req.query.level) || ''}`);
    }

    const ctx = await buildPanelContext(req, null);
    return res.render('owner/invoices.njk', {
      L,
      panelLang: lang,
      level: ctx.level,
      levelOptions: ctx.allowedLevels.map((lv) => ({ level: lv, label: L[`level_${lv}`] || `#${lv}`, active: lv === ctx.level })),
      priceBasis: ctx.priceBasis,
      priceBasisLabels: { [PriceBasis.BASE]: L.price_basis_base, [PriceBasis.SUB]: L.price_basis_sub, [PriceBasis.LIST]: L.price_basis_list },
      client: null,
      invoices: [],
      profile: await repository.getOrganizationProfile(organizationId),
      currency: DOCUMENT_CURRENCY,
      documentTypes: [],
      statuses: InvoiceStatus,
      docLangs: ['pl', 'en', 'de']
    });
  } catch (err) {
    log(`[invoices] panel GET /: ${err.message}`);
    return res.status(500).send('Błąd wczytywania panelu faktur');
  }
});

// Widok JEDNEGO nabywcy: jego dane, wystawianie dokumentów i jego faktury.
router.get('/client/:clientId', requireLogin, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).send('Brak kontekstu organizacji');

  const { lang, L } = labelsFor(req);
  res.locals.owner = !!req.session.user?.isOwner;
  res.locals.admin = !!req.session.user?.isAdmin;

  const clientId = Number(req.params.clientId) || null;
  if (!clientId) return res.redirect('/invoices');

  try {
    const ctx = await buildPanelContext(req, clientId);
    // Nieznany/obcy nabywca → wracamy do wyboru, a nie 404: adres mógł zostać
    // zapamiętany w zakładkach po zmianie poziomu albo kontekstu organizacji.
    if (!ctx.client) return res.redirect(`/invoices?level=${ctx.level}`);

    const [invoices, profile] = await Promise.all([
      repository.listInvoices(ctx.invoiceFilter),
      repository.getOrganizationProfile(organizationId)
    ]);

    return res.render('owner/invoice_client.njk', {
      L,
      panelLang: lang,
      level: ctx.level,
      levelLabel: L[`level_${ctx.level}`] || `#${ctx.level}`,
      priceBasis: ctx.priceBasis,
      priceBasisLabels: { [PriceBasis.BASE]: L.price_basis_base, [PriceBasis.SUB]: L.price_basis_sub, [PriceBasis.LIST]: L.price_basis_list },
      client: ctx.client,
      invoices: decorateInvoices(invoices, lang),
      profile,
      currency: DOCUMENT_CURRENCY,
      documentTypes: ctx.buyerIsEndClient
        // Salon fakturuje sprzedaż detaliczną: proforma i faktura. Zaliczki
        // i faktury końcowe zostają narzędziem organizacji.
        ? [DocumentType.PROFORMA, DocumentType.INVOICE]
        : [DocumentType.PROFORMA, DocumentType.ADVANCE, DocumentType.INVOICE, DocumentType.FINAL],
      statuses: InvoiceStatus,
      docLangs: ['pl', 'en', 'de']
    });
  } catch (err) {
    log(`[invoices] panel GET /client/${clientId}: ${err.message}`);
    return res.status(500).send('Błąd wczytywania danych klienta');
  }
});

router.get('/profile', requireLogin, requireOwner, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).send('Brak kontekstu organizacji');

  const { lang, L } = labelsFor(req);
  res.locals.owner = !!req.session.user?.isOwner;
  res.locals.admin = !!req.session.user?.isAdmin;
  try {
    const [profile, templates] = await Promise.all([
      repository.getOrganizationProfile(organizationId),
      repository.listTemplates()
    ]);
    return res.render('owner/invoice_profile.njk', {
      L,
      panelLang: lang,
      profile,
      templates,
      currency: DOCUMENT_CURRENCY,
      docLangs: ['pl', 'en', 'de'],
      paymentMethods: ['transfer', 'cash', 'card', 'cod', 'prepaid'],
      defaultPatterns: require('../core/numbering').DEFAULT_PATTERNS
    });
  } catch (err) {
    log(`[invoices] panel GET /profile: ${err.message}`);
    return res.status(500).send('Błąd wczytywania ustawień faktur');
  }
});


/**
 * Ekran CRUD odbiorców końcowych (poziom 3).
 *
 * ⚠️ Bez `requireOwner` — z definicji korzysta z niego zwykły użytkownik
 * (salon), który prowadzi własną bazę klientów. Dane pobiera i zapisuje
 * wyłącznie przez `/api/v1/invoices/end-clients`, więc kontrola właściciela
 * jest po stronie API (`owner_user_id`), nie w widoku.
 */
router.get('/end-clients', requireLogin, async (req, res) => {
  const { lang, L } = labelsFor(req);
  res.locals.owner = !!req.session.user?.isOwner;
  res.locals.admin = !!req.session.user?.isAdmin;
  try {
    return res.render('owner/end_clients.njk', {
      L,
      panelLang: lang,
      // Te same definicje, których używa `core/compliance.js` przy budowaniu
      // dokumentu — jedno źródło prawdy o numerach rejestrowych per kraj.
      registryFields: require('../core/compliance').REGISTRY_FIELDS
    });
  } catch (err) {
    log(`[invoices] panel GET /end-clients: ${err.message}`);
    return res.status(500).send('Błąd wczytywania listy odbiorców');
  }
});

/**
 * Podgląd dokumentu w nowej karcie. Renderuje HTML faktury bez layoutu aplikacji
 * (to ma być wierny obraz dokumentu, nie podstrona panelu).
 */
// ⚠️ Bez `requireOwner`: salon musi móc podejrzeć WŁASNY dokument. Zakres
// sprawdza `canAccessInvoice` (organizacja dla ownera, `issuer_type='user'`
// + jego id dla salonu) — inaczej „Podgląd" w panelu salonu zwracał 403
// „Access denied. Owner privileges required.".
router.get('/:id/view', requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Nieprawidłowy identyfikator');
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).send('Nie znaleziono faktury');
    if (!canAccessInvoice(req, invoice)) return res.status(403).send('Brak dostępu');

    const html = await service.renderHtml(id);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    log(`[invoices] panel GET /${id}/view: ${err.message}`);
    return res.status(500).send('Błąd generowania podglądu');
  }
});

module.exports = router;
