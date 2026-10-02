<!-- wymaga: invoices -->
<!--
  Część 5: moduł „Faktury" — trafia do modelu tylko przy włączonym module
  (INVOICES_ENABLED) i nie dla kont sklepów grupy (knowledge.flagsFor).
  Etykiety panelu faktur: {{inv:klucz}} = services/invoices/i18n/panel.json
  (pl/en/de; dla fr/nl panel jest po polsku — tak samo podstawia je serwer).
  Typ dokumentu i status panel pokazuje KODAMI (invoice, DRAFT…) — stąd
  tłumaczenia kodów poniżej.
  Celowo pominięte (niepewne w kodzie, decyzja zespołu): format numeru szkicu
  vs „Dane do faktur", logo, rachunek bankowy na fakturach salonu, to, czy
  automat faktur działa na produkcji. Pytania o to → konsultant.
-->

# Faktury (moduł „Faktury” w portalu)

## Kto co wystawia
- Wejście: pozycja „Faktury” w menu bocznym (na telefonie w menu „więcej”). Ta pozycja menu nazywa się „Faktury” we wszystkich językach portalu — nie tłumacz tej nazwy. Kontom sklepów/klientów grupy moduł nie jest dostępny.
- Klient (salon, dealer) wystawia faktury swoim odbiorcom końcowym — klientom, którym sprzedaje. Typy: proforma i faktura VAT. Dane sprzedawcy na fakturze to dane konta klienta w portalu, a termin płatności to 14 dni. Klient nie ma ekranu „{{inv:profile}}” — zmianę danych firmy na fakturach zgłasza się konsultantowi.
- Pracownik klienta korzysta z modułu tak samo jak klient.
- Konto organizacji wystawia faktury swoim klientom (salonom) — „{{inv:level_2}}” — albo bezpośrednio odbiorcom końcowym — „{{inv:level_4}}”. Wybiera to na karcie „{{inv:choose_relation}}”. Może wystawiać także fakturę zaliczkową i końcową.
- W portalu widać tylko faktury, które konto samo wystawia. Faktur otrzymanych od organizacji lub producenta w portalu nie ma → konsultant.
- Fakturę wystawia się zawsze z wysłanego zamówienia (z „{{base.orders_history}}”). Oferty niewysłanej nie da się zafakturować, nie ma też faktury bez zamówienia. Waluta zawsze EUR.

## Odbiorcy końcowi (kartoteka klientów do faktur)
- „Faktury” → „{{inv:end_clients}}”. To prywatna lista klientów konta — odbiorcy nie dostają kont w portalu.
- Dodanie: „{{inv:end_client_new}}”, w oknie wybierz „{{inv:end_client_type}}” („{{inv:type_company}}” albo „{{inv:type_person}}”), wpisz nazwę i kraj (obowiązkowe), NIP i NIP UE, adres i kontakt, a potem „{{inv:save}}”. Firma wymaga numeru NIP. Dodatkowe numery rejestrowe (np. REGON, Steuernummer, KVK, SIREN/SIRET) pojawiają się zależnie od kraju.
- „{{inv:delivery_address}}” — zaznacz, gdy towar jedzie pod inny adres niż rejestrowy; taki adres drukuje się na fakturze. „{{inv:notes}}” są widoczne tylko dla konta, nie trafiają na fakturę.
- Edycja: „{{inv:edit}}” przy odbiorcy. „{{inv:deactivate}}” ukrywa odbiorcę (wystawione faktury zostają); przywrócenia ukrytego odbiorcy w portalu nie ma → konsultant.
- Odbiorcę można też dodać i wybrać od razu w nagłówku oferty: zaznacz „{{new-order.end_client_checkbox}}”, wyszukaj odbiorcę w polu „{{new-order.end_client_placeholder}}” albo dodaj nowego przyciskiem „+”. Zamówienie zostanie z nim powiązane. Odznaczenie pola w edycji nagłówka odpina odbiorcę.

## Faktura dla odbiorcy końcowego (klient/salon)
1. Kliknij „Faktury”.
2. W „{{inv:select_end_client}}” wyszukaj odbiorcę (nazwa, NIP, miasto lub e-mail) i wybierz go z podpowiedzi. Jeśli go nie ma, dodaj go w „{{inv:end_clients}}”.
3. Na ekranie odbiorcy, w sekcji „{{inv:new_from_order}}”, w polu „{{inv:order}}” wpisz numer lub nazwę zamówienia i wybierz je z podpowiedzi (zamówienia powiązane z tym odbiorcą są na górze).
4. „{{inv:doc_type}}”: „invoice” = faktura VAT, „proforma” = faktura proforma. Wybierz „{{inv:lang}}” (pl, en albo de).
5. Zostaw zaznaczone „{{inv:issue_now}}” (odznaczone = szkic bez numeru) i kliknij „{{inv:create}}”.
6. Jeśli zamówienie nie jest jeszcze powiązane z odbiorcą, portal zapyta o przypisanie — potwierdź „{{inv:assign_confirm}}”. Jeśli ma innego odbiorcę — „{{inv:reassign_confirm}}”.
- Kwoty pochodzą z zamówienia; rabat ustawiony w „{{base.give_discount_tooltip}}” trafia na fakturę odbiorcy końcowego jako rabat (wartość przed rabatem i rabat dla odbiorcy).
- Zamówienie z wystawioną fakturą VAT znika z podpowiedzi; proforma go nie zamyka.

## Faktura dla klienta (konto organizacji)
1. „Faktury” → na karcie „{{inv:choose_relation}}” wybierz „{{inv:level_2}}”.
2. W „{{inv:select_client}}” wyszukaj i wybierz klienta.
3. W „{{inv:orders_window_title}}” widać zamówienia klienta bez faktury: „{{inv:orders_filter_shipped}}” (domyślnie — te, które wyjechały) albo „{{inv:orders_filter_all}}” (także w produkcji, np. pod proformę lub zaliczkę). Zaznacz zamówienia (albo „{{inv:orders_select_all}}”).
4. Wybierz „{{inv:doc_type}}”, język i „{{inv:issue_now}}”, potem „{{inv:create_selected}}”. Każde zaznaczone zamówienie dostaje osobny dokument.
- Typy: „proforma”, „advance” = faktura zaliczkowa (pole „{{inv:advance_percent}}”, 1–100%), „invoice” = faktura VAT, „final” = faktura końcowa, która odlicza wcześniejsze zaliczki. Zaliczka i proforma nie zamykają zamówienia — potem wystawia się fakturę końcową.
- Rabat z Centrum rabatów nie trafia na faktury organizacji.
- Dane sprzedawcy, rachunek bankowy, domyślny termin i forma płatności, język, stopka i numeracja: „Faktury” → „{{inv:profile}}”, potem „{{inv:save}}”. Puste pola = dane konta organizacji.

## VAT
- Stawka zależy od krajów sprzedawcy i nabywcy: ten sam kraj → stawka krajowa; nabywca w innym kraju UE → 0%; nabywca spoza UE → 0% (eksport). Kierunek i skutek widać na karcie nabywcy.
- Przy 0% w UE warto uzupełnić numer VAT-UE nabywcy (ostrzeżenie „{{inv:no_vat_eu}}”). Pytania podatkowe (czy stawka jest właściwa w konkretnym przypadku) → konsultant.

## Lista dokumentów, podgląd i PDF
- Dokumenty są na ekranie danego nabywcy, w sekcji „{{inv:documents}}”. Zbiorczej listy wszystkich faktur ani filtrów po dacie i statusie w portalu nie ma.
- „{{inv:preview}}” otwiera dokument w nowej karcie, „{{inv:pdf}}” pobiera plik PDF.
- Wysyłki faktury e-mailem z portalu nie ma — pobierz PDF i wyślij go samodzielnie.
- Statusy na liście: DRAFT = szkic (bez numeru), ISSUED = wystawiona, PAID = zapłacona, OVERDUE = po terminie, CANCELLED = anulowana. Znaczek „auto” oznacza fakturę wystawioną automatycznie po wysłaniu zamówienia (tylko faktury organizacji, jeśli dla organizacji włączono automat; czy jest włączony → konsultant).

## Szkic, wystawienie, zapłata, anulowanie, korekta
- Szkic: „{{inv:issue}}” nadaje numer, „{{inv:cancel_doc}}” anuluje. Wystawiona: „{{inv:mark_paid}}” (zapłata całej kwoty) albo „{{inv:cancel_doc}}”. Zapłaconej i anulowanej nic już nie zmienia.
- Wystawionej faktury ani szkicu nie da się edytować. Błąd na fakturze: jeśli nie jest oznaczona jako zapłacona, anuluj ją i wystaw nową (dostanie nowy numer, zamówienie wraca na listę do zafakturowania).
- Faktury korygującej nie da się wystawić w portalu → konsultant. (Korekta zlecenia w historii zamówień to inna funkcja i nie dotyczy faktur.)
- Anulowana faktura automatyczna nie zostanie wystawiona ponownie sama — trzeba ją wystawić ręcznie.

## Czego moduł faktur nie ma
- Wysyłki e-mailem, płatności online, KSeF, JPK, eksportu do programu księgowego ani do Excela/CSV.
- Faktury bez zamówienia, edycji pozycji, dopisywania usług (np. montażu, transportu), częściowego fakturowania, innej waluty niż EUR, wgrywania logo.
- Faktury zaliczkowej i końcowej dla klienta/salonu (tylko proforma i VAT).

## Komunikaty
- „{{inv:pick_order}}” — wpisano tekst w pole zamówienia, ale nie wybrano zamówienia z podpowiedzi.
- „{{inv:pick_orders}}” — w oknie zamówień nic nie zaznaczono.
- Zerowa wartość netto zamówienia — pozycje są wycenione na 0, faktury nie da się wystawić → konsultant.
- „Odbiorca typu firma wymaga numeru NIP/VAT” — wpisz NIP albo zmień typ na „{{inv:type_person}}”.
- „Brak uprawnień do wystawiania dokumentów na poziomie…”, „Brak dostępu do zamówienia”, „Brak kontekstu organizacji” → konsultant.
