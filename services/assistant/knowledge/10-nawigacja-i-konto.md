<!-- Część 1: logowanie, nawigacja, język, panel konta, wygląd, przewodnik, stopka. -->

# Logowanie, nawigacja i konto

## Logowanie i wylogowanie
- Na stronie logowania wpisuje się „{{login.pin_label}}” i „{{login.password_label}}”, potem „{{login.login_button}}”. Ta sama strona służy klientom, pracownikom i kontom sklepów grupy.
- W portalu nie ma funkcji „Nie pamiętam hasła”, samodzielnej rejestracji ani opcji „Zapamiętaj mnie”. Zapomniane hasło lub nowe konto → konsultant.
- Sesja wygasa po 8 godzinach, wtedy trzeba zalogować się ponownie. Gdy serwer chwilowo nie odpowiada, pojawia się okno „Utracono połączenie” z przyciskiem „Odśwież”.
- Wylogowanie: „{{base.logout}}” na dole menu bocznego (na telefonie w menu).
- Przy pierwszym logowaniu klient akceptuje zasady przetwarzania danych przyciskiem „{{base.accept_rodo}}”.

## Menu główne (komputer — pasek boczny po lewej)
- „{{base.new_order}}” — nowa oferta.
- „{{base.your_orders}}” — oferty jeszcze niewysłane.
- „{{base.orders_history}}” — zamówienia wysłane, ich status i przesyłki.
- „{{base.employee_panel}}” — konta pracowników (widoczne dla klienta, nie dla samego pracownika).
- „{{base.logout}}”.
- Pasek boczny można zwinąć do samych ikon przyciskiem ze strzałką na jego górze.
- W prawym górnym rogu: „{{panel.nav_link}}” (ikona koła zębatego), „Zmień wygląd”, przycisk przewodnika (ikona kompasu), przełącznik trybu jasnego/ciemnego (księżyc/słońce) i flagi języków.

## Telefon
- Na dole ekranu jest pasek z czterema przyciskami: strona startowa, oferty, zamówienia wysłane i „więcej” (otwiera pełne menu, także „{{panel.nav_link}}”, „{{base.employee_panel}}”, „Zmień wygląd”, „{{base.logout}}” i flagi języków).
- Na telefonie nie ma przycisku przewodnika ani przełącznika trybu ciemnego — są tylko w widoku na komputerze.
- Konfigurator na telefonie prowadzi przez kolejne kroki przyciskami „Dalej” i „Wstecz”.

## Zmiana języka
- Dostępne języki: polski, angielski, niemiecki, niderlandzki, francuski.
- Kliknij flagę w prawym górnym rogu (na telefonie: menu „więcej”). Strona przeładuje się w wybranym języku, a wybór zostanie zapamiętany w przeglądarce.
- Język wpływa na opisy w konfiguratorze, PDF-y i mail z potwierdzeniem zamówienia.

## Panel użytkownika
- Wejście: „{{panel.nav_link}}” w prawym górnym rogu (na telefonie w menu).
- Panel mają klient, konto organizacji i konto grupy. Pracownik i konto sklepu grupy nie mają panelu.
- Zakładki:
  - „{{panel.tab_data}}” — dane firmy (nazwa, NIP, adres, e-mail) tylko do podglądu. Komunikat w panelu: „{{panel.data_readonly_note}}”. Zmiana danych firmy → konsultant.
  - „{{panel.tab_password}}” — zmiana hasła (opis niżej).
  - „{{panel.tab_catalogs}}” — katalogi PDF do pobrania przyciskiem „{{panel.catalog_download}}”. Katalogi udostępnia producent, każda marka ma swoje. Brak katalogów = producent nic nie udostępnił; o konkretny katalog trzeba zapytać konsultanta.
  - „{{panel.tab_personalization}}” — wybór wyglądu portalu (klasyczny lub nowy). Pozostałe motywy są zapowiedziane „wkrótce” i jeszcze nie działają.
- Pod zakładkami jest kafelek „{{cancel_order.panel_link_title}}” — lista zleceń anulowanych.

## Zmiana hasła
1. „{{panel.nav_link}}” → zakładka „{{panel.tab_password}}”.
2. Wpisz „{{panel.current_password}}”, „{{panel.new_password}}” i „{{panel.confirm_password}}” (ikonka oka pokazuje wpisane hasło).
3. Kliknij „{{panel.change_password_btn}}”.
- Nowe hasło musi mieć co najmniej 5 znaków, oba nowe hasła muszą być identyczne, a aktualne hasło musi się zgadzać.
- Pracownik nie zmienia hasła sam — zmienia je właściciel konta w „{{base.employee_panel}}” (edycja pracownika). Hasło konta sklepu grupy ustawia centrala grupy.

## Wygląd portalu
- Tryb jasny/ciemny: ikona księżyca/słońca w prawym górnym rogu (tylko na komputerze). Wybór jest pamiętany w przeglądarce.
- „Zmień wygląd” (prawy górny róg, na telefonie w menu) przełącza między klasycznym a nowym wyglądem portalu. Funkcje są te same, zmienia się tylko wygląd. Wybór jest pamiętany w tej przeglądarce.

## Przewodnik po portalu
- Uruchomienie: ikona kompasu w prawym górnym rogu (tylko na komputerze). Przewodnik zaczyna się na stronie głównej i prowadzi przez tworzenie oferty, dodawanie pozycji i wysyłkę.
- W dymkach przewodnika: „Dalej”, „Wstecz”, „{{intro.skip}}” (zamyka tylko bieżący krok — przewodnik może wrócić) i „{{intro.dont_show}}” (wyłącza go na stałe; zawsze można włączyć ponownie ikoną kompasu).

## Strona główna
- Pokazuje dane konta oraz przełącznik ostatnich ofert i ostatnio wysłanych zamówień (po 4 sztuki, kliknięcie otwiera zamówienie).

## Stopka strony
- „{{site.privacy}}”, „{{site.terms}}” i „{{site.contact}}” — dokumenty i dane kontaktowe właściwe dla marki klienta, w jego języku. Na pytania o telefon czy adres obsługi odsyłaj do „{{site.contact}}” (albo podaj DANE KONTAKTOWE z kontekstu, jeśli są).
