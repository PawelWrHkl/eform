'use strict';

/**
 * REST API modułu fakturowania — warstwa kontrolerów.
 *
 * Zasada: router nie liczy i nie zna SQL-a. Waliduje wejście, woła
 * `InvoiceService` i mapuje wynik/wyjątek na odpowiedź HTTP.
 *
 * Montowanie w `server.js`:
 *   const invoiceRoutes = require('./services/invoices/http/routes');
 *   app.use('/api/v1/invoices', invoiceRoutes);
 *
 * Autoryzacja: korzysta z istniejących middleware repo (`middleware/loginMixture.js`).
 * ⚠️ `requireOwner` dopuszcza owner/admin — fakturowanie jest operacją
 * organizacji, nie klienta. Endpointy odczytu wymagają zalogowania i sprawdzają,
 * czy dokument należy do organizacji z sesji (`http/session.js`).
 *
 * Endpointy:
 *   POST   /from-order/:orderId       utworzenie dokumentu z zamówienia
 *   POST   /:id/issue                 wystawienie szkicu (nadanie numeru)
 *   POST   /:id/status                zmiana statusu (paid/cancelled/overdue)
 *   POST   /:id/correction            faktura korygująca
 *   GET    /:id                       dokument w JSON
 *   GET    /:id/preview               podgląd HTML
 *   GET    /:id/pdf                   plik PDF
 *   GET    /                          lista dokumentów organizacji
 *   GET    /templates/list            dostępne szablony
 *   GET    /profile/current           profil fakturowania organizacji
 *   PUT    /profile/current           aktualizacja profilu
 */

const express = require('express');
const { requireLogin, requireOwner } = require('../../../middleware/loginMixture');
const { InvoiceService, DocumentType, InvoiceStatus } = require('../main');
const repository = require('../db/repository');
const { organizationIdFromSession, belongsToSessionOrganization } = require('./session');
const { log } = require('../../../utils/logging');

const router = express.Router();
const service = new InvoiceService();

/**
 * @param {number|string} value
 * @returns {number|null}
 */
function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Jednolita obsługa błędów: 400 dla naruszeń reguł domenowych, 500 dla reszty. */
function sendError(res, err, context) {
  const message = err && err.message ? err.message : 'Nieznany błąd';
  const isDomainError = /nie istnieje|wymaga|Niedozwolona|Nieprawidłowy|nie ma pozycji|zakresie/i.test(message);
  log(`[invoices] ${context}: ${message}`);
  return res.status(isDomainError ? 400 : 500).json({ success: false, message });
}

// ---------------------------------------------------------------------------
// Tworzenie dokumentów
// ---------------------------------------------------------------------------

router.post('/from-order/:orderId', requireLogin, requireOwner, async (req, res) => {
  const orderId = toId(req.params.orderId);
  if (!orderId) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator zamówienia' });

  const documentType = req.body?.documentType || DocumentType.INVOICE;
  if (!Object.values(DocumentType).includes(documentType)) {
    return res.status(400).json({ success: false, message: `Nieznany typ dokumentu: ${documentType}` });
  }
  if (documentType === DocumentType.CORRECTION) {
    return res.status(400).json({ success: false, message: 'Korektę tworzy się przez POST /:id/correction' });
  }

  try {
    const result = await service.createFromOrder({
      orderId,
      documentType,
      lang: req.body?.lang,
      currency: req.body?.currency,
      issue: req.body?.issue === true,
      // ⚠️ Tylko JAWNE `true`/`false` w body jest ręcznym nadpisaniem. `=== true`
      // dawałoby zawsze boolean, a `false` wyłącza automatyczne sprawdzenie w
      // VIES (patrz `InvoiceService.verifyBuyerVatId`) — czyli weryfikacja
      // nigdy by się nie odpaliła.
      vatEuVerified: typeof req.body?.vatEuVerified === 'boolean' ? req.body.vatEuVerified : undefined,
      skipVies: req.body?.skipVies === true,
      useSubPrices: req.body?.useSubPrices === true,
      advancePercent: req.body?.advancePercent,
      saleDate: req.body?.saleDate,
      notes: req.body?.notes,
      createdByPin: req.session?.user?.pin
    });
    return res.status(201).json({ success: true, id: result.id, number: result.number, invoice: result.invoice });
  } catch (err) {
    return sendError(res, err, `POST /from-order/${orderId}`);
  }
});

router.post('/:id/issue', requireLogin, requireOwner, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!belongsToSessionOrganization(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

    const result = await service.issue(id, { actorPin: req.session?.user?.pin });
    return res.json({ success: true, ...result });
  } catch (err) {
    return sendError(res, err, `POST /${id}/issue`);
  }
});

router.post('/:id/status', requireLogin, requireOwner, async (req, res) => {
  const id = toId(req.params.id);
  const status = req.body?.status;
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  if (!Object.values(InvoiceStatus).includes(status)) {
    return res.status(400).json({ success: false, message: `Nieznany status: ${status}` });
  }
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!belongsToSessionOrganization(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

    await service.changeStatus(id, status, {
      actorPin: req.session?.user?.pin,
      paidAmount: req.body?.paidAmount
    });
    return res.json({ success: true, id, status });
  } catch (err) {
    return sendError(res, err, `POST /${id}/status`);
  }
});

router.post('/:id/correction', requireLogin, requireOwner, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  if (!Array.isArray(req.body?.items) || !req.body.items.length) {
    return res.status(400).json({ success: false, message: 'Korekta wymaga listy pozycji `items` (stan po korekcie)' });
  }
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!belongsToSessionOrganization(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

    const result = await service.createCorrection({
      invoiceId: id,
      items: req.body.items,
      reason: req.body.reason,
      issue: req.body.issue !== false,
      actorPin: req.session?.user?.pin
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return sendError(res, err, `POST /${id}/correction`);
  }
});

// ---------------------------------------------------------------------------
// Odczyt i renderowanie
// ---------------------------------------------------------------------------

router.get('/', requireLogin, requireOwner, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).json({ success: false, message: 'Brak kontekstu organizacji' });
  try {
    const items = await service.list({
      organizationId,
      status: req.query.status,
      documentType: req.query.documentType,
      orderId: req.query.orderId ? Number(req.query.orderId) : undefined,
      limit: Math.min(Number(req.query.limit) || 50, 200),
      offset: Number(req.query.offset) || 0
    });
    return res.json({ success: true, items });
  } catch (err) {
    return sendError(res, err, 'GET /');
  }
});

router.get('/templates/list', requireLogin, requireOwner, async (_req, res) => {
  try {
    return res.json({ success: true, items: await repository.listTemplates() });
  } catch (err) {
    return sendError(res, err, 'GET /templates/list');
  }
});

router.get('/profile/current', requireLogin, requireOwner, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).json({ success: false, message: 'Brak kontekstu organizacji' });
  try {
    const profile = await repository.getOrganizationProfile(organizationId);
    if (!profile) return res.status(404).json({ success: false, message: 'Nie znaleziono organizacji' });
    return res.json({ success: true, profile });
  } catch (err) {
    return sendError(res, err, 'GET /profile/current');
  }
});

router.put('/profile/current', requireLogin, requireOwner, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).json({ success: false, message: 'Brak kontekstu organizacji' });
  try {
    const ok = await service.updateOrganizationProfile(organizationId, req.body || {});
    return res.json({ success: ok });
  } catch (err) {
    return sendError(res, err, 'PUT /profile/current');
  }
});

router.get('/:id', requireLogin, requireOwner, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!belongsToSessionOrganization(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });
    return res.json({ success: true, invoice });
  } catch (err) {
    return sendError(res, err, `GET /${id}`);
  }
});

router.get('/:id/preview', requireLogin, requireOwner, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).send('Nieprawidłowy identyfikator');
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).send('Nie znaleziono faktury');
    if (!belongsToSessionOrganization(req, invoice)) return res.status(403).send('Brak dostępu');

    const html = await service.renderHtml(id);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    log(`[invoices] GET /${id}/preview: ${err.message}`);
    return res.status(500).send('Błąd generowania podglądu');
  }
});

router.get('/:id/pdf', requireLogin, requireOwner, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!belongsToSessionOrganization(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

    const { buffer, filename } = await service.renderPdf(id);
    // `inline` → klient otwiera podgląd; `?download=1` wymusza zapis pliku.
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      'Content-Length': String(buffer.length)
    });
    return res.send(buffer);
  } catch (err) {
    return sendError(res, err, `GET /${id}/pdf`);
  }
});

module.exports = router;
