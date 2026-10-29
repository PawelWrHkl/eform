# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Dwie grupy o **równej wadze** przy decyzjach projektowych (potwierdzone 2026-10-28):

- **Klienci producenta** — salony, dealerzy i sklepy z osłonami okiennymi. Konfigurują produkty (rolety, plisy, żaluzje…) dla swoich klientów końcowych, budują oferty, wysyłają zlecenia do realizacji, śledzą status produkcji i przesyłki, pobierają PDF/Excel i faktury. Po stronie klienta działają też:
  - **pracownicy klienta** — osobne konta z uprawnieniami nadanymi przez klienta (wysyłka zleceń, widoczność cen, wszystkie zlecenia albo tylko własne);
  - **grupy (centrale sieci)** — zarządzają kontami swoich sklepów i zatwierdzają ich zlecenia;
  - **konta sklepów grupy** — tworzą oferty jak klient, ale zwykle przekazują je centrali do zatwierdzenia zamiast wysyłać same.
- **Biuro producenta** — konta organizacji (owner) i admini. Pracują w kontekście wybranego klienta, poprawiają wysłane zlecenia (korekty), przeglądają raporty, log importu i historię logowań, włączają przerwę techniczną.

## Product Purpose

eForm to portal zamówieniowy producenta osłon okiennych. Klient sam konfiguruje pozycję w konfiguratorze, który od razu liczy cenę z cennika producenta, a wysłane zlecenie trafia wprost do produkcji (plik zlecenia + PDF mailem) — bez przepisywania zamówień w biurze. Potem portal pokazuje status produkcji, termin wysyłki i numery przesyłek, a na końcu faktury.

Sukces: klient samodzielnie, bez telefonu do biura, składa poprawne zlecenie z właściwą ceną, którego biuro producenta nie musi poprawiać.

## Positioning

- **Konfigurator i ceny wprost z danych producenta** — parametry i słowniki per grupa produktowa, skrypty cennika, rabaty i ceny SUB per klient. Cena widziana w portalu jest ceną zlecenia w produkcji.
- **Jeden portal dla wielu marek** (HKL, COZY, Luxan, Remasun, TCN) — klient widzi logo swojej organizacji, ceny i rabaty swojego konta, w swoim języku (pl, en, de, fr, nl).
- **Cały łańcuch zamawiania** — klient → (centrala grupy) → producent: zatwierdzanie zleceń sklepów, pracownicy z uprawnieniami, praca biura producenta w kontekście klienta, import zleceń z systemów zewnętrznych.
- **Eforek** — asystent AI (czat i głos): zna bieżący ekran, podświetla i pokazuje krok po kroku, widzi zlecenia konta tylko do odczytu, a gdy nie zna odpowiedzi, przekazuje rozmowę konsultantowi mailem.

## Operating Context

- Cykl: **oferta** (niewysłana, edytowalna) → **pozycje** z konfiguratora → PDF/Excel → **wysyłka do realizacji** (albo przekazanie do zatwierdzenia centrali) → **status produkcji i spedycja** → **faktury** (gdy włączone dla konta; także zbiorcze tygodniowe/miesięczne).
- Wysłane zlecenie można anulować tylko w ciągu 24 h od wysłania; potem zmienia je wyłącznie korekta biura producenta.
- Klienci pracują **na komputerze i na telefonie** — obie ścieżki są pełnoprawne, także konfigurowanie pozycji na telefonie (potwierdzone 2026-10-28).
- Klienci często powtarzają konfiguracje (kopiowanie pozycji i ostatniej konfiguracji, ulubione).
- Część odbiorców widzi zlecenie wyłącznie przez dokumenty: PDF zlecenia (druk, mail), załącznik HTML, specyfikację ceny, faktury.
- Filmy instruktażowe wysyłane linkiem `/film/<nazwa>` (bez logowania); wycieczki onboardingowe przy pierwszym logowaniu.

## Capabilities and Constraints

- **Dwa warianty wyglądu, równorzędne na stałe** (potwierdzone 2026-10-28): **A** — klasyczny (domyślny) i **B** — „Efor 2.0” (klasa `theme-efor-v2`, przełącznik „Zmień wygląd”). Klient wybiera sam; zmiana UI ma działać w obu i nie psuć drugiego. Niezależnie od wariantu: tryb jasny/ciemny.
- **Widoczność cen zależy od roli** — ceny SUB (`SUB___`, zawsze cena klienta), ceny katalogowe, rabaty pod kłódką, VAT, uprawnienie pracownika do cen, tryb cen grupy. Interfejs nie może pokazać ceny roli, która jej nie widzi, ani ceny pośredniej w trakcie liczenia.
- **Nieodwracalne kroki** (wysłanie, anulowanie, usunięcie, zatwierdzenie zlecenia) zawsze kończy człowiek w oknie potwierdzenia; Eforek może do nich doprowadzić, ale ostatnie kliknięcie należy do klienta.
- **Każdy tekst UI w 5 językach** — główny słownik `jezyki.xlsx` (regenerowany do JSON-ów tłumaczeń); asystent, faktury, specyfikacja ceny i wariant B mają własne pliki tłumaczeń. Tekstów nie zaszywa się w szablonach.
- **Technika UI:** SSR w Nunjucks + vanilla JS bez frameworka, arkusze w `public/styles/`, tokeny w `theme.css`. Silnik formularza szuka pól po `id` w całym dokumencie — pól konfiguratora nie wolno przenosić ani duplikować w DOM.
- **Otwarte:** formalny standard dostępności nie został ustalony.

## Brand Commitments

- Nazwa platformy: **eForm** (stopka „eforM”; wariant B nazywany „Efor 2.0”).
- Logo w nagłówku zależy od organizacji zalogowanego konta (`/user/logo`); strona logowania używa grafiki HKL (`public/img/hkl-login-image*`).
- Maskotka asystenta: **mały biały piesek „Eforek”** (imię w interfejsie i w rozmowie) — świadomie nie kopia cudzej maskotki.
- Dokumenty sprzedażowe (faktury) mają formatki per wystawca z logo marki.

## Evidence on Hand

- `PROJECT_OVERVIEW.md` — mapa modułów i changelog.
- `services/assistant/knowledge/*.md` — opis portalu z perspektywy klienta (pojęcia, role, przepływy).
- `wizualizacja efor/` — makiety wariantu B (wrzesień 2026).
- `img/` — logo marek i wystawców faktur; `public/img/` — ikony wariantu A i grafiki logowania.
- `movies/` (poza gitem) — filmy instruktażowe.
- **Brak:** opinii klientów, badań użyteczności, statystyk urządzeń i ruchu. Nie wymyślać ich.

## Product Principles

1. **Cena musi być prawdziwa i trafić do właściwej osoby** — poprawność i widoczność cen według roli wygrywają z wygodą i wyglądem.
2. **Klient zamawia sam i bez pomyłek** — konfigurator, kopiowanie i pomoc Eforka służą temu, żeby zlecenie nie wymagało poprawki w biurze.
3. **Ostatnie słowo przy nieodwracalnych krokach należy do człowieka** — wyraźne potwierdzenie i jasne konsekwencje (np. okno 24 h na anulowanie).
4. **Nic nie jest drugorzędne** — klient i biuro producenta, wariant A i B, komputer i telefon mają równą wagę; zmiana po jednej stronie nie może pogorszyć drugiej.
5. **Pięć języków od pierwszego dnia** — każdy nowy tekst trafia do tłumaczeń, a układ znosi najdłuższe z nich.
