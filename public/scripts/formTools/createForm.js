import { logFunctionName, searchForParameter } from './formTools.js';
import { createDialog } from './dialogUtils_copy.js'
import { isEnabled, createElement } from '../components/htmlManipulator.js';
import { createInfoIcon } from '../components/info.js';
import { SourceWindow } from './slope.js';
import { attachmentBehaviorOnClick, changeAttachmentAppearance, resetAttachmentUI } from './attachment.js';
import { showToast } from '../components/toast.js';

export function processCommissionInput(labelValue = false) {
    logFunctionName('processCommissionInput')

    const hiddenClass = document.querySelector('.asortment-container');
    hiddenClass.style.setProperty('display', 'block', 'important');
}

/** A param whose value is produced automatically (by FORMULA or SOURCE script), not typed by the user. */
export function isCalculatedParam(param) {
    if (!param) return false;
    const hasFormula = param.FORMULA && param.FORMULA !== '<NULL>';
    const hasSource = param.SOURCE && param.SOURCE !== '<NULL>' && param.SOURCE !== param.NAME;
    return !!(hasFormula || hasSource);
}

/** Whether a param is currently in manual-override mode (user typed value, calc ignored). */
export function isManualOverride(paramName) {
    return !!(window.manualParams && window.manualParams.has(paramName));
}

/**
 * Force a numeric <input> to accept whole numbers only — no decimals.
 * Idempotent: safe to call multiple times on the same input.
 */
export function enforceIntegerInput(input) {
    if (!input || input._intEnforced) return;
    input._intEnforced = true;
    input.step = '1';
    input.inputMode = 'numeric';
    input.addEventListener('input', function () {
        // Keep digits and a single leading minus; strip decimal points and anything else.
        let sanitized = this.value.replace(/[^0-9-]/g, '').replace(/(?!^)-/g, '');
        if (sanitized !== this.value) this.value = sanitized;
    });
    input.addEventListener('keydown', function (event) {
        if (['.', ',', 'e', 'E', '+'].includes(event.key)) {
            event.preventDefault();
        }
    });
}

/**
 * MULTI + calculated params get a checkbox that lets the user override the computed value.
 * Checked  → input becomes an editable numeric field; recalculation ignores this param.
 * Unchecked → input goes back to read-only calculated mode and is recomputed.
 */
function createManualOverrideToggle(param, input, parrent) {
    if (!(window.currentUserIdent ?? '').toUpperCase().startsWith('KN_')) return;
    if (!window.manualParams) window.manualParams = new Set();

    // Range hint shown above the checkbox when a manually typed value fails min/max validation.
    const rangeHint = createElement('div', { class: ['manual-range-hint'] }, parrent);
    rangeHint.style.display = 'none';
    input._manualHint = rangeHint;

    const row = createElement('div', { class: ['manual-override-row'] }, parrent);
    const checkbox = createElement('input', {
        type: 'checkbox',
        id: `${param.NAME}__manual`,
        class: ['manual-override-checkbox']
    }, row);
    createElement('label', {
        for: `${param.NAME}__manual`,
        text: t('form.manual_override'),
        class: ['manual-override-label']
    }, row);

    const enableManual = () => {
        window.manualParams.add(param.NAME);
        input.disabled = false;
        input.readOnly = false;
        input.type = 'number';
        enforceIntegerInput(input);
        input.classList.add('manual-active');
        input.focus();
    };

    const disableManual = () => {
        window.manualParams.delete(param.NAME);
        input.disabled = true;
        input.classList.remove('manual-active', 'invalid-input');
        rangeHint.style.display = 'none';
        rangeHint.textContent = '';
        if (typeof window.recalcManualParam === 'function') {
            window.recalcManualParam(param.NAME);
        }
    };

    checkbox.addEventListener('change', () => {
        checkbox.checked ? enableManual() : disableManual();
    });

    return checkbox;
}

export async function getPossibleValues(dictValues, values) {
    logFunctionName('getPossibleValues')
    const possibleElements = [];
    if (!dictValues || dictValues.length === 0) {
        return { possibleElements };
    }

    for (let i = 0; i < dictValues.length; i++) {
        let row = dictValues[i];
        if (row.VALUE == '-' || row.VALUE == '=' || row.VALUE == '') { continue };
        if (! await isEnabled(row.ENABLE, values)) { continue }
        if (row.VALUE == "<NULL>") row.VALUE = null;
        if (row.DESCRIPTION == "<NULL>") row.DESCRIPTION - null;
        let row_number = row.ROW_NUM;
        possibleElements.push(row);
    }
    
    return { possibleElements };
}

export function createInputField(param, options, groupNumber, filters, allOptions, values, attrs = [], parrent = null) {

    logFunctionName('createInputField')

    options = options.possibleElements;

    const createLabelWithInfo = () => {
        const labelWrapper = createElement('div', { class: ['field-label-row'] }, parrent);
        createElement('label', { text: `${param.DESCRIPTION} ` }, labelWrapper);

        createInfoIcon({
            info: param?.INFO,
            parent: labelWrapper,
            defaultLabel: t('Dodatkowe informacje'),
            infoStyle: 'i',
            downloadLabel: t('Pobierz')
        });
    }

    if (param.SOURCE == param.NAME) {
        createLabelWithInfo();

        let btn = createElement("button", {
            class: ["button"],
            id: param.NAME,
            type: 'button',
            html: `${t('Uzupełnij')}`,
            onclick: async function () {
                await param.modal.show()
            }
        }, parrent);
        parrent.appendChild(createElement('br'));
        return btn;
    }

    if (param.GRAPHICS == 'true' && Array.isArray(options) && (param.TYPE != 'link')) {
        createLabelWithInfo();
        let btn = createElement("button", {
            class: ["button"],
            id: param.NAME,
            type: 'button',
            text: param.DEFAULT != '<NULL>'
                ? (param.DEFAULT == '<NONE>'
                    ? ` ${options.find(val => val.VALUE == param.DEFAULT)?.DESCRIPTION}`
                    : `${options.find(val => val.VALUE == param.DEFAULT)?.VALUE}-${options.find(val => val.VALUE == param.DEFAULT)?.DESCRIPTION}`)
                : `${t('form.check_word')}`
        }, parrent);


        btn.addEventListener('click', function () {
            createDialog(param, options, groupNumber, filters[param.NAME], attrs);
        });

        parrent.appendChild(createElement('br'));
        return btn;
    }
    if (allOptions?.length ?? 0 > 1) {
        createLabelWithInfo();

        let select = createElement("select", { class: ["select"] }, parrent);

        select.appendChild(new Option(t('form.check_option'), ""));


        const seenOptions = new Set();
        for (let idx = 0; idx < allOptions.length; idx++) {
            let row = allOptions[idx];
            const optionKey = `${row.ROW_NUM}-${row.VALUE}`;


            if (seenOptions.has(optionKey)) {
                continue;
            }
            seenOptions.add(optionKey);

            let optionText;

            if (row?.ALIAS) {
                optionText = `${row.ALIAS} ${row.ALIAS_DESCRIPTION}`;
            }
            else {
                optionText = `${row.VALUE} ${row.DESCRIPTION}`;
            }
            let option = new Option(optionText || row.VALUE, row.VALUE);
            option.id = `${row.ROW_NUM}-${param.NAME}`;
            option.dataset.alias = row.ALIAS || '';
            option.dataset.aliasDescription = row.ALIAS_DESCRIPTION || '';
            if (!isEnabled(row.ENABLE, values)) {
                option.style.display = 'none'
            }
            select.appendChild(option);
        }
        parrent.appendChild(createElement('br'));
        return select;
    }

    let input = createElement("input", { class: ["input-form"] }, null);

    if (param.TYPE === "numeric") {
        input.type = "number";
        enforceIntegerInput(input);
    }
    else {
        input.type = "text";
    }

    if (param.FORMULA != "<NULL>") {
        input.type = "text";
    }
    if (param.TYPE === 'link') {
        const linkBtn = createElement("a", {
            href: param.URL || "#",
            text: param.DESCRIPTION || "Otwórz",
            class: ["link-btn", "tiny-link-btn"],
            value: param.NAME,
            rel: "noopener noreferrer"
        }, parrent);

        setTimeout(() => {
            const parentDiv = document.querySelector(`.${param.NAME}-select-area`);
            if (parentDiv) {
                parentDiv.classList.remove(`${param.NAME}-select-area`);
                parentDiv.classList.add('link-area');
            }
        }, 0);
        createLabelWithInfo();
        parrent.appendChild(createElement('br'));
        return linkBtn;
    }
    if (param.TYPE === 'file') {
        param.REQUIRED = false;
        input.classList.remove("input-form");
        input.classList.add("file-input");
        input.style.display = 'none';
        const attachmentContainer = document.getElementById('attachment-container');
        const attachmentsLabel = document.querySelector('.attachment-label');
        console.log(attachmentsLabel.textContent, 'labelka załączników')
        if (attachmentsLabel.textContent == '') {
            attachmentsLabel.textContent = t('form.attachments_label')
        }
        const attachmentItemWrapper = createElement('div', {
            class: ['attachment-item-wrapper']
        }, attachmentContainer);


        const fileIcon = createElement('button', {
            type: 'button',
            class: ['file-upload-icon', 'has-tooltip'],
            title: 'Kliknij aby wybrać plik',
        }, attachmentItemWrapper);

        const attachmentImage = createElement('img', { src: '/img/attachment.png', class: ['icon'], alt: 'Załącznik', width: '24', height: '24' }, fileIcon);

        fileIcon.dataset.tooltip = `${param.DESCRIPTION}`
        fileIcon.addEventListener('click', (e) => {
            e.preventDefault();
            input.click();
        });


        const removeBtn = createElement('button', {
            type: 'button',
            class: ['file-remove-btn'],
            id: `${param.NAME}-remove-btn`,
            text: '✕',
            title: 'Usuń załącznik'
        }, attachmentItemWrapper);
        removeBtn.dataset.paramName = param.NAME;
        removeBtn.style.display = 'none';
        removeBtn.addEventListener('click', (e) => {
            const fileName = input.dataset.filename;
            if (fileName && Array.isArray(window.attachments)) {
                window.attachments = window.attachments.filter(name => name !== fileName);
            }
            attachmentBehaviorOnClick(input, attachmentImage, fileIcon, removeBtn, param, e);
        });

        input.type = "file";
        input.name = param.NAME;
        input.id = param.NAME;
        console.log(`✅ Tworzę file input: name="${param.NAME}", id="${param.NAME}"`, input);



        Object.defineProperty(input, 'value', {
            get() {
                if (this.files && this.files.length > 0) {
                    return this.files[0].name;
                }
                return this._fileInputValue || '';
            },
            set(val) {

                if (val === '') {
                    this._fileInputValue = '';
                }

            },
            configurable: true
        });

        input.addEventListener('change', function () {
            const file = input?.files?.[0];


            const applied = changeAttachmentAppearance(input, attachmentImage, fileIcon, removeBtn, param, 10);
            if (applied && file) {

                if (!Array.isArray(window.attachments)) {
                    window.attachments = [];
                }
                window.attachments.push(file.name);


                if (window.values && input.name) {
                    window.values[input.name] = file.name;
                }
                if (window.displayValues && input.name) {
                    const currentValue = window.displayValues.get(input.name) || {};
                    currentValue.option_value = file.name;
                    currentValue.option_description = '';
                    window.displayValues.set(input.name, currentValue);
                }
            }
        });

        attachmentItemWrapper.appendChild(input);
        return input
    }

    createLabelWithInfo();
    parrent.appendChild(input);
    if (param.MULTI == 'true' && isCalculatedParam(param)) {
        createManualOverrideToggle(param, input, parrent);
    }
    parrent.appendChild(createElement('br'));
    return input;


}

export function fillFields(displayValues, inputs, values) {

    for (let input of Object.values(inputs)) {
        if (!input?.name || isParamLocked(input.name, displayValues)) continue;
        const tag = input.tagName
        const labelData = displayValues.get(input.name)
        console.log('Filling field:', input.name, 'with value from displayValues:', labelData);
        if (values[input.name] == "<NONE>") {
            let description = input?.name + '___DESCRIPTION' || '';

            if (labelData) {
                labelData.option_description = values[description];
                input.textContent = `${labelData.option_description}`;
            } else {
                console.warn(`labelData is undefined for input: ${input.name}`);
            }

        }
        else if (input) {

        }
        switch (tag) {
            case "BUTTON":
                if (labelData?.option_value) {
                    input.textContent = `${labelData.option_value} - ${labelData.option_description}`;
                } else if (labelData?.option_value == ' ') {
                    input.textContent = `${labelData.option_description}`;
                }
                break;
            case "INPUT":
                if (input.type !== 'file') {
                    input.value = labelData?.option_value || labelData?.option_description || fillCalculated(values, input);
                }
                break;
            case "SELECT": {
                const targetValue = labelData?.option_value || labelData?.option_description;
                if (targetValue) {
                    const matchingOption = Array.from(input.options).find(o => o.value === targetValue)
                        || Array.from(input.options).find(o => o.dataset.alias === targetValue);
                    if (matchingOption) {
                        matchingOption.selected = true;
                    } else {
                        input.value = targetValue;
                    }
                } else {
                    const calculated = fillCalculated(values, input);
                    if (calculated !== undefined) input.value = calculated;
                }
                break;
            }
        }

    }
}

function fillCalculated(values, input) {
    if (values[input.name] != '') {
        return parseFloat(values[input.name])
    }

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

export function checkIfParamHidden(formula, values, param) {
    let isEnabled = false;
    try {
        isEnabled = window.FormulaHandler.evaluateFormula(
            formula,
            values,
            "param",
            param
        );
        if (param.SOURCE != "<NULL>" && param.NAME != param.SOURCE && !shouldEnable) {
            window.skipCountParams.push(param.NAME)
        }

        if (shouldEnable == 'password') { shouldEnable = false }


    }
    catch (error) {



        showToast('error', `Error:  ${error.message}`)
    }
    return isEnabled;
}


/** Row-2 / listsum regular prices hidden (SUB-only view). Matches order.njk rules. */
export function shouldHideRegularPriceRow(isRowTwo) {
    if (!isRowTwo) return false;
    if (window.isGroupShop || window.isClient || window.hidePrices) return true;
    if (window.hasSubPriceToggle && !window.showCatalogPrices) return true;
    return false;
}

/** Whether current user context should ever see SUB___ price fields. Matches order.njk. */
export function canUserSeeSubPrices() {
    if (window.isGroup || window.isGroupShop || window.isClient) return true;
    if (window.hasSubPriceToggle) return true;
    return false;
}

/** Detect password-protected params from ENABLE (HASLO) — merge, never drop saved locked. */
export function syncLockedParamsFromEnableFormulas(params, values, displayValues) {
    if (!window.FormulaHandler || !params || !values) return;
    if (!window.lockedParams) window.lockedParams = [];

    const preserved = new Set(window.lockedParams);
    if (displayValues) {
        for (const [key, val] of displayValues) {
            if (val?.locked) {
                preserved.add(key);
                if (!key.startsWith('SUB___')) preserved.add('SUB___' + key);
            }
        }
    }

    for (const param of params) {
        if (!param?.NAME || !param.ENABLE || param.ENABLE === '<NULL>') continue;
        try {
            const result = window.FormulaHandler.evaluateFormula(
                param.ENABLE,
                values,
                'param',
                param.NAME
            );
            if (result === 'password') {
                preserved.add(param.NAME);
                if (!param.NAME.startsWith('SUB___')) {
                    preserved.add('SUB___' + param.NAME);
                }
            }
        } catch (_) { /* ignore — uid/context may be incomplete */ }
    }

    window.lockedParams = [...preserved];
}

/** Force-hide all password-locked param rows in the DOM. */
export function hideLockedParamRows(params, inputs) {
    if (!params || !inputs) return;
    for (const param of params) {
        if (!param?.NAME) continue;
        if (!isParamLocked(param.NAME)) continue;
        const input = inputs[param.NAME];
        if (input?.parentNode) {
            input.parentNode.style.display = 'none';
            delete window.enabledParams[param.NAME];
        }
    }
}

/** Restore lockedParams from saved displayValues (incl. SUB___ mirror of base param). */
export function restoreLockedParamsFromDisplayValues(displayValues) {
    if (!displayValues) return;
    if (!window.lockedParams) window.lockedParams = [];
    for (const [key, val] of displayValues) {
        if (!key || !val?.locked || window.lockedParams.includes(key)) continue;
        window.lockedParams.push(key);
    }
    for (const [key, val] of displayValues) {
        if (!key || !val?.locked || key.startsWith('SUB___')) continue;
        const subKey = 'SUB___' + key;
        if (displayValues.has(subKey) && !window.lockedParams.includes(subKey)) {
            window.lockedParams.push(subKey);
        }
    }
}

/** Password-protected param — must stay hidden in the form UI. */
export function isParamLocked(paramName, displayValues = window.formDisplayValues) {
    if (!paramName || typeof paramName !== 'string') return false;
    if (window.lockedParams?.includes(paramName)) return true;
    if (displayValues?.get?.(paramName)?.locked) return true;
    if (paramName.startsWith('SUB___')) {
        const baseName = paramName.slice(6);
        if (window.lockedParams?.includes(baseName)) return true;
        if (displayValues?.get?.(baseName)?.locked) return true;
    }
    return false;
}

/** SUB___ price fields visible for current user context. Matches order.njk rules. */
export function shouldShowSubPriceField(shouldEnable, isLockedSub) {
    if (!shouldEnable || isLockedSub) return false;
    return canUserSeeSubPrices();
}

export function applySingleParamVisibility(key, param, shouldEnable, inputs) {
    const paramDiv = inputs[key]?.parentNode;
    if (!paramDiv) return;

    if (key.startsWith('SUB___')) {
        const isLockedSub = isParamLocked(key);
        if (shouldShowSubPriceField(shouldEnable, isLockedSub)) {
            paramDiv.style.display = 'grid';
            window.enabledParams[param.NAME] = true;
        } else {
            paramDiv.style.display = 'none';
            delete window.enabledParams[param.NAME];
        }
    } else if (shouldEnable) {
        const isRowTwo = param.LISTROW == '2' || param.LISTSUM == 'true';
        if (shouldHideRegularPriceRow(isRowTwo)) {
            paramDiv.style.display = 'none';
            delete window.enabledParams[param.NAME];
        } else {
            paramDiv.style.display = 'grid';
            window.enabledParams[param.NAME] = true;
        }
    } else {
        paramDiv.style.display = 'none';
        delete window.enabledParams[param.NAME];
    }
}

/** Show SUB___ rows immediately (before ENABLE formula / async scripts finish). */
export function showSubPriceRowsImmediately(params, inputs) {
    if (!canUserSeeSubPrices() || !params || !inputs) return;
    for (const param of params) {
        if (!param?.NAME?.startsWith('SUB___')) continue;
        if (isParamLocked(param.NAME)) continue;
        const input = inputs[param.NAME];
        if (input?.parentNode) {
            input.parentNode.style.display = 'grid';
            window.enabledParams[param.NAME] = true;
        }
    }
}

/** Hide regular prices and show SUB___ rows at recalc start (no flash of regular prices). */
export function applySubPriceLayoutDuringCalc(params, inputs, values, displayValues) {
    syncLockedParamsFromEnableFormulas(params, values, displayValues);
    hideRegularPriceRowsDuringCalc(params, inputs);
    hideLockedParamRows(params, inputs);
    showSubPriceRowsImmediately(params, inputs);
}

/** Hide regular price rows immediately when recalc starts (prevents flash before updateFieldStates). */
export function hideRegularPriceRowsDuringCalc(params, inputs) {
    if (!params || !inputs) return;
    for (const param of params) {
        if (!param?.NAME || param.NAME.startsWith('SUB___')) continue;
        const isRowTwo = param.LISTROW == '2' || param.LISTSUM == 'true';
        if (!shouldHideRegularPriceRow(isRowTwo)) continue;
        const input = inputs[param.NAME];
        if (input?.parentNode) {
            input.parentNode.style.display = 'none';
            delete window.enabledParams[param.NAME];
        }
    }
}

/**
 * Maskuje TEKST wszystkich pól cenowych (row-2/listsum, katalogowych I
 * SUB___, bez względu na to, kto akurat ma je pokazane) na czas trwania
 * przeliczenia — zgłoszenie właściciela: przy wolniejszym łączu widać przez
 * moment „dziwne liczby", bo `updateFieldStates` (updateFieldsAndValues.js)
 * dopisuje każdą wartość do DOM osobno, w miarę jak kolejne asynchroniczne
 * skrypty cenowe (`calculateFromScript`, pricesCalculator.js) się
 * wykonują — na szybkim łączu te kroki mieszczą się w jednej klatce i nikt
 * ich nie widzi, na wolnym każdy krok jest osobno widoczny.
 *
 * ⚠️ Celowo NIE `display: none` na całym wierszu (jak
 * `hideRegularPriceRowsDuringCalc`/`showSubPriceRowsImmediately` obok) —
 * to przełącza WIDOCZNOŚĆ WIERSZA między dwoma stałymi stanami (katalog
 * kontra SUB) i robi to raz na przeliczenie. Tu chodzi o coś innego: sam
 * TEKST liczby ma zniknąć na czas liczenia, a wiersz (i jego miejsce w
 * layoucie) ma zostać dokładnie tam, gdzie był — inaczej przy KAŻDEJ
 * zmianie pola cały panel cen migałby (pojawiał się/znikał) zamiast tylko
 * chwilowo „ciemnieć". Stąd `color: transparent` na samym inpucie
 * (public/styles/form.css `.price-value-masked`), nie zmiana `display`.
 */
export function maskPriceValuesDuringCalc(params, inputs) {
    if (!params || !inputs) return;
    for (const param of params) {
        if (!param?.NAME) continue;
        const isRowTwo = param.LISTROW == '2' || param.LISTSUM == 'true';
        if (!isRowTwo) continue;
        inputs[param.NAME]?.classList.add('price-value-masked');
    }
}

/**
 * Zdejmuje maskę z `maskPriceValuesDuringCalc` — wołane, gdy `updateProcedure`
 * kończy CAŁĄ kolejkę przeliczeń (form.js, `window.isCalculating = false`).
 *
 * ⚠️ Zamiatamy WSZYSTKIE `inputs`, nie tylko te z listy `params` (jak przy
 * maskowaniu) — pola `_S` (specyfikacja ceny, pricesCalculator.js
 * `calculateFromScript`) potrafią dostać maskę „przy okazji": ich element
 * powstaje w trakcie liczenia jako `parentInput.cloneNode(true)`, co kopiuje
 * też klasę CSS rodzica, jeśli akurat była nią oznaczona w chwili klonowania.
 * `_S` nie zawsze jest osobnym wpisem w `params`, więc pętla po `params`
 * tego wpisu by nie odwiedziła i klasa zostałaby na stałe (nieszkodliwie —
 * `_S` i tak ma `display: none` — ale bałaganiąco).
 */
export function unmaskPriceValues(params, inputs) {
    if (!inputs) return;
    for (const key of Object.keys(inputs)) {
        inputs[key]?.classList?.remove('price-value-masked');
    }
}

export function hideLocked(inputs, displayValues) {

    for (const [key, value] of displayValues) {
        if (window.lockedParams.includes(key)) {
            value['locked'] = true
        }
        else {
            value['locked'] = false
        }
    }
    return displayValues
}

export function hideSub(inputs, displayValues) {
    const subParams = window.subParams || [];
    for (const [key, value] of displayValues) {
        value['sub'] = subParams.includes(key);
    }
    return displayValues
}


export function hideParams(params, inputs) {
    for (let param of params) {

        let input = inputs[param.NAME]

        if (param.FORMROW == '0') {
            if (input && input.parentElement) {
                input.parentElement.style.display = 'none'
            }
        }


    }
}

