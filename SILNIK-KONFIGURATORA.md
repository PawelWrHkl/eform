# Silnik konfiguratora eForm — jak naprawdę działa

Notatki z analizy kodu (`public/scripts/form.js`, `main.js`, `public/scripts/formTools/*`,
`public/scripts/formula.js`) oraz z obserwacji działającej aplikacji. Dokument opisuje
**mechanikę**, nie intencje — każde twierdzenie da się sprawdzić we wskazanym miejscu w kodzie.

Powiązane: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) (architektura całości),
`services/configuratorTester/` (automat testujący, który z tych notatek korzysta).

---

## 1. Pliki i ścieżki

Produkt = kombinacja wartości ze słownika, ograniczona regułami. Wszystko siedzi w plikach TSV.

| plik | ścieżka | co zawiera |
|---|---|---|
| `group.txt` | `<dataDir>/data/<lang>/group.txt` | działy: `num`, `description`, `products` (lista numerów grup) |
| `prod.txt` | `<dataDir>/<grupa>/data/<lang>/prod.txt` | `code`, `description`, `users`, `param_scripts`, `paramdict_aliases` |
| `param.txt` | `<dataDir>/<grupa>/data/versions/<wersja>/<lang>/param.txt` | rejestr parametrów i reguł |
| `paramdict.txt` | `<dataDir>/<grupa>/data/versions/<wersja>/<lang>/paramdict.txt` | wartości (modele, kolory, tkaniny…) |
| skrypty cenowe | `<dataDir>/<grupa>/data/param-<PARAM>-<wariant>.js` | wyliczenie ceny |
| kolekcje klienta | `<dataDir>/<grupa>/data/paramdict-<PARAM>-<MARKA>.txt` | podmiana/zawężenie słownika per klient |

⚠️ **Dwie różne ścieżki, łatwo pomylić.** Reguły (`param.txt`, `paramdict.txt`) ładują się z
**wersjonowanego** katalogu `versions/<wersja>/<lang>/` — dzięki temu zapisana pozycja zachowuje
reguły ze swojej wersji. `prod.txt` istnieje **tylko** w bieżącym `data/<lang>/` i wersjonowany
nie jest, podobnie jak skrypty cenowe. Patrz `dataLoader.js:27` (`mainPath`) kontra
`getAvailableForms.js:255`.

⚠️ `<dataDir>` to `config.dataDir`, na tym hoście **`/mnt/eform/datatest`**, nie `/mnt/eform/data`.
Nigdy nie wpisywać ścieżki na sztywno.

---

## 2. Jak powstaje konfiguracja — przepływ

```
main.js initialize()
  └─ FormsManager.getAvailableForms()          → group.txt → lista działów
       └─ getOwner()  (/user/owner/)           → { orgIdent, userIdent }   ← TOŻSAMOŚĆ KLIENTA
  └─ wybór działu → buildGroupSelect()
       └─ FormsManager.getGroups(dept)         → prod.txt każdej grupy działu
            • `users` = whitelist → grupa NIE pojawi się na liście, jeśli klienta tam nie ma
            • `param_scripts`  → ORG/KLIENT/PARAM=param-CENA-C.js
            • `paramdict_aliases` → ORG/KLIENT/PARAM=paramdict-KOLOR-COZY.txt
  └─ wybór grupy → prepareForm() → getAppVersion() (/position/version/<grupa>/)
       └─ generateForm(version, groupNumber)   ← form.js:43
```

`generateForm` po kolei:

1. `DataLoader.init/parseData` — wczytuje `param.txt` i `paramdict.txt` z wersjonowanej ścieżki.
2. `convertDictValues` — z szerokiego TSV robi `{ PARAM: [ {VALUE, DESCRIPTION, ENABLE, PROC, ATTRIBUTES}, … ] }`.
3. `selectCollections` — nakłada kolekcje klienta (aliasy). **Wartość bez dopasowanego aliasu
   wypada ze słownika**; przy wielu aliasach jedna wartość rozmnaża się na `VALUE~1`, `VALUE~2`
   (`dataLoader.js:272-301`).
4. `selectPrices` — parametrowi z `SCRIPTS == 'true'` podstawia `param.SOURCE = <ścieżka><plik>.js`
   z mapowania klienta (`dataLoader.js:241`).
5. Dla każdego parametru: `getPossibleValues` → `buildHtml` → kontrolka.
6. Podpięcie zdarzeń, `getUid()`, i wszystko dalej idzie przez `updateProcedure`.

---

## 3. `param.txt` — kolumny, które rządzą

| kolumna | znaczenie |
|---|---|
| `NAME` | identyfikator parametru; `_`-prefiks lub brak `DESCRIPTION` → pole nie powstaje (`form.js:145`) |
| `DESCRIPTION` | etykieta |
| `TYPE` | `numeric`, `file`, … |
| `SOURCE` | `SOURCE == NAME` → parametr okienkowy (skosy, `slope.js`); inaczej ścieżka skryptu cenowego |
| `ENABLE` | **formuła widoczności** — patrz §5 |
| `FORMULA` | formuła wyliczająca wartość |
| `SCRIPTS` | `'true'` = weź skrypt z mapowania klienta; inaczej sam token wariantu |
| `DEFAULT` | wartość początkowa (tylko przy nowej pozycji) |
| `PROC` | **kolumna istnieje, ale jest pusta we wszystkich sprawdzonych grupach** (73, 71, 43, 39, 02) — `PROC` działa wyłącznie na poziomie wartości w `paramdict.txt` |
| `FORMROW` | `'0'` → pole nigdy nie widoczne |
| `LISTROW` / `LISTSUM` | `LISTROW='2'` lub `LISTSUM='true'` → wiersz cenowy; `LISTSUM` → wchodzi do sumy |
| `MULTI` | wielokrotny wybór |
| `DEPENDENCES`, `RELATED` | zależności między parametrami (reset i przebudowa list) |
| `ALIASES`, `GRAPHICS`, `FORMAT`, `INFO` | aliasy, grafiki, format, podpowiedź |

Pełny nagłówek `param.txt` (19 kolumn, identyczny w sprawdzonych grupach):
`NAME, DESCRIPTION, TYPE, PROC, ENABLE, SOURCE, GRAPHICS, DEPENDENCES, RELATED, FORMULA, SCRIPTS,
ALIASES, DEFAULT, MULTI, FORMAT, FORMROW, LISTROW, LISTSUM, INFO`

Parametr z `SCRIPTS` albo `FORMULA` jest **liczony** — jego input jest `disabled`, a wartość
startuje od `0` (`form.js:281-292`).

---

## 4. `paramdict.txt` — kształt

Szeroki TSV: jeden wiersz = jeden „poziom", a kolumny są pogrupowane po parametrze:

```
ROW_NUM  MODEL_VALUE  MODEL_DESCRIPTION  MODEL_ENABLE  MODEL_PROC  MODEL_ATTRS  KOLOR_VALUE  …
```

`convertDictValues` (`dataLoader.js:103`) szuka kolumn `*_VALUE` i dokleja do nich
`_DESCRIPTION`, `_ENABLE`, `_PROC`, `_ATTRS`. `<NULL>` → `null`; wiersz bez `VALUE` **i** bez
`DESCRIPTION` jest pomijany. `_ATTRS` to `klucz=wartość|klucz=wartość` → z tego powstają filtry
w dialogach (`createParameterFilters`).

⚠️ **`DESCRIPTION` nie jest kosmetyką — to nośnik grupy cenowej.** Skrypty cenowe bramkują sekcje
warunkami w rodzaju `ZAWIERA(KOLOR___DESCRIPTION,"#2")`, gdzie `"PG #2"` przychodzi właśnie z opisu.
Dla części tkanin opis jest pusty w bazowym `paramdict.txt`, a grupa cenowa istnieje **tylko
w kolekcji aliasów klienta** — szczegóły w `services/orderImport/paramDescriptions.js`.

---

## 5. Reguły — dwa mechanizmy, nie jeden

### `ENABLE` — czy pole/wartość istnieje

Formuła zwracająca prawdę/fałsz, liczona przez `window.FormulaHandler.evaluateFormula`:

* **na poziomie parametru** (`param.txt` → `ENABLE`): `applyParamVisibilityFromFormulas`
  (`updateFieldsAndValues.js:344`) → fałsz oznacza ukrycie pola i wpis do `disabledParams`;
  dla parametru ze skryptem dochodzi jeszcze `window.skipCountParams` (pomijany w liczeniu).
* **na poziomie wartości** (`paramdict.txt` → `<PARAM>_ENABLE`): `getPossibleValues`
  (`createForm.js:103`) odsiewa wartości, dla których formuła jest fałszywa. **To jedyne
  zawężanie listy opcji** — nic innego jej nie filtruje; `ATTRS` służy wyłącznie do filtrów w UI.
* Zwrotka `'password'` = pole zablokowane hasłem (`HASLO`), traktowane jak niewidoczne.

### `PROC` — co się dzieje po wybraniu wartości

`PROC` wybranej wartości jest ewaluowany w `getProcedures` (`validateUtils.js:15`) w trybie
`"PROCEDURE"`. Cała robota siedzi w funkcji `USTAW` (`formula.js`, `setFunction("USTAW")`):

| wywołanie | efekt |
|---|---|
| `USTAW(POLE,"MIN",v)` / `"MAX"` | `window.inputsValidators[param][wartość][POLE].MIN/MAX` — zakres twardy (legacy) |
| `USTAW(POLE,"MIN2",v)` / `"MAX2"` | zakres **ostrzegawczy** — poza nim „produkcja możliwa bez gwarancji" |
| `USTAW(POLE,"DOM",v)` | wartość domyślna → `window.inputsDefaults`; gdy liczbowa, wpisywana wprost do inputu |
| `USTAW(POLE,"WAR",v)` | wartość wymuszona → `window.constValues` |

⚠️ **Dlatego `window.inputsValidators` jest PUSTE, dopóki nie wybrano wartości z `PROC`.**
To nie błąd — MIN/MAX dla `SZEROKOSC` nie istnieją „same z siebie", pojawiają się dopiero, gdy
model je ustawi. Każda próba odczytania granic wymiarów przed wyborem modelu zwróci `undefined`.
Niezależne źródło granic to arkusz cennika (osie sekcji) — patrz `excelTruthTable`.

---

## 6. Stan globalny (kontrakt `window`)

`generateForm` zeruje to na starcie (`form.js:52-88`) i utrzymuje przez cały cykl:

| zmienna | rola |
|---|---|
| `params`, `formValues`, `formDisplayValues`, `formInputs` | rejestr parametrów, wartości, wiersze do wyświetlenia, kontrolki |
| `allOptionsByParameter` | słownik po `convertDictValues` + kolekcje klienta |
| `enabledParams` | parametry aktualnie aktywne — **to one podlegają walidacji** |
| `inputFlags` | poprawność per pole; `checkFlags()` = prawda tylko gdy WSZYSTKIE `true` |
| `inputsValidators`, `inputsDefaults`, `constValues` | wynik `USTAW` |
| `skipCountParams`, `lockedParams`, `subParams`, `manualParams` | pomijane / zablokowane / ceny klienta / nadpisane ręcznie |
| `calculationQueue`, `isCalculating`, `isPriceCalculating`, `finishFlag` | sterowanie kolejnością obliczeń |
| `uid` | identyfikator pozycji — **wchodzi do wyceny** (dopłata per klient w skrypcie) |

`finishFlag` ustawia się na `true` **1300 ms po** zakończeniu `updateProcedure`
(`form.js:564`) — automat musi na to czekać, samo `isCalculating === false` nie wystarczy.

---

## 7. `updateProcedure` — kolejność ma znaczenie

Jedno wywołanie na każdą zmianę pola (`form.js:487`). Kroki, w tej kolejności:

1. **Kolejka** — `calculationQueue`; równoległe wywołania czekają na swoją turę (`form.js:501-507`).
2. Przepisanie wartości z pól liczonych do `values`.
3. `setDescription` — dokłada `<PARAM>___DESCRIPTION`, `_ALIAS`, `_ALIAS___DESCRIPTION`.
4. `convertIntoPercent`, `hideLocked`, `hideSub`, `buildValuesToDisplay`, `setListRow`.
5. `values['uid'] = window.uid`.
6. `updateFieldInputs` — przebudowa list opcji.
7. **`getProcedures`** — ewaluacja `PROC` → walidatory i wartości domyślne.
8. **`validateFormInput`** — sprawdzenie zakresu dla zmienionego pola.
9. **`updateFieldStates`** — przeliczenie cen (§8).
10. `generateShortJson`, `hideParams`, `fillInputDescription`.
11. Po opróżnieniu kolejki: `applyPriceFactor` (mnożnik **tylko wizualny**).

Pola liczbowe mają **debounce 500 ms** na zdarzeniu `input` (`form.js:387`) — sterując
formularzem programowo trzeba wpisywać wartość (nie przypisywać) i czekać dłużej niż debounce.

---

## 8. Ceny

`updateFieldStates` (`updateFieldsAndValues.js:389`) dzieli parametry na dwa worki:

* **`SOURCE`** (skrypt cenowy) → `calculateFromScript` → `loadScript` odpala `param-*.js`
* **`FORMULA`** → `calculateFromFormula`

Kolejność jest celowa i nietrywialna:

1. **pre-pass**: wszystkie formuły — żeby skrypty widziały świeże wartości,
2. **skrypty**, jeden po drugim (`executeNextScript`),
3. **post-pass**: formuły ponownie — bo skrypty mogły zmienić wejścia,
4. `applyClientDiscount` → `applyVatToGrossValue` → `checkIfPriceIsCorrect`.

### „Według cennika" = silnik sam mówi, że cena wyszła zero

`checkIfPriceIsCorrect` (`pricesCalculator.js:322`): jeśli którykolwiek z `CENA`, `CENA_SUMA`,
`SUMA_BRUTTO` **istnieje w formularzu** i wyszedł `0`, a widoczne `SZEROKOSC`/`WYSOKOSC` są
wypełnione — silnik podmienia pola cenowe na tekst `t('form.pricelist_info')`, czyli
**„Według cennika"**.

⚠️ **„Według cennika" ma DWIE przyczyny, nie jedną.** Druga jest groźniejsza i cichsza:
`scriptLoader.js loadScript()` wstawia skrypt jako `<script src=…>`, a gdy plik **nie da się
sparsować albo załadować**, odpala się `script.onerror` / globalny handler i `errorShield()`
zwraca `{ CENA: t('order.according_to_price') }` — ten sam napis. Czyli:

| napis w polu ceny | przyczyna | jak rozpoznać |
|---|---|---|
| „Według cennika" | `checkIfPriceIsCorrect` — cena policzona jako 0 | `values.CENA == 0`, skrypt się wykonał |
| „według cennika" | `errorShield` — **skrypt cenowy się nie wykonał** | `values.CENA` to TEKST, a `CENA_SUMA == 0` |

Zmierzone na grupie 76: `param-CENA-A.js` ma `SyntaxError` (linia 138242), więc przeglądarka go nie
wykona, `errorShield` podstawia napis, `getTotal()` nie ma z czego policzyć sumy i **pozycja
zapisuje się bez wartości**. Cennik ma dla tej konfiguracji cenę 175. Jeden `node --check` na
skryptach odpowiada na to natychmiast — patrz `services/configuratorTester/scriptSyntaxCheck.js`.

⚠️ **To najlepszy dostępny wykrywacz braku ceny.** Nie trzeba własnej heurystyki: jeśli na ekranie
w polu ceny stoi „Według cennika", aplikacja właśnie zadeklarowała, że nie umie tego wycenić.
Filtr `inputs[paramName] !== undefined` jest tam nieprzypadkowy — `SUMA_BRUTTO` w części grup nie
istnieje, a importowane zamówienia wysyłają ten klucz jako `""`, co bez filtra oznaczało
fałszywe „brak ceny" na każdym zaimportowanym zamówieniu.

Mnożniki i dopłaty, o których arkusz cennika nic nie wie:
* `mul<x>` w nazwie skryptu — wariant cennika klienta,
* tabela `uid` na końcu skryptu (`f = f + 0.03; CENA = CENA * f`) — dopłata per klient; przy
  `f != 1` skrypt **sam dopisuje mnożnik do etykiety** `CENA_S`: `"(304(TCNDPG2))*1.045"`,
* `window.priceFactor` — **tylko wizualny**, nie idzie do zapisu.

---

## 9. Walidacja — co decyduje o „można zapisać"

```
show-button → validateForm()            (main.js:285)
   ├─ validateAllFieldsOnSubmit()       (validateUtils.js:396)
   └─ checkFlags()                      → true albo lista niepoprawnych pól
```

`validateAllFieldsOnSubmit`:

1. Usuwa z `inputFlags` wszystko, czego nie ma w `enabledParams` — **walidowane są tylko
   parametry aktualnie aktywne**.
2. Parametr liczony (`window.calculatedParams`) → automatycznie `true`.
3. `BUTTON` / `INPUT` → wartość niepusta; `type="number"` → musi być liczbą.
4. `REQUIRED === false` w `param.txt` **znosi** niepoprawność — ⚠️ ale **kolumny `REQUIRED` nie ma
   w żadnym sprawdzonym `param.txt`** (73, 71, 43, 39, 02), więc `fullParam?.REQUIRED ?? true` zawsze
   daje `true`. W praktyce: **każdy aktywny parametr jest wymagany**, a ta gałąź jest martwa.
5. Dla poprawnych: `validateFormInput` → zakres z `inputsValidators`.

`validateFormInput` (`validateUtils.js:225`): poza zakresem twardym → `invalid-input` + `inputFlags=false`;
w zakresie twardym, ale poza `MIN2/MAX2` → **ostrzeżenie** (`inputFlags` zostaje `true`).

⚠️ **Przycisk zapisu bywa aktywny przy czerwonym polu.** To nie dziura: klik przechodzi przez
`validateForm()`, które odmawia, gdy `checkFlags()` nie zwróci `true`. Werdykt „formularz przyjął
wartość" trzeba czytać z `inputFlags` / klasy `invalid-input`, **nie** ze stanu przycisku.

---

## 10. Pułapki przy automatyzacji (zmierzone, nie teoretyczne)

1. **Bezgłowy silnik ≠ przeglądarka.** `services/formEngine` woła `applyFormulaParams()` **po**
   kaskadzie cenowej, więc skrypt ceny widzi jeszcze niewyliczony parametr formułowy. Grupa 73,
   pozycja #6449: cennik i wdrożony skrypt **87.36**, przeglądarka **96.28**
   (`SZEROKOSC_POTRZEBNA` ustala się na 2830), bezgłowo **38.02** (oś jeszcze pusta).
2. **`evaluateFormula` przecieka zmienne między wywołaniami.** Liczy na parserze modułowym i woła
   `setVariable` tylko dla kluczy podanego kontekstu — **nigdy nie czyści pozostałych**. Przy jednym
   długo żyjącym realmie wartość z poprzedniej pozycji „ożywia" formułę, która powinna zawieść.
   Objaw: ta sama pozycja sprawdzana osobno wychodzi czysto, a w przelocie daje P1.
   Obejście: dołożyć do kontekstu każdą nazwę z formuły, `undefined` gdy jej nie ma.
3. **`uid` jest sztuczne bezgłowo** (`engine_1788786937956`), więc dopłata per klient się nie
   nalicza — bezgłowo dostajesz cenę bez `f`, w przeglądarce z `f`.
4. **Podmiana wartości w `values` ≠ wybór w formularzu.** Opcja z własnym `PROC` przebudowuje inne
   pola (MIN/MAX, wartości domyślne), a część pól to przyciski otwierające dialog, nie `select` —
   więc listy opcji nie odczytasz z DOM bez kliknięcia.
5. **Kolory mają sufiksy** (`-25`, `-50`, `-65`) oznaczające szerokość lameli. Jedynym filtrem jest
   `ENABLE`; jeśli go nie respektujesz, wygenerujesz kombinacje, których formularz nigdy nie pokaże.
6. **`json_parameters_desc` zapisanej pozycji jest niewiarygodne** jako źródło opisu wybranej
   wartości — bywa niezgodne z `json_parameters` tej samej pozycji. Opis czytać ze słownika.

---

## 11. Ręczne sprawdzenie

`http://192.168.0.8:8000/orders/order/<id>/new-position/` — najpierw dział, potem grupa; wtedy
konfigurator wchodzi w ścieżkę `paramdict`/`param`/`prod` tej grupy. Przydatne w konsoli:

```js
window.formValues            // aktualne wartości
window.enabledParams         // co jest aktywne (i podlega walidacji)
window.inputFlags            // poprawność per pole
window.inputsValidators      // MIN/MAX z PROC wybranych wartości
window.finishFlag            // czy obliczenia się zakończyły
document.getElementById('CENA').value   // "Według cennika" = cena wyszła 0
```
