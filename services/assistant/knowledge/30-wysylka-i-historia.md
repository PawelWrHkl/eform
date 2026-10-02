<!-- Część 3: wysyłka, potwierdzenie, listy, statusy, przesyłki, kopiowanie, anulowanie, czasy dostawy, importy. -->

# Wysyłka zamówienia, historia i kopiowanie

## Wysłanie oferty do realizacji
1. Otwórz ofertę, przewiń na dół i kliknij „{{order.send_order_btn}}” (albo na liście „{{base.your_orders}}” ikonę wysyłki przy ofercie).
2. Potwierdź w oknie „{{orders.send_order}}” przyciskiem „{{orders.send_word}}”.
3. Pojawi się „{{orders.send_success_label}}”, a zamówienie przejdzie do „{{base.orders_history}}”.
- Pustej oferty (bez pozycji) nie da się wysłać.
- Pracownik może wysyłać tylko z uprawnieniem „{{employee.can_send_orders}}”. Bez niego nie widzi przycisku wysyłki — ofertę wysyła właściciel konta albo pracownik z tym uprawnieniem.
- Konto sklepu/klienta grupy zamiast wysyłki ma zwykle „{{group.submit_for_approval_title}}” — zamówienie czeka wtedy na zatwierdzenie przez centralę grupy.
- Po wysłaniu zamówienia nie da się już edytować: dodawać ani zmieniać pozycji, zmieniać adresu czy nazwy. Jedyna droga zmiany: anulowanie w ciągu 24 godzin (patrz niżej) i nowe zamówienie. Zmiany po 24 godzinach → konsultant.
- Po wysłaniu zamówienie trafia do produkcji, a na adres e-mail konta przychodzi mail z potwierdzeniem przyjęcia zamówienia i PDF-em. Jeśli potwierdzenie nie dotarło → konsultant.
- Portal nie wysyła maili o zmianach statusu produkcji, o nadaniu paczki ani o anulowaniu. Status sprawdza się w „{{base.orders_history}}”.

## Lista „{{base.your_orders}}” (oferty niewysłane)
- Kolumny: „{{orders.order_no}}”, „{{orders.commission}}” (nazwa), „{{orders.created_date}}” i akcje. Kliknięcie w wiersz otwiera ofertę.
- Akcje w wierszu: „{{orders.copy_offer}}”, „{{orders.delete_order}}” (kosz, po potwierdzeniu), „{{orders.edit_order_tooltip}}” (ołówek) i wysyłka. Pracownik ma tu tylko kopiowanie i ewentualnie wysyłkę — bez usuwania i edycji z listy.
- Ikona ciężarówki prowadzi do strony „{{termin.delivery_time}}”.

## Lista „{{base.orders_history}}” (zamówienia wysłane)
- Kolumny m.in.: „{{orders.sent_date}}”, „{{orders.status}}”, „{{translate.delivery}}”, „{{orders.tracking_numbers}}” oraz akcje „{{orders.reorder}}” i (przez 24 h od wysłania) „{{cancel_order.button_short}}”.
- Kliknięcie w wiersz otwiera podgląd zamówienia: przy każdej pozycji „{{order.status_label}}”, „{{order.pred_shipping_date_label}}” i „{{order.shipping_method_label}}” z numerem paczki.

## Wyszukiwanie i filtry (obie listy)
- Pole „{{orders.search}}” szuka po nazwie i numerze zamówienia.
- Filtry dat utworzenia: „{{orders.created_from}}” i „{{orders.created_to}}”.
- Tylko na liście wysłanych: filtr „{{orders.status}}” oraz daty wysłania „{{orders.sent_date_from}}” i „{{orders.sent_date_to}}”.
- Przykład: „Jak znaleźć zamówienie z zeszłego tygodnia?” → „{{base.orders_history}}”, ustaw daty wysłania albo wpisz nazwę lub numer w „{{orders.search}}”. Niewysłane oferty są w „{{base.your_orders}}”.
- Pracownik bez uprawnienia „{{employee.can_see_all_orders}}” widzi tylko zamówienia, które sam utworzył.

## Statusy produkcji i przesyłki
- Statusy nadaje produkcja, a portal je pokazuje: „{{order.status_order_sent}}” (zanim produkcja nada status), „{{!preparation!}}”, „{{!production!}}”, „{{!backorder!}}”, „{{!sent!}}”. Zamówienie anulowane ma status „{{cancel_order.status_canceled}}”.
- „{{translate.delivery}}” to przewidywana data wysyłki. Zanim produkcja ją poda, widać szacunek w dniach.
- Numery przesyłek: w kolumnie „{{orders.tracking_numbers}}” przycisk z liczbą przesyłek rozwija listę numerów. Dla DPD, UPS i DHL numer jest linkiem do strony śledzenia przewoźnika.
- Pytania o konkretny termin, opóźnienie lub los konkretnej paczki, których nie widać w portalu → konsultant.

## Kopiowanie zamówienia
- Na liście „{{base.your_orders}}”: „{{orders.copy_offer}}”. Na liście „{{base.orders_history}}” i na liście zleceń anulowanych: „{{orders.reorder}}”.
1. Kliknij przycisk kopiowania przy zamówieniu.
2. Potwierdź w oknie „{{orders.open_as_new}}” przyciskiem „{{orders.accept}}”.
3. Pojawi się „{{orders.copied_success_label}}” i otworzy się nowa oferta z nowym numerem — można ją edytować i wysłać.
- Kopia zawiera nazwę, adres dostawy, uwagi i wszystkie pozycje z ich parametrami. Skopiować można zamówienie w każdym statusie: ofertę, wysłane i anulowane.
- Kopiowania tylko części pozycji nie ma. Sposób: skopiuj całe zamówienie, a w nowej ofercie usuń zbędne pozycje koszem „{{order.delete_pos}}” i ewentualnie zmień pozostałe przez „{{order.edit_pos}}”. Przenoszenia pozycji między różnymi zamówieniami nie ma. W obrębie jednej oferty pozycję można zduplikować przyciskiem „{{order.duplicate_pos}}”.
- Kopia zrobiona przez pracownika nie jest przypisana do niego. Pracownik bez uprawnienia „{{employee.can_see_all_orders}}” może jej potem nie widzieć na swojej liście.

## Anulowanie wysłanego zlecenia (do 24 godzin)
- Anulować można tylko zlecenie wysłane i tylko przez 24 godziny od wysłania. Później portal na to nie pozwala → konsultant.
- Anulowanie jest nieodwracalne. Anulowanego zlecenia nie da się przywrócić ani wysłać ponownie — można je tylko skopiować przyciskiem „{{orders.reorder}}”.
- Kto może: klient, konto organizacji, grupa oraz pracownik z uprawnieniem „{{employee.can_send_orders}}”. Konto sklepu/klienta grupy nie anuluje samo — robi to centrala grupy.
1. Na liście „{{base.orders_history}}” kliknij „{{cancel_order.button_short}}” przy zleceniu albo otwórz zlecenie i kliknij „{{cancel_order.button}}” (widać tam też, ile czasu zostało).
2. Zaznacz „{{cancel_order.step1_checkbox}}” i kliknij „{{cancel_order.step1_continue}}” (rezygnacja: „{{cancel_order.keep_order}}”).
3. Potwierdź „{{cancel_order.step2_confirm}}”.
- Anulowane zlecenia są na liście „{{cancel_order.panel_link_title}}” (kafelek w „{{panel.nav_link}}”), z datą anulowania i przyciskiem „{{orders.reorder}}”.

## Czas dostawy i produkcji
- Strona „{{termin.delivery_time}}” (ikona ciężarówki na listach ofert i zamówień wysłanych) pokazuje orientacyjny czas produkcji w dniach dla poszczególnych produktów.
- Przy każdej pozycji oferty widać „{{order.production_time_label}}” — szacunek dla pozycji i dla całej oferty. Tkanina kuponowa i napęd elektryczny wydłużają czas. To szacunek; faktyczną datę wysyłki podaje produkcja po przyjęciu zamówienia.

## Zamówienia wczytane automatycznie (importy)
- Część klientów przesyła zamówienia automatycznie ze swojego systemu. Wynik takich importów widać na stronie „Moje Importy” (ikona na liście „{{base.your_orders}}”), ze statusem każdego pliku i ewentualnym opisem błędu. Problemy z importem → konsultant.
