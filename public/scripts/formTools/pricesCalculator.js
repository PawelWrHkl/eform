
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
 * Rabat siedzi teraz WYŁĄCZNIE w dwóch ukrytych wierszach `SUB___RABAT_KLIENTA`
 * (%) i `SUB___WARTOSC_PO_RABACIE` (kwota po rabacie) oraz w `total_sub`
 * liczonym w `form.js getTotal()`.
 *
 * ⚠️ **Rabat NIE jest wpisywany do wartości parametrów silnika.** Formuły w
 * `param.txt` liczą się łańcuchowo z `values` (SUB___CENA → SUB___CENA_SUMA →
 * SUB___SUMA_BRUTTO → SUB___WARTOSC_KONCOWA), a `updateFieldStates` przelicza je
 * przy każdej zmianie pola. Gdyby rabat nadpisywał np. `SUB___CENA`, kolejne
 * przeliczenie policzyłoby sumy z już zrabatowanej ceny i rabat naliczałby się
 * wielokrotnie.
 *
 * ⚠️ Rabat NIE wpływa na VAT ani na `WARTOSC_BRUTTO` — te liczą się od
 * nierabatowanego netto, tak jak przed wprowadzeniem rabatu.
 *
 * Zwraca mnożnik (np. 0.9 dla 10%).
 */
export function clientDiscountFactor() {
    const pct = Number(window.clientDiscountPercent) || 0;
    if (!(pct > 0)) return 1;
    return 1 - Math.min(100, pct) / 100;
}

/** Klucze wierszy rabatu w `displayValues` — z prefiksem SUB___, patrz niżej. */
const CLIENT_DISCOUNT_KEYS = ['SUB___RABAT_KLIENTA', 'SUB___WARTOSC_PO_RABACIE'];

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

export function applyClientDiscount(values, displayValues) {
    const pct = Number(window.clientDiscountPercent) || 0;
    if (!(pct > 0)) return;
    const factor = clientDiscountFactor();
    registerClientDiscountKeys();

    // ⚠️ Podstawa rabatu: **`SUB___SUMA_BRUTTO`** — parametr pokazywany przy
    // pozycji jako „WARTOŚĆ BR.[€]" (decyzja właściciela). Rabat klienta liczy
    // się od tej kwoty, a NIE od `SUB___WARTOSC_KONCOWA` (ceny po rabacie
    // cennikowym z `param.txt`): liczenie od `WARTOSC_KONCOWA` dawało kwoty
    // wielokrotnie niższe od oczekiwanych (979 z rabatem 15% wychodziło 332
    // zamiast 832,15). Fallback na `WARTOSC_KONCOWA` tylko wtedy, gdy grupa nie
    // ma w ogóle `SUB___SUMA_BRUTTO`.
    const rawSubNet = values['SUB___SUMA_BRUTTO'] !== undefined
        ? values['SUB___SUMA_BRUTTO']
        : values['SUB___WARTOSC_KONCOWA'];
    const netValue = parseFloat(rawSubNet);

    const afterDiscount = Number.isFinite(netValue)
        ? parseFloat((netValue * factor).toFixed(2))
        : NaN;

    // Pola informacyjne w formularzu (form.js → buildClientDiscountFields).
    values['RABAT_KLIENTA'] = pct;
    if (Number.isFinite(afterDiscount)) values['WARTOSC_PO_RABACIE'] = afterDiscount;

    const discountInput = document.getElementById('RABAT_KLIENTA');
    if (discountInput) discountInput.value = `${pct}%`;
    const afterInput = document.getElementById('WARTOSC_PO_RABACIE');
    if (afterInput && Number.isFinite(afterDiscount)) afterInput.value = afterDiscount;

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
    const existingDiscount = displayValues.get('SUB___RABAT_KLIENTA') || {};
    displayValues.set('SUB___RABAT_KLIENTA', {
        param_description: existingDiscount.param_description || t('form.client_discount_label'),
        option_value: `${pct}%`,
        option_description: '',
        locked: true,
        sub: true,
        row: existingDiscount.row || '2'
    });

    if (Number.isFinite(afterDiscount)) {
        const existingAfter = displayValues.get('SUB___WARTOSC_PO_RABACIE') || {};
        displayValues.set('SUB___WARTOSC_PO_RABACIE', {
            param_description: existingAfter.param_description || t('form.value_after_discount_label'),
            option_value: String(afterDiscount),
            option_description: '',
            locked: true,
            sub: true,
            row: existingAfter.row || '2'
        });
    }
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
    for (const [sumaBruttoKey, wartoscKoncowaKey] of keyPairs) {
        const rawNetValue = values[sumaBruttoKey] !== undefined
            ? values[sumaBruttoKey]
            : values[wartoscKoncowaKey];
        netValue = parseFloat(rawNetValue);
        if (Number.isFinite(netValue)) break;
    }
    if (!Number.isFinite(netValue)) return;

    // ⚠️ Rabat klienta grupy NIE wchodzi do VAT-u ani do `WARTOSC_BRUTTO`
    // (decyzja właściciela): kwota brutto ma zostać taka, jaka była przed
    // wprowadzeniem rabatu, a rabat siedzi wyłącznie w ukrytym
    // `WARTOSC_PO_RABACIE` i w sumie SUB pozycji.

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
    const hasZero = priceParams
        .filter(paramName => inputs[paramName] !== undefined)
        .some(paramName => {
            const value = values[paramName];
            return value == '0' || value == 0;
        });

    if (hasValidValues) {
        setTimeout(() => {

            if (hasZero) {
                destinationParams.forEach(paramName => {

                    let displayValue = displayValues.get(paramName);
                    
                    if (inputs[paramName]) {
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



