# Zadanie: wersja biurowa eForm (rola `staff`)

## Kontekst
eForm to portal zleceń produkcyjnych (Express + Nunjucks + vanilla JS + MySQL bez ORM). Dziś zlecenia wprowadzają sami klienci przez rozbudowany konfigurator (`templates/form.njk` + `public/scripts/form.js`). Biuro HKL potrzebuje wersji surowej i szybkiej: osoba z biura loguje się na własne konto i wprowadza zlecenia w imieniu wielu klientów, bez przełączania kont i bez dodatków konfiguratora.

Cel: pracownica biura w kilka sekund wybiera klienta, zakłada zlecenie i wpisuje pozycje z klawiatury, a ceny wychodzą identyczne jak wtedy, gdy zlecenie wpisuje sam klient.

## Zanim zaczniesz
1. Przeczytaj `PROJECT_OVERVIEW.md` (przede wszystkim sekcje 3–6, 8: „Korekty admina i kontekst owner” i „Auth i sesja”, oraz 9) i pamięć projektu (MEMORY.md). Są tam twarde zasady środowiska.
2. Pracuj w trybie planowania. Najpierw rozpoznanie i plan z listą plików, dopiero potem kod. Decyzje biznesowe są już podjęte (sekcja „Decyzje właściciela”), nie pytaj o nie ponownie. Pytaj tylko o to, czego nie da się rozstrzygnąć z kodu ani z tego promptu.
3. Zasada: najmniejsza kompletna zmiana. Najpierw sprawdź, co już jest w kodzie (lista niżej), i rozszerzaj to. Nowy kod pisz tylko tam, gdzie nic nie pasuje. Nie twórz drugiego silnika wyceny.

## Decyzje właściciela (podjęte 7.11.2026)
1. **Ceny:** staff widzi ceny jak admin, czyli wszystkie warstwy: cenę katalogową HKL, ceny SUB i rabaty pod kłódką. Uprawnień admina NIE dostaje (szczegóły w punkcie E).
2. **Wysyłka i anulowanie:** każde konto staff może wysłać zlecenie dozwolonego klienta na produkcję i anulować wysłane (okno 24 h). Nie ma osobnej flagi.
3. **Mail z potwierdzeniem:** klient dostaje go jak zwykle, a dodatkowo idzie kopia na adres `email` konta staff, które wysłało zlecenie.
4. **Grupy:** w v1 bez kont podrzędnych (`group_user`). Klient z rolą `group` jest obsługiwany jak zwykły klient, a jego konta podrzędne biuro pomija.
5. **Przyszli klienci:** admin decyduje osobno dla każdej organizacji (checkbox „także przyszli klienci”).
6. **Pełny formularz:** okno dialogowe jest główną drogą, ale w oknie jest NA STAŁE link „Pełny formularz” do `form.njk`, który działa w kontekście wybranego klienta.
7. **Usprawnienia z punktu F** wchodzą do zakresu w całości.

## Co już istnieje i na czym budujesz
- **Kontekst klienta (praca „za klienta”)**: `services/owner.js` (`setContextUserByIdent`, `getCurrentUser`, `clearContextUser`), `req.session.context_user`, lista ostatnich klientów `user.recent_clients` (`db/users.js` `getRecentClients`/`saveRecentClient`, trasy `/recent-clients` w `routes/index.js`). Admin i owner już tak pracują. Staff ma iść tym samym torem, tylko zawężonym do listy dozwolonych klientów. Pasek kontekstu po stronie przeglądarki: `public/scripts/base.js`.
- **Role**: kolumna `user.role` (`admin`, `group`, `demo`, NULL = klient). Role do wyboru w panelu: `ROLE_OPTIONS` w `services/admin/userAdminService.js`; panel `/admin/users` i API `/admin/api/users/:id/...` w `routes/admin.js` (osobny endpoint POST na każdą sekcję ustawień, ten sam wzorzec zastosuj dla dostępu biura). Sesję buduje `buildOwnerSession` w `services/authService.js`.
- **Autoryzacja**: `middleware/loginMixture.js` (`checkOrderOwnership`, `requireOwner`, `requirePermission`…), `middleware/employeePermissions.js`.
- **Widoczność cen**: `services/subPriceContext.js` (`getEffectiveOrgId`, `applySubPriceLocals`), `services/subPrices.js`, specyfikacja ceny `services/priceSpec/` (`PRICE_SPEC_CLIENTS_ENABLED=false` = tylko admin), szablony `order.njk` / `order_prices.njk`.
- **Nowe zlecenie**: `templates/new-order.njk`, `GET /orders/add-order` i `POST /orders/save-order` w `routes/orders.js` (właścicielem zlecenia jest `getCurrentUser(req).userId`).
- **Wysyłka, anulowanie, maile**: `POST /orders/send` i `/send-to-production` w `routes/orders.js`, `services/sendOrderService.js` (`OrderSender`, `ignore_mail_list`), `services/orderCancellation.js` (`canRoleCancel`), mailBot.
- **Powielenie zlecenia**: „Zamów ponownie” już istnieje: `POST /orders/copy/:orderId` + `openReorderDialog` (`public/scripts/orderTools/reorder.js`). Użyj tego, nie pisz drugiego.
- **Combobox z podpowiedziami z serwera**: sekcja „Odbiorca końcowy” w `new-order.njk` + `public/scripts/orderEndClient.js`. Ma już ARIA. Na nim oprzyj wybór klienta.
- **Silnik formularza**: `generateForm`/`updateProcedure` w `public/scripts/form.js`; zapis przez `buildOrderItemStructure` (`public/scripts/orderBuilder.js`) → `POST /position/save` / `PATCH /position/edit/save` (zobacz `public/scripts/main.js` i `edit_form.js`). `services/formEngine/harnessHtml.js` wymienia minimalny zestaw węzłów DOM, których silnik potrzebuje. Traktuj go jako listę kontrolną przy montowaniu formularza w oknie. Okna zagnieżdżone: `SourceWindow` (`formTools/slope.js`) i `EXTRAFUNC` popup-input (`docs/EXTRAFUNC.md`). Pozycje kopiuje istniejący mechanizm (pamięć: „Kopiowanie linii = ostatnia konfiguracja”). Nie pisz drugiego.
- **Grupy produktów dostępne dla klienta**: `public/scripts/formTools/getAvailableForms.js` (`FormsManager`). Sprawdź, czy działa poprawnie w kontekście klienta.
- **Synchronizacja klientów**: `services/dbUserSync.js` USUWA z bazy konta, których nie ma w `contractors.txt` (pomija tylko piny `0000`, `admin`, `000000`, `biuro`). Kont staff w tym pliku nie będzie.

## Wymagania

### A. Rola `staff`
- `user.role = 'staff'`. Sprawdź typ kolumny (`SHOW COLUMNS FROM user LIKE 'role'`). Jeśli to ENUM, potrzebna jest migracja.
- Dopisz rolę do `ROLE_OPTIONS`, żeby admin mógł ją nadać z panelu.
- W `buildOwnerSession` ustaw `isStaff = true`. Staff NIGDY nie dostaje `isOwner` ani `isAdmin`, bo `checkOrderOwnership` wpuszcza ownera do każdego zlecenia bez sprawdzania. Wymuś `isOwner = false` także wtedy, gdy ident konta przypadkiem równa się identowi organizacji.
- W `dbUserSync` synchronizacja nie może usuwać ani nadpisywać kont z `role='staff'`. Warunek ma sprawdzać rolę, nie dopisywać kolejny pin do listy. Dodaj test. Sprawdź SELECT-em na bazie testowej, czy istnieje już konto z pinem `biuro`, i opisz, do czego służy.
- Każda osoba z biura ma własne konto staff (audyt, kopia maila), a jedno konto obsługuje wielu klientów. Pole `email` konta staff jest edytowalne w panelu admina (potrzebne do kopii maila).

### B. Kogo widzi staff (ustawia admin)
- Model danych (zaproponuj; moja rekomendacja): tabela `staff_client_access (staff_user_id, organization_id, client_user_id NULL)`, gdzie `client_user_id IS NULL` oznacza wszystkich klientów organizacji, także przyszłych. Klucze obce, indeksy, idempotentna migracja w `migrations/`.
- UI admina w karcie użytkownika (`/admin/users`), widoczne tylko przy roli staff, sekcja „Dostęp biura”: lista organizacji z checkboxami. Zaznaczenie organizacji rozwija listę jej klientów z checkboxami, z opcjami „zaznacz wszystkich”, „także przyszli klienci” (osobno dla każdej organizacji, decyzja 5) i filtrem tekstowym. Zapis jednym żądaniem, w transakcji (podmiana całego zestawu). Wygląd jak reszta panelu admina.
- Na listach klientów pomijaj konta podrzędne grup (decyzja 4). Klient z rolą `group` jest na liście jak zwykły klient.
- Jeden serwis, np. `services/staffAccess.js`, z funkcjami `canAccessClient`, `canAccessOrder`, `searchAllowedClients(staffUserId, q, limit)`. Zależności wstrzykiwane, żeby testy działały bez MySQL (wzorzec: `services/orderCancellation.js`).

### C. Wybór klienta przy nowym zleceniu
- W `new-order.njk` dla staff pierwsze pole to „Klient”: combobox z wyszukiwaniem po nazwie, identzie, pinie i mieście. Podpowiada tylko dozwolonych klientów. Nad nim 5–8 ostatnich klientów jako szybkie przyciski.
- Po wyborze klienta: kontrola w `staffAccess`, potem `setContextUserByIdent`, potem w selectach pojawiają się adresy dostawy i maile tego klienta (dziś renderuje je `GET /orders/add-order` na podstawie `getCurrentUser`).
- Wybór klienta-grupy nie może włączać kontekstu konta podrzędnego (`getActiveGroupShopId` zwraca dla staff null).
- Bez wybranego klienta nie da się zapisać zlecenia (blokada w przeglądarce i na serwerze).
- Na wszystkich stronach staff stały, wyraźny pasek „Pracujesz dla: KLIENT (ORGANIZACJA) · zmień”. To główne zabezpieczenie przed wpisaniem zlecenia niewłaściwemu klientowi.

### D. Pozycje w oknie dialogowym (główna droga) + stały link do pełnego formularza
- Przycisk „Dodaj pozycję” w podglądzie zlecenia otwiera dla staff `<dialog>`: najpierw wybór grupy produktu (tylko grupy dostępne dla klienta z kontekstu), potem parametry.
- Parametry renderuje TEN SAM silnik (`generateForm`) w trybie surowym, bez kopiowania logiki wyceny. Ceny, skrypty per klient, aliasy, rabaty, SUB, waluta, VAT, HASLO i EXTRAFUNC muszą działać 1:1.
- Tryb surowy oznacza:
  - brak zdjęć, galerii, tooltipów, przewodnika (tour), asystenta „Eforek” i animacji;
  - zwarty układ „etykieta | pole”, na szerokim ekranie w 2 kolumnach;
  - kod wartości widoczny obok opisu;
  - selecty z wyszukiwaniem po wpisaniu tekstu;
  - kolejność Tab zgodna z kolejnością parametrów;
  - Enter w ostatnim polu zapisuje, Esc zamyka (z potwierdzeniem, gdy są niezapisane zmiany);
  - suma pozycji na dole, aktualizowana na żywo, z warstwami cen jak u admina (decyzja 1).
- Przyciski: „Zapisz”, „Zapisz i dodaj kolejną (te same wartości)”, „Zapisz i nowa (puste)”.
- Zapis istniejącą ścieżką (`buildOrderItemStructure` → `POST /position/save`). Edycja pozycji też w oknie (`PATCH /position/edit/save`). Po zapisie odśwież tabelę pozycji.
- Okna zagnieżdżone (`SourceWindow`, popup-input), załączniki i walidacja (`validateAllFieldsOnSubmit`) muszą działać nad oknem (top layer, fokus).
- W oknie jest na stałe link „Pełny formularz” (decyzja 6). Otwiera zwykły `form.njk` (oraz `edit_position.njk` przy edycji) dla tej samej grupy i tego samego zlecenia, w kontekście wybranego klienta. Wartości już wpisane w oknie przechodzą do pełnego formularza, jeśli istniejący mechanizm `localStorage` (`formTools/localStorageManager.js`) to umożliwia. Trasy `/position/*` muszą więc obsługiwać staff z tymi samymi kontrolami dostępu co reszta.
- Jeśli tryb surowy wymaga zmian w `form.js`, włączaj je flagą (np. `window.rawMode`), tak by zwykli klienci nie odczuli różnicy. Uwaga: `form.js`, `dataLoader.js`, `form.css` i `form.njk` mają końce linii CRLF.

### E. Bezpieczeństwo i uprawnienia (warunek odbioru)
- O dostępie zawsze decyduje serwer. Dodaj gałąź staff do `getCurrentUser`, ale honoruj kontekst tylko dla dozwolonego klienta. Sprawdzaj dostęp przy ustawianiu kontekstu ORAZ przy każdym żądaniu dotyczącym zlecenia, bo admin może odebrać klienta w trakcie sesji.
- Dodaj gałąź staff do `checkOrderOwnership`: zlecenie musi należeć do dozwolonego klienta.
- **Ceny jak admin, uprawnienia nie (decyzja 1).** Dziś `isAdmin` steruje naraz widocznością cen i uprawnieniami. Rozdziel to: w miejscach, które decydują tylko o tym, co widać z cen (`subPriceContext`, `subPrices`, kłódka, specyfikacja ceny, `order.njk`/`order_prices.njk`, PDF), dodaj staff obok admina. W miejscach dających uprawnienia (panel admina, korekty, ustawienia klientów, zmiana organizacji) staff nadal nie przechodzi. Najlepiej jedna funkcja/flaga typu `canSeeAllPriceLayers(sessionUser)`, zamiast rozsianych `isAdmin || isStaff`.
- **Wysyłka i anulowanie (decyzja 2):** staff przechodzi bramki `POST /orders/send`, `/send-to-production` oraz `canRoleCancel` w `orderCancellation`, ale tylko dla zleceń dozwolonych klientów. Bramka zleceń demo (`isDemoIdent`) zostaje bez zmian. W polu `canceled_by` zapisz konto staff (np. `staff:<ident>`).
- **Mail (decyzja 3):** po wysyłce zlecenia przez staff klient dostaje potwierdzenie jak dziś, a kopia idzie na `email` konta staff, które wysłało zlecenie. Brak adresu = brak kopii i wpis w logu, wysyłka zlecenia nie może się przez to wywrócić. `ignore_mail_list` i obecne przekierowania maili w środowiskach testowych nadal obowiązują.
- Przejrzyj wszystkie użycia `context_user`/`getCurrentUser` (około 110 w 26 plikach) oraz bramki `isOwner`/`isAdmin`. W planie pokaż tabelę: plik → czego dotyczy (ceny / uprawnienia / kontekst) → co staff tam może (dozwolone / zablokowane / do zmiany).
- Staff NIE ma dostępu do: `/admin/*`, korekt admina, `/set-organization`, ustawień i haseł klientów, faktur, cenników PDF klientów, listy sesji i raportów.
- Testy negatywne, wszystkie muszą kończyć się odmową:
  - zlecenie niedozwolonego klienta (podgląd, edycja, wysyłka, anulowanie, powielenie);
  - ustawienie kontekstu na niedozwolony ident;
  - wejście na `/admin`;
  - kolejne żądanie po odebraniu dostępu w trakcie sesji.

### F. Usprawnienia pracy biura (w zakresie, decyzja 7)
- **Strona startowa staff** (po zalogowaniu): wyszukiwarka klienta, ostatni klienci i lista ostatnich zleceń dozwolonych klientów z filtrami (klient, status, data, „moje”). Kliknięcie zlecenia ustawia kontekst jego klienta i otwiera podgląd.
- **Audyt autora:** kto z biura założył zlecenie i kto ostatni je edytował (np. `order.created_by_staff_id`, `order.updated_by_staff_id`, idempotentna migracja). Widoczne dla staff i admina w podglądzie zlecenia i na liście. Nigdy w PDF, mailach do klienta ani eksporcie na FTP.
- **Skróty klawiszowe:** nowe zlecenie, nowa pozycja, zmiana klienta. Nie mogą kolidować z wpisywaniem tekstu w polach ani ze skrótami przeglądarki. Ściągawka pod `?`.
- **Powielenie zlecenia:** istniejące „Zamów ponownie” (`POST /orders/copy/:orderId`, `openReorderDialog`) dostępne dla staff. Kopia trafia do klienta zlecenia źródłowego, nie na konto staff.

## Etapy (po każdym krótki raport: co zrobione, co sprawdzone)
0. Rozpoznanie, plan i tabela z punktu E. Bez kodu.
1. Rola, model dostępu, migracje, panel admina, ochrona przed synchronizacją. Odbiór: admin nadaje rolę i dostęp, staff się loguje i widzi tylko dozwolonych klientów.
2. Wybór klienta, pasek kontekstu, kontrole po stronie serwera, ceny jak admin, wysyłka/anulowanie, kopia maila i testy negatywne.
3. Okno dialogowe pozycji i link do pełnego formularza. Odbiór: ceny zgodne co do grosza (zob. Weryfikacja).
4. Usprawnienia z punktu F.

## Weryfikacja
- `npm test` przechodzi (testy JSDOM uruchamiaj tak jak `npm test`, z `--test-force-exit`). Nowa logika (staffAccess, gałęzie autoryzacji, rozdział ceny/uprawnienia, ochrona w synchronizacji, kopia maila) ma testy jednostkowe.
- E2E Playwrightem na lokalnym :8000 (zasady z pamięci „Zrzuty UI Playwrightem”): konto staff z dostępem do 1 organizacji i 2 klientów, zlecenie dla klienta A z pozycjami dodanymi przez okno, potem wysyłka i anulowanie.
- Zgodność cen: ta sama konfiguracja wpisana oknem staff i zwykłym formularzem jako klient ma dać identyczne `json_parameters`, `parameters_short` i sumy. Minimum 3 grupy produktów, w tym jedna z `SourceWindow` i grupa 43 (popup-input `DLSZNUR`). Porównaj zapisane wiersze `order_item`.
- Mail: w środowisku testowym potwierdź (log/przekierowanie), że poszedł mail do klienta i kopia do staff. Na produkcyjne adresy nie wysyłaj niczego.
- Zwykły klient, admin, owner, grupa i pracownik działają tak jak przed zmianą (regresja kluczowych ścieżek).

## Zasady środowiska (bez wyjątków)
- Pracujesz tylko na lokalnym eFormie na hoście :8000. Żadnego `docker`, `update.sh` ani zmian w `volumes/`.
- DDL na bazie testowej tylko za zgodą właściciela: przygotuj idempotentną migrację w `migrations/`, pokaż ją i poproś o zgodę.
- Nie cofaj plików przez `git checkout --` w żywym drzewie, bo to wdraża starą wersję. Commity tylko na `main` i tylko na prośbę.
- Każdy nowy tekst w UI dodaj w 5 językach (pl, en, de, fr, nl) przez arkusz `jezyki.xlsx` (pamięć: „Tłumaczenia: arkusz nadpisuje JSON-y”). Tekst dopisany tylko do JSON-ów zniknie przy następnym logowaniu.
- Wygląd buduj z tokenów `public/styles/theme.css`, bez nowej palety, bez `backdrop-filter` i ciężkich animacji.
- Na koniec dodaj nową podsekcję w `PROJECT_OVERVIEW.md` i wpis w Changelog.

## Definicja ukończenia
Etapy 1–4 działają i przeszły testy opisane wyżej. Migracje są gotowe do wdrożenia na produkcji, z instrukcją kolejności. Raport końcowy wymienia, czego NIE sprawdzono i jakie ryzyka zostają.
