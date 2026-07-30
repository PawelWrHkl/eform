
import { showToast } from "../components/toast.js";
import { loadScript } from './scriptLoader.js';
import { buildValuesToDisplay } from "./updateFieldsAndValues.js";
import { validateFormInput } from "./validateUtils.js";
import { shouldHideRegularPriceRow } from "./createForm.js";
import { getEnvVersion } from "../getEnv.js";

let _isTestEnv = false;
getEnvVersion().then(v => {
    _isTestEnv = (v === 'Testowa');
    console.log('Wersja środowiska:', v, '| _isTestEnv:', _isTestEnv);
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
            option_value: `${vatRate}%`,
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
                        const isNewSuffix = _isTestEnv && !inputs[scriptParamName] && scriptParamName.endsWith('_S');
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



