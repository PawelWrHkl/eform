# Funkcje dodatkowe pól — kolumna `EXTRAFUNC`

Moduł frontendu formularza: `public/scripts/formTools/extraFunctions/`.
Dokument leży w `docs/`, bo `public/` jest serwowany statycznie.
Kolumna `EXTRAFUNC` w `param.txt` to **uniwersalny parametr**: wpisuje się do
niej nazwy funkcji dodatkowych pola. Każda funkcja wpisana tam teraz lub w
przyszłości jest deklarowana w tym module. Rdzeń formularza (`form.js`,
`validateUtils.js`) nie zmienia się przy dokładaniu nowych funkcji.

Pierwsze użycie: grupa 43, parametr `DLSZNUR` („WYDŁUŻONE SZNURKI STERUJĄCE”),
`EXTRAFUNC=popup-input`, słownik `N`/NIE i `Y`/TAK (datatest, wersja 0.3.762).

---

## Składnia komórki `EXTRAFUNC`

```
popup-input
popup-input(unit=cm|min=10|max=500)
popup-input(label=Długość sznurka|info=Mierzone od dołu, z zapasem), inna-funkcja
```

- Kilka funkcji rozdziela się przecinkiem.
- Opcje podaje się w nawiasie jako `klucz=wartość`, rozdzielone `|`. To ta sama para separatorów co w `<PARAM>_ATTRS` z paramdict.
- Przecinek wewnątrz nawiasu należy do wartości opcji.
- Znak `|` nie może wystąpić w wartości.
- `<NULL>`, pusta komórka i brak kolumny (starsze wersje reguł) dają brak funkcji.
- Nieznana nazwa funkcji to tylko `console.warn`. Formularz działa dalej, więc `param.txt` może wyprzedzać kod.

Parsowanie odbywa się raz, w `DataLoader.parseData()`. Wynik trafia do `param.EXTRAFUNCS = [{ name, options }]`.

---

## Architektura

| Plik | Odpowiedzialność |
|---|---|
| `index.js` | Fasada i rejestracja wbudowanych funkcji. `ExtraFunctionsController` wiąże parametry z funkcjami dla **jednego** zbudowanego formularza. |
| `registry.js` | `ExtraFunctionRegistry`: nazwa → fabryka. |
| `parseExtraFunc.js` | Parser komórki `EXTRAFUNC` (czysta funkcja). |
| `extraValue.js` | Konwencja klucza `<PARAM>___EXTRA` (moduł-liść, bez importów). |
| `popupInput/popupInput.js` | Funkcja `popup-input`: zachowanie, uzgadnianie stanu, walidacja. |
| `popupInput/popupInputDialog.js` | Widok: okno TAK/NIE + liczba całkowita. Zwraca `Promise`, nie zna formularza. |
| `popupInput/integerValue.js` | Parsowanie i walidacja liczby całkowitej (czyste funkcje). |
| `public/styles/extra-functions.css` | Style; wyłącznie tokeny z `theme.css` (tryb ciemny i wariant B działają same). Ładowany w `base.njk`. |

### Punkty styku z rdzeniem (jedyne)

1. `dataLoader.js` — `parseData()`: `param.EXTRAFUNCS = parseExtraFuncCell(param.EXTRAFUNC)`.
2. `form.js` — `generateForm()`: wywołuje `activateExtraFunctions(params, { requestUpdate }).mount(...)` **po** słuchaczach `change` formularza.
3. `form.js` — `updateProcedure()`: wywołuje `syncExtraFunctions(...)` tuż przed `generateShortJson` (po resecie zależności).
4. `validateUtils.js` — `validateAllFieldsOnSubmit()`: `validateExtraFunctions({ values })` daje `inputFlags[param] = false` i etykietę błędu.
5. `validateUtils.js` — `clearDisabledValues()`: klucz `<PARAM>___EXTRA` dzieli los parametru tak jak `___DESCRIPTION`.

### Kontrakt funkcji (nowa funkcja = nowy plik + jedna linia `register`)

Fabryka dostaje `{ param, options, requestUpdate }` i zwraca obiekt. Wszystkie metody są opcjonalne:

```js
{
  mount({ input, values, displayValues, allOptionsByParameter }),
  sync({ values, displayValues, allOptionsByParameter }),
  validate({ values }),
}
```

- **`mount`** wykonuje się raz, po zbudowaniu pola. Tylko przeglądarka i DOM.
- **`sync`** wykonuje się na końcu **każdego** `updateProcedure`. Doprowadza `values`/`displayValues` do spójnego stanu i **musi działać bez DOM-u**. Ten sam kod liczy pozycje po stronie serwera (`services/formEngine`, JSDOM, bez interakcji).
- **`validate`** zwraca komunikat błędu albo `null`.
- **`requestUpdate(paramName)`** odpala przeliczenie formularza po zmianie parametru.

Rejestracja w `index.js`:

```js
export const extraFunctionRegistry = new ExtraFunctionRegistry()
    .register(POPUP_INPUT, createPopupInput)
    .register(NOWA_FUNKCJA, createNowaFunkcja);
```

**Zasada:** stan uzgadniamy w `sync`, nie łatamy go w miejscach, które zmieniają wartość. Przez ten sam punkt przechodzą:
- reset zależności (`DEPENDENCES`),
- wyłączenie przez `ENABLE`,
- „wczytaj ostatnią konfigurację”, kopiowanie linii, edycja,
- przeliczenie serwerowe.

---

## `popup-input`

Parametr słownikowy TAK/NIE, który po TAK wymaga liczby całkowitej.

**UX**

- Pole w formularzu to **przycisk** (klasa `button`, wygląd jak pola z oknem wyboru). Pokazuje:
  - „Wybierz”, gdy nic nie wybrano,
  - „NIE”,
  - „TAK: 120 cm”,
  - „TAK — podaj wartość” z przerywaną ramką, gdy brakuje liczby.
- Klik otwiera okno z dwiema kartami TAK / NIE:
  - **NIE** od razu zamyka okno i ustawia wartość NIE (bez liczby).
  - **TAK** odsłania w oknie pole liczby, stepper −/+ i „Zatwierdź”.
  - **Anuluj, ✕ i Esc** niczego nie zmieniają.
- Przy zapisanym TAK okno otwiera się od razu z odsłoniętym polem i wpisaną liczbą.
- Pole liczby ma `type="text"` + `inputmode="numeric"` (klawiatura numeryczna na telefonie), a nie `type="number"`, bo ten przyjmuje „e”, zmienia wartość kółkiem i po cichu oddaje `""` dla „12,5”. Na wejściu wycinane jest wszystko poza cyframi.
- Walidacja włącza się na żywo dopiero po pierwszej próbie zatwierdzenia (`aria-live`, `aria-invalid`). Niepoprawna liczba nie zamyka okna.
- Okno to natywny `<dialog>` z `showModal()`: pułapka fokusu, tło `inert`, Esc i powrót fokusu.
- Na telefonie (≤ 576 px) okno jest arkuszem od dołu ekranu z przyciskami w zasięgu kciuka. Animacje respektują `prefers-reduced-motion`.

**Mechanika**

- Lista `<select>` z `createForm.js` zostaje w DOM-ie ukryta (`xf-native-hidden`) i dalej niesie wartość dla rdzenia: zapis, `fillFields`, `resetSelectValues`, walidację.
- Wybór z okna ustawia listę i wysyła jej `change`. To ta sama ścieżka co zwykły wybór (`form.js` → `updateProcedure`).
- Błąd walidacji rdzenia (`invalid-input` na liście) przenosi na przycisk `MutationObserver`.

**Zapis liczby — w dwóch miejscach, bo czytają je różni odbiorcy**

| Gdzie | Co | Kto czyta |
|---|---|---|
| `values["<PARAM>___EXTRA"]` → `json_parameters` | `120` (number) | Plik JSON dla fabryki: `services/sendOrderService.js` wysyła **wszystkie** klucze `json_parameters`. |
| `displayValues.get(PARAM).option_description` → `json_parameters_desc` | `"TAK: 120 cm"` | Widok zlecenia, Excel, PDF-y, maile, PDF produkcyjny (`services/orderService.js` → `jsonTextBackToMap`). |

- Opis nie zawiera „ - ”, bo PDF dzieli komórkę na pierwszym „ - ” (`utils/pdfValueParts.js`).
- Sufiks `___` jest celowy. Importer zleceń, tester konfiguratora i `stubDisplayEntries` w formEngine pomijają takie klucze jako metadane.
- `parameters_short` (shortJson) liczby **nie** zawiera, bo obejmuje tylko nazwy parametrów.
- Przy NIE, przy pustej wartości i przy wyłączeniu parametru klucz `___EXTRA` jest usuwany.
- Liczba zapisana jako tekst („120” z `localStorage` lub importu) jest akceptowana.

**Opcje**

| Opcja | Domyślnie | Znaczenie |
|---|---|---|
| `trigger` | `Y` | Wartość słownika oznaczająca TAK. |
| `no` | pierwsza inna wartość słownika | Wartość ustawiana przez NIE. |
| `min` / `max` | `1` / brak | Zakres liczby całkowitej. |
| `step` | `1` | Krok przycisków −/+. |
| `unit` | brak | Jednostka (pole, przycisk, opis „TAK: 120 cm”). |
| `label` | „Podaj wartość” | Etykieta pola liczby. |
| `info` | brak | Tekst informacyjny w oknie (pod polem liczby). |

Etykiety TAK/NIE pochodzą z opisów słownika (z aliasem klienta, jeśli jest). INFO wartości TAK (`DLSZNUR_INFO` w paramdict, także plik `<karta.pdf>`) pokazuje się w oknie przez `createInfoIcon`.

---

## Tłumaczenia

Wszystkie teksty idą przez `t()` z języków Efora (`/mnt/eform/languages/jezyki.xlsx` → JSON-y; arkusz jest źródłem i nadpisuje JSON-y przy logowaniu). Klucze `form.popup_input.*` (pl/en/de/fr/nl) dodano 2026-10-26 za blokiem `form.*`:

`prompt`, `close`, `decrease`, `increase`, `cancel`, `confirm`, `hint_int`, `range`, `range_min`, `range_max`, `err_empty`, `err_int`, `err_min`, `err_max`, `missing`, `required`, `info_label`, `download`

Używane są też istniejące klucze `form.check_word` („Wybierz”) i `form.check_option` („Wybierz opcję”).

Nowy tekst dodajesz do arkusza **i** do JSON-ów, zanim użyjesz go w kodzie.

---

## Pułapki

- **Cykl importów.** `index.js → popupInput → toast.js → formTools.js → validateUtils.js → index.js`. Żaden moduł z tego cyklu nie może czytać importowanego wiązania **na poziomie modułu**: natywny ESM rzuci TDZ `ReferenceError` i formularz się nie zbuduje. Dlatego `validateUtils.js` bierze `EXTRA_SUFFIX` z liścia `extraValue.js` i używa go dopiero wewnątrz funkcji.
- **Kolejność słuchaczy.** `mount` musi być wołany po słuchaczach `change` z `form.js`.
- **Wiele formularzy na stronie** („wczytaj ostatnią konfigurację”). `activateExtraFunctions` tworzy nowy kontroler, a poprzedni przestaje być aktywny.
- **Import zleceń (`services/orderImport`) nie zna `___EXTRA`.** Zlecenie zaimportowane z TAK nie ma liczby, dopóki ktoś nie uzupełni jej w edycji (walidacja zapisu to wymusi).

## Testy

`services/__tests__/extraFunctions.test.js`: parser, liczby, `sync` bez DOM, `clearDisabledValues`, walidacja i okno w JSDOM.

```
ROOT_DIR=/tmp/eform-test NODE_ENV=test node --test --test-force-exit services/__tests__/extraFunctions.test.js
```
