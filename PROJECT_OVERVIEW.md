# eForm — Dokumentacja projektu (mapa modułów)

> Plik referencyjny dla przyszłej pracy nad projektem. Opisuje architekturę, moduły i pojedyncze funkcjonalności, aby nie analizować kodu od zera przy każdej zmianie.
>
> **Zasada utrzymania:** każdą istotną zmianę w kodzie dopisuj do sekcji [Changelog](#changelog) na końcu pliku (data + krótki opis + dotknięte pliki). Jeśli zmiana modyfikuje architekturę modułu, zaktualizuj też właściwą sekcję powyżej.

---

## 1. Czym jest projekt

**eForm** to wewnętrzny system zarządzania zleceniami produkcyjnymi dla firm produkcyjno‑logistycznych (marki: **HKL, COZY, Luxan, Remasun, TCN**). Umożliwia klientom, pracownikom, właścicielom (owner), adminom i użytkownikom grupowym (sklepy) tworzenie, edycję i śledzenie zamówień produkcyjnych przez cały ich cykl życia.

### Kluczowe możliwości
- **Zarządzanie zamówieniami** — tworzenie, edycja, wysyłka i śledzenie zamówień z pozycjami (line items).
- **Wielorolowy dostęp** — klienci, pracownicy, owner, admin, użytkownicy grupowi; każdy ma osobne widoki i uprawnienia.
- **Generowanie PDF** — zamówienia renderowane do PDF (e‑mail, druk, produkcja).
- **Śledzenie statusu produkcji** — integracja z systemami produkcyjnymi, numery spedycyjne (tracking).
- **Powiadomienia e‑mail** — mailBot wysyła potwierdzenia i aktualizacje.
- **Import zamówień** — import przez FTP z systemów zewnętrznych (pliki JSON).
- **i18n** — pełne wsparcie języków: `pl, en, de, fr, nl`.
- **Silnik formularzy** — dynamiczne renderowanie formularzy konfiguracji produktu i wyliczanie cen.
- **Ceny i rabaty** — logika rabatów per‑klient, kontrola widoczności cen, ceny SUB (ceny klienta).
- **RODO/GDPR** — dokumenty polityki prywatności i regulaminy per marka/język.

### Słownik domenowy
- **Order (Zamówienie)** — zamówienie klienta zawierające ≥1 pozycję.
- **Position / Pozycja** — line item w zamówieniu (konkretna konfiguracja produktu). Tabela `order_item`.
- **Owner (Właściciel)** — administrator marki/biznesu; widzi zamówienia całej organizacji.
- **Group / Grupa** — sklep detaliczny składający zamówienia w imieniu klientów końcowych.
- **Group shop** — subkonto sklepu podpięte pod użytkownika grupowego (np. pod TCN).
- **Pin** — identyfikator użytkownika używany do logowania.
- **Spedition numbers** — numery przesyłek/tracking dla wysłanych zamówień.
- **Asortment group / grupa (`groupNumber`)** — numer grupy produktowej definiującej formularz (pliki `param.txt`/`paramdict.txt`).
- **SUB / ceny SUB** — parametry `SUB___` to ZAWSZE cena klienta (nie organizacji) — osobna warstwa cenowa obok ceny bazowej/katalogowej, widoczna wg kontroli dostępu (`isGroup`/`canViewSubPrices`/`viewAsOrganization`).

---

## 2. Stack technologiczny

- **Runtime:** Node.js 18 (LTS, Docker Bullseye‑slim), **CommonJS** (`require`/`module.exports`).
- **Backend:** Express 4, `express-session` (in‑memory store), Nunjucks (`.njk`), MySQL (`mysql`/`mysql2`), bcryptjs, i18n, dotenv, multer, nodemailer, PDFKit, Playwright/Puppeteer (PDF + recalc), ExcelJS, dayjs, lodash, sharp, jsdom, hot-formula-parser, esbuild.
- **Frontend:** czysty vanilla JS (`public/scripts/`), Nunjucks SSR, esbuild (bundling), Intro.js/Shepherd.js (onboarding tours).
- **DB:** pojedyncza baza MySQL `eform`, bez ORM — surowe SQL przez helpery w `db/`. Migracje jako pliki `.sql` w roocie (`migration_*.sql`) i w `migrations/`.
- **Deployment:** pojedynczy kontener Docker (`Dockerfile`), z Chromium do renderu PDF. Storage montowany w `/mnt/eform`. Strefa czasowa `Europe/Warsaw`.
- **Skrypty npm:** `start` (prod), `dev` (`--watch`), `test` (node built-in test runner), `import:orders`, `import:preflight`, `import:daemon`, `import:restart|status|logs` (systemd `eform-import.service`).
- **Formatowanie:** Prettier (`.prettierrc`), taby.

### Punkt wejścia i konfiguracja
- **`server.js`** — Express app. Kolejność middleware: cookieParser → i18n → CORS → session (3 warianty zależne od `PRODUCTION`/`TEST_INTERNET`/dev) → bodyParser (50mb) → static (`public`, `/data`, `/photos`) → global locals (locale, flagi group/orgAccount, subPrice locals, introNeeded) → `addOrganizationsForAdmin` → `enforceAccessLock` → routery. Mounty routerów: patrz [sekcja 5](#5-routes-kontrolery-http).
- **`config.js`** — scentralizowane ścieżki i env. Kluczowe: `rootDir` (`ROOT_DIR`, domyślnie `/mnt/eform`), `dataDir`, `changesDir`, `localesDir`, `photoPath`, `usersPath`, `outputData`, `shortJsonDir`, `availabeLanguages`, `defaultLanguage='en'`, `logsDir`, `ftpImportPath='/orders-in'`, `localImportDir`.
- **`.env`** — DB (`DATABASE*`), `SESSION_SECRET`, FTP (`FTP_*`, `FTP_PDF_*`), `ROOT_DIR`, `NODE_ENV`, mail (`MAILBOT_*`, `EXTRA_MAIL`, `IMPORT_NOTIFY_EMAIL`), `LOG_PATH`, `ADMIN_PIN`/`ADMIN_PASSWORD` + `RECALC_APP_PORT` (Playwright recalc po imporcie).
- **`nunjucks-setup.js`** — konfiguracja silnika szablonów.

---

## 3. Architektura (warstwy)

Klasyczny układ **MVC‑like**:

1. **Routes** (`routes/`) — kontrolery HTTP: obsługa żądań, wołanie serwisów/DB, render szablonów.
2. **Services** (`services/`) — logika biznesowa, orkiestracja wywołań DB.
3. **DB layer** (`db/`) — cienkie wrappery na surowe SQL (bez ORM).
4. **Middleware** (`middleware/`) — cross‑cutting (auth, uprawnienia, i18n, access lock).
5. **Templates** (`templates/*.njk`) — widoki Nunjucks (SSR), organizowane per rola.
6. **Public scripts** (`public/scripts/`) — vanilla JS interaktywności klienta, struktura odwzorowuje role/funkcje.

### Konwencje
- Pliki route mapują 1:1 na prefiksy URL (`/orders` → `routes/orders.js`).
- Pliki DB odwzorowują domeny (`db/orders.js`, `db/users.js`); admin ma równoległą warstwę `db/admin/`.
- Szablony i skrypty frontendu organizowane per rola (`admin/`, `owner/`, `user/`, `group/`).
- Testy: wbudowany runner Node, w katalogach `__tests__/` wewnątrz `services/` i `middleware/`.

---

## 4. Baza danych

### Warstwa dostępu (`db/`)
`db/db_helper.js` to **barrel/agregator** — scala eksporty wszystkich modułów w jeden obiekt. `db/admin/db_helper.js` robi to samo dla wariantów admina.

- **`db/core.js`** — pula połączeń MySQL (`mysql2/promise`, host/port/user z env, 15 połączeń). Eksportuje `pool`, legacy `connetToDb()`, oraz helpery `selectQuery`/`insertQuery`/`updateQuery`/`deleteQuery`.
- **`db/users.js`** — tabela `user`: język, first-login, akceptacja RODO/privacy, logowanie pracownika (join `employee`).
- **`db/orders.js`** — tabela `order`: tworzenie zamówień, budowa sekwencji `order_idx` (per group shop), parsowanie ceny łącznej, powiązanie z group_user.
- **`db/positions.js`** — tabela `order_item`: insert/edycja pozycji, licznik `orderpos`, parametry JSON. ⚠️ *Otwiera połączenie na poziomie modułu (`connetToDb()`), które nigdy nie jest await/release — do sprzątnięcia.*
- **`db/address.js`** — tabele `delivery_address` i `contact_info`: CRUD adresów dostawy i mailowych per user.
- **`db/group.js`** — tabela `group_user`: CRUD sklepów/subkont, unikalność pin.
- **`db/statuses.js`** — tabela `position_statuses`: status wysyłki per pozycja, shipping_date, parcel_code.
- **`db/owner.js`** — widoki owner: users per organizacja (`user` JOIN `organization`), userId po ident.
- **`db/others.js`** — czasy dostawy: `organization_delivery_terms`, `group_delivery_mapping`.
- **`db/admin/orders.js`** — pobieranie zamówień + `order_item` dla admina, sprawdzanie własności, joiny szczegółów/adresów.
- **`db/admin/positions.js`** — admin insert/get `order_item`.
- **`db/admin/users.js`** — zapytania user dla admina (język, first-login, RODO).
- **`db/admin/owner.js`** — listowanie userów organizacji.
- **`db/admin/others.js`** — czasy dostawy (duplikat `db/others`).
- **`db/admin/orderCorrections.js`** — wyszukiwanie/paginacja wysłanych `order` (JOIN `user`, `organization`) dla modułu korekt.
- **`db/admin/reports.js`** — agregaty raportowe: lista klientów z liczbą zamówień, statystyki per user/zakres dat (status='sent').

### Główne encje schematu
`user`, `organization`, `order`, `order_item`, `delivery_address`, `contact_info`, `group_user`, `position_statuses`, `employee`, `department`, `product_group`, `group_delivery_mapping`, `organization_delivery_terms`, `user_favorites`, `app_version`, `client_aliases`, `import_log`, `send_address`/`order_address`, `translation_dictionary`, `paramdict_aliases_config`.

### Migracje
**Root (`migration_*.sql`):**
- `migration_all.sql` — zbiorczy bundle (tworzy `department`, `product_group`, `group_delivery_mapping`; dodaje `order.spedition_numbers`, `max_prod_days` itd.). Kolejność istotna.
- `migration_add_spedition_numbers.sql` — `order.spedition_numbers` JSON.
- `migration_client_aliases.sql` — tabela `client_aliases`.
- `migration_delivery_groups.sql` — `department`, `product_group`, `group_delivery_mapping`.
- `migration_employee_permissions.sql` — `employee.can_send_orders`, `can_see_prices`, `can_see_all_orders`.
- `migration_employee_price_factor.sql` — `employee.price_factor` DECIMAL (mnożnik wizualny cen).
- `migration_group_shop_order_idx.sql` — `order.order_idx` → VARCHAR(32), usuwa trigger `before_insert_order`.
- `migration_group_users.sql` — tabela `group_user`, `order.group_user_id` + kolumny profilu.
- `migration_import_log.sql` — tabela `import_log`.
- `migration_link_group.sql` — `order_item.link_group` VARCHAR(36) (pozycje „wiszące razem”).
- `migration_max_prod_days.sql` — `order.max_prod_days` INT.
- `migration_phone_lengths.sql` — poszerza `phone` do VARCHAR(50) na `send_address`/`order_address`.
- `migration_recent_clients.sql` — `user.recent_clients` JSON.
- `migration_report_configs.sql` — `user.report_configs` JSON.
- `migration_total_sub.sql` — `total_price_sub` na `order_item` i `order`.

**`migrations/` (idempotentne):**
- `add_employee_permissions.sql` — te same 3 kolumny uprawnień (warunkowo).
- `add_order_correction.sql` — `order.corrected_at` DATETIME.

---

## 5. Routes (kontrolery HTTP)

Mounty w `server.js`:

- **`/user`** → `routes/users.js` — auth (login, `auth/login`, check-password), edycja profilu, akceptacja RODO, logout, session-check, widok owner, CRUD pracowników (`/employee/add|edit|:id`, price-factor, orders), intro/tutorial.
- **`/admin`** → `routes/admin.js` — dashboard, access-lock, historia logowań + API, users/organizations/settings/logs/active-sessions, sync tłumaczeń + status, raporty (`/reports`, `/api/reports/stats|configs`), import-log; montuje sub‑router `/order-corrections`.
- **`/admin/order-corrections`** → `routes/admin/orderCorrections.js` — lista korekt, open/:orderId, get :orderId, positions-data, recalculate, submit, cancel.
- **`/group`** → `routes/group.js` — zarządzanie sklepami grupowymi (`/shops` CRUD), panel grupy, akceptacja/odrzucanie pending-orders, shop-orders.
- **`/`** → `routes/index.js` — tłumaczenia, env, zmiana języka, home, delivery-time, contact/terms/privacy, config-num, context-user, recent-clients, set-organization/:id, employee-status.
- **`/orders`** → `routes/orders.js` — **największy router**: search, edit, userOrders, history (+ detal), add-order, `order/:orderId` (+prices/discount/details/pdf), positions-data, recalculate, send, copy, lock, toggle-sub, save-order, submit-for-approval, update/delete/comment, link-positions/link-groups, toggle-status, send-to-production, import-log.
- **`/position`** → `routes/positions.js` — save/edit pozycji, delete, photo, widoki edycji, attachments, duplicate, favorites (toggle/list/clear), version checks, reorder (move-up/down/set-idx), check-images.
- **`/address`** → `routes/address.js` — CRUD adresów dostawy i mailowych (add/list/:id get/put/delete, warianty mail).

Fallback: `app.all('*')` → `error.njk` (404); globalny error handler → `error.njk`.

---

## 6. Silnik formularzy (Form Engine)

### Jak zdefiniowane są formularze
Formularze **nie są JSON** — każda grupa produktowa („asortment group") jest definiowana plikami tab‑separated na dysku pod `<dataDir>/<groupNumber>/data/versions/<version>/<lang>/`:

- **`param.txt`** — wiersz na parametr (pole). Kolumny: `NAME`, `DESCRIPTION`, `TYPE`, `DEFAULT`, `ENABLE` (formuła widoczności), `FORMULA` (formuła calc), `SOURCE` (referencja skryptu/slope), `SCRIPTS` (selektor skryptu ceny), `LISTROW`/`LISTSUM` (layout wiersza cenowego), `FORMROW`, `DEPENDENCES`, `MULTI`, `FORMAT`.
- **`paramdict.txt`** — wartości słownikowe per param: `<PARAM>_VALUE`, `<PARAM>_DESCRIPTION`, `<PARAM>_ENABLE`, `<PARAM>_PROC` (formuła procedury), `<PARAM>_ATTRS` (atrybuty filtra).
- **`prod.txt`** (per grupa/lang) — metadata grupy: `PARAM_SCRIPTS` (mapowanie skryptów cen per‑klient) i `PARAMDICT_ALIASES` (pliki aliasów per‑klient).
- **`param-<NAME>-<X>.js`** — skrypty cenowe: definiują globalne `f(jsonString)` zwracające wyliczone wartości przez `evaluateFormula`.

**Centralne struktury danych (na `window`):** `params` (definicje pól), `formValues` (`{NAME: value}` kanoniczne), `formDisplayValues` (Map `NAME → {param_description, option_value, option_description, sub, locked, row, listsum}`), `allOptionsByParameter` (opcje słownika), `shortJson` (kompaktowe podsumowanie).

### `services/formEngine/*` — silnik headless (server‑side)
Uruchamia **dokładnie ten sam** pipeline wyceny co przeglądarka, ale server‑side w JSDOM — używany przy imporcie zamówień i odświeżaniu przestarzałych cen.

- **`index.js`** — publiczne API. `calculatePrices({groupNumber, version, lang, values, displayValues, orgIdent, userIdent})` bootuje JSDOM, woła `generateForm`, odtwarza każdą wartość przez `updateProcedure` (lub kaskadę `singlePass`), opróżnia kolejkę calc, robi finalny deterministyczny `applyFormulaParams` (do 5× iteracji dla zależności między formułami), zwraca `{values, displayValues, total, shortJson, formMeta}`. `getTotal` czyta wiersze `listsum` → `{total, total_hidden, total_sub}`. Też `getFormMeta` (tylko metadata) i `recalculatePosition(id)` (ładuje `order_item`, przelicza, zapisuje przez `db/positions.updatePosition`).
- **`bundler.js`** — esbuild bunduje `public/scripts/form.js` (+ całe `formTools/*`) w jeden IIFE (`__engineForm`), bo JSDOM 27 nie odpala ES modules. Cache w pamięci.
- **`jsdomEnv.js`** — `bootEngine()`: tworzy JSDOM z harness HTML + `FormEngineResourceLoader`, seeduje globalne `window.*`, stubuje `formsManager` (deleguje do `clientScripts.js`), patchuje `window.fetch` (serwuje `/user/uid`, `/env`→`Testowa`, `/data/*`, `/scripts/*`; blokuje zewnętrzne), wstrzykuje skrypty w kolejności: `formula-parser.min.js` → `formula.js` → bundle → adapter (`window.__engine = {generateForm, updateProcedure, getTotal}`).
- **`clientScripts.js`** — port `FormsManager` oparty na fs. Czyta `prod.txt` `PARAM_SCRIPTS`/`PARAMDICT_ALIASES` by rozwiązać skrypty cen per‑klient (`getClientScripts`) i kolekcje aliasów (`loadClientAliases`) po `orgIdent`/`userIdent`. Naprawia bug „cena = 0" przy imporcie (skrypty per‑klient nie ładowały się headlessowo).
- **`harnessHtml.js`** — minimalny szkielet HTML z ID węzłów DOM czytanych przez frontend (`#dynamic-form`, `#commission-input`, dialogi…).
- **`resourceLoader.js`** — JSDOM `ResourceLoader`: mapuje `/scripts/*`→`public/`, `/img/*`→`public/`, `/data/*`→`dataDir`; serwuje wirtualne źródła in‑memory; blokuje URL zewnętrzne.
- **`scriptRunner.js`** — samodzielny executor skryptów cenowych w sandboxie `vm` (omija JSDOM). Lżejsza alternatywna ścieżka (główny flow używa JSDOM).

### `public/scripts/formTools/*` — logika build/calc klienta
- **`createForm.js`** — konstrukcja pól/UI: `createInputField`, `getPossibleValues`, reguły widoczności (`shouldHideRegularPriceRow`, `hideLocked`, `hideSub`, `hideParams`, `isParamLocked`), `restoreLockedParamsFromDisplayValues`, `syncLockedParamsFromEnableFormulas`, override‑checkbox (dla userów `KN_`), wymuszanie int. „Calculated param" = ma FORMULA lub SOURCE.
- **`pricesCalculator.js`** — rdzeń wyceny. `calculateFromFormula` (przez `window.FormulaHandler.evaluateFormula`, negatywy/false→0), `calculateFromScript` (woła `loadScript` = plik `param-*.js` z `param.SOURCE`, obsługuje pola `_S` spec i warianty `SUB___`), `checkIfPriceIsCorrect` (podmienia cenę na „see pricelist" gdy zero).
- **`dataLoader.js`** — `DataLoader` fetchuje/parsuje `param.txt`/`paramdict.txt` (TSV→obiekty), buduje `allOptionsByParameter`, filtry atrybutów; `selectPrices` (per‑klient `SCRIPTS='true'`→SOURCE), `selectCollections` (nakłada ALIAS/ALIAS_DESCRIPTION klienta).
- **`formDataHelper.js`** — `buildFormDataWithAttachments`/`sendFormDataWithAttachments`: pakuje `postBody` JSON + pliki w `FormData` i POST/PATCH do endpointów save.
- **`updateFieldsAndValues.js`** — dispatcher obliczeń. `updateFieldStates`: pre‑pass FORMULA‑only → sekwencyjne SOURCE scripts (async chain) → post‑pass formuł (dla zależności script→formula). Też `buildValuesToDisplay`, `updateFieldInputs`, `resetDependences`/`resetSelectValues` (kaskada DEPENDENCES), `convertIntoPercent`, `setListRow`, `clearDisabledValues`.
- **`shortJsonGen.js`** — `generateShortJson`: kompakt `{NAME: value (+_ALIAS)}` posortowany w kolejności param → `{data, order}`. Zapisywany jako `parameters_short`.
- **`slope.js`** — klasa `SourceWindow`: modalny sub‑formularz dla params gdzie `SOURCE == NAME` (slope/złożone katalogi). Ładuje własne dane, renderuje dialog, produkuje `sourceValues`/`sourceDisplayValues` do formularza rodzica.
- **`validateUtils.js`** — `getProcedures` (`<PARAM>_PROC` przez `USTAW` → MIN/MAX/DOM validatory), `validateFormInput`, `validateAllFieldsOnSubmit`, `setDefaultValues`, `checkFlags`.
- **`storage.js`** — `AttrLoader`: ładuje `paramdictattr-KOLOR-!storage!.txt` (atrybuty kolorów/dostaw) do `attrValues`.
- **`localStorageManager.js`** — `fillLocalPositionObject`/`getLocalPositionObject`: persystuje `{values, displayValues}` w `localStorage` (`formData`).
- Pomocnicze: `formTools.js` (hub re‑exportów), `getAvailableForms.js` (browserowy `FormsManager`), `getUid.js`, `fileTranslator.js`, `attachment.js`, `scriptLoader.js`, `dialogUtils_copy.js`.

### Skrypty top‑level klienta
- **`form.js`** — browserowy silnik (też bundlowany server‑side). `generateForm(version, groupNumber, values, displayValues, editFlag, lang, spin)` ładuje dane, buduje inputy, ustawia defaulty, wiąże listenery → każdy odpala `updateProcedure`. `updateProcedure` = kolejkowany (serializowany przez `calculationQueue`) pipeline: setDescription → percent → hide locked/sub → buildValuesToDisplay → updateFieldInputs → getProcedures → validate → `updateFieldStates` → generateShortJson → fillLocalPositionObject → applyPriceFactor. `finishFlag` ustawiany 1300ms po opróżnieniu kolejki.
- **`formula.js`** — `window.FormulaHandler.evaluateFormula(expr, context, type)` na bazie `hot-formula-parser`. Funkcje custom: `WSROD/NIEWSROD(2/3)`, `WSRODNIEWSROD`, `ZAWIERA`, `AND`/`ORAZ`, `FLOOR`/`CEIL`/`CEILING`/`ZAOKR`, `LEFT`/`RIGHT`, `HASLO` (password-lock), `USTAW` (side‑effect: ustawia MIN/MAX/DOM validatory + WAR consts, wpisuje defaulty do inputów).
- **`new-order.js`** — UI strony nowego zamówienia (modale adresów/maili, country selects); poza silnikiem calc.
- **`orderBuilder.js`** — `buildOrderItemStructure`: montuje `postBody` do zapisu pozycji (order id, `unitPrice/totalPrice/totalPriceSub`, `jsonValues`, `jsonValuesToDisplay`, `amount`, `comment`, `version`, `groupNumber`, `lang`, `department`, `group`, `parameters_short`).
- **`main.js`** — orkiestruje stronę new-order (`generateForm`, submit → `getTotal`, stringify displayValues → `[[k,v],...]`, `buildOrderItemStructure`, `POST /position/save`). **`edit_form.js`** — analogicznie z `editFlag=true` i `PATCH /position/edit/save`.

### Przepływ danych (E2E)
1. **Render:** `generateForm` → DataLoader parsuje `param.txt`/`paramdict.txt` → `allOptionsByParameter` + aliasy/skrypty per‑klient → inputy do `#dynamic-form`, defaulty → `values`/`displayValues`/`shortJson` na `window`.
2. **Wycena (per zmiana):** input/change → `updateProcedure` (queue) → `updateFieldStates` → per calculated param: `calculateFromFormula` lub `calculateFromScript` → zapis do `values` + `displayValues` (`listsum`/`row`/`locked`/`sub`) → `generateShortJson`.
3. **Sumy:** `getTotal(displayValues)` sumuje wiersze `listsum` → `{total, total_hidden, total_sub}`.
4. **Zapis:** `getTotal` + stringify displayValues → `buildOrderItemStructure` → `sendFormDataWithAttachments` → `POST /position/save` (nowa) lub `PATCH /position/edit/save` (edycja). Kolumny: `json_parameters` (values), `json_parameters_desc` (display entries), `parameters_short` (shortJson) + pola total.
5. **Autorytatywny recalc server-side:** `formEngine.calculatePrices` / `recalculatePosition` odtwarza identyczny pipeline w JSDOM i zapisuje przez `db/positions.updatePosition`.

---

## 7. Import zamówień (Order Import)

Pipeline sterowany FTP: pobiera wyeksportowane pliki JSON zamówień, waliduje i rozwiązuje względem DB eform, wstawia transakcyjnie jako natywne zamówienia, przelicza ceny w prawdziwej przeglądarce headless (Playwright) by skrypty cen per‑klient działały autentycznie. Jest lustrem strony eksportu (`services/sendOrderService.js` / `OrderSender`) — ten sam kształt JSON, odwrotny kierunek. Działa **poza Express**, jako daemon lub jednorazowy skrypt.

### `services/orderImport/*`
- **`index.js`** — orkiestrator. `runImport()` listuje pliki FTP i przetwarza każdy przez `processOneFile()`: download → parse → recover → validate → resolve aliases → resolve user → insert w jednej transakcji DB → recalc w przeglądarce po commicie → restore params → rebuild display values → zero‑price check → move pliku do processed/error. Retry błędów przejściowych (3 próby, exp. backoff). Email z podsumowaniem. ⚠️ *Auto‑wysyłka po imporcie jest celowo wyłączona (złe maile klientów wymagały manualnej weryfikacji).*
- **`orderImporter.js`** — rdzeń zapisu DB. `importResolvedOrder()` tłumaczy+waliduje params każdej pozycji, wstawia send_address, nagłówek order (status='active'), po jednym order_item na pozycję używając prawdziwego silnika (`formEngine.calculatePrices`, singlePass); reindeksuje pozycje i przelicza totale. Zawiera też snapshot/restore params wokół recalc w przeglądarce i `seedDictionaryDescriptions`.
- **`ftpClient.js`** — wrapper FTP (basic-ftp): list/download/move plików `.json`. Fallback do lokalnego katalogu gdy brak env FTP (dev/test).
- **`browserRecalculator.js`** — recalc Playwright (chromium headless). Loguje jako admin, ustawia kontekst na klienta ownera, otwiera `/orders/order/:id`, uruchamia flow „Przelicz", czeka na POST `/recalculate`. Celuje w always‑on instancję (`RECALC_APP_PORT`, port 8081), nie dev.
- **`aliasResolver.js`** — 3‑poziomowa walidacja/rozwiązanie wartości: product_group istnieje → kanoniczny `value_key` w translation_dictionary → `client_aliases` (filtrowane po kolekcji `paramdict_aliases_config` klienta). Przepisuje aliasy na realne wartości, ustawia `<PARAM>_ALIAS`/`_ALIAS_DESCRIPTION`.
- **`userResolver.js`** — znajduje `user` po `ident`, dopełnia brakujące pola klient/dostawa (nie nadpisuje istniejących), wykrywa język (z `user.country` lub default).
- **`optionValidator.js`** — sprawdza że kanoniczne wartości params istnieją w opcjach paramdict grupy; pomija INPUT/CALCULATED/meta. Fail‑fast przed zapisem DB.
- **`orderValidator.js`** — walidacja strukturalna JSON. Wymagane: `userIdent` + niepuste `items[]` (każdy z `product`/`asortment` + niepuste `parameters`). Wykrywa typowy błąd: przyszła tablica displayValues zamiast obiektu order.
- **`parameterTranslator.js`** — odwrotne tłumaczenie kluczy/wartości params na kanoniczny polski przez słownik grupy; passthrough gdy lang `pl` lub pusty słownik.
- **`displayValueBuilder.js`** — duży builder produkujący `json_parameters_desc` (display values) ze słownika + meta formularza + wyjścia silnika: row/locked/sub/listsum, opisy opcji, ukrywanie zerowych/pustych. Eksportuje `getProductGroupName`/`getDepartmentName`.
- **`displayValueRebuilder.js`** — patcher po recalc. Playwright naprawia ceny ale gubi aliasy klienta; re‑aplikuje `_ALIAS`/`_ALIAS_DESCRIPTION` do `option_value`/`option_description`, re‑derywuje locked flags, przebudowuje display values zachowując row/locked/listsum z przeglądarki. Zapis double‑encoded (jak `insertNewForm`).
- **`payloadRecovery.js`** — gdy FTP dostarczy tablicę displayValues/malformed zamiast order, odzyskuje ostatni poprawny JSON zamówienia z `processed/` (local lub FTP).
- **`preflight.js`** — read‑only dry‑run tych samych 4 etapów przed transakcją (structural → alias → user → options); nic nie zapisuje/przenosi; zwraca raport per etap.
- **`sendAfterImport.js`** — wysyła zaimportowane zamówienie flow „Wyślij" (status→sent, JSON+FTP, mail z PDF, produkcja). ⚠️ Obecnie NIE wywoływane z index.js (wyłączone).
- **`transactionalDb.js`** — prymitywy DB związane z połączeniem (insertSendAddress, insertNewOrder, insertNewForm, reindexOrderPositions, updateOrderPrice, getAppVersion). `makeTransactionalDeps(conn)` wstrzykuje je, cały insert w jednej transakcji/rollback.
- **`localCache.js`** — zarządza katalogami stagingu `localImportDir` (incoming/processed/error), timestamped moves, `.error.txt` sidecars.
- **`importLogger.js`** — zapis success/error/partial do tabeli `import_log`.
- **`fileNames.js`** — guard bezpieczeństwa nazwy `.json` (brak path traversal / null bytes).

### `scripts/`
- **`orderImportDaemon.js`** — długożyjący daemon (osobny od server.js). Co `ORDER_IMPORT_INTERVAL_SEC` (default 30s) odpala skrypt preflight, potem `runImport()`; zarządza PID (`import/import.pid`), SIGTERM/SIGINT, re‑entrancy guard. Systemd: `eform-import.service`.
- **`runOrderImport.js`** — jednorazowy `runImport()` z exit codes (0 ok / 1 częściowe / 2 crash).
- **`orderImportPreflight.js`** — CLI dry‑run raport nad wszystkimi pending przez `preflight.preflightPayload`; nigdy nie tyka kolejki. Exit 1 gdy któryś plik odrzucony (alerty cron).

### Przepływ E2E
1. **List/fetch** — `ftpClient.listOrderFiles` (FTP `/orders-in` lub local `incoming/`); download do `incoming/` (backup audytowy).
2. **Parse/recover** — `readJson` (double‑encoded) → `payloadRecovery.tryRecoverValidOrderPayload`.
3. **Validate structure** — `orderValidator.validateOrderPayload`.
4. **Resolve aliases** — `aliasResolver.resolvePayloadAliases`.
5. **Resolve user** — `userResolver.resolveOrderUser`.
6. **Transaction** — connection + `beginTransaction` → `orderImporter.importResolvedOrder` (per item: translate → option-validate → engine price → build display → insert) → reindex + recompute totals → `commit`. Fail → rollback.
7. **Log** — `importLogger.logSuccess`.
8. **Browser recalc (po commit)** — snapshot params → `browserRecalculator.recalculateOrderInBrowser` → `restoreOrderParametersAfterRecalc` → `displayValueRebuilder.rebuildDisplayValuesForOrder` → flag zero-price.
9. **File disposition** — local + remote do `processed/` (lub `error/` + `.error.txt`).
10. **Summary email** — `mailBot/importMailer.sendImportSummary`. (Auto‑send do klienta wyłączony.)

### `json_przykład/` — przykładowe pliki importu
Dwa realne wyeksportowane JSON‑y (kształt `OrderSender`). Klucze top‑level: `orderno, orderid, commission, client, organizationIdent, userIdent, created_date, tax, comment, sentDate, name, address, zip, city, country, email, phone, userStreet/Zip/City/Country/Phone, total, total_hidden, items[]`. Każdy item: `posid, orderpos, product, department, product_description, commission, comment, parameters{}`. Parametry zawierają całą rodzinę meta per pole (`X`, `X_ALIAS`, `X_ALIAS___DESCRIPTION`, `X___DESCRIPTION`, `X___DICT`, `X___TITLE`) — dokładnie to co konsumują aliasResolver, optionValidator, displayValueBuilder.

---

## 8. Serwisy — logika biznesowa

### mailBot — e‑mail / powiadomienia
- **`mailBot.js`** — transporter Nodemailer (SMTP home.pl), renderuje szablony Nunjucks i wysyła stylizowane maile z PDF + logo (cid) + załączniki. Eksportuje `sendMail` (fire‑and‑forget), `sendMailAsync` (promise), `sendCorrectionMail` (`correctionMailTemplate.njk`). Temat z klucza i18n + numer + klient.
- **`importMailer.js`** — samodzielny mailer wysyłający HTML tabelę (PL) po imporcie do `IMPORT_NOTIFY_EMAIL`/`EXTRA_MAIL`. Osobny transporter, nigdy nie rzuca.
- **`pdfGenerator.js`** — renderuje PDF zamówień/produkcji przez Nunjucks + Playwright/Chromium (`page.pdf`). `generatePdf` (landscape klient/gold-price, sub-price views, ilość z `json_parameters.ILOSC`), `generateProductionPdf` (portrait, tłumaczy komentarze na PL), `uploadProductionPdf` (FTP prod / local `pdf_out` dev), `generateExcel`, `renderOrderPdfHtml`. Rejestruje filtr `pdfValueParts`.
- **`fileGenerators.js`** — legacy generator: `generateExcel` (ExcelJS) i `generatePdf` (PDFKit), minimalny PDF. Wyparty przez pdfGenerator.js.
- **`extraAttachments.js`** — `getExtraAttachments` czyta pliki binarne (zdjęcia slope), opcjonalnie nakłada tekst wymiarów przez `sharp` (SVG composite), zwraca obiekty załączników nodemailer.
- **`commentTranslator.js`** — `translateToPolish`: wykrywa język (`franc-min`), tłumaczy przez `@vitalets/google-translate-api` (ESM dynamic import); zwraca oryginał przy błędzie/PL.
- **`conf.js`** — `confLang(lang)`: konfiguruje i zwraca instancję `i18n`.

### translationDict — słownik tłumaczeń
- **`index.js`** — orkiestrator. `syncAll`/`syncGroup` skanują katalogi grup, parsują param/paramdict per język, batch‑upsert do DB, usuwają stale entries (snapshot MySQL NOW()). Re‑eksportuje funkcje query.
- **`dbRepository.js`** — warstwa DB dla `translation_dictionary` (auto‑create). `ensureTable`, `getMySQLNow`, `upsertBatch` (INSERT ... ON DUPLICATE KEY, batche 500), `removeStaleEntries`, `getTranslations`, `getGroupTranslations` (`{params, paramdict}`), `getSyncStatus`. *(Plik otwierany w IDE.)*
- **`fileScanner.js`** — skaner FS. `discoverGroups` (numeryczne katalogi pod `dataDir`), `readDataFile`, `scanGroup` (czyta `param.txt`/`paramdict.txt` dla każdego języka z `{group}/data/{lang}/`).
- **`itemTranslator.js`** — `translateOrderItems`: deep‑clone `cleanOrderItems` i tłumaczy nagłówki, klucze (`display||PARAM`), wartości komórek, `lockedParams`, `table.locked` na język docelowy (słownik keyed po `asortment_group_number`). Format komórki `"VALUE - desc"`.
- **`parser.js`** — parsery TSV. `parseParamFile` (NAME→DESCRIPTION), `parseParamDictFile` (pary `{PARAM}_VALUE`/`{PARAM}_DESCRIPTION`); pomija `<NULL>`/puste.

### Korekty admina i kontekst owner
- **`admin/orderCorrectionService.js`** — workflow korekt. `submitCorrection` (waliduje status='correction', ustawia context user, finalizuje korektę, nadpisuje ceny, re‑wysyła przez `OrderSender` z suffixem `-update` na FTP + PDF + correction mail; respektuje `ignore_mail_list`). `cancelCorrection` (revert do 'sent'). `ensureCorrectionContext`, `clearCorrectionContext`.
- **`owner.js`** — kontekst context‑user (impersonacja). `setContextUserByIdent` (ładuje user po ident, zapisuje `req.session.context_user`, do recent clients), `getContextUser`, `clearContextUser`, `getCurrentUser` (zwraca context_user gdy zalogowany owner/admin, inaczej session user).

### Auth i sesja
- **`authService.js`** — logowanie. `handleAuthLogin` (klient + pracownik, bcrypt‑lub‑plaintext, ustawia session `user`/role/RODO/uprawnienia pracownika, loguje, ustawia język), `handleGroupShopLogin` (subkonto sklepu → parent user TCN), `checkPassword`, `checkFirstLogon`, `checkEmployeePassword`, `checkGroupShopPassword`. Admin auto‑promowany do owner. Login blokowany przy access lock.
- **`sessionService.js`** — introspekcja store. `setStore`, `getActiveSessions` (lista sesji z rolą/org/kontekstem/IP), `destroyNonAdminSessions` (przerwa techniczna).
- **`accessLock.js`** — file‑backed maintenance lock (`.access-lock.json` w dataDir). `isBlocked`, `setBlocked`, `getState`.
- **`accessLockAuth.js`** — `isAdminPin` (pin 'admin' lub rola admin w DB), `rejectIfBlockedForLogin` (renderuje `login.technical_break` dla nie‑adminów gdy locked).

### Sync i pozostałe
- **`dbUserSync.js`** — sync klientów z `contractors.txt` (TSV) do DB — diff add/update/delete po pin+ident, mapowanie org, sync haseł, `fixEncodingInDatabase` (naprawa mojibake ü/ö/ä).
- **`groupSync.js`** — czyta `/mnt/eformconf/grupy.xlsx` (departamenty + listy grup) i per‑grupa `.xlsm` (tłumaczenia nazw, czytane w subprocess by uniknąć OOM); upsert `department` i `product_group`. `syncGroupsFromExcel`.
- **`clientAliasesSync.js`** — skanuje `paramdict-<PARAM>-<COLLECTION>.txt` per grupa, parsuje 3‑kol TSV (VALUE/ALIAS/DESCRIPTION), upsert `client_aliases`. `syncAll`, `syncGroup`, `ensureTable`.
- **`paramdictConfigSync.js`** — parsuje linię `PARAMDICT_ALIASES` z `prod.txt`, mapuje ORG/USER/PARAM → kolekcja aliasów do `paramdict_aliases_config`. `syncAll`, `getCollection`, `parseParamdictAliases`.
- **`subPrices.js`** — logika cen SUB (cena klienta, `SUB___` — zobacz korektę w Changelog 2026-07-29). `orderHasSubPrices`, `calcSubTotals` (subVisible/subLocked z `SUB___`), `resolveDiscountBaseTotal`, `resolveSubPricePdfView` (widok PDF wg roli/org/toggle grupy), `buildPdfSendDataTotals`. **HKL org id = 3.**
- **`subPriceContext.js`** — `getEffectiveOrgId` (rozwiązuje org dla wyceny wraz z kontekstem admina), `applySubPriceLocals` (res.locals flags widoczności SUB, ceny katalogowe, kontekst usera).
- **`getDiscount.js`** — `getPriceAfterDiscount(orderId)`: rabatowany total (baza SUB dla non‑HKL org), rabat procentowy lub kwotowy klienta.
- **`prodStatus.js`** — klasa `SyncProdStatus` czyta `status.txt`, filtruje po org/user ident, upsert statusów; `setParcelHref`/`parseSpeditionNumbers` (tracking DPD/UPS/DHL).
- **`productionDays.js`** — czas realizacji. Wykrywa tkaniny kuponowe (cache atrybutów KOLOR → 14 dni), elektryczne (+5 dni), warianty slope; `computeItemProductionDays`, `buildItemProductionDays`, `recalcAndSaveMaxProdDays`.
- **`versionManager.js`** — `VersionManagerLocal`: przy pliku `{group}.ok` porównuje metadane param/paramdict per język, bumpuje wersję w DB, snapshotuje pliki do `versions/{ver}/{lang}/`. `checkVersion`, `getConfigNum` (czyta `eform.num`).
- **`languageManager.js`** — legacy manager plików tłumaczeń. `checkTranslateLegacy` (wykrywa zmiany `jezyki.xlsx`, odpala CLI `excelToJson`/`jsonToExcel`). ⚠️ *`versionFile` buggy — comma expression zwraca sam katalog.*
- **`setLanguage.js`** — `setLang`: cookie `lang` (1 rok), ograniczone do pl/en/de/nl/fr, default en.
- **`itemBuilder.js`** — `buildOrderItemStructure`: czysta fabryka znormalizowanego obiektu order-item (ceny, rabaty, json values, metadata).
- **`orderService.js`** — `jsonTextBackToMap(orderItems)`: transformer `json_parameters_desc` → grupowane tabele display (`cleanOrderItems`): buduje klucze row1/row2, separuje `SUB___`/RABAT, pomija zerowe rabaty, śledzi locked, `removeEmptyColumns`, sortuje kolumny formuł na końcu, flaguje nienumeryczne ceny jako `according_to_price`.
- **`sendOrderService.js`** — klasa `OrderSender`: buduje wychodzący JSON zamówienia (klient/adres/items/short-items), dołącza zdjęcia slope z wymiarami, `saveToFile` (short JSON + local dev / FTP `/orders-out/` prod); honoruje `ignore_mail_list` i `forceProductionSend`.
- **`logService.js`** — historia logowań: `logUserLogin` (pomija 'admin'), `getUserLoginHistory`, `getUserLoginHistoryByIdent`, `getRecentLogins`.

---

## 9. Middleware

- **`accessLock.js`** — `enforceAccessLock`: gdy locked, przepuszcza adminów + prefiksy public/static + login; niszczy sesje nie‑admin i redirect/503 na technical-break.
- **`loginMixture.js`** — zestaw auth/authz: `requireLogin`, `requirePermission` (widoczność cen), `checkOrderOwnership` (owner/group-shop/user), `isOwner` (orgIdent===userIdent), `requireOwner`, `requireGroup`, `requireGroupShop`, `addOrganizationsForAdmin` (owija res.render by wstrzyknąć listę org dla adminów).
- **`employeePermissions.js`** — RBAC pracownika: `loadEmployeePermissions` (odświeża co request), `requireSendPermission`, `filterPriceData` (`req.hidePrices`), `filterOrdersByPermission` (`req.orderFilter` all/own). Owner omija wszystko.

---

## 10. Utils
`logging.js` (log), `fileManager.js` (FS), `formatClient.js` (etykiety klienta), `hashUser.js` (hashowanie hasła), `humanize_date.js`, `getClientIp.js`, `orderStatusGuard.js`, `productionSendGuard.js`, `readWord.js` (mammoth), `saveOrdersOutput.js`, `emailFbSync.js`, `otherBossUtilities.js`, `pdfValueParts.js` (filtr PDF).

---

## 11. Szablony (Nunjucks) i frontend
- **Szablony** (`templates/*.njk`) — per rola: root (login, home, order, form, new-order, edit_order, order-pdf, order_to_print*, orders*, delivery, contact, privacy, rodo, terms, error), `admin/` (panel, orders, reports, import_log, login_history, order_corrections/), `owner/`, `user/` (employees, panel), `group/` (panel, shops, shop_form, pending_orders, shop_orders). Baza: `base.njk`.
- **Skrypty klienta** (`public/scripts/`) — struktura per rola/funkcja: `components/` (toast, generators, searchingTool, htmlManipulator, api_connector…), `formTools/` (patrz sekcja 6), `orderTools/`, `tools/` (betterNumberValidator, langChanger), `intro/` (onboarding), `admin/`, `owner/`, `group/`. Top-level: main.js, form.js, order.js, orders.js, new-order.js, edit-order.js, pdf.js, themeToggle.js, mobileCards.js, stickyColumns.js.

---

## 12. Uwagi / długi techniczny (do pilnowania)
- `db/positions.js` — połączenie otwierane na poziomie modułu, nigdy nie await/release.
- `orderImport/index.js` — auto‑send po imporcie **celowo wyłączony** (złe maile klientów). `sendAfterImport.js` istnieje ale nie jest wołany.
- `languageManager.js` — `versionFile` buggy (comma expression).
- Import recalc (Playwright) celuje w always‑on instancję na `RECALC_APP_PORT` (8081), nie w dev.
- HKL organization id = 3 (zaszyte w logice SUB/rabatów).

---

## Changelog

> Dopisuj tutaj każdą istotną zmianę: `YYYY-MM-DD — opis — pliki`.

- **2026-07-21** — Utworzenie tego dokumentu (pełna analiza projektu na moduły i funkcjonalności).
- **2026-07-27** — `admin_edit_form.js` (`forceRecalculation`): zerowanie/wykluczanie parametrów kalkulowanych przed wymuszeniem przeliczenia teraz używa `isCalculatedParam` (SOURCE lub FORMULA) zamiast pola `SCRIPTS`/`FORMULA` — dotychczasowy warunek pomijał parametry cenowe, które odwołują się do skryptu wyłącznie przez `SOURCE` (typowy przypadek), przez co stare zapisane ceny mogły przetrwać przeliczenie zamiast być zawsze nadpisane. Plik: `public/scripts/admin/admin_edit_form.js`.
- **2026-07-27** — Naprawiono błąd wyboru kolekcji cenowej podczas admin-redit: trasa `GET /position/:positionId/admin-redit/` nigdy nie ustawiała kontekstu klienta zamówienia (`ownerService.setContextUserByIdent`), więc `FormsManager`/`getOwner()` w przeglądarce dostawał kontekst admina zamiast właściciela zamówienia (np. TCN) i wybierał złą, domyślną kolekcję aliasów/skryptów cenowych (np. PG3 zamiast PG4 dedykowanej dla klienta) — dawało to kilkukrotnie zawyżone ceny SUB przy przeliczaniu zaimportowanej pozycji. Fix: przed renderem pobieramy `db.getOrderOwnerIdent(orderId)` i wołamy `ownerService.setContextUserByIdent(req, ownerIdent)`, analogicznie do `routes/orders.js` (`/userOrders`, `/order/:orderId/send-to-production`). Plik: `routes/positions.js`.
- **2026-07-28** — Naprawiono błąd „Według cennika” po imporcie: `checkIfPriceIsCorrect` (wołane bezwarunkowo na końcu każdego `updateFieldStates`) uznawała cenę za brakującą, gdy którykolwiek z `['CENA','CENA_SUMA','SUMA_BRUTTO']` był `== 0`. `SUMA_BRUTTO` to realny parametr (FORMULA) tylko w części grup — w innych (np. grupa 39, żaluzje) w ogóle nie istnieje w `param.txt`. Nowa pozycja tworzona w apce nigdy nie ustawia tego klucza (zostaje `undefined`, `undefined == 0` → `false`), ale payload importu ZAWSZE niesie ten klucz jako `""` (bo eksporter zawsze go dodaje) — a `"" == 0` → `true` w JS. Efekt: dla każdej zaimportowanej pozycji w grupach bez `SUMA_BRUTTO` `hasZero` był zawsze `true`, więc `CENA/DOPLATA/CENA_KONCOWA/WARTOSC_KONCOWA` (i przez to `total_price`/`getTotal().total`) były bezwarunkowo nadpisywane placeholderem „Według cennika” — niezależnie od tego, czy silnik poprawnie policzył realną cenę. Zweryfikowano empirycznie: prawdziwy przeliczacz Playwright (`browserRecalculator.js`, port `RECALC_APP_PORT`/8081) poprawnie liczył `CENA`/`WARTOSC_KONCOWA` (np. 159.67), po czym wynik był bezwarunkowo nadpisywany placeholderem przed zapisem. Fix: `hasZero` bierze pod uwagę tylko parametry cenowe, które faktycznie istnieją w bieżącym formularzu (`inputs[paramName] !== undefined`). Plik: `public/scripts/formTools/pricesCalculator.js`. ⚠️ Środowisko testowe pod `RECALC_APP_PORT` (kontener `eform-project_eform-test_1`, port 8081) to OSOBNA kopia kodu w `/home/pawel/projects/eform-project/volumes/test` (bind mount), nie ten checkout — fix skopiowany tam ręcznie do weryfikacji; docelowy deploy powinien objąć ten katalog normalnym pipeline'em.
- **2026-07-28** — Import cen: silnik JSDOM (`services/formEngine.calculatePrices`) w `orderImporter.js` liczy tylko wstępne/przybliżone ceny przy wstawianiu do bazy — jedynym autorytatywnym źródłem cen pozostaje przeliczenie prawdziwym `form.js` w realnej przeglądarce (Playwright, `browserRecalculator.js` → `public/scripts/recalculateOrder.js`), które i tak nadpisuje wynik po commicie. Ponieważ zamówienie jest już zacommitowane zanim Playwright w ogóle wystartuje, retry całego importu przy błędzie przeliczania groziłby zdublowaniem zamówienia — więc `recalculateOrderInBrowser` teraz sam ponawia WYŁĄCZNIE krok przeliczania w przeglądarce (domyślnie 3 próby, 5s odstępu), zwracając `{success, message, attempts}`. Jeśli wszystkie próby zawiodą, zamówienie zostaje z przybliżonymi/zerowymi cenami z JSDOM, a `index.js` dopisuje wyraźne ostrzeżenie do `result.warnings` (trafia do maila podsumowania importu) sygnalizujące konieczność ręcznego przeliczenia z panelu. Pliki: `services/orderImport/browserRecalculator.js`, `services/orderImport/index.js`.
- **2026-07-28** — Zmiana podejścia do przeliczania importu: zamiast otwierać stronę zamówienia i klikać "Przelicz wszystkie pozycje" (`recalculateOrder.js` — osobna, mniej sprawdzona reimplementacja), Playwright teraz otwiera **każdą pozycję osobno przez `/position/:id/admin-redit/`** (dokładnie ten sam, już naprawiony flow co ręczna edycja admina) i zapisuje ją (`#show-button` → `PATCH /position/edit/save`). Fix: `browserRecalculator.js` (`recalculatePositionViaAdminEdit`, iteruje po `order_item` danego zamówienia; czeka na `window.finishFlag===true && !window.isCalculating` przed kliknięciem, bo przycisk zapisu w admin-redit no‑opuje się cicho podczas liczenia).
- **2026-07-28** — Naprawiono brak/niedeterminizm ceny SUB (organizacyjnej) w admin-redit dla klientów z dedykowanym, osobnym skryptem SUB (np. TCN: `SUB___CENA=param-SUB___CENA-J.js` w `prod.txt`). Przyczyna: `SUB___CENA` **jest** prawdziwym wierszem w `param.txt` (SCRIPTS='true') i `selectPrices()` poprawnie rozwiązuje jego SOURCE — ale `form.js`'s `buildHtml` tworzy `<input>` dla `SUB___*` tylko gdy `isGroup/isGroupShop/isClient/canViewSubPrices/viewAsOrganization` jest prawdziwe, a te dwa ostatnie flagi (`services/subPriceContext.js`) zależą od *organization id* właściciela zamówienia — dla klienta typu "group" pod org HKL (id=3, jak TCN) ten check nigdy się nie włącza, mimo że TCN ma własny, odrębny cennik SUB. Bez inputa `updateFieldStates` (dysponujące po `inputs`, nie po `params`) nigdy nie wywoływało skryptu SUB, więc `SUB___CENA` zostawało czymkolwiek było w bazie wcześniej (czasem przypadkiem nadpisywane przez efekt uboczny skryptu CENA u innych klientów, stąd niedeterminizm). Fix: `admin_edit_form.js` (`enableSubPriceViewForAdminEdit`) ustawia `window.canViewSubPrices = true` i `window.hasSubPriceToggle = true` przed `generateForm()` — trasa admin-redit jest już ograniczona do adminów, więc to bezpieczne i lustrzane wobec tego, jak widoczność SUB działa dla zwykłych zamówień. `syncSubPriceDisplayEntries` (mirroring z parametru bazowego) działa teraz tylko jako fallback dla SUB___ parametrów bez własnego SOURCE/FORMULA. Zweryfikowano empirycznie na zamówieniu 272020 (4 pozycje, TCN): SUB___CENA = 490/344/566/566 (poprawne, zróżnicowane per pozycja), zamiast pustych/losowych wartości. Plik: `public/scripts/admin/admin_edit_form.js`. ⚠️ Znaleziono przy okazji: `PATCH /position/edit/save` (`routes/positions.js`) nie odświeżał zagregowanych `order.total_price`/`total_price_sub` po zapisie pojedynczej pozycji (tylko import na końcu woła `db.updateOrderPrice`) — dotyczyło to zarówno zwykłej edycji, jak i (co gorsza) naszego nowego flow admin-redit-per-pozycja, który zapisuje przez ten sam endpoint 1x na pozycję. Fix: dopisano `await db.updateOrderPrice(positionForRecalc.order_id, null)` zaraz po `db.updatePosition(...)`. Zweryfikowano na zamówieniu 272020: `order.total_price_sub` = 2678.40 = suma 4 pozycji (668.10+522.10+744.10+744.10), wcześniej zostawało 0.00. Plik: `routes/positions.js`. ⚠️ Uwaga eksploatacyjna: kontener `eform-project_eform-test_1` (cel Playwrighta pod `RECALC_APP_PORT`) trzeba było zrestartować, żeby podjął zmianę w `routes/positions.js` — Express nie przeładowuje route'ów na żywo, samo skopiowanie pliku na dysk (bind mount) nic nie zmienia bez restartu procesu Node w kontenerze.
- **2026-07-29** — Naprawiono "wieczne oczekiwanie" przeliczania niektórych pozycji przy imporcie: `setUpSaveButton` w `admin_edit_form.js` **celowo wycisza toast** dla błędu walidacji ("Validation failed" — patrz `.catch()` w setUpSaveButton), więc gdy `validateForm()` odrzuci zapis (np. brakujące wymagane pole z importu, jak `DLUGSTER` dla modelu U25SD — sender nie podał długości sterowania), `PATCH /position/edit/save` **nigdy nie jest wysyłany**, a `recalculatePositionViaAdminEdit` czekało pełne `timeout` (120s) x 3 próby x N pozycji, zanim się poddało — dla jednego zamówienia to nawet ~24 min pozornego "zawieszenia" importera. To NIE jest błąd kodu przeliczania — to prawdziwy brak wymaganych danych w payloadzie importu, wymaga ręcznej edycji pozycji. Fix: `recalculatePositionViaAdminEdit` (`browserRecalculator.js`) teraz robi `Promise.race` między prawdziwą odpowiedzią PATCH a szybkim (5s) sprawdzeniem czy pojawił się `.invalid-input` — w razie walidacji zwraca natychmiast konkretną nazwę pola(-ów) zamiast czekać na timeout. Zweryfikowano: zamówienie z brakującym `DLUGSTER` teraz failuje w ~25s (4 pozycje) z komunikatem `Walidacja formularza nie powiodła się — brakujące/niepoprawne pole(a): DLUGSTER`, zamiast bezsensownych 8 minut na próbę. Plik: `services/orderImport/browserRecalculator.js`.
- **2026-07-29** — Potwierdzono empirycznie (kontrolowany eksperyment przed/po na tej samej pozycji, zamówienie 271837/2819), że SUB___* liczy się dokładnie tym samym mechanizmem co CENA — w tym samym `updateFieldStates`, w tym samym momencie, tylko innym skryptem/cennikiem. Jedyną przeszkodą był brak wymaganego pola sterowania. Naprawiono źródłowo: `DLUGSTER`/`DLUGOSC_STER` to dwie nazwy tego samego pojęcia ("długość sterowania"), wzajemnie wykluczające się przez `ENABLE` zależne od `MODEL` (każde aktywne dla innego, rozłącznego zestawu modeli) — więc dla danej pozycji zawsze dokładnie jedno z nich jest wymagane. Gdy sender (TCN/Eurogordijn) nie poda żadnego z nich, import teraz sam dolicza wartość domyślną: 2/3 z `WYSOKOSC`, zaokrąglone w dół do pełnych setek — ustawiane w OBU polach naraz (skoro nie wiadomo z góry, które z nich aktywuje `MODEL` danej pozycji; nieużywane pole i tak nie jest czytane/walidowane). Fix: `seedControlLengthDefault()` w `orderImporter.js`, wołane w pętli per-pozycja tuż przed `seedDictionaryDescriptions`. Zweryfikowano na zamówieniu 271837 (4 pozycje modelu U25SD, wszystkie bez DLUGSTER w źródle): po zastosowaniu defaultu wszystkie 4 pozycje policzyły i zapisały CENA oraz SUB___CENA poprawnie (68.4/340, 64.9/319, 58.16/294, 98.53/518), `order.total_price_sub` = 1536.00 = dokładna suma pozycji. Plik: `services/orderImport/orderImporter.js`. ⚠️ Wymaga restartu `eform-import.service` (`npm run import:restart`), żeby zacząć obowiązywać dla realnych importów — brak uprawnień sudo, żeby zrobić to samodzielnie w tym środowisku.
- **2026-07-29** — Naprawiono brak widocznej sumy SUB przy oglądaniu zamówienia w panelu: `templates/order.njk` pokazuje sekcję SUB tylko gdy `isGroup`/`canViewSubPrices`/`viewAsOrganization` (`services/subPriceContext.js`) jest prawdziwe, a te flagi zależą całkowicie od `req.session.context_user` — który nigdy nie był ustawiany, gdy admin otwierał zamówienie bezpośrednio (bez wcześniejszego przełączenia klienta przez `/orders/userOrders`). Efekt: cała sekcja SUB (razem z przełącznikiem odsłaniającym) była nieobecna w HTML-u, mimo że `order.total_price_sub` w bazie było już poprawnie policzone. Fix: `GET /orders/order/:orderId` (`routes/orders.js`) teraz automatycznie ustawia kontekst na właściciela zamówienia (ten sam mechanizm co w admin-redit, `routes/positions.js`) i ponownie woła `applySubPriceLocals(req, res)` (bo globalny middleware w `server.js` uruchomił je wcześniej, ze starym kontekstem). Zweryfikowano na zamówieniu 2822 (TCN): suma SUB (384.00) i wartości per-pozycja (192/192) są teraz obecne w renderowanym HTML (schowane za standardowym przełącznikiem "pokaż SUB", tak jak dla zwykłych zamówień) — wcześniej nieobecne całkowicie. Plik: `routes/orders.js`. ⚠️ Znaleziono przy okazji (nie naprawione): otwarcie `/orders/order/:id` dla **usuniętego** zamówienia crashuje serwer dev (`node --watch server.js`, port 8000) — pre-existing bug niezwiązany z tą zmianą, ujawniony przypadkiem podczas testów na usuniętym zamówieniu testowym.
- **2026-07-29** — `contractors.txt` doszła kolumna `KRAJ`. Dodano `syncUserCountry(pin)` w `services/dbUserSync.js` — odczytuje `contractors.txt`, znajduje wiersz po PIN, i jeśli `kraj` różni się od `user.country` w bazie, nadpisuje kolumnę. Wywoływane fire-and-forget (bez `await`, żeby nie dodawać opóźnienia odczytu/parsowania pliku do logowania) z `services/authService.js` (`handleAuthLogin`) przy każdym udanym logowaniu klienta — niezależnie od pełnej, okresowej synchronizacji `updateClients()`. Powód: `country` steruje wykrywaniem języka gdzie indziej (np. `userResolver.js` przy imporcie zamówień), więc ma być zawsze aktualne per-user, bez czekania na cykliczny sync całego `contractors.txt`. Zweryfikowano: ręcznie ustawiona zła wartość (`XX`) w bazie została poprawnie wykryta i nadpisana z powrotem na `NL` z pliku. Pliki: `services/dbUserSync.js`, `services/authService.js`.
- **2026-07-29** — Naprawiono `db.getUsers()` (`db/users.js`): SELECT nie pobierał kolumn `phone` ani `country` (aliasowanej jako `kraj`), mimo że `compareClients()`/`fieldsToCheck` w `dbUserSync.js` porównują właśnie te dwa pola przy pełnej synchronizacji `contractors.txt`. Efekt: `dbClient.phone`/`dbClient.kraj` były zawsze `undefined`, więc KAŻDY klient z niepustym telefonem/krajem w pliku zgłaszał się jako "do aktualizacji" przy każdym cyklu `updateClients()` — niepotrzebne zapisy do bazy przy każdym sync-u, nawet gdy dane się nie zmieniły. Fix: dodano `phone` i `country AS kraj` do SELECT-a. Zweryfikowano na pełnym pliku (1927 dopasowanych klientów): przed fixem wszystkie zgłaszałyby się jako mismatch dla `kraj`/`phone`, po fixie 0 fałszywych rozbieżności. Plik: `db/users.js`.
- **2026-07-29** — Dodano `services/vatCalculator.js`: wylicza stawkę VAT wg zasad UE — sprzedaż krajowa (kraj organizacji == kraj zalogowanego usera) → stawka VAT tego kraju (tabela `EU_VAT_RATES`, 27 państw UE); sprzedaż zagraniczna (kraje różne) → 0% (zwolnienie). `resolveVatRateForUser(userId, orgId)` pobiera oba kraje z bazy (`user.country`, `organization.country`) i zwraca `{vatRate, userCountry, organizationCountry}`. Wpięte w `GET /orders/order/:orderId/new-position/` (`routes/orders.js`) — liczone dla zalogowanego/kontekstowego usera (`ownerService.getCurrentUser`) i przekazywane do `form.njk` jako `vatRate` (na razie tylko dostępne w kontekście render — szablon jeszcze nic z tym nie robi, do dopisania osobno gdy będzie potrzebne wyświetlenie/użycie w formularzu). Zweryfikowano: TCN (country=NL) vs organizacja HKL (country=PL) → różne kraje → 0%; PL/PL → 23%. Pliki: `services/vatCalculator.js`, `routes/orders.js`.
- **2026-07-29** — Rozszerzono `vatCalculator.js` (na prośbę o precyzję): tabela stawek przemianowana z `EU_VAT_RATES` na `VAT_RATES_BY_COUNTRY` (dawna nazwa zostaje jako alias) i rozszerzona o kraje spoza UE z własnym VAT-em obecne w bazie klientów (`CH: 8.1`, `NO: 25`) — sama reguła "ten sam kraj = stawka tego kraju" nie może zależeć od członkostwa w UE. Dodano `EU_MEMBER_COUNTRIES` (27 państw) używane wyłącznie do etykietowania POWODU zwolnienia (`calculateVatDetails()` zwraca `{vatRate, reason: 'domestic'|'eu-reverse-charge'|'export'|'unknown'}`) — sama liczba (0%) jest taka sama, ale `reason` rozróżnia unijny reverse-charge od eksportu poza UE, co ma znaczenie dla opisu na fakturze. Stawki zweryfikowane na 2026 przez WebSearch/WebFetch (Tax Foundation, ASD Group, VATupdate) — poprawiono dwie nieaktualne: Estonia 22%→24% (podwyżka VII 2025), Rumunia 19%→21%. `routes/orders.js` przekazuje teraz też `vatReason` do `form.njk`.
- **2026-07-30** — Naprawiono niemożność pobrania załączników PDF w mailu z potwierdzeniem zamówienia na natywnej aplikacji Poczta w iOS: nazwa głównego załącznika była budowana jako `${__('history_order.title')}${orderNr}.pdf`, co dla PL daje np. `Zamówienie nr.2819.pdf` — spacja i polski znak diakrytyczny (ó) w nazwie pliku. Mimo że nodemailer poprawnie koduje `Content-Disposition` wg RFC 2231/5987, Apple Mail bywa niekonsekwentne w parsowaniu takich nazw i potrafi pokazać załącznik bez możliwości jego otwarcia/zapisania — podczas gdy Gmail/Outlook/webmail radzą sobie bez problemu, co pasuje do zgłoszenia (widać maila, nie da się pobrać załącznika na iPhonie). Fix: nowy `utils/sanitizeFilename.js` (transliteruje `ł/Ł`, usuwa znaki diakrytyczne przez `normalize('NFD')` + strip combining marks, resztę non-alfanumeryczną zamienia na `_`, zachowuje tylko końcowe rozszerzenie) — zastosowany w `services/mailBot/mailBot.js` (główny PDF zamówienia + wszystkie załączniki z `attachmentsBuffer`, współdzielone przez `sendMail`/`sendCorrectionMail` via `buildMailOptions`) oraz w `services/mailBot/extraAttachments.js` (zdjęcia żaluzji/dodatkowe załączniki). Nie dotknięto `pdfGenerator.js`'s `uploadProductionPdf` (nazwa pliku tam to wewnętrzna nazwa na FTP produkcyjny, nie nazwa załącznika widziana przez klienta) ani `routes/orders.js`'s bezpośredniego pobierania PDF z przeglądarki (`zamowienie_${id}.pdf` — już czysty ASCII). Zweryfikowano: `sanitizeFilename('Zamówienie nr.2819.pdf')` → `'Zamowienie_nr_2819.pdf'`. Pliki: `utils/sanitizeFilename.js` (nowy), `services/mailBot/mailBot.js`, `services/mailBot/extraAttachments.js`.
- **2026-07-29** — **Ważne odkrycie**: `config.js`'s `localesDir` (`process.env.LOCALES_DIR || '/mnt/eform/languages' || path.join(__dirname, 'locales')`) faktycznie zawsze zwraca `/mnt/eform/languages` — drugi człon `||` (`path.join(__dirname, 'locales')`) to martwy kod, bo pierwszy string jest zawsze prawdziwy. `GET /translations` (`routes/index.js`, źródło danych dla `window.t()` używanego w JS przeglądarki, w tym `form.vat_label`/`form.wartosc_brutto_label`/`form.wartosc_vat_label`) czyta więc `{lang}.json` z `/mnt/eform/languages`, NIE z repo `locales/*.json`. Dotychczasowe edycje `locales/{pl,en,de,fr,nl}.json` w repo są więc *dokumentacyjne/dla przyszłego syncu*, ale nie trafiają od razu do przeglądarki — stąd `form.wartosc_vat_label` (i wcześniej `form.wartosc_brutto_label`) pokazywały się jako surowy klucz zamiast tłumaczenia, dopóki nie dopisano ich też bezpośrednio do plików w `/mnt/eform/languages/*.json` (zrobione teraz tym samym zestawem tłumaczeń co w repo). Docelowo `languageManager.js`'s `checkTranslateLegacy` (wołane przy każdym logowaniu) powinno w końcu zsynchronizować te pliki z `jezyki.xlsx` samo, ale nie należy na to liczyć przy pilnych zmianach — trzeba dopisywać klucz w obu miejscach: `locales/*.json` (repo) ORAZ `/mnt/eform/languages/*.json` (serwowane na żywo). Plik: `/mnt/eform/languages/{pl,en,de,fr,nl}.json`.
- **2026-07-29** — Dodano trzecie pole VAT-owe — WARTOŚĆ VAT (kwota VAT w walucie, `WARTOSC_BRUTTO - WARTOSC_KONCOWA`), umieszczone między stawką VAT a WARTOŚCIĄ BRUTTO — na dokładnie tych samych zasadach co pozostałe dwa: `buildVatFields()` (`form.js`) tworzy input `#WARTOSC_VAT` (disabled, domyślnie '0', pomijany razem z resztą gdy `vatRate===0`) między `#VAT` a `#WARTOSC_BRUTTO`; `applyVatToGrossValue()` (`pricesCalculator.js`) liczy `vatValue = grossValue - netValue` i zapisuje go do `values`/inputa oraz do `displayValues` pod kluczem `WARTOSC_VAT` (HKL, `row:'2'`) albo `SUB___WARTOSC_VAT` (pozostali klienci, `sub:true`, `row:'2'`) — identyczna konwencja jak `VAT`/`SUB___VAT` i `WARTOSC_BRUTTO`/`SUB___WARTOSC_BRUTTO`. Dodano tłumaczenia klucza `form.wartosc_vat_label` do `locales/{pl,en,de,fr,nl}.json` oraz do `jezyki.xlsx` (kopia zapasowa przed zapisem, jak poprzednio). Pliki: `public/scripts/form.js`, `public/scripts/formTools/pricesCalculator.js`, `locales/*.json`, `/mnt/eform/languages/jezyki.xlsx`.
- **2026-07-29** — Rozszerzono logikę VAT (pola VAT/WARTOŚĆ BRUTTO) z formularza "nowa pozycja" na oba flow edycji pozycji — zwykłą edycję (`edit_form.js`/`edit_position.njk`) i admin-redit (`admin_edit_form.js`/`admin_edit_position.njk`) — wcześniej istniały tylko przy tworzeniu nowej pozycji (`main.js`). Zmiany: 1) `routes/positions.js` — nowa współdzielona `resolveVatLocals(req)` (ta sama logika co `routes/orders.js`: `resolveVatRateForUser` + `isHklOrg = orgId===3`), wołana w `GET /:positionId/edit/` oraz w `GET /:positionId/admin-redit/` (w tym drugim przypadku PO `setContextUserByIdent`, żeby liczyć dla właściciela zamówienia, nie admina) — obie trasy przekazują teraz `vatRate`/`vatReason`/`isHklOrg` do szablonu. 2) `edit_position.njk`/`admin_edit_position.njk` — dopisano identyczny inline-skrypt `window.vatRate/vatReason/isHklOrg` co w `form.njk`. 3) `edit_form.js`/`admin_edit_form.js` — wołają `buildVatFields()` (tak jak `main.js`); dla zwykłej edycji dodatkowo od razu `applyVatToGrossValue(editValues, editValuesToDisplay)` po zbudowaniu pól, bo zapisana pozycja ma już policzone ceny i nie ma się co czekać na pierwszą interakcję użytkownika, żeby WARTOŚĆ BRUTTO przestała pokazywać domyślne '0'; dla admin-redit `buildVatFields()` wołane jest PRZED `forceRecalculation()` (a nie po, jak reszta pól typu comment), żeby `#WARTOSC_BRUTTO` istniało w DOM, zanim standardowy pipeline `updateFieldStates` (wyzwolony przez `forceRecalculation`) wywoła `applyVatToGrossValue()` — w przeciwnym razie pole zostałoby puste aż do kolejnej ręcznej zmiany. Pliki: `routes/positions.js`, `templates/edit_position.njk`, `templates/admin_edit_position.njk`, `public/scripts/edit_form.js`, `public/scripts/admin/admin_edit_form.js`.
- **2026-07-29** — Dostosowano wpisy VAT/WARTOŚĆ BRUTTO w `displayValues` do nomenklatury pozostałych parametrów cenowych: wcześniej tylko `WARTOSC_BRUTTO` trafiało do `displayValues` (pole VAT w ogóle nie było tam zapisywane), zawsze pod stałym kluczem, bez flagi `sub`. Teraz `applyVatToGrossValue()` (`pricesCalculator.js`) zapisuje OBA pola (VAT i WARTOŚĆ BRUTTO): dla HKL pod zwykłymi kluczami `VAT`/`WARTOSC_BRUTTO` z `row: '2'` (tak samo jak `CENA`/`CENA_SUMA`/`SUMA_BRUTTO`/`WARTOSC_KONCOWA`, które w `param.txt` też mają `LISTROW=2`); dla klientów innych niż HKL pod kluczami `SUB___VAT`/`SUB___WARTOSC_BRUTTO` z `sub: true` i `row: '2'` — dokładnie taki sam kształt wpisu, jaki dostają prawdziwe parametry `SUB___CENA`/`SUB___SUMA_BRUTTO` (przez `buildValuesToDisplay`/`hideSub`), więc VAT/WARTOŚĆ BRUTTO grupują się wizualnie i przy sumowaniu (`getTotal()`, które rozpoznaje SUB po fladze `sub` lub prefiksie klucza) razem z resztą cen SUB, a nie z cenami zwykłymi. Plik: `public/scripts/formTools/pricesCalculator.js`.
- **2026-07-29** — Naprawiono WARTOŚĆ BRUTTO zablokowane na 0 dla klienta HKL (NaOkniePL, org id 3, potwierdzone w DB: `user.organization_id=3`, `order.organization_id=3`, `order.total_price_sub` zawsze `0.00`): `applyVatToGrossValue()` czytała WYŁĄCZNIE parę kluczy dopasowaną do `window.isHklOrg` — dla HKL para `SUMA_BRUTTO`/`WARTOSC_KONCOWA` (bez `SUB___`), inaczej para `SUB___SUMA_BRUTTO`/`SUB___WARTOSC_KONCOWA`. Zweryfikowano w DB (zamówienie 2573, pozycja grupy 59, klient HKL): `SUB___SUMA_BRUTTO`/`SUB___WARTOSC_KONCOWA` są tam `undefined` (HKL nigdy nie ma renderowanych inputów SUB___, patrz `nonHklOrg` w `subPriceContext.js`), więc jeśli `window.isHklOrg` z jakiegokolwiek powodu (błędne wykrycie po stronie serwera, stan przeglądarki) nie było `true` w danej sesji, funkcja czytała nieistniejącą parę SUB___ i zwracała się wcześniej (`NaN`), zostawiając `WARTOSC_BRUTTO` na domyślnym `'0'`. Fix: funkcja teraz próbuje najpierw pary dopasowanej do `isHklOrg`, a jeśli obie wartości są niedostępne — automatycznie pary przeciwnej, zanim się podda (brak wartości w drugiej parze to normalna sytuacja dla HKL, a nie błąd, więc taki fallback nie psuje pozostałych organizacji — część grup non-HKL też w ogóle nie definiuje `SUB___SUMA_BRUTTO` w `param.txt`). Plik: `public/scripts/formTools/pricesCalculator.js`.
- **2026-07-29** — Dodano warunek organizacji do liczenia VAT: dla HKL (org id = 3 — organizacja "domowa", dla której `SUB___` w ogóle nie ma zastosowania, patrz `nonHklOrg` w `services/subPriceContext.js`) `applyVatToGrossValue()` liczy VAT z **zwykłego** `SUMA_BRUTTO`/`WARTOSC_KONCOWA` (bez prefiksu `SUB___`), bo to dla HKL jest cena klienta — a nie z `SUB___SUMA_BRUTTO`/`SUB___WARTOSC_KONCOWA`, które dla tej organizacji nie są liczone. Rozpoznanie organizacji: `routes/orders.js` (`GET /order/:orderId/new-position/`) liczy `isHklOrg = Number(currentUser?.orgId) === 3` z tego samego `currentUser` (uwzględniającego kontekst admina), co `resolveVatRateForUser()`, i wstrzykuje `window.isHklOrg` inline-skryptem w `form.njk`, analogicznie do `vatRate`/`vatReason`. Pliki: `routes/orders.js`, `templates/form.njk`, `public/scripts/formTools/pricesCalculator.js`.
- **2026-07-29** — `buildVatFields()` (`public/scripts/form.js`) teraz w ogóle NIE tworzy pól VAT i WARTOŚĆ BRUTTO (nie tylko ukrywa je przez CSS), gdy `window.vatRate === 0` (sprzedaż zagraniczna/eksport — `vatReason` `eu-reverse-charge`/`export`/`unknown`) — pola te nie mają sensu przy stawce 0%, więc `buildVatFields()` zwraca wcześnie `{}` bez dotykania DOM. `applyVatToGrossValue()` (`pricesCalculator.js`) już wcześniej no-opowała, gdy `#WARTOSC_BRUTTO` nie istnieje w DOM, więc nie wymagało to zmian po jej stronie. `window.vatRate` jest ustalane raz przy renderze strony (server-side, `resolveVatRateForUser()`) i nie zmienia się w trakcie sesji formularza. Plik: `public/scripts/form.js`.
- **2026-07-29** — Uzupełniono tłumaczenia kluczy `form.vat_label`/`form.wartosc_brutto_label` w master pliku `jezyki.xlsx` (`/mnt/eform/languages/jezyki.xlsx`, arkusz `Translations`, kolumny `key,de,en,pl,fr,nl`) — klucze były wcześniej dodane tylko bezpośrednio do `locales/*.json` (patrz wpis 2026-07-29 "Frontend VAT"), ale nie do xlsx, który jest źródłem prawdy dla `languageManager.js`/`checkTranslateLegacy` (kolejny przebieg legacy-sync nadpisałby/zresetował JSON-y z xlsx i zgubił te dwa klucze). Dopisano wiersze `form.vat_label` (MWST/VAT/VAT/TVA/BTW `[%]`) i `form.wartosc_brutto_label` (BRUTTOWERT/GROSS VALUE/WARTOŚĆ BRUTTO/VALEUR BRUTE/BRUTOWAARDE `[€]`) na końcu arkusza (wiersze 643–644), identycznie jak wartości już obecne w `locales/*.json`. Przed zapisem zrobiono kopię zapasową oryginału (`jezyki.backup-20260729-152419.xlsx`, ten sam katalog, zgodnie z istniejącą konwencją nazewnictwa backupów). Plik: `/mnt/eform/languages/jezyki.xlsx`.
- **2026-07-29** — Poprawiono źródło VAT: `applyVatToGrossValue()` (`pricesCalculator.js`) liczyła VAT na bazie `SUB___WARTOSC_KONCOWA`, ale właściwym polem jest `SUB___SUMA_BRUTTO` — mimo nazwy ("BRUTTO" = wartość z VAT) jest to pole czysto netto (FORMULA `SUB___CENA_SUMA * ILOSC`, bez doliczonego VAT, analogicznie do niepoprawnie nazwanego `SUMA_BRUTTO` dla cen zwykłych). Fix: `applyVatToGrossValue()` teraz bierze `SUB___SUMA_BRUTTO` (z fallbackiem na `SUB___WARTOSC_KONCOWA` dla grup, które nie definiują `SUB___SUMA_BRUTTO` w `param.txt`, np. grupa 39). Pliki: `public/scripts/formTools/pricesCalculator.js`, `public/scripts/form.js` (komentarz), `templates/form.njk` (komentarz).
- **2026-07-29** — **Korekta dokumentacji**: parametry `SUB___` (SUB / ceny SUB) to ZAWSZE cena klienta, NIE cena organizacyjna — wcześniejsze wpisy w tym dokumencie (sekcja "Słownik domenowy" oraz kilka wpisów Changelog powyżej) błędnie opisywały SUB jako "ceny organizacyjne"/"organizacyjną" warstwę cenową. Poprawiono definicje w sekcji 1 (Słownik domenowy) i opis `subPrices.js`; starsze wpisy Changelog powyżej pozostają niezmienione jako zapis historyczny przebiegu prac, ale ich sformułowanie "SUB (organizacyjnej/organizacyjnej ceny)" należy czytać jako "SUB (cena klienta)". Nie wymagało to żadnej zmiany w kodzie — `applyVatToGrossValue()` już poprawnie liczy VAT na bazie `SUB___WARTOSC_KONCOWA` właśnie dlatego, że to pole reprezentuje cenę klienta.
- **2026-07-29** — Frontend VAT: dodano pole VAT (nieedytowalne, wypełniane z `window.vatRate`) i pole WARTOŚĆ BRUTTO (nieedytowalne, wyliczane) na stronie nowej pozycji (`form.njk` → `main.js`). Przepływ: `routes/orders.js` (`GET /order/:orderId/new-position/`) liczy `resolveVatRateForUser()` i wstrzykuje `window.vatRate`/`window.vatReason` inline-skryptem w `form.njk` (⚠️ musiał być filtrowany przez `| dump | safe`, nie samym `| dump` — Nunjucks domyślnie escapuje HTML, więc string zamieniał się w `&quot;domestic&quot;`, co psuło **cały** blok `<script>` łącznie z poprawną linią `vatRate` w tym samym tagu — wykryte i naprawione empirycznie). `form.js` (`buildVatFields()`) tworzy oba pola tym samym wzorcem co `buildCommentSpace()` (pole poza schematem `param.txt`), wołane z `main.js` zaraz po `generateForm()`. `pricesCalculator.js` (`applyVatToGrossValue()`) — wołane z `updateFieldsAndValues.js`'s `updateFieldStates()` tuż po przebiegu formuł (przed `checkIfPriceIsCorrect`) — bierze `SUB___WARTOSC_KONCOWA`, dolicza VAT (`window.vatRate`) i wpisuje wynik do pola WARTOSC_BRUTTO; no-op (nic nie robi, nic nie zapisuje do `values`/`displayValues`) gdy pole nie istnieje w DOM — więc edit_form.js/admin_edit_form.js (które nie wołają `buildVatFields()`) nie dostają śmieciowego klucza `WARTOSC_BRUTTO`. Zweryfikowano: `window.vatRate=23`/`vatReason='domestic'` dla admina (PL/PL), pole `#VAT` renderuje "23%" i jest `disabled`, pole `#WARTOSC_BRUTTO` istnieje i jest `disabled`. Nie zweryfikowano na żywo z realną, niezerową ceną (dostępne testowe zamówienia miały akurat wyzerowane `SUB___WARTOSC_KONCOWA` wskutek wcześniejszego czyszczenia danych testowych w tej sesji) — sama arytmetyka (`net * (1 + vat/100)`) jest trywialna i zweryfikowana przez inspekcję kodu. Pliki: `templates/form.njk`, `public/scripts/form.js`, `public/scripts/main.js`, `public/scripts/formTools/pricesCalculator.js`, `public/scripts/formTools/updateFieldsAndValues.js`, `locales/{pl,en,de,fr,nl}.json` (nowe klucze `form.vat_label`, `form.wartosc_brutto_label`).
