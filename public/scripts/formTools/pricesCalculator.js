
import { showToast } from "../components/toast.js";
import { loadScript } from './scriptLoader.js';
import { buildValuesToDisplay } from "./updateFieldsAndValues.js";
import { validateFormInput } from "./validateUtils.js";
import { shouldHideRegularPriceRow } from "./createForm.js";
import { formatVatRateLabel, vatUsesClientPrice } from "./vatLabel.js";
import { savedLabelWithCurrency, withCurrencyLabel } from "./currencyLabel.js";

/**
 * Czy tworzyć specyfikację ceny (`<PARAM>_S`) — przełącznik `PRICE_SPEC_ENABLED`
 * z `.env` (config.js `features.priceSpec`), wstawiany przez `base.njk` jako
 * `window.priceSpecEnabled`, a w silniku JSDOM przez `jsdomEnv.js`.
 * Wyłączona: `_S` nie tworzy pola ani wiersza, a wiersz zapisany wcześniej
 * znika przy przeliczeniu. Zapisane pozycje chowa po stronie serwera
 * `services/orderService.js dropPriceSpecRows`.
 *
 * Do 2026-10-08 warunkiem było „wersja z `/env` ≠ Produkcyjna", pobierane
 * asynchronicznie (z cache'em w sessionStorage na wyścig z pierwszym
 * przeliczeniem). Flaga z szablonu jest gotowa przed startem modułów.
 */
function isPriceSpecEnabled() {
    return window.priceSpecEnabled === true;
}

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
function formatSpecDisplay(raw, digits = 2) {
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

    const fmt = v => parseFloat(v.toFixed(digits)).toString();

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

/**
 * Klucze wierszy rabatu w `displayValues` — z prefiksem SUB___, patrz niżej.
 * Od 2026-10-27 także rozbicie ceny po rabacie klienta grupy
 * (`clientDiscountBreakdown`): cena po rabacie, rabat na dopłatę, dopłata po rabacie.
 */
const CLIENT_DISCOUNT_KEYS = ['SUB___RABAT_KLIENTA', 'SUB___CENA_PO_RABACIE', 'SUB___RABAT_DOPLATY', 'SUB___DOPLATA_PO_RABACIE'];

/**
 * Rabat klienta grupy rozłożony na składniki ceny (decyzja właściciela
 * 2026-10-27 — schemat wierszy pod kłódką konta podrzędnego):
 *   cena po rabacie    = cena katalogowa × (1 − rabat klienta),
 *   dopłata po rabacie = dopłaty `SUB___` × (1 − rabat na dopłatę z konfiguratora),
 *   wartość 1 szt.     = cena po rabacie + dopłata po rabacie (→ `SUB___CENA_KONCOWA`).
 *
 * Rabat klienta ZASTĘPUJE rabat cennikowy (`SUB___CENA_RABAT`) WYŁĄCZNIE na
 * cenie katalogowej. Do 2026-10-27 schodził z całego `SUB___CENA_SUMA` — razem
 * z dopłatami, z pominięciem ich rabatów z konfiguratora (pozycja 8974: 50% od
 * 369.94 = 184.97 zamiast 141.60 + 60.72 = 202.32). Dopłaty liczą się dokładnie
 * jak w formule `SUB___CENA_KONCOWA` grupy w `param.txt`:
 *  • `SUB___DOPLATA` × (1 − `SUB___DOPLATA_RABAT`) tam, gdzie grupa ma osobny
 *    rabat na dopłatę („RABAT DODATKOWY”, dziś grupa 71 — klucz jest wtedy
 *    w `values`); w pozostałych grupach dopłata stoi w nawiasie z ceną:
 *    `(SUB___CENA+SUB___DOPLATA)*(1-SUB___CENA_RABAT)`, więc × (1 − `SUB___CENA_RABAT`),
 *  • `SUB___DOPLATA_EL` × (1 − `SUB___DOPLATA_EL_RABAT`) („RABAT EL”).
 * Cena katalogowa = `SUB___CENA_SUMA` bez dopłat — w każdej grupie
 * `SUB___CENA_SUMA` to cena bazowa (także pasek w 14, tkanina w 46) + dopłaty.
 *
 * Składniki zaokrąglone do groszy, a wartość sztuki to ICH suma — wiersze pod
 * kłódką muszą się zgadzać co do grosza.
 *
 * @param {Record<string, any>} values
 * @param {number} clientPct  rabat klienta grupy w procentach (bez ekstra rabatu)
 * @returns {{ catalogPrice: number, priceAfter: number, surchargeBefore: number, surchargeAfter: number, surchargeRatePct: number|null, unitAfterClientDiscount: number }|null}
 *   `null`, gdy pozycja nie ma ceny katalogowej `SUB___CENA_SUMA`;
 *   `surchargeRatePct` — rabat na dopłatę `SUB___DOPLATA` w procentach (`null`
 *   bez dopłaty). Rabat dopłaty EL nie wchodzi tutaj: pod kłódką pokazuje się
 *   jego własny parametr `SUB___DOPLATA_EL_RABAT` („RABAT EL”).
 */
export function clientDiscountBreakdown(values, clientPct) {
    const listTotal = parseFloat(values['SUB___CENA_SUMA']);
    if (!Number.isFinite(listTotal)) return null;
    const amount = (key) => {
        const v = parseFloat(values[key]);
        return Number.isFinite(v) ? v : 0;
    };
    const round2 = (v) => parseFloat(v.toFixed(2));

    const doplata = amount('SUB___DOPLATA');
    const doplataEl = amount('SUB___DOPLATA_EL');
    const doplataRate = 'SUB___DOPLATA_RABAT' in values ? amount('SUB___DOPLATA_RABAT') : amount('SUB___CENA_RABAT');
    const doplataElRate = amount('SUB___DOPLATA_EL_RABAT');

    const catalogPrice = Math.max(0, listTotal - doplata - doplataEl);
    // Cena nie schodzi poniżej zera, choćby rabat przekroczył 100%.
    const priceAfter = round2(Math.max(0, catalogPrice * (1 - clientPct / 100)));
    const surchargeBefore = round2(doplata + doplataEl);
    const surchargeAfter = round2(Math.max(0, doplata * (1 - doplataRate) + doplataEl * (1 - doplataElRate)));
    const surchargeRatePct = doplata > 0 ? round2(doplataRate * 100) : null;

    return {
        catalogPrice,
        priceAfter,
        surchargeBefore,
        surchargeAfter,
        surchargeRatePct,
        unitAfterClientDiscount: round2(priceAfter + surchargeAfter)
    };
}



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
 * Parametry pozycji liczone jako `<cena jednostkowa> × ILOSC` (tak w każdej
 * grupie z `param.txt`). W trybie narzutu wartość pozycji idzie za ceną
 * jednostkową PO narzucie, a nie jest osobno mnożona — inaczej przy większej
 * ilości rozjeżdżałaby się o grosze z fakturą, która mnoży cenę jednostkową
 * `SUB___CENA_KONCOWA` przez ilość.
 */
const MARKUP_POSITION_FROM_UNIT = {
    WARTOSC_KONCOWA: 'CENA_KONCOWA',
    SUMA_BRUTTO: 'CENA_SUMA',
    SUMA_NETTO: 'CENA_SUMA'
};

/**
 * Narzut klienta grupy (`user.group_price_mode = 'markup'`, ustawia admin;
 * wysokość `group_user.markup_percent` — patrz services/groupPriceMode.js).
 *
 * Klient grupy rozliczanej narzutem płaci CENĘ ZWYKŁĄ (cenę zakupu grupy-matki)
 * powiększoną o narzut — a nie cenę detaliczną `SUB___` z rabatem. Ceną klienta
 * jest jednak w całej aplikacji łańcuch `SUB___*` (podgląd zamówienia, sumy, PDF,
 * mail, faktura, eksport), więc zamiast budować drugą warstwę cen przepisujemy
 * do niego ceny zwykłe: każdy `SUB___X` dostaje wartość swojego bliźniaka `X`
 * (każdy parametr `SUB___` w `param.txt` ma bliźniaka o tej samej budowie):
 *  • kwoty — `X × (1 + narzut)`,
 *  • rabaty cennikowe (`*_RABAT`) — bez zmian, bo to procent, nie kwota.
 * Arytmetyka łańcucha się zgadza: `(CENA×f + DOPLATA×f) × (1 − RABAT)` = `CENA_KONCOWA × f`.
 *
 * ⚠️ Wynik jest czystą funkcją cen ZWYKŁYCH, których ta funkcja nie dotyka —
 * dlatego jest idempotentna przy każdym przeliczeniu, nawet gdy silnik w danym
 * cyklu nie odświeżył któregoś `SUB___` (stara wartość i tak zostaje nadpisana).
 *
 * ⚠️ Narzut 0% to nadal tryb narzutu: klient widzi wtedy dokładnie ceny zwykłe.
 * Wyłącznikiem jest tryb (`window.clientPriceMode`), nie wysokość narzutu.
 *
 * ⚠️ Wiersze cen zwykłych zostają nietknięte — to cena zakupu grupy-matki;
 * kontu podrzędnemu i tak się nie pokazują (`shouldHideRegularPriceRow`,
 * `templates/order.njk`).
 */
export function applyClientMarkup(values, displayValues) {
    if (window.clientPriceMode !== 'markup' || !values) return false;
    const markup = Math.max(0, Number(window.clientMarkupPercent) || 0);
    const factor = 1 + markup / 100;
    const ilosc = Math.max(1, parseFloat(values['ILOSC']) || 1);

    const subKeys = Object.keys(values).filter((key) =>
        key.startsWith('SUB___') && !key.endsWith('_S'));

    const setSub = (key, value, displayText) => {
        values[key] = value;
        const input = document.getElementById(key);
        if (input) input.value = displayText;
        const row = displayValues && displayValues.get(key);
        if (row) {
            // Tylko `option_value` — `listsum`/`locked`/`sub`/`row`/opis muszą zostać,
            // po nich `form.js getTotal()` i `services/subPrices.js` poznają sumy.
            row.option_value = displayText;
            displayValues.set(key, row);
        }
    };

    // Najpierw ceny jednostkowe i rabaty, potem wartości pozycji (`× ILOSC`),
    // bo te liczą się z już przeliczonych cen jednostkowych.
    const positionKeys = [];
    for (const key of subKeys) {
        const base = key.slice('SUB___'.length);
        if (MARKUP_POSITION_FROM_UNIT[base]) {
            positionKeys.push(key);
            continue;
        }
        if (values[base] === undefined || values[base] === null || values[base] === '') {
            // Bliźniak wyłączony albo nieobecny — nie zostawiamy w widoku klienta
            // ceny detalicznej, której w tym trybie nie ma prawa zobaczyć.
            if (displayValues) displayValues.delete(key);
            continue;
        }
        if (base.includes('RABAT')) {
            const baseRow = displayValues && displayValues.get(base);
            const baseInput = document.getElementById(base);
            const text = baseRow?.option_value ?? baseInput?.value ?? String(values[base]);
            setSub(key, values[base], text);
            continue;
        }
        const num = parseFloat(values[base]);
        if (!Number.isFinite(num)) continue;
        const marked = parseFloat((num * factor).toFixed(2));
        setSub(key, marked, formatNumberForDisplay(marked));
    }

    // Specyfikacja ceny detalicznej (`SUB___*_S`, tylko przy `PRICE_SPEC_ENABLED=true`) rozpisuje
    // kody cennika DETALICZNEGO — w tym trybie to nie jest cena klienta, a po
    // kłódce klient by ją zobaczył. Specyfikacja ceny zwykłej (`*_S`) zostaje.
    if (displayValues) {
        for (const key of [...displayValues.keys()]) {
            if (key.startsWith('SUB___') && key.endsWith('_S')) displayValues.delete(key);
        }
    }

    for (const key of positionKeys) {
        const base = key.slice('SUB___'.length);
        const unit = parseFloat(values['SUB___' + MARKUP_POSITION_FROM_UNIT[base]]);
        const own = parseFloat(values[base]);
        const marked = Number.isFinite(unit)
            ? parseFloat((unit * ilosc).toFixed(2))
            : (Number.isFinite(own) ? parseFloat((own * factor).toFixed(2)) : NaN);
        if (!Number.isFinite(marked)) {
            if (displayValues) displayValues.delete(key);
            continue;
        }
        setSub(key, marked, formatNumberForDisplay(marked));
    }

    return true;
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
 *  • **rabat klienta grupy** liczy się od CENY KATALOGOWEJ (`SUB___CENA_SUMA`
 *    bez dopłat) i ZASTĘPUJE rabat cennikowy (`katalog × (1 − rabat)`, decyzja
 *    z 2026-08-24); dopłaty dostają swój rabat z konfiguratora (2026-10-27,
 *    `clientDiscountBreakdown`),
 *  • **ekstra rabat** (`user.extra_rabat`) liczy się od KWOTY NETTO PO RABACIE
 *    i tylko od niej (decyzja z 2026-09-22) — czyli mnoży wynik powyższego.
 *    Do 2026-09-22 doliczał się jako punkt procentowy do `SUB___CENA_RABAT`
 *    (60% → 61%), przez co liczył się od ceny katalogowej.
 *
 * ⚠️ Od 2026-10-26 rabat WCHODZI do VAT-u: `applyVatToGrossValue` liczy go od
 * `SUB___WARTOSC_KONCOWA` po rabacie (do tej daty — od kwoty sprzed rabatu).
 */
export function applyClientDiscount(values, displayValues) {
    // Stan z poprzedniego przeliczenia nie może przeciekać — zmienna jest
    // modułowa i żyje dokładnie jedno `updateFieldStates`.
    discountAppliedToSubTotal = false;

    // ⚠️ Rejestracja PRZED wyjściem przy zerowym rabacie: `hideSub`/`hideLocked`
    // przepisują flagi z tych list przy KAŻDYM przeliczeniu, także w cyklach, w
    // których ta funkcja nic nie robi. Rejestracja dopiero po sprawdzeniu `pct`
    // wypuszczała wiersz rabatu z parametrów ukrytych — pozycja 7302 zapisała
    // się z `locked: false, sub: false`, czyli rabat wylądował wśród zwykłych,
    // widocznych wierszy.
    registerClientDiscountKeys();

    // Grupa rozliczana narzutem: łańcuch `SUB___` dostaje ceny zwykłe + narzut,
    // ZANIM cokolwiek niżej go przeczyta. Rabatu klienta grupy wtedy nie ma
    // (serwer przysyła 0), ale ewentualny ekstra rabat (`user.extra_rabat`)
    // schodzi już z ceny PO narzucie — dokładnie tak, jak schodzi z ceny po
    // rabacie w trybie rabatowym.
    applyClientMarkup(values, displayValues);

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

    // Krok 1 — rabat klienta grupy ZASTĘPUJE rabat cennikowy na CENIE KATALOGOWEJ
    // (decyzja z 2026-08-24), a dopłaty dostają swój rabat z konfiguratora
    // (2026-10-27) — `clientDiscountBreakdown`. Bez rabatu klienta (sam ekstra
    // rabat) zostaje cena po rabatach cennikowych, którą policzyła już formuła
    // grupy. Pozycja bez ceny katalogowej: rabat od ceny po rabacie cennikowym.
    const breakdown = clientPct > 0 ? clientDiscountBreakdown(values, clientPct) : null;
    const cenaKoncowaCennikowa = parseFloat(values['SUB___CENA_KONCOWA']);
    const unitAfterClientDiscount = breakdown
        ? breakdown.unitAfterClientDiscount
        : (clientPct > 0 && Number.isFinite(cenaKoncowaCennikowa)
            ? Math.max(0, cenaKoncowaCennikowa * (1 - clientPct / 100))
            : cenaKoncowaCennikowa);

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

    // Rozbicie ceny po rabacie (decyzja właściciela 2026-10-27) — ukryte jak sam
    // rabat, pokazywane pod kłódką w tej kolejności (services/subPrices.js
    // attachGroupGoldValues): cena po rabacie, rabat na dopłatę (dopłata
    // `SUB___DOPLATA`), RABAT EL (własny parametr cennika `SUB___DOPLATA_EL_RABAT`,
    // nie tworzony tutaj), dopłata po rabacie (obie dopłaty), potem wartość 1 szt.
    // (`SUB___CENA_KONCOWA`) i × ilość (`SUB___WARTOSC_KONCOWA`).
    const hiddenRow = (param_description, option_value) => ({
        param_description, option_value, option_description: '', locked: true, sub: true, row: existingDiscount.row || '2'
    });
    if (breakdown) {
        setRowAfter(displayValues, 'SUB___RABAT_KLIENTA', 'SUB___CENA_PO_RABACIE',
            hiddenRow(withCurrencyLabel(t('order.unit_after_discount_label')), String(breakdown.priceAfter)));
        if (breakdown.surchargeRatePct !== null) {
            setRowAfter(displayValues, 'SUB___CENA_PO_RABACIE', 'SUB___RABAT_DOPLATY',
                hiddenRow(t('order.surcharge_discount_label'), `${breakdown.surchargeRatePct}%`));
        } else {
            displayValues.delete('SUB___RABAT_DOPLATY');
        }
        if (breakdown.surchargeBefore > 0) {
            const afterKey = displayValues.has('SUB___RABAT_DOPLATY') ? 'SUB___RABAT_DOPLATY' : 'SUB___CENA_PO_RABACIE';
            setRowAfter(displayValues, afterKey, 'SUB___DOPLATA_PO_RABACIE',
                hiddenRow(withCurrencyLabel(t('order.surcharge_after_discount_label')), String(breakdown.surchargeAfter)));
        } else {
            displayValues.delete('SUB___DOPLATA_PO_RABACIE');
        }
    } else {
        // Sam ekstra rabat (bez rabatu klienta grupy) — rozbicia nie ma
        displayValues.delete('SUB___CENA_PO_RABACIE');
        displayValues.delete('SUB___RABAT_DOPLATY');
        displayValues.delete('SUB___DOPLATA_PO_RABACIE');
    }

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

    // Widoczne (niezablokowane) kwoty klienta — CENA DET., DOPŁATA DET., CENA
    // ŁĄCZNA, WARTOŚĆ BR. — zostają CENNIKOWE, czyli przed rabatem (decyzja
    // właściciela 2026-10-27). Rabat matki siedzi w ukrytych wierszach: procent
    // w `SUB___RABAT_KLIENTA`, cena po rabacie w `SUB___WARTOSC_KONCOWA`, które
    // pokazują się dopiero po kłódce (services/subPrices.js attachGroupGoldValues).
    // ⚠️ Od 2026-10-21 do 2026-10-27 widoczne wiersze były tu pomniejszane o rabat.

    // Sprzątanie po poprzednim modelu rabatu (do 2026-09-11 rabat miał WŁASNY
    // wiersz z kwotą). Pozycja zapisana wcześniej wnosi ten wiersz ze sobą przy
    // edycji — zostawiony, zamroziłby starą kwotę obok świeżo policzonej.
    displayValues.delete('SUB___WARTOSC_PO_RABACIE');
    displayValues.delete('WARTOSC_PO_RABACIE');

}

/** Klucze VAT w `displayValues` pozycji liczonej od ceny klienta (`SUB___`). */
const SUB_VAT_KEYS = ['SUB___VAT', 'SUB___WARTOSC_VAT', 'SUB___WARTOSC_BRUTTO'];

/**
 * Fills the read-only VAT / WARTOSC_VAT / WARTOSC_BRUTTO fields (built by
 * form.js's buildVatFields()) from the position's net value + the
 * server-computed VAT rate (window.vatRate, see services/vatCalculator.js).
 *
 * ⚠️ Dwa tory (decyzja właściciela 2026-10-26, `vatUsesClientPrice()`):
 *  • **klient HKL** (`window.isHklOrg`, org id 3, i nie `group_user`) — bez
 *    zmian: podstawą jest zwykłe `SUMA_BRUTTO` (mimo nazwy to netto, FORMULA
 *    `CENA_SUMA * ILOSC`), a wpisy idą pod klucze bez prefiksu
 *    (`VAT`/`WARTOSC_VAT`/`WARTOSC_BRUTTO`, row '2'), widoczne;
 *  • **każda inna organizacja albo `group_user` z ceną `SUB___`** — podstawą
 *    jest `SUB___WARTOSC_KONCOWA` (wartość końcowa klienta, już PO rabacie
 *    klienta i ekstra rabacie — z niej idzie faktura), wpisy idą pod
 *    `SUB___VAT`/`SUB___WARTOSC_VAT`/`SUB___WARTOSC_BRUTTO` z `sub: true`
 *    i `locked: true` — ukryte dokładnie tak jak parametry z `=HASLO()`
 *    (w formularzu pola nie są pokazywane, w podglądzie zamówienia dopiero
 *    po kłódce, w PDF-ie wcale).
 *
 * Gdy parametru podstawy w grupie nie ma, próbujemy kolejnych kandydatów
 * (część grup nie definiuje `SUMA_BRUTTO`/`SUB___WARTOSC_KONCOWA`), żeby pola
 * nie zostały na 0.
 *
 * No-op wherever the WARTOSC_BRUTTO field doesn't exist — never adds stray
 * keys to values/displayValues on those flows.
 */
export function applyVatToGrossValue(values, displayValues) {
    // Master switch (config.js `features.vat` → window.vatEnabled, injected by
    // the templates). Off: no VAT keys in values/displayValues, nothing saved.
    if (!window.vatEnabled) return;

    const bruttoInput = document.getElementById('WARTOSC_BRUTTO');
    if (!bruttoInput) return;
    const vatValueInput = document.getElementById('WARTOSC_VAT');

    const useClientPrice = vatUsesClientPrice();
    const baseKeys = useClientPrice
        ? ['SUB___WARTOSC_KONCOWA', 'SUB___SUMA_BRUTTO', 'SUMA_BRUTTO', 'WARTOSC_KONCOWA']
        : ['SUMA_BRUTTO', 'WARTOSC_KONCOWA', 'SUB___SUMA_BRUTTO', 'SUB___WARTOSC_KONCOWA'];

    let netValue = NaN;
    for (const key of baseKeys) {
        if (values[key] === undefined) continue;
        netValue = parseFloat(values[key]);
        if (Number.isFinite(netValue)) break;
    }
    if (!Number.isFinite(netValue)) return;

    const vatRate = Number(window.vatRate) || 0;
    const grossValue = parseFloat((netValue * (1 + vatRate / 100)).toFixed(2));
    const vatValue = parseFloat((grossValue - netValue).toFixed(2));

    values['WARTOSC_VAT'] = vatValue;
    values['WARTOSC_BRUTTO'] = grossValue;
    if (vatValueInput) vatValueInput.value = vatValue;
    bruttoInput.value = grossValue;

    if (!displayValues) return;

    // ⚠️ Rejestracja jak przy rabacie klienta (`registerClientDiscountKeys`):
    // `hideSub`/`hideLocked` przepisują flagi z tych list przy każdym
    // przeliczeniu — bez niej VAT wracałby do zwykłych, widocznych wierszy.
    if (useClientPrice) registerSubVatKeys();

    const [vatKey, vatValueKey, bruttoKey] = useClientPrice
        ? SUB_VAT_KEYS
        : ['VAT', 'WARTOSC_VAT', 'WARTOSC_BRUTTO'];
    const rows = [
        [vatKey, existing => existing.param_description || t('form.vat_label'), formatVatRateLabel(vatRate)],
        [vatValueKey, existing => savedLabelWithCurrency(existing.param_description, t('form.wartosc_vat_label')), String(vatValue)],
        [bruttoKey, existing => savedLabelWithCurrency(existing.param_description, t('form.wartosc_brutto_label')), String(grossValue)]
    ];
    for (const [key, label, value] of rows) {
        const existing = displayValues.get(key) || {};
        displayValues.set(key, {
            param_description: label(existing),
            option_value: value,
            option_description: '',
            locked: useClientPrice,
            sub: useClientPrice,
            row: existing.row || '2'
        });
    }
}

/** Patrz `registerClientDiscountKeys` — ten sam powód, klucze VAT klienta. */
function registerSubVatKeys() {
    if (!Array.isArray(window.subParams)) window.subParams = [];
    if (!Array.isArray(window.lockedParams)) window.lockedParams = [];
    for (const key of SUB_VAT_KEYS) {
        if (!window.subParams.includes(key)) window.subParams.push(key);
        if (!window.lockedParams.includes(key)) window.lockedParams.push(key);
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

                        // Wyłączona specyfikacja: wiersz `-spec` zapisany wcześniej (przy
                        // edycji `displayValues` przychodzą z bazy) znika przy przeliczeniu,
                        // żeby ponowny zapis pozycji już go nie niósł.
                        // ⚠️ Także gdy grupa definiuje `CENA_S` wprost w param.txt (ma własne
                        // pole) — inaczej wiersz budowałby się niżej mimo wyłączonej flagi.
                        // Specyfikacja = `<PARAM>_S` obok swojej ceny `<PARAM>` (ta sama
                        // reguła co orderService.js dropPriceSpecRows).
                        const specParent = scriptParamName.endsWith('_S') ? scriptParamName.slice(0, -2) : null;
                        if (!isPriceSpecEnabled() && specParent && (inputs[specParent] || specParent in values)) {
                            displayValues?.delete(scriptParamName);
                            continue;
                        }

                        // If param ends with _S and no input exists, create a hidden clone from the parent param
                        const isNewSuffix = isPriceSpecEnabled() && !inputs[scriptParamName] && scriptParamName.endsWith('_S');
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
                                // Do 2 miejsc procentu: 0.7535 → „75.35%” (parseInt dawał „75%”, a 0.565 → „56%”).
                                strVal = `${parseFloat((numericValue * 100).toFixed(2))}%`;
                                inputs[scriptParamName].value = numericValue;
                            } else if (isNewSuffix) {
                                // Specyfikacja rabatu („0.7535(VALUE)”) — 4 miejsca jak sam rabat (scriptLoader.roundPrices).
                                strVal = formatSpecDisplay(scriptValue, scriptParamName.includes('RABAT') ? 4 : 2);
                                inputs[scriptParamName].value = scriptValue;
                            } else {
                                strVal = String(scriptValue);
                                inputs[scriptParamName].value = scriptValue;
                            }

                            const subVariantName = 'SUB___' + scriptParamName;
                            const priceParam = window.params?.find(p => p.NAME === scriptParamName);
                            const isRowTwo = priceParam && (priceParam.LISTROW == '2' || priceParam.LISTSUM == 'true');
                            const hideRegular = shouldHideRegularPriceRow(isRowTwo);
                            // ⚠️ Lustro ceny zwykłej do `SUB___` (CENA → SUB___CENA) TYLKO, gdy
                            // `SUB___` nie ma własnego skryptu cennika. Inaczej cena zakupu HKL
                            // nadpisywała cenę detaliczną klienta przy każdym przeliczeniu
                            // skryptu `CENA` — a sumy liczone ze skryptu `SUB___` zostawały
                            // (zgłoszenie 2026-10-09, Luxan GmbH: „LISTENPREIS 72.18 + AUFPREIS
                            // 15.7 = 300.70", gdzie 72.18 to cena HKL, a nie detaliczna 285).
                            const subParam = window.params?.find(p => p.NAME === subVariantName);
                            const subHasOwnScript = !!(subParam && subParam.SCRIPTS == 'true' && subParam.SOURCE);

                            const applyPriceToInput = (name) => {
                                if (name === scriptParamName) {
                                    buildValuesToDisplay(allOptionsByParameter, strVal, scriptParamName, displayValues, 'INPUT', true);
                                    return;
                                }
                                if (inputs[name] && !scriptParamName.startsWith('SUB___') && !subHasOwnScript) {
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



