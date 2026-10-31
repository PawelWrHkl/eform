---
name: eForm — wariant B „Efor 2.0”
description: Portal zamówieniowy producenta osłon okiennych; wariant B to makiety szefa doprowadzone do końca (turkus, bursztyn, krem, Inter), na telefonie natywnie jak iOS.
colors:
  teal: "#265b63"
  teal-deep: "#1b464d"
  teal-night: "#12353a"
  teal-mid: "#3f7f88"
  teal-mist: "#d3e7e9"
  teal-wash: "#e3f1f2"
  amber: "#f7b417"
  amber-hover: "#efaa0c"
  amber-press: "#df9d06"
  amber-ink: "#1b1403"
  amber-cream: "#fdebc4"
  amber-pill: "#fef3dd"
  amber-line: "#f3cf7a"
  cream-hover: "#fefaf1"
  page-bg: "#f7f5f1"
  sidebar: "#fefefd"
  card: "#ffffff"
  sunken: "#f4f2ed"
  hover: "#f8f6f1"
  ink: "#0b1324"
  text: "#1f2733"
  text-2: "#4a5361"
  muted: "#6b7380"
  soft: "#9aa1ab"
  line: "#e8e6e0"
  line-2: "#dfe1e5"
  line-strong: "#c9ced6"
  disabled-bg: "#dcdee2"
  disabled-ink: "#8a919c"
  neutral-btn: "#e6e9ed"
  neutral-btn-hover: "#dde1e6"
  bronze: "#977c5c"
  danger: "#c0392b"
  danger-ink: "#a3261a"
  danger-wash: "#fdeeec"
  danger-line: "#f3c5bf"
  success: "#1e7f55"
  success-wash: "#e6f4ec"
  warning-ink: "#8a5a00"
  dark-bg: "#0f1619"
  dark-sidebar: "#131c20"
  dark-card: "#182227"
  dark-sunken: "#131b1f"
  dark-hover: "#1d2930"
  dark-ink: "#eef3f4"
  dark-text: "#dce4e6"
  dark-text-2: "#b4c1c5"
  dark-muted: "#93a3a8"
  dark-teal-mid: "#5aa3ad"
  dark-danger: "#f07b6e"
  dark-success: "#4fc08d"
  dark-warning-ink: "#f3c75f"
  ios-bar: "rgba(247, 245, 241, .82)"
  ios-tabbar: "rgba(252, 251, 249, .86)"
  ios-sep: "rgba(11, 19, 36, .14)"
  ios-sep-inset: "rgba(11, 19, 36, .1)"
  ios-fill: "rgba(118, 112, 98, .12)"
  ios-fill-press: "rgba(118, 112, 98, .2)"
  ios-gray: "#8a8f98"
  ios-row-press: "#efece6"
  ios-tint-dark: "#8cc3cb"
  ios-bar-dark: "rgba(15, 22, 25, .8)"
  ios-tabbar-dark: "rgba(19, 28, 32, .86)"
typography:
  display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(30px, 1.6vw + 16px, 44px)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.03em"
    fontFeature: "'cv11', 'ss01'"
  display-phone:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15.5px"
    fontWeight: 500
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    fontFeature: "'cv11', 'ss01'"
  body-phone:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    letterSpacing: "0.01em"
  label-caps:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.08em"
  caption:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  tab-label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.01em"
rounded:
  sm: "8px"
  ctl: "10px"
  btn: "10px"
  table: "12px"
  ios: "12px"
  card: "14px"
  dialog: "16px"
  2xl: "18px"
  pill: "9999px"
spacing:
  gutter: "24px"
  phone-gutter: "16px"
  nav-w: "280px"
  nav-w-collapsed: "60px"
  topbar-h: "72px"
  admin-bar-h: "56px"
  phone-navbar-h: "44px"
  phone-tabbar-h: "50px"
  card-head-pad: "14px 22px"
  card-body-pad: "18px 22px 22px"
  field-min-h: "46px"
  field-sm-min-h: "38px"
  icon-btn: "40px"
  row-min-h: "44px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
    rounded: "{rounded.btn}"
  button-primary-hover:
    backgroundColor: "{colors.amber-hover}"
    textColor: "{colors.amber-ink}"
  button-primary-active:
    backgroundColor: "{colors.amber-press}"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
  button-neutral:
    backgroundColor: "{colors.neutral-btn}"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
  button-neutral-hover:
    backgroundColor: "{colors.neutral-btn-hover}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.card}"
    rounded: "{rounded.btn}"
  button-danger-hover:
    backgroundColor: "{colors.danger-ink}"
  button-disabled:
    backgroundColor: "{colors.disabled-bg}"
    textColor: "{colors.disabled-ink}"
  button-icon:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
    size: "{spacing.icon-btn}"
  field:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.ctl}"
    height: "{spacing.field-min-h}"
  field-readonly:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text-2}"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-body-pad}"
  card-head:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.card}"
    typography: "{typography.headline}"
    padding: "{spacing.card-head-pad}"
  table-head:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.card}"
    typography: "{typography.label}"
    padding: "14px 16px"
  summary-total:
    backgroundColor: "{colors.amber-cream}"
    textColor: "{colors.ink}"
    rounded: "{rounded.table}"
    padding: "14px 16px"
  pill:
    backgroundColor: "{colors.amber-pill}"
    textColor: "#6f4f09"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
  pill-sent:
    backgroundColor: "{colors.teal-wash}"
    textColor: "{colors.teal}"
    rounded: "{rounded.pill}"
  nav-item:
    textColor: "{colors.text}"
    rounded: "{rounded.ctl}"
    padding: "10px 14px"
    typography: "{typography.title}"
  nav-item-active:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
  dropdown-item-active:
    backgroundColor: "{colors.amber-pill}"
    textColor: "{colors.ink}"
  toast:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.table}"
    width: "340px"
  pagination-active:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
  phone-tabbar:
    backgroundColor: "{colors.ios-tabbar}"
    textColor: "{colors.ios-gray}"
    height: "{spacing.phone-tabbar-h}"
  phone-tabbar-active:
    textColor: "{colors.teal}"
  phone-group:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.ios}"
  phone-search:
    backgroundColor: "{colors.ios-fill}"
    rounded: "{rounded.ctl}"
---

# Design System: eForm — wariant B „Efor 2.0”

Portal ma dwa równorzędne warianty wyglądu. **Wariant A (klasyczny, domyślny)** jest zamrożony: tokeny w `public/styles/theme.css` (łupkowy `--brand-primary` #5e6e82, akcent #6b9dad, gradienty, tło #f8fafc, promienie 8/12/16/24 px, Inter), warstwa telefonu w `public/styles/mobile/*` na tokenach `--m-*` z `public/styles/mobile/tokens.css` (akcent złoty #d4a437, tło #f4f5f7, tusz #2b3a4e). Ten plik nie opisuje A dalej poza jedną regułą: A pozostaje identyczny piksel po pikselu. Wszystko poniżej to **wariant B**, czyli `public/styles/theme-efor-v2.css` pod klasą `.theme-efor-v2` na `<html>` (ustawia ją `public/scripts/uiVariant.js`), niezależnie od trybu jasnego/ciemnego (`[data-theme="dark"]`).

## Overview

**Creative North Star: "Makieta szefa, doprowadzona do końca"**

B to makiety z `wizualizacja efor/` przeniesione na każdy ekran portalu, łącznie z tymi, których makiety nie pokazują (stany, tryb ciemny, admin, telefon). Ciepłe jasne tło, białe karty z cienką linią, turkusowe paski nagłówków kart i tabel, bursztyn wyłącznie na akcji głównej i na aktywnej pozycji, krem w sumach i plakietkach. Gęstość jest robocza, nie marketingowa: duże pola (46 px), wyraźne etykiety 600, tabele z pełnymi danymi, jeden duży tytuł po lewej i od razu treść.

Na telefonie (< 768 px) ten sam świat zachowuje się jak natywna aplikacja iOS: półprzezroczysty materiał pasków, duży tytuł dokujący w pasku nawigacji, zgrupowane listy z chevronami, pasek kart (Start / Oferty / Zamówienia / Więcej) z turkusowym tintem, arkusz „Więcej” od dołu, akcja główna przy kciuku. Odrzucone wprost: strona zmniejszona z desktopu (hamburger, pływające pola, stopka nad paskiem kart) oraz — decyzją właściciela 2026-10-29 — nowy świat wizualny B (grafit, pomarańcz, zieleń, Archivo). Zmiany w B to dopracowanie w tej palecie, nie nowy wygląd.

**Key Characteristics:**
- Turkus (#265b63) jako kolor struktury: paski nagłówków kart i tabel, linki, focus pól, tint iOS.
- Bursztyn (#f7b417) jako kolor działania: akcja główna, aktywna pozycja nawigacji, aktywna strona paginacji — zawsze z ciemnym tekstem #1b1403.
- Krem jako kolor pieniędzy i statusu: sumy (#fdebc4), plakietki (#fef3dd), zaznaczony kafelek konfiguratora (#fefaf1).
- Płaskie białe karty na ciepłym tle (#f7f5f1), cień ledwie widoczny.
- Inter z `cv11` + `ss01`; duży, ciężki tytuł wyrównany do lewej, bez napisu nad nim.
- Telefon: materiał iOS w palecie B, tint turkusowy, akcja główna bursztynowa.

## Colors

Ciepła, papierowa baza z dwoma akcentami o rozdzielonych rolach: turkus organizuje, bursztyn wzywa do działania, krem oznacza sumy i stan.

### Primary
- **Turkus nagłówków** (teal): paski nagłówków kart, nagłówki tabel (biały tekst), linki, focus pól (obrys + pierścień `rgba(38, 91, 99, .22)`), zaznaczone checkboxy, ikona toastu informacyjnego, tint iOS na telefonie. Ciemniejszy **turkus głęboki** (teal-deep) na hover linków; **turkus nocny** (teal-night) w tle podpowiedzi. **Mgła** i **obmycie** turkusowe (teal-mist, teal-wash) w plakietce „wysłane”, ikonach menu konta i ilustracjach.

### Secondary
- **Bursztyn akcji** (amber): przycisk główny, aktywna pozycja paska bocznego, aktywna strona paginacji, „Nowa oferta” na pulpicie, obrys zaznaczonego kafelka (2 px), pierścień focusa klawiatury `rgba(247, 180, 23, .5)`. Hover (amber-hover) i wciśnięcie (amber-press) to o ton ciemniej; amber-press barwi też ikonę toastu ostrzeżenia. Tekst na bursztynie to zawsze **tusz bursztynowy** (amber-ink) — w trybie ciemnym bursztyn i jego tusz się nie zmieniają.

### Tertiary
- **Krem sumy** (amber-cream): pole sumy w panelu podsumowania oferty, zaznaczenie tekstu.
- **Krem plakietek** (amber-pill): plakietki statusu i środowiska, aktywna pozycja menu rozwijanego, pole organizacji w pasku admina; obrys amber-line.
- **Krem najechania** (cream-hover): hover/zaznaczenie kafelka produktu i systemu, hover przycisków paska admina.

### Neutral
- **Ciepłe tło strony** (page-bg) pod wszystkim; **pasek boczny** (sidebar) o włos jaśniejszy; **karta** (card) biała; **zagłębienie** (sunken) dla pól tylko do odczytu, hover menu i szkieletów; **hover** wierszy tabel.
- **Tusz tytułów** (ink) dla nagłówków i wartości; **tekst** (text) treści; **tekst 2** (text-2) drugorzędny; **wyciszony** (muted) etykiet wersalikowych; **miękki** (soft) placeholderów i e-maili.
- **Linie**: line (karty, separatory), line-2 (pola, przyciski-ikony), line-strong (obrys przycisku drugiego, hover pól).
- **Wyłączone**: disabled-bg + disabled-ink, wspólne dla wszystkich poziomów przycisków. **Przycisk neutralny**: neutral-btn. **Brąz awatara** (bronze) tylko w kółku konta.
- **Stany**: danger / danger-ink / danger-wash / danger-line (błąd pola, alert, usuwanie), success / success-wash, warning-ink (tekst ostrzeżeń i plakietek w trybie ciemnym).
- **Tryb ciemny** (propozycja bez makiety): grafitowe tła z domieszką turkusu (dark-bg, dark-sidebar, dark-card), jasny tusz (dark-ink), linie jako biel 8/13/22 %, kremy jako bursztyn 7–20 % krycia, turkusowe obmycia jako #5aa3ad 14–24 %.

### Named Rules
**The Function Colour Rule.** Kolor niesie funkcję: turkus = struktura i informacja, bursztyn = akcja i „jesteś tutaj”, krem = pieniądze i status, czerwień = błąd i usuwanie. Żaden z nich nie występuje jako dekoracja.

**The Dark Ink On Amber Rule.** Na bursztynie zawsze tusz #1b1403, w obu trybach. W trybie ciemnym `theme.css` barwi każdy `span`/`p` na jasno, dlatego sekcja 26 wymusza `color: inherit` wewnątrz bursztynowych przycisków; nowy bursztynowy przycisk trzeba dopisać do tej listy.

**The One Amber Action Rule.** Na ekranie jeden bursztynowy przycisk akcji głównej; reszta to biały z obrysem, szary neutralny albo ikona.

## Typography

**Display Font:** Inter (z -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial)
**Body Font:** Inter (ten sam stos)

**Character:** Jedna rodzina w całym B, z alternatywami `cv11` i `ss01` włączonymi na `body`. Hierarchię robi waga i rozmiar, nie zmiana kroju; nagłówki h1–h4 mają tusz tytułów i zwężenie −0.02em.

### Hierarchy
- **Display** (800, clamp(30px, 1.6vw + 16px, 44px), 1.08, −0.03em): tytuł strony na desktopie, wyrównany do lewej — oferta, konfigurator, listy, dane oferty, pulpit (nazwa firmy), strony admina.
- **Display phone** (800, 32px, 1.12, −0.025em): duży tytuł iOS na stronach głównych; po przewinięciu dokuje do paska nawigacji (`efor-title-docked`).
- **Headline** (700, 21px, 1.25, −0.01em): biały tekst na turkusowym pasku nagłówka karty.
- **Title** (500, 15.5px): pozycje paska bocznego; aktywna 700.
- **Body** (400, 15px; telefon 16px): treść, pola, menu rozwijane, etykiety checkboxów. Etykiety pól 600.
- **Label** (600, 14px, +0.01em): nagłówki kolumn tabel, bez wersalików.
- **Label caps** (600, 12px, +0.08em, wersaliki): etykiety grup danych — podpisy w sumach, etykiety filtrów list, etykieta wyboru klienta w pasku bocznym; na telefonie (400, 13px) nagłówki zgrupowanych sekcji jak w iOS.
- **Caption** (600, 13px): plakietki, komunikaty błędów pól, podpowiedzi.
- **Tab label** (600, 10.5px): podpisy pod ikonami paska kart.

### Named Rules
**The Title Speaks Alone Rule.** Nad tytułem strony nie ma napisu (eyebrow, kicker) — usunięty decyzją właściciela 2026-10-30; miejsce w nawigacji pokazują okruszki i menu. Wersaliki 12 px są etykietą danych, nigdy wstępem do tytułu.

## Layout

- **Desktop (≥ 768 px):** stały biały pasek boczny 280 px (zwinięty 60 px), pasek górny 72 px z okruszkami po lewej i przełącznikiem wyglądu, przewodnikiem, motywem, językiem i awatarem po prawej. Treść zaczyna się od `nav-w + 24 px` i ma 24 px marginesu z prawej. Admin (≥ 851 px): drugi rząd paska górnego 56 px (wyszukiwarka klienta, organizacja w kremowym polu, panel admina, hasła), treść schodzi o 60 px.
- **Oferta:** pozycje jako karty albo tabela (przełącznik `data-efor-positions`), obok panel podsumowania 340 px z kremową sumą; siatka `1fr 340px`.
- **Konfigurator:** kafelki produktu/systemu w siatce auto-fill (minmax 250–310 px), od 992 px panel ceny 360 px obok pól. Pola konfiguratora zostają w swoim miejscu DOM — układ robi CSS.
- **Pulpit (`.efor-dash`):** tytuł = nazwa firmy + bursztynowa „Nowa oferta”; trzy karty (oferty, wysłane, firma) `1fr 1fr minmax(280px, 340px)`, gap 20 px. Od 768 px karty to podsiatki (`grid-template-rows: subgrid`) dzielące wiersz nagłówka, więc turkusowe paski mają równą wysokość; 768–1279 px karta firmy schodzi do drugiego rzędu na całą szerokość.
- **Telefon (< 768 px):** margines 16 px, pasek nawigacji 44 px, pasek kart 50 px + safe-area, wiersze list ≥ 44 px, akcja główna (wyślij ofertę, zapisz pozycję) przypięta nad paskiem kart, pigułka kontekstu admina pod dużym tytułem. Kafelki produktu i panel ceny tylko od 768/992 px. Stopka znika — linki są w arkuszu „Więcej”.
- **Progi:** 768 px (powłoka desktop/telefon), 851 px (pasek admina), 992 px (panel ceny konfiguratora), 1280 px (pulpit trójkolumnowy).

## Elevation & Depth

Prawie płasko: białe karty odcinają się od ciepłego tła linią 1 px, cień jest tylko podpowiedzią. Wyraźny cień mają wyłącznie warstwy nad treścią (menu, dialogi, toasty). Na telefonie głębię robi materiał (rozmycie `saturate(180%) blur(20px)` za półprzezroczystym paskiem), a karty nie mają cienia (`--m-shadow-card: none`).

### Shadow Vocabulary
- **Karta** (`box-shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 1px 3px rgba(16, 24, 40, .05)`): każda karta, kontener, `.shadow`/`.shadow-lg`.
- **Uniesienie** (`box-shadow: 0 6px 18px -6px rgba(16, 24, 40, .14), 0 2px 6px -2px rgba(16, 24, 40, .06)`): hover klikalnych kart, podpowiedzi.
- **Wyskakujące** (`box-shadow: 0 18px 40px -12px rgba(16, 24, 40, .24), 0 6px 14px -6px rgba(16, 24, 40, .1)`): menu rozwijane, dialogi, modale, toasty.
- **Tryb ciemny:** odpowiednio `0 1px 2px rgba(0,0,0,.35)`, `0 8px 22px -8px rgba(0,0,0,.55)`, `0 22px 48px -14px rgba(0,0,0,.7)`.

### Named Rules
**The Matte Rule.** Przyciski B są matowe: bez gradientu, bez błysku `::after` z theme.css, bez cienia, bez glow. Wciśnięcie to −1 px w pionie i ton ciemniej.

**The Material Behind The Bar Rule.** Na telefonie `backdrop-filter` nakłada się na `::before` paska, nigdy na `.mobile-nav` — filtr na pasku robi z niego blok zawierający dla `position: fixed` i arkusz „Więcej” kurczy się do 44 px.

## Shapes

Łagodne zaokrąglenia rosnące z rozmiarem: pozycje menu i podpowiedzi 8 px, pola i przyciski 10 px, tabele, menu rozwijane, toasty, sumy i grupy iOS 12 px, karty 14 px, dialogi 16 px; plakietki, przełącznik wyglądu i pole środowiska to pigułki. Checkbox 20 px z promieniem 6 px. Obrysy zawsze 1 px (zaznaczony kafelek 2 px bursztynu), separatory iOS 0.5 px z wcięciem. Nagłówek tabeli zaokrągla górne rogi 11 px wewnątrz ramki 12 px; karta z paskiem nagłówka przycina go `overflow: hidden`.

## Components

### Buttons
Cztery poziomy plus ikona; płaskie, Inter 600–700, promień 10 px.
- **Shape:** łagodnie zaokrąglone (10px).
- **Primary:** bursztyn z ciemnym tuszem, 700, bez obrysu; „Speichern”, „Position hinzufügen”, wyślij zlecenie, „Nowa oferta” (48 px wysokości, 0 22 px).
- **Hover / Focus:** hover amber-hover, wciśnięcie amber-press + 1 px w dół; focus klawiatury = bursztynowy pierścień 3 px z odstępem 2 px.
- **Secondary:** biała karta, obrys line-strong, tusz 600; hover tło hover + obrys text-2. Anuluj, Wstecz, Ostatnia konfiguracja.
- **Neutral:** szare wypełnienie neutral-btn bez obrysu (resetuj wartości).
- **Danger:** czerwień z białym tekstem tylko w potwierdzeniu usunięcia; hover danger-ink.
- **Disabled:** wspólny dla wszystkich poziomów — disabled-bg, disabled-ink, bez cienia, `opacity: 1`.
- **Icon:** kafelek 40×40, biały, obrys line-2, ikona szara (w ciemnym odwrócona); wariant usuwania z czerwonym tuszem i hoverem danger-wash.

### Chips
- **Style:** pigułka 6 px 14 px, 13 px 600, krem plakietek z obrysem amber-cream i brązowym tekstem #6f4f09, kropka 9 px w bursztynie.
- **State:** „wysłane” w turkusowym obmyciu z turkusowym tekstem i kropką teal-mid; w trybie ciemnym tekst warning-ink.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** biała karta (ciemny: dark-card).
- **Shadow Strategy:** cień karty (patrz Elevation), uniesienie na hover tylko gdy cała karta jest klikalna.
- **Border:** 1 px line.
- **Internal Padding:** pasek nagłówka 14px 22px, treść 18px 22px 22px.
- **Pasek nagłówka:** wypełniony turkus, biały tekst headline 21 px, ikona przed tytułem. Etykiety pasków idą z `--efor-t-*` (CSS) albo `window.eforV2I18n` (JS). Strony admina: zewnętrzny kontener przezroczysty — bez karty w karcie.

### Inputs / Fields
- **Style:** biel, obrys 1 px line-2, promień 10 px, min. 46 px (małe 38 px), 15 px; placeholder soft; hover line-strong.
- **Focus:** obrys turkusowy + pierścień 3 px `rgba(38, 91, 99, .22)`, bez transformacji.
- **Error / Disabled:** błąd = obrys danger, tło danger-wash, pierścień błędu, komunikat 13 px 600 w danger-ink z ikoną koła z wykrzyknikiem (maska SVG); ostrzeżenie gwarancji = bursztynowy obrys na kremie. Tylko do odczytu (m.in. wyliczone ceny) = sunken + text-2. Cena w trakcie liczenia: shimmer turkus→krem zamiast wartości pośredniej; wartość końcowa wchodzi `opacity` 0.28 s.

### Tables
- Ramka 1 px line, promień 12 px; nagłówek wypełniony turkusem z białym tekstem label 14 px (padding 14px 16px); wiersze białe z linią 1 px; hover = hover. Na listach na telefonie tabela zamienia się w zgrupowane wiersze iOS.

### Navigation
- **Pasek boczny (desktop):** biały (sidebar) z linią po prawej; logo organizacji → plakietka środowiska (krem pigułka) → pozycje 15.5 px 500 z ikonami liniowymi 24 px (`partials/efor-v2-icons.njk`) → karta konta. Hover sunken, **aktywna pozycja bursztynowa** z ciemnym tuszem 700. Przycisk kontekstu klienta w czerwonym obmyciu.
- **Pasek górny:** okruszki (dom 36 px, hover sunken), menu języka, menu konta (awatar w brązie, ikony pozycji w turkusowym obmyciu, separatory line, przełącznik trybu w bursztynie w ciemnym).
- **Menu rozwijane:** biała karta 12 px, padding 6 px, cień wyskakujący; pozycje 8 px, hover sunken, aktywna krem plakietek 600.
- **Telefon:** pasek nawigacji z materiałem (ios-bar) i linią 0.5 px dopiero po przewinięciu (`efor-scrolled`), „‹ Wstecz” w turkusowym tincie, tytuł pośrodku dopiero po zadokowaniu dużego tytułu. Pasek kart z materiałem (ios-tabbar), ikony 25 px (aktywna kreska 2.2), podpisy 10.5 px, nieaktywne ios-gray, aktywna w tincie (#265b63, ciemny #8cc3cb), wciśnięcie `opacity .55`.

### Arkusz „Więcej” (telefon)
Arkusz od dołu z uchwytem 5 px i „Zamknij”: wiersz konta, grupa kontekstu admina, nawigacja jako ikony-kafelki w stylu Ustawień iOS w zgrupowanych listach (promień 12 px, wiersze 44–46 px, chevrony), segmentowany wybór języka, przełącznik trybu ciemnego, przewodnik, linki prawne; nagłówki grup wersalikami 13 px. Otwiera go `uiVariantMobile.js` (klasa na `<html>`, `efor-sheet-open`), nie collapse Bootstrapa. Ruch: `cubic-bezier(.32, .72, 0, 1)`.

### Listy, wyszukiwanie i filtry (telefon)
Zgrupowane wiersze z separatorami od wcięcia i chevronem, wciśnięcie ios-row-press; pole wyszukiwania iOS (wypełnienie ios-fill, promień 10 px, bez obrysu, 16 px); wiersz-ujawnienie „Filtry” z licznikiem aktywnych filtrów.

### Dialogs and Toasts
- **Dialog:** biel, obrys line, promień 16 px, cień wyskakujący; tło `rgba(11, 19, 36, .45)` z rozmyciem 2 px. Ostatnie kliknięcie nieodwracalnych kroków zawsze w takim oknie.
- **Toast:** biała karta 340 px, obrys 1 px line, promień 12 px, cień wyskakujący; stan niesie **kolorowa ikona** 22 px po lewej (info turkus, sukces success, błąd danger, ostrzeżenie amber-press), pasek postępu turkusowy 25 %. Bez paska z boku (decyzja właściciela 2026-10-30).
- **Podpowiedź:** turkus nocny, 8 px, 13 px.

### Kafelki wyboru konfiguratora
Biała karta z obrysem; hover = obrys amber-line + krem najechania + cień karty; zaznaczony = obrys 2 px bursztynu na kremie; focus = bursztynowy pierścień. Obok panel ceny (≥ 992 px) z wierszami ceny i kremową sumą.

### Stany ładowania
Spinner 64 px: obręcz teal-mist, góra turkus, prawa bursztyn, 0.9 s; nakładka ciepła półprzezroczysta z rozmyciem 2 px; szkielety sunken→card shimmer 1.2 s. `prefers-reduced-motion` zeruje animacje i przejścia w całym B.

## Do's and Don'ts

### Do:
- **Do** zaczynać każdą regułę B od `.theme-efor-v2` (jedyny wyjątek: sekcja 0 — sam przełącznik „Zmień wygląd”); markup tylko dla B oznaczać `.efor-v2-only`, tylko dla A `.efor-classic-only`.
- **Do** brać kolory z `--efor-*` (i przepiętych na nie tokenów theme.css), a na telefonie z `--m-*`/`--ios-*` podmienionych w sekcji 20; dopisywać wartości ciemne w `[data-theme="dark"]`.
- **Do** dawać bursztynowi zawsze tusz #1b1403, także w trybie ciemnym, i dopisywać nowe bursztynowe przyciski do listy `color: inherit` z sekcji 26.
- **Do** używać turkusowego paska nagłówka dla kart i turkusowej głowy dla tabel; sumy pieniędzy w kremie amber-cream.
- **Do** stawiać tytuł strony jako duży, ciężki (800), wyrównany do lewej, bez niczego nad nim.
- **Do** sygnalizować stan toastu, pola i alertu kolorem ikony i obrysem 1 px.
- **Do** na telefonie kłaść materiał (`backdrop-filter`) na `::before`, a fade-in wejścia (`fadeInUp` z theme.css) wyłączać na `main .content`/`.container` — aktywna animacja `transform` w Chromium też tworzy blok zawierający dla `position: fixed`.
- **Do** przypinać akcję główną nad paskiem kart przy kciuku (wyślij ofertę, zapisz pozycję).
- **Do** wpisywać każdą nową etykietę B do `templates/partials/efor-v2-strings.njk` w pięciu językach (pl, de, en, nl, fr) — bez `"` i backslashy, apostrof tylko typograficzny.
- **Do** sprawdzać zmiany przy B zrzutem wariantu A piksel po pikselu.

### Don't:
- **Don't** zmieniać wariantu A ani jego tokenów (`theme.css`, `mobile/tokens.css`) przy pracy nad B.
- **Don't** przenosić ani duplikować pól konfiguratora w DOM — silnik formularza szuka ich po `id` w całym dokumencie; układ B robi CSS albo JS przenoszący wyłącznie elementy, które nie są polami.
- **Don't** stawiać napisu wersalikami (eyebrow, kicker) nad tytułem strony.
- **Don't** używać akcentu w postaci paska z boku (`border-left` / `inset Npx 0 0`) na kartach, toastach ani alertach.
- **Don't** używać bursztynu ani turkusu jako dekoracji — kolor w B zawsze coś znaczy.
- **Don't** dokładać gradientów, błysków `::after`, glow ani cieni do przycisków.
- **Don't** wprowadzać nowego świata wizualnego do B (grafit, pomarańcz, zieleń, Archivo zostały odrzucone 2026-10-29); B dopracowuje się w palecie z makiet.
- **Don't** zaszywać tekstów UI w szablonach ani CSS.
- **Don't** pokazywać ceny pośredniej w trakcie liczenia — szkielet/shimmer zamiast wartości.
