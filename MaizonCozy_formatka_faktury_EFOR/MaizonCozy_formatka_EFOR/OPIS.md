# Formatka faktury MaizonCozy B.V. dla EFOR

23.10.2026 · Wiktoria Krawczyk · dla Pawła Woronieckiego (prośba z 22.10: „szablon faktury do Maizon Cozy”, do wprowadzenia w EFOR)

## Co to jest
Szablon PDF faktury MaizonCozy B.V. w wersji, o którą prosił KK w wątku „Poprawiony layout faktury PDF”:

- **układ z 19.10**: zwarty pasek „MaizonCozy B.V.” u góry zamiast papieru firmowego z PrintRight
  (KK 20.10: „Twój mi się znacznie bardziej podobał … Nie słuchaj innych”);
- **tylko A4 poziomo** (KK 20.10: „tylko poziome!!!”);
- **mniejsza czcionka 7,5 pt**, żeby zmieściło się więcej pozycji (KK 19.10). Na stronie 1 mieści się **10 pozycji
  pięciowierszowych**, na kolejnych **11**. Krótsze pozycje (3–4 wiersze, jak na 26000007) zajmują mniej miejsca.
  Dziś PrintRight drukuje 5 pozycji na stronie;
- **logo MaizonCozy obok numeru faktury**, nie nad nim (KK 19.10 zaznaczył miejsce „logo?”, 20.10: „logo nad numerem
  faktury zamiast obok”). Logo to plik, który KK przysłał w wątku;
- **KvK 93574797** w stopce, razem z IBAN, BIC i BTW.

Szablon jest napisany pod to, czym EFOR robi PDF-y faktur: **HTML → Chromium (Playwright `page.pdf`)**.
Sprawdzony przez Node + nunjucks + playwright-core (`render_przyklad.js`) na Chrome 154 oraz na headless shell 131
i 152 (domyślny Chromium Playwrighta): te same podziały wierszy i stron.

## Pliki
| Plik | Co |
|---|---|
| `faktura_maizoncozy.njk` | strona faktury: HTML + CSS, składnia nunjucks/Jinja (`{{ pole }}`, `{% for %}`, `{% if %}`) |
| `stopka.njk` | stopka na każdej stronie (dane sprzedawcy + „Factuur nr · Bladzijde X/Y”), idzie jako `footerTemplate` |
| `render_przyklad.js` | przykład renderowania w Node (to samo, co może robić EFOR) |
| `przyklad_dane_8poz.json`, `przyklad_dane_16poz.json` | dane przykładowe = opis pól (dane syntetyczne) |
| `zasoby/maizoncozy_logo.png` | logo od KK (przycięte białe marginesy, 174 × 183 px) |
| `zasoby/maizoncozy_pasek.svg` | pasek „MaizonCozy B.V.” (64 × 11 mm, tekst zamieniony na krzywe) |
| `zasoby/LiberationSans-*.ttf` | czcionka (licencja SIL OFL, `LICENSE-Liberation.txt`); osadzona, więc PDF wygląda tak samo na każdym serwerze |
| `przyklady/*.pdf`, `przyklady/*.png` | wynik: 8 pozycji = 1 strona, 16 pozycji = 2 strony (10 + 6), znak wodny „VOORBEELD” |

## Jak wygenerować PDF (Playwright 1.49+)
```js
const html   = env.render('faktura_maizoncozy.njk', { ...dane, assets });
const footer = env.render('stopka.njk',            { ...dane, assets });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true,
                 displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer,
                 margin: { top: '13mm', right: '0mm', bottom: '13mm', left: '0mm' } });
```
- **Marginesy wyznacza `@page` w szablonie: 13 / 0 / 13 mm, a strona 1 ma górny 0.** Chromium bierze je z `@page`;
  te w `page.pdf` są tylko dla porządku (takie same). Zmiana samych marginesów w `page.pdf` nic nie zmienia.
- **Dolny margines 13 mm jest potrzebny.** Chromium rysuje stopkę (`footerTemplate`) zawsze 5,1 mm nad dolną krawędzią,
  a stopka ma 7,2 mm (dwa wiersze). Przy mniejszym marginesie kreska stopki przechodzi przez ostatni wiersz tabeli
  albo przez sumy. Zasada: dolny margines ≥ 5,1 mm + wysokość stopki.
- Boki mają 0 mm, bo pasek zaczyna się od lewej krawędzi strony; resztę treści odsuwa od krawędzi `padding: 0 14mm`.
- Strona 1: `@page :first { margin-top: 0 }`, pasek jest w treści, od górnej krawędzi. Strony 2+: pasek i numer faktury
  są w górnym marginesie (`@top-left` / `@top-right` w `@page`). Działa to od Chromium 131, czyli Playwright 1.49+.
  Starszy Chromium na stronach 2+ pominie i pasek, i numer w nagłówku. Numer zostaje wtedy tylko w stopce.
- `headerTemplate` musi zostać pusty (`<span></span>`). Szablon nagłówka Playwrighta rysuje się na KAŻDEJ stronie,
  także na pierwszej, na pasku z treści.
- `text-rendering: geometricPrecision` (w szablonie i w stopce) zostaje. Dzięki niemu podział wierszy jest identyczny
  w Chrome, w domyślnym Chromium Playwrighta (headless shell) i przy każdej konfiguracji czcionek serwera. Sprawdzone:
  Chrome 154 oraz headless shell 131 i 152 dają co do 0,1 mm te same pozycje tekstu.
- `assets` = logo, pasek i dwie czcionki jako **data URI** (patrz `render_przyklad.js`). `setContent()` nie ma adresu
  bazowego, a stopka nie widzi zasobów strony, więc wszystko musi być wpisane w HTML. Czcionki są także w stopce,
  bo inaczej serwer bez Liberation Sans weźmie inną czcionkę. Napisy base64 lepiej zbudować raz na proces.
  Render 12-stronicowej faktury trwa ok. 0,6 s.
- Czcionek nie przycinać pod inną nazwą rodziny ani nie zmieniać: licencja (SIL OFL) zastrzega nazwę „Liberation”
  dla zmienionych plików.
- Numer strony w stopce: klasy `pageNumber` / `totalPages` wstawia Chromium.
- Pasek na zamianę musi mieć dokładnie `width="64mm" height="11mm"`. Na stronach 2+ margines `@page` rysuje obraz
  w jego własnym rozmiarze.

### Jeśli EFOR nie używa nunjucks
Szablon to zwykły HTML z kilkoma pętlami. Można go przepisać na EJS, Handlebars albo template literal, byle CSS
i kolejność elementów zostały bez zmian. Trzeba przenieść:
- **escaping HTML wszystkich pól danych** (nunjucks robi to sam: `autoescape: true`). W EJS `<%= %>`, w Handlebars `{{ }}`,
  w template literal funkcja zamieniająca `& < > " '`. Bez tego nabywca `Smit & Zonen <Interieur>` drukuje się źle.
  Napisy `assets.*` (base64) idą bez escapingu;
- wiersze opisu pozycji (`items[].lines`) łączone `<br>` (w szablonie `loop.first`);
- pola wstawiane w `<style>`: `assets.font_*` w `@font-face`, `assets.strip` w `@top-left`, `document.title`
  i `document.number` w `@top-right` (także w stopce);
- pola opcjonalne to tylko te w `{% if %}`: `watermark`, `document.due_date`, `buyer.vat_id`, `buyer.email`. Pozostałe są
  wymagane. `render_przyklad.js` rzuca błąd, gdy brakuje któregoś (`throwOnUndefined`), żeby nie wyszła faktura
  z pustą sumą albo bez stopki.

### Kontrola po wdrożeniu w EFOR
Te same dane muszą dać ten sam PDF co w `przyklady/`: `przyklad_dane_16poz.json` = 2 strony (10 + 6 pozycji),
`przyklad_dane_8poz.json` = 1 strona (pozycje 5 i 6 mają po 4 wiersze). Tekst stopki na każdej stronie zawiera
`NL866455139B01` i `KvK 93574797`.

## Pola danych (wszystko jako gotowe napisy; szablon niczego nie formatuje)
| Pole | Znaczenie | Przykład |
|---|---|---|
| `document.title` | `Factuur` albo `Creditnota` (korekta) | Factuur |
| `document.number` | numer faktury | 26000007 |
| `document.place` | miejsce wystawienia | Zaltbommel |
| `document.issue_date` | data wystawienia, ISO jak dziś w PrintRight | 2026-10-15 |
| `document.due_date` | termin płatności (`Betalingstermijn`); puste = wiersz znika | 2026-11-14 |
| `buyer.name`, `buyer.street`, `buyer.city_line` | nabywca; `city_line` = kod + miasto (+ „, kraj”, gdy nie NL) | Joost Wonen / Hoornsewal 1 / 2635 CL Den Hoorn |
| `buyer.vat_id`, `buyer.email` | BTW-nr. i e-mail nabywcy; puste = wiersz znika | NL855923945B01 |
| `items[]` | pozycje w kolejności faktury | |
| `items[].pos` | numer pozycji | 1 |
| `items[].lines[]` | wiersze opisu: 1. = komisja zamówienia (`EO/13/1/Jansen-slk achter`), dalej opis produktu i parametry | |
| `items[].qty` | ilość | 1,00 |
| `items[].catalog_price` | cena katalogowa (`Catalogusprijs EURO`) | 488,00 |
| `items[].price` | cena po rabatach (`Prijs EURO`), pogrubiona | 228,70 |
| `items[].amount` | wartość pozycji (`Bedrag EURO`), pogrubiona | 228,70 |
| `items[].price_group` | grupa cenowa (`Prijsgroep`) | 1 |
| `notes[]` | zdania pod tabelą (zasady niżej) | |
| `totals.net` | `Netto totaal` | 1.963,80 EUR |
| `totals.vat[]` | wiersze BTW: `{label, amount}`; jedna stawka: `21% BTW`; kilka stawek: `21% BTW over 1.234,56` (także `0% BTW over …`); sama 0 %: `0% BTW`. **Kwota = suma BTW pozycji zaokrąglanych osobno**, jak w PROD/PrintRight (26000007: 412,41 EUR, choć 21 % × 1.963,80 = 412,40); nie przeliczać od netto | 21% BTW / 412,41 EUR |
| `totals.gross_label`, `totals.gross` | `Totaal` (korekta: `Totaal creditnota`) | 2.376,21 EUR |
| `seller.footer_line1`, `seller.footer_line2` | dwa wiersze stopki (stałe, niżej) | |
| `watermark` | tylko wydruki próbne (`VOORBEELD – geen factuur`); na prawdziwej fakturze puste | |

Formaty: kwoty `1.234,56` (kropka tysięcy, przecinek), sumy z „ EUR”; daty `RRRR-MM-DD`.

Zdania pod tabelą (`notes`), jak na fakturach Cozy z PrintRight:
1. `Wij verzoeken u het betreffende bedrag over te maken op onderstaande rekening.` (tylko przy płatności przelewem)
2. `Op de goederen rust een verlengd eigendomsvoorbehoud.`
3. `Factuurdatum komt overeen met leverdatum (verzenddatum)`: tylko gdy data faktury = data wysyłki. Inaczej zamiast
   niego `Leverdatum: RRRR-MM-DD` (faktura zbiorcza z różnymi datami: data wysyłki przy pozycjach albo lista dat).

**Korekta (`Creditnota`)**: zamiast zdań 1–3 jedno zdanie z **obowiązkowym numerem faktury pierwotnej**:
`Creditnota bij factuur <nr>. Het bedrag wordt verrekend of terugbetaald.`, opcjonalnie `Reden van de correctie: <powód>`;
`due_date` puste, kwoty ujemne, `totals.gross_label` = `Totaal creditnota`. Blok „Goederen ontvangen” szablon
ukrywa sam, gdy `document.title` = `Creditnota`.

**0 % BTW** tylko w dwóch przypadkach, z obowiązkowym zdaniem w `notes`:
- dostawa do innego kraju UE (ICL), `buyer.vat_id` obowiązkowe:
  `Intracommunautaire levering, vrijgesteld van btw (0 %, art. 138 Btw-richtlijn 2006/112/EG). Btw-nummer afnemer: <vat_id>.`
- eksport poza UE: `Uitvoer buiten de EU, vrijgesteld van btw (0 %, art. 146 Btw-richtlijn 2006/112/EG).`

Inne przypadki 0 % to błąd danych; takiej faktury nie wystawiać. Dziś wszystkie faktury Cozy idą do klientów z NL, 21 %.

Stopka (`seller`), stała dla MaizonCozy:
- `MaizonCozy B.V., IBAN NL41INGB0108648206, BIC INGBNL2A, BTW NL866455139B01, KvK 93574797`
- `Mezenlaan 5, 5301NW Zaltbommel, Nederland, tel.: +31 6 17631197, https://www.maizoncozy.eu, e-mail: info@maizoncozy.eu`

Uwaga: papier firmowy z PrintRight drukuje BTW z błędem („L866455139B01”, bez N). Tu jest poprawnie: NL866455139B01.

**Stopka jest obowiązkowa.** Tylko w niej są nazwa i adres sprzedawcy, BTW-nr., KvK i IBAN, które w Holandii musi mieć
każda faktura. PDF bez `footerTemplate` (albo z `displayHeaderFooter: false`) jest niezgodny z przepisami. Kontrola po
wygenerowaniu: tekst PDF musi zawierać `NL866455139B01` i `KvK 93574797` na każdej stronie.

## Zasady układu (żeby zostało tak, jak zaakceptował KK)
- Strona 1: pasek w lewym górnym rogu, od krawędzi (0–11 mm) | logo 11 mm + `Factuur: nr` / miejsce: data /
  `Betalingstermijn` w prawym górnym rogu; pod paskiem nabywca, obok jego BTW-nr. i e-mail; potem tabela.
- Strony 2+: pasek w lewym górnym rogu i `Factuur nr` po prawej (jak w układzie z 19.10), pod nimi tabela
  z nagłówkiem kolumn.
- Kolumny (mm): Pos 9,6 | Beschrijving van goederen 152,5 | Aantal 15,4 | Catalogusprijs 23,7 | Prijs 23,7 | Bedrag 24,0 |
  Prijsgroep 20,0 (razem 268,9). Nagłówek kolumn 6,3 pt w jednej linii, powtarza się na każdej stronie.
- Pozycja nigdy nie dzieli się między strony (`break-inside: avoid`). Uwagi, „Goederen ontvangen: … (Datum/Handtekening)”
  i sumy są jednym blokiem pod tabelą.
- Treść 7,5 pt, wiersz opisu 2,95 mm. Większa czcionka albo większe odstępy zmniejszą liczbę pozycji na stronie.
