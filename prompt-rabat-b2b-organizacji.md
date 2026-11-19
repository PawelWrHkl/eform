# Zadanie: rabat B2B, który organizacja daje swojemu klientowi (z przeliczeniem cen)

## Skąd to zadanie
Zgłoszenie szefa (Krzysztof Krawczyk, 18.11.2026), priorytet wysoki:
> Trzeba móc, robiąc ofertę dla klienta, dodać rabat. Może studio rabatów to ogarnia? Tylko że tu mowa o rabacie B2B, a nie B2C. Czyli np. Luxan robi ofertę klientowi i daje mu dodatkowy rabat. Może być też opcja kwotowo i/lub %. Czyli rabat Luxan udziela klientowi, np. dla JC.

Doprecyzowanie właściciela projektu (Paweł): funkcja jest tylko dla organizacji, czyli dla konta ownera (`user.ident == organization.ident`, w sesji `isOwner`). Owner steruje rabatem zwykłego konta swojej organizacji. Działa podobnie do Centrum rabatów, ale ingeruje w rabat liczony w parametrach (`SUB___CENA_RABAT`), więc ceny pozycji muszą się przeliczyć.

„JC” to najpewniej klient Luxan. Sprawdź: `SELECT id, ident, client_name, role FROM user WHERE organization_id = 5 AND (ident LIKE 'JC%' OR client_name LIKE '%JC%')`.

## Kontekst w skrócie
- Ceny klienta organizacji spoza HKL to łańcuch `SUB___`:
  `SUB___CENA` → `SUB___CENA_SUMA` (cena katalogowa + dopłaty) → `SUB___CENA_RABAT` (rabat cennikowy: wariant skryptu z `prod.txt` albo z nakładki `customer_group_terms`) → `SUB___CENA_KONCOWA` (cena 1 szt. po rabacie; z niej wystawiana jest faktura) → `SUB___WARTOSC_KONCOWA` (× ilość; z niej suma `total_sub`).
- HKL (`organization.id = 3`) nie ma cen `SUB___`. Funkcja dotyczy tylko organizacji spoza HKL (Luxan GmbH = 5, Cozy i inne).
- Dzisiejsze „Centrum rabatów” (`#discount-btn`) to rabat **B2C**, czyli rabat salonu dla klienta końcowego. Zapisuje `order.client_discount_percentage` / `client_discount_value` i liczy się wyłącznie od sumy w widoku i w PDF (`services/getDiscount.js`). Nie dotyka pozycji i nie trafia na faktury.
- Nowa funkcja to rabat **B2B**. Zmienia cenę, jaką klient płaci organizacji, więc musi dojść do pozycji, sum, PDF, maila, eksportu FTP i faktury organizacja → klient.

## Zanim zaczniesz
1. Przeczytaj `PROJECT_OVERVIEW.md`: słownik (SUB), opisy `pricesCalculator.js`, `subPrices.js`, `groupPriceMode.js`, moduł „Klienci organizacji” oraz wpisy w Changelogu z 2026-08-13 (warunki per grupa), 2026-09-22 (ekstra rabat), 2026-10-27 (rabat klienta grupy, złote wiersze, stopka sum) i 2026-11-16 (kłódka ownera spoza HKL). Przeczytaj też pamięć projektu (`MEMORY.md`), szczególnie wpisy: „Rabat grupy a dopłaty”, „Brak rabatu u klienta” (wyścig zapisu), „Stopka sum: per rola”, „Specyfikacja ceny”, „VAT działa na produkcji”, „Tłumaczenia: arkusz nadpisuje JSON-y”, „DDL na bazie testowej = zgoda”, „Nie cofać plików w żywym drzewie”, „Commit tylko swoich zmian”, „Testy JSDOM wiszą bez --test-force-exit”, „Zrzuty UI Playwrightem”, „NIE dotykać kontenerów”.
2. Pracuj w trybie planowania. Kolejność: rozpoznanie, potem plan z listą plików, potem pytania z sekcji „Do rozstrzygnięcia” (jedno `AskUserQuestion`, moja rekomendacja jako pierwsza opcja), dopiero potem kod. O rzeczy z sekcji „Wymagania” nie pytaj ponownie.
3. Zasada: najmniejsza kompletna zmiana. Rabat klienta liczy już jeden tor w przeglądarce. Dołóż do niego nowe źródło. Nie pisz drugiego silnika rabatów i nie licz cen pozycji na serwerze.

## Na czym budujesz (to już działa)
- **Tor liczenia w przeglądarce**: `public/scripts/formTools/pricesCalculator.js`, funkcje `applyClientDiscount` i `clientDiscountBreakdown`. Procent z `window.clientDiscountPercent` **zastępuje** `SUB___CENA_RABAT` na cenie katalogowej. Dopłaty dostają swój rabat z konfiguratora. Wynik trafia do `SUB___CENA_KONCOWA` i `SUB___WARTOSC_KONCOWA`, a rozbicie do ukrytych wierszy `SUB___RABAT_KLIENTA`, `SUB___CENA_PO_RABACIE`, `SUB___RABAT_DOPLATY`, `SUB___DOPLATA_PO_RABACIE` (pod kłódką). Ekstra rabat `user.extra_rabat` mnoży potem kwotę po rabacie. Dziś jedynym źródłem procentu jest konto podrzędne grupy typu `client`. Dla wariantu procentowego to jest dokładnie ta arytmetyka, której potrzebujesz.
- **Źródło procentu na serwerze**: `services/groupDiscount.js` (`resolveClientDiscountForOrder/Position`, liczone z **zamówienia**, nie z sesji) → `services/portalUsageDiscount.js` (`resolveCombinedDiscountForOrder/Position` dodaje ekstra rabat, `resolveFormPricingForOrder` buduje globale formularza). Konsumenci: `templates/form.njk`, `edit_position.njk`, `admin_edit_position.njk` (przez `routes/orders.js` i `routes/positions.js`), `GET /orders/order/:id/positions-data` → `public/scripts/recalculateOrder.js` („Przelicz wszystkie pozycje”), a przez niego także przeliczenie importu (`services/orderImport/browserRecalculator.js`). Nowe źródło podłączone tutaj dojdzie wszędzie.
  - ⚠️ `total` to rabat bazowy + ekstra rabat, a front odzyskuje rabat bazowy odejmowaniem (`pct − portalBonus`). Nie zepsuj tego rozdziału.
  - ⚠️ Rabat grupy i rabat B2B się wykluczają. Zlecenie z `group_user_id` ma rabat grupy, rabatu B2B dla niego nie ma.
- **Okno rabatu B2C (wzorzec UI)**: `templates/order.njk` (`#discount-btn`, warunek `not isGroup and not isGroupShop and not hidePrices`), `public/scripts/orderTools/setDiscount.js` (procent / kwota, podgląd kwoty po rabacie, waluta zamówienia), `POST /orders/order/:id/set-discount` (bramka `getClientGroupOrderBlock`), `db/orders.js` (`saveDiscount`, `getDiscount`), `services/getDiscount.js`.
- **Owner i kontekst klienta**: `isOwner` w `middleware/loginMixture.js` (ident konta == ident organizacji; admin też dostaje `isOwner`, staff ma wymuszone `false`), `services/authService.js` (`buildOwnerSession`), `services/owner.js` (`setContextUserByIdent`, `getCurrentUser`). ⚠️ `setContextUserByIdent` nie sprawdza organizacji, a `checkOrderOwnership` wpuszcza ownera do **każdego** zlecenia. Nowa trasa musi sama sprawdzić, że zlecenie należy do klienta z organizacji ownera.
- **Widoczność i sumy**: `services/subPriceContext.js`, `services/subPrices.js` (`calcSubTotals`, `resolveDiscountBaseTotal`, `attachGroupGoldValues`), `attachGroupGoldRows` w `routes/orders.js`, stopka sum w `order.njk` / `order_prices.njk`, specyfikacja ceny `services/priceSpec/`.
- **Klienci organizacji** (`/org/customers`, `ORG_CUSTOMERS_ENABLED=true`): tabela `customer_commercial_terms` ma kolumny `discount_global_pct` i `discount_rules` (`[{product_group, discount_pct, valid_from, valid_to}]`) z walidacją i edytorem, ale silnik ich **nie czyta** (Changelog 2026-08-13). Te pola trafiają do eksportu klienta (`services/customerExport/mapper.js`), a wiersz mają tylko klienci założeni w eForm. Wykorzystaj je, jeśli właściciel wybierze rabat domyślny per klient (pytanie 2). Pamiętaj, że zmiana znaczenia tych pól zmienia też eksport.
- **Faktury**: `services/invoices/core/orderMapper.js` liczy procent z kwot przed i po rabacie, nie z nominalnego `SUB___CENA_RABAT`. `services/invoices/render/maizonCozy.js` ma listę `SUB_RATES`. Sprawdź, że faktura poziomu 2 pokazuje rabat B2B poprawnie.
- **Cenniki klientów**: `services/pricelists/shop.js` czyta `SUB___CENA_RABAT`. Rabatu per oferta to nie dotyczy, rabatu domyślnego per klient tak (pytanie 2).

## Wymagania (decyzje podjęte)
A. **Kto nadaje:** owner organizacji spoza HKL oraz admin pracujący w kontekście klienta takiej organizacji. Nie nadają: grupy, konta podrzędne grup, staff, pracownicy (`employee`), sam klient. Klient nie może nadać ani zmienić sobie rabatu ani w UI, ani przez API. Odmowa = 403, z testem.
B. **Komu:** zwykłe konto tej samej organizacji (`user.organization_id` = organizacja ownera, `role IS NULL`), inne niż konto ownera.
C. **Forma:** procent i/lub kwota (słowa szefa).
D. **Przeliczenie:** rabat wchodzi do cen pozycji. Po zapisie rabatu wszystkie pozycje zlecenia przeliczają się istniejącym „Przelicz wszystkie pozycje” (`recalculateOrder.js`), bez ręcznej arytmetyki na serwerze. Nowa i edytowana pozycja liczy się z rabatem od razu, przez globale w `form.njk` / `edit_position.njk`. Ponowne przeliczenie nie może naliczyć rabatu drugi raz (idempotencja, z testem).
E. **Kiedy:** tylko zlecenia przed wysłaniem. Przy zleceniach wysłanych, w korekcie i anulowanych rabat jest tylko do odczytu. Skorzystaj z istniejących bramek mutacji w `routes/orders.js`.
F. **Audyt:** zapisz, kto nadał rabat (id konta), kiedy i jaka była poprzednia wartość. Najpierw sprawdź, czy w projekcie jest gotowy dziennik (np. `services/logService.js`).
G. **B2C zostaje:** Centrum rabatów B2C działa jak dziś i liczy się od sumy klienta **po** rabacie B2B. Sprawdź `resolveDiscountBaseTotal` i opisz w raporcie, od czego liczy się B2C po zmianie.
H. **UI:** w tym samym oknie Centrum rabatów osobna, wyraźnie podpisana sekcja „Rabat B2B dla klienta”, widoczna tylko dla uprawnionych z punktu A. Po zapisie okno uruchamia przeliczenie i odświeża widok. Wygląd taki jak w obecnym oknie.
I. **Wyścig zapisu** (pamięć „Brak rabatu u klienta”): nie da się zapisać rabatu w trakcie trwającego przeliczenia, a pozycja zapisana w trakcie zmiany rabatu nie może zostać ze starą ceną.
J. **Teksty:** każdy tekst UI jako klucz tłumaczenia w 5 językach i w arkuszu `jezyki.xlsx` (pamięć).
K. **Asystent:** dopisz krótki akapit o rabacie B2B w `services/assistant/knowledge/20-oferta-i-pozycje.md`. Jeśli dochodzi nowy przycisk, dodaj go też w `services/assistant/uiCatalog.js`.

## Do rozstrzygnięcia na starcie (jedno AskUserQuestion, rekomendacja jako pierwsza opcja)
1. **Jak działa procent.**
   (a, rekomendacja) Owner wpisuje docelowy rabat, który zastępuje `SUB___CENA_RABAT` na cenie katalogowej. W oknie widać obecny rabat z cennika jako punkt odniesienia. To gotowa arytmetyka `applyClientDiscount`, ta sama co u klienta grupy.
   (b) Dodatkowy procent liczony od kwoty po rabacie cennikowym, tak jak `extra_rabat`.
   Dopytaj też: czy rabat może być niższy od cennikowego (czyli podnieść cenę)?
2. **Zakres.**
   (a, rekomendacja) Rabat per zlecenie/oferta, bo o tym mówi szef.
   (b) Rabat domyślny per klient (ewentualnie per grupa produktów przez `discount_rules`) z możliwością nadpisania w ofercie.
   (c) Tylko rabat per klient.
3. **Rabat kwotowy.**
   (a, rekomendacja) Kwota na całe zlecenie rozłożona na pozycje proporcjonalnie do ich wartości po rabacie procentowym. Rabat schodzi z `SUB___CENA_KONCOWA` każdej pozycji, reszta groszowa trafia na największą pozycję. Tylko w tym wariancie kwota trafi na fakturę. Zastrzeżenie: faktura mnoży cenę jednostkową przez ilość, więc przy ilości > 1 suma rabatu może odbiegać od wpisanej kwoty o grosze.
   (b) Kwota tylko na sumie zlecenia, jak w B2C (na fakturę nie trafi).
   Przy procencie i kwocie naraz: najpierw procent, potem kwota.
4. **Co widzi klient.**
   (a, rekomendacja) Tak jak przy rabacie klienta grupy: widoczne ceny cennikowe, a rabat B2B i cena po nim pod kłódką. PDF i mail według tych samych zasad.
   (b) Osobny, widoczny wiersz „Rabat od <organizacja>”.

## Proponowana droga (do potwierdzenia w planie)
1. **Dane:** przy rabacie per zlecenie kolumny w `order` (procent, kwota, kto, kiedy). Idempotentna migracja w `migrations/`, z procedurą na `information_schema`, jak w `migration_organization_customers.sql`. DDL na bazie testowej wykonujesz dopiero po mojej zgodzie. Na produkcji nie wykonujesz nic.
2. **Serwis** `services/orgB2bDiscount.js` z wstrzykiwanymi zależnościami (wzorzec: `services/orderCancellation.js`), żeby testy działały bez MySQL. Funkcje: `canManage(sessionUser, order)`, `resolveForOrder(orderId)`, `save(...)`.
3. **Podłączenie** do `resolveCombinedDiscountForOrder/Position`: rabat bazowy = rabat grupy albo rabat B2B (nigdy oba). Ekstra rabat działa dalej po nich.
4. **Kwota** (jeśli wariant 3a): przeliczenie idzie pozycja po pozycji, więc udziały w kwocie potrzebują wartości wszystkich pozycji po procencie. Zaprojektuj to tak, żeby wynik był deterministyczny i idempotentny, także po dodaniu albo usunięciu pozycji (wtedy przelicza się całe zlecenie). **Pokaż ten projekt w planie przed kodowaniem.**
5. **Trasa** `POST /orders/order/:id/b2b-discount`: walidacja na wejściu (0–100%, kwota ≥ 0 i nie większa od sumy, liczby z przecinkiem i kropką), uprawnienia z punktu A, bramka z punktu E.
6. **UI** w `setDiscount.js` + `order.njk`. Po zapisie istniejące przeliczenie i przeładowanie.

## Weryfikacja (bez tego zadanie nie jest skończone)
- **Testy jednostkowe:** uprawnienia (owner swojej organizacji tak; owner innej organizacji, klient, grupa, konto podrzędne, staff, organizacja HKL nie), połączenie z ekstra rabatem i wykluczenie z rabatem grupy, idempotencja, rozkład kwoty (suma udziałów = kwota, reszta groszowa). Rozszerz istniejące `services/__tests__/clientDiscountInFinalValue.test.js` zamiast pisać od zera. Testy JSDOM uruchamiaj z `--test-force-exit`.
- **Na żywym :8000 (Playwright, konto z `.env`, nie wchodź na `/user/login`):** owner organizacji spoza HKL w kontekście klienta testowego, oferta z 3 pozycjami z różnych grup (jedna z dopłatą, jedna z dopłatą EL). Ustaw rabat procentowy, potem kwotowy, potem oba. Sprawdź `SUB___CENA_KONCOWA` każdej pozycji, stopkę sum dla każdej roli (owner, admin, sam klient, przed kłódką i po niej), PDF, specyfikację ceny i Centrum rabatów B2C liczone od nowej sumy. Zrzuty ekranu dołącz do raportu.
- **Faktura:** sprawdź mapowanie faktury na zapisanych pozycjach (`orderMapper` / szablon Cozy), np. harness E2E faktur z ROLLBACK (pamięć). Nie wysyłaj zleceń i nie wystawiaj prawdziwych faktur.
- Każdą anomalię w cenach zgłoś, także taką, która wygląda na starą.

## Zakazy
- Tylko lokalny eForm na hoście :8000. Żadnego dockera, `update.sh` ani produkcji.
- Nie cofaj plików przez `git checkout` w żywym drzewie.
- Nie zmieniaj plików `prod.txt` ani skryptów `param-*.js` (generuje je aplikacja zewnętrzna).
- Commit tylko na moje polecenie, wyłącznie własne hunki, na `main`.

## Na koniec
- Wpis w Changelogu `PROJECT_OVERVIEW.md` (co, dlaczego, pliki, wynik testów).
- Jeśli zmienia się cokolwiek w fakturach: wpis w `services/invoices/changes.js` i blok wersji w raporcie (pamięć).
- Raport: lista plików, wyniki testów, zrzuty dla każdej roli, decyzje z `AskUserQuestion`, rzeczy świadomie pominięte i otwarte pytania.

Poza zakresem v1 (chyba że odpowiedzi na pytania zdecydują inaczej): rabat B2B w cennikach PDF, rabat per grupa produktów, nadawanie rabatu przez pracowników organizacji i przez staff.
