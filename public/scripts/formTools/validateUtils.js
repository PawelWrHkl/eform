import { isEnabled } from '../components/htmlManipulator.js';
import { showToast } from '../components/toast.js';
import { logFunctionName, resetAllDOM } from './formTools.js';
import {
    buildValuesToDisplay,
    findParamFromValues,
    searchForParameter,
    resetSelectValues,
    setDescription,
    normalizeFilename,
    setWar
} from './formTools.js';


export function getProcedures(inputs, allOptionsByParameter, values, options, actualParameter, value, tagName, displayValues, params) {
    logFunctionName('getProceduresEEEEEEE');

    
    if (!window.inputsValidators) {
        window.inputsValidators = {};
    }
    

    if (tagName != "INPUT") {
        
        if (!allOptionsByParameter || !allOptionsByParameter[actualParameter]) {
            console.warn(`Parametr ${actualParameter} nie istnieje w allOptionsByParameter`);
            return;
        }

        
        let selectedValue = allOptionsByParameter[actualParameter].find(v => v.VALUE == value);

        
        if (!selectedValue) {
            console.warn(`Nie znaleziono wartości ${value} dla parametru ${actualParameter}`);
            return;
        }

        window.actualParam = actualParameter;
        window.actualValue = value;

        
        if (!window.inputsValidators[window.actualParam]) {
            window.inputsValidators[window.actualParam] = {};
        }

        if (!window.inputsValidators[window.actualParam][window.actualValue]) {
            window.inputsValidators[window.actualParam][window.actualValue] = {};
        }


        try {
            
            const checkProcedure = window.FormulaHandler.evaluateFormula(
                selectedValue.PROC,
                values,
                "PROCEDURE"
            );

            values = setWar(values, params, inputs)

            const prodecuresResults = [window.inputsValidators,
            window.inputsDefaults]


        } catch (error) {
            console.error('Błąd ewaluacji procedury:', error);
        }

        setDefaultValues(inputs, values, allOptionsByParameter, displayValues);
    }

    if (window.checkedParams) {
        

        Object.entries(window.checkedParams).forEach(([paramName, paramValue]) => {

            try {

                if (paramValue?.PROC) {

                    if (!window.inputsValidators[paramName]) {
                        window.inputsValidators[paramName] = {};
                    }

                    
                    if (paramValue.VALUE) {
                        if (!window.inputsValidators[paramName][paramValue.VALUE]) {
                            window.inputsValidators[paramName][paramValue.VALUE] = {};
                        }

                        
                        window.ignoreDom = true

                        
                        const prevParam = window.actualParam;
                        const prevValue = window.actualValue;

                        
                        window.actualParam = paramName;
                        window.actualValue = paramValue.VALUE;

                        try {
                            
                            const checkProcedure = window.FormulaHandler.evaluateFormula(
                                paramValue.PROC,
                                values,
                                "PROCEDURE",
                                true

                            );

                            resetAllDOM()
                        } catch (error) {
                            console.error(`Błąd procedury dla ${paramName}/${paramValue.VALUE}:`, error);
                        } finally {
                            
                            window.actualParam = prevParam;
                            window.actualValue = prevValue;
                            window.ignoreDom = false;
                        }
                    } else {
                        console.warn(`Brak wartości VALUE dla parametru: ${paramName}`);
                    }
                }
            } catch (error) {
                console.error('Krytyczny błąd przetwarzania:', error);
            }
        });
        setDefaultValues(inputs, values, allOptionsByParameter, displayValues, true);

    }
}


export function setDefaultValues(inputs, values, allOptionsByParameter, displayValues, fromChecked = false) {
    logFunctionName('setDefaultValues');
    let resetFlag = true;
    if (fromChecked) { return false }
    Object.entries(inputsDefaults).forEach(([firstParam, models]) => {
        Object.entries(models).forEach(([modelName, defaults]) => {
            Object.entries(defaults).forEach(([param, functions]) => {
                const input = inputs[param];
                let currentParam = searchForParameter(functions.DOM, allOptionsByParameter, param);
                if (!currentParam && input && input.tagName != "INPUT") {

                    if (typeof functions.DOM === 'string') {
                        functions.DOM = 'Puste pole'
                    }
                    return;
                }
                if ('DOM' in functions && functions.DOM) {
                    const domValue = functions.DOM;
                    values[param] = domValue;
                    setDescription(values, domValue, allOptionsByParameter, param)
                    
                    try {
                        const curPar = buildValuesToDisplay(allOptionsByParameter, domValue, input?.id, displayValues, input.tagName);
                        
                        
                        if (input.tagName === 'INPUT') {
                            input.value = domValue;
                        }
                        else if (input.tagName === 'BUTTON') {
                            let buttonLabel;
                            let buttonVal;
                            if (currentParam?.ALIAS) {
                                buttonLabel = `${currentParam?.ALIAS ?? ''}-${currentParam?.ALIAS_DESCRIPTION ?? ''}`
                                buttonVal = currentParam?.ALIAS ?? '';
                            }
                            else {
                                if (domValue === '<NONE>') {
                                    
                                    buttonLabel = currentParam?.DESCRIPTION ?? ""
                                }
                                else {
                                    buttonLabel = `${domValue} - ${currentParam?.DESCRIPTION ?? ""}`;
                                }
                                buttonVal = domValue;
                            }
                            input.textContent = buttonLabel;
                            input.value = buttonVal

                        }
                        else if (input.tagName === "SELECT") {
                            const options = input.options;
                            for (let i = 0; i < options.length; i++) {
                                if (options[i].value == domValue) {
                                    input.selectedIndex = i;
                                    options[i].selected = true;
                                    break;
                                }
                            }
                        }
                    }
                    catch (error) {

                    }
                }
            });
        });
    });
    if (resetFlag) {
        resetAllDOM()
    }

}


export function checkFlags() {
    const notTrue = Object.entries(inputFlags)

        .filter(([key, value]) => value !== true);

    if (notTrue.length === 0) {
        return true;
    } else {
        return notTrue.map(([key, value]) => ({ key, value }));
    }
}



export function validateFormInput(values, actualInput) {
    logFunctionName('validateFormInput');

    let flag;
    const validatorList = findAllValidatorsForInput(actualInput, values);

    if (validatorList.length === 0 && actualInput.value != '') {
        setInputValid(actualInput, true);
        return;
    }

    const legacyRange = getValidatorsRange(validatorList, actualInput.name, 'MIN', 'MAX');
    const strictRange = getValidatorsRange(validatorList, actualInput.name, 'MIN2', 'MAX2');
    const hardRange = strictRange.hasRange ? strictRange : legacyRange;

    const value = parseFloat(actualInput.value);

    let result;
    if (isOutsideRange(value, hardRange)) {
        result = setInputValid(actualInput, false, hardRange.min, hardRange.max);
        return result
    }

    if (strictRange.hasRange && isOutsideRange(value, legacyRange)) {
        result = setInputValid(actualInput, true, legacyRange.min, legacyRange.max, 'warning');
        return result
    }
    else {

        result = setInputValid(actualInput, true);
        return result
    }

}

function normalizeRangeValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function getValidatorsRange(validatorList, inputName, minKey, maxKey) {
    let min = 0;
    let max = Infinity;
    let hasRange = false;

    validatorList.forEach(validator => {
        const rules = validator[inputName];
        if (!rules) return;

        const vMin = normalizeRangeValue(rules[minKey]);
        const vMax = normalizeRangeValue(rules[maxKey]);

        if (vMin !== undefined) {
            min = Math.max(min, vMin);
            hasRange = true;
        }
        if (vMax !== undefined) {
            max = Math.min(max, vMax);
            hasRange = true;
        }
    });

    return { min, max, hasRange };
}

function isOutsideRange(value, range) {
    if (!range.hasRange || !Number.isFinite(value)) return false;
    return value > range.max || value < range.min;
}


export function findAllValidatorsForInput(actualInput, values) {
    logFunctionName('findAllValidatorsForInput');
    const result = [];

    for (const [param, models] of Object.entries(inputsValidators)) {
        for (const [model, validators] of Object.entries(models)) {
            if (Object.values(values).includes(model) && Object.keys(validators).length !== 0) {
                result.push(validators);
            }
        }
    }
    return result;
}

export function setInputValid(input, isValid, min, max, mode = 'error') {
    let res = isValid;
    const labelId = `${input.id}-label`;
    const existingLabel = document.getElementById(labelId);
    if (existingLabel) existingLabel.remove();

    const parent = input.parentNode;

    
    if (!parent.classList.contains('input-with-icon')) {
        parent.classList.add('input-with-icon');
    }


    const existingIcon = parent.querySelector('.warning-icon');
    if (existingIcon) existingIcon.remove();

    inputFlags[input.name] = isValid;


    input.classList.remove("invalid-input", "warning-warranty-input");
    const label = document.createElement('label');

    if (mode === 'warning') {
        label.id = labelId;
        label.setAttribute('for', input.id);
        label.classList.add("warning-warranty-label");
        label.textContent = 'Uwaga, produkcja możliwa aczkolwiek bez gwarancji';

        input.classList.add("warning-warranty-input");

        const icon = document.createElement('span');
        icon.classList.add('warning-icon', 'has-tooltip');
        icon.setAttribute('data-tooltip', label.textContent);
        icon.setAttribute('aria-label', label.textContent);
        icon.textContent = '⚠';
        parent.appendChild(icon);
        parent.appendChild(label);

        inputFlags[input.name] = true;
        return true;
    }

    if (!isValid) {
        
        label.id = labelId;
        label.setAttribute('for', input.id);
        res = false;
        if (input.type === "number" && min !== undefined && max !== undefined) {
            res = false;
            inputFlags[input.name] = false;
            input.classList.add("invalid-input");
            const rangeText = `min: ${min} - max: ${max}`;

            // Manual-override fields show the allowed range in a dedicated div under the checkbox.
            if (input._manualHint) {
                input._manualHint.textContent = rangeText;
                input._manualHint.style.display = '';
                return res;
            }

            label.textContent = rangeText;


        } else {
            input.classList.add("invalid-input");
            label.classList.remove("warning-warranty-label");
            label.classList.add("invalid-label");
            label.textContent = t('form.obligo_field');
            res = false;
        }

        parent.appendChild(label);

    } else {

        if (input._manualHint) {
            input._manualHint.textContent = '';
            input._manualHint.style.display = 'none';
        }
        parent.classList.remove('input-with-icon');
    }

    return res;
}

export function validateAllFieldsOnSubmit(inputs, values) {

    for (const key of Object.keys(inputFlags)) {

        if (!enabledParams.hasOwnProperty(key)) {
            delete inputFlags[key];

        }
    }



    for (const param of Object.keys(enabledParams)) {


        if (window.calculatedParams && window.calculatedParams.has(param)) {
            inputFlags[param] = true;
            continue;
        }

        let invalidLabel;

        const input = inputs[param];
        if (!input) continue;
        let isValid = true;
        const warningIcon = input.parentNode?.querySelector('.warning-icon');
        if (warningIcon) warningIcon.remove();
        input.classList.remove("warning-warranty-input");

        if (input.tagName === 'BUTTON') {
            isValid = !!input.value && input.value.trim() !== '';

            if (!isValid) { invalidLabel = t('form.obligo_value'); }
        }
        else {

            isValid = !!input.value && input.value.trim() !== '';
            if (!isValid) { invalidLabel = t('form.obligo_field'); }
            if (input.type === "number") {
                invalidLabel = t('form.numeric_obligo_field');
                const numVal = Number(input.value);
                isValid = input.value !== "" && !isNaN(numVal);

            }
        }


        input.classList.toggle("invalid-input", !isValid);
        let fullParam = window.params.find(p => p.NAME === param);
        let isRequired = fullParam?.REQUIRED ?? true;
        if (!isRequired){
            isValid = true;
        }

        const labelId = `${input.id}-label`;
        const existingLabel = document.getElementById(labelId);
        if (existingLabel) existingLabel.remove();

        if (!isValid) {
            const label = document.createElement('label');
            label.id = labelId;
            label.classList.add('invalid-label');
            label.setAttribute('for', input.id);
            label.textContent = invalidLabel;
            input.parentNode.appendChild(label);
        }

        else if (isValid) {

            let extraValidation = findAllValidatorsForInput(inputs[param], values)
            const paramsToValidate = extraValidation[0]

            if (paramsToValidate?.[param]) {
                isValid = validateFormInput(values, inputs[param])


            }
        }
        
        inputFlags[param] = isValid;

    }



    afterSend = true;

}


/**
 * Wartość, na którą wraca parametr wyłączony przez `ENABLE`.
 *
 * ⚠️ Parametr LICZONY (skrypt cenowy `SCRIPTS` albo `FORMULA`) ma wartość
 * neutralną `0`, a nie `''` — dokładnie tak startuje jego input
 * (`form.js`: `input.value = 0` dla `SCRIPTS != '<NULL>' || FORMULA != '<NULL>'`).
 *
 * DLACZEGO TO WAŻNE: `hot-formula-parser` liczy OBIE gałęzie `IF`, także tę
 * nieużywaną. Pusty operand daje `#VALUE!` na całej formule, `evaluateFormula`
 * zwraca wtedy `false`, a `calculateFromFormula` wpisuje 0. Grupa 14 (VERTIKAL)
 * przy `KONFIGURACJA="L"`: cenę HKL liczy `CENAPASEK`, wyłączona `CENA` stoi w
 * drugiej gałęzi `CENA_SUMA` — wyczyszczona do `''` zerowała `CENA_SUMA`,
 * `SUMA_BRUTTO`, `CENA_KONCOWA` i `WARTOSC_KONCOWA` (oraz ich bliźniaki
 * `SUB___*`), mimo poprawnie policzonego `CENAPASEK`.
 */
function neutralValueFor(paramName, currentValue) {
    const params = window.params;
    if (!Array.isArray(params)) return '';
    const param = params.find(p => p.NAME === paramName);
    if (!param) return '';

    // Ten sam warunek, co w `form.js` przy budowie pola — tam decyduje o
    // `input.disabled = true` i `input.value = 0`.
    const isCalculated = param.SCRIPTS != '<NULL>' || param.FORMULA != '<NULL>';
    if (!isCalculated) return '';

    // ⚠️ Parametr liczony, ale trzymający TEKST, zostaje na `''`. Grupa 14 ma
    // takie trzy: `OPIS_POZYCJI`, `OPIS_CENY`, `OPIS_RABATU` (`SCRIPTS='true'`,
    // `FORMROW='0'`) — skrypt cenowy wpisuje tam etykietę w rodzaju
    // `"(304(TCNDPG2))*1.045"`. Zero byłoby tam liczbą udającą opis.
    if (currentValue === '') return '';
    if (typeof currentValue === 'string' && !Number.isFinite(Number(currentValue))) return '';

    return 0;
}

export function clearDisabledValues(values, displayValues) {
    const enabledParamsKeys = new Set(Object.keys(enabledParams));
    
    for (const key of Object.keys(values)) {

        const baseParam = key.replace(/___DESCRIPTION$/, '');

        if (key.includes('___VISIBLE') || baseParam.includes('___TITLE') || baseParam.includes('___DICT')) {
            
            continue;
        }

        if (!enabledParamsKeys.has(baseParam) && !baseParam.endsWith('_ALIAS')) {
            const desc = `${baseParam}___DESCRIPTION`;
            const visibleKey = `${baseParam}___VISIBLE`;
            const alias_desc = `${baseParam}_ALIAS___DESCRIPTION`;
            const alias_key = `${baseParam}_ALIAS`;
            values[visibleKey] = false;

            
            if (values[desc] !== undefined) {
                values[desc] = '';
            }
            if (values[key] !== undefined && key !== desc) {
                values[key] = key === baseParam ? neutralValueFor(baseParam, values[key]) : '';
            }
            if (values[alias_desc] !== undefined) {
                values[alias_desc] = '';
            }
            if (values[alias_key] !== undefined) {
                values[alias_key] = '';
            }


            const isDescription = key.endsWith('___DESCRIPTION');
            const displayKey = isDescription ? baseParam : key;
            const displayParam = displayValues.get(displayKey);
            

            if (displayParam && displayParam.locked !== true) {
                isDescription || displayParam.option_value != 'undefined' || !displayParam.option_value
                    ? delete displayParam.option_description
                    : delete displayParam.option_value;
            }
            if (displayParam && displayParam.locked !== true && (displayParam.row == '1' || displayParam.row == '0')) {
                delete displayParam.option_description
                delete displayParam.option_value;
            }

            for (const skipParam of window.skipCountParams) {
                if (displayKey === skipParam) {
                    
                    const displayParam = displayValues.get(displayKey);
                    if (displayParam) {
                        displayParam.row = '0';
                        displayValues.set(displayKey, displayParam);
                    }
                    
                }
            }

        } else if (enabledParamsKeys.has(baseParam)) {
            
            const visibleKey = `${baseParam}___VISIBLE`;
            values[visibleKey] = true;
        }
    }

    return { values, displayValues };

}
