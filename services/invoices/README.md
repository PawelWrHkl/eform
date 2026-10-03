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
| Orientacja | **A4 poziomo** (`landscape: true`) | Tabela pozycji niesie 9 kolumn (nr zamówienia, wymiary, ilość, j.m., netto, stawka, VAT, brutto) — w pionie robiły się nieczytelnie wąskie. Układ jest pod to zbudowany: strony transakcji i adres dostawy w jednym pasie, podsumowanie VAT obok sum, płatność obok podpisów |

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

## Hierarchia 3 poziomów (v2)

| Poziom | Wystawca | Nabywca | Profil wystawcy | Seria numeracji |
|---|---|---|---|---|
| 1 | Producent | Organizacja (dystrybutor) | `invoice_issuer_profile` (`manufacturer#0`) | własna |
| 2 | Organizacja | Użytkownik (salon) | `invoice_issuer_profile` (`organization#id`) | własna |
| 3 | Użytkownik (salon) | Odbiorca końcowy | `invoice_issuer_profile` (`user#id`) | własna |

⚠️ Ten sam podmiot występuje na dwóch poziomach w różnych rolach (organizacja
jest nabywcą na 1 i wystawcą na 2), dlatego identyfikacja to zawsze **para
`(typ, id)`**, nigdy samo id. Numer jest unikalny w serii wystawcy
(`uq_issuer_number`), a nie w organizacji — inaczej poziom 2 i 3 kolidowałyby
tym samym `2026/00001`.

**Numeracja:** `{YYYY}/{NR:5}` → `2026/00001`, licznik zerowany 1 stycznia,
odizolowany per (wystawca, poziom, rok) w `invoice_issuer_sequence`. Rezerwacja
numeru jest atomowa (`INSERT … ON DUPLICATE KEY UPDATE LAST_INSERT_ID(last+1)`)
i wykonuje się w tej samej transakcji co zapis dokumentu.

## Odbiorcy końcowi (poziom 3)

Prywatna baza klientów Użytkownika (`invoice_end_client`). ⚠️ To **nie są konta
w aplikacji** — brak pinu i hasła; istnieją wyłącznie jako nabywcy na fakturach
i adresaci dostaw, dlatego mają własną tabelę, a nie wiersz w `user`.

- Ekran: `/invoices/end-clients` (dostępny dla zwykłego użytkownika, bez `requireOwner`).
- API: `GET|POST /end-clients`, `GET|PUT|DELETE /end-clients/:id`, `GET /end-clients/search?q=`.
- `DELETE` **dezaktywuje** (`is_active = 0`), nie usuwa — odbiorca bywa nabywcą
  wystawionych faktur, a te muszą zostać niezmienne.
- Pola rejestrowe w formularzu zmieniają się wraz z krajem, a definicje pochodzą
  z `core/compliance.js` — jedno źródło prawdy z dokumentem. ⚠️ Formularz pokazuje
  **tylko numery spoza pól ogólnych**: `NIP` i numery VAT-UE (USt-IdNr., Btw-id,
  N° TVA) są uzupełniane automatycznie z `tax_id`/`vat_eu_id`, więc pytanie o nie
  drugi raz było czystą duplikacją. Zostaje więc PL → REGON, DE → Steuernummer,
  NL → KVK, FR → SIREN/SIRET/NAF.
- **Kraj nowego odbiorcy** domyślnie = `user.country` właściciela kartoteki (tego samego
  użytkownika, który dostaje `owner_user_id`), a gdy pusty — kraj jego organizacji
  (`repository.getEndClientDefaultCountry`). Tylko wartość startowa — do zmiany w formularzu.
- **Osoba prywatna** (`client_type = 'person'`) nie ma numerów firmowych: formularz ukrywa
  NIP, NIP UE i numery rejestrowe (REGON, KVK, SIREN…), a serwer czyści je przy zapisie
  (`core/endClient.js`, wołane w `createEndClient`/`updateEndClient`). ⚠️ Samo ukrycie
  w formularzu nie wystarcza: odbiorca przestawiony z firmy na osobę zachowałby w bazie
  stary NIP, który trafia na fakturę i do VIES. Przełączenie typu w formularzu przed
  zapisem niczego nie kasuje — wartości są tylko schowane.
- **Adres dostawy** jest osobny od rejestrowego i **domyślnie NIE trafia na
  fakturę** — drukuje się dopiero po zaznaczeniu `print_delivery_address` przy
  odbiorcy (albo po przekazaniu `includeDeliveryAddress` w API dla jednego
  dokumentu). Nawet wtedy pomijamy go, jeśli jest identyczny z rejestrowym.
  Po co w ogóle: towar jedzie pod inny adres niż faktura (montaż u klienta),
  a przy WDT 0% adres w innym państwie UE dokumentuje prawo do stawki.
- Powiązanie z zamówieniem: `PUT /orders/:orderId/end-client` ustawia
  `order.end_client_id`; przy `level: 3` moduł bierze odbiorcę z zamówienia,
  jeśli nie podano `endClientId` jawnie.

## Częściowe fakturowanie (partial invoicing)

Pozycję zamówienia (np. 3 rolety) można fakturować partiami. Każda partia to
wiersz w `invoice_item_allocation` (`order_item_id` → `invoice_item_id`,
`invoiced_quantity`, `order_quantity`).

```bash
# 2 z 3 sztuk teraz, resztę później
curl -X POST /api/v1/invoices/from-order/2427 -d '{
  "level": 2, "issue": true,
  "allocations": [{ "orderItemId": 5821, "quantity": 2 }]
}'
# co zostało do zafakturowania
curl /api/v1/invoices/orders/2427/invoiceable
```

⚠️ Suma zafakturowanych ilości nie może przekroczyć ilości z zamówienia. Baza
tego nie wyrazi (to suma po wielu wierszach), więc walidacja idzie **w
transakcji zapisu**: `SELECT … FOR UPDATE` na pozycjach zamówienia → odczyt
zajętości → walidacja → insert alokacji. Bez tego dwa równoległe wystawienia
przefakturowałyby pozycję.

⚠️ Kwota partii to proporcja **wartości** pozycji, nie `cena × ilość` (cenniki
są progowe), a groszowa reszta trafia do ostatniej partii — dzięki temu suma
faktur częściowych zgadza się z zamówieniem co do grosza (sprawdzone: 2/10 →
378,62 EUR + 8/10 → 1514,48 EUR = 1893,10 EUR).

## Wymogi krajowe (PL, DE, NL, FR)

`core/compliance.js` buduje kontekst wg kraju **wystawcy** i zapisuje go na
dokumencie (`invoice.compliance`), więc faktura wystawiona rok temu drukuje
klauzule obowiązujące wtedy. Szablon `partials/tax_compliance.njk` tylko drukuje.

| Kraj | Numery rejestrowe | Klauzule i wymogi |
|---|---|---|
| PL | NIP, REGON | WDT (art. 42), reverse charge (art. 28b), eksport (art. 41), „Mechanizm podzielonej płatności", zwolnienie; kwota VAT w PLN przy walucie obcej |
| DE | Steuernummer, USt-IdNr. | „Steuerfreie innergemeinschaftliche Lieferung", „Steuerschuldnerschaft des Leistungsempfängers", Kleinunternehmer § 19 UStG; **obowiązkowe Leistungsdatum** |
| NL | KVK-nummer, Btw-identificatienummer | intracommunautaire levering, btw verlegd; stawki 21/9/0 |
| FR | SIREN, SIRET, NAF/APE, N° TVA | „TVA non applicable, art. 293 B du CGI", „Taux des pénalités de retard : …", **„Indemnité forfaitaire pour frais de recouvrement : 40 €"** |

⚠️ Teksty klauzul są w oryginalnym języku prawnym (niemiecka faktura ma niemieckie
brzmienie, nawet gdy reszta dokumentu jest po polsku) — celowo **nie** przez i18n,
bo tłumaczenie zmieniłoby ich skutek prawny.

⚠️ `missing`/ostrzeżenia o brakujących numerach dotyczą **tylko wystawcy** —
wystawca nie ma obowiązku znać SIREN-u kontrahenta.

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

## Kto co może (autoryzacja)

⚠️ Fakturowanie **nie jest** operacją wyłącznie organizacji. Poziom 3 należy do
zwykłego użytkownika (salonu) — bez tego formularz odbiorców końcowych nie miałby
zastosowania. Autoryzacja jest dwutorowa (`http/session.js`):

| Rola | Może wystawić | Widzi dokumenty | Panel `/invoices` |
|---|---|---|---|
| owner / admin | poziom 1, 2, 3 | wszystkie w swojej organizacji | tryb organizacji (nabywca = klient organizacji) |
| zwykły użytkownik (salon) | **poziom 3**, tylko dla swoich zamówień | tylko te, które sam wystawił (`issuer_type='user'`, `issuer_id = jego id`) | tryb salonu (nabywca = jego odbiorca końcowy) |

Ten sam ekran `/invoices` działa w dwóch trybach — wybór trybu wynika z roli
w sesji, nie z parametru URL. W trybie salonu: podpowiedzi klientów lecą z
`end-clients/search`, zamówienia to **własne** zamówienia salonu, typy dokumentów
zawężone do proformy i faktury, a ustawienia fakturowania organizacji są ukryte.

⚠️ „Już zafakturowane" jest **relatywne do poziomu**: to samo zamówienie może mieć
fakturę organizacji (poziom 2) i niezależnie fakturę salonu dla jego klienta
(poziom 3) — to dwie różne relacje handlowe, więc filtr wyklucza tylko dokumenty
tego samego wystawcy i poziomu.

## Panel ownera

### Wyszukiwanie (skala)

⚠️ Klientów i zamówień jest dużo, więc panel **nie renderuje żadnych list** —
oba pola to comboboxy pytające endpoint w miarę pisania:

| Endpoint | Dopasowanie | Limit |
|---|---|---|
| `GET /api/v1/invoices/search/clients?q=` | nazwa klienta, ident, NIP, miasto | 20 (max 50) |
| `GET /api/v1/invoices/search/orders?clientId=&q=` | numer zamówienia (`order_idx`), **nazwa zamówienia** (`commision`) | 20 (max 50) |

Konsekwencje w kodzie, o których trzeba pamiętać:

- Rozmiar HTML-a panelu nie zależy od rozmiaru bazy (0 elementów `<option>` w stronie).
- Front: `debounce` 220 ms + `AbortController` — inaczej wolniejsza odpowiedź na
  krótsze zapytanie nadpisywałaby świeższą.
- Liczniki „ile zamówień czeka / ile dokumentów" liczone są **tylko dla wybranego
  klienta** (jeden `SELECT` z dwoma podzapytaniami), nigdy dla całej listy — przy
  tysiącach klientów byłby to N+1 w SQL-u.
- Dopasowanie idzie po prefiksie (`q%`) i po fragmencie (`%q%`), z prefiksem
  wyżej w sortowaniu. ⚠️ `%fragment%` **nie skorzysta z indeksu** — to świadomy
  kompromis (szukanie „nederland" w „TAPIJTCENTRUM NEDERLAND B.V." jest zbyt
  przydatne, żeby je wyciąć). Indeksy pod prefiks i sortowanie czekają gotowe w
  `db/indexes.sql` — **osobny plik, nieuruchamiany automatycznie**, bo dotyka
  istniejących tabel `user`/`order`/`order_item`. Pomiar na obecnych danych
  (1931 klientów, 1860 zamówień): 0,8–1,8 ms bez tych indeksów.
- Dalsza ścieżka przy naprawdę dużych zbiorach: indeks `FULLTEXT` na
  `user.client_name` + `MATCH … AGAINST` — opisane w komentarzu `db/indexes.sql`.



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

## Tylko zlecenia wysłane do klienta (`!sent!`)

Dokument (każdego typu) powstaje WYŁĄCZNIE dla zlecenia, które ma `status = 'sent'`
i `prod_status = '!sent!'` — status z pliku produkcji `status.txt`, synchronizowany co
godzinę (`services/prodStatus.js`). Pilnuje tego `main.js:isShippedOrder` w
`createFromOrder`, więc reguła obowiązuje tak samo w panelu, w API i w automacie; listy
zleceń w panelu (okno na poziomie 2, podpowiedzi na poziomach 1/3/4) pokazują tylko
takie zlecenia. ⚠️ Same `!sent!` bez `status = 'sent'` to kolizja numeru `order_idx`
z plikiem produkcji (zlecenie `active`), nie wysłany towar.

## Automatyczne wystawianie faktur (`autoInvoicing.js`)

Faktura powstaje sama, gdy zamówienie wyjedzie do klienta — bez wchodzenia na
żadną stronę. Przebieg co godzinę w osobnym procesie:

```
server.js ──(co PROD_STATUS_SYNC_INTERVAL_MIN)──▶ scripts/prodStatusSync.js   (spawn, osobny proces)
                                                   ├─ GET_LOCK na bazę          (services/prodStatusCycle.js)
                                                   ├─ status.txt → position_statuses + order.prod_status
                                                   │                            (services/prodStatus.js:syncAllProdStatuses)
                                                   └─ autoInvoicing.runAutoInvoicing()
```

Zamówienie dostaje fakturę, gdy (`repository.findAutoInvoiceCandidates`):

- `order.status = 'sent'` **i** `order.prod_status = '!sent!'` — samo `!sent!` nie
  wystarcza: w bazie są zamówienia `active` z `!sent!` (numer `order_idx` nowego
  zamówienia trafił na stary numer z pliku produkcji),
- **wszystkie** pozycje w `position_statuses` mają `!sent!` — `prod_status` to status
  pozycji z najpóźniejszą datą, więc nie gwarantuje, że wyjechało całe zamówienie,
- `order.delivery_date >= INVOICE_AUTOGEN_SINCE`,
- na tym poziomie nie ma **żadnego** dokumentu `invoice`/`final`/`advance` — także
  anulowanego i szkicu. ⚠️ Anulowanie faktury automatu = „zajmę się tym ręcznie";
  bez tej reguły automat wystawiałby ją od nowa co godzinę. Zamówienie z zaliczką
  wymaga faktury końcowej (`final`), którą wystawia człowiek.

Które faktury powstają dla jednego zlecenia `!sent!` (`repository.js:AUTO_LEVEL_SQL`;
„własne konto organizacji" = ident użytkownika równy identowi organizacji, jak przy
logowaniu ownera):

| Poziom | Kiedy |
|---|---|
| 1 — HKL → organizacja | organizacja zlecenia to nie HKL |
| 2 — organizacja → klient | zlecenie złożył klient, NIE własne konto organizacji (organizacja nie fakturuje sama siebie) |
| 3 — salon → odbiorca końcowy | do zlecenia salonu przypisany jest jego odbiorca (`order.end_client_id`) |
| 4 — organizacja → odbiorca końcowy | do zlecenia własnego konta organizacji przypisany jest odbiorca organizacji |

Poziomy 3 i 4 wykluczają się (`relationLevels`): dokument jednego z nich blokuje
drugi, więc odbiorca nie dostanie dwóch faktur za to samo zlecenie. Zlecenie bez
przypisanego odbiorcy nie dostaje faktury 3/4.

Dokument wystawia `InvoiceService.createFromOrder` — ta sama ścieżka co przycisk
w panelu (cennik, VAT, VIES, numeracja), z `created_by_pin = 'AUTO'` (na liście
dokumentów znaczek „auto"). Błąd jednego zamówienia (np. zerowa wartość) trafia do
logu i nie zatrzymuje pozostałych; zamówienie wraca w kolejnym przebiegu.

| Zmienna `.env` | Domyślnie | Znaczenie |
|---|---|---|
| `INVOICE_AUTOGEN_ENABLED` | wyłączone | `true` włącza automat (wymaga też `INVOICES_ENABLED=true`) |
| `INVOICE_AUTOGEN_SINCE` | — | **wymagane**, `RRRR-MM-DD`: tylko zamówienia wysłane od tego dnia. Bez progu pierwszy przebieg zafakturowałby całą historię |
| `INVOICE_AUTOGEN_LEVELS` | `1,2,3,4` | poziomy — domyślnie wszystkie (tabela niżej) |
| `INVOICE_AUTOGEN_ORGS` | wszystkie | lista `organization.id` — automat tylko dla tych organizacji |
| `INVOICE_AUTOGEN_ISSUE` | `true` | `false` → szkice bez numeru, do przejrzenia i wystawienia ręcznie |
| `INVOICE_AUTOGEN_MAX_PER_RUN` | `100` | bezpiecznik: najwięcej zamówień na jeden przebieg |
| `PROD_STATUS_SYNC_MODE` | `child` | `child` — cykl uruchamia `server.js`; `external` — cron/systemd (`node scripts/prodStatusSync.js`); `off` |
| `PROD_STATUS_SYNC_INTERVAL_MIN` | `60` | co ile minut (min. 5) |

Ręcznie: `npm run prodstatus:dry` (nic nie zapisuje — pokazuje różnice statusów
i listę faktur do wystawienia), `npm run prodstatus:run` (jeden cykl),
`npm run prodstatus:full` (przelicza nagłówki wszystkich zamówień z pliku, bez faktur).

⚠️ Kilka instancji na jednej bazie (host :8000 + kontenery dev/test na bazie
testowej) jest bezpieczne: cykl bierze `GET_LOCK('eform:prodstatus:<baza>')`, a
pozostałe instancje pomijają termin. Automat włączaj jednak tylko w JEDNYM `.env`
na bazę — tam, skąd faktury mają wychodzić.

## Fakturowanie niestandardowe — faktura zbiorcza (`core/collective.js`)

Klient może mieć zamiast faktury za każde zlecenie **jedną fakturę zbiorczą za okres**.
Ustawia to admin: `/admin/users` → konto → karta **„Fakturowanie niestandardowe"**
(`user.invoice_schedule`, migracja `migrations/add_user_invoice_schedule.sql`):

| Wartość | Znaczenie | Wystawienie |
|---|---|---|
| puste | standard — faktura za każde zlecenie po wysyłce | co godzinę (automat) |
| `weekly` | zbiorcza ze zleceń wysłanych w tygodniu pon–nd | we wtorek |
| `monthly` | zbiorcza ze zleceń wysłanych w miesiącu kalendarzowym | 2. dnia następnego miesiąca |

- Dotyczy faktur, w których klient jest **nabywcą** — poziom 2 (organizacja → klient).
  Poziomy 1, 3, 4 bez zmian.
- Okres zlecenia = **data wysyłki** (`order.delivery_date`); do faktury trafiają te same
  zlecenia co do pojedynczej faktury automatu (`!sent!`, wszystkie pozycje wysłane, od
  `INVOICE_AUTOGEN_SINCE`, bez dokumentu poziomu 2).
- ⚠️ Dzień zapasu po końcu okresu (`COLLECTIVE_GRACE_DAYS = 1`): status wysyłki z ostatniego
  dnia trafia do `status.txt` z opóźnieniem — faktura tuż po północy pominęłaby takie zlecenie
  i za ten sam okres powstałaby druga.
- Jedna faktura = klient + sklep grupowy + okres (sklep z własnym NIP-em to osobny nabywca).
  Zaległe zlecenia z dawnych okresów dostają fakturę za SWÓJ okres — data sprzedaży musi
  odpowiadać dostawom.
- Dokument (`InvoiceService.createCollective` → ta sama ścieżka `buildDocument` co faktura
  za jedno zamówienie): pozycje wszystkich zamówień, każda z numerem swojego zamówienia
  (`invoice_item.order_number`); data sprzedaży i dostawy = koniec okresu; `invoice.order_id`
  pusty, `order_ref` = lista numerów (skracana do 64 znaków), w uwagach okres i pełna lista
  w języku dokumentu (`collective.note` w `i18n/*.json`).
- ⚠️ „Zafakturowane" rozpoznajemy także po POZYCJACH (`repository.linkedDocumentSql`) —
  faktura zbiorcza nie ma `order_id`, więc samo `invoice.order_id = o.id` uznałoby jej
  zamówienia za niezafakturowane i automat wystawiłby im drugie faktury.
- Ręczna faktura z okna zamówień wyjmuje zlecenie z faktury zbiorczej — karta klienta i okno
  pokazują ostrzeżenie dla klientów z harmonogramem.
- Kod działa także przed migracją (`supportsInvoiceSchedule`) — wtedy fakturowanie
  niestandardowe jest po prostu nieaktywne.

## Okno zamówień (widok klienta, poziom 2)

`/invoices/client/:id?level=2` pokazuje od razu **wszystkie** zamówienia klienta
czekające na fakturę (`templates/owner/partials/client_orders_window.njk`, dane z
`repository.listInvoiceableOrdersForClient`) zamiast comboboxa z podpowiedziami:

- wyłącznie zlecenia z **`!sent!`** w `status.txt` (patrz „Tylko zlecenia wysłane do klienta"),
- zaznaczenie kilku zamówień = osobny dokument dla każdego (kolejne
  `POST /from-order/:id`, po kolei); błąd trafia do wiersza zamówienia,
- „już zafakturowane" = nieanulowany `invoice`/`final` na poziomie 2 bez względu na
  `issuer_id` — dokumenty z v1 mają `issuer_id = 0`,
- licznik „zamówień do zafakturowania" na karcie klienta liczy ten sam warunek co okno.

Pozostałe poziomy (1, 3, 4) zostają przy comboboxie — także tylko zlecenia `!sent!`.

## Formatki organizacji (papier firmowy)

Każda organizacja drukuje faktury na własnej **formatce** — PDF-ie z papierem
firmowym w `img/invoice-background/` (`COZY.pdf`, `HKL.pdf`, `LUXANGMBH.pdf`).
Treść faktury (ten sam szablon Nunjucks dla wszystkich) jest nakładana na formatkę
na każdej stronie; formatka zostaje wektorowa.

Gdzie w bazie (`db/schema_v3.sql`):

```
invoice_organization_profile.template_code ──▶ invoice_template.code
                                                 ├─ background_file  'LUXANGMBH.pdf'
                                                 ├─ page_margins     {"top":24,"right":12,"bottom":27,"left":12}  (mm)
                                                 └─ template_file / stylesheet  (układ treści, domyślnie wspólny)
```

**W panelu:** `/invoices/profile` → sekcja **„Formatka (papier firmowy)"** (tylko admin,
w kontekście wybranej organizacji): plik z listy, cztery marginesy, przycisk **„Podgląd PDF"**
(ostatnia faktura organizacji na wybranej formatce, z ustawieniami z formularza — bez zapisu),
zapis razem z resztą profilu. Owner widzi przypisaną formatkę bez możliwości zmiany.

**Skryptem** (ta sama logika — `templateAssignment.js`):

```bash
node scripts/setInvoiceTemplate.js --list
node scripts/setInvoiceTemplate.js LUXANGMBH --background LUXANGMBH.pdf --margins 24,12,27,12
node scripts/setInvoiceTemplate.js Cozy      --background COZY.pdf      --margins 20,12,22,12
node scripts/setInvoiceTemplate.js HKL       --background HKL.pdf       --margins 46,14,74,14
node scripts/setInvoiceTemplate.js LUXANGMBH --default        # powrót do wydruku bez formatki
```

Skrypt sprawdza, że plik istnieje, zapisuje wiersz `invoice_template` (kod = ident
organizacji) i ustawia go w profilu. Marginesy to pole treści między pasem
nagłówka a stopką formatki — wartości wyżej zmierzone na obecnych plikach.

Zasady:

- **Szablon należy do wystawcy** (`core/templates.js`): poziom 1 → HKL, poziomy 2 i 4 →
  organizacja zamówienia, poziom 3 (salon) → domyślny. Wybór po organizacji zamówienia
  drukowałby fakturę HKL na papierze Luxanu.
- **Rozmiar i orientacja strony pochodzą z formatki** (COZY/LUXANGMBH: 290×210 mm poziomo).
  Gdy treść nie mieści się na jednej stronie o niewiele, PDF jest pomniejszany (min. 80%),
  żeby blok „Płatność + podpisy" nie spadał na pustą drugą stronę. Długie faktury mają
  skalę 100% i kolejne strony — każda na formatce.
- **Faktura pamięta kod szablonu** (`invoice.template_code`) z chwili wystawienia. Gdy obecny
  kod organizacji mają już wystawione faktury, zmiana formatki albo marginesów tworzy **nową
  wersję** (`LUXANGMBH_202610021015`) — panel i skrypt robią to same; stary wiersz zostaje,
  więc ponowny wydruk starej faktury nie pokaże nowych danych z formatki (np. innego konta).
  Dopóki kod nie ma faktur, zmiany idą w miejsce.
- Zła nazwa albo brak pliku formatki/szablonu **nie blokuje** PDF-a: dokument powstaje bez
  formatki (albo na szablonie domyślnym), a w logu zostaje ostrzeżenie.
- Formatkę zmienia **tylko admin** (skrypt albo sekcja w `/invoices/profile`); owner widzi ją
  bez możliwości zmiany — lista zawiera formatki wszystkich organizacji. API odrzuca
  `template_code` od nie-admina.
- Podgląd HTML (`/invoices/:id/view`) pokazuje samą treść — formatka jest tylko w PDF-ie.

⚠️ `HKL.pdf` jest **pionowa** i ma nietypowy rozmiar 282×398 mm (A4 w skali ~134%), a faktura
jest pozioma: treść zajmuje górne ~40% strony, a przy druku na A4 całość zmniejsza się do ~75%.
Do rozważenia: pozioma formatka HKL w formacie A4 jak COZY/LUXANGMBH.

## Punkty rozszerzeń

| Chcę… | Zrób to tutaj |
|---|---|
| Formatka (papier firmowy) organizacji | PDF do `img/invoice-background/` + `node scripts/setInvoiceTemplate.js <ORG> --background <plik.pdf> --margins …` |
| Własny układ treści dla organizacji | Kopia `templates/invoice-main.njk` + `--template <plik.njk>` w tym samym skrypcie |
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
- **Ilość to zawsze LICZBA SZTUK z `json_parameters.ILOSC`** — żaden produkt nie
  jest rozliczany na m² ani mb. Powierzchnia (`POW`) i wymiary są danymi
  technicznymi konfiguracji: idą do `meta` i do kolumny „Wymiary", nigdy do
  kolumny „Ilość". ⚠️ To samo źródło czyta `core/allocations.js`, więc drukowana
  ilość i partie częściowego fakturowania zawsze się zgadzają.
- **Wartość netto pozycji pochodzi z wyceny silnika formularzy**
  (`order_item.total_price`), bo cenniki tej branży są progowe — iloczyn
  „ilość × cena jednostkowa" dałby inną kwotę niż realna wycena.
- **`invoice_tax_rate` nie jest jeszcze czytana w runtime** — stawki biorą się z
  `services/vatCalculator.js`. Tabela jest przygotowana pod nadpisania per
  organizacja i wersjonowanie stawek w czasie.
