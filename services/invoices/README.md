# Moduł fakturowania (`services/invoices`)

Wystawianie i renderowanie dokumentów księgowych dla zamówień eForm: proforma,
faktura zaliczkowa, końcowa, zwykła VAT i korygująca. Multi-tenancy per
organizacja, transakcje krajowe/UE/eksport, waluty obce z kursem NBP, szablony
Nunjucks → PDF (Playwright).

## Stack i decyzje projektowe

Moduł jest pisany w stacku, w którym realnie działa eForm, a nie w stacku
„domyślnym dla nowego projektu":

| Obszar | Wybór | Dlaczego |
|---|---|---|
| Język | CommonJS + JSDoc `@typedef` | Repo nie ma kroku kompilacji; `jsconfig.json` daje pełne podpowiedzi i błędy typów w edytorze bez wprowadzania builda TS |
| Baza | MySQL (istniejąca baza `eform`) | Moduł czyta zamówienia (`order`, `order_item`) i klientów w tej samej transakcyjnej bazie; osobny Postgres wymagałby synchronizacji danych |
| Waluta | **wyłącznie EUR** (`DOCUMENT_CURRENCY` w `main.js`) | Cała sprzedaż jest w EUR; wybór waluty per dokument mnożyłby stany do przetestowania (kursy, niespójność zaliczka↔końcowa). Parametr `currency` w API jest ignorowany |
| Kwoty | liczby całkowite (grosze/centy) | `0.1 + 0.2 !== 0.3` — faktura musi spinać się co do grosza (`core/money.js`) |
| Stawki VAT | ponowne użycie `services/vatCalculator.js` | Tabela 27 państw UE + CH/NO już istnieje i jest utrzymywana; duplikat rozjechałby się przy pierwszej zmianie stawki |
| PDF | Playwright/Chromium jak w `mailBot/pdfGenerator.js` | Ta sama instalacja przeglądarki, te same flagi — bez drugiej zależności w obrazie Dockera |

## Architektura

Zależności zawsze do środka (Clean Architecture):

```
http/routes.js         kontrolery HTTP — walidacja wejścia, kody odpowiedzi
      ↓
main.js                InvoiceService — przypadki użycia, orkiestracja
      ↓
core/*                 czysta logika, zero I/O:
                         money.js        arytmetyka w minor units
                         taxRules.js     krajowa / WDT / reverse charge / eksport
                         calculator.js   pozycje → VAT per grupa stawek → sumy
                         numbering.js    wzorce numeracji + okresy licznika
                         statuses.js     maszyna stanów dokumentu
                         currency.js     kursy NBP (provider wstrzykiwany)
                         orderMapper.js  order/order_item → pozycje faktury
      ↓
db/repository.js       jedyne miejsce z SQL-em
render/renderer.js     Nunjucks → HTML → PDF
```

Struktura plików:

```
services/invoices/
├── main.js                      publiczne API modułu (fasada + re-eksport rdzenia)
├── domain/
│   ├── constants.js             DocumentType, InvoiceStatus, TaxCategory, Unit
│   └── types.js                 model danych jako JSDoc @typedef
├── core/                        (patrz wyżej)
├── db/
│   ├── schema.sql               DDL MySQL (idempotentny)
│   └── repository.js            CRUD, transakcje, atomowa numeracja
├── render/renderer.js           środowisko Nunjucks + PDF
├── templates/
│   ├── invoice-main.njk         szablon główny (składa komponenty)
│   ├── partials/                header, seller_buyer, items_table,
│   │                            vat_summary, payment, footer
│   └── styles/invoice.css       arkusz + zmienne motywu
├── i18n/{pl,en,de}.json         słowniki dokumentu
├── examples/invoice-payload.json pełny kontekst przekazywany do szablonu
└── __tests__/                   54 testy (node:test, bez bazy i sieci)
```

## Instalacja

```bash
# 1. Schemat bazy (idempotentny — można puszczać wielokrotnie)
mysql -h "$DATABASE_HOST" -P "$DATABASE_PORT" -u "$DATABASE_USER" -p"$DATABASE_PASSWORD" eform \
  < services/invoices/db/schema.sql
# albo z Node: require('./services/invoices/db/repository').runSchemaMigration()

# 2. Montowanie API w server.js
#    app.use('/api/v1/invoices', require('./services/invoices/http/routes'));

# 3. Testy
node --test services/invoices/__tests__/*.test.js
```

Tabele: `invoice`, `invoice_item`, `invoice_tax_line`, `invoice_sequence`,
`invoice_template`, `invoice_tax_rate`, `invoice_organization_profile`,
`invoice_event`. Żadna istniejąca tabela nie jest modyfikowana.

## API

Wszystkie endpointy wymagają zalogowania i uprawnień owner/admin
(`middleware/loginMixture.js`), a odczyt dodatkowo sprawdza, czy dokument należy
do organizacji z sesji.

| Metoda | Ścieżka | Opis |
|---|---|---|
| POST | `/api/v1/invoices/from-order/:orderId` | Dokument z zamówienia. Body: `documentType`, `issue`, `currency`, `lang`, `vatEuVerified`, `useSubPrices`, `advancePercent`, `serviceItems`, `saleDate`, `notes` |
| POST | `/api/v1/invoices/:id/issue` | Wystawienie szkicu — nadanie numeru |
| POST | `/api/v1/invoices/:id/status` | Zmiana statusu (`paid`, `cancelled`, `overdue`) |
| POST | `/api/v1/invoices/:id/correction` | Korekta. Body: `items` (stan po), `reason` |
| GET | `/api/v1/invoices/:id` | Dokument w JSON |
| GET | `/api/v1/invoices/:id/preview` | Podgląd HTML |
| GET | `/api/v1/invoices/:id/pdf` | PDF (`?download=1` wymusza zapis) |
| GET | `/api/v1/invoices` | Lista organizacji (`status`, `documentType`, `orderId`, `limit`, `offset`) |
| GET | `/api/v1/invoices/templates/list` | Dostępne szablony |
| GET/PUT | `/api/v1/invoices/profile/current` | Profil fakturowania organizacji |

Przykład:

```bash
# Faktura VAT z zamówienia + jawnie dołożona usługa montażu
curl -X POST http://localhost:8000/api/v1/invoices/from-order/2912 \
  -H 'Content-Type: application/json' \
  -d '{
        "documentType": "invoice",
        "currency": "EUR",
        "lang": "pl",
        "issue": true,
        "vatEuVerified": true,
        "serviceItems": [
          { "name": "Usługa montażu u klienta", "netAmount": 300, "quantity": 2, "isInstallation": true }
        ]
      }'
```

## Reguły podatkowe

`core/taxRules.js` rozstrzyga w tej kolejności:

1. **Krajowa** (ten sam kraj) → stawka krajowa; montaż w PL → 8% (stawka obniżona).
2. **Poza UE** → eksport, 0%.
3. **Oba kraje w UE i różne** → **0%**: towar jako WDT, usługa jako odwrotne
   obciążenie. Decyduje **para krajów** (`organization.country` vs `user.country`) —
   dokładnie ta sama reguła, którą stosuje `services/vatCalculator.js` w całej aplikacji.

Kategoria, nie sama stawka, decyduje o adnotacji na dokumencie — 0% przy WDT i 0%
przy eksporcie to różne stany prawne.

### VIES

Numer VAT-UE nabywcy jest sprawdzany w VIES (`core/vies.js`, REST API Komisji
Europejskiej) **automatycznie** przy tworzeniu dokumentu — ale tylko wtedy, gdy ma
to sens: kraje są różne, oba w UE, a nabywca ma numer. Sprzedaż krajowa nie
generuje zapytania.

⚠️ Wynik **nie warunkuje stawki** (o niej decyduje para krajów) — jest zapisywany
na dokumencie jako dowód należytej staranności: `buyer_vat_eu_verified`,
`vies_checked_at`, `vies_valid`. Awaria lub timeout VIES nigdy nie blokuje
wystawienia faktury: dokument powstaje, a w logu ląduje ostrzeżenie.
Sterowanie z API: `vatEuVerified: true|false` nadpisuje ręcznie, `skipVies: true`
pomija sprawdzenie.

## Panel ownera

`/invoices` (widok listy + tworzenie dokumentu) i `/invoices/profile` (dane do
faktur). Dostęp: `requireLogin` + `requireOwner`. Widoki renderuje
`http/panel.js`, a wszystkie akcje idą przez REST API — strona nie ma własnej
logiki biznesowej.

- Lista zamówień do zafakturowania pokazuje kierunek transakcji (`PL→NL`) i
  podpowiedź, jaka wyjdzie stawka. Zamówienia z samą zaliczką **zostają** na
  liście (z oznaczeniem `⬤ kwota`), bo czekają na fakturę końcową.
- Akcje w wierszu: podgląd HTML, PDF, wystawienie szkicu, oznaczenie zapłaty, anulowanie.
- Etykiety panelu siedzą w `i18n/panel.json` i są wstrzykiwane do szablonu jako
  `L`. ⚠️ Świadomie NIE w `locales/*.json` aplikacji: te są czytane z
  `/mnt/eform/languages` (mount kontenera synchronizowany z panelu admina), więc
  klucze dodane w repo nie dotarłyby do działającej instancji.

## Punkty rozszerzeń

| Chcę… | Zrób to tutaj |
|---|---|
| Własny szablon dla organizacji | Kopia `templates/invoice-main.njk` + wiersz w `invoice_template` + `template_code` w profilu |
| Zmienić kolory/font | `theme_vars` w profilu organizacji (CSS custom properties, walidowane w `renderer.buildThemeCss`) |
| Nowy język | `i18n/<kod>.json` + wpis w `renderer.SUPPORTED_LANGS` (test pilnuje kompletności kluczy) |
| Inne źródło kursów (EBC, własna tabela) | Klasa z metodą `fetchRate(currency, isoDate)` przekazana do `CurrencyConverter` |
| Nowy wzorzec numeracji | `number_patterns` w profilu; znaczniki `{YYYY} {YY} {MM} {DD} {NR} {NR:n} {ORG} {TYPE}` |
| Nowa kategoria podatkowa | `domain/constants.js` (+ `LEGAL_NOTE_KEYS`) i gałąź w `core/taxRules.js` |
| Faktura z innego źródła niż zamówienie | Drugi mapper obok `core/orderMapper.js` — rdzeń przyjmuje neutralne `RawItem[]` |
| Dołożyć usługę (montaż, szycie, transport) | `serviceItems` w `createFromOrder`; `isInstallation: true` kwalifikuje do stawki obniżonej |
| Stawka obniżona w innym kraju | `REDUCED_RATES_BY_COUNTRY` w `core/taxRules.js` |

## Świadome ograniczenia

- **0% także bez potwierdzenia w VIES.** Formalnie WDT wymaga ważnego numeru
  VAT-UE nabywcy; tu o stawce decyduje para krajów, a brak numeru lub brak
  potwierdzenia daje tylko ostrzeżenie w logu (`Nabywca z UE bez numeru VAT-UE…`).
  Świadoma decyzja — spójna z `services/vatCalculator.js`, który tak liczy VAT
  w całej aplikacji.
- **Brak obsługi progu OSS** (10 000 EUR sprzedaży wysyłkowej B2C do UE) —
  przy sprzedaży do konsumenta z UE po przekroczeniu progu obowiązuje stawka kraju
  konsumenta; moduł stosuje 0% jak dla B2B.
- **Kursy tylko na PLN** — `CurrencyConverter` (tabela A NBP) przelicza kwotę VAT
  na walutę lokalną sprzedawcy. Przy sprzedaży wewnątrzwspólnotowej VAT wynosi 0,
  więc przelicznik pracuje realnie tylko dla sprzedaży krajowej w EUR.
- **Zaliczka przy mieszanych stawkach** dziedziczy stawkę pierwszej pozycji
  zamówienia i loguje ostrzeżenie — rozbicie zaliczki proporcjonalnie na stawki
  jest decyzją księgową, nie techniczną.
- **Pozycje zamówienia są traktowane jako TOWAR, nigdy jako usługa.** W
  `json_parameters` nie istnieje flaga „usługa montażu": parametr `MONTAZ` to kod
  sposobu montażu (rodzaj uchwytu). Rozkład wartości w produkcyjnej bazie:
  `297800` ×323, `SPSCH` ×426, `PCV` ×134, `VS2SL` ×107, `MP` ×106, `2` ×987,
  `307` ×761, `''` ×430 — w PDF-ie widoczne jako „MONTAŻ: 297800 — Uchwyt
  uniwersalny EOS". Pierwsza wersja mappera traktowała niepuste `MONTAZ` jako
  usługę, co klasyfikowało prawie każdą pozycję jako usługę i przestawiało
  opodatkowanie z WDT (towar, 0%) na odwrotne obciążenie dla usług — czyli
  podawało na fakturze zły stan prawny. Usługi dokłada się teraz **jawnie**
  przez `serviceItems`.
- **Ilość w m²/mb jest informacyjna.** Wartość netto pozycji pochodzi z wyceny
  silnika formularzy (`order_item.total_price`), bo cenniki tej branży są
  progowe — iloczyn „m² × cena jednostkowa" dałby inną kwotę niż realna wycena.
- **`invoice_tax_rate` nie jest jeszcze czytana w runtime** — stawki biorą się z
  `services/vatCalculator.js`. Tabela jest przygotowana pod nadpisania per
  organizacja i wersjonowanie stawek w czasie.
