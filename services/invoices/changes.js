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
