'use strict';

/**
 * Testy hierarchii 3 poziomów, zgodności krajowej (PL/DE/NL/FR) i częściowego
 * fakturowania. Bez bazy i bez sieci.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { InvoiceLevel, IssuerType, BuyerType, resolveParties, getLevel, allowedLevelsForSession } = require('../core/hierarchy');
const { buildComplianceContext, buildRegistryRows } = require('../core/compliance');
const { orderedQuantity, availableQuantity, validateAllocations, allocatedNetAmount } = require('../core/allocations');
const { TaxCategory } = require('../domain/constants');

const manufacturerProfile = {
  name: 'HKL Production GmbH', taxId: 'DE111111111', vatEuId: 'DE111111111', country: 'DE',
  registryNumbers: { STEUERNUMMER: '151/815/08155', USTIDNR: 'DE111111111' }
};
const orgProfile = {
  name: 'HKL Dekoracja Okien Sp. z o.o.', taxId: '9551942642', vatEuId: 'PL9551942642', country: 'PL',
  registryNumbers: { NIP: '9551942642', REGON: '320000000' }
};
const userProfile = {
  name: 'Salon Firan Ewa', taxId: '8512345678', country: 'PL',
  registryNumbers: { NIP: '8512345678' }
};

const organization = { id: 3, name: 'HKL Dekoracja Okien Sp. z o.o.', tax_id: '9551942642', country: 'PL', city: 'Szczecin' };
const user = { id: 600, client_name: 'Salon Firan Ewa', tax_id: '8512345678', country: 'PL', city: 'Wrocław' };
const endClient = {
  id: 42, name: 'Jan Kowalski', client_type: 'person', country: 'PL',
  street: 'Kwiatowa 3', zip: '50-001', city: 'Wrocław', email: 'jan@example.com', registry_numbers: {}
};

/* ---------------------------------------------------------------- */
/* Hierarchia                                                        */
/* ---------------------------------------------------------------- */

test('poziom 1: producent → organizacja', () => {
  const r = resolveParties({
    level: InvoiceLevel.MANUFACTURER_TO_ORGANIZATION,
    issuerProfile: manufacturerProfile,
    context: { organization }
  });
  assert.equal(r.issuerType, IssuerType.MANUFACTURER);
  assert.equal(r.issuerId, 0, 'producent jest jeden — id stałe');
  assert.equal(r.buyerType, BuyerType.ORGANIZATION);
  assert.equal(r.buyerId, 3);
  assert.equal(r.seller.country, 'DE');
  assert.equal(r.buyer.name, 'HKL Dekoracja Okien Sp. z o.o.');
});

test('poziom 2: organizacja → użytkownik', () => {
  const r = resolveParties({
    level: InvoiceLevel.ORGANIZATION_TO_USER,
    issuerProfile: orgProfile,
    context: { organization, user }
  });
  assert.equal(r.issuerType, IssuerType.ORGANIZATION);
  assert.equal(r.issuerId, 3);
  assert.equal(r.buyerType, BuyerType.USER);
  assert.equal(r.buyerId, 600);
  assert.equal(r.buyer.name, 'Salon Firan Ewa');
});

test('poziom 3: użytkownik → odbiorca końcowy', () => {
  const r = resolveParties({
    level: InvoiceLevel.USER_TO_END_CLIENT,
    issuerProfile: userProfile,
    context: { organization, user, endClient }
  });
  assert.equal(r.issuerType, IssuerType.USER);
  assert.equal(r.issuerId, 600);
  assert.equal(r.buyerType, BuyerType.END_CLIENT);
  assert.equal(r.buyerId, 42);
  assert.equal(r.buyer.name, 'Jan Kowalski');
  assert.equal(r.buyer.clientType, 'person', 'osoba prywatna nie musi mieć NIP-u');
});

test('ta sama organizacja jest nabywcą na poziomie 1 i wystawcą na 2', () => {
  const l1 = resolveParties({ level: 1, issuerProfile: manufacturerProfile, context: { organization } });
  const l2 = resolveParties({ level: 2, issuerProfile: orgProfile, context: { organization, user } });
  assert.equal(l1.buyerId, l2.issuerId, 'ten sam podmiot, dwie różne role');
  assert.notEqual(l1.issuerType, l2.issuerType, 'dlatego identyfikacja to PARA (typ, id)');
});

test('brak danych nabywcy jest błędem, nie cichym pustym dokumentem', () => {
  assert.throws(
    () => resolveParties({ level: 3, issuerProfile: userProfile, context: { organization, user } }),
    /Brak danych nabywcy/
  );
});

test('nieznany poziom odrzucony', () => {
  assert.throws(() => getLevel(7), /Nieznany poziom fakturowania/);
});

test('poziomy dostępne dla roli z sesji', () => {
  // Każda rola ma DWIE relacje do wyboru — poza salonem, który ma tylko swoją.
  // Owner: swojemu użytkownikowi (2) albo odbiorcy końcowemu bezpośrednio (4).
  assert.deepEqual(allowedLevelsForSession({ isOwner: true }), [2, 4]);
  // Admin działa z poziomu HKL: do innej organizacji (1) albo do klienta HKL (2).
  assert.deepEqual(allowedLevelsForSession({ isAdmin: true }), [1, 2]);
  assert.deepEqual(allowedLevelsForSession({}), [3], 'salon fakturuje tylko odbiorców końcowych');
  // ⚠️ Owner NIE fakturuje poziomu 1 — sprzedaż do organizacji jest relacją HKL
  assert.equal(allowedLevelsForSession({ isOwner: true }).includes(1), false);
});

/* ---------------------------------------------------------------- */
/* Zgodność krajowa                                                  */
/* ---------------------------------------------------------------- */

test('PL: numery rejestrowe i przeliczenie VAT na PLN przy walucie obcej', () => {
  const ctx = buildComplianceContext({
    seller: { country: 'PL', taxId: '9551942642', registry: { REGON: '320000000' } },
    buyer: { country: 'PL', taxId: '8512345678' },
    taxLines: [{ taxCategory: TaxCategory.STANDARD, taxRate: 23 }],
    currency: 'EUR',
    localCurrency: 'PLN'
  });
  assert.equal(ctx.rateTable.label, 'VAT');
  assert.deepEqual(ctx.sellerRegistry.map((r) => `${r.label}=${r.value}`), ['NIP=9551942642', 'REGON=320000000']);
  assert.equal(ctx.requiresLocalVatAmount, true, 'faktura w EUR u polskiego wystawcy wymaga kwoty VAT w PLN');
  assert.equal(ctx.domestic, true);
});

test('PL: split payment tylko przy sprzedaży krajowej i włączonym ustawieniu', () => {
  const base = {
    seller: { country: 'PL', taxId: '955' },
    buyer: { country: 'PL', taxId: '851' },
    taxLines: [{ taxCategory: TaxCategory.STANDARD, taxRate: 23 }]
  };
  const on = buildComplianceContext({ ...base, legalSettings: { split_payment: true } });
  assert.ok(on.clauses.some((c) => c.id === 'pl_split_payment'));

  const off = buildComplianceContext(base);
  assert.equal(off.clauses.some((c) => c.id === 'pl_split_payment'), false);

  const foreign = buildComplianceContext({
    ...base,
    buyer: { country: 'DE', vatEuId: 'DE123456789' },
    legalSettings: { split_payment: true }
  });
  assert.equal(foreign.clauses.some((c) => c.id === 'pl_split_payment'), false, 'split payment to instrument krajowy');
});

test('DE: USt-IdNr., klauzula WDT po niemiecku i obowiązkowe Leistungsdatum', () => {
  const ctx = buildComplianceContext({
    seller: { country: 'DE', vatEuId: 'DE111111111', registry: { STEUERNUMMER: '151/815/08155' } },
    buyer: { country: 'NL', vatEuId: 'NL004148496B01' },
    taxLines: [{ taxCategory: TaxCategory.INTRA_EU_GOODS, taxRate: 0 }]
  });
  assert.equal(ctx.rateTable.label, 'USt.');
  assert.deepEqual(ctx.sellerRegistry.map((r) => r.label), ['Steuernummer', 'USt-IdNr.']);
  assert.ok(ctx.clauses.some((c) => c.text === 'Steuerfreie innergemeinschaftliche Lieferung.'));
  assert.equal(ctx.requiresDeliveryDate, true);
  assert.match(ctx.warnings.join(' '), /Leistungsdatum/, 'brak daty dostawy musi być zgłoszony');
});

test('DE: reverse charge ma niemieckie brzmienie', () => {
  const ctx = buildComplianceContext({
    seller: { country: 'DE', vatEuId: 'DE111' },
    buyer: { country: 'FR', vatEuId: 'FR222' },
    taxLines: [{ taxCategory: TaxCategory.INTRA_EU_SERVICE, taxRate: 0 }],
    deliveryDate: '2026-08-01'
  });
  assert.ok(ctx.clauses.some((c) => c.text === 'Steuerschuldnerschaft des Leistungsempfängers.'));
  assert.equal(ctx.warnings.length, 0, 'z datą dostawy i pełnymi numerami wystawcy nie ma ostrzeżeń');
});

test('NL: KVK i Btw-id, stawki 21/9/0', () => {
  const ctx = buildComplianceContext({
    seller: { country: 'NL', vatEuId: 'NL004148496B01', registry: { KVK: '12345678' } },
    buyer: { country: 'NL', taxId: 'NL999' },
    taxLines: [{ taxCategory: TaxCategory.STANDARD, taxRate: 21 }]
  });
  assert.deepEqual(ctx.rateTable.rates, ['21%', '9%', '0%']);
  assert.deepEqual(ctx.sellerRegistry.map((r) => `${r.label}=${r.value}`), ['KVK-nummer=12345678', 'Btw-identificatienummer=NL004148496B01']);
});

test('FR: SIREN/SIRET/NAF + obowiązkowe klauzule o karach i windykacji', () => {
  const ctx = buildComplianceContext({
    seller: { country: 'FR', vatEuId: 'FR40303265045', registry: { SIREN: '303265045', SIRET: '30326504500019', NAF: '4759B' } },
    buyer: { country: 'FR', taxId: 'FR123' },
    taxLines: [{ taxCategory: TaxCategory.STANDARD, taxRate: 20 }],
    legalSettings: { late_penalty_rate: '12 % par an' }
  });
  assert.deepEqual(ctx.sellerRegistry.map((r) => r.label), ['N° SIREN', 'N° SIRET', 'Code NAF/APE', 'N° TVA intracommunautaire']);
  assert.ok(ctx.clauses.some((c) => c.text === 'Indemnité forfaitaire pour frais de recouvrement : 40 €.'));
  assert.ok(ctx.clauses.some((c) => c.text === 'Taux des pénalités de retard : 12 % par an.'));
});

test('FR: zwolnienie 293 B tylko gdy włączone w profilu', () => {
  const args = {
    seller: { country: 'FR', vatEuId: 'FR40303265045', registry: { SIREN: '303265045' } },
    buyer: { country: 'FR' },
    taxLines: [{ taxCategory: TaxCategory.EXEMPT, taxRate: 0 }]
  };
  assert.equal(buildComplianceContext(args).clauses.some((c) => c.id === 'fr_vat_exempt_293b'), false);
  const exempt = buildComplianceContext({ ...args, legalSettings: { vat_exempt_293b: true } });
  assert.ok(exempt.clauses.some((c) => c.text === 'TVA non applicable, art. 293 B du CGI.'));
});

test('numery nabywcy w formacie JEGO kraju, bez pustych wierszy', () => {
  const ctx = buildComplianceContext({
    seller: { country: 'PL', taxId: '955' },
    buyer: { country: 'DE', vatEuId: 'DE123456789' },
    taxLines: [{ taxCategory: TaxCategory.INTRA_EU_GOODS, taxRate: 0 }]
  });
  // Steuernummer nabywcy nie jest znany → wiersz odfiltrowany, zostaje USt-IdNr.
  assert.deepEqual(ctx.buyerRegistry.map((r) => r.label), ['USt-IdNr.']);
  assert.equal(ctx.buyerRegistry[0].value, 'DE123456789');
});

test('brakujące numery NABYWCY nie generują ostrzeżeń', () => {
  // Wystawca nie ma obowiązku znać SIREN-u kontrahenta; o brak numeru VAT
  // przy transakcji wewnątrzwspólnotowej ostrzega `core/taxRules.js`.
  const ctx = buildComplianceContext({
    seller: { country: 'DE', vatEuId: 'DE111', registry: { STEUERNUMMER: '151/815/08155' } },
    buyer: { country: 'FR' },
    taxLines: [{ taxCategory: TaxCategory.INTRA_EU_GOODS, taxRate: 0 }],
    deliveryDate: '2026-08-01'
  });
  assert.equal(ctx.warnings.length, 0);

  const person = buildComplianceContext({
    seller: { country: 'PL', taxId: '955' },
    buyer: { country: 'PL', clientType: 'person' },
    taxLines: [{ taxCategory: TaxCategory.STANDARD, taxRate: 23 }]
  });
  assert.equal(person.warnings.length, 0, 'osoba prywatna nie ma NIP-u i to jest w porządku');
});

test('brak wymaganego numeru sprzedawcy jest zgłaszany', () => {
  const ctx = buildComplianceContext({
    seller: { country: 'NL' },
    buyer: { country: 'NL' },
    taxLines: []
  });
  assert.match(ctx.warnings.join(' '), /KVK-nummer sprzedawcy/);
});

test('buildRegistryRows uzupełnia numer VAT-UE z pola ogólnego', () => {
  const rows = buildRegistryRows({ vatEuId: 'DE123456789' }, 'DE', { asSeller: true });
  assert.equal(rows.find((r) => r.key === 'USTIDNR').value, 'DE123456789');
  assert.equal(rows.find((r) => r.key === 'USTIDNR').missing, false);
});

/* ---------------------------------------------------------------- */
/* Częściowe fakturowanie                                            */
/* ---------------------------------------------------------------- */

test('ilość zamówiona czytana z ILOSC, z fallbackiem na amount', () => {
  assert.equal(orderedQuantity({ json_parameters: { ILOSC: 3 }, amount: 1 }), 3);
  assert.equal(orderedQuantity({ json_parameters: '{"ILOSC":"5"}' }), 5, 'JSON jako string też');
  assert.equal(orderedQuantity({ amount: 4 }), 4, 'brak ILOSC → amount');
  assert.equal(orderedQuantity({}), 1);
});

test('dostępna ilość maleje o zafakturowane partie', () => {
  const item = { json_parameters: { ILOSC: 3 } };
  assert.deepEqual(availableQuantity({ orderItem: item }), { ordered: 3, invoiced: 0, available: 3, fullyInvoiced: false });
  assert.deepEqual(availableQuantity({ orderItem: item, alreadyInvoiced: 2 }), { ordered: 3, invoiced: 2, available: 1, fullyInvoiced: false });
  assert.equal(availableQuantity({ orderItem: item, alreadyInvoiced: 3 }).fullyInvoiced, true);
});

test('walidacja: nie można zafakturować więcej niż zamówiono', () => {
  const orderItems = new Map([[10, { id: 10, json_parameters: { ILOSC: 3 } }]]);
  const allocated = new Map([[10, 2]]);

  const ok = validateAllocations({ requested: [{ orderItemId: 10, quantity: 1 }], orderItemsById: orderItems, allocatedByOrderItem: allocated });
  assert.equal(ok.valid, true);
  assert.equal(ok.lines[0].remainingAfter, 0);

  const tooMuch = validateAllocations({ requested: [{ orderItemId: 10, quantity: 2 }], orderItemsById: orderItems, allocatedByOrderItem: allocated });
  assert.equal(tooMuch.valid, false);
  assert.match(tooMuch.errors[0], /próba zafakturowania 2 przy dostępnych 1/);
});

test('walidacja sumuje tę samą pozycję wielokrotnie w jednym żądaniu', () => {
  const orderItems = new Map([[10, { id: 10, json_parameters: { ILOSC: 3 } }]]);
  const result = validateAllocations({
    requested: [{ orderItemId: 10, quantity: 2 }, { orderItemId: 10, quantity: 2 }],
    orderItemsById: orderItems,
    allocatedByOrderItem: new Map()
  });
  assert.equal(result.valid, false, '2 + 2 > 3 mimo że każda partia osobno się mieści');
  assert.equal(result.lines.length, 1, 'pierwsza partia przechodzi, druga odrzucona');
});

test('walidacja odrzuca obcą pozycję i nieprawidłową ilość', () => {
  const orderItems = new Map([[10, { id: 10, json_parameters: { ILOSC: 3 } }]]);
  const alien = validateAllocations({ requested: [{ orderItemId: 99, quantity: 1 }], orderItemsById: orderItems, allocatedByOrderItem: new Map() });
  assert.match(alien.errors[0], /nie należy do tego zamówienia/);

  const zero = validateAllocations({ requested: [{ orderItemId: 10, quantity: 0 }], orderItemsById: orderItems, allocatedByOrderItem: new Map() });
  assert.match(zero.errors[0], /Nieprawidłowa ilość/);

  const empty = validateAllocations({ requested: [], orderItemsById: orderItems, allocatedByOrderItem: new Map() });
  assert.match(empty.errors[0], /Nie wskazano żadnej pozycji/);
});

test('kwoty partii sumują się do wartości pozycji co do grosza', () => {
  // 100,00 EUR za 3 szt. → 33,33 + 33,33 + 33,34 (reszta do ostatniej partii)
  const itemNetMinor = 10000;
  const first = allocatedNetAmount({ itemNetMinor, quantity: 1, ordered: 3 });
  const second = allocatedNetAmount({ itemNetMinor, quantity: 1, ordered: 3, alreadyInvoicedQty: 1, alreadyInvoicedMinor: first });
  const third = allocatedNetAmount({ itemNetMinor, quantity: 1, ordered: 3, alreadyInvoicedQty: 2, alreadyInvoicedMinor: first + second });

  assert.equal(first, 3333);
  assert.equal(second, 3333);
  assert.equal(third, 3334, 'ostatnia partia domyka groszową resztę');
  assert.equal(first + second + third, itemNetMinor);
});

test('jedna partia na całość daje pełną kwotę', () => {
  assert.equal(allocatedNetAmount({ itemNetMinor: 58400, quantity: 3, ordered: 3 }), 58400);
});

/* ---------------------------------------------------------------- */
/* Autoryzacja: kto może wystawić i zobaczyć dokument                */
/* ---------------------------------------------------------------- */

const { canIssueAtLevel, canAccessInvoice, scopeFromSession } = require('../http/session');

/** @param {Object} user */
const req = (user) => ({ session: { user } });

test('poziom 3 może wystawić ZWYKŁY użytkownik (salon)', () => {
  // Sedno funkcji: salon fakturuje swojego odbiorcę końcowego. Wcześniej cały
  // endpoint był za `requireOwner`, więc było to niewykonalne.
  const salon = req({ userId: 931, organization: 3 });
  assert.equal(canIssueAtLevel(salon, 3), true);
  assert.equal(canIssueAtLevel(salon, 2), false, 'poziom 2 to relacja organizacji');
  assert.equal(canIssueAtLevel(salon, 1), false);
});

test('rola wyznacza dostępne relacje — owner i admin fakturują co innego', () => {
  const owner = req({ userId: 600, orgId: 3, isOwner: true });
  assert.equal(canIssueAtLevel(owner, 2), true, 'owner → użytkownik organizacji');
  assert.equal(canIssueAtLevel(owner, 4), true, 'owner → odbiorca końcowy bezpośrednio');
  // ⚠️ Sprzedaż do organizacji to relacja HKL (admina), nie ownera; a poziom 3
  // ma sprzedawcę-salon, więc owner nie może wystawiać w cudzym imieniu.
  assert.equal(canIssueAtLevel(owner, 1), false);
  assert.equal(canIssueAtLevel(owner, 3), false);

  const admin = req({ userId: 1, orgId: 3, isAdmin: true });
  assert.equal(canIssueAtLevel(admin, 1), true, 'HKL → inna organizacja');
  assert.equal(canIssueAtLevel(admin, 2), true, 'HKL → własny klient');
  assert.equal(canIssueAtLevel(admin, 4), false);
});

test('admin ma dostęp niezależnie od organizacji na dokumencie', () => {
  // ⚠️ Admin PRZEŁĄCZA kontekst organizacji (`/set-organization/:id`). Gdyby
  // dostęp zawężać do bieżącego kontekstu, przełączenie odcinałoby go od
  // faktur, które sam wystawił — w tym od poziomu 1, zapisanego w kontekście
  // organizacji-NABYWCY.
  const admin = req({ userId: 1, orgId: 3, isAdmin: true });
  assert.equal(canAccessInvoice(admin, { organizationId: 7, issuerType: 'manufacturer', issuerId: 0 }), true);
  assert.equal(canAccessInvoice(admin, { organizationId: 7, issuerType: 'organization', issuerId: 7 }), true);
});

test('kontekst organizacji: admin bierze przełączoną, owner swoją macierzystą', () => {
  const { organizationIdFromSession } = require('../http/session');
  // Sesje dokładnie takie, jakie buduje `services/authService.js`
  const adminHkl = req({ userId: 1, organization: 'HKL', orgId: 3, isAdmin: true, isOwner: true });
  const adminSwitched = req({ userId: 1, organization: '5', orgId: 3, isAdmin: true, isOwner: true });
  const owner = req({ userId: 600, organization: 'HKL', orgId: 3, isOwner: true });

  assert.equal(organizationIdFromSession(adminHkl), 3);
  // ⚠️ Sedno: po `/set-organization/5` admin fakturuje i wyszukuje w organizacji 5
  assert.equal(organizationIdFromSession(adminSwitched), 5);
  // Owner ma w `organization` IDENT tekstowy — musi ustąpić `orgId`
  assert.equal(organizationIdFromSession(owner), 3);
});

test('salon widzi wyłącznie dokumenty, które sam wystawił', () => {
  const salon = req({ userId: 931, organization: 3 });
  const own = { organizationId: 3, issuerType: 'user', issuerId: 931 };
  const otherSalon = { organizationId: 3, issuerType: 'user', issuerId: 999 };
  const orgDoc = { organizationId: 3, issuerType: 'organization', issuerId: 3 };

  assert.equal(canAccessInvoice(salon, own), true);
  assert.equal(canAccessInvoice(salon, otherSalon), false, 'cudzy dokument w tej samej organizacji — nie');
  assert.equal(canAccessInvoice(salon, orgDoc), false, 'dokument organizacji nie jest jego');
});

test('owner widzi wszystko w swojej organizacji, ale nie w innej', () => {
  const owner = req({ userId: 600, orgId: 3, isOwner: true });
  assert.equal(canAccessInvoice(owner, { organizationId: 3, issuerType: 'user', issuerId: 931 }), true);
  assert.equal(canAccessInvoice(owner, { organizationId: 5, issuerType: 'organization', issuerId: 5 }), false);
});

test('⚠️ brak pól hierarchii w dokumencie = brak dostępu dla salonu', () => {
  // Regresja: `getInvoice` nie mapował `issuer_type`/`issuer_id`, więc salon
  // dostawał 403 na własnej fakturze (PDF i podgląd).
  const salon = req({ userId: 931, organization: 3 });
  assert.equal(canAccessInvoice(salon, { organizationId: 3 }), false);
});

test('zakres sesji rozpoznaje kształt danych ownera i klienta', () => {
  // Owner ma `organization` jako IDENT tekstowy i `orgId` numeryczny
  assert.deepEqual(scopeFromSession(req({ userId: 600, organization: 'HKL', orgId: 3, isOwner: true })),
    { isOrgScope: true, organizationId: 3, userId: 600 });
  // Zwykły użytkownik ma `organization` numeryczne
  assert.deepEqual(scopeFromSession(req({ userId: 931, organization: 3 })),
    { isOrgScope: false, organizationId: 3, userId: 931 });
});

/* ---------------------------------------------------------------- */
/* Adres dostawy na fakturze                                         */
/* ---------------------------------------------------------------- */

const { buildDeliveryAddress } = require('../main');

const clientWithDelivery = {
  street: 'Hauptstr. 5', zip: '10115', city: 'Berlin', country: 'DE',
  delivery_name: 'Budowa Zehlendorf', delivery_street: 'Clayallee 100',
  delivery_zip: '14195', delivery_city: 'Berlin', delivery_country: 'DE'
};

test('adres dostawy domyślnie NIE trafia na fakturę', () => {
  // Samo wpisanie adresu w kartotece nie może zmieniać wyglądu dokumentu —
  // decyduje checkbox `print_delivery_address` przy odbiorcy.
  assert.equal(buildDeliveryAddress({ ...clientWithDelivery, print_delivery_address: 0 }), null);
});

test('zaznaczony checkbox drukuje adres dostawy', () => {
  const address = buildDeliveryAddress({ ...clientWithDelivery, print_delivery_address: 1 });
  assert.equal(address.street, 'Clayallee 100');
  assert.equal(address.name, 'Budowa Zehlendorf');
  assert.equal(address.country, 'DE');
});

test('parametr API nadpisuje flagę odbiorcy w obie strony', () => {
  assert.ok(buildDeliveryAddress({ ...clientWithDelivery, print_delivery_address: 0 }, { force: true }));
  assert.equal(buildDeliveryAddress({ ...clientWithDelivery, print_delivery_address: 1 }, { force: false }), null);
});

test('adres identyczny z rejestrowym nie jest drukowany drugi raz', () => {
  const same = {
    street: 'Rynek 1', zip: '61-772', city: 'Poznań', country: 'PL',
    delivery_street: 'Rynek 1', delivery_zip: '61-772', delivery_city: 'Poznań', delivery_country: 'PL',
    print_delivery_address: 1
  };
  assert.equal(buildDeliveryAddress(same), null);
});

test('pusty adres dostawy nie tworzy pustej sekcji', () => {
  assert.equal(buildDeliveryAddress({ street: 'Rynek 1', print_delivery_address: 1 }), null);
});
