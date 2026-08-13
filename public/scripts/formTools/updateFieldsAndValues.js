import { findParamFromValues, logFunctionName } from './formTools.js';
import { getProcedures, searchForParameter } from './formTools.js';
import { createDialog } from './dialogUtils_copy.js';
import { isEnabled } from '../components/htmlManipulator.js';
import { validateFormInput, setInputValid } from './validateUtils.js';
import { showToast } from '../components/toast.js';
import { loadScript } from './scriptLoader.js';
import { findAllValidatorsForInput, clearDisabledValues } from './validateUtils.js'
import { calculateFromScript, calculateFromFormula, checkIfPriceIsCorrect, applyVatToGrossValue } from './pricesCalculator.js';
import { applySingleParamVisibility } from './createForm.js';




export function resetDependences([params, display], name, inputs, values, allOptionsByParameter) {
    logFunctionName('resetDependences');

    let param = params.find((obj) => obj.NAME === name);
    if (param && param.DEPENDENCES && typeof param.DEPENDENCES === "string") {


        let paramsToCheck = param.DEPENDENCES.split(",");
        let paramsToReset = [...paramsToCheck];

        for (let depParam of paramsToCheck) {
            let valueToReset = values[depParam];

            let x = searchForParameter(valueToReset, allOptionsByParameter, depParam);


            if (x && isEnabled(x.ENABLE, values)) {
                paramsToReset = paramsToReset.filter(p => p !== depParam);
            }

            if (inputs[depParam]?.tagName == 'INPUT' && typeof valueToReset == 'number') {
                let allValidators = (findAllValidatorsForInput(depParam, values))[0];
                let validators = allValidators && allValidators[depParam];
                const min = validators?.MIN2 ?? validators?.MIN;
                const max = validators?.MAX2 ?? validators?.MAX;
                if (
                    validators &&
                    Number(min) < values[depParam] &&
                    values[depParam] < Number(max)
                ) {
                    paramsToReset = paramsToReset.filter(param => param !== depParam);
                }

            }
        }

        resetSelectValues([paramsToReset, display], inputs, values);
    }
}




export function resetSelectValues([parameters, display], inputs, values, skipCalculated = true) {
    logFunctionName('resetSelectValues')
    window.checkedParams = {}
    let commInput = document.getElementById('commission-input');
    if (commInput && !skipCalculated) {
        commInput.value = '';
    }

    for (let idx = 0; idx < parameters.length; idx++) {
        let paramName = parameters[idx];
        const param = params.find(obj => obj.NAME === paramName);



        if (inputs[paramName] && inputs[paramName].tagName == 'INPUT') {
            let isCalculated = param && ((
                (param.FORMULA && param.FORMULA !== '<NULL>') ||
                (param.SOURCE && param.SOURCE !== '<NULL>' && param.SOURCE !== param.NAME)));

            if (isCalculated && skipCalculated) {

                continue;
            }
        }

        if (inputs[paramName]) {
            inputs[paramName].selectedIndex = 0;
            values[paramName] = "";


            if (inputs[paramName].tagName == 'BUTTON') {

                inputs[paramName].innerHTML = `${t('form.check_word')}`;
                inputs[paramName].value = '';
            }
            if (inputs[paramName].tagName == 'INPUT') {
                inputs[paramName].value = '';

            }
        } else {
            console.warn(`Pole ${paramName} nie istnieje w inputs`);
        }
    }
    for (let idx = 0; idx < parameters.length; idx++) {
        let param = parameters[idx];
        resetDisplayEntry(param, display);
    }
}

export function resetDisplayEntry(param, display) {
    logFunctionName('resetDisplayEntry')

    if (display.has(param)) {
        const existing = display.get(param);
        display.set(param, { param_description: existing.param_description });
    }
}

export function buildValuesToDisplay(dictValues, value, paramName, displayValues, tagName, calculated = false) {


    logFunctionName('buildValuesToDisplay');



    let currentValue = displayValues?.get(paramName) || {};

    if (currentValue == {} && !calculated) {
        displayValues.set(paramName, {
            locked: false,
            option_value: '',
            option_description: '',
            row: ""
        })
    }

    else if (Object.keys(currentValue).length <= 1 && calculated) {

        let param = params.find(p => p.NAME === paramName);
        let locked;



        if (window.lockedParams && window.lockedParams.includes(paramName)) {
            locked = true;
        } else {
            locked = false;
        }

        const sub = !!(window.subParams && window.subParams.includes(paramName));

        displayValues.set(paramName, {
            param_description: param?.DESCRIPTION || '',
            locked: locked,
            sub: sub,
            option_value: value,
            option_description: '',
            row: param?.LISTROW || '1'
        });

    }
    if (currentValue['option_value'] || currentValue['option_value'] != undefined
    ) {

        currentValue['option_value'] = String(currentValue['option_value'])
    }

    if (value === '<NONE>') {

        let currentValue = displayValues.get(paramName) || {};

        for (let key in currentValue) {
            currentValue['locked'] = false;
            currentValue['option_value'] = '';
            currentValue['option_description'] = '';
            currentValue['row'] = '';
        }

        currentValue['option_value'] = '';
        currentValue['option_description'] = '';
        displayValues.set(paramName, currentValue);


        return;
    }


    // Sub-form ("slope") param: the value is a whole nested form, either the
    // modal's sourceDisplayValues (title -> value) or the full model produced by
    // processSourceValues (values + ___DICT/___TITLE/___VISIBLE/___DESCRIPTION/
    // _ALIAS meta). Only the real sub-values get described, labelled by their
    // title cut at the first space ("B [mm]" -> "B") — feeding the meta keys into
    // the text is what produced "TYP___DICT:[object Object],…" on imported orders.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const isModel = Object.keys(value).some(key => key.endsWith('___TITLE'));
        const isMetaField = (key) => /___(DICT|TITLE|VISIBLE|DESCRIPTION)$/.test(key)
            || key.endsWith('_ALIAS') || key.endsWith('_ALIAS_DESCRIPTION');
        const descParts = [];

        for (let [fieldName, fieldVal] of Object.entries(value)) {
            if (isModel && isMetaField(fieldName)) continue;
            // Title maps carry no meta, so the type field is only recognisable
            // by its own label there — kept skipped, as before.
            if (!isModel && fieldName === 'TYP') continue;
            if (!fieldVal || fieldVal === '<NONE>') continue;

            const title = (isModel && value[`${fieldName}___TITLE`]) || fieldName;
            descParts.push(String(title).split(' ')[0] + ':' + fieldVal);
        }

        currentValue['option_value'] = '';
        currentValue['option_description'] = descParts.join(' / ');
        displayValues.set(paramName, currentValue);

        return;
    }


    if (value != '<NONE>') {
        const valOBj = searchForParameter(value, dictValues, paramName);
        currentValue['option_value'] = value;

        if (tagName != "INPUT") {
            const currentParam = dictValues[paramName]?.find(v => v.VALUE === value);
            if (currentParam?.ALIAS) {
                currentValue['option_description'] = currentParam?.ALIAS_DESCRIPTION ?? "";
                currentValue['option_value'] = currentParam.ALIAS;
            } else {
                currentValue['option_description'] = currentParam?.DESCRIPTION ?? "";
            }
        }

    }

    // always propagate sub flag for SUB___ params
    if (window.subParams && window.subParams.includes(paramName)) {
        currentValue['sub'] = true;
    }

    // For SUB___ params: mirror locked flag from base param name.
    // Scripts hardcode e.g. window.lockedParams.push('CENA_RABAT') — the SUB___ variant
    // must also become locked when its base param is locked.
    if (paramName.startsWith('SUB___')) {
        const baseName = paramName.slice(6); // 'SUB___CENA_RABAT' → 'CENA_RABAT'
        if (window.lockedParams && window.lockedParams.includes(baseName)) {
            currentValue['locked'] = true;
            if (!window.lockedParams.includes(paramName)) {
                window.lockedParams.push(paramName);
            }
        }
    }
}


export async function updateFieldInputs(params, inputs, values, displayValues, allOptionsByParameter, options, actualParameter, value, tagName, filters, attrVals) {

    enabledParams = {}
    logFunctionName('updateFieldInputs')


    let btns = [];
    const allowedOptions = {};
    const allowedParameters = {};
    for (const paramName in inputs) {

        if (inputs[paramName].tagName == 'BUTTON') {
            btns.push(inputs[paramName])
        }

        allowedOptions[paramName] = new Set();
        allowedParameters[paramName] = [];
    }

    for (const paramName in allOptionsByParameter) {

        const paramArray = allOptionsByParameter[paramName];
        if (!inputs[paramName]) continue;


        for (const param of paramArray) {
            let isEnabled = false;
            try {
                isEnabled = await window.FormulaHandler.evaluateFormula(
                    param.ENABLE,
                    values,
                    "paramdict",
                    param,
                    paramName
                );
                let expression = param

            }

            catch (error) {


                showToast('error', `Parametr: ${param.VALUE}.  ${error.message}`)
            }

            if (isEnabled && param.VALUE != '-') {
                if (param.ROW_NUM) {
                    const idAndValue = `${param.ROW_NUM}-${paramName}`;
                    allowedOptions[paramName].add(idAndValue);
                    allowedParameters[paramName].push(param);
                }

            }
        }

    }

    for (const paramName in inputs) {
        let param = params.find((param) => param.NAME === paramName);
        if (!param) continue;
        const currentSelect = inputs[paramName];
        if (currentSelect.tagName === "INPUT") { };
        const allowed = allowedOptions[paramName];

        if (currentSelect.tagName === 'BUTTON' && !(param.SOURCE == param.NAME)) {

            const newBtn = currentSelect.cloneNode(true);
            currentSelect.parentNode.replaceChild(newBtn, currentSelect);

            newBtn.addEventListener('click', function () {
                createDialog(param, allowedParameters[paramName], tempGroupNumber, filters[paramName], attrVals);
            });


            inputs[paramName] = newBtn;
        }

        for (const child of currentSelect.children) {
            const optionValue = child.id.replace(/\s+/g, " ").trim();

            if (!allowed.has(optionValue)) {
                child.style.display = "none";
                child.disabled = true;
            } else {
                child.style.display = "grid";
                child.disabled = false;
            }
        }
    }
}


function applyParamVisibilityFromFormulas(params, inputs, values, validateInputs) {
    const disabledParams = new Set();
    for (let key in inputs) {
        const param = params.find(p => p.NAME === key);
        if (!param) continue;

        let shouldEnable = false;
        try {
            shouldEnable = window.FormulaHandler.evaluateFormula(
                param.ENABLE,
                values,
                "param",
                param.NAME
            );

            if (param.SOURCE != "<NULL>" && param.NAME != param.SOURCE && !shouldEnable) {
                if (!window.skipCountParams.includes(param.NAME)) {
                    window.skipCountParams.push(param.NAME);
                }
            } else if (window.skipCountParams.includes(param.NAME) && shouldEnable) {
                window.skipCountParams = window.skipCountParams.filter(name => name !== param.NAME);
            }

            if (shouldEnable == 'password') {
                shouldEnable = false;
                if (key.startsWith('SUB___') && window.lockedParams && !window.lockedParams.includes(key)) {
                    window.lockedParams.push(key);
                }
            } else if (!shouldEnable) {
                disabledParams.add(param.NAME);
            }
            if (param.FORMROW == '0') { shouldEnable = false; }
        } catch (error) {
            showToast('error', `Parametr: ${param.VALUE}.  ${error.message}`);
        }

        applySingleParamVisibility(key, param, shouldEnable, inputs);

        if (validateInputs && inputs[key].tagName == 'INPUT') {
            validateFormInput(values, inputs[key]);
        }
    }
    return disabledParams;
}

export async function updateFieldStates(params, inputs, values, displayValues, groupNumber, allOptionsByParameter, name, value) {

    logFunctionName('updateFieldStates')
    let disabledParams = applyParamVisibilityFromFormulas(params, inputs, values, true);
    ({ values, displayValues } = clearDisabledValues(values, displayValues))
    const scriptOperations = [];
    const formulaOperations = [];

    for (let key in inputs) {
        let param = params.find(p => p.NAME === key);
        if (!param) continue;

        // Manual-override params are typed by the user; never recompute them here.
        if (window.manualParams && window.manualParams.has(key)) continue;

        const hasSource = param.SOURCE != "<NULL>" && param.NAME != param.SOURCE;
        const hasFormula = param.FORMULA != "<NULL>" && !(window.skipCountParams.includes(param.NAME)) && !disabledParams.has(param.NAME);

        if (hasSource && hasFormula) {

            scriptOperations.push({ param, key, hasFormula: true });
        } else if (hasSource) {
            window.calculatedParams.add(param.NAME);
            scriptOperations.push({ param, key, hasFormula: false });
        } else if (hasFormula) {
            window.calculatedParams.add(param.NAME);

            formulaOperations.push({ param, key });
        }
    }

    return new Promise((resolveAll) => {
        // PRE-PASS: uruchom najpierw formuły (bez SOURCE) — żeby skrypty miały dostęp
        // do świeżo policzonych wartości tych formuł (np. MARSZCZPROC zależny od FALA).
        // Bez tego skrypty czytają stare values[] dla parametrów które są tylko formułami.
        formulaOperations.forEach(operation => {
            calculateFromFormula(
                operation.param,
                values,
                inputs,
                displayValues,
                groupNumber,
                allOptionsByParameter,
                operation.key,
                operation.param.NAME
            );
        });

        let scriptIndex = 0;

        const executeNextScript = () => {
            if (scriptIndex >= scriptOperations.length) {
                // POST-PASS: ponownie uruchom wszystkie formuły (oryginalne + dodane
                // w trakcie callbacków skryptów dla SOURCE+FORMULA params) — w razie
                // gdyby skrypty zmieniły wartości używane przez formuły.
                formulaOperations.forEach(operation => {
                    calculateFromFormula(
                        operation.param,
                        values,
                        inputs,
                        displayValues,
                        groupNumber,
                        allOptionsByParameter,
                        operation.key,
                        operation.param.NAME
                    );
                });
                resolveAll();
                return;
            }

            const operation = scriptOperations[scriptIndex];
            scriptIndex++;

            calculateFromScript(
                operation.param,
                values,
                inputs,
                displayValues,
                groupNumber,
                allOptionsByParameter,
                operation.key,
                operation.param.NAME,
                function () {
                    if (operation.hasFormula) {
                        formulaOperations.push({
                            param: operation.param,
                            key: operation.key
                        });
                    }
                    executeNextScript();
                }
            );

        };

        if (scriptOperations.length > 0) {
            executeNextScript();
        }
        else {
            // Brak skryptów — formuły już zostały wykonane w pre-pass, nic więcej nie trzeba
            resolveAll();
        }
    }).then(() => {
        applyParamVisibilityFromFormulas(params, inputs, values, false);
        // Right after prices finish computing (SUB___WARTOSC_KONCOWA has its final
        // value) — before checkIfPriceIsCorrect's placeholder logic — fill the
        // read-only WARTOSC_BRUTTO field with the VAT-adjusted gross value.
        applyVatToGrossValue(values, displayValues);
        displayValues = checkIfPriceIsCorrect(values, inputs, displayValues);
    });
}


export function setListRow(params, displayValues) {
    for (let param of params) {
        let displayParam = displayValues.get(param.NAME)
        let listRow = param?.LISTROW ?? '1'
        if (displayParam) {
            displayParam['row'] = listRow
            if (param.LISTSUM == 'true') {
                displayParam['listsum'] = true
            }
        }
    }

    return displayValues;
}

export function setWar(values, params, inputs) {

    function setNestedValue(obj, path, value, param, inputs) {

        const keys = path.split('.');
        let current = obj;
        let currentInput = inputs[param.NAME];
        for (let i = 0; i < keys.length - 1; i++) {

            if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        if (param.NAME == param.SOURCE) {

            param.modal.setTyp(value);


        }
        else if (param.TYPE == 'link') {
            currentInput.value = `/photos/${window.tempGroupNumber}/${param.NAME}/${value}`
            currentInput.target = "_blank";
            currentInput.href = `/photos/${window.tempGroupNumber}/${param.NAME}/${value}`

        }
        else {

            if (currentInput) {

                if (currentInput.tagName === 'INPUT' || currentInput.tagName === 'TEXTAREA' || currentInput.tagName === 'SELECT') {
                    currentInput.value = value;
                } else {
                    currentInput.innerHTML = value;
                }
            } else {
                console.warn(`Input element for ${param.NAME} not found`);
            }
        }

        current[keys[keys.length - 1]] = value;

    }

    for (const key in window.constValues) {
        const keys = key.split('.');
        let paramName = keys[0]
        const param = params.find(p => p.NAME == paramName);

        if (param) {
            setNestedValue(values, key, window.constValues[key], param, inputs);
        } else {
            console.warn(`Parameter ${paramName} not found in params`);
        }
    }


    return values;
}

export function checkRelated(params, values) {
    logFunctionName('checkRelated')

    let parameters = Object.values(params);


    for (let idx = 0; idx < parameters.length; idx++) {
        let param = parameters[idx];
        let relatedValue = param.RELATED;

        if (relatedValue) {
            if (relatedValue.trim() === "" || relatedValue == null) {
                param.RELATED = false;
            } else {
                param.RELATED = relatedValue;
            }
        } else {
            param.RELATED = false;
        }

        if (param.RELATED) {
            values[param.RELATED] = values[param.NAME];
        }
    }
}

export function resetAllDOM() {

    for (const [category, models] of Object.entries(window.inputsDefaults)) {

        for (const [modelName, modelConfig] of Object.entries(models)) {
            for (const [param, paramConfig] of Object.entries(modelConfig)) {
                if (paramConfig.hasOwnProperty('DOM')) {
                    delete paramConfig.DOM;
                }
                if (Object.keys(paramConfig).length == 0) {
                    delete modelConfig[param]
                }
            }
            if (Object.keys(modelConfig).length == 0) {
                delete models[modelName];
                continue;
            }
        }
        if (Object.keys(models).length == 0) {
            delete window.inputsDefaults[category];
        }
    }
}
export function convertIntoPercent(values, name, value, inputs, params) {
    logFunctionName('convertIntoPercent')
    const param = params.find((obj) => obj.NAME === name);

    if (param.FORMAT == 'n%') {
        if (typeof value === 'string') {
            value = value.replace(',', '.');
        }
        if (!isNaN(value)) {
            value = parseFloat(value)
        }
        if (typeof value === 'string' && value.endsWith('%')) {
            let numericPart = parseFloat(value.slice(0, -1));
            if (!isNaN(numericPart) && numericPart <= 100) {
                values[name] = numericPart / 100;
                inputs[name].value = `${numericPart}%`;
            } else {
                values[name] = 0;
                inputs[name].value = '0%';
            }
        } else if (typeof value === 'number' && value >= 1 && value <= 100) {
            values[name] = value / 100;
            inputs[name].value = `${value}%`;
        } else if (typeof value === 'number' && value < 1 && value >= 0) {
            values[name] = value;
            inputs[name].value = `${value * 100}%`;
        }
        else {
            values[name] = 0;
            inputs[name].value = '0%';
        }
    }
    return values;

}
