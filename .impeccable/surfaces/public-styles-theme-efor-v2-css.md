---
version: 1
slug: "public-styles-theme-efor-v2-css"
primary_target: "public/styles/theme-efor-v2.css"
related_targets: ["templates/base.njk","public/scripts/uiVariantView.js","templates/partials/efor-v2-strings.njk"]
---

# Wariant B — „Efor 2.0” (powłoka, listy, oferta, konfigurator, start, admin; desktop + telefon)

Tryb: Operate. Odbiorcy: salon/dealer i biuro producenta po równo (PRODUCT.md). Zadanie: założyć ofertę, skonfigurować pozycje, wysłać, śledzić etap; admin — pracować w kontekście organizacji/klienta. Zakres: dopracowanie B, nawigacja, wersja admina, telefon natywnie jak iOS (decyzje usera 2026-10-29); funkcje, teksty i uprawnienia bez zmian. Wariant A nietknięty (porównanie piksel po pikselu).

**Historia decyzji:** losowanie kierunku (seed:d17ce3b902f36fe5) przydzieliło nowy świat „Gute Form” (grafit, pomarańcz, zieleń, Archivo). Właściciel odrzucił go po zobaczeniu: „nie podoba mi się kompletnie styl — kolory zostaw po staremu”. Obowiązuje świat z makiet szefa — to jest rozszerzenie istniejącego świata, nie nowy wygląd.

Ograniczenia: każda reguła pod `.theme-efor-v2`; pola konfiguratora nie są przenoszone; identyfikatory klikane przez asystenta zostają; nowe etykiety B w `partials/efor-v2-strings.njk` (5 języków).

## Direction contract

THESIS: B to makiety szefa doprowadzone do końca — ciepłe jasne tło, turkusowe nagłówki kart, bursztyn na akcjach i aktywnej pozycji; na telefonie ten sam świat zachowuje się jak natywna aplikacja iOS. Odrzuca stronę zmniejszoną z desktopu (hamburger, pływające pola, stopka nad paskiem kart).

OWN-WORLD: tło #F7F5F1, karty białe z cienką linią, turkus #265B63 w nagłówkach kart i tabel, bursztyn #F7B417 (ciemny tekst) dla akcji głównej i aktywnej pozycji, krem #FDEBC4 w sumach, Inter; na telefonie materiał pasków (półprzezroczysta biel z rozmyciem), zgrupowane listy, arkusze od dołu.

STORY: klient i biuro znajdują każdą sekcję w tym samym miejscu, na telefonie pracują kciukiem jak w aplikacji, admin zawsze widzi, w czyim kontekście pracuje.

FIRST VIEWPORT: desktop — biały pasek boczny z logo i bursztynową aktywną pozycją, pasek górny z okruszkami, językiem i kontem; admin: drugi rząd kontekstu (organizacja, klient, ostatni klient, panel, hasła). iPhone — duży tytuł zwijany do paska nawigacji, treść w zgrupowanych listach, półprzezroczysty pasek kart (Start, Oferty, Zamówienia, Więcej → arkusz z resztą nawigacji, kontem i kontekstem admina), akcja główna w dolnym pasku przy kciuku.

FORM: istniejący świat B z makiet szefa (`wizualizacja efor/`), rozszerzony o powłokę iOS i pasek admina; seed:d17ce3b902f36fe5 (przydział odrzucony przez właściciela).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
