import { logFunctionName } from './formTools.js';
import { getProcedures } from './formTools.js';
import { createDialog } from './formTools.js';
import { validateFormInput } from './validateUtils.js';
import { showToast } from '../components/toast.js';
export function resetDependences([params,display], name, inputs, values) {
    logFunctionName('resetDependences')

    let param = params.find((obj) => obj.NAME === name);
    if (param && param.DEPENDENCES && typeof param.DEPENDENCES === "string") {
        let paramsToReset = param.DEPENDENCES.split(",");

        resetSelectValues([paramsToReset,display], inputs, values);
    }
}

export function resetSelectValues([parameters,display], inputs, values) {
    logFunctionName('resetSelectValues')
    for (let idx = 0; idx < parameters.length; idx++) {
        let paramName = parameters[idx];
        const param = params.find(obj => obj.NAME === paramName);

        if (inputs[paramName]) {
            inputs[paramName].selectedIndex = 0;
            values[paramName] = "";
            

        if (inputs[paramName].tagName == 'BUTTON'){
            inputs[paramName].innerHTML = `Wybierz ${param.DESCRIPTION}`;
            inputs[paramName].value = '';
        }
        if (inputs[paramName].tagName == 'INPUT'){
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

export function buildValuesToDisplay(dictValues, value, paramName,  displayValues,tagName){
    logFunctionName('buildValuesToDisplay')

    const currentValue = displayValues.get(paramName);
    currentValue['option_value'] = value;

    if (tagName != "INPUT"){
        const currentParam = dictValues[paramName].find(v => v.VALUE === value)
        currentValue['option_description'] = currentParam.DESCRIPTION;
        }
}

export async function updateFieldInputs(params, inputs, values, displayValues,allOptionsByParameter, options, actualParameter,value,tagName) {
    logFunctionName('updateFieldInputs')

    getProcedures(inputs, allOptionsByParameter, values,options, actualParameter,value,tagName, displayValues)
    let btns = [];
    const allowedOptions = {};
    const allowedParameters = {};
    for (const paramName in inputs) {
        // BUTTON
        if (inputs[paramName].tagName == 'BUTTON'){
            btns.push(inputs[paramName])
        }
        

        allowedOptions[paramName] = new Set();
        allowedParameters[paramName] =[];
    }
    // sprawdzenie enable za pomoca formuly
    for (const paramName in allOptionsByParameter) {
        const paramArray = allOptionsByParameter[paramName];

        if (!inputs[paramName]) continue;

        for (const param of paramArray) {
            let isEnabled =false;
            try{
            isEnabled = await window.FormulaHandler.evaluateFormula(
                param.ENABLE,
                values,
                "paramdict"
            );}
            catch(error){

                showToast('error',`Parametr: ${param.VALUE}.  ${error.message}`)
            }
            // TUTAJ PRZYCISKI DALEJ SIĘ WYŚWIETLAJ
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
        const currentSelect = inputs[paramName];
        
        if (currentSelect.tagName === "INPUT") {
            
        }
        
        const allowed = allowedOptions[paramName];
        if (currentSelect.tagName === 'BUTTON') {
            currentSelect.onclick = function() {
                createDialog(param, allowedParameters[paramName], tempGroupNumber);
            };
        }
    
        for (const child of currentSelect.children) {
            
            const optionValue = child.id.replace(/\s+/g, " ").trim();

            if (!allowed.has(optionValue)) {
                if (!child.classList.contains("hidden")) {
                    child.classList.add("hidden");
                }
                child.disabled = true;
            } else {
                if (child.classList.contains("hidden")) {
                    child.classList.remove("hidden");
                }
                child.disabled = false;
            }
        }
    }
}

export function updateFieldStates(params, inputs, values) {
    logFunctionName('updateFieldStates')

    for (let key in inputs) {
        let param;
        for (let i = 0; i < params.length; i++) {
            if (params[i].NAME === key) {
                param = params[i];
                break;
            }
        }
        if (!param || !param.ENABLE) continue;
        let shouldEnable = false;
        try{
        shouldEnable = window.FormulaHandler.evaluateFormula(
            param.ENABLE,
            values,
            "param"
        );
    }
    catch(error){
                
        showToast('error',error)
    }
        let paramDiv = inputs[key].parentNode;

        paramDiv.hidden = !shouldEnable;
        paramDiv.children[0].innerHTML;
        if (inputs[key].tagName == 'INPUT'){
        validateFormInput(values, inputs[key]);
    }
}
}

export function checkRelated(params, values) {
    logFunctionName('checkRelated')

    let parameters = Object.values(params);

    console.log("checkRelated");
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
