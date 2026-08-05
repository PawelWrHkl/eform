'use strict';

/**
 * Model danych modułu jako JSDoc `@typedef`.
 *
 * Repo jest w CommonJS bez kroku kompilacji, a `jsconfig.json` w roocie włącza
 * sprawdzanie typów w edytorze — dlatego typowanie idzie przez JSDoc, a nie
 * przez `.ts`. Efekt w VS Code jest ten sam (podpowiedzi, błędy przy złym
 * kształcie obiektu), bez wprowadzania builda do projektu, który go nie ma.
 *
 * Plik nie eksportuje kodu wykonywalnego — same definicje typów.
 * Import w innym module: `/** @typedef {import('../domain/types').Invoice} Invoice *\/`
 *
 * KWOTY: wewnątrz modułu wszystkie kwoty są liczone w **groszach/centach**
 * (`number`, liczba całkowita) — patrz `core/money.js`. Do bazy i do szablonu
 * wychodzą już jako `DECIMAL(12,2)` / sformatowany string. Nigdy nie licz na
 * `float` w PLN — 0.1 + 0.2 to nie 0.3, a faktura musi się spinać co do grosza.
 */

/**
 * @typedef {'proforma'|'advance'|'final'|'invoice'|'correction'} DocumentTypeValue
 * @typedef {'draft'|'issued'|'paid'|'overdue'|'cancelled'|'corrected'} InvoiceStatusValue
 * @typedef {'standard'|'reduced'|'intra_eu_goods'|'intra_eu_service'|'export'|'np'|'zw'} TaxCategoryValue
 * @typedef {'szt'|'m2'|'mb'|'kpl'|'usl'|'godz'} UnitValue
 */

/**
 * Strona transakcji (sprzedawca albo nabywca) w postaci zdenormalizowanej.
 * ⚠️ Dane kontrahenta są **kopiowane** na fakturę w chwili wystawienia, a nie
 * wiązane referencją — zmiana adresu klienta w przyszłości nie może zmienić
 * treści dokumentu wystawionego rok temu.
 *
 * @typedef {Object} Party
 * @property {string} name
 * @property {string} [taxId]         NIP/VAT-ID w formacie krajowym.
 * @property {string} [vatEuId]       NIP-UE z prefiksem (np. `DE123456789`).
 * @property {string} [street]
 * @property {string} [zip]
 * @property {string} [city]
 * @property {string} country         ISO 3166-1 alpha-2 (`PL`, `DE`, `CH`).
 * @property {string} [email]
 * @property {string} [phone]
 */

/**
 * Dane bankowe sprzedawcy, drukowane w sekcji płatności.
 * @typedef {Object} BankAccount
 * @property {string} [bankName]
 * @property {string} iban
 * @property {string} [swift]
 * @property {string} [currency]      Waluta rachunku, jeśli inna niż dokumentu.
 */

/**
 * Pozycja faktury po wyliczeniu. Kwoty w minor units waluty dokumentu.
 *
 * @typedef {Object} InvoiceItem
 * @property {number} [id]
 * @property {number} position                Numer porządkowy (1..n).
 * @property {string} name                    Nazwa towaru/usługi na dokumencie.
 * @property {string} [description]           Doprecyzowanie (wymiary, kolor, model).
 * @property {UnitValue} unit
 * @property {number} quantity                Ilość (może być ułamkowa: 2.35 m²).
 * @property {number} unitPriceNet            Cena jednostkowa netto (minor units).
 * @property {number} [discountPercent]       Rabat procentowy (0–100).
 * @property {number} netAmount               Wartość netto po rabacie (minor units).
 * @property {TaxCategoryValue} taxCategory
 * @property {number} taxRate                 Stawka w % (23, 8, 0…).
 * @property {number} taxAmount               Kwota VAT (minor units).
 * @property {number} grossAmount             Wartość brutto (minor units).
 * @property {number} [orderItemId]           Powiązanie z `order_item.id` w eForm.
 * @property {Record<string, unknown>} [meta] Dane źródłowe (wymiary, grupa asort.).
 */

/**
 * Wiersz podsumowania VAT — jeden na każdą parę (stawka, kategoria).
 * ⚠️ VAT zaokrągla się **na poziomie grupy stawek**, nie pozycji ani dokumentu.
 *
 * @typedef {Object} TaxLine
 * @property {TaxCategoryValue} taxCategory
 * @property {number} taxRate
 * @property {number} netAmount
 * @property {number} taxAmount
 * @property {number} grossAmount
 * @property {string} [legalNoteKey]          Klucz i18n adnotacji (np. reverse charge).
 */

/**
 * Kurs waluty użyty do przeliczenia VAT na walutę lokalną sprzedawcy.
 * @typedef {Object} ExchangeRate
 * @property {string} from                    Waluta dokumentu (`EUR`).
 * @property {string} to                      Waluta lokalna sprzedawcy (`PLN`).
 * @property {number} rate                    Kurs (1 `from` = `rate` `to`).
 * @property {string} date                    Data kursu `YYYY-MM-DD`.
 * @property {string} source                  Np. `NBP:043/A/NBP/2026`.
 */

/**
 * Kompletny dokument — to jest obiekt, który trafia do kontekstu Nunjucks.
 *
 * @typedef {Object} Invoice
 * @property {number} [id]
 * @property {number} organizationId
 * @property {DocumentTypeValue} documentType
 * @property {InvoiceStatusValue} status
 * @property {string} [number]                Nadawany przy przejściu w `issued`.
 * @property {string} issueDate               `YYYY-MM-DD`
 * @property {string} saleDate                `YYYY-MM-DD` — data obowiązku podatkowego.
 * @property {string} dueDate                 `YYYY-MM-DD`
 * @property {string} currency                ISO 4217 waluty dokumentu.
 * @property {string} localCurrency           Waluta lokalna sprzedawcy (do podsumowania VAT).
 * @property {ExchangeRate} [exchangeRate]    Wymagany, gdy `currency !== localCurrency`.
 * @property {Party} seller
 * @property {Party} buyer
 * @property {BankAccount} [bankAccount]
 * @property {string} [paymentMethod]
 * @property {InvoiceItem[]} items
 * @property {TaxLine[]} taxLines
 * @property {number} totalNet
 * @property {number} totalTax
 * @property {number} totalGross
 * @property {number} [totalTaxLocal]         `totalTax` przeliczony na `localCurrency`.
 * @property {number} [advanceSettled]        Suma zaliczek odliczonych na fakturze końcowej.
 * @property {number} [amountDue]             Do zapłaty = brutto − zaliczki.
 * @property {number} [orderId]               Powiązanie z `order.id`.
 * @property {number} [correctedInvoiceId]    Dla `documentType='correction'`.
 * @property {string} [correctionReason]
 * @property {string} lang                    Język dokumentu (`pl`, `en`, `de`…).
 * @property {string} [templateCode]          Szablon organizacji; `default`, gdy brak.
 * @property {string} [notes]
 */

/**
 * Konfiguracja fakturowania organizacji (tabela `invoice_organization_profile`).
 *
 * @typedef {Object} OrganizationProfile
 * @property {number} organizationId
 * @property {string} [orgCode]               `organization.ident` — znacznik {ORG} w numeracji.
 * @property {Party} seller
 * @property {BankAccount|null} [bankAccount]
 * @property {string} localCurrency
 * @property {string} defaultCurrency
 * @property {number} defaultPaymentDays
 * @property {string} defaultLang
 * @property {string} [defaultPaymentMethod]
 * @property {string} templateCode
 * @property {Record<string, string>} [themeVars]  Zmienne CSS (kolor akcentu, font).
 * @property {Partial<Record<DocumentTypeValue, string>>} numberPatterns
 * @property {Record<string, string>} [footerNotes]  Klauzule KRS/CEIDG/RODO per język.
 * @property {string} [logoFile]              Nazwa pliku logo w `img/`.
 */

/**
 * Zależności wstrzykiwane do serwisów (DIP z SOLID) — dzięki temu testy
 * jednostkowe nie potrzebują bazy, sieci ani przeglądarki.
 *
 * @typedef {Object} InvoiceDeps
 * @property {import('./types').RepositoryLike} [repository]
 * @property {{ getRate: (from: string, to: string, date: string) => Promise<ExchangeRate> }} [currency]
 * @property {(msg: string, ...rest: unknown[]) => void} [log]
 * @property {() => Date} [now]
 */

/**
 * Minimalny kontrakt repozytorium — pozwala podmienić MySQL na cokolwiek innego.
 * @typedef {Object} RepositoryLike
 * @property {(id: number) => Promise<Invoice|null>} getInvoice
 * @property {(invoice: Invoice) => Promise<number>} createInvoice
 * @property {(id: number, patch: Partial<Invoice>) => Promise<boolean>} updateInvoice
 * @property {(organizationId: number) => Promise<OrganizationProfile|null>} getOrganizationProfile
 */

module.exports = {};
