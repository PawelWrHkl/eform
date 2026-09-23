
import { showToast } from "../components/toast.js";
import { loadScript } from './scriptLoader.js';
import { buildValuesToDisplay } from "./updateFieldsAndValues.js";
import { validateFormInput } from "./validateUtils.js";
import { shouldHideRegularPriceRow } from "./createForm.js";
import { formatVatRateLabel } from "./vatLabel.js";
import { getEnvVersion } from "../getEnv.js";

// Specyfikacja ceny (_S) pokazuje się na WSZYSTKICH wersjach poza produkcyjną
// — sama widoczność w podglądzie zamówienia i tak jest zablokowana za `entry.locked`
// (przycisk kłódki w order.njk), to tylko decyduje, czy dane w ogóle powstają.
// ⚠️ `getEnvVersion()` odpytuje `/env` asynchronicznie, więc flaga na starcie
// strony bywa jeszcze `false` — SESSION_STORAGE_KEY cache'uje ostatni wynik per
// karta przeglądarki, żeby KOLEJNE przeliczenia w tej samej sesji nie czekały
// na fetch i nie gubiły wiersza `_S` przy pierwszym, szybkim przeliczeniu.
const SESSION_STORAGE_KEY = 'eform_isNonProdEnv';
let _isNonProdEnv = false;
try {
    _isNonProdEnv = sessionStorage.getItem(SESSION_STORAGE_KEY) === '1';
} catch (_) { /* prywatna karta / storage wyłączony — zostaje false */ }
getEnvVersion().then(v => {
    _isNonProdEnv = !!v && v !== 'Produkcyjna';
    console.log('Wersja środowiska:', v, '| _isNonProdEnv:', _isNonProdEnv);
    try { sessionStorage.setItem(SESSION_STORAGE_KEY, _isNonProdEnv ? '1' : '0'); } catch (_) { /* ignore */ }
});
function formatNumberForDisplay(value) {
    const num = parseFloat(value);

    if (num % 1 === 0) {
        return num.toString();
    }
    return num.toFixed(2);
}

/**
 * Format raw _S script expression into "computed_numbers, (CODES)" form.
 * Outer multiplier is applied to each number and never shown.
 * e.g. "(416(PG3))*1.1"  → "457.6, (PG3)"
 *      "(55(KUHGMBS150)+70(KUHGMBSG250)+49.28(PROWADNICAUS2))*1.1"
 *        → "(60.5 + 77 + 54.21), (KUHGMBS150 + KUHGMBSG250 + PROWADNICAUS2)"
 *      "0.6(VALUE)" → "0.6, (VALUE)"
 */
function formatSpecDisplay(raw) {
    let s = String(raw).trim();

    // Detect outer multiplier: ...)*number at the end
    let multiplier = 1;
    const multMatch = s.match(/\)\s*\*\s*(\d+\.?\d*)\s*$/);
    if (multMatch) {
        multiplier = parseFloat(multMatch[1]);
        // Strip outer (...)*multiplier wrapper
        s = s.replace(/\)\s*\*\s*\d+\.?\d*\s*$/, '').replace(/^\(/, '');
    }

    // Extract number(CODE) tokens with operators
    const tokens = [];
    const regex = /([+\-])?\s*(\d+\.?\d*)\(([A-Za-z0-9_]+)\)/g;
    let match;
    while ((match = regex.exec(s)) !== null) {
        tokens.push({ op: match[1] || '+', num: parseFloat(match[2]), code: match[3] });
    }

    if (tokens.length === 0) return s;

    const fmt = v => parseFloat(v.toFixed(2)).toString();

    // Numeric part: each number × multiplier
    const numStrs = tokens.map((t, i) => {
        const val = fmt(t.num * multiplier);
        return i === 0 ? val : (t.op === '-' ? ' - ' : ' + ') + val;
    });
    // Code part
    const codeStrs = tokens.map((t, i) => {
        return i === 0 ? t.code : (t.op === '-' ? ' - ' : ' + ') + t.code;
    });

    const numPart = tokens.length > 1 ? '(' + numStrs.join('') + ')' : numStrs.join('');
    const codePart = '(' + codeStrs.join('') + ')';
    return numPart + ', ' + codePart;
}


/**
 * Kwota netto pozycji SPRZED rabatu klienta, zapamiętana na czas jednego
 * przeliczenia.
 *
 * ⚠️ Potrzebna, odkąd `applyClientDiscount` obniża `SUB___CENA_KONCOWA`
 * (parametr fakturowy) i idącą za nią `SUB___WARTOSC_KONCOWA`. VAT ma się
 * nadal liczyć od kwoty PRZED rabatem (decyzja właściciela z 2026-08-21), a
 * `applyVatToGrossValue` w grupach bez `SUB___SUMA_BRUTTO` — np. grupa 39 —
 * czyta właśnie `SUB___WARTOSC_KONCOWA`. Bez tego VAT po cichu zmieniłby
 * podstawę.
 *
 * Obie funkcje wołane są po sobie w `updateFieldStates`, więc zmienna żyje
 * dokładnie jedno przeliczenie; `applyVatToGrossValue` ją konsumuje i zeruje.
 */
let netBeforeClientDiscount = null;

/**
 * Czy ostatnie `applyClientDiscount` zdążyło wpisać rabat do `SUB___WARTOSC_KONCOWA`.
 *
 * `form.js getTotal()` bierze `total_sub` z ostatniego wiersza `listsum` — czyli
 * właśnie z `SUB___WARTOSC_KONCOWA`. Gdy rabat już tam siedzi, suma jest gotowa
 * i NIE wolno mnożyć jej drugi raz. Gdy parametru nie ma (np. HKL albo grupa bez
 * cen klienta), rabat trzeba dołożyć mnożnikiem — stąd ta flaga.
 */
let discountAppliedToSubTotal = false;

/** @returns {boolean} patrz `discountAppliedToSubTotal`. */
export function clientDiscountAppliedToSubTotal() {
    return discountAppliedToSubTotal;
}

/**
 * Wstawia wiersz `displayValues` DOKŁADNIE ZA wskazanym parametrem.
 *
 * ⚠️ Kolejność wierszy pozycji to kolejność wkładania do `Map` — a `Map.set`
 * dokłada nowy klucz na KONIEC. Bonus za korzystanie z serwisu ma stać zaraz za
 * rabatem cennikowym `SUB___CENA_RABAT` (decyzja właściciela 2026-09-11), bo to
 * jego rozwinięcie: cennik pokazuje 61%, a wiersz niżej mówi, skąd wziął się
 * ten jeden punkt. Bez przebudowy mapy wiersz lądował na samym końcu listy,
 * za cenami i VAT-em.
 *
 * Gdy kotwicy nie ma (grupa bez rabatu cennikowego), wiersz idzie na koniec —
 * czyli tam, gdzie trafiał dotąd.
 */
function setRowAfter(displayValues, afterKey, key, entry) {
    if (!displayValues.has(afterKey)) {
        displayValues.set(key, entry);
        return;
    }
    // Wiersz może już stać w złym miejscu — np. powstał w cyklu, w którym rabat
    // cennikowy nie miał jeszcze swojego wiersza. Usuwamy go, żeby wstawić na
    // właściwej pozycji; inaczej zła kolejność zostałaby na zawsze.
    displayValues.delete(key);
    const rest = [];
    let seen = false;
    for (const [k, v] of displayValues) {
        if (seen) rest.push([k, v]);
        if (k === afterKey) seen = true;
    }
    for (const [k] of rest) displayValues.delete(k);
    displayValues.set(key, entry);
    for (const [k, v] of rest) displayValues.set(k, v);
}

/** Klucze wierszy rabatu w `displayValues` — z prefiksem SUB___, patrz niżej. */
const CLIENT_DISCOUNT_KEYS = ['SUB___RABAT_KLIENTA'];


/**
 * ⚠️ Rejestracja w `window.subParams` i `window.lockedParams` jest KONIECZNA:
 * `createForm.js hideSub/hideLocked` przy każdym przeliczeniu przepisuje flagi
 * `sub`/`locked` WSZYSTKICH wpisów `displayValues` z tych dwóch list. Bez tego
 * wiersze rabatu traciły `sub: true`/`locked: true` przy najbliższej zmianie
 * pola i (zależnie od momentu zapisu) mogły trafić do bazy jako zwykły,
 * widoczny wiersz obok cen katalogowych.
 */
function registerClientDiscountKeys() {
    if (!Array.isArray(window.subParams)) window.subParams = [];
    if (!Array.isArray(window.lockedParams)) window.lockedParams = [];
    for (const key of CLIENT_DISCOUNT_KEYS) {
        if (!window.subParams.includes(key)) window.subParams.push(key);
        if (!window.lockedParams.includes(key)) window.lockedParams.push(key);
    }
}

/**
 * Rabat klienta grupy (`group_user.discount_percent`, wstrzykiwany jako
 * `window.clientDiscountPercent` — patrz services/groupDiscount.js).
 *
 * ⚠️ **Rabat dotyczy WYŁĄCZNIE cen `SUB___*`** — czyli ceny klienta. Zwykłe
 * (katalogowe) ceny i suma `total`/`total_hidden` zostają nietknięte, bo to nie
 * cena, którą klient płaci.
 *
 * ⚠️ **Żaden WIDOCZNY wiersz ceny nie jest zmieniany** (decyzja właściciela,
 * 2026-08-21): `SUB___SUMA_BRUTTO` i pozostałe sumy pokazują dokładnie to, co
 * policzył silnik — tak samo w formularzu i w podglądzie zamówienia. Wcześniej
 * skalowaliśmy tu wiersze `listsum`, co dawało dwa objawy: cena klienta po
 * zapisie „schodziła" o rabat (choć rabat ma być ukryty), a w podglądzie ta sama
 * kwota pojawiała się dwa razy — raz jako suma, raz jako „wartość po rabacie".
 * Rabat siedzi teraz w ukrytym wierszu `SUB___RABAT_KLIENTA` (sam procent) oraz
 * w kwocie parametru `SUB___CENA_KONCOWA` („CENA NETTO PO RABACIE", niem.
 * „PREIS N. RABATT [€] netto") — a za nią, jako `cena × ilość`, idzie
 * `SUB___WARTOSC_KONCOWA` i `total_sub` liczony w `form.js getTotal()`.
 *
 * ⚠️ **Rabat wchodzi do CENY JEDNOSTKOWEJ `SUB___CENA_KONCOWA`** (od
 * 2026-09-11 — z niej wystawiana jest faktura; systemy zewnętrzne mnożą ją
 * przez ilość), a `SUB___WARTOSC_KONCOWA` idzie za nią jako `cena × ilość`.
 * Formuły w `param.txt` liczą się łańcuchowo z `values` (SUB___CENA →
 * SUB___CENA_SUMA → SUB___CENA_KONCOWA → SUB___WARTOSC_KONCOWA), a
 * `updateFieldStates` przelicza je przy każdej zmianie pola — gdyby rabat
 * nadpisywał WCZEŚNIEJSZE ogniwo (np. `SUB___CENA`), kolejne przeliczenie
 * policzyłoby sumy z już zrabatowanej ceny i rabat naliczałby się wielokrotnie.
 * Te dwa parametry to KONIEC łańcucha (sprawdzone w grupach 39, 73, 43, 71
 * i 02: `SUB___CENA_KONCOWA` czyta wyłącznie formuła `SUB___WARTOSC_KONCOWA`,
 * a tej nie czyta już nic), a obie formuły odtwarzają się od zera przy każdym
 * przeliczeniu — dlatego akurat tam jest to bezpieczne.
 *
 * ⚠️ **Dwa rabaty, dwie różne podstawy** (szczegóły przy samym liczeniu):
 *  • **rabat klienta grupy** liczy się od CENY KATALOGOWEJ `SUB___CENA_SUMA`
 *    i ZASTĘPUJE rabat cennikowy (`katalog × (1 − rabat)`, decyzja
 *    z 2026-08-24),
 *  • **ekstra rabat** (`user.extra_rabat`) liczy się od KWOTY NETTO PO RABACIE
 *    i tylko od niej (decyzja z 2026-09-22) — czyli mnoży wynik powyższego.
 *    Do 2026-09-22 doliczał się jako punkt procentowy do `SUB___CENA_RABAT`
 *    (60% → 61%), przez co liczył się od ceny katalogowej.
 *
 * ⚠️ Rabat NIE wpływa na VAT ani na `WARTOSC_BRUTTO` — te liczą się od
 * nierabatowanego netto, tak jak przed wprowadzeniem rabatu.
 */
export function applyClientDiscount(values, displayValues) {
    // Stan z poprzedniego przeliczenia nie może przeciekać — obie zmienne są
    // modułowe i żyją dokładnie jedno `updateFieldStates`.
    netBeforeClientDiscount = null;
    discountAppliedToSubTotal = false;

    // ⚠️ Rejestracja PRZED wyjściem przy zerowym rabacie: `hideSub`/`hideLocked`
    // przepisują flagi z tych list przy KAŻDYM przeliczeniu, także w cyklach, w
    // których ta funkcja nic nie robi. Rejestracja dopiero po sprawdzeniu `pct`
    // wypuszczała wiersz rabatu z parametrów ukrytych — pozycja 7302 zapisała
    // się z `locked: false, sub: false`, czyli rabat wylądował wśród zwykłych,
    // widocznych wierszy.
    registerClientDiscountKeys();

    const pct = Number(window.clientDiscountPercent) || 0;
    if (!(pct > 0)) {
        // ⚠️ Rabat zszedł do zera, ale wiersz po nim potrafi wciąż siedzieć
        // w ZAPISANEJ pozycji: przy edycji `displayValues` przychodzą z bazy,
        // nie z pustej mapy. Bez tego usunięcia klient, któremu rabat odebrano,
        // widzi go dalej — i zapisuje ponownie przy każdej edycji. Tak właśnie
        // pozycje sprzed 2026-09-22 (np. 7378, klient Neuhausen) pokazywały
        // „1% za korzystanie z serwisu" mimo pustej kolumny `user.extra_rabat`.
        if (displayValues) {
            for (const key of CLIENT_DISCOUNT_KEYS) displayValues.delete(key);
            displayValues.delete('SUB___WARTOSC_PO_RABACIE');
            displayValues.delete('WARTOSC_PO_RABACIE');
        }
        return;
    }
    // Ile z `pct` to ekstra rabat klienta (`user.extra_rabat`; 0, gdy klient nic
    // nie ma wpisane) — wstrzykiwane przez routes/orders.js i routes/positions.js
    // z services/portalUsageDiscount.js.
    const portalBonusPct = Number(window.portalUsageDiscountPercent) || 0;

    // ⚠️ **EKSTRA RABAT MNOŻY KWOTĘ NETTO PO RABACIE** — nie dolicza się już do
    // procentu cennikowego (decyzja właściciela 2026-09-22: „ma liczyć się tylko
    // i wyłącznie od parametru wartość netto po rabacie").
    //
    // Do 2026-09-22 bonus był doliczany WPROST do `SUB___CENA_RABAT` (60% → 61%),
    // czyli liczył się od ceny KATALOGOWEJ. Na pozycji 7381 (katalog 547, rabat
    // cennikowy 60%) dawało to 547 × 0.39 = 213.33, bo 1% od katalogu to 5.47.
    // Teraz podstawą jest kwota po rabacie: 547 × 0.40 = 218.80, a bonus to 1%
    // OD NIEJ (2.19) — należne 216.61.
    //
    // ⚠️ `SUB___CENA_RABAT` zostaje NIETKNIĘTY (60%, nie 61%) — bonus nie jest
    // już częścią cennika, więc nie ma czego podbijać. Znika tym samym cały
    // problem kumulacji bonusu między przeliczeniami.

    // Rabat klienta grupy = to, co zostaje z `pct` po odjęciu ekstra rabatu.
    // Serwer przysyła sumę obu (`resolveCombinedDiscountForOrder`), a składają
    // się inaczej, więc muszą tu zostać rozdzielone.
    const clientPct = Math.max(0, pct - portalBonusPct);

    const ilosc = Math.max(1, parseFloat(values['ILOSC']) || 1);
    const hasKoncowa = values['SUB___WARTOSC_KONCOWA'] !== undefined;
    const hasCenaKoncowa = values['SUB___CENA_KONCOWA'] !== undefined;
    // Podstawa VAT: kwota pozycji PRZED rabatem klienta — ten VAT-u nie rusza
    // (decyzja właściciela 2026-08-21).
    // ⚠️ Od 2026-09-22 jest to też kwota PRZED ekstra rabatem. Dotąd bonus
    // siedział w `SUB___CENA_RABAT`, czyli w cenniku, więc VAT liczył się od
    // kwoty już po nim. Teraz bonus schodzi dopiero po rabacie cennikowym —
    // traktujemy go jak rabat klienta, a ten podstawy VAT nie rusza.
    netBeforeClientDiscount = parseFloat(values['SUB___WARTOSC_KONCOWA']);

    // Cena katalogowa — podstawa rabatu klienta grupy, który ZASTĘPUJE rabat
    // cennikowy. Gdy jej nie ma, zostaje cena po rabacie cennikowym.
    const rawUnitList = parseFloat(values['SUB___CENA_SUMA']);
    const unitListPrice = Number.isFinite(rawUnitList)
        ? rawUnitList
        : parseFloat(values['SUB___CENA_KONCOWA']);

    // Krok 1 — rabat klienta grupy ZASTĘPUJE rabat cennikowy (`katalog × (1 − rabat)`,
    // decyzja z 2026-08-24). Bez niego zostaje cena po rabacie cennikowym, którą
    // policzyła już formuła grupy.
    const unitAfterClientDiscount = clientPct > 0 && Number.isFinite(unitListPrice)
        // Cena nie schodzi poniżej zera, choćby rabat przekroczył 100%.
        ? Math.max(0, unitListPrice * (1 - clientPct / 100))
        : parseFloat(values['SUB___CENA_KONCOWA']);

    // Krok 2 — ekstra rabat zdejmuje swój procent z KWOTY NETTO PO RABACIE.
    // ⚠️ Mnożenie, nie dodawanie punktów procentowych: rabat klienta 15% i bonus
    // 1% dają 100 → 85 → 84.15, a nie 84 (16% od katalogu, jak było do 22.09).
    const unitAfterDiscount = Number.isFinite(unitAfterClientDiscount)
        ? Math.max(0, parseFloat((unitAfterClientDiscount * (1 - portalBonusPct / 100)).toFixed(2)))
        : NaN;
    const positionAfterDiscount = Number.isFinite(unitAfterDiscount)
        ? parseFloat((unitAfterDiscount * ilosc).toFixed(2))
        : NaN;

    if (Number.isFinite(unitAfterDiscount) && hasCenaKoncowa) {
        values['SUB___CENA_KONCOWA'] = unitAfterDiscount;
        const cenaKoncowaInput = document.getElementById('SUB___CENA_KONCOWA');
        if (cenaKoncowaInput) cenaKoncowaInput.value = unitAfterDiscount;
    }

    // Wartość pozycji IDZIE ZA CENĄ JEDNOSTKOWĄ — nie jest osobnym rabatem,
    // tylko tym samym `cena × ilość`, co liczy formuła. Musi zejść razem z nią,
    // bo z tego wiersza (`LISTSUM=true`, ostatni) `form.js getTotal()` bierze
    // `total_sub`, a `services/subPrices.js` — sumę „Razem po rabacie".
    // Zostawienie jej bez rabatu wróciłoby do usterki z 2026-09-10: kafelek
    // pokazywał 113.20, a w bazie było 112.07.
    if (Number.isFinite(positionAfterDiscount) && hasKoncowa) {
        discountAppliedToSubTotal = true;
        values['SUB___WARTOSC_KONCOWA'] = positionAfterDiscount;
        const koncowaInput = document.getElementById('SUB___WARTOSC_KONCOWA');
        if (koncowaInput) koncowaInput.value = positionAfterDiscount;
    }

    // Pola informacyjne w formularzu (form.js → buildClientDiscountFields).
    values['RABAT_KLIENTA'] = pct;
    if (Number.isFinite(positionAfterDiscount)) values['WARTOSC_PO_RABACIE'] = positionAfterDiscount;

    const discountInput = document.getElementById('RABAT_KLIENTA');
    if (discountInput) discountInput.value = `${pct}%`;
    const afterInput = document.getElementById('WARTOSC_PO_RABACIE');
    if (afterInput && Number.isFinite(positionAfterDiscount)) afterInput.value = positionAfterDiscount;

    if (!displayValues) return;

    // ⚠️ NIE ruszamy wierszy `listsum` — widoczne sumy zostają takie, jak je
    // policzył silnik (patrz opis funkcji). Rabat wchodzi do zapisywanej sumy
    // klienta dopiero w `form.js getTotal()`.

    // Wiersze widoczne w podglądzie zamówienia i na dokumencie — ta sama
    // nomenklatura co przy VAT (`sub` dla klienta spoza HKL).
    // ⚠️ Wiersze rabatu zapisujemy pod kluczami `SUB___*`, bo o tym, czy wiersz
    // jest ceną klienta, decyduje po stronie serwera PREFIKS KLUCZA, a nie flaga
    // `sub`: `services/orderService.js` wrzuca do `item.subParamValues` tylko
    // `key.startsWith('SUB___')`. Bez prefiksu rabat wyświetlał się w tabeli
    // razem z cenami katalogowymi. Ten sam zabieg co przy VAT
    // (`SUB___VAT`/`SUB___WARTOSC_VAT`) — identyfikatory pól w formularzu
    // zostają bez prefiksu.
    //
    // ⚠️ `locked: true` — rabat ma być domyślnie UKRYTY i pokazywać się razem z
    // cenami zablokowanymi („złotymi"), czyli po odblokowaniu kłódką
    // (`order.njk`: wiersz SUB renderuje się przy `not entry.locked or prices`).
    // JEDEN wiersz rabatu, ukryty pod kłódką — nigdy dwa. Bonus 1% za
    // korzystanie z serwisu jest już wliczony w `pct` po stronie serwera
    // (services/portalUsageDiscount.js), więc kwota schodzi dokładnie raz;
    // tutaj zmienia się tylko OPIS, żeby było widać, skąd rabat się bierze.
    const existingDiscount = displayValues.get('SUB___RABAT_KLIENTA') || {};
    // ⚠️ Wysokość ekstra rabatu wchodzi do TEKSTU opisu (`{percent}` w kluczu),
    // bo steruje nią właściciel przez `user.extra_rabat` — zaszyte „1%" kłamałoby
    // przy każdej innej wartości. Podstawiamy `portalBonusPct`, nie `pct`:
    // opis dotyczy samego ekstra rabatu, a `pct` niesie sumę z rabatem klienta.
    const portalLabel = t('form.portal_usage_discount_label', { percent: portalBonusPct });
    const discountLabel = portalBonusPct <= 0
        ? t('form.client_discount_label')
        : (pct > portalBonusPct
            // Rabat klienta + ekstra rabat w jednym wierszu.
            ? `${t('form.client_discount_label')} (${portalLabel})`
            // Cały rabat to ekstra rabat.
            : portalLabel);
    setRowAfter(displayValues, 'SUB___CENA_RABAT', 'SUB___RABAT_KLIENTA', {
        // Opis jest wyliczany, nie dziedziczony: `|| existing` zamroziłoby stary
        // tekst przy kolejnym przeliczeniu, gdyby doszedł rabat klienta.
        param_description: discountLabel,
        option_value: `${pct}%`,
        option_description: '',
        locked: true,
        sub: true,
        row: existingDiscount.row || '2'
    });

    // Te same kwoty w wierszach pozycji, w PDF-ie i w sumie zamówienia:
    // podmieniamy WYŁĄCZNIE `option_value` istniejących wierszy.
    // ⚠️ Reszta pól (`listsum`, `locked`, `row`, opis) MUSI zostać nietknięta —
    // to po `listsum` poznaje wiersz sumy `form.js getTotal()` i `subPrices.js`.
    const cenaKoncowaRow = displayValues.get('SUB___CENA_KONCOWA');
    if (Number.isFinite(unitAfterDiscount) && cenaKoncowaRow) {
        cenaKoncowaRow.option_value = String(unitAfterDiscount);
        displayValues.set('SUB___CENA_KONCOWA', cenaKoncowaRow);
    }

    const koncowaRow = displayValues.get('SUB___WARTOSC_KONCOWA');
    if (Number.isFinite(positionAfterDiscount) && koncowaRow) {
        koncowaRow.option_value = String(positionAfterDiscount);
        displayValues.set('SUB___WARTOSC_KONCOWA', koncowaRow);
    }

    // Sprzątanie po poprzednim modelu rabatu (do 2026-09-11 rabat miał WŁASNY
    // wiersz z kwotą). Pozycja zapisana wcześniej wnosi ten wiersz ze sobą przy
    // edycji — zostawiony, zamroziłby starą kwotę obok świeżo policzonej.
    displayValues.delete('SUB___WARTOSC_PO_RABACIE');
    displayValues.delete('WARTOSC_PO_RABACIE');

}

/**
 * Fills the read-only WARTOSC_VAT (VAT amount in currency) and WARTOSC_BRUTTO
 * fields (built by form.js's buildVatFields()) from SUB___SUMA_BRUTTO + the
 * server-computed VAT rate (window.vatRate, see services/vatCalculator.js).
 * Despite its name, SUB___SUMA_BRUTTO is a net value (FORMULA =
 * SUB___CENA_SUMA * ILOSC, no VAT applied) — VAT still needs to be added on
 * top of it.
 * For HKL (window.isHklOrg, org id 3 — SUB___ prices don't apply to it, see
 * services/subPriceContext.js's nonHklOrg check), SUB___* params are never
 * even present in `values`, so the plain SUMA_BRUTTO / WARTOSC_KONCOWA (no
 * SUB___ prefix) is the client's price there instead. Tries the pair matching
 * window.isHklOrg first, then falls back to the other pair (SUB___* undefined
 * for HKL is the norm, not an error — and some non-HKL groups simply don't
 * define SUB___SUMA_BRUTTO/SUB___WARTOSC_KONCOWA in param.txt either), so a
 * wrong/stale isHklOrg detection can't leave the fields stuck at 0.
 *
 * displayValues entries follow the same nomenclature as the other price
 * params: for HKL, VAT/WARTOSC_VAT/WARTOSC_BRUTTO are recorded under their
 * plain names with row '2' (matching CENA/CENA_SUMA/SUMA_BRUTTO/
 * WARTOSC_KONCOWA's own LISTROW). For non-HKL clients they're recorded under
 * SUB___VAT/SUB___WARTOSC_VAT/SUB___WARTOSC_BRUTTO with `sub: true` and row
 * '2', the same shape real SUB___ price params get (see
 * buildValuesToDisplay/hideSub) — so they sit alongside
 * SUB___CENA/SUB___SUMA_BRUTTO rather than the regular price rows.
 *
 * No-op wherever the WARTOSC_BRUTTO field doesn't exist (edit_form.js /
 * admin_edit_form.js don't build it) — never adds stray keys to
 * values/displayValues on those flows.
 */
export function applyVatToGrossValue(values, displayValues) {
    // Master switch (config.js `features.vat` → window.vatEnabled, injected by
    // the templates). Off: no VAT keys in values/displayValues, nothing saved.
    if (!window.vatEnabled) return;

    // ⚠️ TYMCZASOWO: konto podrzędne grupy (`group_user`) nie widzi VAT-u na
    // żadnym etapie, więc nie liczymy go wcale — żaden klucz VAT nie wejdzie do
    // `values`/`displayValues`, a więc i do zapisanej pozycji
    // (form.js buildVatFields też nie tworzy dla niego pól).
    if (window.isGroupShop) return;

    const bruttoInput = document.getElementById('WARTOSC_BRUTTO');
    if (!bruttoInput) return;
    const vatValueInput = document.getElementById('WARTOSC_VAT');

    const isHklOrg = !!window.isHklOrg;
    const keyPairs = isHklOrg
        ? [['SUMA_BRUTTO', 'WARTOSC_KONCOWA'], ['SUB___SUMA_BRUTTO', 'SUB___WARTOSC_KONCOWA']]
        : [['SUB___SUMA_BRUTTO', 'SUB___WARTOSC_KONCOWA'], ['SUMA_BRUTTO', 'WARTOSC_KONCOWA']];

    let netValue = NaN;
    let usedKey = null;
    for (const [sumaBruttoKey, wartoscKoncowaKey] of keyPairs) {
        const hasSumaBrutto = values[sumaBruttoKey] !== undefined;
        const rawNetValue = hasSumaBrutto ? values[sumaBruttoKey] : values[wartoscKoncowaKey];
        netValue = parseFloat(rawNetValue);
        if (Number.isFinite(netValue)) {
            usedKey = hasSumaBrutto ? sumaBruttoKey : wartoscKoncowaKey;
            break;
        }
    }
    if (!Number.isFinite(netValue)) return;

    // ⚠️ Rabat klienta grupy NIE wchodzi do VAT-u ani do `WARTOSC_BRUTTO`
    // (decyzja właściciela): kwota brutto ma zostać taka, jaka była przed
    // wprowadzeniem rabatu, a rabat siedzi w `SUB___WARTOSC_KONCOWA` i w sumie
    // SUB pozycji.
    //
    // ⚠️ Dlatego w grupach BEZ `SUB___SUMA_BRUTTO` (np. 39 — ma tylko
    // `SUB___SUMA_NETTO`) podstawą jest `SUB___WARTOSC_KONCOWA`, a ten parametr
    // niesie już kwotę PO rabacie. Bierzemy wtedy wartość sprzed rabatu,
    // zapamiętaną przez `applyClientDiscount` chwilę wcześniej — inaczej VAT po
    // cichu zmieniłby podstawę razem z rabatem.
    if (usedKey === 'SUB___WARTOSC_KONCOWA' && Number.isFinite(netBeforeClientDiscount)) {
        netValue = netBeforeClientDiscount;
    }

    const vatRate = Number(window.vatRate) || 0;
    const grossValue = parseFloat((netValue * (1 + vatRate / 100)).toFixed(2));
    const vatValue = parseFloat((grossValue - netValue).toFixed(2));

    values['WARTOSC_VAT'] = vatValue;
    values['WARTOSC_BRUTTO'] = grossValue;
    if (vatValueInput) vatValueInput.value = vatValue;
    bruttoInput.value = grossValue;

    if (displayValues) {
        const vatKey = isHklOrg ? 'VAT' : 'SUB___VAT';
        const vatValueKey = isHklOrg ? 'WARTOSC_VAT' : 'SUB___WARTOSC_VAT';
        const bruttoKey = isHklOrg ? 'WARTOSC_BRUTTO' : 'SUB___WARTOSC_BRUTTO';

        const existingVat = displayValues.get(vatKey) || {};
        displayValues.set(vatKey, {
            param_description: existingVat.param_description || t('form.vat_label'),
            option_value: formatVatRateLabel(vatRate),
            option_description: '',
            locked: false,
            sub: !isHklOrg,
            row: existingVat.row || '2'
        });

        const existingVatValue = displayValues.get(vatValueKey) || {};
        displayValues.set(vatValueKey, {
            param_description: existingVatValue.param_description || t('form.wartosc_vat_label'),
            option_value: String(vatValue),
            option_description: '',
            locked: false,
            sub: !isHklOrg,
            row: existingVatValue.row || '2'
        });

        const existingBrutto = displayValues.get(bruttoKey) || {};
        displayValues.set(bruttoKey, {
            param_description: existingBrutto.param_description || t('form.wartosc_brutto_label'),
            option_value: String(grossValue),
            option_description: '',
            locked: false,
            sub: !isHklOrg,
            row: existingBrutto.row || '2'
        });
    }
}

export function checkIfPriceIsCorrect(values, inputs, displayValues) {
    const priceParams = ['CENA', 'CENA_SUMA', 'SUMA_BRUTTO'];
    const destinationParams = ['CENA', 'CENA_SUMA', 'SUMA_BRUTTO', 'DOPLATA', 'CENA_RABAT', 'CENA_RABAT', 'CENA_KONCOWA', 'WARTOSC_KONCOWA', "DOPLATA_EL_RABAT"];
    const wrongValues = ['', 0, null, undefined, NaN];
    const checkParams = ['SZEROKOSC', 'WYSOKOSC'].filter(p => {
        let input = inputs[p];
        if (input !== undefined) {
            let parentDiv = input.parentNode;
            return parentDiv && parentDiv.style.display !== 'none';
        }
        return false;
    });
    const hasValidValues = checkParams.length === 0 || checkParams.every(p => !wrongValues.includes(values[p]));

    // Only consider a price param when the current form actually defines/renders
    // it. SUMA_BRUTTO is a real computed param (FORMULA=CENA_SUMA*ILOSC) in some
    // groups but doesn't exist at all in others (e.g. group 39) — there it's just
    // a leftover legacy key that import payloads always carry as "" (the sender's
    // export always includes it, computed or not). A brand-new position created in
    // the app never sets that key at all (values['SUMA_BRUTTO'] stays undefined,
    // which fails the `== 0` check), but an imported order explicitly sets it to
    // "" (which passes `"" == 0`) — so without this filter, every imported order
    // in a group without SUMA_BRUTTO was unconditionally flagged as "price
    // missing" and had its real, correctly-computed prices replaced by the
    // "Według cennika" placeholder, regardless of whether CENA/DOPLATA were fine.
    // ⚠️ Drugi filtr: parametr WYŁĄCZONY przez `ENABLE` w tej konfiguracji nie
    // jest ceną, która „wyszła zero" — tej ceny po prostu nie ma się skąd wziąć.
    // `applyParamVisibilityFromFormulas` wpisuje taki parametr (ze skryptem
    // cenowym) do `window.skipCountParams`, więc żaden skrypt go nie liczy.
    // Grupa 14 (VERTIKAL) przy `KONFIGURACJA="L"` cenę HKL liczy `CENAPASEK`,
    // a `CENA` jest wyłączona i stoi na 0 — bez tego filtra CAŁY blok cenowy
    // (`CENA_SUMA`, `SUMA_BRUTTO`, `CENA_KONCOWA`, `WARTOSC_KONCOWA`) szedł na
    // „Według cennika" przy poprawnie policzonej cenie.
    const skipped = window.skipCountParams || [];
    const hasZero = priceParams
        .filter(paramName => inputs[paramName] !== undefined && !skipped.includes(paramName))
        .some(paramName => {
            const value = values[paramName];
            return value == '0' || value == 0;
        });

    if (hasValidValues) {
        setTimeout(() => {

            if (hasZero) {
                destinationParams.forEach(paramName => {

                    let displayValue = displayValues.get(paramName);

                    // Wyłączonego pola nie podmieniamy — napis wróciłby też do
                    // jego wiersza (`row: '2'`), który `clearDisabledValues`
                    // dopiero co schował.
                    if (inputs[paramName] && !skipped.includes(paramName)) {
                        inputs[paramName].type = 'text';
                        inputs[paramName].value = t('form.pricelist_info')
                        displayValues.set(paramName, {
                            param_description: displayValue?.param_description ?? '',
                            option_value: t('form.pricelist_info'),
                            option_description: '',
                            locked: displayValue?.locked ?? false,
                            row: '2'
                        });
                    }

                });
            }
        }, 150);
        return displayValues;
    }
}


export function calculateFromScript(param, values, inputs, displayValues, groupNumber, allOptionsByParameter, key, paramName, onComplete) {
    const wrongValues = ['', 0, null, undefined, NaN];
    const checkParams = ['SZEROKOSC', 'WYSOKOSC'].filter(p => {
        let input = inputs[p];
        if (input !== undefined) {
            let parentDiv = input.parentNode;
            return parentDiv && parentDiv.style.display !== 'none';
        }
        return false;
    });
    const hasValidValues = checkParams.length === 0 || checkParams.every(p => !wrongValues.includes(values[p]));
    if (hasValidValues && !(window.skipCountParams.includes(param.NAME))) {
        try {
            console.log('Przygotowywanie wartości dla skryptu:', values);

            loadScript(param.SOURCE, values, displayValues, groupNumber, allOptionsByParameter, param, function (scriptResult) {
                
                if (scriptResult) {
                    for (const [scriptParamName, scriptValue] of Object.entries(scriptResult)) {
                        console.log('Ustawiamy wartość ze SCRIPT u:', scriptParamName, scriptValue);

                        // ZAWSZE aktualizuj values — nawet dla parametrów bez własnego inputa.
                        // Bez tego computed values (np. MARSZCZPROC obliczane ze skryptu jako side-effect)
                        // pozostają w starym stanie i kolejne formuły używają nieaktualnych wartości.
                        values[scriptParamName] = scriptValue;

                        // If param ends with _S and no input exists, create a hidden clone from the parent param
                        const isNewSuffix = _isNonProdEnv && !inputs[scriptParamName] && scriptParamName.endsWith('_S');
                        if (isNewSuffix) {
                            const parentName = scriptParamName.slice(0, -2);
                            const parentInput = inputs[parentName];
                            if (parentInput) {
                                const clone = parentInput.cloneNode(true);
                                clone.id = scriptParamName;
                                clone.name = scriptParamName;
                                clone.style.display = 'none';
                                parentInput.parentNode.appendChild(clone);
                                inputs[scriptParamName] = clone;
                            }
                        }

                        if (inputs && inputs[scriptParamName]) {
                            let strVal;
                            if (param.FORMAT == 'n%' && !isNewSuffix) {
                                const numericValue = parseFloat(scriptValue);
                                strVal = `${parseInt(numericValue * 100)}%`;
                                inputs[scriptParamName].value = numericValue;
                            } else if (isNewSuffix) {
                                strVal = formatSpecDisplay(scriptValue);
                                inputs[scriptParamName].value = scriptValue;
                            } else {
                                strVal = String(scriptValue);
                                inputs[scriptParamName].value = scriptValue;
                            }

                            const subVariantName = 'SUB___' + scriptParamName;
                            const priceParam = window.params?.find(p => p.NAME === scriptParamName);
                            const isRowTwo = priceParam && (priceParam.LISTROW == '2' || priceParam.LISTSUM == 'true');
                            const hideRegular = shouldHideRegularPriceRow(isRowTwo);

                            const applyPriceToInput = (name) => {
                                if (name === scriptParamName) {
                                    buildValuesToDisplay(allOptionsByParameter, strVal, scriptParamName, displayValues, 'INPUT', true);
                                    return;
                                }
                                if (inputs[name] && !scriptParamName.startsWith('SUB___')) {
                                    inputs[name].value = scriptValue;
                                    values[name] = scriptValue;
                                    buildValuesToDisplay(allOptionsByParameter, strVal, name, displayValues, 'INPUT', true);
                                }
                            };

                            if (hideRegular && inputs[subVariantName]) {
                                applyPriceToInput(subVariantName);
                                applyPriceToInput(scriptParamName);
                            } else {
                                applyPriceToInput(scriptParamName);
                                applyPriceToInput(subVariantName);
                            }

                            // For auto-created _S params, set description from parent with -spec suffix
                            if (isNewSuffix) {
                                const parentName = scriptParamName.slice(0, -2);
                                const parentDisplay = displayValues.get(parentName);
                                const entry = displayValues.get(scriptParamName);
                                if (entry) {
                                    entry.param_description = (parentDisplay?.param_description || parentName) + '-spec';
                                    entry.row = '2';
                                    entry.locked = true;
                                    displayValues.set(scriptParamName, entry);
                                }
                                // Also register in global lockedParams so template recognizes it
                                if (window.lockedParams && !window.lockedParams.includes(scriptParamName)) {
                                    window.lockedParams = [...new Set([...window.lockedParams, scriptParamName])];
                                }
                            }

                            console.log('Ustawiamy display', displayValues);
                        }
                    }
                }

                
                if (onComplete && typeof onComplete === 'function') {
                    onComplete();
                }
            });
        } catch (error) {

            if (inputs[param.NAME]) {
                inputs[param.NAME].value = '0';
            }
            values[param.NAME] = 0;

            
            if (onComplete && typeof onComplete === 'function') {
                onComplete();
            }
        }
    } else {
        if (inputs[param.NAME]) {
            inputs[param.NAME].value = '0';
        }
        values[param.NAME] = 0;

        
        if (onComplete && typeof onComplete === 'function') {
            onComplete();

        }
    }
    return paramName;
}


export function calculateFromFormula(param, values, inputs, displayValues, groupNumber, allOptionsByParameter, key, paramName) {
    if (param.FORMULA.includes('RABAT')) {
    }
    try {
        let result = window.FormulaHandler.evaluateFormula(
            param.FORMULA,
            values,
            "formula");
        console.log('Wynik formuły:', result, 'dla parametru', param.NAME, 'z formułą', param.FORMULA);
        if (result === false || result === null || result < 0) {

            if (inputs[param.NAME]) {
                inputs[param.NAME].value = '0';
            }
            values[param.NAME] = 0;
        } else {
            
            result = parseFloat(result);
            
            if (inputs[param.NAME]) {
                inputs[param.NAME].value = formatNumberForDisplay(result);
                
            }
            values[param.NAME] = parseFloat(result?.toFixed(2)) ?? 0;
            buildValuesToDisplay(allOptionsByParameter, formatNumberForDisplay(result), param.NAME, displayValues, 'INPUT ');
        }

        if (inputs[param.NAME]) {
            validateFormInput(values, inputs[param.NAME]);
        }
    } catch (error) {
        console.error('Błąd podczas obliczania formuły:', error);
        showToast('error', `Parametr: ${param.VALUE}. ${error.message}`);
    }

    return paramName;
}



