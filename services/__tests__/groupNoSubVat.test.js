'use strict';

/**
 * Grupa NIGDY nie widzi VAT-u cen klienta `SUB___` — ani konto podrzędne
 * (`group_user`), ani grupa-matka (`role = group`), także po kłódce „Pokaż cenę
 * po rabacie” (właściciel 2026-10-27). VAT cen zwykłych matki zostaje.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nunjucks = require('nunjucks');

const { dropSubVatForGroups } = require('../subPrices');

test('dropSubVatForGroups: rola grupy bez stawki i kwot VAT cen klienta; VAT cen zwykłych i inne role bez zmian', () => {
  const shop = dropSubVatForGroups({ subLocked: 110, vatRate: 23, subVat: '25.30', subGross: '135.30', regularVat: '1.00' }, true);
  assert.equal(shop.vatRate, undefined);
  assert.equal(shop.subVat, undefined);
  assert.equal(shop.subGross, undefined);
  assert.equal(shop.subLocked, 110, 'suma po rabacie zostaje');
  assert.equal(shop.regularVat, '1.00', 'VAT cen zwykłych to osobny tor');
  const other = dropSubVatForGroups({ vatRate: 23, subVat: '25.30', subGross: '135.30' }, false);
  assert.equal(other.subVat, '25.30');
});

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, '..', '..', 'templates')), { autoescape: true });
env.addGlobal('__', (key) => key);
env.addGlobal('gk', (key) => key);
env.addFilter('pdfValueParts', (v) => v);
env.addFilter('applyFactor', (value) => value);

function footer(context) {
  const html = env.render('order.njk', {
    orderDetails: { id: 1, order_idx: 7, status: 'active' }, orderItems: [], hidePrices: false, currencySuffix: '€',
    cleanOrderItems: [{ headers1: [], headers2: [], headerKeys1: [], headerKeys2: [], locked: [], sub: [],
      rows: [{ item: { id: 1, lockedParams: [], subParamValues: [], clientDiscountValues: [] }, row: { row1: {}, row2: {} } }] }],
    totalPrice: { visible: '100.00', hidden: '100.00', subVisible: 120, subLocked: 110, vatRate: 23, subVat: '25.30', subGross: '135.30' },
    hasSubPrices: true, discountPricesUnlocked: true, ...context
  });
  const start = html.indexOf("id='total-container'");
  return html.slice(start, html.indexOf('send-order-actions', start)).replace(/<[^>]+>/g, ' ');
}

test('stopka po kłódce: ani konto podrzędne, ani matka nie widzą VAT-u cen klienta (nawet gdy kwoty doszły)', () => {
  for (const role of [{ isGroupShop: true, isGroupClientType: true }, { isGroupShop: true }, { isGroup: true, isGroupClientType: true }, { isGroup: true }]) {
    const html = footer(role);
    assert.match(html, /order\.total_hidden/, `${JSON.stringify(role)}: suma po rabacie jest`);
    assert.doesNotMatch(html, /order\.total_vat|order\.total_gross_incl_vat/, JSON.stringify(role));
  }
  // Kontrola: klient organizacji spoza HKL (nie grupa) widzi VAT po kłódce jak dotąd
  const owner = footer({ hasSubPriceToggle: true, showCatalogPrices: true, prices: true });
  assert.match(owner, /order\.total_vat 23%/);
});
