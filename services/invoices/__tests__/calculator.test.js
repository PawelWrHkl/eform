'use strict';

/**
 * Testy kalkulatora i arytmetyki pieniężnej.
 * Bez bazy, bez sieci — czyste funkcje (`node --test`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../core/money');
const { InvoiceCalculator } = require('../core/calculator');
const { TaxCategory } = require('../domain/constants');

test('money: parsowanie kwot z formatów występujących w eForm', () => {
  assert.equal(money.toMinor(123.45), 12345);
  assert.equal(money.toMinor('584.00'), 58400);
  assert.equal(money.toMinor('1 234,56'), 123456);
  assert.equal(money.toMinor('718.32 €'), 71832);
  assert.equal(money.toMinor(null), 0);
  assert.equal(money.toMinor('brak'), 0);
});

test('money: zaokrąglenie half-up działa też dla kwot ujemnych (korekty)', () => {
  assert.equal(money.roundHalfUp(2.5), 3);
  assert.equal(money.roundHalfUp(-2.5), -3, 'korekta -2,5 gr musi iść na -3, nie na -2');
  assert.equal(money.percentOf(10050, 23), 2312, '100,50 × 23% = 23,115 → 23,12');
});

test('money: klasyczny błąd float nie przecieka do kwot', () => {
  // 0.1 + 0.2 !== 0.3 w IEEE 754 — w minor units to 10 + 20 = 30
  assert.equal(money.toMinor(0.1) + money.toMinor(0.2), money.toMinor(0.3));
});

test('calculator: pozycja z rabatem i stawką krajową', () => {
  const calc = new InvoiceCalculator({ currency: 'PLN', localCurrency: 'PLN' });
  const item = calc.calculateItem(
    { name: 'Roleta', unitPriceNet: 100, quantity: 3, discountPercent: 10, taxRate: 23 },
    1
  );

  assert.equal(item.netAmount, 27000, '3 × 100 zł − 10% = 270 zł');
  assert.equal(item.taxAmount, 6210, 'VAT 23% od 270 zł = 62,10 zł');
  assert.equal(item.grossAmount, 33210);
});

test('calculator: VAT zaokrąglany per grupa stawek, nie per pozycja', () => {
  const calc = new InvoiceCalculator({ currency: 'PLN', localCurrency: 'PLN' });
  // Trzy pozycje po 10,01 zł: VAT z każdej to 2,3023 zł → 2,30 po zaokrągleniu.
  // Suma z pozycji = 6,90; VAT od grupy (30,03) = 6,9069 → 6,91. Wiążąca jest grupa.
  const result = calc.calculate([
    { name: 'a', unitPriceNet: 10.01, taxRate: 23 },
    { name: 'b', unitPriceNet: 10.01, taxRate: 23 },
    { name: 'c', unitPriceNet: 10.01, taxRate: 23 }
  ]);

  const perItemSum = result.items.reduce((acc, i) => acc + i.taxAmount, 0);
  assert.equal(perItemSum, 690, 'suma VAT z pozycji: 3 × 2,30 zł');
  assert.equal(result.totalTax, 691, 'VAT z grupy stawek: 23% od 30,03 zł = 6,91 zł');
  assert.equal(result.totalNet, 3003);
  assert.equal(result.totalGross, 3694, 'brutto = netto grup + VAT grup');
});

test('calculator: osobne wiersze podsumowania dla różnych stawek i kategorii', () => {
  const calc = new InvoiceCalculator({ currency: 'PLN', localCurrency: 'PLN' });
  const result = calc.calculate([
    { name: 'towar', unitPriceNet: 1000, taxRate: 23, taxCategory: TaxCategory.STANDARD },
    { name: 'montaż', unitPriceNet: 200, taxRate: 8, taxCategory: TaxCategory.REDUCED },
    { name: 'wdt', unitPriceNet: 500, taxRate: 0, taxCategory: TaxCategory.INTRA_EU_GOODS }
  ]);

  assert.equal(result.taxLines.length, 3);
  assert.deepEqual(result.taxLines.map((l) => l.taxRate), [23, 8, 0], 'kolejność: najwyższa stawka pierwsza');

  const wdt = result.taxLines.find((l) => l.taxCategory === TaxCategory.INTRA_EU_GOODS);
  assert.equal(wdt.taxAmount, 0);
  assert.equal(wdt.legalNoteKey, 'legal.intra_eu_goods', 'kategoria zerowa nosi klucz adnotacji prawnej');
});

test('calculator: dwie kategorie o tej samej stawce 0% nie są łączone', () => {
  const calc = new InvoiceCalculator({ currency: 'EUR', localCurrency: 'PLN' });
  const result = calc.calculate([
    { name: 'wdt', unitPriceNet: 100, taxRate: 0, taxCategory: TaxCategory.INTRA_EU_GOODS },
    { name: 'eksport', unitPriceNet: 100, taxRate: 0, taxCategory: TaxCategory.EXPORT }
  ]);
  assert.equal(result.taxLines.length, 2, 'WDT i eksport to różne stany prawne, mimo tej samej stawki');
});

test('calculator: VAT przeliczony na walutę lokalną po kursie', () => {
  const calc = new InvoiceCalculator({
    currency: 'EUR',
    localCurrency: 'PLN',
    exchangeRate: { from: 'EUR', to: 'PLN', rate: 4.2637, date: '2026-08-04', source: 'NBP:149/A/NBP/2026' }
  });
  const result = calc.calculate([{ name: 'roleta', unitPriceNet: 1000, taxRate: 23 }]);

  assert.equal(result.totalTax, 23000, 'VAT 230,00 EUR');
  assert.equal(result.totalTaxLocal, 98065, '230 EUR × 4,2637 = 980,65 PLN');
});

test('calculator: brak kursu daje null, nie zero', () => {
  const calc = new InvoiceCalculator({ currency: 'EUR', localCurrency: 'PLN', exchangeRate: null });
  const result = calc.calculate([{ name: 'x', unitPriceNet: 100, taxRate: 23 }]);
  assert.equal(result.totalTaxLocal, null, 'null pozwala szablonowi wydrukować ostrzeżenie zamiast 0,00');
});

test('calculator: faktura końcowa odlicza zaliczki', () => {
  const advances = [{ totalGross: 30000 }, { totalGross: 12300 }];
  const settled = InvoiceCalculator.settleAdvances(advances);
  assert.equal(settled, 42300);

  const calc = new InvoiceCalculator({ currency: 'PLN', localCurrency: 'PLN' });
  const result = calc.calculate([{ name: 'całość', unitPriceNet: 1000, taxRate: 23 }], { advanceSettled: settled });

  assert.equal(result.totalGross, 123000);
  assert.equal(result.amountDue, 80700, 'do zapłaty = brutto 1230,00 − zaliczki 423,00');
});

test('calculator: korekta liczy delty względem dokumentu pierwotnego', () => {
  const before = { totalNet: 100000, totalTax: 23000, totalGross: 123000, taxLines: [] };
  const after = { totalNet: 80000, totalTax: 18400, totalGross: 98400, taxLines: [] };
  const { delta } = InvoiceCalculator.diff(before, after);

  assert.equal(delta.totalNet, -20000);
  assert.equal(delta.totalTax, -4600);
  assert.equal(delta.totalGross, -24600, 'korekta zmniejszająca ma ujemną deltę');
});

test('calculator: ilość ułamkowa (m²) nie gubi groszy', () => {
  const calc = new InvoiceCalculator({ currency: 'EUR', localCurrency: 'PLN' });
  const item = calc.calculateItem({ name: 'plisa', unitPriceNet: 89.9, quantity: 2.35, taxRate: 23 }, 1);
  assert.equal(item.netAmount, 21127, '2,35 m² × 89,90 = 211,265 → 211,27');
});

test('serwis: zamówienie o zerowej wartości nie tworzy dokumentu', async () => {
  const { InvoiceService } = require('../main');

  // Atrapy zamiast bazy — sprawdzamy wyłącznie regułę „nie wystawiamy 0,00".
  const repository = {
    async getOrderInvoiceSource() {
      return {
        order: { id: 1, organization_id: 3, order_idx: '999', status: 'sent' },
        // Realny przypadek z bazy: pozycje z zerową/NULL-ową ceną
        orderItems: [{ id: 1, total_price: '0.00', json_parameters: {} }, { id: 2, total_price: null, json_parameters: {} }],
        organization: { id: 3, name: 'HKL', country: 'PL' },
        user: { id: 9, client_name: 'Klient', country: 'PL' },
        groupShop: null
      };
    },
    async getOrganizationProfile() {
      return { organizationId: 3, orgCode: 'HKL', seller: { name: 'HKL', country: 'PL' }, localCurrency: 'PLN', defaultCurrency: 'EUR', defaultPaymentDays: 14, defaultLang: 'pl', templateCode: 'default', numberPatterns: {}, footerNotes: {} };
    },
    // v2: profil wystawcy dla poziomu (patrz `core/hierarchy.js`)
    async getIssuerProfile() {
      return {
        issuerType: 'organization', issuerId: 3, level: 2, name: 'HKL', country: 'PL',
        taxId: '955', registryNumbers: { NIP: '955' }, currency: 'EUR', localCurrency: 'PLN',
        paymentDays: 14, defaultLang: 'pl', templateCode: 'default', themeVars: {},
        numberPattern: '{YYYY}/{NR:5}', legalSettings: {}, footerNotes: {}
      };
    },
    async getAllocatedQuantities() { return new Map(); },
    async getEndClient() { return null; },
    async getAdvanceInvoicesForOrder() { return []; },
    async createInvoice() { throw new Error('createInvoice nie powinno zostać wywołane'); }
  };

  const service = new InvoiceService({ repository, log: () => {}, vies: { check: async () => ({ checked: false, valid: false }) } });

  await assert.rejects(
    () => service.createFromOrder({ orderId: 1 }),
    /zerową wartość netto/,
    'dokument na 0,00 musi zostać zablokowany'
  );
});

test('serwis: allowZeroTotal pozwala wymusić dokument na zero', async () => {
  const { InvoiceService } = require('../main');
  let saved = null;
  const repository = {
    async getOrderInvoiceSource() {
      return {
        order: { id: 1, organization_id: 3, order_idx: '999' },
        orderItems: [{ id: 1, total_price: '0.00', json_parameters: {} }],
        organization: { id: 3, name: 'HKL', country: 'PL' },
        user: { id: 9, client_name: 'Klient', country: 'PL' },
        groupShop: null
      };
    },
    async getOrganizationProfile() {
      return { organizationId: 3, orgCode: 'HKL', seller: { name: 'HKL', country: 'PL' }, localCurrency: 'PLN', defaultCurrency: 'EUR', defaultPaymentDays: 14, defaultLang: 'pl', templateCode: 'default', numberPatterns: {}, footerNotes: {} };
    },
    // v2: profil wystawcy dla poziomu (patrz `core/hierarchy.js`)
    async getIssuerProfile() {
      return {
        issuerType: 'organization', issuerId: 3, level: 2, name: 'HKL', country: 'PL',
        taxId: '955', registryNumbers: { NIP: '955' }, currency: 'EUR', localCurrency: 'PLN',
        paymentDays: 14, defaultLang: 'pl', templateCode: 'default', themeVars: {},
        numberPattern: '{YYYY}/{NR:5}', legalSettings: {}, footerNotes: {}
      };
    },
    async getAllocatedQuantities() { return new Map(); },
    async getEndClient() { return null; },
    async getAdvanceInvoicesForOrder() { return []; },
    async createInvoice(invoice) { saved = invoice; return { id: 5, number: null }; }
  };
  const service = new InvoiceService({ repository, log: () => {}, vies: { check: async () => ({ checked: false, valid: false }) } });

  const result = await service.createFromOrder({ orderId: 1, allowZeroTotal: true });
  assert.equal(result.id, 5);
  assert.equal(saved.totalGross, 0);
  assert.equal(saved.currency, 'EUR', 'waluta zawsze EUR — patrz DOCUMENT_CURRENCY');
});
