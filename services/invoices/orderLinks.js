'use strict';

/**
 * Wejścia do edytora faktury z widoku zamówienia — admin i biuro (Paweł, 17.11.2026).
 * Etykiety z panelu faktur (`i18n/panel.json`), więc bez nowych kluczy w arkuszu
 * tłumaczeń. Link prowadzi do `/invoices/edit/order/:id?level=N`: edytor sam wybiera
 * przygotowany szkic, wystawioną fakturę (per zlecenie, potem dzienną) albo nowe
 * przygotowanie (`InvoiceService.resolveEditTarget`).
 */

const fs = require('fs');
const path = require('path');
const { canEditInvoices } = require('./access');

const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', 'panel.json'), 'utf8'));

/**
 * @param {Record<string, any>} req
 * @param {number} orderId
 * @param {{ repository?: any }} [deps]
 * @returns {Promise<Array<{ href: string, label: string }>>}
 */
async function invoiceEditLinks(req, orderId, deps = {}) {
  const user = req.session && req.session.user;
  if (!orderId || !canEditInvoices(user)) return [];
  const repository = deps.repository || require('./db/repository');
  const rel = await repository.getOrderRelations(Number(orderId));
  if (!rel) return [];
  const L = LABELS[(typeof req.getLocale === 'function' && req.getLocale()) || 'pl'] || LABELS.pl;
  const { HKL_ORG_ID } = require('../subPrices');
  const links = [];
  if (Number(rel.organizationId) !== Number(HKL_ORG_ID)) {
    links.push({ href: `/invoices/edit/order/${orderId}?level=1`, label: `${L.edit_order_link_l1} ${rel.orgIdent}` });
  }
  // Konto samej organizacji nie dostaje faktury „dla klienta” (AUTO_LEVEL_SQL[2])
  if (String(rel.userIdent).toUpperCase() !== String(rel.orgIdent).toUpperCase()) {
    links.push({ href: `/invoices/edit/order/${orderId}?level=2`, label: L.edit_order_link_l2 });
  }
  return links;
}

module.exports = { invoiceEditLinks };
