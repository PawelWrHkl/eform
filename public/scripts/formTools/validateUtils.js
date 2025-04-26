import { logFunctionName } from './formTools.js';
import { buildValuesToDisplay } from './formTools.js';

export function getProcedures(inputs, allOptionsByParameter, values,options, actualParameter,value,tagName, displayValues){
    logFunctionName('getProcedures')
    
    if (tagName != "INPUT"){
        let selectedValue = allOptionsByParameter[actualParameter].find(v => v.VALUE == value)
        actualParam = actualParameter;

        if (!inputsValidatiors[actualParam]) {
            inputsValidatiors[actualParam] = {};
        }
        inputsValidatiors[actualParam][value] = {};
        actualValue = value;
			console.log(selectedValue)
            const checkProcedure = window.FormulaHandler.evaluateFormula(
                selectedValue.PROC,
                values,
                "PROCEDURE"
            );
			console.log(checkProcedure,'wynik procedury')
        setDefaultValues(inputs,values,allOptionsByParameter, displayValues)
    }
}

export function setDefaultValues(inputs, values, allOptionsByParameter, displayValues) {
    logFunctionName('setDefaultValues');

    Object.entries(inputsValidatiors).forEach(([firstParam, models]) => {
        Object.entries(models).forEach(([modelName, validators]) => {
            Object.entries(validators).forEach(([param, functions]) => {
                if ('DOM' in functions) {
                    const domValue = functions.DOM;
                    values[param] = domValue;
                    const input = inputs[param];
                    buildValuesToDisplay(allOptionsByParameter, domValue, input.name, displayValues, input.tagName);

                    if (input.tagName === 'INPUT' && !input.value) {
                        input.value = domValue;
                    } else if (input.tagName === 'BUTTON' && !input.value) {
                        const currentParam = allOptionsByParameter[param].find(v => v.VALUE === domValue);
                        input.innerHTML = `${domValue} - ${currentParam.DESCRIPTION}`;
                        input.value = domValue;
                    }
                }
            });
        });
    });
}
export function checkFlags() {
    logFunctionName('checkFlags')

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
    const validatorList = findAllValidatorsForInput(actualInput, values);

    if (validatorList.length === 0) {
        setInputValid(actualInput, true);
        return;
    }

    // Wyznacz największy MIN i najmniejszy MAX
    let min = -Infinity;
    let max = Infinity;

    validatorList.forEach(validator => {
        const vMin = validator[actualInput.name]?.MIN;
        const vMax = validator[actualInput.name]?.MAX;
        if (vMin !== undefined) min = Math.max(min, vMin);
        if (vMax !== undefined) max = Math.min(max, vMax);
    });

    const value = parseFloat(actualInput.value);

    if (value > max || value < min) {
        setInputValid(actualInput, false, min, max);
    } else {
        setInputValid(actualInput, true);
    }
}

// Funkcja pomocnicza: zbiera wszystkie walidatory, które pasują do aktualnego inputa i modelu
function findAllValidatorsForInput(actualInput, values) {
    logFunctionName('findAllValidatorsForInput');
    const result = [];
    for (const [param, models] of Object.entries(inputsValidatiors)) {
        for (const [model, validators] of Object.entries(models)) {
            if (Object.values(values).includes(model) && Object.keys(validators).length !== 0) {
                result.push(validators);
            }
        }
    }
    return result;
}

function setInputValid(input, isValid, min, max) {
    logFunctionName('setInputValid');
    inputFlags[input.name] = isValid;
    input.classList.toggle("invalid-input", !isValid);

    const labelId = `${input.id}-label`;
    const existingLabel = document.getElementById(labelId);
    if (existingLabel) existingLabel.remove();

    if (!isValid) {
        const label = document.createElement('label');
        label.id = labelId;
        label.classList.add('invalid-label');
        label.textContent = `Prawidłowa szerokość to ${min} - ${max} cm`;
        label.setAttribute('for', input.id);
        input.parentNode.appendChild(label);
    }
}