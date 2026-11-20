'use strict';

/**
 * Wersje faktur — co i kiedy się zmieniło (zalecenie KK z 2026-11-07: „opisuj wersje
 * i zmiany jakie w rechach wprowadzasz — wersja 0 start, wersja 1 …”).
 * Strona dla admina: `/invoices/changes` (`http/panel.js`), skrót w panelu faktur.
 *
 * ⚠️ KAŻDA zmiana wyglądu albo treści faktury = nowy wpis NA GÓRZE listy (kolejny numer)
 * i ten sam opis w raporcie dla właściciela. `env`: 'produkcja' albo 'test' (lokalnie,
 * jeszcze niewdrożone) — po wdrożeniu zmień na 'produkcja' i dopisz datę wdrożenia.
 */

/** @type {Array<{ version: number, date: string, env: 'produkcja'|'test', title: string, changes: string[] }>} */
const INVOICE_VERSIONS = Object.freeze([
  {
    version: 24,
    date: '2026-11-20',
    env: 'test',
    title: 'Termin płatności: 60 dni dla HKL → Cozy i HKL → Luxan GmbH, termin klienta z contractors.txt',
    changes: [
      'Pytanie Wiktorii z 20.11, decyzja Pawła „jedno i drugie”. Faktury HKL → Cozy i HKL → Luxan GmbH dostają termin 60 dni, jak faktury PROD z 16–17.11. Termin organizacji jest zapisany przy jej koncie klienta (Cozy, LuxanGmbH). Faktury Cozy i Luxan GmbH dla ich klientów zostają przy 14 dniach.',
      'contractors.txt może mieć nową kolumnę PAYMENT_DAYS (termin w dniach; puste albo „-” = brak). Faktura bierze termin w tej kolejności: ręczna zmiana na fakturze → płatnik (PAYMASTER_IDENT) → klient → organizacja-nabywca → wystawca → 14 dni. Dopóki plik nie ma tej kolumny, wszystko zostaje jak dziś.',
      'Faktury już wystawione zachowują swój termin, także po „Pobierz ponownie z zlecenia” i „Przelicz dzienne ponownie”. Nowy termin dostają faktury wystawione od teraz, także z szkiców.'
    ]
  },
  {
    version: 23,
    date: '2026-11-20',
    env: 'test',
    title: 'Płatności i przypomnienia tylko dla faktur HKL; przypomnienie 5 dni po terminie, tylko z numerem KSeF',
    changes: [
      'Ustalenia Wiktorii z 20.11: plik płatności z księgowości obejmuje tylko faktury wystawiane przez HKL (do organizacji i do klientów HKL). Tylko one mają status „otwarta/opłacona”. Faktury Cozy i Luxan GmbH dla ich klientów pokazują w panelu „wystawiona” zamiast „otwarta”, bo ich wpłat eForm nie zna.',
      'Przypomnienie o płatności idzie kilka dni PO terminie (domyślnie 5, INVOICE_REMINDER_DAYS_AFTER_DUE w .env), bo wpłata jest w księgach do ok. 3 dni po wyciągu. Treść: „termin płatności poniższej faktury minął”.',
      'Przypomnienie dostaje tylko faktura HKL z numerem KSeF (plik numery_ksef). Faktura bez numeru, np. powtarzająca fakturę PROD, nie dostaje przypomnienia. Gdy numer KSeF przyjdzie później, przypomnienie pójdzie od razu, raz.',
      'W pliku płatności: zapłacono = suma narastająca wszystkiego, co księgowość rozliczyła z fakturą (przelewy i kompensaty), data = data ostatniego wyciągu.'
    ]
  },
  {
    version: 22,
    date: '2026-11-20',
    env: 'test',
    title: 'Koszty transportu na fakturach Luxan GmbH → klient (kalkulator Wiktorii)',
    changes: [
      'Raz na dzień wysyłki eForm wysyła do kalkulatora Wiktorii wszystkie sztuki wysłane tego dnia klientom Luxan GmbH (z pliku statusów, tylko wysłane), także te już zafakturowane. Faktura Luxan GmbH → klient zlecenia wysłanego od 20.11 powstaje dopiero po wycenie każdego jego dnia wysyłki i dostaje linię „Transportkosten …” z kwotą z kalkulatora, z VAT jak towar.',
      'Kwota 0 nic nie dopisuje, opłata miesięczna trafia raz na klienta i miesiąc, a ta sama opłata nie trafi na fakturę drugi raz. Opłata przy fakturze już wystawionej (z PROD albo bez tej linii) i przypadek bez kwoty idą mailem „do doliczenia przez biuro”.',
      'Gdy kalkulator odrzuca zapytanie albo nie odpowiada, faktury czekają, a eForm ponawia próby i wysyła alarm (na razie do Wiktorii). Plik zafakturowanych pozycji ma nową ostatnią kolumnę TYPE („transport”), a linie bez zlecenia mają klienta faktury.'
    ]
  },
  {
    version: 21,
    date: '2026-11-20',
    env: 'test',
    title: 'KSeF: numer i kod QR na fakturach HKL, blokada przyjętych faktur',
    changes: [
      'eForm czyta z FTP plik Wiktorii numery_ksef.tsv (stan każdej faktury HKL w KSeF: przyjęta, odrzucona albo wstrzymana). Na teście, na produkcji wyłączone, dopóki Wiktoria nie da znać, że plik jest na FTP.',
      'Faktura HKL przyjęta w KSeF ma na PDF kod QR z linku weryfikacyjnego KSeF, a pod nim numer KSeF — także na FTP i w mailu, jeśli PDF powstaje po przyjęciu.',
      'Faktury przyjętej w KSeF nie da się już edytować, pobrać ponownie z zlecenia, przeliczyć jako dziennej ani anulować — tylko korekta. Ta sama blokada obejmie faktury Luxan GmbH przyjęte przez niemiecką usługę e-faktur (tryb live od stycznia).',
      'Przygotowane, domyślnie wyłączone: PDF faktury HKL wychodzi do klienta dopiero po przyjęciu w KSeF; bez wiersza w pliku faktura czeka, przy odrzuceniu albo wstrzymaniu nie wychodzi. Włączenie: INVOICE_KSEF_MAIL_GATE=true.'
    ]
  },
  {
    version: 20,
    date: '2026-11-19',
    env: 'produkcja',
    title: 'Pobierz ponownie z zlecenia (np. po przeliczeniu cen)',
    changes: [
      'W liście faktur (panel faktur, admin) przy wystawionej fakturze VAT jest przycisk „Pobierz ponownie z zlecenia”. Faktura buduje się od nowa z aktualnych danych zlecenia: ceny, pozycje, opisy. Polecenie Pawła 19.11 przy zleceniu 23 „Van Straaten” klienta Wonen, któremu przeliczono ceny.',
      'Numer, data wystawienia i data sprzedaży zostają. Poprawki zrobione w edytorze faktury dla zlecenia też zostają. PDF idzie ponownie mailem i na FTP, plik na FTP jest nadpisany.',
      'Działa dla faktury z jednego zlecenia i dla faktury dziennej (wszystkie jej zlecenia naraz). Nie rusza faktury opłaconej, anulowanej, z korektą, częściowej, zbiorczej tygodniowej/miesięcznej ani dziennej poprawionej ręcznie w edytorze — wtedy komunikat, co zrobić.'
    ]
  },
  {
    version: 19,
    date: '2026-11-19',
    env: 'produkcja',
    title: 'Płatnik z contractors.txt na fakturze; konto z kartoteki klientów',
    changes: [
      'Gdy klient ma w contractors.txt płatnika (PAYMASTER_IDENT, np. TCN → TCN_RECH, A&A Lohne → A&A Lohne_Rechnung, sklepy JC → JC-Berlin-Meierotto), faktura idzie na dane płatnika: nazwa, NIP, adres, kraj, e-mail, telefon. Puste pole płatnika uzupełnia konto klienta. Polecenie Pawła 19.11 po mailu Tomka.',
      'Konto do wpłaty na fakturze HKL: najpierw z contractors.txt (BANK_NAME, BANK_ACCOUNT, SWIFT — płatnika, potem klienta), potem z pliku księgowości po NIP, na końcu domyślne. Konto zapisuje się w fakturze przy wystawieniu.',
      'Synchronizacja klientów z contractors.txt aktualizuje teraz wszystkie pola: także e-mail (pusty w pliku nie kasuje adresu w bazie), kraj (nowa kolumna COUNTRY) oraz płatnika i konto. Kraj był pusty u prawie wszystkich klientów; od teraz przychodzi z pliku, a od niego zależy VAT i język faktury.',
      'Faktura organizacji dla klienta i faktury in blanco bez innych zmian; faktury już wystawione zachowują swoich nabywców.'
    ]
  },
  {
    version: 18,
    date: '2026-11-19',
    env: 'produkcja',
    title: 'Status płatności z księgowości i przypomnienie w dniu terminu',
    changes: [
      'Faktura ma status „otwarta” albo „opłacona” (także „otwarta, po terminie”); przy wpłacie częściowej panel pokazuje, ile już zapłacono. Wymaganie szefa 19.11: „dane eForm będzie czytał z księgowości, czy zapłacone — musi iść online”.',
      'Płatności eForm czyta co godzinę z pliku księgowości platnosci.tsv na FTP faktur (automat Wiktorii; ten sam katalog co zafakturowane_pozycje.tsv). Pełna wpłata → „opłacona” z datą zapłaty, częściowa → kwota przy fakturze. Opłaconej nie cofa. Ręczny przycisk „Zapłacona” w panelu zostaje.',
      'W dniu terminu płatności (od 7:00) nieopłacona faktura dostaje przypomnienie mailem: „dziś mija termin płatności”, kwota pozostała do zapłaty i ta sama faktura PDF w załączniku, w języku faktury. Raz na fakturę. Kopia (UDW) do skrzynki fakturowej wystawcy.',
      'Na razie przypomnienia, jak same faktury, idą tylko do testerów. Dotyczą faktur wystawionych od 16.11 (start prawdziwego fakturowania), żeby stare dokumenty z okresu testów nie zasypały skrzynek.'
    ]
  },
  {
    version: 17,
    date: '2026-11-19',
    env: 'produkcja',
    title: 'Konto do wpłaty klienta HKL z kartoteki księgowości; formatka HKL bez kont',
    changes: [
      'Faktury HKL (automatyczne, in blanco i edytowane) mają w sekcji „Płatność” bank, numer konta i SWIFT przypisane klientowi w księgowości (plik „kontrahenci - nr kont bankowych”, dopasowanie po NIP). Np. Ryver, Luxan GmbH, Kaya, Thuis, Azra, Artelioz: ING PL34 1050 1559 1000 0090 3311 9596; Luxan Sp.: ING PL56 …9588; Maxsol, BD Line: Erste PL81 …8394; Naoknie: Erste PL91 …0001. Polecenie Pawła 19.11: „to obowiązek”.',
      'Klient HKL, którego nie ma w pliku, dostaje domyślne konto EUR ING PL34 1050 1559 1000 0090 3311 9596, a w logu automatu i w edytorze pojawia się ostrzeżenie, żeby księgowość dopisała go do pliku. MaizonCozy dopisana przez księgowość 19.11 (ING PL34 …9596).',
      'Formatka HKL nie ma już kont w stopce, tylko dane firmy: na fakturze jest jedno konto, to z sekcji „Płatność”. Dawne konto PLN na formatce (PL64 1910 … 0001) miało błędną sumę kontrolną, poprawne to PL91 1910 1048 2793 2107 1341 0001.',
      'Faktury Cozy i Luxan dla ich klientów bez zmian. Wystawione faktury HKL z nowej serii (od 26000001) dostały konto; ich PDF-y na FTP podmienione bez maila.'
    ]
  },
  {
    version: 16,
    date: '2026-11-19',
    env: 'produkcja',
    title: 'Numer strony na każdej stronie faktury',
    changes: [
      'Na każdej stronie faktury, z prawej nad stopką formatki: rodzaj, numer i numer strony, w języku faktury, np. „Faktura VAT 26000002 · Strona 1/3”, „Rechnung … · Seite 2/3”, „Factuur … · Pagina 3/3” (prośba Pawła 19.11). Długie faktury dzienne nie gubią kolejności kartek.',
      'Wzór MaizonCozy miał to już wcześniej („Factuur … · Bladzijde 1/3”) — bez zmian. Treść i układ faktur bez zmian.'
    ]
  },
  {
    version: 15,
    date: '2026-11-18',
    env: 'produkcja',
    title: 'HKL fakturuje tylko dziennie, jedna numeracja HKL, nazwy plików w języku faktury',
    changes: [
      'HKL → organizacja i HKL → klient HKL: tylko faktura dzienna (zbiorcza za dzień wysyłki), faktury per zlecenie już nie powstają. Polecenie Pawła 18.11 po mailu szefa: „dajemy zbiorczo per dzień wysyłki”, bo przy 100 fakturach klient musiałby przy płatności wpisywać 100 numerów.',
      'Organizacja → klient (np. Luxan, Cozy dla swoich klientów) i odbiorcy końcowi bez zmian: faktura per zlecenie. Klient z ustawioną fakturą tygodniową albo miesięczną (np. JC) dostaje zbiorczą za okres zamiast dziennej.',
      'Faktura dzienna liczy się teraz jako pełna faktura: panel nie pokazuje jej zleceń jako niezafakturowanych. Zlecenie z fakturą wystawioną ręcznie nie trafia do dziennej.',
      'Jedna numeracja dla wszystkich faktur HKL (do organizacji i do klientów): 8 cyfr jak w PROD, ciągiem. HKL → Cozy 26000001, następna faktura HKL (np. do Luxan) 26000002 i tak dalej. Wcześniej organizacje inne niż Cozy i klienci HKL szli w starej serii 2026/…',
      'Nazwa pliku PDF w języku faktury, na FTP, w mailu i przy pobraniu z panelu, np. Rechnung_26000002.pdf, Factuur_26000003.pdf, Facture_…, Faktura_VAT_…. Wzór Cozy jest zawsze po niderlandzku (Factuur_…). Faktura już wysłana na FTP przy poprawce nadpisuje swój dawny plik pod starą nazwą, żeby nie powstał drugi.'
    ]
  },
  {
    version: 14,
    date: '2026-11-17',
    env: 'produkcja',
    title: 'Ręczna edycja faktur z zamówień (admin i biuro)',
    changes: [
      'Admin i biuro mogą edytować fakturę z zamówienia: dopisać lub usunąć pozycję, zmienić nazwę, opis, ilość, jednostkę, cenę, uwagi, daty i termin płatności — także w istniejących pozycjach. Numeru nie da się zmienić.',
      'Zamówienie jeszcze w produkcji: edycja przygotowuje fakturę. Po wysyłce (!sent!) automat wystawia właśnie tę wersję, nakładając zmiany na aktualne zamówienie; mail i FTP jak zawsze, klient dostaje wersję po edycji. Te same zmiany trafiają do faktury dziennej i zbiorczej z tym zamówieniem.',
      'Jeśli zamówienie zmieni się w pozycji, którą ktoś ręcznie poprawił, automat faktury nie wystawi — oznacza ją „do przejrzenia”, a edytor pokazuje, którą pozycję sprawdzić.',
      'Faktura już wystawiona: zmiana w miejscu, ten sam numer, bez maila do klienta (biuro pisze samo); PDF na FTP jest podmieniany. Opłaconą poprawia tylko admin; faktury z korektą, anulowanej i częściowej nie da się edytować.',
      'Każda zmiana jest w historii faktury (kto, kiedy, co przed i po); na liście faktur znaczek „edytowana”. „Przelicz dzienne ponownie” nie rusza dziennej poprawionej ręcznie.',
      'Wejścia: przyciski „Faktura…” w widoku zamówienia (biuro i admin) i „Edytuj” na liście faktur (admin). Biuro edytuje tylko faktury swoich klientów.',
      'Wyszukiwarka faktur admina (panel faktur → „Szukaj”): wszystkie organizacje naraz — po kliencie, commission, numerze faktury albo zamówienia, z podglądem, PDF i edycją. Wcześniej panel pokazywał tylko organizację wybraną w „Wybierz organizację”, więc np. faktury Cozy → klient nie było widać z HKL.',
      'Poprawka 17.11 15:31 (uwaga Pawła): pole opisu w edytorze pokazuje 1:1 to, co jest na fakturze. Na wzorze Cozy to opis z zamówienia i linia cen (np. „MODEL=…,STOF=…” i „LIJSTPRIJS…”), a nie lista parametrów. Nowe faktury Cozy zapisują w pozycji dokładnie ten tekst; wydruk się nie zmienia.'
    ]
  },
  {
    version: 13,
    date: '2026-11-17',
    env: 'produkcja',
    title: 'Faktura dzienna zaraz po północy; HKL → Maizon tylko dzienna, numery od 26000001',
    changes: [
      'Faktura dzienna powstaje w pierwszym przebiegu po północy: za 16.11 już 17.11 (wcześniej dzień zapasu, czyli dopiero 18.11).',
      'Za ten sam dzień nie powstaje druga faktura dzienna. Jeśli status zlecenia dojdzie później, admin klika w panelu faktur „Przelicz dzienne ponownie”. Zlecenie trafia wtedy do tej samej faktury, która zachowuje numer i datę wystawienia, a PDF idzie ponownie mailem i na FTP.',
      'HKL → MaizonCozy: od teraz tylko faktura dzienna, bez faktur per zlecenie, we własnej numeracji 8 cyfr jak w PROD. Pierwsza to 26000001 (16.11: M2/6 + Wonen/19), potem 26000002… (decyzja Wiktorii i Pawła 17.11). Pozostałe organizacje bez zmian (testowo, seria HKL 2026/…).',
      'Testowe faktury per zlecenie HKL → Maizon 2026/00818 i 2026/00819 (te same dwa zlecenia) usunięte z bazy i z FTP.'
    ]
  },
  {
    version: 12,
    date: '2026-11-17',
    env: 'produkcja',
    title: 'Mail z fakturą z adresu fakturowego organizacji',
    changes: [
      'Każda organizacja ma w bazie swój adres fakturowy (nowa kolumna organization.invoice_email). Cozy: factuur@maizoncozy.eu, pozostałe jeszcze puste.',
      'Robot wysyła mail z fakturą z adresu wystawcy przez jego własną skrzynkę (Cozy → klient z factuur@maizoncozy.eu, HKL → organizacja z adresu HKL). Hasło skrzynki jest w bazie przy organizacji (decyzja Pawła 17.11: „hasło w bazie, na produkcji też”), zapasowo w pliku .env.local; nigdy w gicie.',
      'Dopóki organizacja nie ma uzupełnionego adresu i hasła, mail idzie jak wcześniej ze skrzynki systemu, także przy przyszłej wysyłce do klientów (decyzja Pawła 17.11). Gdy adres jest, a hasła brak, w logu pojawia się ostrzeżenie.',
      'Odbiorcy bez zmian (tylko testerzy). Odpowiedź testera trafia do skrzynki systemu, nie do organizacji.',
      'Treść i wygląd faktur bez zmian.'
    ]
  },
  {
    version: 11,
    date: '2026-11-17',
    env: 'produkcja',
    title: 'Referencja EO i klient przy każdej pozycji',
    changes: [
      'Każda pozycja każdej faktury z zamówienia (proforma, zaliczkowa, końcowa, VAT, zbiorcza, dzienna) ma pod nazwą referencję jak na wzorze Cozy: EO/numer zlecenia/pozycja/commission zlecenia-commission pozycji, np. „EO/273266/1/DANKERS-273266”. Dotyczy faktur HKL → organizacja, HKL → klient i organizacja → klient.',
      'HKL → organizacja (np. Luxan): w tym samym wierszu klient organizacji (konto, które złożyło zlecenie: ident i nazwa), np. „Klient: Matthes – Lamellen und Jalousienreinigung Matthes”.',
      'Commission pozycji nie powtarza się już w szarym opisie, bo jest w referencji. Kolumna „Zamówienie” zostaje; na fakturach dziennych poziomu 1 ma sam numer (klient ma własny wiersz).',
      'Dotyczy faktur wystawionych od tej wersji. Starsze trzeba by przepisać osobno.'
    ]
  },
  {
    version: 10,
    date: '2026-11-16',
    env: 'produkcja',
    title: 'Faktura in blanco: wygodniejszy formularz, podsumowanie na żywo, szkice, języki',
    changes: [
      'Formularz w krokach (wystawca, nabywca, pozycje, warunki). Przy każdym kroku widać, czego brakuje, a błąd pojawia się przy konkretnym polu, w języku panelu (pl, en, de).',
      'Podsumowanie liczy się na bieżąco po stronie serwera, bez zapisu: kwoty netto/VAT/brutto, rodzaj opodatkowania (krajowa, odwrotne obciążenie, WDT, eksport) z notą prawną, język dokumentu i orientacyjny numer faktury. Szkic powstaje dopiero przy „Podgląd PDF”.',
      'Nabywca: podpowiedzi z adresem i numerem VAT, „ostatnio wybierani”, karta nabywcy, przycisk „Sprawdź w VIES”, kontrola formatu numeru VAT-UE i e-maila.',
      'Pozycje: gotowe szablony (Transport, Montaż, Naprawa, Refaktura kosztów) z nazwą w języku dokumentu, duplikowanie, kolejność, Enter = nowa pozycja, przecinek dziesiętny. Opis pod nazwą, do 1000 znaków.',
      'Lista ostatnich faktur in blanco: wznowienie albo porzucenie szkicu, PDF, „Nowa na podstawie” (nabywca i pozycje bez dat i numeru). Po wystawieniu: numer, PDF, podgląd, „Nowa faktura”.',
      'Bez zmian w numeracji, VAT i automacie faktur. Nadal tylko admin, bez automatycznej wysyłki mailem i na FTP.'
    ]
  },
  {
    version: 9,
    date: '2026-11-16',
    env: 'produkcja',
    title: 'Faktura in blanco i refaktura (bez zamówienia)',
    changes: [
      'Nowe narzędzie admina: panel faktur → „Faktura in blanco” (/invoices/blank). Wystawca to organizacja z formatką (HKL, Luxan GmbH, Cozy). Nabywca: organizacja, konto klienta albo dane wpisane ręcznie. Pozycje dowolne: nazwa, opis, ilość, jednostka, cena jedn. netto, towar albo usługa.',
      'Numer z serii wystawcy, jak przy fakturach z zamówień (Cozy: 26000009…, HKL: 2026/…). VAT według krajów stron, np. usługa NL → DE dla firmy: 0 % z dopiskiem „Btw verlegd”. Język według kraju nabywcy albo wybrany.',
      'Refaktura kosztów (np. transport Cozy → FENIX): zaznaczenie „Refaktura” dopisuje na fakturze „Weiterberechnung von Kosten: <dokument źródłowy>” (w języku dokumentu) i takie oznaczenie w nagłówku.',
      'Najpierw szkic z podglądem (bez numeru, można poprawić), potem „Wystaw”. Wystawionej faktury nie da się anulować, tylko skorygować.',
      'Poprawka: szkic faktury wystawiany z panelu bierze numer z serii wystawcy. Wcześniej brał stary licznik organizacji, więc u Cozy dałby 26000001, numer już użyty w PROD.',
      'Wzór MaizonCozy: dopisek o odwrotnym obciążeniu przy usługach dla firm z UE i uwagi z faktur in blanco. Zwykłe faktury Cozy z zamówień bez zmian.',
      'Po uwagach Pawła (16.11): na wzorze Cozy opis pozycji pod nazwą (wiersz po wierszu) i bez kolumny „Prijsgroep”. PDF do pobrania już z podglądu szkicu. Opis pozycji w formularzu jako większe pole, do 1000 znaków.'
    ]
  },
  {
    version: 8,
    date: '2026-11-16',
    env: 'produkcja',
    title: 'Numeracja faktur Cozy → klient jak w PROD: 26000008',
    changes: [
      'Faktury Cozy dla jej klientów mają 8-cyfrowy numer jak w PROD (rok 2-cyfrowy + 6 cyfr licznika). Pierwsza faktura z E-Form: 26000008, kolejne 26000009… Inny numer automat Wiktorii odrzuca. Od tej faktury PROD nie wystawia już faktur Cozy (mail Wiktorii z 16.11).',
      'Wzorzec w profilu organizacji (invoice_organization_profile.number_patterns = {"invoice":"{YY}{NR:6}"}), licznik Cozy przestawiony z 8 na 7. Testowe faktury 2026/00001–00008 zostały ze starymi numerami. HKL i Luxan GmbH bez zmian (2026/00001).'
    ]
  },
  {
    version: 7,
    date: '2026-11-07',
    env: 'produkcja',
    title: 'Opis pozycji: produkt, model, dodatki; cena – ilość – wartość (uwagi KK)',
    changes: [
      'Nazwa pozycji to zawsze produkt: dział i grupa, np. „VERTIKALJALOUSIE”, „ROLETY – BB24”. Wcześniej stała tam nazwa własna pozycji (pokój, np. „Bad / EG”, albo goły kod katalogowy) albo zdublowane „VORHÄNGE VORHÄNGE”.',
      'Pod każdą pozycją, na całą szerokość tabeli, krótka specyfikacja w języku zlecenia: model, kolor, sterowanie, napęd i inne wybrane opcje (6 głównych parametrów, jak w specyfikacji ceny). Po niej nazwa własna pozycji, komisja i komentarz klienta.',
      'Nowa kolumna „Cena jedn. netto” (cena – ilość – wartość), wymagana też na fakturze VAT. Cena jednostkowa = wartość pozycji / ilość, zaokrąglona do grosza.',
      'Klient organizacji z rabatem (ceny SUB___): cena jedn. przed rabatem, rabat, cena jedn. po rabacie i wartość netto. Suma „przed rabatem” w wierszu RAZEM zniknęła (pod cenami jednostkowymi nie ma sensu).',
      'Nowe nazwy i opisy mają faktury wystawione od wdrożenia. Wcześniejsze zachowują zapisane nazwy i opisy, kolumnę ceny jednostkowej dostają przy ponownym wydruku.',
      '13.11: wszystkie 21 faktur z Cozy (HKL → Cozy, także dzienne, i Cozy → klienci) przepisane według tej reguły na polecenie Pawła: 92 pozycje. Kwoty, numery i daty bez zmian, PDF-y podmienione na FTP i wysłane mailem do testerów. Pozostałe faktury sprzed 7.11 mają jeszcze stare nazwy.'
    ]
  },
  {
    version: 6,
    date: '2026-11-07',
    env: 'produkcja',
    title: 'Stopka HKL bez ukrytych wycinków',
    changes: [
      'Formatka HKL nie zawiera już kawałków oryginalnego PDF-u. W części przeglądarek nad kreską stopki wychodziły napisy wyróżnień (GEPARD BIZNESU, MOCNA FIRMA…), a rachunki EUR/PLN rysowały się podwójnie.',
      'PDF faktury HKL ma ok. 150–170 KB zamiast ok. 900 KB. IBAN skopiowany z faktury wkleja się ze zwykłymi spacjami.'
    ]
  },
  {
    version: 5,
    date: '2026-11-06',
    env: 'produkcja',
    title: 'Faktury dzienne HKL, jedna seria numerów, faktury od 1.09',
    changes: [
      'Faktury dzienne HKL, obok faktur per zlecenie: HKL → organizacja (jedna na organizację i dzień; klienci alfabetycznie, u klienta zlecenia po kolei) i HKL → klient HKL (jedna na klienta i dzień). Na FTP w katalogu dzienne/, mailem do testerów.',
      'Jedna seria numerów na firmę: faktury HKL do organizacji i do klientów mają kolejne numery z jednego licznika. 97 faktur HKL → organizacja ze zdublowanymi numerami usunięto i wystawiono ponownie (od 2026/00293).',
      'Automat wystawia faktury za wysyłki od 1.09 (wcześniej od 1.10).',
      'Dane firmy HKL (adres, REGON, tel., NIP) przeniesione z nagłówka do stopki, obok rachunków.',
      'Maile z fakturami po 10 na godzinę (przy większych paczkach home.pl oznaczał je jako spam).'
    ]
  },
  {
    version: 4,
    date: '2026-11-03',
    env: 'test',
    title: 'Wzór faktury MaizonCozy dla klientów Cozy',
    changes: [
      'Faktury Cozy → jej klienci na osobnym wzorze MaizonCozy (wzór Wiktorii z 23.10). Tylko test, na produkcji niewdrożone.'
    ]
  },
  {
    version: 3,
    date: '2026-10-30',
    env: 'produkcja',
    title: 'PDF na FTP',
    changes: [
      'Każda faktura automatu trafia na FTP: /invoices/hkl-organizacja/<ORGANIZACJA>/ i /invoices/organizacja-klient/<ORGANIZACJA>/<KLIENT>/.',
      'Skrzynka fakturaefor@hkl.eu dostaje maile z fakturami razem z testerami.'
    ]
  },
  {
    version: 2,
    date: '2026-10-26',
    env: 'produkcja',
    title: 'Niższy nagłówek',
    changes: [
      'Góra faktury o połowę niższa (uwaga KK: zajmowała 1/3 strony): mniejsze logo, nazwa i daty w jednym wierszu.',
      '27.10: bez wyróżnień (Gepard Biznesu itd.) w stopce HKL, bo po zmniejszeniu były nieczytelne.'
    ]
  },
  {
    version: 1,
    date: '2026-10-23',
    env: 'produkcja',
    title: 'Język klienta, układ poziomy, rabat w 3 kolumnach, faktury zbiorcze',
    changes: [
      'Język faktury według kraju klienta: NL niderlandzki, PL polski, DE i AT niemiecki, FR francuski, reszta angielski.',
      'Wszystkie faktury poziomo, HKL na poziomym papierze firmowym.',
      'Klient organizacji z ceną SUB___: kolumny cena przed rabatem | rabat | cena po rabacie.',
      'Faktury zbiorcze tygodniowe i miesięczne (ustawienie klienta w /admin/users).',
      'Więcej testerów w mailach: Paweł, Krzysztof, Rafał, Grzegorz.'
    ]
  },
  {
    version: 0,
    date: '2026-10-22',
    env: 'produkcja',
    title: 'Start',
    changes: [
      'Automat faktur na produkcji: faktura za każde zlecenie wysłane (!sent!), poziomy 1–4, za wysyłki od 1.10.',
      'Faktura na papierze firmowym wystawcy (HKL, Luxan GmbH, Cozy), VAT według kraju nabywcy.',
      'Mail z PDF tylko do testerów, moduł faktur widoczny tylko dla admina, cykl co godzinę z crona.'
    ]
  }
]);

const CURRENT_INVOICE_VERSION = INVOICE_VERSIONS[0].version;

module.exports = { INVOICE_VERSIONS, CURRENT_INVOICE_VERSION };
