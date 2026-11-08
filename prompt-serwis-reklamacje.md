# Zadanie: moduł „Serwis” w eForm (zgłoszenia reklamacyjne i serwisowe)

## Kontekst
eForm to portal zleceń produkcyjnych (Express + Nunjucks + vanilla JS + MySQL bez ORM). Dziś problemy z dostarczonym towarem klienci zgłaszają mailem i telefonem, bez numeru zlecenia, bez zdjęć i bez wskazania pozycji. Dział serwisu HKL musi potem o to dopytywać.

Cel: klient w 2 minuty, także z telefonu na budowie, zgłasza problem z konkretnymi pozycjami konkretnego zlecenia, ze zdjęciami. Zgłoszenie trafia do bazy reklamacji HKL kompletne, więc serwis nie musi o nic dopytywać. Klient widzi potem numer i status swojego zgłoszenia.

Zlecenie od szefa (Krzysztof Krawczyk), słowo w słowo:
> Musimy dodać do efora funkcjonalność serwis. W nim kilka opcji typu: 1. Naprawa 2. Zgłoszenie problemu tech (reklamacja) 3. Uszkodzenie w transporcie 4. Zapytanie o dostawę. Do zgłoszenia obligo komisja, nr zam o ile jest pod ręką. Z efora zgłoszenie musi trafić do bazy reklamacji HKL. Także dodać kolekcje do zamówienia. Kolekcja plis, rollo, ff itd.

## Zanim zaczniesz
1. Przeczytaj `PROJECT_OVERVIEW.md` (sekcje 3–6, 8: „mailBot”, „Auth i sesja”, „Sync i pozostałe”, oraz 9) i pamięć projektu (MEMORY.md). Są tam twarde zasady środowiska.
2. Pracuj w trybie planowania. Najpierw rozpoznanie i plan z listą plików, dopiero potem kod. Decyzje z sekcji „Decyzje właściciela” są podjęte, nie pytaj o nie ponownie. Pytaj tylko o punkty z sekcji „Otwarte pytania” i o to, czego nie da się rozstrzygnąć z kodu.
3. Najmniejsza kompletna zmiana. Najpierw sprawdź listę „Co już istnieje” i rozszerzaj to, co jest. Nowy kod pisz tylko tam, gdzie nic nie pasuje.

## Decyzje właściciela (7.11.2026)
1. **Wejście:** pozycja menu „Serwis” (dla klienta podpis „Mam problem z zamówieniem”) oraz przycisk „Zgłoś problem” w podglądzie wysłanego zlecenia i w wierszu listy zleceń wysłanych. Przycisk z podglądu otwiera kreator z wybranym już zleceniem.
2. **Kreator w 4 krokach** z paskiem postępu, powrót bez utraty danych: **1. Zlecenie → 2. Rodzaj i pozycje → 3. Opis i zdjęcia → 4. Podsumowanie i wysyłka.**
3. **Lista zleceń w kroku 1:** domyślnie zakładka „Dostarczone” = `status='sent'` i `prod_status='!sent!'` (to jest „100%”). Druga zakładka „W realizacji” to pozostałe wysłane, nieanulowane zlecenia. Dla nich dostępny jest tylko rodzaj 4 (zapytanie o dostawę). Pozostałe rodzaje są widoczne, ale wyszarzone, z krótkim wyjaśnieniem dlaczego. Wyszukiwanie po numerze, komisji, odbiorcy końcowym i dacie. Domyślny zakres: ostatnie 24 miesiące.
4. **„Nie mam numeru zlecenia”:** link nad listą. Prowadzi do zgłoszenia bez zlecenia z eForm (np. zamówienie złożone telefonicznie albo sprzed eForm). Wtedy wymagane są: komisja, kolekcja (wybór z listy) i opis. Pole „Numer zamówienia” jest wolnym tekstem i jest opcjonalne.
5. **Komisja jest zawsze obowiązkowa.** Przy zleceniu z listy pole wypełnia się z `order.commision`, ale klient może je poprawić. Puste pole blokuje wysyłkę.
6. **Kolekcja = `department`** (PLISY, ŻALUZJE, ROLETY, VERTIKAL, KOMPONENTY, RAMKA MAGNETYCZNA, RZYMSKIE, ZASŁONY, MOSKITIERY, PANELE), połączona z grupą produktu przez `product_group.department_id`. Przy pozycjach ze zlecenia kolekcja wylicza się sama i nie zapisujemy jej w zleceniu. Przy zgłoszeniu bez zlecenia klient ją wybiera. Kolekcja jest widoczna w tabeli pozycji kreatora i w eksporcie do HKL.
7. **Pozycje:** tabela pozycji zlecenia z checkboxami („zaznacz wszystkie”). Kolumny: nr pozycji (z podpozycjami `1-1`), kolekcja, grupa, krótki opis (wymiary, kolor/tkanina), ilość, data wysyłki i nr paczki z `position_statuses`. Przy zaznaczonej pozycji pojawiają się: „ilość, której dotyczy” (domyślnie cała, nie więcej niż `ILOSC`), kategoria problemu i opcjonalna uwaga do pozycji.
8. **Reguły per rodzaj** (walidacja w przeglądarce i na serwerze, jedna definicja reguł dla obu stron):

   | Rodzaj | Zlecenie | Pozycje | Kategoria | Opis | Zdjęcia |
   |---|---|---|---|---|---|
   | 1 Naprawa | „Dostarczone” lub bez numeru | min. 1, gdy jest zlecenie | per pozycja | wymagany | zalecane |
   | 2 Reklamacja techniczna | „Dostarczone” lub bez numeru | min. 1, gdy jest zlecenie | per pozycja | wymagany | min. 1 |
   | 3 Uszkodzenie w transporcie | „Dostarczone” lub bez numeru | min. 1, gdy jest zlecenie | per pozycja | wymagany | min. 2 (opakowanie + produkt) |
   | 4 Zapytanie o dostawę | dowolne wysłane, nieanulowane, lub bez numeru | opcjonalne | jedna na zgłoszenie | opcjonalny | brak |

   Kategorie (do przetłumaczenia, lista w jednym miejscu):
   - **Reklamacja techniczna i Naprawa:** mechanizm/obsługa nie działa; wada tkaniny/materiału; niezgodny wymiar; niezgodny kolor/model; brak elementu lub akcesorium; napęd elektryczny/sterowanie; mocowanie/montaż; inne.
   - **Transport:** uszkodzone opakowanie i produkt; produkt uszkodzony przy całym opakowaniu; brak paczki lub części przesyłki; inne.
   - **Dostawa:** kiedy dostawa; paczka nie dotarła; inne.
9. **Naprawa:** checkbox „Proszę o wycenę przed naprawą, jeśli nie jest objęta gwarancją”, domyślnie zaznaczony. Sprawdzenia gwarancji nie robimy. Eksport podaje tylko wiek zlecenia w dniach, decyzję podejmuje HKL.
10. **Transport:** pola „Data dostawy” (domyślnie `shipping_date` pozycji) i „Uszkodzenie odnotowano u kuriera / w protokole” (tak/nie). Gdy od daty dostawy minęło więcej niż 7 dni, pokaż ostrzeżenie. Wysyłki nie blokuj.
11. **Zapytanie o dostawę:** zanim pokażesz formularz, wyświetl to, co już wiemy: status produkcji, planowaną datę, numery paczek z linkiem do śledzenia (`prodStatus.setParcelHref`). Dopiero pod tym przycisk „To nie odpowiada na moje pytanie, wyślij zapytanie”. Tak robią porządne portale i to odciąża serwis.
12. **Kontakt:** osoba kontaktowa i telefon są wymagane, e-mail wypełnia się z konta. Opcjonalny adres, pod którym jest produkt, jeśli inny niż adres dostawy zlecenia. Odbiorca końcowy wypełnia się ze zlecenia.
13. **Zdjęcia i pliki:** do 10 plików na zgłoszenie, każdy do 20 MB: JPG, PNG, HEIC, WEBP, PDF, MP4/MOV. Na telefonie przycisk aparatu (`accept="image/*"` + `capture`), na komputerze przeciągnij i upuść. Miniatury z możliwością usunięcia przed wysyłką. Limity widoczne od razu, nie dopiero w komunikacie o błędzie.
14. **Numer zgłoszenia:** `SRV-<rok>-<id z dopełnieniem do 5 cyfr>`, np. `SRV-2026-00042`. Liczony z AUTO_INCREMENT, bez osobnego licznika.
15. **Po wysyłce:** ekran potwierdzenia z numerem i informacją, co dalej. Mail do klienta z numerem i podsumowaniem. Mail do serwisu HKL (decyzja 18). Brak terminu odpowiedzi (SLA), dopóki szef go nie poda.
16. **„Moje zgłoszenia”:** lista (numer, data, rodzaj, zlecenie, komisja, status, ostatnia zmiana) i podgląd z osią czasu. Dopóki zgłoszenie nie jest zamknięte, klient może dodać informację (tekst i zdjęcia). Dopisek idzie do HKL tym samym kanałem co zgłoszenie.
17. **Kto zgłasza:** każdy, kto widzi zlecenie. Zakres = te same zasady co listy zleceń (`scopeFromRequest`/`scopeWhere` w `services/assistant/tools.js`): klient, kontekst ownera/admina, pracownik (bez „Wszystkie zamówienia” tylko swoje), sklep grupy (swoje), grupa (zlecenia swoich sklepów). W zgłoszeniu zapisz, kto je faktycznie złożył (ident zalogowanego, pracownik, ewentualnie admin w kontekście). Jeśli rola `staff` z `prompt-biuro-staff.md` jest już wdrożona, staff zgłasza za dozwolonego klienta. Jeśli nie, pomiń.
18. **Mail do serwisu:** adres tylko z `.env`: `SERVICE_NOTIFY_EMAIL` plus opcjonalnie per marka `SERVICE_NOTIFY_EMAIL_<IDENT_ORG>`. Bez fallbacku na `organization.email` (to skrzynki zamówień produkcji), tak jak `ASSISTANT_HANDOFF_EMAIL`. Reply-To = mail klienta. Przekierowania maili w środowiskach testowych obowiązują.
19. **Język:** klient pisze po swojemu. Do HKL idzie oryginał plus tłumaczenie na polski (`mailBot/commentTranslator.translateToPolish`, przy błędzie sam oryginał).
20. **Konto demo:** przechodzi cały kreator, a zgłoszenie zapisuje się i widać je w „Moich zgłoszeniach”. Nie idzie żaden eksport ani mail, decyduje bramka po właścicielu zlecenia (`isDemoIdent`), jak przy wysyłce. Zamiatarka demo usuwa zgłoszenia i pliki konta demo.
21. **Włącznik:** `SERVICE_ENABLED=true|admins` (wzorzec `ASSISTANT_ENABLED`: `admins` = pilotaż tylko dla adminów; wyłączony = router nie jest montowany i menu nie pokazuje pozycji).
22. **Ceny:** zgłoszenie, eksport i maile NIE zawierają cen.

## Otwarte pytania (Etap 0: zadaj je właścicielowi, nie zgaduj)
1. **„Baza reklamacji HKL”: co to jest i jak do niej zapisywać?** (osobna baza MySQL/MSSQL, API, program czytający pliki z FTP, skrzynka mailowa?) Kto ją obsługuje i czy oddaje statusy z powrotem? Do czasu odpowiedzi budujesz domyślny kanał opisany w punkcie „Dostarczenie do HKL”. Docelowy sposób to jeden dodatkowy adapter, nie przebudowa.
2. Czy „dodać kolekcje do zamówienia” znaczy coś więcej niż decyzja 6, np. kolekcję widoczną w nagłówku zlecenia albo na liście zleceń? Co oznacza „ff” w liście kolekcji szefa?
3. Gdzie na produkcji leży `config.outputData` i czy katalog jest na trwałym wolumenie? Sprawdź odczytem plików compose, niczego nie zmieniaj. Zdjęcia zgłoszeń nie mogą zniknąć przy aktualizacji kontenera.

## Co już istnieje i na czym budujesz
- **Zakres zleceń konta:** `scopeFromRequest` + `scopeWhere` w `services/assistant/tools.js`. Użyj tego. Jeśli import z modułu asystenta jest nie na miejscu, przenieś obie funkcje do wspólnego modułu (np. `services/orderScope.js`) razem z testami i popraw importy w asystencie. Nie pisz drugiej wersji.
- **Statusy:** `order.status`, `order.prod_status` (`!sent!`, `!preparation!`, `!production!`, `!backorder!`, NULL = przyjęte), `order.delivery_date`, `order.spedition_numbers`, tabela `position_statuses` (`order_pos`, `shipping_date`, `parcel_code`). Podpozycje: `prodStatus.alignStatusesToItems`/`positionNumber`. Filtr statusów na liście: `templates/orders_history.njk` + `db/orders.js`.
- **Kolekcje:** tabele `department` i `product_group` (sync `services/groupSync.js` z `grupy.xlsx`, nazwy w 5 językach).
- **Podgląd wysłanego zlecenia:** `/orders/history/order/:id` (`templates/order_sent.njk`). Dane pozycji: `positions-data` w `routes/orders.js`, opisy z `json_parameters_desc` → `services/orderService.js` (`jsonTextBackToMap`), tłumaczenia `translationDict/itemTranslator.js`.
- **Upload:** `multer` (już w `routes/positions.js`, `memoryStorage`), `sharp` (miniatury, zmniejszenie zdjęć do maila), `utils/sanitizeFilename.js`, `utils/fileManager.js`.
- **Maile:** `services/mailBot/mailBot.js` (`sendMailAsync`, szablony Nunjucks, logo cid), `commentTranslator.js`. Wzorzec maila do konsultanta z Reply-To: `services/assistant/handoff.js`.
- **Eksport plikiem na FTP:** `services/orderCancellation.js` (znacznik w `outputData/orders-cancel/` lokalnie i na FTP `/orders-cancel/` na produkcji, `ensureDir`, zależności wstrzykiwane) oraz `services/invoices/invoiceFtpExport.js` (katalog zależny od środowiska: `/invoices` na prod, `/invoices-test` poza nim, znaczniki zdarzeń zamiast flag). Nazwy plików zleceń: `utils/orderFileName.js`.
- **Cykl tła:** `services/prodStatusCycle.js` uruchamiany z crona (`PROD_STATUS_SYNC_MODE=external`). Ponawianie nieudanych eksportów dołącz jako krok tego cyklu, bez nowego crona.
- **Demo:** `services/demoMode.js` (bramka `isDemoIdent`, zamiatarka `startDemoSweeper`).
- **Asystent Eforek:** katalog stron `services/assistant/pages.js`, katalog elementów `uiCatalog.js`, baza wiedzy `services/assistant/knowledge/*.md`.
- **Panel admina:** `routes/admin.js`, `templates/admin/*`. Wzorzec listy z filtrami i paginacją: korekty (`db/admin/orderCorrections.js`).

## Wymagania

### A. Model danych (idempotentna migracja `migrations/add_service_tickets.sql`)
- `service_ticket`: id, number (UNIQUE), type, status, order_id NULL, order_no_text NULL (numer wpisany ręcznie), commission NOT NULL, department_id NULL (kolekcja przy zgłoszeniu bez zlecenia), description, description_pl NULL, contact_name, contact_phone, contact_email, product_address NULL, end_client NULL, delivered_at NULL, carrier_noted NULL, quote_before_repair NULL, created_at, updated_at, closed_at NULL, hkl_ref NULL (numer w bazie HKL, gdy wróci).
  - **Migawka właściciela** (zgłoszenie musi przetrwać usunięcie konta przez `dbUserSync`): user_id NULL, user_ident, client_name, organization_id, organization_ident, group_user_id NULL, employee_id NULL, created_by (np. `user:<ident>`, `employee:<id>`, `admin:<ident>`, `staff:<ident>`).
- `service_ticket_item`: ticket_id, order_item_id NULL, order_pos, department_id, qty, category, note.
- `service_ticket_file`: ticket_id, event_id NULL, stored_name, original_name, mime, size, created_at.
- `service_ticket_event`: ticket_id, created_at, actor, kind (`created`, `client_message`, `status`, `export_ok`, `export_failed`, `mail_sent`…), status NULL, message NULL. To jest oś czasu dla klienta i dziennik eksportu dla admina. Wzorzec: `invoice_event`.
- Statusy: `submitted` (klient widzi „Przekazane do serwisu HKL”), `accepted`, `in_progress`, `waiting_for_client`, `resolved_accepted`, `resolved_rejected`, `closed`. Nieudany eksport NIE jest statusem klienta. To zdarzenie `export_failed` widoczne tylko u admina.
- Sprawdź, czy `dbUserSync` i zamiatarka demo kasują zlecenia i pozycje. Klucze obce dobierz tak, żeby żadne z nich się nie wywróciło i żeby zgłoszenie (poza demo) nie zniknęło.

### B. Serwis `services/serviceTickets/`
- `rules.js`: rodzaje, kategorie, wymagania z decyzji 8–10 i kwalifikacja zlecenia do rodzaju. Czysty moduł. Tę samą definicję dostaje przeglądarka (wstrzyknięta do szablonu jako JSON), żeby walidacja nie rozjechała się między stronami.
- `index.js`: `listEligibleOrders(scope, filters)`, `getOrderForTicket(scope, orderId)` (pozycje + kolekcje + statusy pozycji), `createTicket(scope, input, files)`, `addClientMessage(...)`, `listTickets(scope)`, `getTicket(scope, id)`. Zależności wstrzykiwane (db, storage, exporter, mailer, clock), wzorzec `orderCancellation.js`. Testy bez MySQL.
- Zapis zgłoszenia, pozycji i plików w jednej transakcji. Pliki najpierw do katalogu tymczasowego, po COMMIT przenoszone do `outputData/service/<numer>/`. Przy ROLLBACK sprzątasz pliki. Eksport i maile ruszają dopiero po COMMIT. Ich błąd nie cofa zgłoszenia, tylko zapisuje `export_failed`.

### C. Interfejs klienta
- Trasy w nowym `routes/service.js` (montowany pod `/service` tylko przy włączonej fladze): strona startowa (rodzaje + „Moje zgłoszenia”), kreator, `POST` zgłoszenia (multipart), lista, podgląd, dopisek. Odpowiedzi JSON 401/403/422 dla wywołań z kreatora, jak w `routes/assistant.js`.
- Kreator według decyzji 2–13. Błędy przy polach, fokus na pierwszym błędzie, komunikat w `aria-live`. Pełna obsługa z klawiatury, etykiety pól, kontrast z tokenów.
- **Mobile first:** monter zgłasza z telefonu na budowie. Kreator ma działać na szerokości 360 px bez poziomego przewijania. Tabela pozycji na telefonie zamienia się w karty.
- Podsumowanie przed wysyłką pokazuje wszystko, co pójdzie do HKL, z linkami „zmień” do kroków. Przycisk wysyłki blokuje się po kliknięciu (brak podwójnych zgłoszeń). Serwer też odrzuca duplikat: ten sam użytkownik, zlecenie, rodzaj i zestaw pozycji w ciągu 2 minut.
- Jeśli któraś z zaznaczonych pozycji ma już otwarte zgłoszenie, pokaż ostrzeżenie z linkiem do niego. Wysyłki nie blokuj.
- Przycisk „Zgłoś problem” w `order_sent.njk` i w wierszu listy wysłanych, tylko gdy zlecenie jest w zakresie konta i flaga jest włączona.
- Wygląd z tokenów `public/styles/theme.css`, bez nowej palety, bez `backdrop-filter` i ciężkich animacji.

### D. Dostarczenie do HKL (kanał domyślny, dopóki nie ma odpowiedzi na pytanie 1)
- Adapter `exporter` z jedną metodą `deliver(ticketPackage)`. Domyślna implementacja: katalog `<numer>/` z plikami i `ticket.json` na FTP `/service` (produkcja) lub `/service-test` (pozostałe środowiska), lokalnie lustro w `outputData/service-out/`. **`ticket.json` wgrywany jako ostatni** (`.tmp` + rename), żeby czytający program nigdy nie wziął niepełnej paczki. Dopisek klienta = `event-<n>.json` + jego pliki w tym samym katalogu.
- `ticket.json`: numer, rodzaj, kategorie, komisja, numer zlecenia eForm (`order_idx`) i nazwa pliku produkcyjnego z `utils/orderFileName.js` (żeby HKL połączyło zgłoszenie z produkcją), ident i nazwa klienta i organizacji, kolekcje, pozycje (nr, grupa, `parameters_short`, ilość, której dotyczy, kategoria, uwaga, data wysyłki, nr paczki), opis oryginalny + PL, kontakt, adres produktu, odbiorca końcowy, dane transportowe/naprawy, wiek zlecenia w dniach, lista plików, `created_by`. Bez cen.
- Mail do serwisu HKL (decyzja 18): podsumowanie, link do podglądu w panelu admina, zdjęcia zmniejszone `sharp`-em do ~1600 px w załączniku, łącznie do ~10 MB. Wideo i większe pliki tylko w paczce na FTP, w mailu lista nazw.
- Ponawianie: zgłoszenia z ostatnim zdarzeniem `export_failed` i bez `export_ok` ponawia krok w `prodStatusCycle`, maksymalnie 5 prób. Potem tylko alarm w logu i widoczność w panelu admina.

### E. Panel admina `/admin/service`
- Lista z filtrami (rodzaj, status, organizacja, klient, data, „błąd eksportu”), podgląd zgłoszenia z plikami i osią czasu, przycisk „Wyślij ponownie do HKL”, ręczna zmiana statusu z wiadomością do klienta (mail + zdarzenie na osi czasu). Ręczna zmiana jest rozwiązaniem tymczasowym, dopóki statusy nie wracają z bazy HKL.
- Pliki zgłoszeń serwuje trasa ze sprawdzeniem dostępu (admin albo klient w zakresie), nigdy statyczny katalog.

### F. Bezpieczeństwo (warunek odbioru)
- O dostępie decyduje serwer: zlecenie musi być w zakresie konta (`scopeWhere`), każda przysłana pozycja musi należeć do tego zlecenia, `qty` nie może przekraczać ilości pozycji, rodzaj musi pasować do statusu zlecenia (reguła z `rules.js`).
- Pliki: typ sprawdzany po zawartości (magic bytes), nie po rozszerzeniu ani `mimetype` z przeglądarki. Nazwa na dysku generowana przez serwer, oryginalna nazwa tylko jako metadana. Limity liczby i rozmiaru na serwerze (multer `limits`).
- Opis i uwagi escapowane w szablonach i mailach (Nunjucks autoescape, bez `| safe` na danych klienta).
- Limit: maks. 20 zgłoszeń i dopisków na konto na dobę (ochrona skrzynki serwisu i limitu home.pl).
- Testy negatywne, wszystkie kończą się odmową: zlecenie innego klienta; pozycja z innego zlecenia; rodzaj 1–3 dla zlecenia w realizacji; zgłoszenie anulowanego zlecenia; podgląd/plik/dopisek cudzego zgłoszenia; pracownik bez „Wszystkie zamówienia” i cudze zlecenie organizacji; sklep grupy i zlecenie innego sklepu; plik `.exe` przemianowany na `.jpg`; konto demo nie generuje eksportu ani maila.

### G. Eforek i tłumaczenia
- Dodaj stronę „Serwis” do `services/assistant/pages.js`, element menu do `uiCatalog.js` (klikalny tylko w nawigacji) i krótki plik wiedzy `knowledge/serwis.md` z rozdziałem warunkowym zależnym od flagi. Eforek kieruje do kreatora i może pokazać drogę. Zgłoszenia NIGDY nie wysyła.
- Każdy tekst UI i maili w 5 językach (pl, en, de, fr, nl) przez arkusz `jezyki.xlsx` (pamięć: „Tłumaczenia: arkusz nadpisuje JSON-y”), łącznie z rodzajami, kategoriami i statusami. Nazwy kolekcji biorą się z `department.name_<lang>`.

## Etapy (po każdym krótki raport: co zrobione, co sprawdzone)
0. Rozpoznanie, plan z listą plików, odpowiedzi właściciela na „Otwarte pytania”. Pokaż migrację i poproś o zgodę na DDL na bazie testowej. Bez kodu.
1. Migracja, `rules.js`, serwis z testami jednostkowymi (kwalifikacja, walidacja per rodzaj, zakres, duplikaty, transakcja + pliki).
2. Interfejs klienta: wejścia, kreator, „Moje zgłoszenia”, podgląd, dopisek, tłumaczenia, telefon. Odbiór: E2E poniżej.
3. Dostarczenie do HKL (adapter FTP + mail + ponawianie w cyklu) i panel admina.
4. Eforek, wpis w `PROJECT_OVERVIEW.md`, raport końcowy. Docelowy adapter bazy HKL i synchronizacja statusów, jeśli Etap 0 dał konkretną odpowiedź. Jeśli nie, opisz, co trzeba dostać, żeby to dokończyć.

## Weryfikacja
- `npm test` przechodzi (testy JSDOM jak w `npm test`, z `--test-force-exit`). Nowa logika ma testy jednostkowe.
- E2E Playwrightem na lokalnym :8000 (zasady z pamięci „Zrzuty UI Playwrightem”), konto symulatora:
  - reklamacja techniczna na zleceniu „Dostarczone”, 2 z kilku pozycji, różne kategorie, 2 zdjęcia → numer `SRV-…`, wiersze w bazie testowej, paczka w lustrze `service-out/` z `ticket.json` jako ostatnim plikiem, mail klienta i serwisu w logu przekierowania;
  - uszkodzenie w transporcie z 1 zdjęciem → odmowa (wymagane 2);
  - zapytanie o dostawę dla zlecenia w realizacji → najpierw widać status i paczki;
  - zgłoszenie bez numeru zlecenia (komisja + kolekcja);
  - dopisek do otwartego zgłoszenia → `event-1.json`;
  - zrzuty na 1280 px i 390 px.
- Eksport z wyłączonym FTP/serwerem pocztowym: zgłoszenie zostaje zapisane, w panelu admina widać `export_failed`, następny przebieg cyklu wysyła paczkę.
- Na produkcyjne adresy i produkcyjny FTP nie wysyłaj niczego.
- Regresja: lista i podgląd zleceń, wysyłka, anulowanie i asystent działają jak przed zmianą dla klienta, pracownika, grupy, sklepu grupy, ownera i admina.

## Zasady środowiska (bez wyjątków)
- Pracujesz tylko na lokalnym eFormie na hoście :8000. Żadnego `docker`, `update.sh` ani zmian w `volumes/`.
- DDL na bazie testowej tylko za zgodą właściciela: przygotuj idempotentną migrację w `migrations/`, pokaż ją i poproś o zgodę.
- Nie cofaj plików przez `git checkout --` w żywym drzewie, bo to wdraża starą wersję. Commity tylko na `main` i tylko na prośbę.
- Nowe zmienne środowiskowe (`SERVICE_ENABLED`, `SERVICE_NOTIFY_EMAIL…`, katalog FTP) opisz w `config.js`. Sekrety tylko w `.env.local` (`.env` jest auto-commitowany).
- Pliki `form.js`, `dataLoader.js`, `form.css`, `form.njk` mają CRLF. Ten moduł nie powinien ich ruszać.
- Na koniec dodaj podsekcję „serviceTickets” w `PROJECT_OVERVIEW.md` i wpis w Changelog.

## Definicja ukończenia
Etapy 1–4 działają i przeszły testy opisane wyżej. Migracja jest gotowa do wdrożenia na produkcji, z instrukcją kolejności (migracja → `.env` → restart → włączenie flagi najpierw w trybie `admins`). Raport końcowy wymienia, czego NIE sprawdzono, jakie ryzyka zostają (m.in. przechowywanie zdjęć z danymi osobowymi bez polityki retencji) i co trzeba dostać od HKL, żeby podłączyć docelową bazę reklamacji.
