'use strict';

/**
 * Testy mapowania zamówień eForm na pozycje faktury.
 * Dane wejściowe odwzorowują realne wiersze `order_item` (klucze `json_parameters`
 * są zawsze polskie i kanoniczne: ILOSC, POW, SZEROKOSC, WYSOKOSC).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapOrderItemsToInvoiceItems,
  mapParties,
  resolveUnitAndQuantity,
  buildItemName,
  buildItemDescription
} = require('../core/orderMapper');
const { Unit, TaxCategory } = require('../domain/constants');

const standardTax = () => ({ taxCategory: TaxCategory.STANDARD, taxRate: 23 });

test('ilość to LICZBA SZTUK z ILOSC — nigdy m² ani mb', () => {
  // ⚠️ Żaden produkt nie jest rozliczany na metry: `POW` i wymiary to dane
  // techniczne konfiguracji. Wcześniej mapper drukował `POW × ILOSC` jako ilość,
  // przez co dokument przeczył alokacjom częściowego fakturowania (te zawsze
  // liczą `ILOSC`).
  const r = resolveUnitAndQuantity({ POW: 1.52, ILOSC: 2, SZEROKOSC: 1232, WYSOKOSC: 1232 }, 2);
  assert.equal(r.unit, Unit.PIECE);
  assert.equal(r.quantity, 2, 'dwie sztuki, nie 3,04 m²');
});

test('sama szerokość bez wysokości też daje sztuki (karnisze)', () => {
  const r = resolveUnitAndQuantity({ SZEROKOSC: 2400, ILOSC: 3 }, 3);
  assert.equal(r.unit, Unit.PIECE);
  assert.equal(r.quantity, 3, 'nie 7,2 mb');
});

test('brak ILOSC → fallback na amount, potem 1', () => {
  assert.equal(resolveUnitAndQuantity({}, 5).quantity, 5);
  assert.equal(resolveUnitAndQuantity({}, 0).quantity, 1);
});

test('parametr MONTAZ to kod uchwytu, NIE usługa montażu', () => {
  // Realne wartości z bazy: 297800, SPSCH, PCV, VS2SL, MP, 2, 307.
  // Traktowanie ich jako usługi przestawiało VAT z WDT na odwrotne obciążenie.
  for (const code of ['297800', 'SPSCH', 'PCV', 'VS2SL', 'MP', '2', '307', '']) {
    const r = resolveUnitAndQuantity({ MONTAZ: code, POW: 3, ILOSC: 1 }, 1);
    assert.equal(r.isInstallation, false, `MONTAZ=${code} nie może oznaczać usługi`);
    assert.equal(r.unit, Unit.PIECE, 'pozycja zostaje towarem liczonym w sztukach');
  }
});

test('pozycje zamówienia są zawsze towarem — usługi dokłada się jawnie', () => {
  const seen = [];
  mapOrderItemsToInvoiceItems({
    orderItems: [{ id: 1, total_price: '100.00', json_parameters: { MONTAZ: 'SPSCH', POW: 2, ILOSC: 1 } }],
    resolveTax: (opts) => { seen.push(opts); return standardTax(); }
  });
  assert.deepEqual(seen, [{ isService: false, isInstallation: false }]);
});

test('nazwa pozycji: własna nazwa → dział + grupa → dział', () => {
  assert.equal(buildItemName({ name: 'Roleta dzień-noc' }), 'Roleta dzień-noc');
  assert.equal(buildItemName({ name: '', department: 'PLISY', group_name: 'EOS' }), 'PLISY EOS');
  assert.equal(buildItemName({ department: 'ŻALUZJE' }), 'ŻALUZJE');
  assert.equal(buildItemName({}), 'Pozycja zamówienia');
});

test('nazwa pozycji: goły kod katalogowy dostaje kontekst działu i grupy', () => {
  // Realne dane: `order_item.name = '272116'`. Sam kod nie spełnia wymogu
  // „nazwa towaru lub usługi" na fakturze.
  assert.equal(buildItemName({ name: '272116', department: 'ROLETY', group_name: 'BB24' }), 'ROLETY BB24 272116');
  assert.equal(buildItemName({ name: '272116' }), '272116', 'bez działu i grupy zostaje sam kod');
  assert.equal(buildItemName({ name: 'Duette 32 mm', department: 'ROLETY' }), 'Duette 32 mm', 'nazwa z literami zostaje bez zmian');
});

test('opis pozycji: wymiary, wybrane parametry, referencja i komentarz', () => {
  const desc = buildItemDescription(
    { commision: 'Salon okno 1', comment: 'montaż od wewnątrz' },
    { SZEROKOSC: 1232, WYSOKOSC: 1500, MODEL: 'AO30', KOLOR: '2002-P20', DODATKI: '-' }
  );
  // Wymiary celowo NIE w opisie — mają własną kolumnę na dokumencie
  assert.doesNotMatch(desc, /1232×1500/);
  assert.match(desc, /MODEL: AO30/);
  assert.match(desc, /KOLOR: 2002-P20/);
  assert.match(desc, /Salon okno 1/);
  assert.match(desc, /montaż od wewnątrz/);
  assert.doesNotMatch(desc, /DODATKI/, 'wartości "-" są pomijane');
});

test('mapowanie: wartość netto pochodzi z wyceny pozycji, ilość jest informacyjna', () => {
  const items = mapOrderItemsToInvoiceItems({
    orderItems: [{
      id: 6945,
      department: 'PLISY',
      group_name: 'EOS',
      amount: 1,
      total_price: '584.00',
      total_price_sub: '520.00',
      json_parameters: { ILOSC: 1, POW: 1.52, SZEROKOSC: 1232, WYSOKOSC: 1232, MODEL: 'AO30' },
      orderpos: 1,
      asortment_group_number: '39'
    }],
    resolveTax: standardTax,
    currency: 'EUR'
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].unitPriceNetMinor, 58400, 'kwota z `total_price`, nie iloczyn m² × stawka');
  assert.equal(items[0].quantity, 1, 'kalkulator dostaje ilość 1 — cenniki progowe nie znoszą mnożenia');
  assert.equal(items[0].unit, Unit.PIECE);
  assert.equal(items[0].meta.displayQuantity, 1, 'na wydruku liczba sztuk z ILOSC');
  assert.equal(items[0].meta.area, 1.52, 'powierzchnia zostaje w meta jako dana techniczna');
  assert.equal(items[0].meta.asortmentGroup, '39');
  assert.equal(items[0].taxRate, 23);
  assert.equal(items[0].orderItemId, 6945);
});

test('mapowanie: tryb cen klienta bierze total_price_sub', () => {
  const items = mapOrderItemsToInvoiceItems({
    orderItems: [{ id: 1, total_price: '584.00', total_price_sub: '520.00', json_parameters: {} }],
    resolveTax: standardTax,
    currency: 'EUR',
    useSubPrices: true
  });
  assert.equal(items[0].unitPriceNetMinor, 52000);
});

test('mapowanie: json_parameters jako string JSON jest parsowany', () => {
  const items = mapOrderItemsToInvoiceItems({
    orderItems: [{ id: 1, total_price: '100.00', json_parameters: '{"ILOSC":3,"POW":0}' }],
    resolveTax: standardTax
  });
  assert.equal(items[0].meta.pieces, 3);
});

test('mapowanie: uszkodzony JSON nie wysadza mapowania', () => {
  const items = mapOrderItemsToInvoiceItems({
    orderItems: [{ id: 1, total_price: '100.00', json_parameters: '{zepsute' }],
    resolveTax: standardTax
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].unit, Unit.PIECE);
});

test('strony transakcji: organizacja jako sprzedawca, klient jako nabywca', () => {
  const { seller, buyer } = mapParties({
    organization: { name: 'HKL Sp. z o.o.', tax_id: 'PL1234567890', street: 'Długa 1', zip: '50-001', city: 'Wrocław', country: 'PL', company_mail: 'biuro@hkl.eu' },
    user: { client_name: 'Kunde GmbH', tax_id: 'DE123456789', street: 'Hauptstr. 5', zip: '10115', city: 'Berlin', country: 'DE', email: 'k@gmbh.de' }
  });

  assert.equal(seller.name, 'HKL Sp. z o.o.');
  assert.equal(seller.email, 'biuro@hkl.eu');
  assert.equal(buyer.name, 'Kunde GmbH');
  assert.equal(buyer.vatEuId, 'DE123456789', 'NIP klienta jest kandydatem na numer VAT-UE');
  assert.equal(buyer.country, 'DE');
});

test('strony transakcji: sklep grupowy z własnym NIP-em jest nabywcą', () => {
  const { buyer } = mapParties({
    organization: { name: 'HKL', country: 'PL' },
    user: { client_name: 'TCN centrala', tax_id: 'NL111', country: 'NL' },
    groupShop: { name: 'TCN Sklep Best', tax_id: 'NL999', street: 'Sportlaan 31', city: 'Best', country: 'NL' }
  });
  assert.equal(buyer.name, 'TCN Sklep Best');
  assert.equal(buyer.taxId, 'NL999', 'faktura idzie na dane rejestrowe sklepu, nie centrali');
});

test('strony transakcji: sklep bez danych rejestrowych nie przesłania klienta', () => {
  const { buyer } = mapParties({
    organization: { name: 'HKL', country: 'PL' },
    user: { client_name: 'Centrala', tax_id: 'NL111', country: 'NL' },
    groupShop: { id: 5, name: '', tax_id: null }
  });
  assert.equal(buyer.name, 'Centrala');
});
