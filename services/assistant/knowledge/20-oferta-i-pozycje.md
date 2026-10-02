<!-- Część 2: nowa oferta, adresy, konfigurator, pozycje, łączenie, ulubione, ceny, rabat, PDF/Excel. -->

# Tworzenie oferty i pozycji

## Nowa oferta (nagłówek zamówienia)
1. Kliknij „{{base.new_order}}” w menu (albo na pustej liście ofert „{{orders.add_order_btn}}”).
2. Na stronie „{{new-order.h1}}” wpisz „{{new-order.order_name}}” (obowiązkowe, maks. 60 znaków — np. nazwisko klienta końcowego lub numer referencyjny).
3. Opcjonalnie wybierz adres dostawy (patrz niżej) i wpisz „{{new-order.comments}}” (maks. 250 znaków).
4. Kliknij „{{new-order.save_button}}”. Otworzy się widok nowej oferty, w którym dodaje się pozycje.
- Jeśli nie wybierzesz żadnego adresu, zamówienie zostanie wysłane na adres domyślny konta (widoczny na stronie głównej).

## Adresy dostawy i adresy e-mail
- Osobnej książki adresowej nie ma — adresami zarządza się w nagłówku oferty (przy tworzeniu i edycji).
- Adres z listy: zaznacz „{{new-order.chcekbox_address_label}}”, potem wybierz z listy „{{new-order.select_address}}”. Obok listy są ikony „{{order.create_address}}”, „{{order.edit_address}}” i „{{order.delete_address}}”. Zapisane adresy są dostępne we wszystkich ofertach konta.
- Podobnie lista „{{order.select_email_address}}” z ikonami dodawania, edycji i usuwania adresu e-mail.
- Adres jednorazowy: zaznacz „{{new-order.send_chcekbox_address_label}}” i wpisz dane odbiorcy (nazwa, e-mail, telefon, ulica, miasto, kod pocztowy, kraj). Taki adres nie jest dodawany do listy. Zaznaczenie jednej opcji odznacza drugą.
- Zmiana nagłówka istniejącej oferty: w widoku oferty „{{edit_order.title}}” albo na liście ofert ikona ołówka „{{orders.edit_order_tooltip}}”, potem „{{edit_order.save_button}}”. Działa tylko w ofertach niewysłanych.

## Widok oferty
- Na górze pasek narzędzi: „{{order.add_position_btn}}”, „{{edit_order.title}}”, łączenie pozycji „{{order.link_manager_title}}” (ikona łańcucha), „{{base.give_discount_tooltip}}”, „{{base.generate_short_pdf_tooltip}}”, „{{base.generate_pdf_tooltip}}”, „{{order.generate_excel_tooltip}}”.
- Pod paskiem tabela pozycji z parametrami, cenami (jeśli konto widzi ceny) i „{{order.production_time_label}}” (dni dla pozycji i dla całej oferty).
- Na dole suma oferty i przycisk „{{order.send_order_btn}}”. Gdy ceny nie da się wyliczyć automatycznie, zamiast kwoty widać „{{order.according_to_price}}”.
- Kliknięcie w wiersz pozycji otwiera jej podgląd (tylko do odczytu).

## Dodawanie pozycji (konfigurator)
1. W widoku oferty kliknij „{{order.add_position_btn}}”.
2. Wpisz „{{form.commission_label}}” — nazwę pozycji, np. pomieszczenie lub okno (maks. 32 znaki).
3. „{{form.department_label}}” — rodzaj produktu (np. roleta, plisa).
4. „{{form.group_label}}” — konkretny system/grupa produktu (gdy jest tylko jedna, wybiera się sama).
5. Wypełnij formularz parametrów po kolei, od góry („{{form.reminder}}”) — kolejne opcje zależą od wcześniejszych wyborów.
6. Kliknij „{{form.save_button}}”. Pozycja zostanie dodana i wrócisz do oferty.
- Lista działów i grup zawiera tylko produkty udostępnione temu klientowi. Brak produktu na liście → konsultant.
- „{{form.reset_button}}” czyści wartości formularza.
- „{{form.last_choice}}” przywraca ostatnio użyty dział i grupę, a „{{position.get_last_config}}” wczytuje wartości ostatnio konfigurowanej pozycji. Oba działają na danych zapamiętanych w tej przeglądarce.
- Przy błędach zapisu pojawia się „{{form.incorrect_data}}”, błędne pola migają na czerwono, a strona przewija się do pierwszego z nich.
- Pole liczbowe (np. wymiar) poza zakresem pokazuje podpowiedź „min: X - max: Y”. Wartości graniczne zależą od produktu i są widoczne właśnie w tej podpowiedzi. Żółte ostrzeżenie „Uwaga, produkcja możliwa aczkolwiek bez gwarancji” oznacza, że taki wymiar można zamówić, ale bez gwarancji.
- Pola z oknem wyboru (np. tkanina, kolor): przycisk „{{form.check_word}}” otwiera okno „{{form.dialog_title}}” z kafelkami, wyszukiwarką „{{form.search_input_placeholder}}”, filtrami („{{form.reset_filters}}”) i sortowaniem. Wybór zatwierdza się przyciskiem „{{form.apply_button}}”. Kliknięcie miniatury powiększa zdjęcie.
- Ikonka „i” przy parametrze lub wartości pokazuje opis po najechaniu myszą. Jeśli do opisu jest dołączony plik (np. karta techniczna, instrukcja montażu w PDF), kliknięcie w „i” pobiera ten plik.
- „{{form.cupon_info_label}}” oznacza tkaninę kuponową: „{{form.cupon_info}}”.
- Komentarz do pozycji: link „{{form.add_comment_button}}” pod formularzem (maks. 250 znaków).
- Załączniki: jeśli dany produkt przewiduje plik (np. zdjęcie, szkic), pod formularzem jest sekcja „{{form.attachments_label}}” z ikoną spinacza. Plik jest opcjonalny, maks. 10 MB. Ogólnego pola na zdjęcia w każdej pozycji nie ma.
- Dlaczego jakiejś opcji nie da się wybrać? Opcje zależą od wcześniejszych wyborów w formularzu (np. model ogranicza dostępne tkaniny i wymiary). Gdy klient nie wie, która reguła blokuje wybór → konsultant.

## Ulubione wartości
- W oknie wyboru wartości (np. tkanin) każdy kafelek ma serduszko — kliknięcie dodaje lub usuwa wartość z ulubionych.
- Sortowanie „{{form.favorites_first}}” pokazuje ulubione na początku. „{{form.clear_favorites}}” czyści ulubione dla danej grupy produktu.
- Ulubione są zapisane na koncie klienta, osobno dla każdej grupy produktu. Nie ma ulubionych pozycji ani ulubionych zamówień.

## Pozycje: edycja, duplikowanie, usuwanie, kolejność
- Przyciski są w kolumnie akcji przy każdej pozycji (na telefonie na karcie pozycji). Działają tylko w ofertach niewysłanych.
- „{{order.edit_pos}}” (ołówek) — otwiera formularz z aktualnymi wartościami; po zmianach „{{form.save_button}}”. W edycji nie da się zmienić działu ani grupy produktu — aby zmienić produkt, usuń pozycję i dodaj nową.
- „{{order.duplicate_pos}}” — bez pytania tworzy kopię pozycji na końcu oferty i od razu otwiera jej edycję (wygodne przy kilku podobnych oknach).
- „{{order.delete_pos}}” (kosz) — po potwierdzeniu „{{order.confirm}}” usuwa pozycję, a numeracja się przelicza.
- Strzałki „{{order.move_up}}” i „{{order.move_down}}” zmieniają kolejność pozycji.

## Łączenie pozycji (pozycje wiszące obok siebie)
- Służy do oznaczenia pozycji, które mają wisieć razem (np. kilka rolet w jednym oknie) — informacja dla produkcji i montażu.
1. W widoku oferty kliknij ikonę łańcucha „{{order.link_manager_title}}”.
2. Przeciągnij pozycje ze strefy „{{order.link_unlinked}}” do grupy („{{order.link_new_group}}” tworzy kolejną grupę). Na ekranie dotykowym: zaznacz karty i użyj przycisku przeniesienia do grupy.
3. Kliknij „{{order.link_save}}”. Grupa musi mieć co najmniej 2 pozycje. Połączone pozycje dostają w tabeli kolorowy pasek i oznaczenie grupy.

## Ceny
- Klient widzi ceny w ofercie, przy pozycjach i w sumie. Pracownik widzi ceny tylko z uprawnieniem „{{employee.can_see_prices}}”. Bez niego nie widzi cen, sum ani rabatów, a PDF generuje się bez cen.
- Kłódka w pasku narzędzi oferty (jest tylko na niektórych kontach): kliknięcie otwiera okno „{{order.unlock}}”. Po wpisaniu hasła konta pokazują się dodatkowe, normalnie ukryte ceny (np. cena po rabacie). Opcja „{{order.remember}}” zostawia je odblokowane do wylogowania. Dzięki temu zwykły widok można pokazać klientowi końcowemu bez ujawniania ceny zakupu.
- Konta grupy i ich sklepów zamiast kłódki mają przycisk „{{form.show_discounted_price}}” (wymaga hasła konta).
- Pytania o wysokość cen, cennik, rabat u producenta, warunki handlowe lub faktury wystawiane przez producenta → konsultant.

## Centrum rabatów (rabat dla klienta końcowego)
1. W widoku oferty kliknij ikonę „{{base.give_discount_tooltip}}”.
2. W oknie „{{order.set_discount_for_order}}” zaznacz „{{order.percent_discount}}” (0–100%) albo „{{order.amount_discount}}” (nie większy niż wartość zamówienia). Okno pokazuje kwotę rabatu i kwotę po rabacie.
3. Kliknij „{{order.apply_discount}}”. Pod sumą oferty pojawi się rabat i „{{order.total_after_discount}}”.
- To rabat, który salon daje swojemu klientowi końcowemu: widać go w ofercie i w PDF. Nie obniża ceny zakupu u producenta.
- Centrum rabatów nie jest dostępne dla kont grupy i sklepów ani dla pracowników bez prawa do cen.

## PDF i Excel
- „{{base.generate_pdf_tooltip}}” — pełny PDF oferty/zamówienia.
- „{{base.generate_short_pdf_tooltip}}” — skrócony PDF (A3 poziomo, same kody wartości bez opisów).
- „{{order.generate_excel_tooltip}}” — plik Excel z pozycjami i sumą.
- Przyciski są w pasku narzędzi oferty i w podglądzie wysłanego zamówienia. Pustej oferty nie da się wydrukować.
- Ceny w PDF są takie, jak w aktualnym widoku: zwykle ceny standardowe (z ewentualnym rabatem z Centrum rabatów), po odblokowaniu kłódki także ceny ukryte. Pracownik bez prawa do cen dostaje PDF bez cen.
