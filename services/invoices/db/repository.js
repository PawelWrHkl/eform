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
      const numbering = new NumberingService({
        allocateSequence: (p) => allocateSequence(p, conn)
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

    const cur = invoice.currency;
    const [header] = await conn.query(
      `INSERT INTO invoice (
        organization_id, document_type, status, number, issue_date, sale_date, due_date,
        currency, local_currency, exchange_rate, exchange_rate_date, exchange_rate_source,
        seller_name, seller_tax_id, seller_vat_eu_id, seller_street, seller_zip, seller_city, seller_country,
        buyer_user_id, buyer_group_user_id, buyer_name, buyer_tax_id, buyer_vat_eu_id, buyer_vat_eu_verified,
        vies_checked_at, vies_valid,
        buyer_street, buyer_zip, buyer_city, buyer_country, buyer_email,
        total_net, total_tax, total_gross, total_tax_local, advance_settled, amount_due,
        payment_method, order_id, parent_invoice_id, corrected_invoice_id, correction_reason,
        lang, template_code, notes, legal_notes, created_by_pin
      ) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)`,
      [
        invoice.organizationId, invoice.documentType, invoice.status, number,
        invoice.issueDate, invoice.saleDate, invoice.dueDate,
        cur, invoice.localCurrency,
        invoice.exchangeRate?.rate ?? null, invoice.exchangeRate?.date ?? null, invoice.exchangeRate?.source ?? null,
        invoice.seller.name, invoice.seller.taxId || null, invoice.seller.vatEuId || null,
        invoice.seller.street || null, invoice.seller.zip || null, invoice.seller.city || null, invoice.seller.country || null,
        invoice.buyerUserId ?? null, invoice.buyerGroupUserId ?? null,
        invoice.buyer.name, invoice.buyer.taxId || null, invoice.buyer.vatEuId || null, invoice.buyerVatEuVerified ? 1 : 0,
        // Wynik VIES: `NULL` = nie sprawdzano, 0/1 = sprawdzono z tym rezultatem
        invoice.viesCheckedAt ? new Date(invoice.viesCheckedAt) : null,
        invoice.viesValid === null || invoice.viesValid === undefined ? null : (invoice.viesValid ? 1 : 0),
        invoice.buyer.street || null, invoice.buyer.zip || null, invoice.buyer.city || null,
        invoice.buyer.country || null, invoice.buyer.email || null,
        money.toMajor(invoice.totalNet, cur), money.toMajor(invoice.totalTax, cur), money.toMajor(invoice.totalGross, cur),
        invoice.totalTaxLocal == null ? null : money.toMajor(invoice.totalTaxLocal, invoice.localCurrency),
        money.toMajor(invoice.advanceSettled || 0, cur), money.toMajor(invoice.amountDue ?? invoice.totalGross, cur),
        invoice.paymentMethod || null, invoice.orderId ?? null, invoice.parentInvoiceId ?? null,
        invoice.correctedInvoiceId ?? null, invoice.correctionReason || null,
        invoice.lang || 'pl', invoice.templateCode || 'default', invoice.notes || null,
        invoice.legalNotes ? JSON.stringify(invoice.legalNotes) : null,
        invoice.createdByPin || null
      ]
    );
    const invoiceId = Number(header.insertId);

    for (const item of invoice.items || []) {
      await conn.query(
        `INSERT INTO invoice_item (
           invoice_id, position, name, description, unit, quantity, unit_price_net,
           discount_percent, net_amount, tax_category, tax_rate, tax_amount, gross_amount,
           order_item_id, meta
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          invoiceId, item.position, item.name, item.description || null, item.unit,
          item.meta?.displayQuantity ?? item.quantity,
          money.toMajor(item.unitPriceNet, cur), item.discountPercent || 0,
          money.toMajor(item.netAmount, cur), item.taxCategory, item.taxRate,
          money.toMajor(item.taxAmount, cur), money.toMajor(item.grossAmount, cur),
          item.orderItemId ?? null, item.meta ? JSON.stringify(item.meta) : null
        ]
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
      street: h.seller_street, zip: h.seller_zip, city: h.seller_city, country: h.seller_country
    },
    buyer: {
      name: h.buyer_name, taxId: h.buyer_tax_id, vatEuId: h.buyer_vat_eu_id,
      street: h.buyer_street, zip: h.buyer_zip, city: h.buyer_city,
      country: h.buyer_country, email: h.buyer_email
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
      meta: parseJsonColumn(r.meta) || {}
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
 * @param {number} [params.limit=50]
 * @param {number} [params.offset=0]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function listInvoices({ organizationId, status, documentType, orderId, limit = 50, offset = 0 }) {
  const where = ['organization_id = ?'];
  const values = [organizationId];
  if (status) { where.push('status = ?'); values.push(status); }
  if (documentType) { where.push('document_type = ?'); values.push(documentType); }
  if (orderId) { where.push('order_id = ?'); values.push(orderId); }
  values.push(Number(limit), Number(offset));

  const rows = await selectQuery(
    `SELECT id, number, document_type, status, issue_date, due_date, currency,
            total_net, total_tax, total_gross, amount_due, buyer_name, order_id
       FROM invoice
      WHERE ${where.join(' AND ')}
      ORDER BY issue_date DESC, id DESC
      LIMIT ? OFFSET ?`,
    values
  );
  return rows || [];
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
 * Szablon dokumentu po kodzie (z fallbackiem na `default`).
 * @param {string} code
 * @returns {Promise<{ code: string, templateFile: string, stylesheet: string, themeVars: object }>}
 */
async function getTemplate(code) {
  const rows = await selectQuery('SELECT * FROM invoice_template WHERE code = ? AND is_active = 1', [code || 'default']);
  const row = rows && rows[0];
  if (!row) return { code: 'default', templateFile: 'invoice-main.njk', stylesheet: 'styles/invoice.css', themeVars: {} };
  return {
    code: row.code,
    templateFile: row.template_file,
    stylesheet: row.stylesheet,
    themeVars: parseJsonColumn(row.theme_vars) || {}
  };
}

/**
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function listTemplates() {
  return (await selectQuery('SELECT code, name, template_file, stylesheet, is_active FROM invoice_template ORDER BY code', [])) || [];
}

/**
 * Uruchamia `db/schema.sql`. Wygodne przy pierwszym wdrożeniu i w testach
 * integracyjnych; produkcyjnie równoważne `mysql eform < schema.sql`.
 * @returns {Promise<{ executed: number }>}
 */
async function runSchemaMigration() {
  const sqlPath = path.join(__dirname, 'schema.sql');
  const raw = fs.readFileSync(sqlPath, 'utf8');
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
  runSchemaMigration
};
