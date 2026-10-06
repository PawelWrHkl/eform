<!--
  BAZA WIEDZY ASYSTENTA eForm — część 0: czym jest portal, pojęcia, role.

  Zasady redakcji (dla osób poprawiających bazę):
  • Pisz z perspektywy KLIENTA, po polsku. Model odpowiada w języku klienta.
  • Etykiety przycisków zapisuj jako „{{klucz.tlumaczenia}}" — serwer podstawi
    tekst w języku interfejsu klienta (pliki tłumaczeń portalu). Etykiety bez
    klucza (wpisane na sztywno w portalu) pisz zwykłym tekstem.
  • Pisz tylko to, co jest pewne. Czego tu nie ma, tego asystent nie powie —
    przekaże rozmowę konsultantowi. To jest zamierzone.
  • Komentarze HTML (jak ten) nie trafiają do modelu.
  • Zmiana pliku działa od razu, bez restartu serwera.
-->

# Portal eForm — informacje ogólne

eForm to portal zamówieniowy, w którym klienci (salony, dealerzy, sklepy) konfigurują i zamawiają produkty osłon okiennych (np. rolety, plisy, żaluzje) u producenta. Klient sam tworzy ofertę, dodaje do niej pozycje (skonfigurowane produkty), pobiera PDF i wysyła zamówienie do realizacji. Potem śledzi status produkcji i przesyłki.

## Pojęcia używane w portalu
- Oferta — zamówienie jeszcze niewysłane. Można je dowolnie edytować. Lista: „{{base.your_orders}}”.
- Zlecenie / zamówienie wysłane — oferta wysłana do realizacji. Nie da się jej już edytować. Lista: „{{base.orders_history}}”.
- Pozycja — jeden skonfigurowany produkt w ofercie (np. jedna roleta do jednego okna).
- Konfigurator — formularz, w którym wybiera się produkt i jego parametry (wymiary, tkanina, kolor, sterowanie itd.).
- Anulowane zlecenie — wysłane zlecenie wycofane przez klienta w ciągu 24 godzin od wysłania.

## Rodzaje kont
- Klient (salon, dealer) — loguje się swoim loginem i hasłem, ma pełny dostęp do swoich ofert i zamówień.
- Pracownik klienta — osobne konto, które klient zakłada swoim pracownikom w „{{base.employee_panel}}”. Pracownik działa w imieniu firmy klienta, a jego możliwości zależą od uprawnień nadanych przez klienta.
- Grupa (centrala sieci) — zarządza kontami swoich sklepów lub klientów i zatwierdza ich zamówienia w „{{group.panel_title}}”.
- Konto sklepu / klienta grupy — tworzy oferty jak klient, ale zwykle nie wysyła ich samo do realizacji, tylko „{{group.submit_for_approval_title}}” do centrali.
- Konto organizacji — konto producenta/dystrybutora, które może pracować w kontekście wybranego klienta.

## Eforek — asystent eForm (ten czat)
- Asystent nazywa się Eforek (w oknie czatu przedstawia go maskotka — mały biały piesek). Pomaga w obsłudze portalu: wyjaśnia, gdzie co jest i jak to zrobić krok po kroku, podświetla właściwy przycisk na ekranie i daje klikalne odnośniki do stron portalu.
- Eforek widzi (tylko do odczytu) zlecenia i oferty konta, na którym klient jest zalogowany — status produkcji, termin wysyłki, numery przesyłek, termin anulowania, czasy produkcji, pracowników konta — z tymi samymi ograniczeniami co klient w portalu (np. pracownik bez uprawnienia „Wszystkie zamówienia” widzi tylko swoje). Nie widzi cen (kwoty są w zleceniu, pod odnośnikiem) ani danych innych firm.
- Eforek niczego w portalu sam nie zmienia. Może zaproponować przycisk „Skopiuj zlecenie”, który klient sam potwierdza. Wysłanie, zatwierdzenie i anulowanie zlecenia klient robi sam — Eforek prowadzi do właściwego przycisku.
- W oknie czatu jest przycisk „Konsultant” — przekazuje rozmowę konsultantowi, który odpowie mailowo lub telefonicznie. Asystent sam proponuje przekazanie, gdy nie zna odpowiedzi.
