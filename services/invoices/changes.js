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
    version: 7,
    date: '2026-11-07',
    env: 'test',
    title: 'Opis pozycji: produkt, model, dodatki; cena – ilość – wartość (uwagi KK)',
    changes: [
      'Nazwa pozycji to zawsze produkt: dział i grupa, np. „VERTIKALJALOUSIE”, „ROLETY – BB24”. Wcześniej stała tam nazwa własna pozycji (pokój, np. „Bad / EG”, albo goły kod katalogowy) albo zdublowane „VORHÄNGE VORHÄNGE”.',
      'Pod każdą pozycją, na całą szerokość tabeli, krótka specyfikacja w języku zlecenia: model, kolor, sterowanie, napęd i inne wybrane opcje (6 głównych parametrów, jak w specyfikacji ceny). Po niej nazwa własna pozycji, komisja i komentarz klienta.',
      'Nowa kolumna „Cena jedn. netto” (cena – ilość – wartość), wymagana też na fakturze VAT. Cena jednostkowa = wartość pozycji / ilość, zaokrąglona do grosza.',
      'Klient organizacji z rabatem (ceny SUB___): cena jedn. przed rabatem, rabat, cena jedn. po rabacie i wartość netto. Suma „przed rabatem” w wierszu RAZEM zniknęła (pod cenami jednostkowymi nie ma sensu).',
      'Nowe nazwy i opisy mają faktury wystawione od wdrożenia. Wcześniejsze zachowują zapisane nazwy i opisy, kolumnę ceny jednostkowej dostają przy ponownym wydruku.'
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
