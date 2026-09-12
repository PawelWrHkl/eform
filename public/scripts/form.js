import { DataLoader } from "./formTools/dataLoader.js";
import {
  getPossibleValues,
  createInputField,
  validateFormInput,
  updateFieldInputs,
  convertIntoPercent,
  updateFieldStates,
  resetDependences,
  buildValuesToDisplay,
  getInfoFromDialog,
  findParamFromValues,
  setDescription,
  fillFields,
  setWar,
  roundInputValue,
  fillInputDescription,
  setListRow,
  checkIfOptionsExist,
  getProcedures
} from "./formTools/formTools.js";
import { validateAllFieldsOnSubmit, clearDisabledValues } from "./formTools/validateUtils.js";
import { resetSelectValues } from "./formTools/updateFieldsAndValues.js";
import { SourceWindow } from './formTools/slope.js';
import { applyAttachmentFromServer } from './formTools/attachment.js';
import { showToast } from "./components/toast.js";
import { createElement, isEnabled } from "./components/htmlManipulator.js";
import {
  hideLocked, hideSub, hideParams, shouldHideRegularPriceRow, canUserSeeSubPrices,
  applySubPriceLayoutDuringCalc, showSubPriceRowsImmediately,
  restoreLockedParamsFromDisplayValues, syncLockedParamsFromEnableFormulas,
  isParamLocked, hideLockedParamRows
} from './formTools/createForm.js'
import { AttrLoader } from "./formTools/storage.js";
import { Translator } from "./formTools/fileTranslator.js"
import { stopSpin, startSpin } from "./components/hourglass.js";
import { fillLocalPositionObject } from "./formTools/localStorageManager.js";
import { getUid } from './formTools/getUid.js';
import { generateShortJson } from './formTools/shortJsonGen.js';
import { formatVatRateLabel } from './formTools/vatLabel.js';


export async function generateForm(
  version = null,
  groupNumber = full,
  values = {},
  displayValues = new Map(),
  editFlag = false,
  lang = document.documentElement.lang || 'pl',
  spin = false
) {
  window.finishFlag = false;
  window.skipCountParams = [];
  window.editFlag = editFlag
  window.inputsValidators = {};
  window.inputsDefaults = {}
  window.inputFlags = {};
  window.tempGroupNumber = groupNumber
  window.enabledParams = {};
  window.afterSend = false;
  window.validParams = {};
  window.calculatedParams = new Set();
  window.lastChangedField = null; 
  window.attachments = [];
  window.constValues = {};
  window.lockedParams = [];
  window.subParams = [];
  window.manualParams = new Set();
  window.formDisplayValues = displayValues;
  // TYPE='file' params render their real widget into #attachment-container
  // (see createForm.js), but buildHtml still creates an empty
  // `${param.NAME}-select-area` wrapper div for each one. Those are collected
  // here instead of being appended in param.txt order, so buildVatFields()
  // can append them to #dynamic-form AFTER the VAT fields — otherwise they'd
  // land wherever the attachment param happens to sit in param.txt, ahead of
  // the VAT block that's always built last.
  window.__attachmentAreaDivs = [];
  if (editFlag && displayValues?.size) {
    restoreLockedParamsFromDisplayValues(displayValues);
  }
  window.spin = spin;
  
  window.calculationQueue = [];
  window.uid = '';
  window.isCalculating = false;
  window.isPriceCalculating = false;
  const loader = new DataLoader();
  window.shortJson = {};
  window.translator = new Translator();

  const semafor = new AttrLoader();
  await window.translator.init(groupNumber, lang);
  await loader.init(version, groupNumber, lang)
  await semafor.init(groupNumber)

  const data = await loader.parseData();
  const dictValues = data.dictValues;
  let allOptionsByParameter = loader.convertDictValues(dictValues);


  const calculatedParams = {};
  if (!data) return;

  allOptionsByParameter = await loader.selectCollections(allOptionsByParameter)


  loader.createParameterFilters(allOptionsByParameter);
  const filters = loader.getAllFilters();
  fillLocalPositionObject();
  data.params = await loader.selectPrices(data.params)
  window.params = data.params;
  const params = data.params;
  window.actualParam = '';
  window.actualValue = '';
  if (editFlag) {
    window.uid = await getUid();
    syncLockedParamsFromEnableFormulas(params, values, displayValues);
  }
  const form = document.getElementById("dynamic-form");
  const attachmentContainer = document.getElementById('attachment-container');
  const attachmentsLabel = document.querySelector('.attachment-label');
  const linkContainer = document.createElement("div");
  linkContainer.id = "link-buttons-container";
  let labelNumber = 1;
  const inputs = {};

  let options = {};
  form.innerHTML = "";
  attachmentContainer.innerHTML = '';
  attachmentsLabel.textContent = '';
  for (let i = 0; i < params.length; i++) {
    let param = params[i];
    options = await getPossibleValues(allOptionsByParameter[param.NAME], values);
    await buildHtml(options, param, filters);

  }



  async function buildHtml(options, param, filters) {

    let input;

    const paramName = param.NAME;
    if (!paramName || paramName.startsWith("_") || !param.DESCRIPTION) return;

    // SUB___ params: only visible for group, groupShop, canViewSubPrices, and isClient users
    if (paramName.startsWith('SUB___')) {
      if (!window.isGroup && !window.isGroupShop && !window.canViewSubPrices && !window.viewAsOrganization && !window.isClient) return;
      // go into sub bucket only — NOT locked
      if (!window.subParams.includes(paramName)) window.subParams.push(paramName);
    }

    const isAttachmentParam = param.TYPE === 'file';
    const div = createElement('div', { class: [`${param.NAME}-select-area`] }, isAttachmentParam ? null : form);
    if (isAttachmentParam) {
      window.__attachmentAreaDivs.push(div);
    }

    if (param.SOURCE == param.NAME) {
      param.modal = new SourceWindow(1, (sourceValues) => {
        values[param.NAME] = param.modal.processSourceValues();
        buildValuesToDisplay(allOptionsByParameter, param.modal.sourceDisplayValues, param.NAME, displayValues, 'BUTTON');

        inputFlags[paramName] = true;
        validParams[paramName] = true;
        enabledParams[paramName] = true;
        const dv = displayValues.get(param.NAME);
        if (dv) {
          inputs[param.NAME].value = param.modal.sourceDisplayValues;
          inputs[param.NAME].innerText = `${dv.option_description || ''}`;

        }

        updateProcedure({
          params,
          inputs,
          values,
          displayValues,
          allOptionsByParameter,
          options,
          name: param.NAME,
          value: param.modal.sourceDisplayValues,
          groupNumber,
          tagName: '',
          filters,
          calculatedParams,
          flags: { updateInputs: false, buildValues: false, updateStates: true }
        });
      });

      try {
        await param.modal.init(param.SOURCE, param);

        
        if (editFlag && values[param.NAME]) {
          
          Object.assign(param.modal.sourceValues, values[param.NAME]);

          
          if (values[param.NAME].TYP) {
            param.modal.setTyp(values[param.NAME].TYP);
          }
        }

        input = createInputField(param, options, groupNumber, filters, allOptionsByParameter[param.NAME], values, semafor.attrValues, div);
      } catch (err) {
        console.error(err);
        return;
      }
    }

    else {

      input = createInputField(param, options, groupNumber, filters, allOptionsByParameter[param.NAME], values, semafor.attrValues, div);
    }


    input.name = param.NAME;
    input.id = param.NAME;

    if (param.TYPE === 'file' && editFlag) {

      console.log(param.NAME, values[param.NAME])
      if (values[param.NAME]) {
        window.attachments.push(values[param.NAME]);

        const orderIdElement = document.getElementById('orderId');
        const posIdElement = document.getElementById('positionId');

        if (orderIdElement && posIdElement) {
          const orderId = orderIdElement.textContent;
          const posId = posIdElement.textContent;
          const fileName = values[param.NAME];
          console.log('Sprawdzam załącznik z serwera:', fileName);
          await applyAttachmentFromServer(input, fileName, orderId, posId, params);
        }
      }
    }

    inputs[param.NAME] = input;
    if (!editFlag) {
      const isSub = !!(window.subParams && window.subParams.includes(param.NAME));
      displayValues.set(param.NAME, { 'param_description': param?.ALIAS_DESCRIPTION ?? param.DESCRIPTION, sub: isSub });
    }

    if (!editFlag) {
      if (param?.DEFAULT != '<NULL>' && param.DEFAULT) {
        if (param.TYPE === "numeric" || !isNaN(param.DEFAULT)) {
          values[param.NAME] = parseInt(param.DEFAULT);
        }
        else {
          values[param.NAME] = param.DEFAULT;
        }
        if (inputs[param.NAME]?.type !== 'file') {
          inputs[param.NAME].value = param.DEFAULT;
        }
        buildValuesToDisplay(allOptionsByParameter, param.DEFAULT, param.NAME, displayValues, 'INPUT ');
      } else {
        values[param.NAME] = "";
      }
      if (!isSource(param)) {
        values[param.NAME + '___DESCRIPTION'] = "";
        values[param.NAME + '_ALIAS'] = "";
        values[param.NAME + '_ALIAS___DESCRIPTION'] = "";
      } else {
        
        values[param.NAME + '___DESCRIPTION'] = "";
        values[param.NAME + '_ALIAS'] = "";
        values[param.NAME + '_ALIAS___DESCRIPTION'] = "";
      }
    }
    else {

    }

    if (isSource(param)) {
      
      values[param.NAME] = param.modal.processSourceValues();
    }
    else if (param.SCRIPTS != "<NULL>" || param.FORMULA != "<NULL>") {
      calculatedParams[param.NAME] = input;
      input.disabled = true;
      if (input.type !== 'file') {
        if (!editFlag) {
          input.value = 0
        } else {
          input.value = values[param.NAME]
        }
      }

    }
    if (editFlag) {
      
      if (param.SOURCE != param.NAME) {

      }
    }
    labelNumber++;
    if (input.tagName === "INPUT") {
      inputFlags[paramName] = false;
      validParams[paramName] = false;
    }


    if (paramName.startsWith('SUB___')) {
      if (canUserSeeSubPrices() && !isParamLocked(paramName, displayValues)) {
        enabledParams[paramName] = true;
        div.style.display = 'grid';
        if (editFlag) {
          inputFlags[paramName] = true;
          validParams[paramName] = true;
        }
      } else {
        div.style.display = 'none';
      }
    } else if (!isEnabled(param.ENABLE, values, paramName) || param.FORMROW == '0') {
      div.style.display = 'none'
    }
    else {
      const isRowTwo = param.LISTROW == '2' || param.LISTSUM == 'true';
      if (!shouldHideRegularPriceRow(isRowTwo)) {
        enabledParams[paramName] = true;
        div.style.display = 'grid'
        if (editFlag) {
          inputFlags[paramName] = true;
          validParams[paramName] = true;
        }
      } else {
        div.style.display = 'none';
      }
    }

    if (isParamLocked(paramName, displayValues)) {
      div.style.display = 'none';
      delete enabledParams[paramName];
    }

    if (isEnabled && editFlag && input.type !== 'file' && !isParamLocked(paramName, displayValues)) {
      if (values[param.NAME] != '') {
        input.value = values[param.NAME]
      }
      else {
        input.value = 'ffff'
      }

    }
    
    if (!isSource(param)) {
      values = checkIfOptionsExist(allOptionsByParameter, param.NAME, values);
    }
  }



  const COMMON_PARAMS = { params, inputs, values, displayValues, allOptionsByParameter, groupNumber, calculatedParams };
  if (!editFlag) {
    window.uid = await getUid();
  }
  console.log('Pobrane UID:', window.uid);
  if (editFlag) {
    fillFields(displayValues, inputs, values);
    await applySubPriceFieldVisibility(groupNumber);
  }


  for (let key in inputs) {

    


    if (inputs[key].tagName === "INPUT") {
      let inputDebounceTimer = null;



      inputs[key].addEventListener("input", function () {
        if (this.tagName === "INPUT") { 
          
          console.log(this.tagName, 'input event, value:', this.value, 'name:', this.name);
          values[this.name] = roundInputValue(this.value);

          if (inputDebounceTimer) {
            clearTimeout(inputDebounceTimer);
          }
          
          inputDebounceTimer = setTimeout(() => {
            updateProcedure({
              ...COMMON_PARAMS, options, name: this.name, value: this.value, tagName: this.tagName, filters,
              flags: { updateInputs: true, validate: true, buildValues: true, updateStates: true, percent: true, attrValues: semafor.attrValues }
            });
          }, 500);
        }
      });


    } else {
      inputs[key].addEventListener('change', function () {
        values[this.name] = this.value;
        window.lastChangedField = {
          name: this.name,
          value: this.value,
          tagName: this.tagName,
          timestamp: Date.now()
        };
        updateProcedure({
          ...COMMON_PARAMS, options, name: this.name, value: this.value, tagName: this.tagName, filters, attrValues: semafor.attrValues,
          flags: { buildValues: true, updateInputs: true, updateStates: true }
        });
      });
    }

  }

  document.getElementById('dialog-confirm').onclick = async () => {

    // Coupon fabric exception: when the chosen fabric is a "kupon" fabric, persist a
    // marker into the position values (saved into json_parameters). The server uses
    // it to set the predicted production time to 14 days until the real one arrives.
    // Captured before getInfoFromDialog() closes the dialog. Only fabric pickers
    // carry data-coupon, so selecting other BUTTON params won't clear the flag.
    const activeOptionBoxes = Array.from(document.querySelectorAll('.image-box.active'));
    const hasCouponData = activeOptionBoxes.some(box => box.dataset.coupon !== undefined);
    if (hasCouponData) {
      if (activeOptionBoxes.some(box => box.dataset.coupon === '1')) {
        values['IS_KUPON'] = '1';
      } else {
        delete values['IS_KUPON'];
      }
    }

    let valueToUpdate;
    let [selectedValue, paramName] = getInfoFromDialog(values, inputs, allOptionsByParameter);

    let descValue = selectedValue.replace(/~\d+$/g, '');

    values = setDescription(values, selectedValue, allOptionsByParameter, paramName)
    values[paramName] = descValue;

    if (selectedValue.includes('|') && params[paramName]?.MULTI) {
      valueToUpdate = (selectedValue.split("|"))[0];
    } else {
      valueToUpdate = selectedValue;
    }

    updateProcedure({
      ...COMMON_PARAMS, options, name: paramName, value: valueToUpdate, tagName: 'BUTTON', filters, attrValues: semafor.attrValues,
      flags: { resetDeps: true, buildValues: true, updateInputs: true, updateStates: true }
    });
  };

  window.formInputs = inputs;
  window.formValues = values;
  window.formDisplayValues = displayValues;
  window.allOptionsByParameter = allOptionsByParameter;
  setupFileRemovalListener(params, inputs, values, displayValues);

  // Recompute a single calculated param after leaving manual-override mode.
  window.recalcManualParam = async (name) => {
    await updateProcedure({
      ...COMMON_PARAMS, options, name, value: values?.[name] ?? '', tagName: 'INPUT', filters,
      flags: { updateInputs: true, buildValues: true, updateStates: true }
    });
  };

  return [inputs, values, displayValues, shortJson];
}


function handleFileRemovalReset(paramName, params, inputs, values, displayValues) {
  console.log(`Resetuję załącznik: ${paramName}`);
  
  resetSelectValues([[paramName], displayValues], inputs, values, false);
}


function setupFileRemovalListener(params, inputs, values, displayValues) {
  document.addEventListener('click', function (e) {
    const removeBtn = e.target.closest('.file-remove-btn');
    if (removeBtn && removeBtn.dataset.paramName) {
      const paramName = removeBtn.dataset.paramName;
      handleFileRemovalReset(paramName, params, inputs, values, displayValues);
    }
  });
}

export async function updateProcedure({
  params, inputs, values, displayValues, allOptionsByParameter, options, name, value, groupNumber,
  tagName, filters, calculatedParams, flags = {}, attrValues = {}
}) {
  const {
    resetDeps = false,
    buildValues = false,
    updateInputs = false,
    validate = false,
    updateStates = false,
    percent = false
  } = flags;

  
  const taskId = Date.now() + Math.random();
  window.calculationQueue.push(taskId);

  
  while (window.calculationQueue[0] !== taskId) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  
  window.isCalculating = true;
  window.isPriceCalculating = false;
  disableFormButtons(true);
  applySubPriceLayoutDuringCalc(params, inputs, values, displayValues);

  console.log('🔒 updateProcedure rozpoczęte, UI zablokowane');

  window.finishFlag = false;
  if (spin) {
    startSpin()
  }

  for (let [param, input] of Object.entries(calculatedParams)) {
    if (input && input.value !== undefined) {
      values[param] = input.value;
    }
  }

  values = setDescription(values, value, allOptionsByParameter, name)
  if (percent) values = convertIntoPercent(values, name, value, inputs, params)
  displayValues = hideLocked(inputs, displayValues)
  displayValues = hideSub(inputs, displayValues)
  if (buildValues) buildValuesToDisplay(allOptionsByParameter, value, name, displayValues, tagName);
  displayValues = setListRow(params, displayValues)
  values['uid'] = window.uid;
  if (updateInputs) updateFieldInputs(params, inputs, values, displayValues, allOptionsByParameter, options, name, value, tagName, filters, attrValues);
  getProcedures(inputs, allOptionsByParameter, values, options, name, value, tagName, displayValues, params)
  validateFormInput(values, inputs[name]);
  values = setDescription(values, value, allOptionsByParameter, name)
  if (updateStates) {
    await updateFieldStates(params, inputs, values, displayValues, groupNumber, allOptionsByParameter, name, value);
  }
  console.log('valuesy ', values)
  window.checkedParams = findParamFromValues(values, allOptionsByParameter);
  if (afterSend) validateAllFieldsOnSubmit(inputs, values)
  if (resetDeps) resetDependences([params, displayValues], name, inputs, values, allOptionsByParameter);
  window.shortJson = generateShortJson(params, values);
  fillLocalPositionObject(values, displayValues);
  hideParams(params, inputs)
  fillInputDescription(inputs, params, values, allOptionsByParameter)
  console.log('AKTUALNY JSON', values)
  if (spin) {
    stopSpin()
  }
  window.calculationQueue.shift();

  if (window.calculationQueue.length === 0) {
    window.isCalculating = false;
    window.isPriceCalculating = true;
    disableFormButtons(false);
    applyPriceFactor(params, inputs, values);
    console.log('🔓 Wszystkie obliczenia zakończone, UI odblokowane');
  }
  console.log('display values 123', displayValues);
  setTimeout(() => {
    window.finishFlag = true;
  }, 1300)

}


function disableFormButtons(disable) {
  const buttons = [
    document.getElementById('show-button'),
    document.getElementById('reset-button'),
    document.getElementById('dialog-confirm')
  ].filter(btn => btn !== null);

  buttons.forEach(btn => {
    btn.disabled = disable;
    if (disable) {
      btn.classList.add('disabled', 'opacity-50', 'cursor-not-allowed');
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
    } else {
      btn.classList.remove('disabled', 'opacity-50', 'cursor-not-allowed');
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
  });
}

export function isSource(param) {
  return param.SOURCE == param.NAME;
}

/** Align visible price fields with SUB/client rules (same as after updateProcedure). */
export async function applySubPriceFieldVisibility(groupNumber) {
  const params = window.params;
  const inputs = window.formInputs;
  const values = window.formValues;
  const displayValues = window.formDisplayValues;
  const allOptionsByParameter = window.allOptionsByParameter;
  if (!params || !inputs || !values || !displayValues) return;

  restoreLockedParamsFromDisplayValues(displayValues);
  syncLockedParamsFromEnableFormulas(params, values, displayValues);
  hideLocked(inputs, displayValues);
  hideSub(inputs, displayValues);
  hideLockedParamRows(params, inputs);
  await updateFieldStates(params, inputs, values, displayValues, groupNumber, allOptionsByParameter, '', '');
  showSubPriceRowsImmediately(params, inputs);
  hideLockedParamRows(params, inputs);
  hideParams(params, inputs);
}

export function buildCommentSpace(destinationNode, comment = '') {
  const hasComment = comment.trim() !== '';

  const showCommentButton = createElement('button', {
    type: 'button',
    text: hasComment ? `${t('form.hide_comment_button')}` : `${t('form.add_comment_button')}`,
    id: 'show-comment-button',
    class: ['btn', 'btn-link'],
  }, document.getElementById('buttons-space'))

  const MAX_LENGTH = 250;


  const commentDiv = createElement('div', { class: ['comment-space', 'col-12'].concat(hasComment ? [] : ['d-none']) }, destinationNode);

  
  createElement('label', {
    for: 'orderComment',
    text: t('form.comment_label'),
    class: ['form-label', 'mb-1']
  }, commentDiv);

  
  const textarea = createElement('textarea', {
    html: comment,
    id: 'orderComment',
    class: ['form-control', 'item-comment'],
    rows: 2,
    maxlength: MAX_LENGTH
  }, commentDiv);

  
  const counter = createElement('small', {
    class: ['text-muted', 'd-block', 'mt-1'],
    html: `${comment.length}/${MAX_LENGTH}`
  }, commentDiv);

  
  textarea.addEventListener('input', function () {
    counter.innerHTML = `${this.value.length}/${MAX_LENGTH}`;
  });

  showCommentButton.addEventListener('click', () => {
    if (commentDiv.classList.contains('d-none')) {
      commentDiv.classList.remove('d-none');
      showCommentButton.textContent = `${t('form.hide_comment_button')}`;
    } else {
      commentDiv.classList.add('d-none');
      showCommentButton.textContent = `${t('form.add_comment_button')}`;
    }
  });

  return textarea;
}

/** Appends the `${param.NAME}-select-area` wrapper divs deferred by
 * generateForm() for TYPE='file' (attachment) params — see that function's
 * `window.__attachmentAreaDivs` comment. Called at the end of buildVatFields()
 * so attachments always end up generated last, after the VAT block,
 * regardless of their position in param.txt. */
function appendDeferredAttachmentAreaDivs(destinationNode) {
  const divs = window.__attachmentAreaDivs || [];
  divs.forEach((div) => destinationNode.appendChild(div));
  window.__attachmentAreaDivs = [];
}

/**
 * VAT field (read-only, percentage from services/vatCalculator.js via
 * window.vatRate) + VAT-amount field (read-only, the VAT rate applied in
 * euros) + gross-value field (read-only) — all three filled by
 * pricesCalculator.js' applyVatToGrossValue() from SUB___SUMA_BRUTTO on every
 * recalculation. None is a param.txt-driven field — same pattern as
 * buildCommentSpace().
 *
 * Always built, even at vatRate === 0 (cross-border/export sale — a real,
 * legitimate rate, not something to hide as if VAT weren't calculated at
 * all). formatVatRateLabel() shows a reason suffix so 0% doesn't look broken.
 *
 * Attachment (TYPE='file') param wrapper divs are generated last, after this
 * whole VAT block, via appendDeferredAttachmentAreaDivs() — see
 * generateForm()'s `window.__attachmentAreaDivs` comment for why.
 */
export function buildVatFields(destinationNode) {
  // Master switch: window.vatEnabled is injected by the templates only while
  // config.js's `features.vat` is on (off on production). With the feature off
  // no VAT field is created at all — but the deferred attachment divs still
  // have to be appended, since this function owns that final step.
  if (!window.vatEnabled) {
    appendDeferredAttachmentAreaDivs(destinationNode);
    return {};
  }

  // ⚠️ TYMCZASOWO wyłączone dla konta podrzędnego grupy (`group_user`): na tym
  // poziomie VAT/WARTOSC_VAT/WARTOSC_BRUTTO nie mają się pokazywać ani w
  // konfiguracji pozycji, ani w podglądzie zamówienia (decyzja właściciela,
  // 2026-08-21). Pola nie powstają, więc `applyVatToGrossValue` nie ma czego
  // wypełnić i do zapisu nie idą żadne klucze VAT — patrz też pominięcie
  // wierszy VAT w `templates/order.njk`. Załączniki dokładamy tak czy tak, bo
  // ta funkcja jest właścicielem tego ostatniego kroku.
  if (window.isGroupShop) {
    appendDeferredAttachmentAreaDivs(destinationNode);
    return {};
  }

  const vatRate = Number(window.vatRate) || 0;

  const vatDiv = createElement('div', { class: ['VAT-select-area'] }, destinationNode);
  createElement('label', {
    for: 'VAT',
    text: t('form.vat_label'),
    class: ['form-label', 'mb-1']
  }, vatDiv);
  const vatInput = createElement('input', {
    type: 'text',
    id: 'VAT',
    class: ['input-form'],
    disabled: true,
    value: formatVatRateLabel(vatRate)
  }, vatDiv);

  const vatValueDiv = createElement('div', { class: ['WARTOSC_VAT-select-area'] }, destinationNode);
  createElement('label', {
    for: 'WARTOSC_VAT',
    text: t('form.wartosc_vat_label'),
    class: ['form-label', 'mb-1']
  }, vatValueDiv);
  const vatValueInput = createElement('input', {
    type: 'text',
    id: 'WARTOSC_VAT',
    class: ['input-form'],
    disabled: true,
    value: '0'
  }, vatValueDiv);

  const bruttoDiv = createElement('div', { class: ['WARTOSC_BRUTTO-select-area'] }, destinationNode);
  createElement('label', {
    for: 'WARTOSC_BRUTTO',
    text: t('form.wartosc_brutto_label'),
    class: ['form-label', 'mb-1']
  }, bruttoDiv);
  const bruttoInput = createElement('input', {
    type: 'text',
    id: 'WARTOSC_BRUTTO',
    class: ['input-form'],
    disabled: true,
    value: '0'
  }, bruttoDiv);

  appendDeferredAttachmentAreaDivs(destinationNode);

  return { vatInput, vatValueInput, bruttoInput };
}

/**
 * Rabat klienta grupy — dwa pola tylko do odczytu: procent (`RABAT_KLIENTA`)
 * i wartość po rabacie (`WARTOSC_PO_RABACIE`), wypełniane przez
 * pricesCalculator.js → applyClientDiscount() po każdym przeliczeniu ceny.
 *
 * ⚠️ **Oba pola są UKRYTE w formularzu** (`display: none`). Mają się LICZYĆ, ale
 * nie pokazywać osobie konfigurującej pozycję — rabat widać dopiero w podglądzie
 * zamówienia, po odsłonięciu kłódką (`templates/order.njk`, wiersze
 * `client-discount-row`). Inputy istnieją, bo `applyClientDiscount()` wpisuje do
 * nich wynik przez `getElementById`, a wartości idą dalej do `values` i
 * `displayValues`.
 *
 * ⚠️ Rabat NIE dotyka VAT-u ani `WARTOSC_BRUTTO` — brutto zostaje takie, jak
 * przed wprowadzeniem rabatu (patrz applyVatToGrossValue).
 *
 * Ten sam wzorzec co buildVatFields(): pola NIE pochodzą z `param.txt`, więc
 * silnik ich nie zna i żadna formuła się o nie nie potknie. Wołane przed
 * `buildVatFields()`, które dokłada blok VAT, a na końcu pola załączników.
 *
 * Nic nie buduje, gdy rabatu nie ma (`window.clientDiscountPercent` = 0 albo
 * brak).
 */
export function buildClientDiscountFields(destinationNode) {
  const pct = Number(window.clientDiscountPercent) || 0;
  if (!(pct > 0)) return {};
  if (!destinationNode) return {};
  // Te same zasady widoczności co ceny SUB___ (rabat jest ceną klienta):
  // kto nie widzi cen SUB, nie widzi też rabatu; przy ukrytych cenach nic nie
  // budujemy.
  if (window.hidePrices || !canUserSeeSubPrices()) return {};

  // Idempotencja: zmiana grupy asortymentowej przebudowuje formularz
  // (buildDynamicForm woła to ponownie), a dwa pola o tym samym `id` zepsułyby
  // wypełnianie przez getElementById.
  destinationNode
    .querySelectorAll('.RABAT_KLIENTA-select-area, .WARTOSC_PO_RABACIE-select-area')
    .forEach((el) => el.remove());

  // `display: none` na wrapperach: pola liczą się, ale nie są widoczne.
  const discountDiv = createElement('div', { class: ['RABAT_KLIENTA-select-area', 'd-none'], style: 'display: none' }, destinationNode);
  createElement('label', {
    for: 'RABAT_KLIENTA',
    text: t('form.client_discount_label'),
    class: ['form-label', 'mb-1']
  }, discountDiv);
  const discountInput = createElement('input', {
    type: 'text',
    id: 'RABAT_KLIENTA',
    class: ['input-form'],
    disabled: true,
    value: `${pct}%`
  }, discountDiv);

  const afterDiv = createElement('div', { class: ['WARTOSC_PO_RABACIE-select-area', 'd-none'], style: 'display: none' }, destinationNode);
  createElement('label', {
    for: 'WARTOSC_PO_RABACIE',
    text: t('form.value_after_discount_label'),
    class: ['form-label', 'mb-1']
  }, afterDiv);
  const afterInput = createElement('input', {
    type: 'text',
    id: 'WARTOSC_PO_RABACIE',
    class: ['input-form'],
    disabled: true,
    value: '0'
  }, afterDiv);

  return { discountInput, afterInput };
}

/**
 * Mnożnik rabatu klienta grupy — kopia jednej linijki z
 * `formTools/pricesCalculator.js clientDiscountFactor()`, świadomie bez importu:
 * `getTotal()` jest wołane przy zapisie pozycji z kilku ekranów, a ściąganie tu
 * całego modułu cen (z jego zależnościami) tylko po mnożnik byłoby gorszym
 * kompromisem niż te trzy linie.
 */
function clientDiscountFactorForTotals() {
  const pct = Number(window.clientDiscountPercent) || 0;
  if (!(pct > 0)) return 1;
  return 1 - Math.min(100, pct) / 100;
}

export function getTotal(displayValues) {
  const totalObj = {};
  for (let [key, value] of displayValues) {
    if (value?.listsum) {
      // SUB___* params are always sub-price rows, even when the engine leaves
      // their `sub` flag unset (e.g. imported orders where SUB inputs aren't
      // generated). Without this, a SUB___ listsum row would overwrite the real
      // total/total_hidden via the assignments below.
      const isSub = value?.sub || (typeof key === 'string' && key.startsWith('SUB___'));
      if (isSub) {
        // sub params: use assignment like total/total_hidden so that SUB___CENA_RABAT
        // (the discounted price, defined after SUB___CENA) overwrites rather than accumulates.
        // Accumulation caused double-counting when both SUB___CENA and SUB___CENA_RABAT had listsum=true.
        totalObj['total_sub'] = parseFloat(value.option_value || 0);
      }
      else if (value?.locked) {
        totalObj['total_hidden'] = parseFloat(value.option_value);
      }
      else {
        totalObj['total'] = parseFloat(value.option_value);
      }
    }
  }
  // ⚠️ Suma klienta zapisywana w pozycji (`order_item.total_price_sub`) MUSI być
  // tą samą liczbą, którą widok pokazuje przy pozycji jako „WART. NET. PO
  // RABACIE" — inaczej stopka zamówienia rozjeżdża się z wierszem pozycji (tak
  // było: 14,27 w bazie przy 40,77 na ekranie).
  //
  // Od 2026-09-11 rabat klienta jest już WLICZONY w `SUB___WARTOSC_KONCOWA`
  // (`pricesCalculator.js applyClientDiscount`, bo z tego parametru wystawiana
  // jest faktura), więc bierzemy tę kwotę wprost — pętla wyżej mogłaby ją
  // nadpisać innym wierszem `listsum`. Mnożnik stosujemy TYLKO tam, gdzie tego
  // parametru w ogóle nie ma (HKL / ekran bez cen klienta) — inaczej rabat
  // zszedłby dwa razy.
  const discountPct = Number(window.clientDiscountPercent) || 0;
  if (discountPct > 0) {
    const koncowaRow = displayValues.get('SUB___WARTOSC_KONCOWA');
    const koncowaValue = koncowaRow ? parseFloat(koncowaRow.option_value) : NaN;
    if (Number.isFinite(koncowaValue)) {
      totalObj['total_sub'] = koncowaValue;
    } else {
      const discountFactor = clientDiscountFactorForTotals();
      if (discountFactor !== 1 && Number.isFinite(totalObj['total_sub'])) {
        totalObj['total_sub'] = parseFloat((totalObj['total_sub'] * discountFactor).toFixed(2));
      }
    }
  }

  return totalObj;
}


/**
 * Zastosowanie faktora cen — mnożenie wyświetlanych wartości w inputach cenowych.
 * Faktor jest TYLKO wizualny — values[] (do zapisu) pozostają oryginalne.
 * Działa tylko gdy window.priceFactor !== 1 i pracownik ma uprawnienie can_see_prices.
 */
function applyPriceFactor(params, inputs, values) {
  const factor = parseFloat(window.priceFactor);
  if (!factor || factor === 1.0 || window.hidePrices) return;

  for (const param of params) {
    if (window.manualParams && window.manualParams.has(param.NAME)) continue;
    if ((param.LISTROW == '2' || param.LISTSUM == 'true') && inputs[param.NAME]) {
      const originalValue = parseFloat(values[param.NAME]);
      if (!isNaN(originalValue) && originalValue !== 0) {
        const factoredValue = (originalValue * factor).toFixed(2);
        inputs[param.NAME].value = factoredValue;
      }
    }
  }
}


export async function recalculateLastChangedField() {

  if (!window.lastChangedField) {

    return;
  }
  startSpin();
  const { name, value, tagName, timestamp } = window.lastChangedField;
  const timeSinceChange = Date.now() - timestamp;

  const params = window.params;
  const inputs = window.formInputs;
  const values = window.formValues;

  const displayValues = window.formDisplayValues;
  const allOptionsByParameter = window.allOptionsByParameter;
  const groupNumber = window.tempGroupNumber;

  if (!params || !inputs || !values) {
    return;
  }

  
  const calculatedParams = {};
  const options = {};
  const filters = {};

  await updateProcedure({
    params,
    inputs,
    values,
    displayValues,
    allOptionsByParameter,
    options,
    name,
    value,
    groupNumber,
    tagName,
    filters,
    calculatedParams,
    flags: {
      updateInputs: true, validate: true, buildValues: true, updateStates: true, percent: true
    }
  });

  stopSpin();
}
