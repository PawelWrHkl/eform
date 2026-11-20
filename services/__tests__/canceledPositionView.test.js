// Pozycja anulowana w PROD przy zleceniu, które idzie dalej → „Anulowane” w podglądzie (Wiktoria 20.11.2026).
// `statuses[i].canceled` ustawia routes/orders.js (GET /history/order/:id) z prodProgress.canceledPositions.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const nunjucks = require('nunjucks');

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, '..', '..', 'templates')), { autoescape: true });
env.addGlobal('__', (key) => key);
env.addGlobal('gk', (key) => key);
env.addFilter('pdfValueParts', (v) => v);
env.addFilter('applyFactor', (value) => value);

const row = (id) => ({ item: { id, lockedParams: [], subParamValues: [], clientDiscountValues: [] }, row: { row1: {}, row2: {} } });

function statusRows(statuses) {
  const html = env.render('order_sent.njk', {
    orderDetails: { id: 1, order_idx: 7, status: 'sent' }, orderItems: [], hidePrices: false, currencySuffix: '€',
    cleanOrderItems: [{ headers1: [], headers2: [], headerKeys1: [], headerKeys2: [], locked: [], sub: [], rows: [row(11), row(12)] }],
    totalPrice: { visible: '1', hidden: '1' }, statuses
  });
  return [11, 12].map((id) => {
    const start = html.indexOf(`id='status-row-${id}'`);
    return html.slice(start, html.indexOf('</tr>', start)).replace(/<[^>]+>/g, ' ');
  });
}

test('podgląd wysłanego: pozycja anulowana w PROD ma „Anulowane”, pozostałe swój status', () => {
  const [first, second] = statusRows([{ status: '!sent!', shipping_date: '2026-11-02' }, { status: '!sent!', canceled: true }]);
  assert.match(first, /!sent!/);
  assert.doesNotMatch(first, /cancel_order\.status_canceled/);
  assert.match(second, /cancel_order\.status_canceled/);
  assert.doesNotMatch(second, /!sent!/);
});

test('podgląd wysłanego: pozycja anulowana bez wiersza statusu też ma „Anulowane”', () => {
  const [first, second] = statusRows([undefined, { canceled: true }]);
  assert.doesNotMatch(first, /cancel_order\.status_canceled/);
  assert.match(second, /cancel_order\.status_canceled/);
});

// Telefon (PRJ-06, 20.11): karta pozycji w wysłanym ma status z tego samego fragmentu, bez Duplikuj/Edytuj/Usuń.
test('podgląd wysłanego na telefonie: karta pozycji ma status zamiast akcji edycji', () => {
  const html = env.render('order_sent.njk', {
    orderDetails: { id: 1, order_idx: 7, status: 'sent' }, orderItems: [], hidePrices: false, currencySuffix: '€',
    cleanOrderItems: [{ headers1: [], headers2: [], headerKeys1: [], headerKeys2: [], locked: [], sub: [], rows: [row(11), row(12)] }],
    totalPrice: { visible: '1', hidden: '1' }, statuses: [{ status: '!sent!', shipping_date: '2026-11-02' }, { status: '!sent!', canceled: true }]
  });
  const list = html.slice(html.indexOf('mobile-items-list'), html.indexOf("id='total-container'"));
  const cards = list.split('class="mobile-item-card"').slice(1).map((c) => c.replace(/<[^>]+>/g, ' '));
  assert.strictEqual(cards.length, 2);
  assert.match(cards[0], /!sent!/);
  assert.match(cards[1], /cancel_order\.status_canceled/);
  assert.doesNotMatch(list, /order\.edit|order\.delete|order\.duplicate/);
  assert.match(html, /id='order-title-mobile'[^>]*>\s*history_order\.title/);
});
