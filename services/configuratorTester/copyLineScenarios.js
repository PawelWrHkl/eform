/**
 * Scenariusze kopiowania odtworzone z przypadków Ryver (2026-10-12/13) —
 * zestaw regresji robota kopiowania (copyLineRunner.js). Każdy scenariusz:
 * pozycja bazowa (najnowsza pasująca pozycja grupy z bazy + nadpisane pola)
 * → kopia wybraną ścieżką → kroki jak u klienta → zapis → porównanie.
 *
 * `mode`: 'ostatnia' — „wczytaj ostatnią konfigurację" na stronie nowej
 * pozycji (tak kopiuje Ryver), 'duplikat' — przycisk „Duplikuj" → edycja.
 * `watch`: pola pilnowane w zapisanej kopii (reszta może się zmienić
 * w skutek kroków). `department`: numer działu z interfejsu konta symulatora.
 */

'use strict';

/**
 * Wbudowane scenariusze. `override`: wartość albo [wartość, opis opcji];
 * `''` czyści pole (razem z opisem). `expectChanged` — pola, które scenariusz
 * zmienia celowo. `expectBlocked` — zapis MA zostać zablokowany na tych polach.
 */
const SCENARIOS = {
  'vertical-ostatnia': {
    opis: 'Vertical (14), „ostatnia konfiguracja", MODEL 2L→1R, szerokość 910, ilość 3 — oferta Ryver 351',
    group: '14', department: '4', mode: 'ostatnia',
    base: { KONFIGURACJA: 'S' },
    override: {
      MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'],
      PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 1780, DLUGOSC_STER: 1500
    },
    watch: ['KONFIGURACJA', 'RODZAJ', 'MODEL', 'KOLOR_SYSTEMU', 'PASEK', 'SZEROKOSC', 'KORALIK_OBSL', 'DLUGOSC_STER', 'PROTEKCJA', 'ILOSC'],
    steps: [
      { type: 'dialog', name: 'MODEL', value: '1R' },
      { type: 'fill', name: 'SZEROKOSC', value: 910 },
      { type: 'fill', name: 'ILOSC', value: 3 }
    ],
    expectChanged: ['MODEL', 'SZEROKOSC', 'ILOSC']
  },
  'vertical-ostatnia-bez-zmian': {
    opis: 'Vertical (14), „ostatnia konfiguracja" i zapis bez żadnej zmiany',
    group: '14', department: '4', mode: 'ostatnia',
    base: { KONFIGURACJA: 'S' },
    override: { MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'], PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 1780 },
    watch: ['KONFIGURACJA', 'RODZAJ', 'MODEL', 'KOLOR_SYSTEMU', 'PASEK', 'SZEROKOSC', 'KORALIK_OBSL', 'DLUGOSC_STER', 'PROTEKCJA', 'ILOSC'],
    steps: []
  },
  'vertical-uszkodzony-localstorage': {
    opis: 'Vertical (14), „ostatnia konfiguracja" ze stanem uszkodzonym przez stary błąd (opis PASEK bez option_value)',
    group: '14', department: '4', mode: 'ostatnia',
    base: { KONFIGURACJA: 'S' },
    override: { MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'], PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 1780 },
    corruptStorage: ['PASEK'],
    watch: ['MODEL', 'PASEK', 'SZEROKOSC'],
    steps: []
  },
  'vertical-duplikat': {
    opis: 'Vertical (14), „duplikuj" → edycja, MODEL 2L→1R, szerokość 910, ilość 3',
    group: '14', department: '4', mode: 'duplikat',
    base: { KONFIGURACJA: 'S' },
    override: { MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'], PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 1780 },
    watch: ['KONFIGURACJA', 'RODZAJ', 'MODEL', 'KOLOR_SYSTEMU', 'PASEK', 'SZEROKOSC', 'KORALIK_OBSL', 'DLUGOSC_STER', 'PROTEKCJA', 'ILOSC'],
    steps: [
      { type: 'dialog', name: 'MODEL', value: '1R' },
      { type: 'fill', name: 'SZEROKOSC', value: 910 },
      { type: 'fill', name: 'ILOSC', value: 3 }
    ],
    expectChanged: ['MODEL', 'SZEROKOSC', 'ILOSC']
  },
  'rzymska-ostatnia': {
    // Ryver i Kaya_Exclusive (13.10): w kopiach rzymskich ginęły STOFF, SYSTEM,
    // RODZAJ_SZYCIA. Dział bierzemy z interfejsu konta symulatora.
    opis: 'Roleta rzymska (24), „ostatnia konfiguracja", sterowanie ręczne, szerokość → 1500',
    group: '24', mode: 'ostatnia',
    base: { STEROWANIE: 'K' },
    override: {},
    watch: ['KONFIGURACJA', 'SYSTEM', 'STOFF', 'KOLOR', 'KOLOR_KUNDE', 'RODZAJ_SZYCIA', 'PODSZEWKA', 'WYSOKOSC',
      'OSTATNI_SEG', 'STEROWANIE', 'KOLOR_SYSTEMU', 'STRONA_STEROWANIA', 'KORALIK_OBSL', 'OCHRONA_CHILD_SAFETY', 'MONTAZ', 'ILOSC'],
    steps: [{ type: 'fill', name: 'SZEROKOSC', value: 1500 }],
    expectChanged: ['SZEROKOSC']
  },
  'h50-ostatnia': {
    opis: 'Żaluzja drewniana H50 (59), „ostatnia konfiguracja", szerokość 2720, strona LL — zlecenie Ryver 266',
    group: '59', department: '2', mode: 'ostatnia',
    // Kolor przypięty: zakres szerokości zależy od koloru lameli — 14.10 nowsza
    // pozycja #7706 (5552-50) nie dopuszcza 2720 i scenariusz „padał" na walidacji.
    base: { MODEL: 'H50', STEROWANIE: 'S', KOLOR: '5549-50' },
    override: {
      STRONA_STEROWANIA: ['RR', 'TREKKOORD - TUIMELKOORD RECHTS'], OCHRONA_CHILD_SAFETY: ['CS_NO', 'nein'],
      BLENDA: ['IDD', 'IDD'], DLUGOSC_STER: 1300, SZEROKOSC: 970, WYSOKOSC: 1635
    },
    watch: ['MODEL', 'STEROWANIE', 'STRONA_STEROWANIA', 'KOLOR', 'SZEROKOSC', 'WYSOKOSC', 'RODZAJ_TEXT', 'OCHRONA_CHILD_SAFETY', 'DLUGOSC_STER', 'PROWADZENIE', 'BLENDA', 'MONTAZ', 'ILOSC'],
    steps: [
      { type: 'fill', name: 'SZEROKOSC', value: 2720 },
      { type: 'dialog', name: 'STRONA_STEROWANIA', value: 'LL' }
    ],
    expectChanged: ['SZEROKOSC', 'STRONA_STEROWANIA']
  },
  'h50-duplikat-zabezpieczenie': {
    opis: 'H50 (59), „duplikuj" → ponowny wybór CS_NO: długość sterowania 1300 → 865 jak w zleceniu 266, KOOF bez zmian',
    group: '59', department: '2', mode: 'duplikat', repeat: 1,
    base: { MODEL: 'H50', STEROWANIE: 'S' },
    override: {
      STRONA_STEROWANIA: ['RR', 'TREKKOORD - TUIMELKOORD RECHTS'], OCHRONA_CHILD_SAFETY: ['CS_NO', 'nein'],
      BLENDA: ['IDD', 'IDD'], DLUGOSC_STER: 1300, SZEROKOSC: 970, WYSOKOSC: 1635
    },
    watch: ['MODEL', 'STEROWANIE', 'STRONA_STEROWANIA', 'OCHRONA_CHILD_SAFETY', 'DLUGOSC_STER', 'PROWADZENIE', 'BLENDA', 'MONTAZ'],
    steps: [{ type: 'dialog', name: 'OCHRONA_CHILD_SAFETY', value: 'CS_NO' }],
    expectChanged: ['DLUGOSC_STER']
  },
  'h50-pusty-koof': {
    opis: 'H50 (59), pozycja z pustym KOOF, „duplikuj" → zapis bez zmian MUSI zostać zablokowany',
    group: '59', department: '2', mode: 'duplikat', repeat: 1,
    base: { MODEL: 'H50', STEROWANIE: 'S' },
    override: {
      STRONA_STEROWANIA: ['RR', 'TREKKOORD - TUIMELKOORD RECHTS'], OCHRONA_CHILD_SAFETY: ['CS_NO', 'nein'],
      BLENDA: '', DLUGOSC_STER: 1300, SZEROKOSC: 970, WYSOKOSC: 1635
    },
    watch: ['BLENDA'],
    steps: [],
    expectBlocked: ['BLENDA']
  },

  // Walidacja zakresów (MIN/MAX z procedur) po „ostatniej konfiguracji" —
  // zgłoszenie 2026-10-16: formularz z localStorage nie pilnował wymiarów.
  'vertical-ostatnia-za-waska': {
    opis: 'Vertical (14), „ostatnia konfiguracja", szerokość 50 (MIN 500) — zapis MUSI zostać zablokowany',
    group: '14', department: '4', mode: 'ostatnia', repeat: 1,
    base: { KONFIGURACJA: 'S' },
    override: { MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'], PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 1780 },
    watch: ['SZEROKOSC'],
    steps: [{ type: 'fill', name: 'SZEROKOSC', value: 50 }],
    expectBlocked: ['SZEROKOSC']
  },
  'vertical-ostatnia-za-szeroka': {
    opis: 'Vertical (14), „ostatnia konfiguracja", szerokość 9000 (MAX 6900) — zapis MUSI zostać zablokowany',
    group: '14', department: '4', mode: 'ostatnia', repeat: 1,
    base: { KONFIGURACJA: 'S' },
    override: { MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'], PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 1780 },
    watch: ['SZEROKOSC'],
    steps: [{ type: 'fill', name: 'SZEROKOSC', value: 9000 }],
    expectBlocked: ['SZEROKOSC']
  },
  'vertical-ostatnia-zly-wymiar-w-kopii': {
    opis: 'Vertical (14), kopiowana linia ma już szerokość 9000 — zapis kopii BEZ zmian MUSI zostać zablokowany',
    group: '14', department: '4', mode: 'ostatnia', repeat: 1,
    base: { KONFIGURACJA: 'S' },
    override: { MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'], PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 9000 },
    watch: ['SZEROKOSC'],
    steps: [],
    expectBlocked: ['SZEROKOSC']
  },
  'vertical-duplikat-za-waska': {
    opis: 'Vertical (14), „duplikuj" → edycja, szerokość 50 (MIN 500) — zapis MUSI zostać zablokowany',
    group: '14', department: '4', mode: 'duplikat', repeat: 1,
    base: { KONFIGURACJA: 'S' },
    override: { MODEL: ['2L', 'Controle links, slatpakket rechts'], PASEK: ['B2', '89MM'], PROTEKCJA: ['NO_PROT', 'ZONDER LAMELOVERSTEK'], SZEROKOSC: 1780 },
    watch: ['SZEROKOSC'],
    steps: [{ type: 'fill', name: 'SZEROKOSC', value: 50 }],
    expectBlocked: ['SZEROKOSC']
  },
  'h50-ostatnia-za-waska': {
    opis: 'H50 (59), „ostatnia konfiguracja", szerokość 100 (MIN 300) — zapis MUSI zostać zablokowany',
    group: '59', department: '2', mode: 'ostatnia', repeat: 1,
    base: { MODEL: 'H50', STEROWANIE: 'S', KOLOR: '5549-50' },
    override: {
      STRONA_STEROWANIA: ['RR', 'TREKKOORD - TUIMELKOORD RECHTS'], OCHRONA_CHILD_SAFETY: ['CS_NO', 'nein'],
      BLENDA: ['IDD', 'IDD'], DLUGOSC_STER: 1300, SZEROKOSC: 970, WYSOKOSC: 1635
    },
    watch: ['SZEROKOSC'],
    steps: [{ type: 'fill', name: 'SZEROKOSC', value: 100 }],
    expectBlocked: ['SZEROKOSC']
  },
  'h50-ostatnia-dlugosc-sterowania': {
    opis: 'H50 (59), „ostatnia konfiguracja", długość sterowania 20 (MIN2 50) — zapis MUSI zostać zablokowany',
    group: '59', department: '2', mode: 'ostatnia', repeat: 1,
    base: { MODEL: 'H50', STEROWANIE: 'S', KOLOR: '5549-50' },
    override: {
      STRONA_STEROWANIA: ['RR', 'TREKKOORD - TUIMELKOORD RECHTS'], OCHRONA_CHILD_SAFETY: ['CS_NO', 'nein'],
      BLENDA: ['IDD', 'IDD'], DLUGOSC_STER: 1300, SZEROKOSC: 970, WYSOKOSC: 1635
    },
    watch: ['DLUGOSC_STER'],
    steps: [{ type: 'fill', name: 'DLUGOSC_STER', value: 20 }],
    expectBlocked: ['DLUGOSC_STER']
  }
};

module.exports = { SCENARIOS };
