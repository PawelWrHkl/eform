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
 *   GET    /search/clients            podpowiedzi klientów (combobox panelu)
 *   GET    /search/orders             podpowiedzi zamówień klienta
 *   GET    /end-clients/search        podpowiedzi odbiorców końcowych (poziom 3)
 *   GET    /end-clients/:id           odbiorca końcowy
 *   POST   /end-clients               nowy odbiorca końcowy
 *   PUT    /end-clients/:id           edycja odbiorcy
 *   DELETE /end-clients/:id           dezaktywacja odbiorcy
 *   GET    /orders/:orderId/invoiceable  ilości pozostałe do zafakturowania
 *   PUT    /orders/:orderId/end-client   przypisanie odbiorcy końcowego do zamówienia
 *   GET    /profile/current           profil fakturowania organizacji
 *   PUT    /profile/current           aktualizacja profilu
 */

const express = require('express');
const { requireLogin, requireOwner } = require('../../../middleware/loginMixture');
const { InvoiceService, DocumentType, InvoiceStatus } = require('../main');
const repository = require('../db/repository');
const { organizationIdFromSession, belongsToSessionOrganization, scopeFromSession, canAccessInvoice, canIssueAtLevel } = require('./session');
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
  const isDomainError = /nie istnieje|wymaga|Niedozwolona|Nieprawidłowy|nie ma pozycji|zakresie|zerową wartość/i.test(message);
  log(`[invoices] ${context}: ${message}`);
  return res.status(isDomainError ? 400 : 500).json({ success: false, message });
}

// ---------------------------------------------------------------------------
// Tworzenie dokumentów
// ---------------------------------------------------------------------------

// ⚠️ Bez `requireOwner`: poziom 3 wystawia ZWYKŁY użytkownik (salon) dla swojego
// odbiorcy końcowego — to sedno tej funkcji. Uprawnienia sprawdzamy per poziom
// (`canIssueAtLevel`) i per zamówienie (salon tylko swoje), patrz `http/session.js`.
router.post('/from-order/:orderId', requireLogin, async (req, res) => {
  const orderId = toId(req.params.orderId);
  if (!orderId) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator zamówienia' });

  const level = Number(req.body?.level) || 2;
  if (!canIssueAtLevel(req, level)) {
    return res.status(403).json({ success: false, message: `Brak uprawnień do wystawiania dokumentów na poziomie ${level}` });
  }

  const scope = scopeFromSession(req);
  const orderRows = await repository.getOrderOwnership(orderId);
  if (!orderRows) return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia' });
  const ownsOrder = scope.userId && Number(orderRows.user_id) === scope.userId;
  const sameOrg = scope.organizationId && Number(orderRows.organization_id) === scope.organizationId;
  if (!(scope.isOrgScope ? sameOrg : ownsOrder)) {
    return res.status(403).json({ success: false, message: 'Brak dostępu do zamówienia' });
  }

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
      level,
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
      allowZeroTotal: req.body?.allowZeroTotal === true,
      // v2: odbiorca końcowy, partie ilości, data dostawy
      endClientId: req.body?.endClientId,
      allocations: req.body?.allocations,
      deliveryDate: req.body?.deliveryDate,
      saleDate: req.body?.saleDate,
      notes: req.body?.notes,
      createdByPin: req.session?.user?.pin
    });
    return res.status(201).json({ success: true, id: result.id, number: result.number, invoice: result.invoice });
  } catch (err) {
    return sendError(res, err, `POST /from-order/${orderId}`);
  }
});

router.post('/:id/issue', requireLogin, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

    const result = await service.issue(id, { actorPin: req.session?.user?.pin });
    return res.json({ success: true, ...result });
  } catch (err) {
    return sendError(res, err, `POST /${id}/issue`);
  }
});

router.post('/:id/status', requireLogin, async (req, res) => {
  const id = toId(req.params.id);
  const status = req.body?.status;
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  if (!Object.values(InvoiceStatus).includes(status)) {
    return res.status(400).json({ success: false, message: `Nieznany status: ${status}` });
  }
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

    await service.changeStatus(id, status, {
      actorPin: req.session?.user?.pin,
      paidAmount: req.body?.paidAmount
    });
    return res.json({ success: true, id, status });
  } catch (err) {
    return sendError(res, err, `POST /${id}/status`);
  }
});

router.post('/:id/correction', requireLogin, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  if (!Array.isArray(req.body?.items) || !req.body.items.length) {
    return res.status(400).json({ success: false, message: 'Korekta wymaga listy pozycji `items` (stan po korekcie)' });
  }
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

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

router.get('/', requireLogin, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).json({ success: false, message: 'Brak kontekstu organizacji' });
  const scope = scopeFromSession(req);
  try {
    const items = await service.list({
      organizationId,
      // Salon widzi wyłącznie dokumenty, które sam wystawił
      issuerType: scope.isOrgScope ? undefined : 'user',
      issuerId: scope.isOrgScope ? undefined : scope.userId,
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



// ---------------------------------------------------------------------------
// Odbiorcy końcowi (poziom 3) — CRUD prywatnej bazy klientów Użytkownika
//
// ⚠️ Właścicielem rekordu jest ZALOGOWANY użytkownik (`session.user.userId`),
// a nie organizacja: baza klientów salonu jest jego prywatna. Każde zapytanie
// repozytorium filtruje po `owner_user_id`, więc podanie obcego id nic nie da.
// ⚠️ Te endpointy NIE są za `requireOwner` — z definicji korzysta z nich
// zwykły użytkownik (salon), który fakturuje swoich odbiorców.
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Request} req
 * @returns {number|null}
 */
function sessionUserId(req) {
  const id = Number(req.session?.user?.userId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/end-clients/search', requireLogin, async (req, res) => {
  const ownerUserId = sessionUserId(req);
  if (!ownerUserId) return res.status(403).json({ success: false, message: 'Brak użytkownika w sesji' });
  try {
    const items = await repository.searchEndClients({
      ownerUserId,
      query: String(req.query.q || ''),
      limit: Math.min(Number(req.query.limit) || 20, 50),
      includeInactive: req.query.includeInactive === '1'
    });
    return res.json({ success: true, items });
  } catch (err) {
    return sendError(res, err, 'GET /end-clients/search');
  }
});

router.get('/end-clients/:id', requireLogin, async (req, res) => {
  const ownerUserId = sessionUserId(req);
  const id = toId(req.params.id);
  if (!ownerUserId || !id) return res.status(400).json({ success: false, message: 'Nieprawidłowe żądanie' });
  try {
    const client = await repository.getEndClient({ id, ownerUserId });
    if (!client) return res.status(404).json({ success: false, message: 'Nie znaleziono odbiorcy' });
    return res.json({ success: true, client });
  } catch (err) {
    return sendError(res, err, `GET /end-clients/${id}`);
  }
});

router.post('/end-clients', requireLogin, async (req, res) => {
  const ownerUserId = sessionUserId(req);
  if (!ownerUserId) return res.status(403).json({ success: false, message: 'Brak użytkownika w sesji' });

  const data = req.body || {};
  if (!String(data.name || '').trim()) {
    return res.status(400).json({ success: false, message: 'Nazwa odbiorcy jest wymagana' });
  }
  // Firma bez NIP-u nie da się poprawnie zafakturować w obrocie B2B; osoba
  // prywatna go nie ma i to jest w porządku.
  if (data.client_type === 'company' && !String(data.tax_id || '').trim()) {
    return res.status(400).json({ success: false, message: 'Odbiorca typu „firma" wymaga numeru NIP/VAT' });
  }

  try {
    const organizationId = organizationIdFromSession(req) || Number(req.session?.user?.organization) || 0;
    const id = await repository.createEndClient({ ownerUserId, organizationId, data });
    return res.status(201).json({ success: true, id });
  } catch (err) {
    return sendError(res, err, 'POST /end-clients');
  }
});

router.put('/end-clients/:id', requireLogin, async (req, res) => {
  const ownerUserId = sessionUserId(req);
  const id = toId(req.params.id);
  if (!ownerUserId || !id) return res.status(400).json({ success: false, message: 'Nieprawidłowe żądanie' });
  try {
    const ok = await repository.updateEndClient({ id, ownerUserId, data: req.body || {} });
    if (!ok) return res.status(404).json({ success: false, message: 'Nie znaleziono odbiorcy albo brak zmian' });
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, err, `PUT /end-clients/${id}`);
  }
});

router.delete('/end-clients/:id', requireLogin, async (req, res) => {
  const ownerUserId = sessionUserId(req);
  const id = toId(req.params.id);
  if (!ownerUserId || !id) return res.status(400).json({ success: false, message: 'Nieprawidłowe żądanie' });
  try {
    // Dezaktywacja, nie DELETE — odbiorca bywa nabywcą wystawionych faktur,
    // a te muszą pozostać niezmienne.
    const ok = await repository.deactivateEndClient({ id, ownerUserId });
    if (!ok) return res.status(404).json({ success: false, message: 'Nie znaleziono odbiorcy' });
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, err, `DELETE /end-clients/${id}`);
  }
});


/**
 * Przypisanie odbiorcy końcowego do zamówienia (integracja poziomu 3
 * z formularzem/widokiem zamówienia).
 *
 * ⚠️ Dostęp: zamówienie musi należeć do zalogowanego użytkownika ALBO do jego
 * organizacji (owner/admin obsługują zamówienia swoich salonów). Odbiorca musi
 * należeć do właściciela zamówienia — inaczej dałoby się podpiąć obcego klienta.
 * `endClientId: null` czyści powiązanie.
 */
router.put('/orders/:orderId/end-client', requireLogin, async (req, res) => {
  const orderId = toId(req.params.orderId);
  if (!orderId) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator zamówienia' });

  const endClientId = req.body?.endClientId === null ? null : toId(req.body?.endClientId);
  if (req.body?.endClientId !== null && !endClientId) {
    return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator odbiorcy' });
  }

  try {
    const result = await repository.assignEndClientToOrder({
      orderId,
      endClientId,
      sessionUserId: sessionUserId(req),
      organizationId: organizationIdFromSession(req)
    });
    if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });
    return res.json({ success: true, orderId, endClientId });
  } catch (err) {
    return sendError(res, err, `PUT /orders/${orderId}/end-client`);
  }
});

// ---------------------------------------------------------------------------
// Częściowe fakturowanie: co jeszcze zostało do zafakturowania
// ---------------------------------------------------------------------------

router.get('/orders/:orderId/invoiceable', requireLogin, async (req, res) => {
  const orderId = toId(req.params.orderId);
  if (!orderId) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator zamówienia' });
  try {
    const { availableQuantity } = require('../core/allocations');
    const rows = await repository.getOrderInvoicingStatus(orderId);
    const items = rows.map((row) => {
      const state = availableQuantity({ orderItem: row, alreadyInvoiced: Number(row.invoiced) });
      return {
        orderItemId: row.order_item_id,
        name: row.name || row.commision || '',
        ordered: state.ordered,
        invoiced: state.invoiced,
        available: state.available,
        fullyInvoiced: state.fullyInvoiced,
        invoiceNumbers: row.invoice_numbers ? String(row.invoice_numbers).split(',') : []
      };
    });
    return res.json({ success: true, items, anyAvailable: items.some((i) => !i.fullyInvoiced) });
  } catch (err) {
    return sendError(res, err, `GET /orders/${orderId}/invoiceable`);
  }
});

// ---------------------------------------------------------------------------
// Wyszukiwanie dla comboboxów w panelu
//
// ⚠️ Klientów i zamówień będzie bardzo dużo, więc panel nie renderuje list —
// pyta te dwa endpointy w miarę pisania. Wynik jest zawsze przycięty
// (`limit`, twardo max 50), a zapytania siedzą w `db/repository.js`.
// Kolejność rejestracji ma znaczenie: MUSZĄ być przed `/:id`, bo inaczej
// „search" zostałoby potraktowane jako identyfikator dokumentu.
// ---------------------------------------------------------------------------

router.get('/search/clients', requireLogin, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).json({ success: false, message: 'Brak kontekstu organizacji' });

  const scope = scopeFromSession(req);
  const query = String(req.query.q || '');
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  try {
    // ⚠️ Endpoint zwraca „klientów, których wolno fakturować TEMU, kto pyta":
    // owner/admin dostaje klientów organizacji, salon swoich odbiorców końcowych.
    // Wcześniej było tu twarde `requireOwner`, przez co starsza (zacache'owana)
    // wersja `invoices.js` w przeglądarce salonu dostawała 403 „Owner privileges
    // required" przy samym wpisywaniu nazwy klienta.
    const items = scope.isOrgScope
      ? await repository.searchClients({ organizationId, query, limit })
      : await repository.searchEndClients({ ownerUserId: scope.userId, query, limit });

    return res.json({ success: true, items, scope: scope.isOrgScope ? 'organization' : 'end_clients' });
  } catch (err) {
    return sendError(res, err, 'GET /search/clients');
  }
});

router.get('/search/orders', requireLogin, async (req, res) => {
  const organizationId = organizationIdFromSession(req);
  if (!organizationId) return res.status(403).json({ success: false, message: 'Brak kontekstu organizacji' });

  const scope = scopeFromSession(req);

  // ⚠️ Czyje zamówienia szukamy zależy od TRYBU:
  //   organizacja (poziom 2) → zamówienia wskazanego klienta (`clientId` = user.id),
  //   salon (poziom 3)       → WŁASNE zamówienia salonu; `clientId` z panelu jest
  //                            wtedy id ODBIORCY KOŃCOWEGO, nie właściciela zamówień.
  // Pomyłka w tym miejscu dawała pustą listę zamówień w trybie salonu.
  const ownerOfOrders = scope.isOrgScope ? toId(req.query.clientId) : scope.userId;
  if (!ownerOfOrders) {
    return res.status(400).json({
      success: false,
      message: scope.isOrgScope ? 'Wymagany parametr clientId' : 'Brak użytkownika w sesji'
    });
  }

  try {
    const items = await repository.searchInvoiceableOrders({
      organizationId,
      clientId: ownerOfOrders,
      query: String(req.query.q || ''),
      limit: Math.min(Number(req.query.limit) || 20, 50),
      // Wykluczamy tylko dokumenty TEJ SAMEJ relacji: zamówienie zafakturowane
      // przez organizację (poziom 2) nadal czeka na fakturę salonu (poziom 3).
      issuerType: scope.isOrgScope ? 'organization' : 'user',
      issuerId: scope.isOrgScope ? organizationId : scope.userId,
      level: scope.isOrgScope ? 2 : 3
    });
    return res.json({ success: true, items });
  } catch (err) {
    return sendError(res, err, 'GET /search/orders');
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

router.get('/:id', requireLogin, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });
    return res.json({ success: true, invoice });
  } catch (err) {
    return sendError(res, err, `GET /${id}`);
  }
});

router.get('/:id/preview', requireLogin, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).send('Nieprawidłowy identyfikator');
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).send('Nie znaleziono faktury');
    if (!canAccessInvoice(req, invoice)) return res.status(403).send('Brak dostępu');

    const html = await service.renderHtml(id);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    log(`[invoices] GET /${id}/preview: ${err.message}`);
    return res.status(500).send('Błąd generowania podglądu');
  }
});

router.get('/:id/pdf', requireLogin, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Nieprawidłowy identyfikator' });
  try {
    const invoice = await repository.getInvoice(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Nie znaleziono faktury' });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ success: false, message: 'Brak dostępu' });

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
