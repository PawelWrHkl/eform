import { DataLoader } from "./dataLoader.js";
import {
    getPossibleValues,
    createInputField,
    validateFormInput,
    updateFieldInputs,

    buildValuesToDisplay,
    getInfoFromDialog,
    findParamFromValues,
    setDescription,
    fillFields
} from "./formTools.js";
import { validateAllFieldsOnSubmit, clearDisabledValues } from "./validateUtils.js";
import { updateFieldStates } from "./updateFieldsAndValues.js";

import { showToast } from "../components/toast.js";
import { createElement, isEnabled } from "../components/htmlManipulator.js";





export class SourceWindow {
    constructor(typ, onSaveCallback) {
        this.TYP = typ;
        this.onSaveCallback = onSaveCallback; 
        this.modal = null;
        this.data = null;
        this.allOptionsByParameter = null;
        this.sourceValues = {};
        this.sourceDisplayValues = new Map(); 
        this.sourceValidators = {};
    }

    async init(catalog, param) {
        this.catalog = catalog;
        this.param = param;

        await this.loadData(catalog, param);


    }

    async show() {

        const photoFile = this.getPhotoPath(this.catalog);
        this.renderModal(photoFile);
        this.attachEvents();
        this.runSlopeProcedures();
        this.validateAllSlopeInputs();
    }

    async loadData() {

        const slopeLoader = new DataLoader();
        const ver = await this.getLegacySlopeVer()
        await slopeLoader.init(ver, this.param.SOURCE, document.documentElement.lang);
        this.data = await slopeLoader.parseData();
        
        this.allOptionsByParameter = slopeLoader.convertDictValues(this.data.dictValues);

        this.createObject();
    }
    async getLegacySlopeVer() {

        const response = await fetch(`/position/version/${this.param.NAME}`);
        const data = await response.json();
        return data.version
    }
    getPhotoPath() {
        
        return `/photos/${this.catalog}/TYP/${this.TYP}.jpg`;
    }

    createObject() {
        for (const [key, value] of Object.entries(this.data.params)) {

            if (value.DESCRIPTION && value.ENABLE !== null) {
                
                this.sourceValues[value.NAME] = '';
                
                
                this.sourceValues[value.NAME + '___DICT'] = false;
                this.sourceValues[value.NAME + '___VISIBLE'] = true;
                this.sourceValues[value.NAME + '___TITLE'] = value.DESCRIPTION || value.NAME;
                this.sourceValues[value.NAME + '___DESCRIPTION'] = '';
                this.sourceValues[value.NAME + '_ALIAS'] = '';
                this.sourceValues[value.NAME + '_ALIAS___DESCRIPTION'] = '';
            }
        }
    }

    getObject() {
        return this.sourceValues;
    }

    getParameterVisibility() {
        
        const visibility = {};
        if (this.data && this.data.params) {
            this.data.params.forEach(param => {
                if (param.NAME && param.ENABLE !== null) {
                    const isVisible = isEnabled(param.ENABLE, this.sourceValues, 'param');
                    const hasOptions = this.allOptionsByParameter[param.NAME] || false

                    
                    visibility[param.NAME] = {
                        visible: isVisible,
                        hasDict: hasOptions,
                        description: param.DESCRIPTION || param.NAME
                    };
                }
            });
        }
        return visibility;
    }

    /**
     * Przetwarza wartości z SOURCE (slope) na strukturę z meta-polami
     * @returns {Object} - Rozszerzony obiekt z meta-polami
     */
    
    processSourceValues() {
        if (!this.sourceValues || typeof this.sourceValues !== 'object') {
            return this.sourceValues;
        }

        const processedValues = {};
        const visibility = this.getParameterVisibility();

        
        const paramsMap = {};
        if (Array.isArray(this.data.params)) {
            this.data.params.forEach(param => {
                if (param.NAME) {
                    paramsMap[param.NAME] = param;
                }
            });
        }

        
        const visibleParams = Object.keys(visibility).filter(key => visibility[key] && visibility[key].visible);

        
        const enabledParams = visibleParams.filter(key => {
            const param = this.data.params.find(p => p.NAME === key);
            return param && param.ENABLE !== null;
        });

        const allParams = new Set([
            ...Object.keys(this.sourceValues).filter(key => {
                
                if (key.includes('___') || key.includes('_ALIAS')) return false;

                
                const param = this.data.params.find(p => p.NAME === key);
                return param && param.ENABLE !== null;
            }),
            ...enabledParams 
        ]);

        
        for (const subParamName of allParams) {
            
            const paramDef = this.data.params.find(p => p.NAME === subParamName);
            if (!paramDef || paramDef.ENABLE === null) {
                continue;
            }

            const subParamValue = this.sourceValues[subParamName];

            
            processedValues[subParamName] = subParamValue || '';

            
            if (subParamValue && subParamValue !== '') {

                const paramOptions = this.allOptionsByParameter?.[subParamName];
                if (paramOptions && Array.isArray(paramOptions)) {

                    const foundOption = paramOptions.find(opt => opt.VALUE === subParamValue);

                    if (foundOption) {
                        
                        if (foundOption.ALIAS) {
                            processedValues[`${subParamName}_ALIAS`] = foundOption.ALIAS;
                            processedValues[`${subParamName}_ALIAS___DESCRIPTION`] = foundOption.ALIAS_DESCRIPTION || '';
                        } else {
                            processedValues[`${subParamName}_ALIAS`] = '';
                            processedValues[`${subParamName}_ALIAS___DESCRIPTION`] = '';
                        }

                        
                        processedValues[`${subParamName}___DESCRIPTION`] = foundOption.DESCRIPTION || '';
                    } else {
                        
                        processedValues[`${subParamName}_ALIAS`] = '';
                        processedValues[`${subParamName}_ALIAS___DESCRIPTION`] = '';
                        processedValues[`${subParamName}___DESCRIPTION`] = '';
                    }
                } else {

                    
                    processedValues[`${subParamName}_ALIAS`] = '';
                    processedValues[`${subParamName}_ALIAS___DESCRIPTION`] = '';
                    processedValues[`${subParamName}___DESCRIPTION`] = '';
                }

                
                const paramVisibility = visibility[subParamName];


                
                if (paramVisibility) {
                    processedValues[`${subParamName}___DICT`] = !!paramVisibility.hasDict;
                } else {
                    
                    const dictValue = !!(paramOptions && paramOptions.length > 0);
                    processedValues[`${subParamName}___DICT`] = !!dictValue;
                    
                }

                
                const sourceParam = paramsMap[subParamName];
                processedValues[`${subParamName}___TITLE`] = sourceParam?.DESCRIPTION || subParamName;
                processedValues[`${subParamName}___VISIBLE`] = paramVisibility ? paramVisibility.visible : true;
            } else {
                
                processedValues[`${subParamName}_ALIAS`] = '';
                processedValues[`${subParamName}_ALIAS___DESCRIPTION`] = '';
                processedValues[`${subParamName}___DESCRIPTION`] = '';

                
                const paramVisibility = visibility[subParamName];

                
                

                
                if (paramVisibility) {

                    processedValues[`${subParamName}___DICT`] = !!paramVisibility.hasDict;

                } else {
                    
                    processedValues[`${subParamName}___DICT`] = false;
                    
                }

                
                const sourceParam = paramsMap[subParamName];
                processedValues[`${subParamName}___TITLE`] = sourceParam?.DESCRIPTION || subParamName;
                processedValues[`${subParamName}___VISIBLE`] = paramVisibility ? paramVisibility.visible : true;
            }

        }

        return processedValues;
    }
    renderModal(photoFile) {

        this.modal = createElement('div', { id: 'slope-modal', class: ['modal', 'show'], style: 'display: block;', tabindex: '-1' }, document.body);


        const dialog = createElement('div', { class: ['modal-dialog'] }, this.modal);
        const content = createElement('div', { class: ['modal-content'] }, dialog);

        
        const header = createElement('div', { class: ['modal-header'] }, content);
        createElement('h3', { text: `${this.param.DESCRIPTION}`, class: ['modal-title'] }, header);

        
        const body = createElement('div', { class: ['modal-body'] }, content);
        createElement('img', {
            src: photoFile,
            alt: 'SLOPE',
            class: ['slope-image'],
            onerror: (e) => {
                
                
                
                
                try {
                    const img = e.target;

                    
                    if (img.dataset._fallbackAttempted) {
                        const placeholder = document.createElement('div');
                        placeholder.className = 'img-placeholder img-fluid mb-4 ';
                        placeholder.textContent = 'Brak zdjęcia';
                        img.parentNode.replaceChild(placeholder, img);
                        return;
                    }

                    
                    img.dataset._fallbackAttempted = '1';

                    
                    const clone = img.cloneNode(true);
                    
                    clone.onerror = null;
                    clone.removeAttribute('onerror');

                    
                    clone.onerror = () => {
                        
                        clone.onerror = null;
                        const placeholder = document.createElement('div');
                        placeholder.className = 'img-placeholder img-fluid mb-4';
                        placeholder.textContent = 'Brak zdjęcia';
                        if (clone.parentNode) clone.parentNode.replaceChild(placeholder, clone);
                    };

                    
                    clone.src = `/photos/${this.catalog}/TYP/${this.TYP}.png`;

                    
                    if (img.parentNode) img.parentNode.replaceChild(clone, img);
                } catch (err) {
                    
                    try {
                        const target = e && e.target;
                        if (target) {
                            target.onerror = null;
                            target.removeAttribute && target.removeAttribute('onerror');
                        }
                    } catch (ignore) { }
                }
            }
        }, body);

        const typParam = this.data.params.find(p => p.NAME === 'TYP');
        const typInfo = typParam?.INFO;
        if (typInfo && typInfo !== '<NULL>' && typInfo.trim() !== '') {
            const infoBar = createElement('div', { class: ['slope-info-bar'] }, body);
            createElement('span', { class: ['slope-info-icon'], text: 'i' }, infoBar);
            const normalizedInfo = typInfo.replace(/\\n/g, '\n').replace(/\n/g, '<br>');
            createElement('span', { html: normalizedInfo }, infoBar);
        }

        
        const form = createElement('form', { id: 'slope-form', class: ['slope-form'] }, body);

        
        let row;
        
        const values = {};
        const enabledParams = {};
        this.data.params.forEach((param, idx) => {

            if (idx % 2 === 0) {
                row = createElement('div', { class: ['row', 'mb-3'] }, form);
            }
            if (param.DESCRIPTION) {
                const col = createElement('div', { class: ['col-12', 'col-md-6'] }, row);
                createElement('label', { text: param.DESCRIPTION, for: param.NAME, class: ['form-label'] }, col);
                let input = createElement('input', { class: ['form-control', 'source-input'], type: 'number', id: param.NAME, name: param.NAME, value: param?.VALUE || '' }, col);
                if (param.NAME == 'TYP') {
                    input.type = 'text'
                    input.value = this.TYP;
                    input.disabled = true;
                    this.sourceValues['TYP'] = this.TYP;
                } else if (this.sourceValues[param.NAME] !== undefined && this.sourceValues[param.NAME] !== '') {
                    input.value = this.sourceValues[param.NAME];
                }
                


                if (!isEnabled(param.ENABLE, this.sourceValues, 'param')) {
                    
                    col.style.display = 'none';
                } else {
                    enabledParams[param.NAME] = true;
                    col.style.display = 'grid';
                }
            }

            
            if (idx % 2 === 1 || idx === this.data.params.length - 1) {
                
                const cols = row.querySelectorAll('.col-12');
                const allHidden = Array.from(cols).every(col => col.style.display === 'none');

                if (allHidden) {
                    row.style.display = 'none';
                } else {
                    row.style.display = '';
                }
            }
        });

        
        const buttonsContainer = createElement('div', { class: ['modal-footer'] }, content);
        this.createButtons(buttonsContainer);
    }

    createButtons(container) {
        
        createElement('button', {
            type: 'button',
            class: ['cancel-btn'],
            text: t('order.cancel'),
            onclick: () => this.close()
        }, container);

        createElement('button', {
            id: 'dialog-confim',
            type: 'btn',
            class: ['submit-btn'],
            text: t('order.confirm'),
            onclick: () => this.processForm()
        }, container);
    }

    attachEvents() {
        console.log('🔴 attachEvents START');
        
        const form = document.getElementById('slope-form');
        console.log('🔴 slope-form znaleziony:', !!form);
        if (!form) return;
        form.onsubmit = (e) => this.handleSubmit(e, form);

        
        console.log('🔴 Wywoływam attachInputListeners');
        this.attachInputListeners();
        console.log('🔴 attachEvents END');
    }

    attachInputListeners() {
        
        const inputs = this.getInputsFromDOM();
        console.log('Inputy do podłączenia:', inputs);
        for (const paramName in inputs) {
            const input = inputs[paramName];
            console.log(`Podłączam listener do: ${paramName}`);
            
            input.addEventListener('input', () => {
                console.log(`Zmiana wartości: ${paramName}`, input.value);
                this.onFieldChange(paramName);
            });
        }
    }


    runSlopeProcedures() {
        const savedValidators = window.inputsValidators;
        const savedDefaults = window.inputsDefaults;
        const savedActualParam = window.actualParam;
        const savedActualValue = window.actualValue;
        const savedFormulaContext = window.formulaContext;
        const savedConstValues = window.constValues;

        window.inputsValidators = {};
        window.inputsDefaults = {};

        for (const param of this.data.params) {
            const paramName = param.NAME;
            const currentValue = this.sourceValues[paramName];

            if (currentValue === undefined || currentValue === null || currentValue === '') continue;

            const options = this.allOptionsByParameter[paramName];
            if (!options || !Array.isArray(options)) continue;

            const selectedOption = options.find(opt => String(opt.VALUE) === String(currentValue));
            if (!selectedOption || !selectedOption.PROC) continue;

            window.actualParam = paramName;
            window.actualValue = String(currentValue);

            if (!window.inputsValidators[paramName]) {
                window.inputsValidators[paramName] = {};
            }
            if (!window.inputsValidators[paramName][window.actualValue]) {
                window.inputsValidators[paramName][window.actualValue] = {};
            }

            try {
                window.FormulaHandler.evaluateFormula(
                    selectedOption.PROC,
                    { ...this.sourceValues },
                    "PROCEDURE"
                );
            } catch (error) {
                console.error(`Slope PROC error for ${paramName}/${currentValue}:`, error);
            }
        }

        this.sourceValidators = JSON.parse(JSON.stringify(window.inputsValidators));

        window.inputsValidators = savedValidators;
        window.inputsDefaults = savedDefaults;
        window.actualParam = savedActualParam;
        window.actualValue = savedActualValue;
        window.formulaContext = savedFormulaContext;
        window.constValues = savedConstValues;
    }

    findSlopeValidatorsForInput(paramName) {
        const result = [];
        const valueStrings = Object.values(this.sourceValues).map(v => String(v));

        for (const [param, models] of Object.entries(this.sourceValidators)) {
            for (const [model, validators] of Object.entries(models)) {
                if (valueStrings.includes(model) && Object.keys(validators).length !== 0) {
                    result.push(validators);
                }
            }
        }
        return result;
    }

    validateSlopeInput(paramName) {
        const input = document.getElementById(paramName);
        if (!input || input.type !== 'number' || input.disabled) return true;

        const validatorList = this.findSlopeValidatorsForInput(paramName);

        const labelId = `${paramName}-slope-label`;
        const existingLabel = document.getElementById(labelId);
        if (existingLabel) existingLabel.remove();

        input.classList.remove('invalid-input');

        let min = 0;
        let max = Infinity;
        let hasValidators = false;

        validatorList.forEach(validator => {
            const vMin = validator[paramName]?.MIN;
            const vMax = validator[paramName]?.MAX;
            if (vMin !== undefined) { min = Math.max(min, vMin); hasValidators = true; }
            if (vMax !== undefined) { max = Math.min(max, vMax); hasValidators = true; }
        });

        if (!hasValidators) return true;

        input.setAttribute('min', min);
        if (max < Infinity) input.setAttribute('max', max);

        const label = document.createElement('label');
        label.id = labelId;
        label.setAttribute('for', paramName);
        label.textContent = `min: ${min} - max: ${max !== Infinity ? max : '∞'}`;

        const value = parseFloat(input.value);

        if (input.value !== '' && !isNaN(value) && (value < min || value > max)) {
            input.classList.add('invalid-input');
            label.classList.add('invalid-label');
            input.parentNode.appendChild(label);
            return false;
        } else {
            label.classList.add('slope-range-label');
            input.parentNode.appendChild(label);
            return true;
        }
    }

    validateAllSlopeInputs() {
        let allValid = true;
        const inputs = this.getInputsFromDOM();

        for (const paramName in inputs) {
            if (inputs[paramName].disabled) continue;
            if (!this.validateSlopeInput(paramName)) {
                allValid = false;
            }
        }
        return allValid;
    }

    close() {
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        if (this.backdrop) {
            this.backdrop.remove();
            this.backdrop = null;
        }
    }

    getInputsFromDOM() {
        const inputs = {};
        document.querySelectorAll('.source-input').forEach(input => {
            inputs[input.id] = input;
        });
        return inputs;
    }

    onFieldChange(paramName) {
        const input = document.getElementById(paramName);
        const param = this.data.params.find(p => p.NAME === paramName);

        if (input && param) {
            
            if (!isNaN(input.value) && input.value.trim() !== '') {
                this.sourceValues[paramName] = parseInt(input.value);
            } else {
                this.sourceValues[paramName] = input.value;
            }

            this.runSlopeProcedures();
            this.validateAllSlopeInputs();
        }
    }
    processForm() {
        if (!this.validateAllSlopeInputs()) {
            showToast(t('form.validation_error') || 'Sprawdź poprawność wartości', 'error');
            return;
        }
        let inputs = document.querySelectorAll('.source-input');
        inputs.forEach(input => {
            console.log(this.sourceValues, "SPRAWDZAMOCOCHODZI1")
            if (input.id in this.sourceValues) {

                if (!isNaN(input.value) && input.value.trim() !== '') {
                    
                    this.sourceValues[input.id] = parseInt(input.value);
                }
                else {
                    this.sourceValues[input.id] = input.value;
                    
                }

                
                if (!!input.value) {
                    this.sourceDisplayValues[this.sourceValues[`${input.id}___TITLE`]] = input.value;
                }
            }

        });

        
        if (typeof this.onSaveCallback === 'function') {
            this.onSaveCallback(this.sourceValues);
        }

        this.close();
    }
    setTyp(typ) {
        this.TYP = typ;
        this.sourceValues['TYP'] = typ
    }
}

