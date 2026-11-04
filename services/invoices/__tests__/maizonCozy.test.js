'use strict';

/**
 * Faktura MaizonCozy (`render/maizonCozy.js`): kiedy wzór wchodzi, jak składa
 * pozycję z parametrów zamówienia i sumy — bez bazy i bez Chromium.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { appliesTo, buildData, priceLine, renderHtml } = require('../render/maizonCozy');

const params = {
  OPIS_POZYCJI: 'MODEL=BB24,STOF=30253-DP25,WYMIAROWANIE SLOPÓW=[object Object],BREEDTE [MM]=572',
  OPIS_CENY: 'LIJSTPRIJS [€] bruto=999', // cena HKL ze starych skryptów — nie może trafić na fakturę
  SUB___CENA: 197, SUB___CENA___TITLE: 'LIJSTPRIJS [€] bruto',
  SUB___DOPLATA: 0, SUB___DOPLATA___TITLE: 'TOESLAG [€]',
  SUB___CENA_RABAT: 0.6, SUB___CENA_RABAT___TITLE: 'LIJSTPRIJS RABAT',
  SUB___DOPLATA_RABAT: 0.3, SUB___DOPLATA_RABAT___TITLE: 'EXTRA KORTING',
  KOLOR_ALIAS___DESCRIPTION: 'PRIJSGROEP #E'
};

const invoice = {
  level: 2, issuerType: 'organization', documentType: 'invoice', number: '2026/00001',
  issueDate: '2026-11-03', dueDate: '2026-11-17', deliveryDate: '2026-11-03', paymentMethod: 'transfer',
  buyer: { name: 'Smit & Zonen', street: 'Hoornsewal 1', zip: '2635 CL', city: 'Den Hoorn', country: 'NL', vatEuId: 'NL855923945B01', email: 'a@b.nl' },
  items: [{ position: 1, name: 'PLISSÉGORDIJNEN EOS', orderItemId: 7, netAmount: 15760, meta: { displayQuantity: 2, priceBeforeDiscountMinor: 39400 } }],
  taxLines: [{ taxCategory: 'standard', taxRate: 21, netAmount: 15760, taxAmount: 3310 }],
  totalNet: 15760, totalGross: 19070
};
const orderItems = [{ id: 7, orderpos: 1, commision: 'slk achter', order_idx: '193', order_commision: 'Lipka', json_parameters: JSON.stringify(JSON.stringify(params)) }];

test('wzór tylko dla faktur Cozy → klient (poziom 2, wystawca Cozy)', () => {
  assert.equal(appliesTo({ invoice, profile: { orgCode: 'Cozy' } }), true);
  assert.equal(appliesTo({ invoice, profile: { orgCode: 'HKL' } }), false);
  assert.equal(appliesTo({ invoice: { ...invoice, level: 1 }, profile: { orgCode: 'Cozy' } }), false);
});

test('cennik z SUB___ (ceny Cozy), nie z OPIS_CENY', () => {
  assert.equal(priceLine(params), 'LIJSTPRIJS [€] bruto=197,LIJSTPRIJS RABAT=60.00%,EXTRA KORTING=30.00%');
});

test('pozycja: referencja EO/…, opis bez [object Object], kwoty nl, grupa cenowa', () => {
  const data = buildData(invoice, orderItems);
  assert.deepEqual(data.items[0], {
    pos: '1',
    lines: [
      'EO/193/1/Lipka-slk achter',
      'PLISSÉGORDIJNEN EOS MODEL=BB24,STOF=30253-DP25,BREEDTE [MM]=572',
      'LIJSTPRIJS [€] bruto=197,LIJSTPRIJS RABAT=60.00%,EXTRA KORTING=30.00%'
    ],
    qty: '2,00', catalog_price: '197,00', price: '78,80', amount: '157,60', price_group: 'E'
  });
  assert.deepEqual(data.totals, { net: '157,60 EUR', vat: [{ label: '21% BTW', amount: '33,10 EUR' }], gross_label: 'Totaal', gross: '190,70 EUR' });
  assert.deepEqual(data.notes, [
    'Wij verzoeken u het betreffende bedrag over te maken op onderstaande rekening.',
    'Op de goederen rust een verlengd eigendomsvoorbehoud.',
    'Factuurdatum komt overeen met leverdatum (verzenddatum)'
  ]);
});

test('korekta: Creditnota z numerem faktury pierwotnej, bez terminu płatności', () => {
  const data = buildData({ ...invoice, documentType: 'correction', correctionReason: 'Retour', amountDue: -19070 }, orderItems, '2026/00001');
  assert.equal(data.document.title, 'Creditnota');
  assert.equal(data.document.due_date, '');
  assert.equal(data.notes[0], 'Creditnota bij factuur 2026/00001. Het bedrag wordt verrekend of terugbetaald.');
  assert.equal(data.totals.gross, '-190,70 EUR');
});

test('HTML: nabywca escapowany, stopka z KvK i BTW', () => {
  const html = renderHtml(buildData(invoice, orderItems));
  assert.match(html, /Smit &amp; Zonen/);
  assert.match(html, /KvK 93574797/);
  assert.match(html, /NL866455139B01/);
});
