import {
    generateForm,
    buildCommentSpace,
    getTotal,
    recalculateLastChangedField

} from "/scripts/form.js";
import {
    resetSelectValues, checkFlags
} from "/scripts/formTools/formTools.js";
import { sendFormDataWithAttachments } from "/scripts/formTools/formDataHelper.js";
import { FormsManager } from '/scripts/formTools/getAvailableForms.js'
import { showToast } from "/scripts/components/toast.js";
import { validateAllFieldsOnSubmit } from '/scripts/formTools/validateUtils.js'
import { checkIfPriceIsCorrect } from '/scripts/formTools/pricesCalculator.js'
import { startSpin, stopSpin } from "/scripts/components/hourglass.js";
import { isCalculatedParam } from "/scripts/formTools/createForm.js";

const MAX_WAIT_MS = 30000;

function getPositionIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const queryId = params.get('id');
    if (queryId) return queryId;

    const pathParts = window.location.pathname.split('/');
    const positionIndex = pathParts.findIndex(part => part === 'position');
    if (positionIndex !== -1 && pathParts[positionIndex + 1]) {
        return pathParts[positionIndex + 1];
    }
    return null;
}

async function getPositionInfo(id) {
    try {
        const response = await fetch(`/position/${id}/data`, {
            method: "GET",
            headers: { "Content-Type": "application/json" }
        });
        const data = await response.json();
        return data.position;
    } catch (error) {
        console.error(error);
    }
}

async function getLatestVersion(groupNumber) {
    try {
        const response = await fetch(`/position/version/${groupNumber}/`, {
            method: "GET",
            headers: { "Content-Type": "application/json" }
        });
        const data = await response.json();
        return data.version;
    } catch (error) {
        console.error('Błąd pobierania wersji:', error);
        return null;
    }
}

function waitForCalculations() {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const queueEmpty = !window.calculationQueue || window.calculationQueue.length === 0;
            const finished = window.finishFlag === true;
            const elapsedQuiet = Date.now() - start > 2000 && queueEmpty;
            if ((queueEmpty && finished) || elapsedQuiet) return resolve();
            if (Date.now() - start > MAX_WAIT_MS) {
                return reject(new Error('Przekroczono czas oczekiwania na obliczenia'));
            }
            setTimeout(check, 50);
        };
        check();
    });
}

async function forceRecalculation(inputs, values) {
    // Reset all calculated (FORMULA/SOURCE-script) param values to 0 before
    // triggering recalculation. In a brand-new position every calculated param
    // starts at 0 (form.js:!editFlag branch). In admin-redit they hold the old
    // saved values; if a price script reads values['CENA'] and takes a shortcut
    // path (e.g. rounding) when it is already > 0, the stale value causes
    // incorrect results. Zeroing them mirrors the initial state so scripts
    // always compute from scratch — saved prices are never trusted, only
    // recomputed ones. isCalculatedParam (SOURCE or FORMULA) is used here
    // rather than the SCRIPTS field, since most price params reference their
    // script only through SOURCE and leave SCRIPTS '<NULL>'.
    const paramsList = window.params || [];
    for (const p of paramsList) {
        if (!p?.NAME) continue;
        if (isCalculatedParam(p)) {
            values[p.NAME] = 0;
            if (inputs[p.NAME]) inputs[p.NAME].value = 0;
        }
    }

    // Find the first *user-input* param that has a non-empty value — it must
    // not be a calculated param (those were just zeroed and will be
    // recomputed as dependencies).
    let firstName = null;
    for (const p of paramsList) {
        if (!p?.NAME) continue;
        if (p.NAME.includes('___')) continue;
        if (!inputs[p.NAME]) continue;
        // Skip calculated params — they should be results, not triggers
        if (isCalculatedParam(p)) continue;
        if (values[p.NAME] === undefined || values[p.NAME] === '' || values[p.NAME] === 0) continue;
        firstName = p.NAME;
        break;
    }
    if (firstName) {
        window.lastChangedField = {
            name: firstName,
            value: values[firstName],
            tagName: inputs[firstName]?.tagName || 'INPUT',
            timestamp: Date.now()
        };
        await recalculateLastChangedField();
    } else {
        console.warn('[admin-edit] Nie znaleziono parametru do wymuszenia przeliczenia');
    }
    await waitForCalculations();
}

/**
 * Po waitForCalculations() skrypty cennikowe zaktualizowały window.lockedParams
 * i window.subParams. buildValuesToDisplay ustawia locked/sub tylko przy tworzeniu
 * nowego wpisu. Dla istniejących wpisów (z przekazanego oldValuesToDisplay)
 * locked/sub pozostają z poprzedniego zapisu. Przywracamy je z globalnych list.
 */
function syncLockedAndSubFlags(displayValues) {
    const locked = window.lockedParams || [];
    const sub = window.subParams || [];
    for (const [key, entry] of displayValues) {
        if (!entry || typeof entry !== 'object') continue;
        entry.locked = locked.includes(key);
        entry.sub = sub.includes(key);
    }
}

/**
 * enableSubPriceViewForAdminEdit() (below) makes generateForm() render real
 * SUB___ inputs, so the standard calc pipeline computes them for real in the
 * common case. This is now only a fallback for SUB___ params that have
 * NEITHER a resolved SOURCE nor a FORMULA (no per-client SUB script
 * configured for this client at all): mirror the base param's value so the
 * preview isn't blank, since there is nothing else to compute it from.
 */
function syncSubPriceDisplayEntries(displayValues) {
    const params = window.params || [];
    const locked = window.lockedParams || [];
    for (const param of params) {
        if (!param?.NAME?.startsWith('SUB___')) continue;
        if (isCalculatedParam(param)) continue; // already computed for real — never overwrite
        const baseParamName = param.NAME.slice(6); // 'SUB___CENA' → 'CENA'
        const baseEntry = displayValues.get(baseParamName);
        if (!baseEntry?.option_value) continue;
        const existing = displayValues.get(param.NAME) || {};
        displayValues.set(param.NAME, {
            param_description: existing.param_description || baseEntry.param_description || '',
            locked: locked.includes(param.NAME),
            sub: true,
            option_value: baseEntry.option_value,
            option_description: '',
            row: existing.row || param.LISTROW || '1'
        });
    }
}

/**
 * By default form.js never renders an <input> for SUB___ params unless the
 * viewer is isGroup/isGroupShop/isClient, or has canViewSubPrices/
 * viewAsOrganization/hasSubPriceToggle set (see createForm.js
 * canUserSeeSubPrices() and form.js's buildHtml gate) — those flags come from
 * services/subPriceContext.js, keyed off the order owner's *organization id*.
 * For a client whose org happens to be HKL itself (id 3) but who is really a
 * distinct reseller with its own SUB pricing script (e.g. TCN — a "group"
 * account under org HKL), that org-id check never turns on, so admin-redit
 * got neither a rendered SUB___ input nor a computed SUB price — regardless
 * of whether selectPrices() already resolved a real per-client SOURCE for it
 * (e.g. SUB___CENA=param-SUB___CENA-J.js).
 *
 * admin-redit is already admin-only (routes/positions.js gates the whole
 * route on req.session.user.isAdmin), so there's no extra exposure in always
 * enabling the SUB view here — this mirrors exactly how a normal order page
 * shows SUB prices to admin/owner. Setting these before generateForm() makes
 * buildHtml() create real SUB___ inputs, which lets the standard
 * updateFieldStates dispatch (keyed by `inputs`) actually invoke their real
 * SOURCE script/FORMULA — the same computation a client/group user would get.
 */
function enableSubPriceViewForAdminEdit() {
    window.canViewSubPrices = true;
    window.hasSubPriceToggle = true;
}

async function init() {
    try {
        const id = getPositionIdFromUrl();
        if (!id) throw new Error('Nie znaleziono ID pozycji w URL');

        const position = await getPositionInfo(id);
        if (!position) throw new Error('Nie udało się pobrać danych pozycji');

        const values = position.json_parameters;
        const comment = position.comment;
        const lang = position.lang;
        const groupNumber = String(position.asortment_group_number);

        // Parse old displayValues so fillFields() can fill button labels (option_value /
        // option_description). Clear every 'locked' flag first so that old sub-price lock
        // state from the previous save does NOT bleed into the new form — we want the admin
        // to see all rows and recalculate from scratch.
        let oldValuesToDisplay = new Map();
        try {
            // json_parameters_desc may arrive as a JSON string (normal orders) or
            // as an already-parsed array (imported orders, MySQL JSON column).
            let parsed = position.json_parameters_desc;
            if (typeof parsed === 'string') {
                parsed = JSON.parse(parsed);
                if (typeof parsed === 'string') parsed = JSON.parse(parsed);
            }
            if (Array.isArray(parsed)) {
                oldValuesToDisplay = new Map(parsed);
                for (const entry of oldValuesToDisplay.values()) {
                    if (entry && typeof entry === 'object') entry.locked = false;
                }
            }
        } catch {
            // json_parameters_desc absent or malformed — fall back to empty Map
        }

        const formDiv = document.getElementById('dynamic-form');
        window.formsManager = new FormsManager();
        const departments = await formsManager.getAvailableForms();

        const department = departments.find(d => d.products.includes(groupNumber));
        if (!department) throw new Error(`Nie znaleziono działu dla grupy ${groupNumber}`);

        await formsManager.getGroups(department.num);
        formsManager.setCurrentRootPath(groupNumber);
        formsManager.setCurrentGroup(groupNumber);

        const latestVersion = await getLatestVersion(groupNumber) || position.ver;

        const versionDiv = document.getElementById('version-space');
        if (versionDiv) {
            const label = latestVersion === position.ver ? '(bieżąca)' : '(najnowsza)';
            versionDiv.innerHTML = `v ${latestVersion} <span class="admin-redit-badge">${label}</span>`;
        }

        // Always compute+show the SUB (organizational) price view here — admin-redit
        // is already admin-only, so this is safe, and it's the only way the SUB___
        // params' real per-client scripts ever get invoked (see function docs below).
        enableSubPriceViewForAdminEdit();

        // Pass old displayValues (with cleared locked flags) so fillFields()
        // can restore button labels and option descriptions.
        // editFlag=true pre-fills all inputs from values.
        const result = await generateForm(
            latestVersion,
            groupNumber,
            values,
            oldValuesToDisplay,
            true,
            lang
        );

        if (!result) throw new Error(`Nie udało się wygenerować formularza (v${latestVersion}, gr=${groupNumber})`);

        const [editInputs, editValues, editValuesToDisplay] = result;

        // Force full recalculation so all formulas/scripts run with the new schema rules.
        await forceRecalculation(editInputs, editValues);

        // Synchronizuj locked/sub flagi ze stanu po obliczeniach.
        syncLockedAndSubFlags(editValuesToDisplay);

        // Fallback mirror for SUB___ params without a real per-client script/formula
        // (see enableSubPriceViewForAdminEdit / syncSubPriceDisplayEntries docs above).
        syncSubPriceDisplayEntries(editValuesToDisplay);

        setupResetButton(editInputs, editValues, editValuesToDisplay);
        const editComment = buildCommentSpace(formDiv, comment);
        setUpSaveButton(id, editValues, editValuesToDisplay, editComment, position.order_id, editInputs);
    } catch (err) {
        console.error('[admin-edit] Błąd inicjalizacji formularza:', err);
        showToast('error', `Błąd ładowania formularza: ${err.message}`);
    }
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

    const showButton = document.getElementById('show-button');

    showButton.onclick = function () {
        if (sentState) {
            showToast('warning', 'Formularz już został wysłany');
            throw new Error('Already sent');
        }

        if (window.isCalculating) {
            showToast('warning', 'Trwają obliczenia, poczekaj...');
            return;
        }

        recalculateLastChangedField()
            .then(() => waitForCalculations())
            .then(() => {
                valuesToDisplay = checkIfPriceIsCorrect(values, inputs, valuesToDisplay);
            })
            .then(() => validateForm(inputs, values))
            .then((isValid) => {
                if (!isValid) {
                    showToast('error', t("form.incorrect_data"));
                    throw new Error('Validation failed');
                }

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
    };
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
    };
    const total = getTotal(valuesToDisplay);
    postBody.total = total;

    try {
        const result = await sendFormDataWithAttachments("/position/edit/save", postBody, "PATCH");
        showToast('success', `${t('form.saved_form_success')}`);
        return new Promise(resolve => {
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

async function validateForm(inputs, values) {
    const visibleInputsObj = Object.fromEntries(
        Object.entries(inputs).filter(
            ([key, elem]) => getComputedStyle(elem).display !== 'none'
        )
    );
    validateAllFieldsOnSubmit(visibleInputsObj, values);
    const correctFlag = await checkFlags();
    if (typeof correctFlag !== 'boolean') {
        highlightInvalidFields(correctFlag);
        return false;
    }
    return true;
}

function highlightInvalidFields(flags) {
    let firstInvalid = null;
    for (let { key } of flags) {
        let elem = document.getElementById(key);
        if (elem) {
            elem.classList.add("invalid-input");
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

init();

