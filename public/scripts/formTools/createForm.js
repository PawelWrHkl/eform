import { logFunctionName } from './formTools.js';
import { createDialog } from './dialogUtils_copy.js';

export function processCommissionInput() {
    logFunctionName('processCommissionInput')

    const hiddenClass = document.querySelector('.asortment-container');
    hiddenClass.style.setProperty('display', 'block', 'important');
    const label = document.querySelector('label[for="commision-input"]');
    label.innerHTML = 'Pozycja (Komission):';

    const inputElement = document.getElementById('commistion-input');
    if (inputElement) {
        const inputValue = inputElement.value;
        const commissionLabel = document.createElement('h5');
        commissionLabel.textContent = inputValue;
        const parent = inputElement.parentElement;
        parent.replaceChild(commissionLabel, inputElement);

        const saveCommissionButton = document.getElementById('commision-save-btn');
        const editCommissionButton = document.getElementById('commision-edit-btn');
        
        if (saveCommissionButton && saveCommissionButton.parentElement) {
            editCommissionButton.style.display = 'block';
            saveCommissionButton.style.display = 'none';
        }
        
        editCommissionButton.addEventListener('click', function () {
            parent.replaceChild(inputElement, commissionLabel);

            if (editCommissionButton.parentElement) {
                editCommissionButton.style.display = 'none';
                saveCommissionButton.style.display = 'block';
            }
        });
    }

}

export function getPossibleValues(dictValues) {
    logFunctionName('getPossibleValues')
    const possibleElements = [];

    if (!dictValues || dictValues.length === 0) {
        return { possibleElements };
    }

    for (let i = 0; i < dictValues.length; i++) {
        let row = dictValues[i];
        if(row.VALUE == '-' || row.VALUE == '=' || row.VALUE == ''){continue};
        if (row.VALUE == "<NULL>") row.VALUE = null;
        if (row.DESCRIPTION == "<NULL>") row.DESCRIPTION - null;
        let row_number = row.ROW_NUM;
        possibleElements.push(row);
    }

    return { possibleElements };
}

export function createInputField(param, options,groupNumber) {
    logFunctionName('createInputField')

    options = options.possibleElements;
    if (param.GRAPHICS =='true' && Array.isArray(options)){
        let btn = document.createElement("button");
        btn.classList.add("btn", 'color-dialog-btn');
        btn.id= param.NAME;
        btn.type='button';
        btn.innerHTML = `Wybierz ${param.DESCRIPTION}`;

        btn.onclick = function() {
            createDialog(param, options,groupNumber);
        };
        return btn;
    }

    if (options.length > 1) {
        let select = document.createElement("select");
        select.classList.add("select");
        select.appendChild(new Option("Wybierz opcję", ""));
        for (let idx = 0; idx < options.length; idx++) {
            let row = options[idx];

            let optionText = `${row.VALUE} ${row.DESCRIPTION}`;
            let option = new Option(optionText || row.VALUE, row.VALUE);
            option.id = `${row.ROW_NUM}-${param.NAME}`;

            select.appendChild(option);
        }
        return select;
    }

    let input = document.createElement("input");

    if (param.TYPE === "number") {
        input.type = "number";
    } 
    else {
        input.type = "text";
    }
    return input;
}

export function saveOrderPositionToJson(data, filename) {
    logFunctionName('saveOrderPositionToJson')

    const jsonData = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonData], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
