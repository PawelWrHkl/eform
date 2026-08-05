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
const { organizationIdFromSession } = require('./session');
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
 * Zamówienia wysłane, do których nie ma jeszcze dokumentu — kandydaci do
 * zafakturowania. Podpowiedź o stawce liczona z pary krajów
 * (`organization.country` vs `user.country`), czyli tak samo jak reguła
 * podatkowa w `core/taxRules.js`.
 *
 * @param {number} organizationId
 * @param {number} [limit]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function listInvoiceableOrders(organizationId, limit = 40) {
  // ⚠️ Z listy wypadają tylko zamówienia z dokumentem ROZLICZAJĄCYM
  // (`invoice`/`final`). Zamówienie z samą proformą albo zaliczką MUSI zostać —
  // inaczej nie da się do niego wystawić faktury końcowej, a bez niej zaliczka
  // nigdy nie zostanie odliczona (wyłapane testem UI: końcowa lądowała na
  // kolejnym zamówieniu z listy i pokazywała pełną kwotę do zapłaty).
  // `advances_gross` niesie sumę zaliczek, żeby dropdown mógł to pokazać.
  const rows = await selectQuery(
    `SELECT o.id, o.order_idx, o.commision, o.sent_date, o.total_float, o.total_price,
            u.client_name, u.country AS buyer_country, u.tax_id AS buyer_tax_id,
            org.country AS seller_country,
            (SELECT COUNT(*) FROM invoice a
               WHERE a.order_id = o.id AND a.document_type = 'advance' AND a.status NOT IN ('cancelled', 'draft')) AS advances_count,
            (SELECT COALESCE(SUM(a.total_gross), 0) FROM invoice a
               WHERE a.order_id = o.id AND a.document_type = 'advance' AND a.status NOT IN ('cancelled', 'draft')) AS advances_gross
       FROM \`order\` o
       JOIN \`user\` u   ON u.id = o.user_id
       JOIN organization org ON org.id = o.organization_id
       LEFT JOIN invoice i ON i.order_id = o.id
                          AND i.document_type IN ('invoice', 'final')
                          AND i.status <> 'cancelled'
      WHERE o.organization_id = ? AND o.status = 'sent' AND i.id IS NULL
      ORDER BY o.sent_date DESC, o.id DESC
      LIMIT ?`,
    [organizationId, Number(limit)]
  );

  return (rows || []).map((r) => {
    const zeroRate = taxRules.isIntraEuZeroRate(r.seller_country, r.buyer_country);
    const sameCountry = taxRules.normalizeCountry(r.seller_country) === taxRules.normalizeCountry(r.buyer_country);
    return {
      ...r,
      taxHint: zeroRate ? 'zero_rate_hint' : (sameCountry ? 'domestic_hint' : 'export_hint'),
      zeroRate
    };
  });
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

router.get('/', requireLogin, requireOwner, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).send('Brak kontekstu organizacji');

  const { lang, L } = labelsFor(req);
  // ⚠️ `base.njk` czyta `owner`/`admin` z res.locals, ale ustawia je middleware
  // routera `/user` — poza nim nawigacja nie wiedziałaby, że to owner.
  res.locals.owner = !!req.session.user?.isOwner;
  res.locals.admin = !!req.session.user?.isAdmin;
  try {
    const [invoices, orders, profile] = await Promise.all([
      repository.listInvoices({ organizationId, limit: 100 }),
      listInvoiceableOrders(organizationId),
      repository.getOrganizationProfile(organizationId)
    ]);

    return res.render('owner/invoices.njk', {
      L,
      panelLang: lang,
      invoices: decorateInvoices(invoices, lang),
      orders,
      profile,
      currency: DOCUMENT_CURRENCY,
      documentTypes: [DocumentType.PROFORMA, DocumentType.ADVANCE, DocumentType.INVOICE, DocumentType.FINAL],
      statuses: InvoiceStatus,
      docLangs: ['pl', 'en', 'de']
    });
  } catch (err) {
    log(`[invoices] panel GET /: ${err.message}`);
    return res.status(500).send('Błąd wczytywania panelu faktur');
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
 * Podgląd dokumentu w nowej karcie. Renderuje HTML faktury bez layoutu aplikacji
 * (to ma być wierny obraz dokumentu, nie podstrona panelu).
 */
router.get('/:id/view', requireLogin, requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Nieprawidłowy identyfikator');
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).send('Nie znaleziono faktury');
    if (invoice.organizationId !== organizationIdFromSession(req)) return res.status(403).send('Brak dostępu');

    const html = await service.renderHtml(id);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    log(`[invoices] panel GET /${id}/view: ${err.message}`);
    return res.status(500).send('Błąd generowania podglądu');
  }
});

module.exports = router;
