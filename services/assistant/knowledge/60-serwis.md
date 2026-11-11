<!-- wymaga: service -->
<!--
  Część 6: moduł „Serwis” — zgłoszenia reklamacyjne i serwisowe. Trafia do modelu tylko przy
  włączonym module (SERVICE_PANEL=true, knowledge.flagsFor → service). Eforek KIERUJE do kreatora
  i może pokazać drogę (nav_service, service_new_btn, report_problem_btn); zgłoszenia NIGDY nie
  wysyła sam — ostatnie kliknięcie „{{service.submit}}” należy do klienta.
  Celowo pominięte: terminy odpowiedzi serwisu (szef nie podał SLA), sprawdzanie gwarancji
  (decyduje HKL), ceny napraw. Pytania o to → konsultant.
-->

# Serwis: zgłaszanie problemów z zamówieniem

## Do czego służy
- Pozycja menu „{{service.menu_label}}” prowadzi na stronę [[page:service]] (u administratora menu nazywa się „{{service.title}}”). Są tam rodzaje zgłoszeń i lista „{{service.my_tickets}}”.
- Rodzaje: „{{service.type.repair}}” (produkt wymaga naprawy), „{{service.type.complaint}}” (wada lub niezgodność z zamówieniem, wymagane co najmniej jedno zdjęcie), „{{service.type.transport}}” (przesyłka dotarła uszkodzona, wymagane co najmniej dwa zdjęcia: opakowanie i produkt) oraz „{{service.type.delivery}}” (pytanie o termin lub paczkę).
- Zgłoszenie trafia do serwisu HKL razem z numerem zlecenia, zaznaczonymi pozycjami, opisem i zdjęciami, więc serwis nie musi o nic dopytywać. Ceny nie są przekazywane.

## Jak zgłosić problem (kreator w 4 krokach)
1. Wejdź w „{{service.menu_label}}” i kliknij „{{service.start_new}}” — albo na liście „{{base.orders_history}}” lub w podglądzie wysłanego zlecenia kliknij „{{service.report_button}}”; wtedy zlecenie jest już wybrane.
2. Krok „{{service.step.order}}”: zakładka „{{service.tab_delivered}}” pokazuje zlecenia dostarczone (status 100 %), zakładka „{{service.tab_in_progress}}” — pozostałe wysłane. Szukaj po numerze, komisji, odbiorcy końcowym lub dacie wysłania. Jeśli zamówienie było składane telefonicznie albo sprzed portalu, kliknij „{{service.no_order_link}}” — wtedy wymagane są komisja, kolekcja i opis.
3. Krok „{{service.step.type}}”: wybierz rodzaj, sprawdź „{{service.commission}}” (zawsze wymagana), zaznacz pozycje, których dotyczy problem, podaj „{{service.qty_affected}}” i „{{service.category_label}}”. Dla zlecenia w realizacji dostępne jest tylko „{{service.type.delivery}}” — pozostałe rodzaje odblokują się po dostarczeniu.
4. Krok „{{service.step.details}}”: opisz problem w swoim języku (serwis dostanie tłumaczenie), dodaj zdjęcia (na telefonie „{{service.take_photo}}”, na komputerze „{{service.add_files}}” albo przeciągnij pliki; do 10 plików po 20 MB) i uzupełnij kontakt: „{{service.contact_name}}”, „{{service.contact_phone}}”, „{{service.contact_email}}”.
5. Krok „{{service.step.summary}}”: sprawdź wszystko, w razie potrzeby „{{service.change}}”, potem „{{service.submit}}”. Pojawi się numer zgłoszenia w formacie SRV-rok-numer, a na e-mail przyjdzie potwierdzenie.
- Przy „{{service.type.delivery}}” portal najpierw pokazuje, co już wiadomo o zleceniu („{{service.known_title}}”: status produkcji, planowaną datę wysyłki, numery paczek z linkami do śledzenia). Jeśli to nie odpowiada na pytanie, kliknij „{{service.not_answered}}”.
- Przy „{{service.type.repair}}” jest zaznaczone domyślnie „{{service.quote_before_repair}}”. Przy „{{service.type.transport}}” podaje się „{{service.delivered_at}}” i czy „{{service.carrier_noted}}”; po 7 dniach od dostawy pojawia się ostrzeżenie, ale wysłać nadal można.

## „{{service.my_tickets}}” i co dalej
- Lista pokazuje numer, datę, rodzaj, zlecenie, komisję, status i ostatnią zmianę; kliknięcie otwiera zgłoszenie z historią („{{service.timeline}}”) i plikami.
- Statusy: „{{service.status.submitted}}”, „{{service.status.accepted}}”, „{{service.status.in_progress}}”, „{{service.status.waiting_for_client}}”, „{{service.status.resolved_accepted}}”, „{{service.status.resolved_rejected}}”, „{{service.status.closed}}”. Zmiana statusu przychodzi też mailem.
- Dopóki zgłoszenie nie jest zamknięte, można dopisać informację lub zdjęcia w sekcji „{{service.add_message}}”. Dopisek trafia do serwisu tą samą drogą co zgłoszenie.
- Terminów odpowiedzi serwisu portal nie podaje. Pytania o decyzję, gwarancję lub koszt naprawy → konsultant.
