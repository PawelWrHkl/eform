import {
    generateForm,
    buildCommentSpace,
    buildVatFields,
    getTotal,
    recalculateLastChangedField

} from "/scripts/form.js";
import {
    resetSelectValues, checkFlags
} from "/scripts/formTools/formTools.js";
import { sendFormDataWithAttachments } from "/scripts/formTools/formDataHelper.js";
import { FormsManager } from './formTools/getAvailableForms.js'
import { showToast } from "/scripts/components/toast.js";
import { createElement, editElementById } from "./components/htmlManipulator.js";
import { validateAllFieldsOnSubmit } from './formTools/validateUtils.js'
import { checkIfPriceIsCorrect, applyVatToGrossValue } from './formTools/pricesCalculator.js'
import { startSpin, stopSpin } from "./components/hourglass.js";


function getPositionIdFromUrl() {
    
    const params = new URLSearchParams(window.location.search);
    const queryId = params.get('id');

    if (queryId) {
        
        return queryId;
    }

    
    const pathParts = window.location.pathname.split('/');
    const positionIndex = pathParts.findIndex(part => part === 'position');

    if (positionIndex !== -1 && pathParts[positionIndex + 1]) {
        const pathId = pathParts[positionIndex + 1];
        
        return pathId;
    }

    
    return null;
}
async function getPositionInfo(id) {
    
    try {
        const response = await fetch(`/position/${id}/data`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            }
        });
        const data = await response.json();

        return data.position
    }
    catch (error) {
        console.error(error);
    }
}



async function init() {
    const id = getPositionIdFromUrl();
    const position = await getPositionInfo(id);

    const version = position.ver;
    const values = position.json_parameters;
    // json_parameters_desc comes back either as a JSON string (normal orders)
    // or as an already-parsed array (imported orders, MySQL JSON column).
    let valuesToDisplayList = position.json_parameters_desc;
    if (typeof valuesToDisplayList === 'string') {
        try {
            valuesToDisplayList = JSON.parse(valuesToDisplayList);
            if (typeof valuesToDisplayList === 'string') {
                valuesToDisplayList = JSON.parse(valuesToDisplayList);
            }
        } catch {
            valuesToDisplayList = [];
        }
    }
    if (!Array.isArray(valuesToDisplayList)) valuesToDisplayList = [];
    const valuesToDisplay = new Map(valuesToDisplayList);
    const comment = position.comment;
    const lang = position.lang


    const formDiv = document.getElementById('dynamic-form')
    window.formsManager = new FormsManager();
    const departments = await formsManager.getAvailableForms();
    const department = departments.find(department =>
        department.products.includes(position.asortment_group_number)
    );
    const groups = await formsManager.getGroups(department.num);

    formsManager.setCurrentRootPath(position.asortment_group_number);
    formsManager.setCurrentGroup(position.asortment_group_number);
    const [editInputs, editValues, editValuesToDisplay] = await generateForm(version, position.asortment_group_number, values, valuesToDisplay, true, lang)

    setupResetButton(editInputs, editValues, editValuesToDisplay)
    const editComment = buildCommentSpace(formDiv, comment)
    buildVatFields(formDiv)
    // Saved positions already have their price params computed — fill
    // WARTOSC_BRUTTO from them immediately instead of leaving it at the
    // default '0' until the user touches a field or hits save.
    applyVatToGrossValue(editValues, editValuesToDisplay)

    setUpSaveButton(id, editValues, editValuesToDisplay, editComment, position.order_id, editInputs)

}


function setupResetButton(inputs, values, valuesToDisplay) {
    const resetButton = document.getElementById('reset-button');
    resetButton.onclick = function () {
        showToast('info', t('form.loading_data'));
        resetSelectValues([Object.keys(values), valuesToDisplay], inputs, values);
    };
}

function setUpSaveButton(id, values, valuesToDisplay, comment, orderId, inputs) {
    let sentState = false;

    console.log('setupShowButton')
    const showButton = document.getElementById('show-button');

    showButton.onclick = function () {
        
        if (sentState) {
            console.log('⚠️ Formularz już został wysłany');
            showToast('warning', 'Formularz już został wysłany');
            throw new Error('Already sent');
        }

        
        if (window.isCalculating) {
            showToast('warning', 'Trwają obliczenia, poczekaj...');
            return;
        }

        
        console.log('🚀 Wymuszam przeliczenie przed zapisem...');
        recalculateLastChangedField()
            .then(() => {
                
                console.log('⏳ Czekam na zakończenie wszystkich obliczeń...');
                return new Promise(resolve => {
                    const checkQueue = () => {
                        if (!window.calculationQueue || window.calculationQueue.length === 0) {
                            resolve();
                        } else {
                            setTimeout(checkQueue, 50);
                        }
                    };
                    checkQueue();
                });
            })
            .then(() => {
                
                console.log('💰 Sprawdzam i aktualizuję ceny...');
                valuesToDisplay = checkIfPriceIsCorrect(values, inputs, valuesToDisplay);
                console.log('✅ DisplayValues zaktualizowane:', valuesToDisplay);
            })
            .then(() => {
                
                console.log('✅ Przeliczenie zakończone, przechodzę do walidacji...');
                return validateForm(inputs, values);
            })
            .then((isValid) => {
                if (!isValid) {
                    showToast('error', t("form.incorrect_data"));
                    throw new Error('Validation failed');
                }

                


                console.log('✅ Wszystkie warunki spełnione, wysyłam dane...');
                return new Promise(resolve => {
                    setTimeout(() => {
                        sendData(id, values, valuesToDisplay, comment, orderId)
                            .then(() => {

                                resolve();
                                sentState = true;
                            });
                    }, 1000);
                });
            })
            .catch((error) => {
                if (error.message !== 'Validation failed' && error.message !== 'Form not ready' && error.message !== 'Already sent') {
                    console.error('Błąd podczas zapisywania:', error);
                    showToast('error', t("form.error_saving_form"));
                }
            });
    }

}



async function sendData(id, values, valuesToDisplay, comment, orderId) {
    const commission = document.getElementById('commission-name');
    const jsonValuesToDisplay = JSON.stringify(Array.from(valuesToDisplay.entries()));


    const postBody = {
        id: id,
        commission: commission.value,
        jsonValues: values,
        jsonValuesToDisplay: jsonValuesToDisplay,
        comment: comment.value,
        jsonShort: window.shortJson

    }
    const total = getTotal(valuesToDisplay);
    
    postBody.total = total;

    try {
        const result = await sendFormDataWithAttachments("/position/edit/save", postBody, "PATCH");
        showToast('success', `${t('form.saved_form_success')}`);
        return new Promise(resolve => {
            console.log(window.jsonShort, 'JSON SHORT')
            setTimeout(() => {

                window.location.href = `/orders/order/${orderId}`;
                resolve(result);
            }, 3000);
        });
    } catch (error) {
        console.error("Błąd przy wysyłaniu", error);
        showToast('error', t("form.error_saving_form"));
        throw error;
    }

}

export async function validateForm(inputs, values) {
    
    const visibleInputsObj = Object.fromEntries(
        Object.entries(inputs).filter(
            ([key, elem]) => getComputedStyle(elem).display !== 'none'
        )
    );
    
    validateAllFieldsOnSubmit(visibleInputsObj, values)
    const correctFlag = await checkFlags();
    if (typeof correctFlag !== 'boolean') {
        highlightInvalidFields(correctFlag);

        return false;
    }
    return true
}

function highlightInvalidFields(flags) {
    let firstInvalid = null;
    for (let { key } of flags) {
        let elem = document.getElementById(key);
        if (elem) {
            elem.classList.add("invalid-input",)
            elem.classList.add('flash-error');
            if (!firstInvalid) firstInvalid = elem;
            setTimeout(() => {
                elem.classList.remove('flash-error');
            }, 2000);
        }
    }
    if (firstInvalid) {
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstInvalid.focus({ preventScroll: true });
    }
}



init()

