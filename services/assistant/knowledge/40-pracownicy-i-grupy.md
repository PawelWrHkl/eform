<!-- Część 4: panel pracowników, konto pracownika, grupy i sklepy, konto organizacji. -->

# Pracownicy, grupy i sklepy

## Panel pracowników (klient zakłada konta pracownikom)
- Wejście: „{{base.employee_panel}}” w menu. Lista „{{employee.panel_title}}” pokazuje pracowników, ich login, telefon, ostatnie logowanie i uprawnienia.
- Dodanie pracownika:
  1. Kliknij „{{employee.add_employee}}”.
  2. Wpisz imię, nazwisko, login (musi być unikalny), hasło (min. 6 znaków) i opcjonalnie telefon.
  3. Zaznacz „{{employee.permissions}}” (domyślnie wszystkie są wyłączone) i kliknij „{{employee.save}}”.
- Pracownik loguje się na tej samej stronie logowania swoim loginem i hasłem.
- Uprawnienia można zmieniać na liście pracowników — zaznaczenie zapisuje się od razu i działa natychmiast:
  - „{{employee.can_send_orders}}” — może wysyłać zamówienia do realizacji i anulować je w ciągu 24 h. Bez niego tworzy i edytuje oferty, ale ich nie wyśle.
  - „{{employee.can_see_prices}}” — widzi ceny, sumy, rabaty i PDF z cenami.
  - „{{employee.can_see_all_orders}}” — widzi wszystkie zamówienia firmy. Bez niego widzi tylko te, które sam utworzył.
  - „{{employee.price_factor}}” — mnożnik wyświetlanych cen (np. aby pracownik widział cenę detaliczną). Działa tylko przy włączonej widoczności cen i nie zmienia zapisanych cen.
- Akcje przy pracowniku: „{{employee.view_orders}}”, „{{employee.edit}}” (dane i zmiana hasła pracownika: „{{employee.want_change_password}}”) oraz „{{employee.delete}}”.

## Konto pracownika — czego nie ma
- Pracownik działa w imieniu firmy klienta: korzysta z tych samych adresów i ulubionych.
- Nie ma „{{panel.nav_link}}” (więc sam nie zmieni hasła i nie widzi katalogów ani listy zleceń anulowanych) ani „{{base.employee_panel}}”.
- Na liście ofert nie usuwa ani nie edytuje ofert z listy. W widoku oferty może dodawać, edytować i usuwać pozycje.
- Gdy pracownikowi czegoś brakuje (np. nie widzi cen albo przycisku wysyłki), uprawnienia zmienia właściciel konta w „{{base.employee_panel}}”.

## Grupa (centrala sieci sklepów lub klientów)
- „{{group.panel_title}}” ma zakładki: „{{group.tab_shops}}” (konta sklepów/klientów), „{{group.tab_orders}}” i „{{group.tab_pending}}” (zamówienia czekające na zatwierdzenie).
- Centrala zakłada konto sklepu/klienta: nazwa i dane adresowe, login nadawany automatycznie, hasło (min. 5 znaków lub wygenerowane). Opcja „{{group.sf_send_order_policy}}”: włączona — konto samo wysyła zamówienia; wyłączona — zamówienia czekają na zatwierdzenie w panelu grupy.
- Zatwierdzanie: w zakładce „{{group.tab_pending}}” „{{group.approve_btn}}” wysyła zamówienie do produkcji (nieodwracalne), a „{{group.reject_btn}}” cofa je do sklepu do poprawy. To samo można zrobić w widoku zamówienia: „{{group.approve_send_btn}}” lub „{{group.reject_btn}}”.
- Praca w imieniu sklepu: lista „{{group.context_select_label}}” w menu bocznym — zamówienia zakładane w tym trybie trafiają do wybranego sklepu. Powrót: „{{group.context_exit}}”.

## Konto sklepu / klienta grupy
- Tworzy oferty i pozycje jak zwykły klient.
- Zamiast „{{order.send_order_btn}}” zwykle ma „{{group.submit_for_approval_title}}” — po potwierdzeniu zamówienie czeka na zatwierdzenie przez centralę. Jeśli centrala włączyła samodzielną wysyłkę, konto ma zwykłe „{{order.send_order_btn}}”.
- Nie ma „{{panel.nav_link}}” i nie anuluje wysłanych zleceń samo (robi to centrala). Hasło do konta ustawia centrala grupy.

## Konto organizacji (praca w kontekście klienta)
- Pole „{{orders.users_list}}” w menu pozwala pracować na ofertach wybranego klienta. Wyjście z trybu klienta: „{{base.turn_off_context}}”.
- „{{orders.show_all_orders}}” pokazuje oferty i zamówienia wszystkich klientów organizacji.
