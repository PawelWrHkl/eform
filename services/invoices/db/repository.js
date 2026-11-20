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
const { normalizeEndClientData } = require('../core/endClient');
const { DAILY_ACTOR } = require('../core/collective');

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
 * Pozycje faktury (zapis nowej faktury i edycji wystawionej).
 * @returns {Promise<Map<number, number>>} `order_item_id` → `invoice_item.id`
 */
async function insertInvoiceItems(conn, invoiceId, invoice, cur) {
  const idByOrderItem = new Map();
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
    if (item.orderItemId) idByOrderItem.set(Number(item.orderItemId), Number(itemResult.insertId));
  }
  return idByOrderItem;
}

/** Podsumowanie VAT faktury (zapis nowej faktury i edycji wystawionej). */
async function insertTaxLines(conn, invoiceId, taxLines, cur) {
  for (const line of taxLines || []) {
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
}

/**
 * Zapis kompletnego dokumentu (nagłówek + pozycje + podsumowanie VAT) w jednej
 * transakcji. Numer jest nadawany TUTAJ, w tej samej transakcji co insert —
 * inaczej awaria między rezerwacją numeru a zapisem zostawiłaby dziurę w numeracji.
 *
 * `opts.replaceId` („Przelicz dzienne ponownie”): stara wersja faktury znika w TEJ SAMEJ
 * transakcji (pozycje, VAT, zdarzenia — kaskadą), a nowa przejmuje jej numer z `invoice.number`.
 *
 * @param {Invoice & { orgCode?: string, numberPattern?: string, createdByPin?: string }} invoice
 * @param {{ assignNumber?: boolean, replaceId?: number|null }} [opts]
 * @returns {Promise<{ id: number, number: string|null }>}
 */
async function createInvoice(invoice, opts = {}) {
  const { NumberingService } = require('../core/numbering');

  return withTransaction(async (conn) => {
    // Historia (utworzenie, przygotowanie, edycje) przechodzi na nową wersję; znaczniki
    // maila i FTP nie — nowa wersja idzie kanałami od nowa (przeliczona dzienna, wystawiony szkic).
    // Wysłany plik zostaje jako `ftp_replaced`: nowa wersja nadpisze go na FTP pod tą samą nazwą
    let carriedEvents = [];
    if (opts.replaceId) {
      [carriedEvents] = await conn.query(
        `SELECT IF(event_type LIKE 'ftp\\_uploaded%', 'ftp_replaced', event_type) AS event_type,
                from_status, to_status, actor_pin, payload, created_at FROM invoice_event
          WHERE invoice_id = ? AND event_type NOT LIKE 'mail\\_%' AND event_type NOT LIKE 'ftp\\_failed%' ORDER BY id`,
        [Number(opts.replaceId)]
      );
      const [del] = await conn.query('DELETE FROM invoice WHERE id = ?', [Number(opts.replaceId)]);
      if (!del.affectedRows) {
        // Ktoś podmienił albo usunął tę wersję w międzyczasie (dwa zapisy naraz)
        const err = new Error('Ktoś zapisał tę fakturę w międzyczasie — odśwież i spróbuj jeszcze raz.');
        err.code = 'INVOICE_EDIT_CONFLICT';
        throw err;
      }
    }
    let number = invoice.number || null;

    if (!number && opts.assignNumber) {
      // v2: seria wystawcy na rok (`issuerSeriesKey`; HKL — jedna wspólna, `{YY}{NR:6}`).
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

    for (const e of carriedEvents) {
      await conn.query(
        'INSERT INTO invoice_event (invoice_id, event_type, from_status, to_status, actor_pin, payload, created_at) VALUES (?,?,?,?,?,?,?)',
        [invoiceId, e.event_type, e.from_status, e.to_status, e.actor_pin, e.payload == null ? null : (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)), e.created_at]
      );
    }

    /** `order_item_id` → `invoice_item.id`, potrzebne do zapisu alokacji. */
    const invoiceItemIdByOrderItem = await insertInvoiceItems(conn, invoiceId, invoice, cur);

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

    await insertTaxLines(conn, invoiceId, invoice.taxLines, cur);

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
            i.total_net, i.total_tax, i.total_gross, i.amount_due, i.paid_amount, i.buyer_name, i.order_id,
            i.level, i.issuer_type, i.issuer_id,
            -- 'AUTO' = dokument wystawiony przez automat (autoInvoicing.js)
            i.created_by_pin,
            JSON_EXTRACT(i.compliance, '$.manualEdit') IS NOT NULL AS manual_edit,
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
        -- Fakturujemy WYŁĄCZNIE zlecenia wysłane do klienta (!sent! ze status.txt)
        AND o.prod_status = '!sent!'
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
function invoiceableForClientWhere({ organizationId, clientId, level }) {
  return {
    sql: `
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
      WHERE o.organization_id = ? AND o.user_id = ? AND o.status = 'sent'
        AND o.prod_status = '!sent!'
        AND NOT EXISTS (
              SELECT 1 FROM invoice i
               WHERE i.order_id = o.id AND i.level = ?
                 AND i.document_type IN ('invoice', 'final')
                 AND i.status <> 'cancelled')
        AND NOT ${linkedDocumentSql("AND il.document_type IN ('invoice', 'final') AND il.status <> 'cancelled'")}`,
    values: [organizationId, clientId, Number(level), [Number(level)]]
  };
}

/**
 * Ile zamówień klienta czeka na fakturę — licznik na karcie klienta.
 *
 * @param {{ organizationId: number, clientId: number, level: number }} params
 * @returns {Promise<number>}
 */
async function countInvoiceableOrdersForClient({ organizationId, clientId, level }) {
  const where = invoiceableForClientWhere({ organizationId, clientId, level });
  const rows = await selectQuery(`SELECT COUNT(*) AS c ${where.sql}`, where.values);
  return rows && rows[0] ? Number(rows[0].c) : 0;
}

/**
 * Pełna lista zamówień klienta do zafakturowania — „okno zamówień" w widoku
 * klienta na poziomie 2, w miejsce comboboxa z podpowiedziami.
 *
 * Wyłącznie zlecenia z `prod_status = '!sent!'` (towar wyjechał do klienta) —
 * tylko takie można fakturować (`main.js:isShippedOrder`).
 *
 * `unshipped_positions` — ile pozycji ma w pliku produkcji status inny niż
 * `!sent!`. `order.prod_status` to status pozycji z NAJPÓŹNIEJSZĄ datą, więc
 * zamówienie potrafi być „wysłane", choć któraś pozycja jeszcze nie wyjechała.
 *
 * @param {{ organizationId: number, clientId: number, level: number, limit?: number }} params
 * @returns {Promise<{ items: Array<Record<string, any>>, total: number }>}
 */
async function listInvoiceableOrdersForClient({ organizationId, clientId, level, limit = 500 }) {
  const where = invoiceableForClientWhere({ organizationId, clientId, level });
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
       ORDER BY o.delivery_date DESC, o.id DESC
       LIMIT ?`,
      [Number(level), ...where.values, Number(limit)]
    ),
    countInvoiceableOrdersForClient({ organizationId, clientId, level })
  ]);
  return { items: rows || [], total };
}

/**
 * PRZEGLĄD dla panelu (`/invoices`, poziomy 1 i 2): każdy nabywca z
 * zamówieniami wysłanymi do klienta (`status = 'sent'` i `prod_status = '!sent!'`)
 * — ile z nich ma fakturę, ile nie, kiedy była ostatnia wysyłka i ostatnia faktura.
 *
 * „Z fakturą" = nieanulowany dokument `invoice`/`final` tego poziomu na
 * zamówieniu albo faktura zbiorcza obejmująca jego pozycje — dokładne
 * dopełnienie `invoiceableForClientWhere`, więc „bez faktury" w przeglądzie
 * równa się liczbie zamówień w oknie zamówień klienta (przy tym samym okresie).
 *
 * Nabywca per poziom (tak jak automat, `AUTO_LEVEL_SQL`):
 *   1 — organizacja zamówienia ≠ HKL; faktury poziomu 1 mają `organization_id`
 *       organizacji-nabywcy (jak w `listInvoices` dla poziomu 1),
 *   2 — klient organizacji z sesji, bez własnego konta organizacji (organizacja
 *       nie fakturuje sama siebie).
 *
 * @param {{ level: number, organizationId: number, since?: string|null, hklOrganizationId: number }} params
 * @returns {Promise<Array<{ clientId: number, name: string, ident: string, shipped: number, invoiced: number, pending: number, lastShipped: Date|null, documents: number, lastInvoice: Date|null }>>}
 */
async function listInvoiceOverview({ level, organizationId, since = null, hklOrganizationId }) {
  const lvl = Number(level);
  if (lvl !== 1 && lvl !== 2) return [];

  const invoicedSql = `(EXISTS (SELECT 1 FROM invoice i
                                 WHERE i.order_id = o.id AND i.level = ?
                                   AND i.document_type IN ('invoice', 'final')
                                   AND i.status <> 'cancelled')
                        OR ${linkedDocumentSql("AND il.document_type IN ('invoice', 'final') AND il.status <> 'cancelled'")})`;
  const sinceSql = since ? 'AND o.delivery_date >= ?' : '';

  let ordersSql;
  let ordersValues;
  let documentsSql;
  let documentsValues;
  if (lvl === 1) {
    ordersSql = `
      SELECT org.id AS client_id, org.name AS name, org.ident AS ident,
             COUNT(*) AS shipped,
             SUM(CASE WHEN ${invoicedSql} THEN 1 ELSE 0 END) AS invoiced,
             MAX(o.delivery_date) AS last_shipped
        FROM \`order\` o
        JOIN organization org ON org.id = o.organization_id
       WHERE o.status = 'sent' AND o.prod_status = '!sent!'
         AND o.organization_id <> ?
         ${sinceSql}
       GROUP BY org.id, org.name, org.ident`;
    ordersValues = [lvl, [lvl], Number(hklOrganizationId)];
    documentsSql = `
      SELECT organization_id AS client_id, COUNT(*) AS documents, MAX(issue_date) AS last_invoice
        FROM invoice
       WHERE level = 1 AND document_type IN ('invoice', 'final') AND status <> 'cancelled'
       GROUP BY organization_id`;
    documentsValues = [];
  } else {
    ordersSql = `
      SELECT u.id AS client_id, u.client_name AS name, u.ident AS ident,
             COUNT(*) AS shipped,
             SUM(CASE WHEN ${invoicedSql} THEN 1 ELSE 0 END) AS invoiced,
             MAX(o.delivery_date) AS last_shipped
        FROM \`order\` o
        JOIN \`user\` u ON u.id = o.user_id
        JOIN organization org ON org.id = o.organization_id
       WHERE o.organization_id = ? AND o.status = 'sent' AND o.prod_status = '!sent!'
         AND UPPER(u.ident) <> UPPER(org.ident)
         ${sinceSql}
       GROUP BY u.id, u.client_name, u.ident`;
    ordersValues = [lvl, [lvl], Number(organizationId)];
    documentsSql = `
      SELECT buyer_user_id AS client_id, COUNT(*) AS documents, MAX(issue_date) AS last_invoice
        FROM invoice
       WHERE organization_id = ? AND level = 2 AND buyer_user_id IS NOT NULL
         AND document_type IN ('invoice', 'final') AND status <> 'cancelled'
       GROUP BY buyer_user_id`;
    documentsValues = [Number(organizationId)];
  }
  if (since) ordersValues.push(since);

  const [orderRows, documentRows] = await Promise.all([
    strictQuery(ordersSql, ordersValues),
    strictQuery(documentsSql, documentsValues)
  ]);
  const documentsByClient = new Map(documentRows.map((r) => [Number(r.client_id), r]));

  return orderRows.map((r) => {
    const shipped = Number(r.shipped) || 0;
    const invoiced = Number(r.invoiced) || 0;
    const docs = documentsByClient.get(Number(r.client_id));
    return {
      clientId: Number(r.client_id),
      name: r.name || '',
      ident: r.ident || '',
      shipped,
      invoiced,
      pending: shipped - invoiced,
      lastShipped: r.last_shipped || null,
      documents: docs ? Number(docs.documents) || 0 : 0,
      lastInvoice: docs ? docs.last_invoice || null : null
    };
  });
}

/**
 * Dokument obejmujący zamówienie `o` przez swoje POZYCJE, a nie przez
 * `invoice.order_id` — tak rozpoznajemy FAKTURĘ ZBIORCZĄ (dotyczy wielu
 * zamówień, więc `order_id` ma pusty). Bez tego zamówienie z faktury zbiorczej
 * wyglądałoby na niezafakturowane i automat wystawiłby mu drugą fakturę.
 * Jeden placeholder `IN (?)` — lista poziomów. Faktura dzienna HKL też się liczy:
 * od 18.11.2026 to JEDYNA faktura relacji HKL (Paweł: „per dzień, wyłączyć per zlecenie”).
 *
 * @param {string} [extra] dodatkowe warunki na `il` (typ dokumentu, status)
 * @returns {string}
 */
function linkedDocumentSql(extra = '') {
  return `EXISTS (SELECT 1 FROM order_item oi
                   JOIN invoice_item ii ON ii.order_item_id = oi.id
                   JOIN invoice il ON il.id = ii.invoice_id
                  WHERE oi.order_id = o.id AND il.order_id IS NULL AND il.level IN (?) ${extra})`;
}

/** @type {Promise<boolean>|null} */
let invoiceScheduleSupport = null;

/**
 * Czy jest kolumna `user.invoice_schedule` (`migrations/add_user_invoice_schedule.sql`).
 * Kod bywa wdrażany przed migracją — wtedy fakturowanie niestandardowe po prostu
 * nie działa, zamiast wywracać zapytania automatu. Raz na proces (cykl automatu
 * to osobny proces, więc migracja zadziała od następnego cyklu).
 *
 * @returns {Promise<boolean>}
 */
function supportsInvoiceSchedule() {
  if (!invoiceScheduleSupport) {
    invoiceScheduleSupport = strictQuery(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'invoice_schedule'`,
      []
    ).then((rows) => Number(rows[0] && rows[0].c) > 0).catch(() => false);
  }
  return invoiceScheduleSupport;
}

/**
 * Harmonogram fakturowania klienta (`user.invoice_schedule`): `weekly`,
 * `monthly` albo `null` (standard — faktura za każde zlecenie).
 *
 * @param {number} userId
 * @returns {Promise<'weekly'|'monthly'|null>}
 */
async function getUserInvoiceSchedule(userId) {
  if (!userId || !(await supportsInvoiceSchedule())) return null;
  const { normalizeSchedule } = require('../core/collective');
  const rows = await selectQuery('SELECT invoice_schedule FROM `user` WHERE id = ?', [userId]);
  return normalizeSchedule(rows && rows[0] && rows[0].invoice_schedule);
}

/**
 * @param {number} userId
 * @param {'weekly'|'monthly'|null} schedule  `null` = standard
 * @returns {Promise<boolean>}
 */
async function setUserInvoiceSchedule(userId, schedule) {
  const { normalizeSchedule } = require('../core/collective');
  const result = await strictQuery('UPDATE `user` SET invoice_schedule = ? WHERE id = ?', [normalizeSchedule(schedule), userId]);
  return result.affectedRows > 0;
}

/**
 * Poziomy, które dla jednego zlecenia się WYKLUCZAJĄ: odbiorca końcowy kupuje
 * od salonu (3) ALBO bezpośrednio od organizacji (4) — nigdy od obu naraz.
 * Dla poziomów 1 i 2 relacja to sam poziom.
 *
 * @param {number} level
 * @returns {number[]}
 */
function relationLevels(level) {
  const lvl = Number(level);
  return lvl === 3 || lvl === 4 ? [3, 4] : [lvl];
}

/**
 * Warunek „kto stoi po drugiej stronie" per poziom. Konto WŁASNE organizacji
 * rozpoznajemy tak samo jak logowanie ownera (`middleware/loginMixture.js:isOwner`):
 * ident użytkownika = ident organizacji.
 *   1 — HKL → organizacja (HKL wykluczane przez `excludeOrganizationId`),
 *   2 — organizacja → jej klient; NIE dla własnego konta organizacji
 *       (organizacja nie wystawia faktury sama sobie),
 *   3 — salon → odbiorca końcowy przypisany do zlecenia przez salon,
 *   4 — organizacja → odbiorca końcowy przypisany do zlecenia własnego konta organizacji.
 */
const AUTO_LEVEL_SQL = Object.freeze({
  1: '',
  2: 'AND UPPER(u.ident) <> UPPER(org.ident)',
  3: `AND o.end_client_id IS NOT NULL AND UPPER(u.ident) <> UPPER(org.ident)
        AND EXISTS (SELECT 1 FROM invoice_end_client ec
                     WHERE ec.id = o.end_client_id AND ec.owner_user_id = o.user_id)`,
  4: `AND o.end_client_id IS NOT NULL AND UPPER(u.ident) = UPPER(org.ident)
        AND EXISTS (SELECT 1 FROM invoice_end_client ec
                     WHERE ec.id = o.end_client_id AND ec.organization_id = o.organization_id)`
});

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
 *  - strona transakcji pasuje do poziomu (`AUTO_LEVEL_SQL`),
 *  - brak JAKIEGOKOLWIEK dokumentu `invoice`/`final`/`advance` w tej relacji
 *    (`relationLevels`), także anulowanego albo szkicu: anulowana faktura oznacza,
 *    że ktoś zajął się zamówieniem ręcznie — automat wystawiałby ją od nowa co
 *    godzinę; zaliczka wymaga faktury końcowej, którą wystawia człowiek.
 *
 * @param {{ level: number, since: string, organizationIds?: number[], excludeOrganizationId?: number|null, limit?: number }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findAutoInvoiceCandidates({ level, since, organizationIds = [], excludeOrganizationId = null, excludeOrderIds = [], limit = 100 }) {
  const levelSql = AUTO_LEVEL_SQL[Number(level)];
  if (levelSql === undefined) throw new Error(`Automat nie obsługuje poziomu ${level}`);
  const values = [since];
  let filters = '';
  if (organizationIds.length) { filters += ' AND o.organization_id IN (?)'; values.push(organizationIds); }
  if (excludeOrganizationId) { filters += ' AND o.organization_id <> ?'; values.push(Number(excludeOrganizationId)); }
  // Zlecenia czekające na transport (`transport.js`) nie zajmują okna kolejnej rundy
  if (excludeOrderIds.length) { filters += ' AND o.id NOT IN (?)'; values.push(excludeOrderIds); }
  // Klient z fakturowaniem niestandardowym (tygodniowe/miesięczne) dostaje
  // fakturę ZBIORCZĄ za okres (`findCollectiveCandidates`), nie za każde zlecenie
  const scheduleSql = Number(level) === 2 && (await supportsInvoiceSchedule())
    ? "AND (u.invoice_schedule IS NULL OR u.invoice_schedule NOT IN ('weekly', 'monthly'))"
    : '';
  values.push(relationLevels(level), relationLevels(level), Number(limit));

  return strictQuery(
    `SELECT o.id, o.order_idx, o.commision, o.organization_id, o.user_id, o.delivery_date,
            o.end_client_id, u.ident AS user_ident
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
       JOIN organization org ON org.id = o.organization_id
      WHERE o.status = 'sent'
        AND o.prod_status = '!sent!'
        AND o.delivery_date >= ?${filters}
        ${levelSql}
        ${scheduleSql}
        AND NOT EXISTS (
              SELECT 1 FROM position_statuses ps
               WHERE ps.user_ident = u.ident AND CAST(ps.order_idx AS CHAR) = o.order_idx
                 AND ps.status <> '!sent!')
        AND NOT EXISTS (
              SELECT 1 FROM invoice i
               WHERE i.order_id = o.id AND i.level IN (?)
                 AND i.document_type IN ('invoice', 'final', 'advance'))
        AND NOT ${linkedDocumentSql("AND il.document_type IN ('invoice', 'final', 'advance')")}
      ORDER BY o.delivery_date, o.id
      LIMIT ?`,
    values
  );
}

/**
 * Czy zamówienie ma już dokument w tej relacji (ta sama reguła co w
 * `findAutoInvoiceCandidates`). Automat pyta jeszcze raz tuż przed zapisem —
 * między wyszukaniem a wystawieniem ktoś mógł wystawić fakturę ręcznie.
 *
 * @param {{ orderId: number, level: number }} params
 * @returns {Promise<boolean>}
 */
async function hasLevelInvoice({ orderId, level }) {
  const rows = await strictQuery(
    `SELECT 1 AS found FROM \`order\` o
      WHERE o.id = ?
        AND (EXISTS (SELECT 1 FROM invoice i
                      WHERE i.order_id = o.id AND i.level IN (?)
                        AND i.document_type IN ('invoice', 'final', 'advance'))
             OR ${linkedDocumentSql("AND il.document_type IN ('invoice', 'final', 'advance')")})`,
    [orderId, relationLevels(level), relationLevels(level)]
  );
  return rows.length > 0;
}

/**
 * Faktury czekające na mail (`invoiceMailer.js`): wystawione (z numerem, nie
 * anulowane) przez danego autora, utworzone od `since`, bez zdarzenia `doneEvent`
 * i z mniej niż `maxAttempts` nieudanymi próbami (`mail_failed`).
 *
 * „Wysłane" to wpis w `invoice_event`, nie kolumna — nie trzeba migracji, a
 * historia prób (do kogo, kiedy, jaki błąd) zostaje przy dokumencie.
 *
 * @param {{ since: string, doneEvent: string, failedEvent: string, maxAttempts?: number, createdByPin?: string|string[], limit?: number }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findInvoicesToMail({ since, doneEvent, failedEvent, maxAttempts = 3, createdByPin = 'AUTO', limit = 50, ksefGate = false }) {
  const { HKL_ORG_ID } = require('../../subPrices');
  // KSeF (INVOICE_KSEF_MAIL_GATE): faktura HKL — poziom 1 albo poziom 2 organizacji HKL, jak w `numery_ksef.tsv` —
  // dopiero z `ksef_accepted`; filtr w SQL, żeby czekające nie zajmowały limitu przebiegu
  const ksefSql = ksefGate
    ? `AND NOT ((i.level = 1 OR (i.level = 2 AND i.organization_id = ${Number(HKL_ORG_ID)}))
               AND NOT EXISTS (SELECT 1 FROM invoice_event k WHERE k.invoice_id = i.id AND k.event_type = 'ksef_accepted'))`
    : '';
  return strictQuery(
    `SELECT i.id, i.number, i.level, i.buyer_name, i.buyer_email, i.created_at,
            (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?) AS failures
       FROM invoice i
      WHERE i.created_by_pin IN (?)
        AND i.status IN ('issued', 'paid', 'overdue')
        AND i.number IS NOT NULL
        AND i.created_at >= ?
        AND NOT EXISTS (SELECT 1 FROM invoice_event e WHERE e.invoice_id = i.id AND e.event_type = ?)
        AND (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?) < ?
        ${ksefSql}
      ORDER BY i.id
      LIMIT ?`,
    [failedEvent, [].concat(createdByPin), since, doneEvent, failedEvent, maxAttempts, limit]
  );
}

/**
 * Konto klienta jako nabywca faktury in blanco (`InvoiceService.createBlank`).
 *
 * @param {number} userId
 * @returns {Promise<Record<string, any>|null>}
 */
async function getUserForInvoice(userId) {
  const rows = await strictQuery(
    'SELECT id, ident, client_name, tax_id, street, zip, city, country, email, phone, organization_id FROM `user` WHERE id = ?',
    [Number(userId)]
  );
  return rows[0] || null;
}

/**
 * Nabywcy do faktury in blanco (tylko admin): organizacje i konta klientów po nazwie
 * albo idencie, razem do 20 wyników.
 *
 * @param {string} query
 * @returns {Promise<Array<{ type: 'organization'|'user', id: number, ident: string, name: string, country: string, taxId: string, organization: string|null }>>}
 */
async function searchBlankBuyers(query) {
  const like = `%${String(query || '').trim()}%`;
  // Dwa zapytania zamiast UNION: `organization` i `user` mają różne kolacje (UNION → „Illegal mix of collations”)
  const orgs = await strictQuery(
    `SELECT 'organization' AS type, o.id, o.ident, o.name, o.country, o.tax_id AS taxId, NULL AS organization,
            o.street, o.zip, o.city
       FROM organization o WHERE o.name LIKE ? OR o.ident LIKE ? ORDER BY o.name LIMIT 10`,
    [like, like]
  );
  const users = await strictQuery(
    `SELECT 'user' AS type, u.id, u.ident, u.client_name AS name, u.country, u.tax_id AS taxId, org.ident AS organization,
            u.street, u.zip, u.city
       FROM \`user\` u LEFT JOIN organization org ON org.id = u.organization_id
      WHERE u.client_name LIKE ? OR u.ident LIKE ? ORDER BY u.client_name LIMIT 10`,
    [like, like]
  );
  return [...orgs, ...users];
}

/**
 * Ostatni nabywcy faktur in blanco (do 8, bez powtórzeń): odnośnik do organizacji/konta,
 * jeśli był, inaczej dane z faktury (wpisane ręcznie).
 *
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function recentBlankBuyers() {
  const rows = await strictQuery(
    `SELECT buyer_name AS name, buyer_street AS street, buyer_zip AS zip, buyer_city AS city, buyer_country AS country,
            buyer_tax_id AS taxId, buyer_vat_eu_id AS vatEuId, buyer_email AS email,
            JSON_UNQUOTE(JSON_EXTRACT(compliance, '$.blank.buyer.type')) AS refType,
            JSON_EXTRACT(compliance, '$.blank.buyer.id') AS refId
       FROM invoice WHERE price_basis = 'manual' AND status <> 'cancelled' ORDER BY id DESC LIMIT 40`
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${String(r.name || '').toUpperCase()}|${r.country}`;
    if (!r.name || seen.has(key)) continue;
    seen.add(key);
    out.push(r.refType && r.refType !== 'null' && Number(r.refId)
      ? { type: r.refType, id: Number(r.refId), name: r.name, country: r.country, taxId: r.vatEuId || r.taxId || '', street: r.street, zip: r.zip, city: r.city, recent: true }
      : { type: 'manual', name: r.name, country: r.country, taxId: r.taxId || '', vatEuId: r.vatEuId || '', street: r.street, zip: r.zip, city: r.city, email: r.email || '', recent: true });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Ostatnie faktury in blanco (szkice i wystawione) — lista w panelu: wznów, porzuć, „nowa na podstawie”.
 *
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function listBlankInvoices() {
  return strictQuery(
    `SELECT i.id, i.number, i.status, DATE_FORMAT(i.issue_date, '%Y-%m-%d') AS issueDate, i.buyer_name AS buyerName,
            i.total_net AS totalNet, i.total_gross AS totalGross, o.ident AS issuer, i.order_name AS orderName
       FROM invoice i LEFT JOIN organization o ON o.id = i.organization_id
      WHERE i.price_basis = 'manual' AND i.status <> 'cancelled'
      ORDER BY i.id DESC LIMIT 30`
  );
}

/**
 * Ostatni wydany numer w serii wystawcy (bez rezerwacji) — orientacyjny numer w podglądzie.
 *
 * @param {{ issuerType: string, issuerId: number, level: number, year: number }} params
 * @returns {Promise<number>}
 */
async function peekIssuerSequence({ issuerType, issuerId, level, year }) {
  const key = issuerSeriesKey({ issuerType, issuerId, level });
  const rows = await strictQuery(
    'SELECT last_number FROM invoice_issuer_sequence WHERE issuer_type = ? AND issuer_id = ? AND level = ? AND year = ?',
    [key.issuerType, Number(key.issuerId) || 0, Number(key.level), Number(year)]
  );
  return rows[0] ? Number(rows[0].last_number) : 0;
}

/**
 * Wystawcy faktur in blanco: organizacje z profilem fakturowania (formatka, dane, seria).
 *
 * @returns {Promise<Array<{ id: number, ident: string, name: string }>>}
 */
async function listBlankIssuers() {
  return strictQuery(
    `SELECT o.id, o.ident, o.name FROM organization o
       JOIN invoice_organization_profile p ON p.organization_id = o.id
      ORDER BY o.name`
  );
}

/**
 * Każda pozycja każdej wystawionej faktury (bez szkiców i anulowanych), wszystkie poziomy,
 * od pierwszej — plik `zafakturowane_pozycje.tsv` na FTP (`invoiceFtpExport.js`): z niego
 * automat Wiktorii stawia blokadę DSPR_NUM w PROD i porównuje faktury z PROD (16.11.2026).
 * Daty jako tekst, żeby strefa czasowa nie przesunęła dnia. Błąd bazy rzuca wyjątek —
 * pusta lista po awarii nadpisałaby plik odbiorcy. Pozycja bez zlecenia (transport,
 * in blanco) dostaje klienta faktury: właściciela jej zlecenia albo konto nabywcy, a linia
 * transportu typ `transport` (Wiktoria 18.11: „typ transport i klient — tak, tego potrzebuję”).
 *
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findInvoicedPositions() {
  return strictQuery(
    `SELECT i.id, i.level, i.number, DATE_FORMAT(i.issue_date, '%Y-%m-%d') AS issue_date,
            DATE_FORMAT(i.sale_date, '%Y-%m-%d') AS sale_date, i.order_id, i.order_name,
            i.created_by_pin, i.document_type, org.ident AS organization_ident,
            COALESCE(u.ident, iu.ident, bu.ident) AS user_ident, o.order_idx, oi.orderpos, it.quantity, it.net_amount,
            CASE WHEN JSON_EXTRACT(it.meta, '$.transport') IS NOT NULL THEN 'transport' ELSE '' END AS item_type
       FROM invoice i
       JOIN invoice_item it ON it.invoice_id = i.id
       LEFT JOIN organization org ON org.id = i.organization_id
       LEFT JOIN order_item oi ON oi.id = it.order_item_id
       LEFT JOIN \`order\` o ON o.id = oi.order_id
       LEFT JOIN \`user\` u ON u.id = o.user_id
       LEFT JOIN \`order\` io ON io.id = i.order_id
       LEFT JOIN \`user\` iu ON iu.id = io.user_id
       LEFT JOIN \`user\` bu ON bu.id = i.buyer_user_id
      WHERE i.number IS NOT NULL AND i.status IN ('issued', 'paid', 'overdue')
      ORDER BY i.id, it.position, it.id`
  );
}

/**
 * Transport (`transport.js`): zlecenia po id albo po parach (ident klienta, numer zlecenia)
 * z status.txt, z organizacją, płatnikiem i adresem dostawy. Adres jak w e-fakturze: adres
 * wysyłki zlecenia, inaczej adres dostawy, inaczej konto klienta. Płatnik osobnym zapytaniem,
 * bo kolumny `paymaster_ident` nie ma w bazie bez `add_user_paymaster_bank.sql`.
 *
 * @param {{ orderIds?: number[], pairs?: Array<[string, string]> }} params
 */
async function getTransportOrders({ orderIds = [], pairs = [] }) {
  if (!orderIds.length && !pairs.length) return [];
  const rows = await strictQuery(
    `SELECT o.id, o.order_idx, o.commision, u.id AS user_id, u.ident AS user_ident, org.ident AS org_ident,
            COALESCE(NULLIF(sa.country, ''), NULLIF(da.country, ''), u.country) AS country,
            COALESCE(NULLIF(sa.zip, ''), NULLIF(da.zip, ''), u.zip) AS zip,
            CASE WHEN sa.id IS NOT NULL THEN CONCAT('S', sa.id) WHEN da.id IS NOT NULL THEN CONCAT('D', da.id) ELSE '' END AS address_key
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
       JOIN organization org ON org.id = o.organization_id
       LEFT JOIN send_address sa ON sa.id = o.send_address_id
       LEFT JOIN delivery_address da ON da.id = o.delivery_address_id
      WHERE ${orderIds.length ? 'o.id IN (?)' : '(u.ident, o.order_idx) IN (?)'}`,
    [orderIds.length ? orderIds : pairs]
  );
  if (!rows.length) return rows;
  const users = await strictQuery('SELECT * FROM `user` WHERE id IN (?)', [[...new Set(rows.map((r) => r.user_id))]]);
  const { cleanValue } = require('../core/contractorAccounts');
  // „-” w contractors.txt = brak płatnika
  const payer = new Map(users.map((u) => [u.id, cleanValue(u.paymaster_ident) || '']));
  return rows.map((r) => ({ ...r, paymaster_ident: payer.get(r.user_id) || '' }));
}

/** Transport: pozycje zleceń z cenami (kwota jak na fakturze liczy `core/orderMapper.js`). */
async function getTransportItems(orderIds) {
  if (!orderIds.length) return [];
  return strictQuery(
    `SELECT oi.id, oi.order_id, oi.orderpos, oi.name, oi.amount, oi.total_price, oi.total_price_sub, oi.json_parameters
       FROM order_item oi WHERE oi.order_id IN (?) ORDER BY oi.order_id, oi.id`,
    [orderIds]
  );
}

/** Transport: najniższy numer wystawionej faktury poziomu 2 (organizacja → klient) każdej pozycji. */
async function findIssuedTransportInvoices(orderItemIds) {
  if (!orderItemIds.length) return [];
  return strictQuery(
    `SELECT it.order_item_id, MIN(i.number) AS number
       FROM invoice_item it JOIN invoice i ON i.id = it.invoice_id
      WHERE it.order_item_id IN (?) AND i.level = 2 AND i.number IS NOT NULL
        AND i.status IN ('issued', 'paid', 'overdue') AND i.document_type IN ('invoice', 'final')
      GROUP BY it.order_item_id`,
    [orderItemIds]
  );
}

/** Transport: linie transportu na wystawionych fakturach — ochrona przed drugim dopisaniem opłaty. */
async function findTransportLines() {
  return strictQuery(
    `SELECT i.number, it.meta
       FROM invoice_item it JOIN invoice i ON i.id = it.invoice_id
      WHERE i.number IS NOT NULL AND i.status IN ('issued', 'paid', 'overdue')
        AND JSON_EXTRACT(it.meta, '$.transport') IS NOT NULL`
  );
}

/**
 * Faktury czekające na wysyłkę na FTP (`invoiceFtpExport.js`) — te same warunki
 * co kolejka maili (`findInvoicesToMail`), własne zdarzenia, tylko podane
 * poziomy, plus identy do ścieżki katalogu: `organization_ident` (organizacja
 * faktury — na poziomie 1 to NABYWCA), `issuer_organization_ident` (wystawca
 * będący organizacją) i `client_ident` (konto klienta-nabywcy). `createdByPin` —
 * jeden autor albo lista (automat + faktury dzienne HKL).
 *
 * @param {{ since: string, doneEvent: string, failedEvent: string, maxAttempts?: number, createdByPin?: string|string[], levels: number[], limit?: number }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findInvoicesForFtp({ since, doneEvent, failedEvent, maxAttempts = 5, createdByPin = 'AUTO', levels, limit = 50 }) {
  return strictQuery(
    `SELECT i.id, i.number, i.level, i.document_type, i.organization_id, i.issuer_id, i.issuer_type, i.lang,
            i.buyer_user_id, i.buyer_name, i.created_at, i.created_by_pin,
            org.ident AS organization_ident, iss.ident AS issuer_organization_ident, u.ident AS client_ident,
            (SELECT JSON_UNQUOTE(JSON_EXTRACT(p.payload, '$.path')) FROM invoice_event p
              WHERE p.invoice_id = i.id AND (p.event_type LIKE 'ftp\\_uploaded%' OR p.event_type = 'ftp_replaced')
              ORDER BY p.id DESC LIMIT 1) AS previous_path,
            (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?) AS failures
       FROM invoice i
       LEFT JOIN organization org ON org.id = i.organization_id
       LEFT JOIN organization iss ON iss.id = i.issuer_id AND i.issuer_type = 'organization'
       LEFT JOIN \`user\` u ON u.id = i.buyer_user_id
      WHERE i.created_by_pin IN (?)
        AND i.status IN ('issued', 'paid', 'overdue')
        AND i.number IS NOT NULL
        AND i.level IN (?)
        AND i.created_at >= ?
        AND NOT EXISTS (SELECT 1 FROM invoice_event e WHERE e.invoice_id = i.id AND e.event_type = ?)
        AND (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?) < ?
      ORDER BY i.id
      LIMIT ?`,
    [failedEvent, [].concat(createdByPin), levels, since, doneEvent, failedEvent, maxAttempts, limit]
  );
}

/**
 * Ostatnia wersja treści dokumentu: utworzenie (także nowa wersja po przeliczeniu —
 * `createInvoice({ replaceId })` przenosi stare zdarzenia PRZED nowe `created`)
 * albo edycja w miejscu (`updateInvoiceContent` → `edited`).
 */
const LAST_VERSION_EVENT_SQL = `COALESCE((SELECT MAX(v.id) FROM invoice_event v
     WHERE v.invoice_id = i.id AND v.event_type IN ('created', 'edited')), 0)`;

/**
 * Faktury do wysłania do usługi e-faktur (`einvoice/index.js`): wystawione od `since`
 * (data wystawienia), pary (wystawca z kluczem API, poziom) z `issuerLevels`, bez rozstrzygnięcia
 * dla AKTUALNEJ wersji treści — zdarzenie końcowe sprzed edycji/przeliczenia się
 * nie liczy, tak samo nieudane próby (licznik od nowa po zmianie treści).
 *
 * @param {{ since: string, issuerLevels: Array<[string, number]>, statuses: string[], terminalEvents: string[], failedEvent: string, maxAttempts: number, limit: number }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findInvoicesForEinvoice({ since, issuerLevels, statuses, terminalEvents, failedEvent, maxAttempts, limit }) {
  if (!issuerLevels.length) return [];
  const { HKL_ORG_ID } = require('../../subPrices');
  const issuerIdent = `CASE i.issuer_type WHEN 'organization' THEN iss.ident WHEN 'manufacturer' THEN hkl.ident WHEN 'user' THEN iu.ident END`;
  return strictQuery(
    `SELECT i.id, i.number, i.level, i.issuer_type, i.issuer_id, i.document_type, i.order_id, i.order_name,
            i.created_by_pin, DATE_FORMAT(i.sale_date, '%Y-%m-%d') AS sale_date, i.buyer_name,
            ${issuerIdent} AS issuer_ident,
            (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?
                AND f.id > ${LAST_VERSION_EVENT_SQL}) AS failures
       FROM invoice i
       LEFT JOIN organization iss ON iss.id = i.issuer_id AND i.issuer_type = 'organization'
       LEFT JOIN organization hkl ON hkl.id = ?
       LEFT JOIN \`user\` iu ON iu.id = i.issuer_id AND i.issuer_type = 'user'
      WHERE i.status IN (?)
        AND i.number IS NOT NULL
        AND i.issue_date >= ?
        AND (${issuerIdent}, i.level) IN (?)
        AND NOT EXISTS (SELECT 1 FROM invoice_event e WHERE e.invoice_id = i.id AND e.event_type IN (?)
                           AND e.id > ${LAST_VERSION_EVENT_SQL})
        AND (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?
                AND f.id > ${LAST_VERSION_EVENT_SQL}) < ?
      ORDER BY i.id
      LIMIT ?`,
    [failedEvent, HKL_ORG_ID, statuses, since, issuerLevels, terminalEvents, failedEvent, maxAttempts, limit]
  );
}

/**
 * Wiersze źródłowe treści e-faktury (`einvoice/payload.js:buildPayload`) dla dokumentu
 * z bazy albo z `createFromOrder({ dryRun })`: zamówienia i pozycje z właścicielem,
 * statusy pozycji z `position_statuses`, adresy wysyłki, nabywca, termin płatności
 * klienta, wystawca i dokument korygowany. Wyłącznie odczyt.
 *
 * @param {import('../domain/types').Invoice & Record<string, any>} invoice
 * @returns {Promise<import('../einvoice/payload').EinvoiceSources>}
 */
async function getEinvoiceSources(invoice) {
  const itemIds = [...new Set((invoice.items || []).map((it) => Number(it.orderItemId)).filter(Boolean))];
  const orderItems = itemIds.length
    ? await strictQuery(
      `SELECT oi.id, oi.order_id, oi.orderpos, oi.commision, oi.json_parameters, oi.asortment_group_number,
              o.order_idx, u.ident AS user_ident, pg.name_de AS group_de, d.name_de AS department_de
         FROM order_item oi
         JOIN \`order\` o ON o.id = oi.order_id
         JOIN \`user\` u ON u.id = o.user_id
         LEFT JOIN product_group pg ON pg.group_number = oi.asortment_group_number
         LEFT JOIN department d ON d.id = pg.department_id
        WHERE oi.id IN (?)
        ORDER BY oi.order_id, oi.orderpos, oi.id`,
      [itemIds]
    )
    : [];
  const orderIds = [...new Set([invoice.orderId, ...orderItems.map((r) => r.order_id)].filter(Boolean).map(Number))];
  const orders = orderIds.length
    ? await strictQuery(
      `SELECT o.id, o.order_idx, o.commision, DATE_FORMAT(o.delivery_date, '%Y-%m-%d') AS delivery_date,
              o.send_address_id, u.ident AS user_ident
         FROM \`order\` o
         JOIN \`user\` u ON u.id = o.user_id
        WHERE o.id IN (?)
        ORDER BY o.id`,
      [orderIds]
    )
    : [];
  const pairs = [...new Map(orders.map((o) => [`${o.user_ident}\u0000${o.order_idx}`, [o.user_ident, o.order_idx]])).values()];
  const statuses = pairs.length
    ? await strictQuery(
      `SELECT user_ident, order_idx, order_pos, status, DATE_FORMAT(shipping_date, '%Y-%m-%d') AS shipping_date
         FROM position_statuses WHERE (user_ident, order_idx) IN (?)`,
      [pairs]
    )
    : [];
  const sendIds = [...new Set(orders.map((o) => Number(o.send_address_id)).filter(Boolean))];
  const sendAddresses = sendIds.length
    ? await strictQuery('SELECT id, name, street, zip, city, country FROM send_address WHERE id IN (?)', [sendIds])
    : [];

  let buyer = { ident: null, email: null, phone: null, invoiceEmail: '' };
  if (invoice.buyerGroupUserId) {
    const [g] = await strictQuery('SELECT ident, email, phone FROM group_user WHERE id = ?', [invoice.buyerGroupUserId]);
    if (g) buyer = { ...g, invoiceEmail: '' };
  } else if (invoice.buyerUserId) {
    // `SELECT *`: `invoice_email`/`paymaster_ident` są od migracji — bez nich puste. Adres do faktur
    // (contractors.txt INVOICE_EMAIL) płatnika, gdy faktura idzie na płatnika, inaczej klienta
    const { cleanValue } = require('../core/contractorAccounts');
    const [u] = await strictQuery('SELECT * FROM `user` WHERE id = ?', [invoice.buyerUserId]);
    if (u) {
      const paymaster = cleanValue(u.paymaster_ident);
      const [payer] = paymaster && paymaster.toUpperCase() !== String(u.ident || '').toUpperCase()
        ? await strictQuery('SELECT * FROM `user` WHERE ident = ? LIMIT 1', [paymaster])
        : [];
      buyer = { ident: u.ident, email: u.email, phone: u.phone, invoiceEmail: cleanValue(payer && payer.invoice_email) || cleanValue(u.invoice_email) };
    }
  } else if (invoice.buyerType === 'organization') {
    // Poziom 1: nabywcą jest organizacja faktury
    const [o] = await strictQuery('SELECT ident, invoice_email AS email, NULL AS phone FROM organization WHERE id = ?', [invoice.organizationId]);
    if (o) buyer = { ...o, invoiceEmail: '' };
  }

  let paymentTermsDays = null;
  if (invoice.buyerUserId) {
    try {
      const [t] = await strictQuery(
        'SELECT payment_terms_days FROM customer_commercial_terms WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1',
        [invoice.buyerUserId]
      );
      if (t && t.payment_terms_days !== null && t.payment_terms_days !== undefined) paymentTermsDays = Number(t.payment_terms_days);
    } catch (err) {
      // Baza bez modułu kartoteki klientów (ORG_CUSTOMERS_ENABLED) — termin z dat faktury
      if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    }
  }

  let issuer = await getInvoiceSender({ issuerType: invoice.issuerType, issuerId: invoice.issuerId });
  if (!issuer && invoice.issuerType === 'user') {
    const [u] = await strictQuery('SELECT ident, email FROM `user` WHERE id = ?', [invoice.issuerId]);
    if (u) issuer = { ident: u.ident || '', email: u.email || '' };
  }

  let corrected = null;
  if (invoice.correctedInvoiceId) {
    const [c] = await strictQuery(
      `SELECT number, DATE_FORMAT(issue_date, '%Y-%m-%d') AS issueDate, DATE_FORMAT(delivery_date, '%Y-%m-%d') AS deliveryDate
         FROM invoice WHERE id = ?`,
      [invoice.correctedInvoiceId]
    );
    corrected = c || null;
  }

  return {
    issuer: { ident: (issuer && issuer.ident) || '', email: (issuer && issuer.email) || '' },
    buyer,
    paymentTermsDays,
    orders,
    orderItems,
    statuses,
    sendAddresses,
    corrected
  };
}

/**
 * Pozycje zamówień pod wydruk faktury MaizonCozy (`render/maizonCozy.js`):
 * parametry pozycji (opis, cennik SUB___, grupa cenowa) i nazwa zamówienia
 * do referencji `EO/<nr>/<poz>/<nazwa>`.
 *
 * @param {number[]} orderItemIds
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function getOrderItemsForPrint(orderItemIds) {
  if (!orderItemIds.length) return [];
  return strictQuery(
    `SELECT oi.id, oi.orderpos, oi.commision, oi.json_parameters, o.order_idx, o.commision AS order_commision
       FROM order_item oi
       JOIN \`order\` o ON o.id = oi.order_id
      WHERE oi.id IN (?)`,
    [orderItemIds]
  );
}

/**
 * Wpis w dzienniku dokumentu (`invoice_event`). Rzuca przy błędzie zapisu —
 * w przeciwieństwie do `db/core.insertQuery`, które błąd tylko loguje.
 *
 * @param {{ invoiceId: number, eventType: string, actorPin?: string|null, payload?: object|null }} event
 * @returns {Promise<void>}
 */
async function addInvoiceEvent({ invoiceId, eventType, actorPin = null, payload = null }) {
  await strictQuery(
    'INSERT INTO invoice_event (invoice_id, event_type, actor_pin, payload) VALUES (?, ?, ?, ?)',
    [invoiceId, eventType, actorPin, payload ? JSON.stringify(payload) : null]
  );
}

/**
 * Faktury na przypomnienie o płatności (`invoiceMailer.js`, szef 19.11.2026; ustalenia Wiktorii 20.11):
 * tylko faktury HKL (tylko ich wpłaty zna księgowość — plik płatności), tylko z numerem KSeF (faktura
 * powtarzająca fakturę PROD zostałaby „otwarta” na zawsze), termin minął co najmniej N dni temu
 * (`dueOnOrBefore`; wpłata trafia do ksiąg do ~3 dni po wyciągu), nieopłacone, wysłane wcześniej mailem
 * w tym samym trybie (`mailedEvent`), bez przypomnienia (`doneEvent`), mniej niż `maxAttempts` porażek.
 * `<=`, nie `=`: numer KSeF może przyjść po N-tym dniu — przypomnienie pójdzie wtedy od razu, raz.
 *
 * @param {{ dueOnOrBefore: string, since: string, mailedEvent: string, doneEvent: string, failedEvent: string, maxAttempts?: number, limit?: number }} params
 *        `since` — tylko faktury wystawione od tego dnia (`INVOICE_REMINDERS_SINCE`)
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findInvoicesToRemind({ dueOnOrBefore, since, mailedEvent, doneEvent, failedEvent, maxAttempts = 3, limit = 50 }) {
  const { HKL_ORG_ID } = require('../../subPrices');
  return strictQuery(
    `SELECT i.id, i.number, i.buyer_name, i.due_date, i.amount_due, i.paid_amount, i.currency,
            (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?) AS failures
       FROM invoice i
      WHERE i.status IN ('issued', 'overdue')
        AND i.document_type IN ('invoice', 'final')
        AND i.number IS NOT NULL
        AND i.due_date <= ?
        AND i.issue_date >= ?
        AND (i.issuer_type = 'manufacturer' OR (i.issuer_type = 'organization' AND i.issuer_id = ?))
        AND i.amount_due - i.paid_amount >= 0.01
        AND EXISTS (SELECT 1 FROM invoice_event k WHERE k.invoice_id = i.id AND k.event_type = 'ksef_accepted')
        AND EXISTS (SELECT 1 FROM invoice_event m WHERE m.invoice_id = i.id AND m.event_type = ?)
        AND NOT EXISTS (SELECT 1 FROM invoice_event e WHERE e.invoice_id = i.id AND e.event_type = ?)
        AND (SELECT COUNT(*) FROM invoice_event f WHERE f.invoice_id = i.id AND f.event_type = ?) < ?
      ORDER BY i.id
      LIMIT ?`,
    [failedEvent, dueOnOrBefore, since, Number(HKL_ORG_ID), mailedEvent, doneEvent, failedEvent, maxAttempts, limit]
  );
}

/**
 * Faktury HKL po numerach — do pliku płatności z księgowości (`invoicePayments.js`; plik obejmuje tylko
 * faktury HKL — Wiktoria 20.11.2026). Organizacja jak w pliku pozycji (`organization_ident` = organizacja
 * faktury: na poziomie 1 nabywca, na 2 wystawca).
 *
 * @param {string[]} numbers
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findInvoicesByNumbers(numbers) {
  if (!numbers.length) return [];
  const { HKL_ORG_ID } = require('../../subPrices');
  return strictQuery(
    `SELECT i.id, i.number, i.level, i.status, i.document_type, i.amount_due, i.paid_amount, i.paid_at, i.currency,
            DATE_FORMAT(i.issue_date, '%Y-%m-%d') AS issue_date, org.ident AS organization_ident
       FROM invoice i
       LEFT JOIN organization org ON org.id = i.organization_id
      WHERE i.number IN (?)
        AND (i.issuer_type = 'manufacturer' OR (i.issuer_type = 'organization' AND i.issuer_id = ?))`,
    [numbers, Number(HKL_ORG_ID)]
  );
}

/**
 * Stan KSeF faktur (`invoiceKsef.js`): ostatnie zdarzenie `ksef_*` każdej faktury.
 *
 * @param {number[]} invoiceIds
 * @returns {Promise<Map<number, { status: string, ksefNumber: string, ksefDate: string, verifyUrl: string, reason: string }>>}
 */
async function getKsefStates(invoiceIds) {
  const ids = [...new Set(invoiceIds.map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await strictQuery(
    `SELECT e.invoice_id, e.payload FROM invoice_event e
      WHERE e.invoice_id IN (?) AND e.event_type LIKE 'ksef\\_%'
        AND e.id = (SELECT MAX(x.id) FROM invoice_event x WHERE x.invoice_id = e.invoice_id AND x.event_type LIKE 'ksef\\_%')`,
    [ids]
  );
  return new Map(rows.map((r) => {
    const p = parseJsonColumn(r.payload) || {};
    return [Number(r.invoice_id), { status: p.status || '', ksefNumber: p.ksefNumber || '', ksefDate: p.ksefDate || '', verifyUrl: p.verifyUrl || '', reason: p.reason || '' }];
  }));
}

/**
 * Wpłata z księgowości: kwota, data i (przy pełnej) status „opłacona”, plus wpis `payment_synced`
 * w dzienniku. Tylko gdy status się w międzyczasie nie zmienił (np. ktoś anulował fakturę).
 *
 * @param {{ id: number, fromStatus: string, status: string, paidAmount: number, paidAt: string|null, actorPin?: string, payload?: object }} p
 * @returns {Promise<boolean>} czy zapisano
 */
async function applyPayment({ id, fromStatus, status, paidAmount, paidAt, actorPin = null, payload = null }) {
  return withTransaction(async (conn) => {
    const [r] = await conn.query('UPDATE invoice SET status = ?, paid_amount = ?, paid_at = ? WHERE id = ? AND status = ?',
      [status, paidAmount, paidAt, Number(id), fromStatus]);
    if (!r.affectedRows) return false;
    await conn.query(
      `INSERT INTO invoice_event (invoice_id, event_type, from_status, to_status, actor_pin, payload)
       VALUES (?, 'payment_synced', ?, ?, ?, ?)`,
      [Number(id), fromStatus, status, actorPin, payload ? JSON.stringify(payload) : null]
    );
    return true;
  });
}

/**
 * Zamówienia klientów z fakturowaniem niestandardowym (`user.invoice_schedule`),
 * które czekają na FAKTURĘ ZBIORCZĄ poziomu 2. Te same warunki co pojedyncza
 * faktura automatu (`findAutoInvoiceCandidates`, poziom 2) — różni je tylko to,
 * że zamówienia trafiają razem na jeden dokument za okres (`core/collective.js`).
 *
 * @param {{ since: string, organizationIds?: number[] }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findCollectiveCandidates({ since, organizationIds = [] }) {
  if (!(await supportsInvoiceSchedule())) return [];
  const values = [since];
  let filters = '';
  if (organizationIds.length) { filters += ' AND o.organization_id IN (?)'; values.push(organizationIds); }
  values.push([2], [2]);

  return strictQuery(
    `SELECT o.id, o.order_idx, o.user_id, o.group_user_id, o.organization_id, o.delivery_date,
            u.ident AS user_ident, u.invoice_schedule
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
       JOIN organization org ON org.id = o.organization_id
      WHERE o.status = 'sent'
        AND o.prod_status = '!sent!'
        AND o.delivery_date >= ?${filters}
        AND u.invoice_schedule IN ('weekly', 'monthly')
        ${AUTO_LEVEL_SQL[2]}
        AND NOT EXISTS (
              SELECT 1 FROM position_statuses ps
               WHERE ps.user_ident = u.ident AND CAST(ps.order_idx AS CHAR) = o.order_idx
                 AND ps.status <> '!sent!')
        AND NOT EXISTS (
              SELECT 1 FROM invoice i
               WHERE i.order_id = o.id AND i.level IN (?)
                 AND i.document_type IN ('invoice', 'final', 'advance'))
        AND NOT ${linkedDocumentSql("AND il.document_type IN ('invoice', 'final', 'advance')")}
      ORDER BY o.user_id, o.delivery_date, o.id`,
    values
  );
}

/**
 * Zlecenia HKL czekające na FAKTURĘ DZIENNĄ (`core/collective.js:groupDailyCandidates`):
 * poziom 1 — zlecenia innych organizacji (HKL → organizacja), poziom 2 — klientów
 * HKL (bez własnego konta HKL i bez klientów z fakturą tygodniową/miesięczną — ci
 * dostają zbiorczą). Te same warunki wysyłki co automat. Od 18.11.2026 dzienna to
 * jedyna faktura relacji HKL, więc wyklucza ją każda faktura tego zlecenia: wystawiona
 * per zlecenie (np. ręcznie; szkic przygotowany w edytorze nie — jego zmiany niesie
 * dzienna) i dzienna/zbiorcza obejmująca jego pozycje (także anulowana: ktoś zajął się
 * nią ręcznie).
 *
 * @param {{ level: 1|2, since: string, organizationIds?: number[] }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function findDailyCandidates({ level, since, organizationIds = [] }) {
  const { HKL_ORG_ID } = require('../../subPrices');
  const lvl = Number(level);
  if (lvl !== 1 && lvl !== 2) throw new Error(`Faktura dzienna nie obsługuje poziomu ${level}`);
  const values = [lvl, since, Number(HKL_ORG_ID)];
  let filters = '';
  if (organizationIds.length) { filters += ' AND o.organization_id IN (?)'; values.push(organizationIds); }
  if (lvl === 2 && (await supportsInvoiceSchedule())) filters += " AND (u.invoice_schedule IS NULL OR u.invoice_schedule NOT IN ('weekly', 'monthly'))";
  values.push([lvl], [lvl]);

  return strictQuery(
    `SELECT o.id, o.order_idx, o.user_id, o.group_user_id, o.organization_id, o.delivery_date,
            u.ident AS user_ident, org.ident AS organization_ident, ? AS level
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
       JOIN organization org ON org.id = o.organization_id
      WHERE o.status = 'sent'
        AND o.prod_status = '!sent!'
        AND o.delivery_date >= ?
        AND ${lvl === 1 ? 'o.organization_id <> ?' : `o.organization_id = ? ${AUTO_LEVEL_SQL[2]}`}${filters}
        AND NOT EXISTS (
              SELECT 1 FROM position_statuses ps
               WHERE ps.user_ident = u.ident AND CAST(ps.order_idx AS CHAR) = o.order_idx
                 AND ps.status <> '!sent!')
        AND NOT EXISTS (
              SELECT 1 FROM invoice i
               WHERE i.order_id = o.id AND i.level IN (?)
                 AND i.document_type IN ('invoice', 'final', 'advance') AND i.status NOT IN ('draft', 'cancelled'))
        AND NOT ${linkedDocumentSql("AND il.document_type IN ('invoice', 'final', 'advance')")}
      ORDER BY o.delivery_date, o.id`,
    values
  );
}

/**
 * Ręczne zmiany faktury dla zamówienia i relacji (`core/manualEdit.js`): najnowszy
 * nieanulowany dokument tego zamówienia z nakładką — przygotowany szkic albo
 * wystawiona faktura per zlecenie. Faktura dzienna/zbiorcza (`order_id` NULL) nakładki
 * nie niesie, tylko ją stosuje. `strictQuery`: bez nakładki faktura wyszłaby bez zmian.
 *
 * @param {{ orderId: number, level: number }} params
 * @returns {Promise<{ invoiceId: number, status: string, manualEdit: Record<string, any> }|null>}
 */
async function findManualOverlay({ orderId, level }) {
  const rows = await strictQuery(
    `SELECT id, status, compliance FROM invoice
      WHERE order_id = ? AND level = ? AND status <> 'cancelled'
        AND JSON_EXTRACT(compliance, '$.manualEdit.overlay') IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [Number(orderId), Number(level)]
  );
  const row = rows[0];
  const manualEdit = row ? (parseJsonColumn(row.compliance) || {}).manualEdit : null;
  return manualEdit && manualEdit.overlay ? { invoiceId: Number(row.id), status: row.status, manualEdit } : null;
}

/**
 * Szkic przygotowany ręcznie dla zamówienia i relacji (przed !sent!).
 * @returns {Promise<{ id: number, compliance: Record<string, any> }|null>}
 */
async function findPreparedDraft({ orderId, level }) {
  const rows = await strictQuery(
    `SELECT id, compliance FROM invoice
      WHERE order_id = ? AND level = ? AND status = 'draft'
        AND JSON_UNQUOTE(JSON_EXTRACT(compliance, '$.manualEdit.prepared')) = 'true'
      ORDER BY id DESC LIMIT 1`,
    [Number(orderId), Number(level)]
  );
  return rows[0] ? { id: Number(rows[0].id), compliance: parseJsonColumn(rows[0].compliance) || {} } : null;
}

/**
 * Przygotowane szkice, których zamówienie doszło do !sent! — automat wystawia je
 * zamiast budować fakturę od zera. Bez relacji, w których faktury per zlecenie nie ma:
 * relacje HKL przy fakturach dziennych (`hklDailyOnly`: poziom 1 i klienci HKL) i klient
 * z fakturą tygodniową/miesięczną — tam nakładkę stosuje faktura dzienna/zbiorcza.
 *
 * @param {{ since: string, hklDailyOnly?: boolean, limit?: number }} params
 */
async function findPreparedDraftsReady({ since, hklDailyOnly = false, limit = 100 }) {
  const { HKL_ORG_ID } = require('../../subPrices');
  const scheduleSql = (await supportsInvoiceSchedule())
    ? "AND (i.level <> 2 OR u.invoice_schedule IS NULL OR u.invoice_schedule NOT IN ('weekly', 'monthly'))"
    : '';
  return strictQuery(
    `SELECT i.id, i.order_id, i.level, o.order_idx, o.organization_id, u.ident AS user_ident,
            EXISTS (SELECT 1 FROM invoice_event e WHERE e.invoice_id = i.id AND e.event_type = 'manual_review') AS review
       FROM invoice i
       JOIN \`order\` o ON o.id = i.order_id
       JOIN \`user\` u ON u.id = o.user_id
      WHERE i.status = 'draft'
        AND JSON_UNQUOTE(JSON_EXTRACT(i.compliance, '$.manualEdit.prepared')) = 'true'
        AND o.status = 'sent' AND o.prod_status = '!sent!' AND o.delivery_date >= ?
        AND NOT EXISTS (
              SELECT 1 FROM position_statuses ps
               WHERE ps.user_ident = u.ident AND CAST(ps.order_idx AS CHAR) = o.order_idx
                 AND ps.status <> '!sent!')
        ${hklDailyOnly ? 'AND i.level <> 1 AND NOT (i.level = 2 AND o.organization_id = ?)' : ''}
        ${scheduleSql}
      ORDER BY i.id
      LIMIT ?`,
    [since, ...(hklDailyOnly ? [Number(HKL_ORG_ID)] : []), Number(limit)]
  );
}

/**
 * Wyszukiwarka faktur admina we WSZYSTKICH organizacjach (prośba Pawła 17.11.2026: panel
 * działa w kontekście jednej organizacji, więc np. Cozy → M2 nie było widać z HKL).
 * Szuka po numerze, nabywcy (nazwa, ident), numerze i nazwie (commission) zamówienia
 * z nagłówka, a dla dziennej/zbiorczej także po zamówieniach i klientach pozycji.
 *
 * @param {{ q: string, limit?: number }} params
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function searchInvoices({ q, limit = 100 }) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return strictQuery(
    `SELECT i.id, i.number, i.level, i.status, i.document_type, i.currency, i.total_net, i.total_gross, i.amount_due, i.paid_amount,
            i.issue_date, i.due_date, i.seller_name, i.buyer_name, i.order_ref, i.order_name, i.created_by_pin, i.issuer_type, i.issuer_id,
            JSON_EXTRACT(i.compliance, '$.manualEdit') IS NOT NULL AS manual_edit, bu.ident AS buyer_ident
       FROM invoice i
       LEFT JOIN \`user\` bu ON bu.id = i.buyer_user_id
      WHERE i.number LIKE ? OR i.buyer_name LIKE ? OR bu.ident LIKE ? OR i.order_ref LIKE ? OR i.order_name LIKE ?
         OR EXISTS (SELECT 1 FROM invoice_item ii
                      JOIN order_item oi ON oi.id = ii.order_item_id
                      JOIN \`order\` o ON o.id = oi.order_id
                      JOIN \`user\` ou ON ou.id = o.user_id
                     WHERE ii.invoice_id = i.id
                       AND (o.commision LIKE ? OR oi.commision LIKE ? OR o.order_idx LIKE ? OR ou.ident LIKE ? OR ou.client_name LIKE ?))
      ORDER BY i.id DESC
      LIMIT ?`,
    [like, like, like, like, like, like, like, like, like, like, Number(limit)]
  );
}

/** Strony zamówienia do wejść edytora faktury (`orderLinks.js`). */
async function getOrderRelations(orderId) {
  const rows = await strictQuery(
    `SELECT o.organization_id, org.ident AS org_ident, u.ident AS user_ident
       FROM \`order\` o JOIN \`user\` u ON u.id = o.user_id JOIN organization org ON org.id = o.organization_id
      WHERE o.id = ?`,
    [Number(orderId)]
  );
  return rows[0] ? { organizationId: Number(rows[0].organization_id), orgIdent: rows[0].org_ident || '', userIdent: rows[0].user_ident || '' } : null;
}

/**
 * Wystawiona faktura zamówienia w relacji — najpierw per zlecenie, potem dzienna/zbiorcza
 * z jego pozycjami (edytor otwiera ją zamiast nowego przygotowania).
 */
async function findOrderInvoiceForEdit({ orderId, level }) {
  const rows = await strictQuery(
    `SELECT i.id FROM invoice i
      WHERE i.level = ? AND i.status NOT IN ('cancelled', 'draft') AND i.document_type IN ('invoice', 'final')
        AND (i.order_id = ? OR EXISTS (SELECT 1 FROM invoice_item ii JOIN order_item oi ON oi.id = ii.order_item_id
                                        WHERE ii.invoice_id = i.id AND oi.order_id = ?))
      ORDER BY (i.order_id IS NULL), i.id DESC
      LIMIT 1`,
    [Number(level), Number(orderId), Number(orderId)]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Liczba zdarzeń „przyjęta przez system zewnętrzny” dokumentu `idSql` (`core/statuses.acceptedLockMessage`):
 * e-faktura ZUGFeRD przyjęta w trybie LIVE (w cieniu dokument „MUSTER” niczego nie blokuje) i KSeF ACCEPTED.
 * Nowy system z akceptacją = kolejny warunek tutaj.
 */
const acceptedSql = (idSql) => `(SELECT COUNT(*) FROM invoice_event x WHERE x.invoice_id = ${idSql}
     AND (x.event_type = 'ksef_accepted'
       OR (x.event_type = 'einvoice_ready' AND JSON_UNQUOTE(JSON_EXTRACT(x.payload, '$.mode')) = 'live')))`;

/** Co blokuje edycję w miejscu: korekta/dokument powiązany, alokacje częściowego fakturowania, przyjęcie e-faktury/KSeF. */
async function getEditBlockers(invoiceId) {
  const [row] = await strictQuery(
    `SELECT (SELECT COUNT(*) FROM invoice r WHERE r.corrected_invoice_id = ? OR r.parent_invoice_id = ?) AS related,
            (SELECT COUNT(*) FROM invoice_item_allocation a WHERE a.invoice_id = ?) AS allocations,
            ${acceptedSql('?')} AS accepted`,
    [Number(invoiceId), Number(invoiceId), Number(invoiceId), Number(invoiceId)]
  );
  return { related: Number(row.related), allocations: Number(row.allocations), accepted: Number(row.accepted) };
}

/** Zamówienia na fakturze (nagłówek albo pozycje — dzienna/zbiorcza ma ich wiele). */
async function getInvoiceOrderIds(invoiceId) {
  const rows = await strictQuery(
    `SELECT DISTINCT oi.order_id AS id FROM invoice_item ii JOIN order_item oi ON oi.id = ii.order_item_id WHERE ii.invoice_id = ?
     UNION SELECT order_id AS id FROM invoice WHERE id = ? AND order_id IS NOT NULL`,
    [Number(invoiceId), Number(invoiceId)]
  );
  return [...new Set(rows.map((r) => Number(r.id)).filter(Boolean))];
}

/**
 * „Pobierz ponownie z zamówienia” (`InvoiceService.rebuildFromOrders`): autor faktury (od niego
 * zależy mail i FTP automatu) i jej zlecenia w kolejności pozycji. Osobno od `getInvoice`, bo
 * korekta kopiuje cały obiekt faktury i z `createdByPin` automat wysłałby ją mailem.
 *
 * @param {number} invoiceId
 * @returns {Promise<{ createdByPin: string|null, orderIds: number[] }>}
 */
async function getRebuildSource(invoiceId) {
  const [head] = await strictQuery('SELECT created_by_pin FROM invoice WHERE id = ?', [Number(invoiceId)]);
  const rows = await strictQuery(
    `SELECT oi.order_id AS id, MIN(ii.position) AS pos FROM invoice_item ii JOIN order_item oi ON oi.id = ii.order_item_id
      WHERE ii.invoice_id = ? GROUP BY oi.order_id ORDER BY pos`,
    [Number(invoiceId)]
  );
  return { createdByPin: head ? head.created_by_pin || null : null, orderIds: rows.map((r) => Number(r.id)) };
}

/** Historia faktury do panelu edycji (utworzenie, przygotowanie, edycje, przegląd). */
async function getInvoiceHistory(invoiceId) {
  const rows = await strictQuery(
    `SELECT event_type, actor_pin, payload, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS at
       FROM invoice_event
      WHERE invoice_id = ? AND event_type IN ('created', 'issued', 'prepared', 'edited', 'manual_review')
      ORDER BY id`,
    [Number(invoiceId)]
  );
  return rows.map((r) => ({ type: r.event_type, actorPin: r.actor_pin, at: r.at, payload: parseJsonColumn(r.payload) || {} }));
}

/**
 * Edycja faktury w miejscu (decyzja Pawła 17.11.2026): ten sam numer, nowe pozycje,
 * podsumowanie VAT, sumy, uwagi i daty w JEDNEJ transakcji. Blokada równoległej
 * edycji: `compliance.manualEdit.version`. Wpis `edited` niesie pełny zrzut poprzedniej
 * wersji. `reuploadFtp`: znacznik `ftp_uploaded` → `ftp_uploaded_rN`, więc eksport
 * podmieni PDF na FTP; znaczników maila nie ruszamy — klient nie dostaje nic.
 *
 * @param {number} invoiceId
 * @param {Record<string, any>} invoice  nowa treść (items, taxLines, sumy w groszach, notes, daty, compliance)
 * @param {{ expectedVersion?: number|null, actorPin?: string|null, eventType?: string, eventPayload?: object, reuploadFtp?: boolean }} opts
 * @returns {Promise<{ id: number, version: number }>}
 */
async function updateInvoiceContent(invoiceId, invoice, { expectedVersion = null, actorPin = null, eventType = 'edited', eventPayload = {}, reuploadFtp = false } = {}) {
  return withTransaction(async (conn) => {
    const [[row]] = await conn.query('SELECT id, currency, local_currency, compliance FROM invoice WHERE id = ? FOR UPDATE', [Number(invoiceId)]);
    if (!row) throw new Error(`Faktura ${invoiceId} nie istnieje`);
    const stored = parseJsonColumn(row.compliance) || {};
    const version = Number((stored.manualEdit && stored.manualEdit.version) || 0);
    if (expectedVersion != null && Number(expectedVersion) !== version) {
      const err = new Error('Ktoś zapisał tę fakturę w międzyczasie — odśwież edytor i nanieś zmiany jeszcze raz.');
      err.code = 'INVOICE_EDIT_CONFLICT';
      throw err;
    }
    const cur = row.currency;
    await conn.query('DELETE FROM invoice_item WHERE invoice_id = ?', [Number(invoiceId)]);
    await conn.query('DELETE FROM invoice_tax_line WHERE invoice_id = ?', [Number(invoiceId)]);
    await insertInvoiceItems(conn, Number(invoiceId), invoice, cur);
    await insertTaxLines(conn, Number(invoiceId), invoice.taxLines, cur);
    const compliance = {
      ...stored,
      ...(invoice.compliance || {}),
      manualEdit: { ...(stored.manualEdit || {}), ...((invoice.compliance && invoice.compliance.manualEdit) || {}), version: version + 1 }
    };
    await conn.query(
      `UPDATE invoice SET total_net = ?, total_tax = ?, total_gross = ?, total_tax_local = ?, amount_due = ?,
              notes = ?, sale_date = ?, delivery_date = ?, due_date = ?, legal_notes = ?, compliance = ?
        WHERE id = ?`,
      [
        money.toMajor(invoice.totalNet, cur), money.toMajor(invoice.totalTax, cur), money.toMajor(invoice.totalGross, cur),
        invoice.totalTaxLocal == null ? null : money.toMajor(invoice.totalTaxLocal, row.local_currency),
        money.toMajor(invoice.amountDue ?? invoice.totalGross, cur),
        invoice.notes || null, invoice.saleDate, invoice.deliveryDate || null, invoice.dueDate,
        invoice.legalNotes ? JSON.stringify(invoice.legalNotes) : null, JSON.stringify(compliance), Number(invoiceId)
      ]
    );
    await conn.query(
      'INSERT INTO invoice_event (invoice_id, event_type, actor_pin, payload) VALUES (?, ?, ?, ?)',
      [Number(invoiceId), eventType, actorPin, JSON.stringify(eventPayload)]
    );
    if (reuploadFtp) {
      const [[n]] = await conn.query("SELECT COUNT(*) AS c FROM invoice_event WHERE invoice_id = ? AND event_type LIKE 'ftp\\_uploaded\\_r%'", [Number(invoiceId)]);
      await conn.query("UPDATE invoice_event SET event_type = ? WHERE invoice_id = ? AND event_type = 'ftp_uploaded'", [`ftp_uploaded_r${Number(n.c) + 1}`, Number(invoiceId)]);
    }
    return { id: Number(invoiceId), version: version + 1 };
  });
}

/**
 * Faktury dzienne nabywcy za dzień (bez anulowanych) — automat nie wystawia drugiej,
 * spóźnione zlecenia dołącza „Przelicz dzienne ponownie”. Poziom 1: nabywca =
 * organizacja (`invoice.organization_id`), poziom 2: klient HKL i sklep grupowy.
 *
 * @param {{ level: number, organizationId: number, userId?: number|null, groupUserId?: number|null, day: string }} params
 * @returns {Promise<Array<{ id: number, number: string|null, status: string, issueDate: string, related: number, orders: Array<{ id: number, order_idx: string, user_id: number, user_ident: string }> }>>}
 */
async function findDailyInvoices({ level, organizationId, userId = null, groupUserId = null, day }) {
  const lvl = Number(level);
  const rows = await strictQuery(
    `SELECT i.id, i.number, i.status, DATE_FORMAT(i.issue_date, '%Y-%m-%d') AS issue_date,
            DATE_FORMAT(i.due_date, '%Y-%m-%d') AS due_date,
            JSON_UNQUOTE(JSON_EXTRACT(i.compliance, '$.manualEdit.edited')) AS edited,
            (SELECT COUNT(*) FROM invoice r WHERE r.corrected_invoice_id = i.id OR r.parent_invoice_id = i.id) AS related,
            ${acceptedSql('i.id')} AS accepted
       FROM invoice i
      WHERE i.created_by_pin = '${DAILY_ACTOR}' AND i.level = ? AND i.sale_date = ? AND i.organization_id = ?
        ${lvl === 1 ? '' : 'AND i.buyer_user_id = ? AND COALESCE(i.buyer_group_user_id, 0) = ?'}
        AND i.status <> 'cancelled'
      ORDER BY i.id`,
    lvl === 1 ? [lvl, day, Number(organizationId)] : [lvl, day, Number(organizationId), Number(userId), Number(groupUserId) || 0]
  );
  const result = [];
  for (const r of rows) {
    const orders = await strictQuery(
      `SELECT DISTINCT o.id, o.order_idx, o.user_id, u.ident AS user_ident
         FROM invoice_item ii
         JOIN order_item oi ON oi.id = ii.order_item_id
         JOIN \`order\` o ON o.id = oi.order_id
         JOIN \`user\` u ON u.id = o.user_id
        WHERE ii.invoice_id = ?`,
      [r.id]
    );
    result.push({ id: Number(r.id), number: r.number, status: r.status, issueDate: r.issue_date, dueDate: r.due_date, related: Number(r.related), accepted: Number(r.accepted), edited: r.edited === 'true', orders });
  }
  return result;
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
 * JEDNA seria faktur HKL (Paweł 18.11.2026: „wspólna numeracja — hkl-cozy 0001, potem hkl-luxan
 * 0002 i tak dalej”): HKL-producent (poziom 1, każda organizacja) i organizacja HKL (jej klienci,
 * poziomy 2 i 4) liczą razem, wzorzec `{YY}{NR:6}` → 26000001, 26000002… Licznik to ten, od
 * którego 17.11 ruszyła seria HKL → Cozy (26000001): `manufacturer/1/1` (1 = id Cozy, historycznie).
 * Wzorzec siedzi w kodzie razem z licznikiem: ten licznik z dawnym `{YYYY}/{NR:5}` dałby numery
 * już użyte w 2026 (2026/00002…).
 */
const HKL_SERIES = Object.freeze({ issuerType: 'manufacturer', issuerId: 1, level: 1, numberPattern: '{YY}{NR:6}' });

const { isHklIssuer } = require('../core/pricing');

/**
 * Klucz serii numeracji wystawcy — firma, nie poziom (patrz `allocateIssuerSequence`).
 * HKL → `HKL_SERIES`; inna organizacja zostaje przy kluczu poziomu 2, bo tam są jej liczniki.
 *
 * @param {{ issuerType: string, issuerId: number, level: number }} issuer
 * @returns {{ issuerType: string, issuerId: number, level: number }}
 */
function issuerSeriesKey({ issuerType, issuerId, level }) {
  if (isHklIssuer(issuerType, issuerId)) return { issuerType: HKL_SERIES.issuerType, issuerId: HKL_SERIES.issuerId, level: HKL_SERIES.level };
  if (issuerType === 'organization') return { issuerType, issuerId: Number(issuerId) || 0, level: 2 };
  return { issuerType, issuerId: Number(issuerId) || 0, level: Number(level) };
}

/**
 * Atomowa rezerwacja numeru w serii wystawcy.
 *
 * JEDNA seria na firmę, zerowana 1 stycznia: wspólny wzorzec przy osobnych licznikach dawał
 * te same numery dwóm fakturom jednego NIP-u (2026-11-06: HKL poziom 1 i poziom 2 → 97 par).
 * Dlatego klucz (`issuerSeriesKey`) pomija poziom: HKL (producent i organizacja) liczy w
 * `HKL_SERIES`, inna organizacja (poziomy 2 i 4) w swojej serii z poziomu 2, użytkownik
 * (poziom 3) w swojej. Ta sama technika co w
 * `allocateSequence`: `LAST_INSERT_ID(expr)` zapisuje i zwraca wartość w jednym
 * zapytaniu, więc dwa równoległe wystawienia nie dostaną tego samego numeru
 * (żadnego `SELECT … FOR UPDATE`).
 *
 * @param {{ issuerType: string, issuerId: number, level: number, year: number }} params
 * @param {import('mysql2/promise').PoolConnection} [conn]
 * @returns {Promise<number>}
 */
async function allocateIssuerSequence({ issuerType, issuerId, level, year }, conn) {
  ({ issuerType, issuerId, level } = issuerSeriesKey({ issuerType, issuerId, level }));
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
  const profile = await loadIssuerProfile({ issuerType, issuerId, level });
  return profile && isHklIssuer(issuerType, issuerId) ? { ...profile, numberPattern: HKL_SERIES.numberPattern } : profile;
}

/** Profil wystawcy z bazy albo zastępczy (`getIssuerProfile` bez wzorca serii HKL). */
async function loadIssuerProfile({ issuerType, issuerId, level }) {
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
      // Cozy: `{"invoice":"{YY}{NR:6}"}` → 26000008, numer zgodny z PROD (Wiktoria, 16.11.2026)
      numberPattern: org.numberPatterns.invoice || '{YYYY}/{NR:5}', legalSettings: {}, footerNotes: org.footerNotes
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
 * Skrzynka, z której idą maile z fakturami wystawcy: `organization.invoice_email`
 * (Paweł, 17.11.2026: „każda organizacja musi mieć swój adres fakturowy").
 * Producent (poziom 1) = HKL; konto klienta (poziom 3) własnej skrzynki nie ma.
 * Hasło skrzynki: `organization.invoice_email_password` (Paweł, 17.11.2026: „hasło w bazie,
 * na produkcji też”). `SELECT *`, bo baza bez którejś migracji (`add_organization_invoice_email*.sql`)
 * ma po prostu mniej kolumn — wtedy pusty adres/hasło i mail ze skrzynki systemu.
 *
 * @param {{ issuerType: string, issuerId: number }} issuer
 * @returns {Promise<{ ident: string, email: string, password: string }|null>}
 */
async function getInvoiceSender({ issuerType, issuerId }) {
  const { HKL_ORG_ID } = require('../../subPrices');
  const orgId = issuerType === 'organization' ? Number(issuerId) : (issuerType === 'manufacturer' ? HKL_ORG_ID : 0);
  if (!orgId) return null;
  const rows = await selectQuery('SELECT * FROM organization WHERE id = ?', [orgId]);
  const row = rows && rows[0];
  return row
    ? { ident: row.ident || '', email: String(row.invoice_email || '').trim(), password: String(row.invoice_email_password || '') }
    : null;
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
 * Domyślny kraj nowego odbiorcy: `user.country` właściciela kartoteki,
 * a gdy pusty (są takie konta) — kraj jego organizacji.
 *
 * @param {number} userId
 * @returns {Promise<string>} kod ISO-2 albo `''`
 */
async function getEndClientDefaultCountry(userId) {
  if (!userId) return '';
  const rows = await selectQuery(
    `SELECT u.country, o.country AS org_country
       FROM \`user\` u
       LEFT JOIN organization o ON o.id = u.organization_id
      WHERE u.id = ?`,
    [userId]
  );
  const row = rows && rows[0];
  if (!row) return '';
  const iso = (value) => {
    const code = String(value || '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : '';
  };
  return iso(row.country) || iso(row.org_country);
}

/**
 * @param {{ ownerUserId: number, organizationId: number, data: Record<string, any> }} params
 * @returns {Promise<number>} id nowego odbiorcy
 */
async function createEndClient({ ownerUserId, organizationId, data }) {
  // Osoba prywatna bez NIP/NIP UE/numerów rejestrowych — `core/endClient.js`
  const entries = Object.entries(normalizeEndClientData(data) || {}).filter(([k]) => END_CLIENT_FIELDS.includes(k));
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
  // Zmiana typu na osobę prywatną czyści numery firmowe — `core/endClient.js`
  const entries = Object.entries(normalizeEndClientData(data) || {}).filter(([k]) => END_CLIENT_FIELDS.includes(k));
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
  // Płatnik i konto z contractors.txt (Tomek/Paweł 19.11.2026). `SELECT *`: kolumny są od migracji
  // `add_user_paymaster_bank.sql` — bez niej po prostu ich nie ma i faktura idzie jak dotąd.
  const { cleanValue, accountFromContractor, paymentDaysOf } = require('../core/contractorAccounts');
  const extra = ((await selectQuery('SELECT * FROM `user` WHERE id = ?', [order.u_id])) || [])[0] || {};
  const paymaster = cleanValue(extra.paymaster_ident);
  const payerRow = paymaster && paymaster.toUpperCase() !== String(order.u_ident || '').toUpperCase()
    ? ((await selectQuery('SELECT * FROM `user` WHERE ident = ? LIMIT 1', [paymaster])) || [])[0] || null
    : null;
  // Termin organizacji-nabywcy (poziom 1): jej konto w contractors.txt — ident konta = ident organizacji
  // (Cozy, LuxanGmbH; porównanie bez wielkości liter). Nie `invoice_organization_profile.default_payment_days`:
  // to termin, który organizacja daje swoim klientom (Paweł 20.11.2026)
  const orgIdent = orgs && orgs[0] && orgs[0].ident;
  const orgAccount = orgIdent ? ((await selectQuery('SELECT * FROM `user` WHERE ident = ? LIMIT 1', [orgIdent])) || [])[0] : null;

  return {
    order,
    orderItems,
    organization: (orgs && orgs[0]) || null,
    organizationPaymentDays: paymentDaysOf(orgAccount),
    // Dane płatnika na fakturę (`hierarchy.resolveParties`) — bez haseł i reszty konta
    payer: payerRow
      ? { ident: payerRow.ident, client_name: payerRow.client_name, tax_id: payerRow.tax_id, street: payerRow.street,
        city: payerRow.city, zip: payerRow.zip, country: payerRow.country, email: payerRow.email, phone: payerRow.phone }
      : null,
    user: {
      // Konto do wpłaty z contractors.txt: płatnika, a gdy go nie ma albo nie ma konta — klienta
      bankAccount: accountFromContractor(payerRow) || accountFromContractor(extra),
      // Termin z contractors.txt (PAYMENT_DAYS, 20.11.2026): płatnika, a bez niego klienta
      paymentDays: paymentDaysOf(payerRow) ?? paymentDaysOf(extra),
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
 * Wiersz szablonu po kodzie — BEZ zastępowania domyślnym (w przeciwieństwie do
 * `getTemplate`): przypisanie formatki musi wiedzieć, czy wiersz istnieje.
 *
 * @param {string} code
 * @returns {Promise<{ code: string, name: string, templateFile: string, stylesheet: string, backgroundFile: string|null, pageMargins: object|null }|null>}
 */
async function getTemplateRow(code) {
  const rows = await strictQuery('SELECT * FROM invoice_template WHERE code = ?', [code]);
  const row = rows[0];
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    templateFile: row.template_file,
    stylesheet: row.stylesheet,
    backgroundFile: row.background_file || null,
    pageMargins: parseJsonColumn(row.page_margins)
  };
}

/**
 * Ile dokumentów zapamiętało ten kod szablonu. Kod używany przez wystawione
 * faktury nie może zmienić formatki w miejscu — patrz `templateAssignment.js`.
 *
 * @param {string} code
 * @returns {Promise<number>}
 */
async function countInvoicesWithTemplate(code) {
  const rows = await strictQuery('SELECT COUNT(*) AS c FROM invoice WHERE template_code = ?', [code]);
  return Number(rows[0] && rows[0].c) || 0;
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
  HKL_SERIES,
  issuerSeriesKey,
  getIssuerProfile,
  getInvoiceSender,
  upsertIssuerProfile,
  createEndClient,
  getEndClientDefaultCountry,
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
  listInvoiceOverview,
  findAutoInvoiceCandidates,
  findInvoicesByNumbers,
  applyPayment,
  findInvoicesToRemind,
  findCollectiveCandidates,
  findDailyCandidates,
  hasLevelInvoice,
  findInvoicesToMail,
  findInvoicesForFtp,
  findInvoicesForEinvoice,
  getKsefStates,
  getEinvoiceSources,
  findInvoicedPositions,
  getTransportOrders,
  getTransportItems,
  findIssuedTransportInvoices,
  findTransportLines,
  getUserForInvoice,
  searchBlankBuyers,
  listBlankIssuers,
  recentBlankBuyers,
  listBlankInvoices,
  peekIssuerSequence,
  getOrderItemsForPrint,
  addInvoiceEvent,
  relationLevels,
  supportsInvoiceSchedule,
  getUserInvoiceSchedule,
  setUserInvoiceSchedule,
  allocateSequence,
  getOrganizationProfile,
  upsertOrganizationProfile,
  createInvoice,
  getInvoice,
  updateStatus,
  listInvoices,
  getAdvanceInvoicesForOrder,
  findDailyInvoices,
  findManualOverlay,
  findPreparedDraft,
  findPreparedDraftsReady,
  getInvoiceOrderIds,
  getRebuildSource,
  getInvoiceHistory,
  getEditBlockers,
  getOrderRelations,
  searchInvoices,
  findOrderInvoiceForEdit,
  updateInvoiceContent,
  getOrderInvoiceSource,
  getTemplate,
  listTemplates,
  upsertTemplate,
  getTemplateRow,
  countInvoicesWithTemplate,
  listOrganizationTemplates,
  runSchemaMigration
};
