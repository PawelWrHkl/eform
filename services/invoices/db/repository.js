'use strict';

/**
 * Repozytorium MySQL modułu fakturowania.
 *
 * Warstwa dostępu do danych — jedyne miejsce z SQL-em. Rdzeń (`core/*`) dostaje
 * ten obiekt przez wstrzyknięcie (`RepositoryLike` w `domain/types.js`), więc
 * testy jednostkowe podmieniają go na atrapę bez bazy.
 *
 * ⚠️ Konwencja repo, łatwa do przeoczenia: `db/core.selectQuery` zwraca **`false`**
 * przy zerowej liczbie wierszy, nie pustą tablicę. Wszystkie odczyty poniżej
 * normalizują to do `[]`/`null`.
 *
 * ⚠️ Kwoty: rdzeń liczy w groszach (`core/money.js`), baza trzyma DECIMAL(12,2).
 * Konwersję robi wyłącznie ten plik (`toMajor` na zapisie, `toMinor` na odczycie)
 * — żeby nie było dwóch źródeł prawdy o formacie kwoty.
 */

const fs = require('fs');
const path = require('path');
const { selectQuery, connetToDb } = require('../../../db/core');
const { log } = require('../../../utils/logging');
const money = require('../core/money');
const { toIsoDay } = require('../core/dates');

/** @typedef {import('../domain/types').Invoice} Invoice */
/** @typedef {import('../domain/types').OrganizationProfile} OrganizationProfile */

/**
 * @param {unknown} value
 * @returns {any}
 */
function parseJsonColumn(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}

/**
 * Wykonuje `fn` w transakcji na pojedynczym połączeniu z puli.
 * @template T
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const conn = await connetToDb();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* połączenie mogło już padnąć */ }
    throw err;
  } finally {
    await conn.end();
  }
}

/**
 * Atomowa rezerwacja kolejnego numeru w okresie.
 *
 * `LAST_INSERT_ID(expr)` w MySQL zapisuje wartość wyrażenia i zwraca ją przez
 * `insertId` — dzięki temu inkrementacja i odczyt to jedno zapytanie, bez
 * `SELECT ... FOR UPDATE` i bez ryzyka, że dwa równoległe wystawienia faktury
 * dostaną ten sam numer.
 *
 * @param {{ organizationId: number, documentType: string, periodKey: string }} params
 * @param {import('mysql2/promise').PoolConnection} [conn] Połączenie transakcji.
 * @returns {Promise<number>}
 */
async function allocateSequence({ organizationId, documentType, periodKey }, conn) {
  const sql = `
    INSERT INTO invoice_sequence (organization_id, document_type, period_key, last_number)
    VALUES (?, ?, ?, LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`;
  const executor = conn || (await connetToDb());
  try {
    const [result] = await executor.query(sql, [organizationId, documentType, periodKey]);
    return Number(result.insertId);
  } finally {
    if (!conn) await executor.end();
  }
}

/**
 * Profil fakturowania organizacji. Gdy organizacja nie ma wpisu w
 * `invoice_organization_profile`, budujemy profil zastępczy z tabeli
 * `organization` — moduł ma działać od pierwszego uruchomienia, bez konfiguracji.
 *
 * @param {number} organizationId
 * @returns {Promise<OrganizationProfile|null>}
 */
async function getOrganizationProfile(organizationId) {
  const rows = await selectQuery(
    `SELECT o.id, o.ident, o.name, o.street, o.city, o.zip, o.tax_id, o.country,
            o.company_mail, o.email, o.company_phone,
            p.*
       FROM organization o
       LEFT JOIN invoice_organization_profile p ON p.organization_id = o.id
      WHERE o.id = ?`,
    [organizationId]
  );
  const row = rows && rows[0];
  if (!row) return null;

  const numberPatterns = parseJsonColumn(row.number_patterns) || {};
  const themeVars = parseJsonColumn(row.theme_vars) || {};
  const footerNotes = parseJsonColumn(row.footer_notes) || {};

  return {
    organizationId: row.id,
    orgCode: row.ident || '',
    seller: {
      name: row.seller_name || row.name || '',
      taxId: row.seller_tax_id || row.tax_id || '',
      vatEuId: row.seller_vat_eu_id || '',
      street: row.seller_street || row.street || '',
      zip: row.seller_zip || row.zip || '',
      city: row.seller_city || row.city || '',
      country: (row.seller_country || row.country || '').slice(0, 2).toUpperCase(),
      email: row.seller_email || row.company_mail || row.email || '',
      phone: row.seller_phone || row.company_phone || ''
    },
    bankAccount: row.bank_iban ? { bankName: row.bank_name || '', iban: row.bank_iban, swift: row.bank_swift || '' } : null,
    localCurrency: row.local_currency || 'PLN',
    defaultCurrency: row.default_currency || 'EUR',
    defaultPaymentDays: Number(row.default_payment_days ?? 14),
    defaultLang: row.default_lang || 'pl',
    defaultPaymentMethod: row.default_payment_method || 'transfer',
    templateCode: row.template_code || 'default',
    themeVars,
    numberPatterns,
    footerNotes
  };
}

/**
 * @param {number} organizationId
 * @param {Record<string, any>} patch  Klucze zgodne z kolumnami profilu.
 * @returns {Promise<boolean>}
 */
async function upsertOrganizationProfile(organizationId, patch) {
  const allowed = [
    'seller_name', 'seller_tax_id', 'seller_vat_eu_id', 'seller_street', 'seller_zip',
    'seller_city', 'seller_country', 'seller_email', 'seller_phone',
    'bank_name', 'bank_iban', 'bank_swift', 'local_currency', 'default_currency',
    'default_payment_days', 'default_lang', 'default_payment_method', 'template_code',
    'theme_vars', 'number_patterns', 'footer_notes'
  ];
  const entries = Object.entries(patch || {}).filter(([k]) => allowed.includes(k));
  if (!entries.length) return false;

  const jsonCols = new Set(['theme_vars', 'number_patterns', 'footer_notes']);
  const cols = entries.map(([k]) => `\`${k}\``).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  const updates = entries.map(([k]) => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');
  const values = entries.map(([k, v]) => (jsonCols.has(k) && v && typeof v === 'object' ? JSON.stringify(v) : v));

  const conn = await connetToDb();
  try {
    await conn.query(
      `INSERT INTO invoice_organization_profile (organization_id, ${cols})
       VALUES (?, ${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      [organizationId, ...values]
    );
    return true;
  } catch (err) {
    log(`[invoices] upsertOrganizationProfile error: ${err.message}`);
    return false;
  } finally {
    await conn.end();
  }
}

/**
 * Zapis kompletnego dokumentu (nagłówek + pozycje + podsumowanie VAT) w jednej
 * transakcji. Numer jest nadawany TUTAJ, w tej samej transakcji co insert —
 * inaczej awaria między rezerwacją numeru a zapisem zostawiłaby dziurę w numeracji.
 *
 * @param {Invoice & { orgCode?: string, numberPattern?: string, createdByPin?: string }} invoice
 * @param {{ assignNumber?: boolean }} [opts]
 * @returns {Promise<{ id: number, number: string|null }>}
 */
async function createInvoice(invoice, opts = {}) {
  const { NumberingService } = require('../core/numbering');

  return withTransaction(async (conn) => {
    let number = invoice.number || null;

    if (!number && opts.assignNumber) {
      // v2: seria per (wystawca, poziom, rok) → `YYYY/00001`.
      // v1 (bez `issuerType`): stara seria per organizacja/typ dokumentu.
      const useIssuerSeries = !!invoice.issuerType;
      const numbering = new NumberingService({
        allocateSequence: useIssuerSeries
          ? ({ periodKey }) => allocateIssuerSequence({
            issuerType: invoice.issuerType,
            issuerId: invoice.issuerId || 0,
            level: invoice.level || 2,
            year: Number(String(periodKey).slice(0, 4))
          }, conn)
          : (params) => allocateSequence(params, conn)
      });
      const allocated = await numbering.next({
        organizationId: invoice.organizationId,
        documentType: invoice.documentType,
        isoDate: invoice.issueDate,
        pattern: invoice.numberPattern,
        orgCode: invoice.orgCode
      });
      number = allocated.number;
    }

    // ⚠️ Częściowe fakturowanie: blokada pozycji + walidacja zajętości MUSZĄ
    // być w tej samej transakcji co zapis alokacji, inaczej dwa równoległe
    // wystawienia przefakturują pozycję (patrz `core/allocations.js`).
    let validatedAllocations = null;
    if (Array.isArray(invoice.allocations) && invoice.allocations.length) {
      const { validateAllocations } = require('../core/allocations');
      await lockOrderItems(invoice.orderId, conn);
      const allocated = await getAllocatedQuantities(invoice.orderId, conn, {
        issuerType: invoice.issuerType,
        issuerId: invoice.issuerId,
        level: invoice.level
      });
      const [orderItemRows] = await conn.query('SELECT * FROM order_item WHERE order_id = ?', [invoice.orderId]);
      const orderItemsById = new Map((orderItemRows || []).map((r) => [Number(r.id), r]));

      const check = validateAllocations({
        requested: invoice.allocations,
        orderItemsById,
        allocatedByOrderItem: allocated
      });
      if (!check.valid) {
        throw new Error(`Częściowe fakturowanie: ${check.errors.join(' ')}`);
      }
      validatedAllocations = check.lines;
    }

    const cur = invoice.currency;

    // ⚠️ Kolumny i wartości jako JEDEN obiekt, a SQL generowany z jego kluczy.
    // Ręczne utrzymywanie trzech list (kolumny / znaki zapytania / wartości)
    // rozjechało się przy dodawaniu pól v2 i dało „Column count doesn't match
    // value count" — tak nie da się tego zepsuć.
    const headerData = {
      organization_id: invoice.organizationId,
      level: invoice.level || 2,
      issuer_type: invoice.issuerType || 'organization',
      issuer_id: invoice.issuerId || 0,
      // Po którym cenniku wystawiono — `core/pricing.js`
      price_basis: invoice.priceBasis || 'base',
      document_type: invoice.documentType,
      status: invoice.status,
      number,
      issue_date: invoice.issueDate,
      sale_date: invoice.saleDate,
      delivery_date: invoice.deliveryDate || null,
      due_date: invoice.dueDate,
      currency: cur,
      local_currency: invoice.localCurrency,
      exchange_rate: invoice.exchangeRate?.rate ?? null,
      exchange_rate_date: invoice.exchangeRate?.date ?? null,
      exchange_rate_source: invoice.exchangeRate?.source ?? null,

      seller_name: invoice.seller.name,
      seller_tax_id: invoice.seller.taxId || null,
      seller_vat_eu_id: invoice.seller.vatEuId || null,
      seller_street: invoice.seller.street || null,
      seller_zip: invoice.seller.zip || null,
      seller_city: invoice.seller.city || null,
      seller_country: invoice.seller.country || null,
      seller_registry: invoice.seller.registry ? JSON.stringify(invoice.seller.registry) : null,

      buyer_user_id: invoice.buyerUserId ?? null,
      buyer_group_user_id: invoice.buyerGroupUserId ?? null,
      buyer_type: invoice.buyerType || 'user',
      buyer_end_client_id: invoice.buyerEndClientId ?? null,
      buyer_name: invoice.buyer.name,
      buyer_tax_id: invoice.buyer.taxId || null,
      buyer_vat_eu_id: invoice.buyer.vatEuId || null,
      buyer_vat_eu_verified: invoice.buyerVatEuVerified ? 1 : 0,
      buyer_registry: invoice.buyer.registry ? JSON.stringify(invoice.buyer.registry) : null,
      delivery_address: invoice.deliveryAddress ? JSON.stringify(invoice.deliveryAddress) : null,
      // Wynik VIES: NULL = nie sprawdzano, 0/1 = sprawdzono z tym rezultatem
      vies_checked_at: invoice.viesCheckedAt ? new Date(invoice.viesCheckedAt) : null,
      vies_valid: invoice.viesValid === null || invoice.viesValid === undefined ? null : (invoice.viesValid ? 1 : 0),
      buyer_street: invoice.buyer.street || null,
      buyer_zip: invoice.buyer.zip || null,
      buyer_city: invoice.buyer.city || null,
      buyer_country: invoice.buyer.country || null,
      buyer_email: invoice.buyer.email || null,

      total_net: money.toMajor(invoice.totalNet, cur),
      total_tax: money.toMajor(invoice.totalTax, cur),
      total_gross: money.toMajor(invoice.totalGross, cur),
      total_tax_local: invoice.totalTaxLocal == null ? null : money.toMajor(invoice.totalTaxLocal, invoice.localCurrency),
      advance_settled: money.toMajor(invoice.advanceSettled || 0, cur),
      amount_due: money.toMajor(invoice.amountDue ?? invoice.totalGross, cur),

      payment_method: invoice.paymentMethod || null,
      order_id: invoice.orderId ?? null,
      // Numer i nazwa zamówienia jako snapshot — patrz `db/schema_v2.sql`
      // Rabat odbiorcy (JSON): typ, procent, kwota i podstawa — patrz `core/clientDiscount.js`
      client_discount: invoice.clientDiscount ? JSON.stringify(invoice.clientDiscount) : null,
      order_ref: invoice.orderRef || null,
      order_name: invoice.orderName || null,
      parent_invoice_id: invoice.parentInvoiceId ?? null,
      corrected_invoice_id: invoice.correctedInvoiceId ?? null,
      correction_reason: invoice.correctionReason || null,

      lang: invoice.lang || 'pl',
      template_code: invoice.templateCode || 'default',
      notes: invoice.notes || null,
      legal_notes: invoice.legalNotes ? JSON.stringify(invoice.legalNotes) : null,
      compliance: invoice.compliance ? JSON.stringify(invoice.compliance) : null,
      created_by_pin: invoice.createdByPin || null
    };

    const headerColumns = Object.keys(headerData);
    const [header] = await conn.query(
      `INSERT INTO invoice (${headerColumns.map((c) => `\`${c}\``).join(', ')})
       VALUES (${headerColumns.map(() => '?').join(', ')})`,
      headerColumns.map((c) => headerData[c])
    );
    const invoiceId = Number(header.insertId);

    /** `order_item_id` → `invoice_item.id`, potrzebne do zapisu alokacji. */
    const invoiceItemIdByOrderItem = new Map();

    for (const item of invoice.items || []) {
      const [itemResult] = await conn.query(
        `INSERT INTO invoice_item (
           invoice_id, position, name, description, unit, quantity, unit_price_net,
           discount_percent, net_amount, tax_category, tax_rate, tax_amount, gross_amount,
           order_item_id, order_number, width_mm, height_mm, meta
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          invoiceId, item.position, item.name, item.description || null, item.unit,
          item.meta?.displayQuantity ?? item.quantity,
          money.toMajor(item.unitPriceNet, cur), item.discountPercent || 0,
          money.toMajor(item.netAmount, cur), item.taxCategory, item.taxRate,
          money.toMajor(item.taxAmount, cur), money.toMajor(item.grossAmount, cur),
          item.orderItemId ?? null,
          // Wymogi specyfikacji: pozycja faktury niesie numer oryginalnego
          // zamówienia i wymiary (szerokość × wysokość dla rolet/firan).
          item.orderNumber || invoice.orderRef || null,
          item.meta?.widthMm ?? null, item.meta?.heightMm ?? null,
          item.meta ? JSON.stringify(item.meta) : null
        ]
      );
      if (item.orderItemId) invoiceItemIdByOrderItem.set(Number(item.orderItemId), Number(itemResult.insertId));
    }

    // Alokacje partii ilości — po zapisie pozycji, bo potrzebują ich ID
    for (const line of validatedAllocations || []) {
      const invoiceItemId = invoiceItemIdByOrderItem.get(Number(line.orderItemId));
      if (!invoiceItemId) {
        throw new Error(`Alokacja dla pozycji zamówienia ${line.orderItemId} nie ma odpowiadającej pozycji faktury`);
      }
      await conn.query(
        `INSERT INTO invoice_item_allocation
           (invoice_id, invoice_item_id, order_id, order_item_id, invoiced_quantity, order_quantity)
         VALUES (?,?,?,?,?,?)`,
        [invoiceId, invoiceItemId, invoice.orderId, line.orderItemId, line.quantity, line.ordered]
      );
    }

    for (const line of invoice.taxLines || []) {
      await conn.query(
        `INSERT INTO invoice_tax_line (invoice_id, tax_category, tax_rate, net_amount, tax_amount, gross_amount, legal_note_key)
         VALUES (?,?,?,?,?,?,?)`,
        [
          invoiceId, line.taxCategory, line.taxRate,
          money.toMajor(line.netAmount, cur), money.toMajor(line.taxAmount, cur), money.toMajor(line.grossAmount, cur),
          line.legalNoteKey || null
        ]
      );
    }

    await conn.query(
      `INSERT INTO invoice_event (invoice_id, event_type, to_status, actor_pin, payload)
       VALUES (?, 'created', ?, ?, ?)`,
      [invoiceId, invoice.status, invoice.createdByPin || null, JSON.stringify({ number, orderId: invoice.orderId ?? null })]
    );

    return { id: invoiceId, number };
  });
}

/**
 * Pełny dokument z pozycjami i podsumowaniem VAT, w kształcie `Invoice`
 * (kwoty w minor units — gotowe dla kalkulatora i renderera).
 *
 * @param {number} id
 * @returns {Promise<Invoice|null>}
 */
async function getInvoice(id) {
  const headers = await selectQuery('SELECT * FROM invoice WHERE id = ?', [id]);
  const h = headers && headers[0];
  if (!h) return null;

  const cur = h.currency;
  const itemRows = (await selectQuery('SELECT * FROM invoice_item WHERE invoice_id = ? ORDER BY position', [id])) || [];
  const taxRows = (await selectQuery('SELECT * FROM invoice_tax_line WHERE invoice_id = ? ORDER BY tax_rate DESC', [id])) || [];

  return {
    id: h.id,
    organizationId: h.organization_id,
    // ⚠️ Pola hierarchii MUSZĄ tu być: na nich opiera się autoryzacja salonu
    // (`http/session.js:canAccessInvoice`) i one decydują, czyja to seria
    // numeracji. Brak mapowania dawał 403 na własnym dokumencie salonu.
    level: h.level,
    issuerType: h.issuer_type,
    issuerId: h.issuer_id,
    priceBasis: h.price_basis || 'base',
    buyerType: h.buyer_type,
    buyerEndClientId: h.buyer_end_client_id,
    deliveryDate: toIsoDay(h.delivery_date),
    // Kontekst prawny zapisany przy wystawieniu — bez tego ponowny render
    // (podgląd/PDF po latach) gubiłby klauzule i numery rejestrowe.
    compliance: parseJsonColumn(h.compliance) || null,
    deliveryAddress: parseJsonColumn(h.delivery_address) || null,
    documentType: h.document_type,
    status: h.status,
    number: h.number,
    issueDate: toIsoDay(h.issue_date),
    saleDate: toIsoDay(h.sale_date),
    dueDate: toIsoDay(h.due_date),
    currency: cur,
    localCurrency: h.local_currency,
    exchangeRate: h.exchange_rate
      ? { from: cur, to: h.local_currency, rate: Number(h.exchange_rate), date: toIsoDay(h.exchange_rate_date), source: h.exchange_rate_source || '' }
      : undefined,
    seller: {
      name: h.seller_name, taxId: h.seller_tax_id, vatEuId: h.seller_vat_eu_id,
      street: h.seller_street, zip: h.seller_zip, city: h.seller_city, country: h.seller_country,
      registry: parseJsonColumn(h.seller_registry) || {}
    },
    buyer: {
      name: h.buyer_name, taxId: h.buyer_tax_id, vatEuId: h.buyer_vat_eu_id,
      street: h.buyer_street, zip: h.buyer_zip, city: h.buyer_city,
      country: h.buyer_country, email: h.buyer_email,
      registry: parseJsonColumn(h.buyer_registry) || {}
    },
    buyerUserId: h.buyer_user_id,
    buyerGroupUserId: h.buyer_group_user_id,
    buyerVatEuVerified: !!h.buyer_vat_eu_verified,
    viesCheckedAt: h.vies_checked_at ? new Date(h.vies_checked_at).toISOString() : null,
    viesValid: h.vies_valid === null || h.vies_valid === undefined ? null : !!h.vies_valid,
    items: itemRows.map((r) => ({
      id: r.id,
      position: r.position,
      name: r.name,
      description: r.description || '',
      unit: r.unit,
      quantity: Number(r.quantity),
      unitPriceNet: money.toMinor(r.unit_price_net, cur),
      discountPercent: Number(r.discount_percent),
      netAmount: money.toMinor(r.net_amount, cur),
      taxCategory: r.tax_category,
      taxRate: Number(r.tax_rate),
      taxAmount: money.toMinor(r.tax_amount, cur),
      grossAmount: money.toMinor(r.gross_amount, cur),
      orderItemId: r.order_item_id,
      // Numer zamówienia i wymiary: wymagane na pozycji faktury, więc muszą
      // wrócić z bazy, a nie tylko istnieć w świeżo policzonym dokumencie.
      orderNumber: r.order_number || null,
      meta: {
        ...(parseJsonColumn(r.meta) || {}),
        widthMm: r.width_mm ?? (parseJsonColumn(r.meta) || {}).widthMm ?? null,
        heightMm: r.height_mm ?? (parseJsonColumn(r.meta) || {}).heightMm ?? null
      }
    })),
    taxLines: taxRows.map((r) => ({
      taxCategory: r.tax_category,
      taxRate: Number(r.tax_rate),
      netAmount: money.toMinor(r.net_amount, cur),
      taxAmount: money.toMinor(r.tax_amount, cur),
      grossAmount: money.toMinor(r.gross_amount, cur),
      legalNoteKey: r.legal_note_key
    })),
    totalNet: money.toMinor(h.total_net, cur),
    totalTax: money.toMinor(h.total_tax, cur),
    totalGross: money.toMinor(h.total_gross, cur),
    totalTaxLocal: h.total_tax_local == null ? null : money.toMinor(h.total_tax_local, h.local_currency),
    advanceSettled: money.toMinor(h.advance_settled, cur),
    amountDue: money.toMinor(h.amount_due, cur),
    paymentMethod: h.payment_method,
    orderId: h.order_id,
    clientDiscount: parseJsonColumn(h.client_discount) || null,
    orderRef: h.order_ref || (h.order_id == null ? '' : String(h.order_id)),
    orderName: h.order_name || '',
    parentInvoiceId: h.parent_invoice_id,
    correctedInvoiceId: h.corrected_invoice_id,
    correctionReason: h.correction_reason,
    lang: h.lang,
    templateCode: h.template_code,
    notes: h.notes,
    legalNotes: parseJsonColumn(h.legal_notes) || []
  };
}

/**
 * Zmiana statusu + wpis audytowy. Walidację przejścia robi warstwa serwisu
 * (`core/statuses.assertTransition`) — repozytorium tylko zapisuje.
 *
 * @param {number} id
 * @param {{ status: string, fromStatus?: string, actorPin?: string, paidAmount?: number, paidAt?: string, number?: string }} patch
 * @returns {Promise<boolean>}
 */
async function updateStatus(id, patch) {
  return withTransaction(async (conn) => {
    const sets = ['status = ?'];
    const values = [patch.status];
    if (patch.number !== undefined) { sets.push('number = ?'); values.push(patch.number); }
    if (patch.paidAmount !== undefined) { sets.push('paid_amount = ?'); values.push(patch.paidAmount); }
    if (patch.paidAt !== undefined) { sets.push('paid_at = ?'); values.push(patch.paidAt); }
    values.push(id);

    await conn.query(`UPDATE invoice SET ${sets.join(', ')} WHERE id = ?`, values);
    await conn.query(
      `INSERT INTO invoice_event (invoice_id, event_type, from_status, to_status, actor_pin)
       VALUES (?, 'status_changed', ?, ?, ?)`,
      [id, patch.fromStatus || null, patch.status, patch.actorPin || null]
    );
    return true;
  });
}

/**
 * Lista dokumentów organizacji z prostym filtrowaniem i paginacją.
 *
 * @param {Object} params
 * @param {number} params.organizationId
 * @param {string} [params.status]
 * @param {string} [params.documentType]
 * @param {number} [params.orderId]
 * @param {number} [params.buyerUserId]
 * @param {number} [params.limit=50]
 * @param {number} [params.offset=0]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function listInvoices({ organizationId, status, documentType, orderId, buyerUserId, buyerEndClientId, issuerType, issuerId, level, limit = 50, offset = 0 }) {
  const where = ['organization_id = ?'];
  const values = [organizationId];
  // Zakres wystawcy: salon widzi wyłącznie dokumenty, które sam wystawił
  // (`issuer_type='user'` + jego id), organizacja swoje.
  if (issuerType) { where.push('issuer_type = ?'); values.push(issuerType); }
  if (issuerId !== undefined && issuerId !== null) { where.push('issuer_id = ?'); values.push(Number(issuerId)); }
  if (level) { where.push('level = ?'); values.push(Number(level)); }
  if (status) { where.push('status = ?'); values.push(status); }
  if (documentType) { where.push('document_type = ?'); values.push(documentType); }
  if (orderId) { where.push('order_id = ?'); values.push(orderId); }
  // Panel pracuje w kontekście wybranego klienta — patrz `http/panel.js`
  if (buyerUserId) { where.push('buyer_user_id = ?'); values.push(buyerUserId); }
  if (buyerEndClientId) { where.push('buyer_end_client_id = ?'); values.push(Number(buyerEndClientId)); }
  values.push(Number(limit), Number(offset));

  const rows = await selectQuery(
    `SELECT i.id, i.number, i.document_type, i.status, i.issue_date, i.due_date, i.currency,
            i.total_net, i.total_tax, i.total_gross, i.amount_due, i.buyer_name, i.order_id,
            i.level, i.issuer_type, i.issuer_id,
            -- 'AUTO' = dokument wystawiony przez automat (autoInvoicing.js)
            i.created_by_pin,
            -- Numer i nazwa zamówienia do rozeznania na liście.
            -- ⚠️ COALESCE ze złączeniem: dokumenty sprzed dodania kolumn
            -- (snapshot) mają je puste, więc dla nich bierzemy dane wprost
            -- z zamówienia — inaczej starsze faktury miałyby pustą kolumnę.
            COALESCE(i.order_ref, o.order_idx) AS order_ref,
            COALESCE(NULLIF(i.order_name, ''), o.commision) AS order_name,
            -- Użytkownik (salon), z którego zamówienia powstał dokument.
            -- ⚠️ To NIE to samo co nabywca: na poziomie 1 nabywcą jest
            -- organizacja, a zamówienie i tak złożył konkretny salon — i to on
            -- pozwala rozpoznać, czego dokument dotyczy.
            u.client_name AS order_user_name,
            u.ident AS order_user_ident
       FROM invoice i
       LEFT JOIN \`order\` o ON o.id = i.order_id
       LEFT JOIN \`user\` u ON u.id = o.user_id
      WHERE ${where.map((w) => `i.${w}`).join(' AND ')}
      ORDER BY i.issue_date DESC, i.id DESC
      LIMIT ? OFFSET ?`,
    values
  );
  return rows || [];
}


/**
 * Wyszukiwanie klientów organizacji dla comboboxa w panelu.
 *
 * ⚠️ SKALA: klientów i zamówień będzie bardzo dużo, więc panel NIE renderuje
 * żadnych pełnych list — pyta ten endpoint w miarę pisania. Dlatego:
 *  - wynik jest zawsze przycięty `LIMIT` (domyślnie 20),
 *  - dopasowanie idzie po prefiksie (`q%`) ORAZ po fragmencie (`%q%`), ale
 *    prefiks jest wyżej w sortowaniu — to on może skorzystać z indeksu na
 *    `client_name`, fragment wymaga skanu i jest tylko dopełnieniem,
 *  - żadnych podzapytań liczących dokumenty per wiersz (przy tysiącach klientów
 *    to byłby N+1 w SQL-u); liczniki pokazujemy dopiero dla WYBRANEGO klienta.
 *
 * @param {Object} params
 * @param {number} params.organizationId
 * @param {string} params.query
 * @param {number} [params.limit=20]
 * @returns {Promise<Array<{ id: number, client_name: string, ident: string, country: string, tax_id: string, city: string }>>}
 */
async function searchClients({ organizationId, query, limit = 20 }) {
  const q = String(query || '').trim();
  const prefix = `${q}%`;
  const infix = `%${q}%`;

  const rows = await selectQuery(
    `SELECT u.id, u.client_name, u.ident, u.country, u.tax_id, u.city
       FROM \`user\` u
      WHERE u.organization_id = ?
        AND (? = '' OR u.client_name LIKE ? OR u.ident LIKE ? OR u.tax_id LIKE ? OR u.city LIKE ?)
      ORDER BY (u.client_name LIKE ?) DESC, u.client_name
      LIMIT ?`,
    [organizationId, q, infix, prefix, prefix, infix, prefix, Number(limit)]
  );
  return rows || [];
}

/**
 * Ile podmiotów pasuje do frazy — do komunikatu „pokazano X z Y".
 *
 * ⚠️ Combobox z natury pokazuje TYLKO kilkanaście pozycji (przy 200
 * użytkownikach organizacji nie da się inaczej), ale bez tej liczby wygląda to
 * jak błąd wyszukiwania: „czemu tylko kilku, a nie wszyscy". Liczymy tym samym
 * warunkiem WHERE co wyszukiwanie, żeby obie liczby zawsze się zgadzały.
 *
 * @param {{ source: 'clients'|'end_clients'|'organizations', organizationId?: number, ownerUserId?: number, query?: string, excludeId?: number }} params
 * @returns {Promise<number>}
 */
async function countSearchMatches({ source, organizationId, ownerUserId, query = '', excludeId = null }) {
  const q = String(query || '').trim();
  const prefix = `${q}%`;
  const infix = `%${q}%`;

  if (source === 'organizations') {
    const rows = await selectQuery(
      `SELECT COUNT(*) AS c FROM organization
        WHERE (? = 0 OR id <> ?)
          AND (? = '' OR name LIKE ? OR ident LIKE ? OR tax_id LIKE ? OR city LIKE ?)`,
      [Number(excludeId) || 0, Number(excludeId) || 0, q, infix, prefix, prefix, prefix]
    );
    return rows && rows[0] ? Number(rows[0].c) : 0;
  }

  if (source === 'end_clients') {
    const byOwner = !!ownerUserId;
    const rows = await selectQuery(
      `SELECT COUNT(*) AS c FROM invoice_end_client
        WHERE (? = 1 AND owner_user_id = ? OR ? = 0 AND organization_id = ?)
          AND is_active = 1
          AND (? = '' OR name LIKE ? OR tax_id LIKE ? OR city LIKE ? OR email LIKE ?)`,
      [byOwner ? 1 : 0, Number(ownerUserId) || 0, byOwner ? 1 : 0, Number(organizationId) || 0,
        q, infix, prefix, prefix, prefix]
    );
    return rows && rows[0] ? Number(rows[0].c) : 0;
  }

  const rows = await selectQuery(
    `SELECT COUNT(*) AS c FROM \`user\` u
      WHERE u.organization_id = ?
        AND (? = '' OR u.client_name LIKE ? OR u.ident LIKE ? OR u.tax_id LIKE ? OR u.city LIKE ?)`,
    [organizationId, q, infix, prefix, prefix, infix]
  );
  return rows && rows[0] ? Number(rows[0].c) : 0;
}

/**
 * Organizacje jako NABYWCY poziomu 1 (HKL sprzedaje do innej organizacji).
 *
 * ⚠️ Organizacja wystawcy jest wykluczona — HKL nie sprzedaje sam sobie.
 *
 * @param {{ query?: string, limit?: number, excludeId?: number }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function searchOrganizations({ query = '', limit = 20, excludeId = null }) {
  const q = String(query || '').trim();
  const prefix = `${q}%`;
  const infix = `%${q}%`;
  const rows = await selectQuery(
    `SELECT id, ident, name, tax_id, country, city, street, zip
       FROM organization
      WHERE (? = 0 OR id <> ?)
        AND (? = '' OR name LIKE ? OR ident LIKE ? OR tax_id LIKE ? OR city LIKE ?)
      ORDER BY (name LIKE ?) DESC, name
      LIMIT ?`,
    [Number(excludeId) || 0, Number(excludeId) || 0, q, infix, prefix, prefix, prefix, prefix, Number(limit)]
  );
  // Ujednolicony kształt z `searchClients` — combobox panelu czyta te same pola
  return (rows || []).map((r) => ({ ...r, client_name: r.name }));
}

/**
 * Wyszukiwanie zamówień danego klienta, które można jeszcze zafakturować.
 *
 * `endClientId` (poziomy 3 i 4): zamówienia SPIĘTE z tym odbiorcą idą na górę
 * listy, a spięte z kimś innym w ogóle nie są pokazywane — powiązanie robi się
 * na formularzu zamówienia (`templates/new-order.njk`).
 *
 * Te same zasady co wyżej (limit + prefiks/fragment). Dopasowanie po numerze
 * zamówienia (`order_idx`) i po NAZWIE zamówienia (`commision`) — tego szukał
 * user. `advances_gross` i `items_net` liczone podzapytaniami tylko dla wierszy,
 * które faktycznie wracają (max `limit`), więc koszt nie rośnie z rozmiarem tabeli.
 *
 * @param {Object} params
 * @param {number} params.organizationId
 * @param {number} params.clientId
 * @param {string} params.query
 * @param {number} [params.limit=20]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function searchInvoiceableOrders({ organizationId, clientId = null, query, limit = 20, issuerType = null, issuerId = null, level = null, endClientId = null }) {
  const q = String(query || '').trim();
  const prefix = `${q}%`;
  const infix = `%${q}%`;
  // ⚠️ „Już zafakturowane" jest RELATYWNE DO POZIOMU: to samo zamówienie może
  // mieć fakturę organizacji (poziom 2) i niezależnie fakturę salonu dla jego
  // klienta (poziom 3) — to dwie różne relacje handlowe. Dlatego wykluczamy
  // tylko dokumenty tego samego wystawcy i poziomu, a nie jakiekolwiek.
  const scoped = !!(issuerType && level);

  const rows = await selectQuery(
    `SELECT o.id, o.order_idx, o.commision, o.sent_date, o.total_float,
            -- Aktualne przypisanie zamówienia do odbiorcy końcowego: panel
            -- musi ostrzec, zanim przepnie zamówienie na kogoś innego.
            o.end_client_id, ec.name AS end_client_name,
            (SELECT COALESCE(SUM(a.total_gross), 0) FROM invoice a
              WHERE a.order_id = o.id AND a.document_type = 'advance'
                AND a.status NOT IN ('cancelled', 'draft')) AS advances_gross,
            (SELECT COALESCE(SUM(it.total_price), 0) FROM order_item it
              WHERE it.order_id = o.id) AS items_net
       FROM \`order\` o
       LEFT JOIN invoice_end_client ec ON ec.id = o.end_client_id
       LEFT JOIN invoice i ON i.order_id = o.id
                          AND i.document_type IN ('invoice', 'final')
                          AND i.status <> 'cancelled'
                          AND (? = 0 OR (i.issuer_type = ? AND i.issuer_id = ? AND i.level = ?))
      WHERE o.organization_id = ? AND (? = 0 OR o.user_id = ?) AND o.status = 'sent' AND i.id IS NULL
        AND (? = '' OR o.order_idx LIKE ? OR o.commision LIKE ?)
        -- ⚠️ Zamówienia spięte z INNYM odbiorcą są POKAZYWANE, nie ukrywane:
        -- panel pyta wtedy „zamówienie jest odbiorcy X, przypisać do Y?".
        -- Ukrywanie ich uniemożliwiało poprawienie błędnego przypisania, a
        -- samo przepięcie i tak wymaga świadomego potwierdzenia.
        AND (? = 0 OR 1 = 1)
      ORDER BY (o.end_client_id = ?) DESC, (o.order_idx LIKE ?) DESC, o.sent_date DESC, o.id DESC
      LIMIT ?`,
    [
      scoped ? 1 : 0, issuerType || '', Number(issuerId) || 0, Number(level) || 0,
      organizationId, Number(clientId) || 0, Number(clientId) || 0, q, prefix, infix,
      Number(endClientId) || 0, Number(endClientId) || 0, Number(endClientId) || 0,
      prefix, Number(limit)
    ]
  );
  return rows || [];
}

/**
 * Zapytanie, które przy błędzie RZUCA. `selectQuery` zwraca wtedy `false`, czyli
 * to samo co „brak wierszy" — przy sprawdzaniu „czy faktura już jest" taka
 * pomyłka oznacza drugą fakturę za to samo zamówienie.
 */
async function strictQuery(sql, values) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(sql, values);
    return rows;
  } finally {
    await conn.end();
  }
}

/**
 * Wspólny warunek „zamówienie klienta czeka na fakturę" dla okna zamówień
 * (`listInvoiceableOrdersForClient`) i licznika na karcie klienta — obie liczby
 * muszą wychodzić z tego samego WHERE, inaczej karta i okno by się rozjeżdżały.
 *
 * ⚠️ `o.status = 'sent'` obowiązuje TAKŻE przy filtrze `!sent!`: w bazie są
 * zamówienia `active` z `prod_status = '!sent!'` — `order_idx` nowego zamówienia
 * trafił na stary numer z pliku produkcji (synchronizacja paruje statusy po
 * numerze). Takiego zamówienia nikt nie przekazał do produkcji.
 *
 * ⚠️ „Już zafakturowane" = jakikolwiek nieanulowany dokument `invoice`/`final`
 * na tym zamówieniu NA TYM POZIOMIE, bez dopasowania wystawcy: na poziomie 2
 * wystawcą jest zawsze organizacja zamówienia, a dokumenty z v1 mają
 * `issuer_id = 0` — dopasowanie po wystawcy pokazywałoby je jako niezafakturowane.
 */
function invoiceableForClientWhere({ organizationId, clientId, level, onlyShipped }) {
  return {
    sql: `
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
      WHERE o.organization_id = ? AND o.user_id = ? AND o.status = 'sent'
        AND (? = 0 OR o.prod_status = '!sent!')
        AND NOT EXISTS (
              SELECT 1 FROM invoice i
               WHERE i.order_id = o.id AND i.level = ?
                 AND i.document_type IN ('invoice', 'final')
                 AND i.status <> 'cancelled')`,
    values: [organizationId, clientId, onlyShipped ? 1 : 0, Number(level)]
  };
}

/**
 * Ile zamówień klienta czeka na fakturę — licznik na karcie klienta.
 *
 * @param {{ organizationId: number, clientId: number, level: number, onlyShipped?: boolean }} params
 * @returns {Promise<number>}
 */
async function countInvoiceableOrdersForClient({ organizationId, clientId, level, onlyShipped = true }) {
  const where = invoiceableForClientWhere({ organizationId, clientId, level, onlyShipped });
  const rows = await selectQuery(`SELECT COUNT(*) AS c ${where.sql}`, where.values);
  return rows && rows[0] ? Number(rows[0].c) : 0;
}

/**
 * Pełna lista zamówień klienta do zafakturowania — „okno zamówień" w widoku
 * klienta na poziomie 2, w miejsce comboboxa z podpowiedziami.
 *
 * Domyślnie tylko `prod_status = '!sent!'` (towar wyjechał do klienta — moment
 * wystawienia faktury). `onlyShipped: false` pokazuje wszystkie przekazane do
 * produkcji — do proformy i faktury zaliczkowej przed wysyłką.
 *
 * `unshipped_positions` — ile pozycji ma w pliku produkcji status inny niż
 * `!sent!`. `order.prod_status` to status pozycji z NAJPÓŹNIEJSZĄ datą, więc
 * zamówienie potrafi być „wysłane", choć któraś pozycja jeszcze nie wyjechała.
 *
 * @param {{ organizationId: number, clientId: number, level: number, onlyShipped?: boolean, limit?: number }} params
 * @returns {Promise<{ items: Array<Record<string, any>>, total: number }>}
 */
async function listInvoiceableOrdersForClient({ organizationId, clientId, level, onlyShipped = true, limit = 500 }) {
  const where = invoiceableForClientWhere({ organizationId, clientId, level, onlyShipped });
  const [rows, total] = await Promise.all([
    selectQuery(
      `SELECT o.id, o.order_idx, o.commision, o.sent_date, o.delivery_date, o.total_float,
              o.prod_status, o.spedition_numbers,
              (SELECT COALESCE(SUM(a.total_gross), 0) FROM invoice a
                WHERE a.order_id = o.id AND a.level = ? AND a.document_type = 'advance'
                  AND a.status NOT IN ('cancelled', 'draft')) AS advances_gross,
              (SELECT COALESCE(SUM(it.total_price), 0) FROM order_item it
                WHERE it.order_id = o.id) AS items_net,
              (SELECT COUNT(*) FROM position_statuses ps
                WHERE ps.user_ident = u.ident AND CAST(ps.order_idx AS CHAR) = o.order_idx
                  AND ps.status <> '!sent!') AS unshipped_positions
       ${where.sql}
       ORDER BY ${onlyShipped ? 'o.delivery_date DESC' : 'o.sent_date DESC'}, o.id DESC
       LIMIT ?`,
      [Number(level), ...where.values, Number(limit)]
    ),
    countInvoiceableOrdersForClient({ organizationId, clientId, level, onlyShipped })
  ]);
  return { items: rows || [], total };
}

/**
 * Zamówienia, dla których automat ma wystawić fakturę na danym poziomie
 * (`services/invoices/autoInvoicing.js`).
 *
 * Warunki — każdy z konkretnego powodu:
 *  - `status = 'sent'` i `prod_status = '!sent!'` — patrz `invoiceableForClientWhere`,
 *  - WSZYSTKIE pozycje w `position_statuses` mają `!sent!`: `prod_status` to
 *    status pozycji z najpóźniejszą datą, więc sam w sobie nie gwarantuje, że
 *    wyjechało całe zamówienie,
 *  - `delivery_date >= since` — próg włączenia automatu; bez niego pierwszy
 *    przebieg zafakturowałby całą historię wysłanych zamówień,
 *  - brak JAKIEGOKOLWIEK dokumentu `invoice`/`final`/`advance` na tym poziomie,
 *    także anulowanego albo szkicu: anulowana faktura oznacza, że ktoś zajął się
 *    zamówieniem ręcznie — automat wystawiałby ją od nowa co godzinę; zaliczka
 *    wymaga faktury końcowej, którą wystawia człowiek.
 *
 * @param {{ level: number, since: string, organizationIds?: number[], excludeOrganizationId?: number|null, limit?: number }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findAutoInvoiceCandidates({ level, since, organizationIds = [], excludeOrganizationId = null, limit = 100 }) {
  const values = [since];
  let filters = '';
  if (organizationIds.length) { filters += ' AND o.organization_id IN (?)'; values.push(organizationIds); }
  if (excludeOrganizationId) { filters += ' AND o.organization_id <> ?'; values.push(Number(excludeOrganizationId)); }
  values.push(Number(level), Number(limit));

  return strictQuery(
    `SELECT o.id, o.order_idx, o.commision, o.organization_id, o.user_id, o.delivery_date, u.ident AS user_ident
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
      WHERE o.status = 'sent'
        AND o.prod_status = '!sent!'
        AND o.delivery_date >= ?${filters}
        AND NOT EXISTS (
              SELECT 1 FROM position_statuses ps
               WHERE ps.user_ident = u.ident AND CAST(ps.order_idx AS CHAR) = o.order_idx
                 AND ps.status <> '!sent!')
        AND NOT EXISTS (
              SELECT 1 FROM invoice i
               WHERE i.order_id = o.id AND i.level = ?
                 AND i.document_type IN ('invoice', 'final', 'advance'))
      ORDER BY o.delivery_date, o.id
      LIMIT ?`,
    values
  );
}

/**
 * Czy zamówienie ma już dokument na tym poziomie (ta sama reguła co w
 * `findAutoInvoiceCandidates`). Automat pyta jeszcze raz tuż przed zapisem —
 * między wyszukaniem a wystawieniem ktoś mógł wystawić fakturę ręcznie.
 *
 * @param {{ orderId: number, level: number }} params
 * @returns {Promise<boolean>}
 */
async function hasLevelInvoice({ orderId, level }) {
  const rows = await strictQuery(
    `SELECT id FROM invoice
      WHERE order_id = ? AND level = ? AND document_type IN ('invoice', 'final', 'advance')
      LIMIT 1`,
    [orderId, Number(level)]
  );
  return rows.length > 0;
}

/**
 * Faktury zaliczkowe wystawione do danego zamówienia — potrzebne, żeby faktura
 * końcowa mogła je odliczyć (`InvoiceCalculator.settleAdvances`).
 *
 * @param {number} orderId
 * @returns {Promise<Array<{ id: number, number: string, totalGross: number, currency: string }>>}
 */
async function getAdvanceInvoicesForOrder(orderId) {
  const rows = await selectQuery(
    `SELECT id, number, currency, total_gross
       FROM invoice
      WHERE order_id = ? AND document_type = 'advance' AND status NOT IN ('cancelled', 'draft')
      ORDER BY issue_date, id`,
    [orderId]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    number: r.number,
    currency: r.currency,
    totalGross: money.toMinor(r.total_gross, r.currency)
  }));
}


/* =====================================================================
 * v2: hierarchia 3 poziomów, odbiorcy końcowi, częściowe fakturowanie
 * ===================================================================== */

/**
 * Atomowa rezerwacja numeru w serii wystawcy (`YYYY/00001`).
 *
 * Klucz licznika to (typ wystawcy, id wystawcy, poziom, rok) — każdy podmiot na
 * każdym poziomie ma własną serię zerowaną 1 stycznia. Ta sama technika co w
 * `allocateSequence`: `LAST_INSERT_ID(expr)` zapisuje i zwraca wartość w jednym
 * zapytaniu, więc dwa równoległe wystawienia nie dostaną tego samego numeru
 * (żadnego `SELECT … FOR UPDATE`).
 *
 * @param {{ issuerType: string, issuerId: number, level: number, year: number }} params
 * @param {import('mysql2/promise').PoolConnection} [conn]
 * @returns {Promise<number>}
 */
async function allocateIssuerSequence({ issuerType, issuerId, level, year }, conn) {
  const sql = `
    INSERT INTO invoice_issuer_sequence (issuer_type, issuer_id, level, year, last_number)
    VALUES (?, ?, ?, ?, LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`;
  const executor = conn || (await connetToDb());
  try {
    const [result] = await executor.query(sql, [issuerType, Number(issuerId) || 0, Number(level), Number(year)]);
    return Number(result.insertId);
  } finally {
    if (!conn) await executor.end();
  }
}

/**
 * Profil wystawcy dla poziomu. Gdy go nie ma, budujemy zastępczy z danych
 * źródłowych (organizacja / użytkownik), żeby moduł działał bez konfiguracji —
 * tak samo jak `getOrganizationProfile` w v1.
 *
 * @param {{ issuerType: string, issuerId: number, level: number }} params
 * @returns {Promise<Object|null>}
 */
async function getIssuerProfile({ issuerType, issuerId, level }) {
  const rows = await selectQuery(
    `SELECT * FROM invoice_issuer_profile WHERE issuer_type = ? AND issuer_id = ? AND level = ?`,
    [issuerType, Number(issuerId) || 0, Number(level)]
  );
  const row = rows && rows[0];
  if (row) {
    return {
      id: row.id,
      issuerType: row.issuer_type,
      issuerId: row.issuer_id,
      level: row.level,
      name: row.name,
      taxId: row.tax_id || '',
      vatEuId: row.vat_eu_id || '',
      registryNumbers: parseJsonColumn(row.registry_numbers) || {},
      street: row.street || '',
      zip: row.zip || '',
      city: row.city || '',
      country: (row.country || 'PL').toUpperCase(),
      email: row.email || '',
      phone: row.phone || '',
      bankAccount: row.bank_iban ? { bankName: row.bank_name || '', iban: row.bank_iban, swift: row.bank_swift || '' } : null,
      currency: row.currency || 'EUR',
      localCurrency: row.local_currency || 'PLN',
      paymentDays: Number(row.payment_days ?? 14),
      defaultLang: row.default_lang || 'pl',
      templateCode: row.template_code || 'default',
      themeVars: parseJsonColumn(row.theme_vars) || {},
      numberPattern: row.number_pattern || '{YYYY}/{NR:5}',
      legalSettings: parseJsonColumn(row.legal_settings) || {},
      footerNotes: parseJsonColumn(row.footer_notes) || {}
    };
  }

  // --- Profil zastępczy -------------------------------------------------
  if (issuerType === 'organization') {
    const org = await getOrganizationProfile(issuerId);
    if (!org) return null;
    return {
      issuerType, issuerId: Number(issuerId), level: Number(level),
      name: org.seller.name, taxId: org.seller.taxId, vatEuId: org.seller.vatEuId,
      registryNumbers: org.seller.taxId ? { NIP: org.seller.taxId } : {},
      street: org.seller.street, zip: org.seller.zip, city: org.seller.city,
      country: org.seller.country, email: org.seller.email, phone: org.seller.phone,
      bankAccount: org.bankAccount, currency: 'EUR', localCurrency: org.localCurrency,
      paymentDays: org.defaultPaymentDays, defaultLang: org.defaultLang,
      templateCode: org.templateCode, themeVars: org.themeVars,
      numberPattern: '{YYYY}/{NR:5}', legalSettings: {}, footerNotes: org.footerNotes
    };
  }

  if (issuerType === 'user') {
    const rows2 = await selectQuery(
      `SELECT u.id, u.client_name, u.tax_id, u.street, u.zip, u.city, u.country, u.email, u.phone,
              o.local_currency
         FROM \`user\` u
         LEFT JOIN invoice_organization_profile o ON o.organization_id = u.organization_id
        WHERE u.id = ?`,
      [issuerId]
    );
    const u = rows2 && rows2[0];
    if (!u) return null;
    return {
      issuerType, issuerId: Number(issuerId), level: Number(level),
      name: u.client_name || '', taxId: u.tax_id || '', vatEuId: u.tax_id || '',
      registryNumbers: u.tax_id ? { NIP: u.tax_id } : {},
      street: u.street || '', zip: u.zip || '', city: u.city || '',
      country: (u.country || 'PL').toUpperCase().slice(0, 2),
      email: u.email || '', phone: u.phone || '', bankAccount: null,
      currency: 'EUR', localCurrency: u.local_currency || 'PLN', paymentDays: 14,
      defaultLang: 'pl', templateCode: 'default', themeVars: {},
      numberPattern: '{YYYY}/{NR:5}', legalSettings: {}, footerNotes: {}
    };
  }

  // Producentem jest HKL — organizacja matka. Nie ma osobnej tabeli, więc profil
  // zastępczy budujemy z jej danych; inaczej admin nie mógłby wystawić NICZEGO
  // na poziomie 1, dopóki ktoś ręcznie nie wypełni profilu producenta.
  if (issuerType === 'manufacturer') {
    const { HKL_ORG_ID } = require('../../subPrices');
    const hkl = await getIssuerProfile({ issuerType: 'organization', issuerId: HKL_ORG_ID, level: Number(level) });
    return hkl ? { ...hkl, issuerType, issuerId: Number(issuerId) || 0 } : null;
  }

  return null;
}

/**
 * @param {{ issuerType: string, issuerId: number, level: number }} key
 * @param {Record<string, any>} patch
 * @returns {Promise<boolean>}
 */
async function upsertIssuerProfile({ issuerType, issuerId, level }, patch) {
  const allowed = [
    'name', 'tax_id', 'vat_eu_id', 'registry_numbers', 'street', 'zip', 'city', 'country',
    'email', 'phone', 'bank_name', 'bank_iban', 'bank_swift', 'currency', 'local_currency',
    'payment_days', 'default_lang', 'template_code', 'theme_vars', 'number_pattern',
    'legal_settings', 'footer_notes'
  ];
  const jsonCols = new Set(['registry_numbers', 'theme_vars', 'legal_settings', 'footer_notes']);
  const entries = Object.entries(patch || {}).filter(([k]) => allowed.includes(k));
  if (!entries.length) return false;

  const cols = entries.map(([k]) => `\`${k}\``).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  const updates = entries.map(([k]) => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');
  const values = entries.map(([k, v]) => (jsonCols.has(k) && v && typeof v === 'object' ? JSON.stringify(v) : v));

  const conn = await connetToDb();
  try {
    await conn.query(
      `INSERT INTO invoice_issuer_profile (issuer_type, issuer_id, level, ${cols})
       VALUES (?, ?, ?, ${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      [issuerType, Number(issuerId) || 0, Number(level), ...values]
    );
    return true;
  } catch (err) {
    log(`[invoices] upsertIssuerProfile error: ${err.message}`);
    return false;
  } finally {
    await conn.end();
  }
}

/* ---------------------- Odbiorcy końcowi (CRUD) ---------------------- */

/** Kolumny, które wolno zapisać z zewnątrz — biała lista chroni przed nadpisaniem właściciela. */
const END_CLIENT_FIELDS = Object.freeze([
  'client_type', 'name', 'tax_id', 'vat_eu_id', 'registry_numbers', 'street', 'zip', 'city',
  'country', 'delivery_name', 'delivery_street', 'delivery_zip', 'delivery_city',
  'delivery_country', 'print_delivery_address', 'email', 'phone', 'default_currency', 'notes', 'is_active'
]);

/**
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function mapEndClient(row) {
  if (!row) return null;
  return { ...row, registry_numbers: parseJsonColumn(row.registry_numbers) || {} };
}

/**
 * @param {{ ownerUserId: number, organizationId: number, data: Record<string, any> }} params
 * @returns {Promise<number>} id nowego odbiorcy
 */
async function createEndClient({ ownerUserId, organizationId, data }) {
  const entries = Object.entries(data || {}).filter(([k]) => END_CLIENT_FIELDS.includes(k));
  const cols = entries.map(([k]) => `\`${k}\``);
  const values = entries.map(([k, v]) => (k === 'registry_numbers' && v && typeof v === 'object' ? JSON.stringify(v) : v));

  const conn = await connetToDb();
  try {
    const [result] = await conn.query(
      `INSERT INTO invoice_end_client (owner_user_id, organization_id${cols.length ? ', ' + cols.join(', ') : ''})
       VALUES (?, ?${cols.length ? ', ' + entries.map(() => '?').join(', ') : ''})`,
      [ownerUserId, organizationId, ...values]
    );
    return Number(result.insertId);
  } finally {
    await conn.end();
  }
}

/**
 * ⚠️ Aktualizacja ZAWSZE z warunkiem `owner_user_id` — baza odbiorców jest
 * prywatna dla salonu, więc identyfikator z requestu nie może wystarczyć.
 *
 * @param {{ id: number, ownerUserId: number, data: Record<string, any> }} params
 * @returns {Promise<boolean>}
 */
async function updateEndClient({ id, ownerUserId, data }) {
  const entries = Object.entries(data || {}).filter(([k]) => END_CLIENT_FIELDS.includes(k));
  if (!entries.length) return false;
  const sets = entries.map(([k]) => `\`${k}\` = ?`).join(', ');
  const values = entries.map(([k, v]) => (k === 'registry_numbers' && v && typeof v === 'object' ? JSON.stringify(v) : v));

  const conn = await connetToDb();
  try {
    const [result] = await conn.query(
      `UPDATE invoice_end_client SET ${sets} WHERE id = ? AND owner_user_id = ?`,
      [...values, id, ownerUserId]
    );
    return result.affectedRows > 0;
  } finally {
    await conn.end();
  }
}

/**
 * Dezaktywacja zamiast usunięcia — odbiorca może być nabywcą wystawionych
 * faktur, a te muszą zostać niezmienne.
 *
 * @param {{ id: number, ownerUserId: number }} params
 * @returns {Promise<boolean>}
 */
async function deactivateEndClient({ id, ownerUserId }) {
  const conn = await connetToDb();
  try {
    const [result] = await conn.query(
      'UPDATE invoice_end_client SET is_active = 0 WHERE id = ? AND owner_user_id = ?',
      [id, ownerUserId]
    );
    return result.affectedRows > 0;
  } finally {
    await conn.end();
  }
}

/**
 * Odbiorca końcowy w zadanym zakresie widoczności.
 *
 * ⚠️ Zakres MUSI być podany — bez niego zapytanie po samym `id` pozwoliłoby
 * czytać kartotekę cudzego salonu. Salon widzi swoich (`ownerUserId`), owner
 * całą organizację (`organizationId`) — bo na poziomie 4 to organizacja jest
 * sprzedawcą i fakturuje odbiorcę bez pośrednictwa salonu.
 *
 * @param {{ id: number, ownerUserId?: number, organizationId?: number }} params
 * @returns {Promise<Record<string, any>|null>}
 */
async function getEndClient({ id, ownerUserId, organizationId }) {
  const where = ['id = ?'];
  const values = [id];
  if (ownerUserId) { where.push('owner_user_id = ?'); values.push(Number(ownerUserId)); }
  else if (organizationId) { where.push('organization_id = ?'); values.push(Number(organizationId)); }
  else throw new Error('getEndClient wymaga zakresu: ownerUserId albo organizationId');

  const rows = await selectQuery(`SELECT * FROM invoice_end_client WHERE ${where.join(' AND ')}`, values);
  return mapEndClient(rows && rows[0]);
}

/**
 * Wyszukiwanie odbiorców właściciela — źródło dla comboboxa w formularzu
 * zamówienia i w panelu. Limit jak w pozostałych wyszukiwaniach (skala!).
 *
 * @param {{ ownerUserId: number, query?: string, limit?: number, includeInactive?: boolean }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function searchEndClients({ ownerUserId, organizationId, query = '', limit = 20, includeInactive = false }) {
  const q = String(query || '').trim();
  const prefix = `${q}%`;
  const infix = `%${q}%`;
  // Zakres: salon widzi swoich odbiorców, owner — wszystkich w organizacji
  // (poziom 4: organizacja sprzedaje odbiorcy końcowemu bezpośrednio).
  const byOwner = !!ownerUserId;
  if (!byOwner && !organizationId) throw new Error('searchEndClients wymaga zakresu: ownerUserId albo organizationId');
  const rows = await selectQuery(
    `SELECT id, owner_user_id, client_type, name, tax_id, vat_eu_id, country, city, street, zip, email, phone, is_active
       FROM invoice_end_client
      WHERE (? = 1 AND owner_user_id = ? OR ? = 0 AND organization_id = ?)
        AND (? = 1 OR is_active = 1)
        AND (? = '' OR name LIKE ? OR tax_id LIKE ? OR city LIKE ? OR email LIKE ?)
      ORDER BY (name LIKE ?) DESC, name
      LIMIT ?`,
    [
      byOwner ? 1 : 0, Number(ownerUserId) || 0, byOwner ? 1 : 0, Number(organizationId) || 0,
      includeInactive ? 1 : 0, q, infix, prefix, prefix, prefix, prefix, Number(limit)
    ]
  );
  return (rows || []).map(mapEndClient);
}

/* ------------------- Częściowe fakturowanie (alokacje) ------------------ */

/**
 * Ile z każdej pozycji zamówienia już zafakturowano.
 *
 * ⚠️ Czytane w TEJ SAMEJ transakcji co zapis alokacji (parametr `conn`) —
 * inaczej dwa równoległe wystawienia odczytałyby ten sam stan i przefakturowały
 * pozycję. Wiersze blokujemy `FOR UPDATE` na pozycjach zamówienia.
 *
 * @param {number} orderId
 * @param {import('mysql2/promise').PoolConnection} [conn]
 * @returns {Promise<Map<number, number>>} `order_item_id` → suma ilości
 */
async function getAllocatedQuantities(orderId, conn, relation = null) {
  // ⚠️ ZAJĘTOŚĆ ILOŚCI JEST WŁASNOŚCIĄ RELACJI, nie zamówienia. Producent
  // sprzedaje organizacji, organizacja użytkownikowi, użytkownik odbiorcy —
  // to trzy niezależne sprzedaże tego samego towaru. Wspólny licznik oznaczał,
  // że faktura organizacji „zjadała" ilości salonowi i przy częściowym
  // fakturowaniu blokowała mu wystawienie własnego dokumentu.
  const scoped = !!(relation && relation.issuerType && relation.level);
  const sql = `
    SELECT a.order_item_id, COALESCE(SUM(a.invoiced_quantity), 0) AS invoiced
      FROM invoice_item_allocation a
      JOIN invoice i ON i.id = a.invoice_id
     WHERE a.order_id = ? AND i.status <> 'cancelled'
       AND (? = 0 OR (i.issuer_type = ? AND i.issuer_id = ? AND i.level = ?))
     GROUP BY a.order_item_id`;
  const values = [
    orderId,
    scoped ? 1 : 0,
    scoped ? relation.issuerType : '',
    scoped ? Number(relation.issuerId) || 0 : 0,
    scoped ? Number(relation.level) : 0
  ];

  const rows = conn ? (await conn.query(sql, values))[0] : (await selectQuery(sql, values) || []);
  const map = new Map();
  for (const row of rows || []) map.set(Number(row.order_item_id), Number(row.invoiced));
  return map;
}

/**
 * Blokuje pozycje zamówienia na czas transakcji, żeby równoległe wystawienie
 * nie mogło policzyć zajętości na nieaktualnym stanie.
 *
 * @param {number} orderId
 * @param {import('mysql2/promise').PoolConnection} conn
 * @returns {Promise<void>}
 */
async function lockOrderItems(orderId, conn) {
  await conn.query('SELECT id FROM order_item WHERE order_id = ? FOR UPDATE', [orderId]);
}

/**
 * Historia fakturowania pozycji zamówienia — dla UI („2 z 3 zafakturowane").
 *
 * @param {number} orderId
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function getOrderInvoicingStatus(orderId, relation = null) {
  // Zakres jak w `getAllocatedQuantities`: „ile jeszcze zostało" ma sens
  // wyłącznie w obrębie jednej relacji handlowej.
  const scoped = !!(relation && relation.issuerType && relation.level);
  const rows = await selectQuery(
    `SELECT oi.id AS order_item_id, oi.name, oi.commision, oi.amount, oi.json_parameters,
            COALESCE(SUM(CASE WHEN i.status <> 'cancelled' THEN a.invoiced_quantity END), 0) AS invoiced,
            GROUP_CONCAT(DISTINCT CASE WHEN i.status <> 'cancelled' THEN i.number END) AS invoice_numbers
       FROM order_item oi
       LEFT JOIN invoice_item_allocation a ON a.order_item_id = oi.id
       LEFT JOIN invoice i ON i.id = a.invoice_id
                          AND (? = 0 OR (i.issuer_type = ? AND i.issuer_id = ? AND i.level = ?))
      WHERE oi.order_id = ?
      GROUP BY oi.id
      ORDER BY oi.orderpos, oi.id`,
    [
      scoped ? 1 : 0,
      scoped ? relation.issuerType : '',
      scoped ? Number(relation.issuerId) || 0 : 0,
      scoped ? Number(relation.level) : 0,
      orderId
    ]
  );
  return rows || [];
}

/**
 * Dane zamówienia potrzebne do zbudowania faktury: nagłówek, pozycje,
 * organizacja, klient i (opcjonalnie) sklep grupowy.
 *
 * @param {number} orderId
 * @returns {Promise<{ order: any, orderItems: any[], organization: any, user: any, groupShop: any }|null>}
 */
async function getOrderInvoiceSource(orderId) {
  const orders = await selectQuery(
    `SELECT o.*, u.id AS u_id, u.client_name, u.tax_id AS u_tax_id, u.street AS u_street,
            u.city AS u_city, u.zip AS u_zip, u.country AS u_country, u.email AS u_email,
            u.phone AS u_phone, u.ident AS u_ident
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
      WHERE o.id = ?`,
    [orderId]
  );
  const order = orders && orders[0];
  if (!order) return null;

  const orderItems = (await selectQuery('SELECT * FROM order_item WHERE order_id = ? ORDER BY orderpos, id', [orderId])) || [];
  const orgs = await selectQuery('SELECT * FROM organization WHERE id = ?', [order.organization_id]);
  const shops = order.group_user_id
    ? await selectQuery('SELECT * FROM group_user WHERE id = ?', [order.group_user_id])
    : null;

  return {
    order,
    orderItems,
    organization: (orgs && orgs[0]) || null,
    user: {
      id: order.u_id,
      client_name: order.client_name,
      tax_id: order.u_tax_id,
      street: order.u_street,
      city: order.u_city,
      zip: order.u_zip,
      country: order.u_country,
      email: order.u_email,
      phone: order.u_phone,
      ident: order.u_ident
    },
    groupShop: (shops && shops[0]) || null
  };
}



/**
 * Minimalny odczyt do kontroli dostępu: kto jest właścicielem zamówienia.
 * Osobno od `getOrderInvoiceSource`, żeby guard nie ciągnął pozycji i adresów.
 *
 * @param {number} orderId
 * @returns {Promise<{ id: number, user_id: number, organization_id: number, order_idx: string }|null>}
 */
async function getOrderOwnership(orderId) {
  const rows = await selectQuery(
    'SELECT id, user_id, organization_id, order_idx FROM `order` WHERE id = ?',
    [orderId]
  );
  return (rows && rows[0]) || null;
}

/**
 * Przypisuje odbiorcę końcowego do zamówienia (`order.end_client_id`).
 *
 * Kontrola dostępu jest tutaj, nie w kontrolerze, bo wymaga danych z bazy:
 *  - zamówienie musi należeć do użytkownika z sesji albo do jego organizacji,
 *  - odbiorca musi należeć do WŁAŚCICIELA zamówienia (`owner_user_id`), inaczej
 *    dałoby się podpiąć klienta innego salonu i wystawić mu fakturę.
 *
 * @param {{ orderId: number, endClientId: number|null, sessionUserId: number|null, organizationId: number|null }} params
 * @returns {Promise<{ ok: boolean, status?: number, message?: string }>}
 */
async function assignEndClientToOrder({ orderId, endClientId, sessionUserId, organizationId, isAdmin = false }) {
  const rows = await selectQuery('SELECT id, user_id, organization_id FROM `order` WHERE id = ?', [orderId]);
  const order = rows && rows[0];
  if (!order) return { ok: false, status: 404, message: 'Nie znaleziono zamówienia' };

  const ownsOrder = sessionUserId && Number(order.user_id) === Number(sessionUserId);
  const sameOrganization = organizationId && Number(order.organization_id) === Number(organizationId);
  // Admin pracuje w przełączanym kontekście organizacji, więc porównanie
  // organizacji blokowałoby mu cudze zamówienia bez powodu (ta sama reguła
  // co `http/session.js:canAccessOrder`). Powiązanie odbiorcy z WŁAŚCICIELEM
  // zamówienia jest sprawdzane niżej i obowiązuje także admina.
  if (!isAdmin && !ownsOrder && !sameOrganization) {
    return { ok: false, status: 403, message: 'Brak dostępu do zamówienia' };
  }

  if (endClientId !== null) {
    const client = await getEndClient({ id: endClientId, ownerUserId: order.user_id });
    if (!client) {
      return { ok: false, status: 400, message: 'Odbiorca nie należy do właściciela tego zamówienia' };
    }
  }

  const conn = await connetToDb();
  try {
    const [result] = await conn.query('UPDATE `order` SET end_client_id = ? WHERE id = ?', [endClientId, orderId]);
    return { ok: result.affectedRows > 0 };
  } finally {
    await conn.end();
  }
}

/**
 * Szablon dokumentu po kodzie (z fallbackiem na `default`).
 *
 * `backgroundFile`/`pageMargins` — formatka organizacji (`core/templates.js`).
 * ⚠️ `SELECT *` celowo: przed migracją `db/schema_v3.sql` kolumn formatki nie ma,
 * a dokument ma się wtedy renderować dalej, po prostu bez formatki.
 *
 * @param {string} code
 * @returns {Promise<{ code: string, templateFile: string, stylesheet: string, themeVars: object, backgroundFile: string|null, pageMargins: object|null }>}
 */
async function getTemplate(code) {
  const rows = await selectQuery('SELECT * FROM invoice_template WHERE code = ? AND is_active = 1', [code || 'default']);
  const row = rows && rows[0];
  if (!row) {
    return { code: 'default', templateFile: 'invoice-main.njk', stylesheet: 'styles/invoice.css', themeVars: {}, backgroundFile: null, pageMargins: null };
  }
  return {
    code: row.code,
    templateFile: row.template_file,
    stylesheet: row.stylesheet,
    themeVars: parseJsonColumn(row.theme_vars) || {},
    backgroundFile: row.background_file || null,
    pageMargins: parseJsonColumn(row.page_margins)
  };
}

/**
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function listTemplates() {
  // `SELECT *`: kolumny formatki (`background_file`, `page_margins`) są dopiero
  // po migracji `db/schema_v3.sql` — lista ma działać także przed nią.
  return (await selectQuery('SELECT * FROM invoice_template ORDER BY code', [])) || [];
}

/**
 * Rejestruje albo aktualizuje szablon (`scripts/setInvoiceTemplate.js`).
 * Ścieżki są względem `services/invoices/templates/` — wołający sprawdza, że
 * pliki istnieją, zanim wskaże je w bazie. Przy błędzie RZUCA.
 *
 * @param {{ code: string, name: string, templateFile: string, stylesheet: string, backgroundFile?: string|null, pageMargins?: object|null }} template
 * @returns {Promise<void>}
 */
async function upsertTemplate({ code, name, templateFile, stylesheet, backgroundFile = null, pageMargins = null }) {
  await strictQuery(
    `INSERT INTO invoice_template (code, name, template_file, stylesheet, background_file, page_margins, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE name = VALUES(name), template_file = VALUES(template_file),
                             stylesheet = VALUES(stylesheet), background_file = VALUES(background_file),
                             page_margins = VALUES(page_margins), is_active = 1`,
    [code, name, templateFile, stylesheet, backgroundFile, pageMargins ? JSON.stringify(pageMargins) : null]
  );
}

/**
 * Który plik szablonu ma każda organizacja — do kontroli przypisań.
 * Brak wiersza profilu albo kodu bez wiersza w `invoice_template` = domyślny,
 * tak jak przy renderowaniu (`getTemplate`).
 *
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function listOrganizationTemplates() {
  return strictQuery(
    `SELECT o.id AS organization_id, o.ident, o.name AS organization_name,
            COALESCE(p.template_code, 'default') AS template_code, t.*
       FROM organization o
       LEFT JOIN invoice_organization_profile p ON p.organization_id = o.id
       LEFT JOIN invoice_template t ON t.code = COALESCE(p.template_code, 'default')
      ORDER BY o.id`,
    []
  );
}

/**
 * Uruchamia `db/schema.sql`. Wygodne przy pierwszym wdrożeniu i w testach
 * integracyjnych; produkcyjnie równoważne `mysql eform < schema.sql`.
 * @returns {Promise<{ executed: number }>}
 */
async function runSchemaMigration() {
  // v1 + v2 (hierarchia, odbiorcy końcowi, alokacje) + v3 (formatki) —
  // kolejność ma znaczenie: kolejne wersje dokładają kolumny do tabel z v1.
  const raw = ['schema.sql', 'schema_v2.sql', 'schema_v3.sql']
    .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
    .join('\n');
  // Rozbicie na instrukcje: komentarze `--` precz, potem podział po `;`
  const statements = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const conn = await connetToDb();
  try {
    for (const stmt of statements) {
      await conn.query(stmt);
    }
    return { executed: statements.length };
  } finally {
    await conn.end();
  }
}

module.exports = {
  withTransaction,
  allocateIssuerSequence,
  getIssuerProfile,
  upsertIssuerProfile,
  createEndClient,
  updateEndClient,
  deactivateEndClient,
  getEndClient,
  searchEndClients,
  getAllocatedQuantities,
  lockOrderItems,
  getOrderInvoicingStatus,
  assignEndClientToOrder,
  getOrderOwnership,
  searchClients,
  searchOrganizations,
  countSearchMatches,
  searchInvoiceableOrders,
  countInvoiceableOrdersForClient,
  listInvoiceableOrdersForClient,
  findAutoInvoiceCandidates,
  hasLevelInvoice,
  allocateSequence,
  getOrganizationProfile,
  upsertOrganizationProfile,
  createInvoice,
  getInvoice,
  updateStatus,
  listInvoices,
  getAdvanceInvoicesForOrder,
  getOrderInvoiceSource,
  getTemplate,
  listTemplates,
  upsertTemplate,
  listOrganizationTemplates,
  runSchemaMigration
};
