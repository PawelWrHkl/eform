/**
 * Przelicz wszystkie pozycje zamówienia z aktualnymi danymi (cenniki, skrypty).
 *
 * Strategia (Opcja A — przeliczanie po stronie klienta):
 * 1. Pobierz listę pozycji z backendu (id, ver, group, json_parameters, ...).
 * 2. Dla każdej pozycji sekwencyjnie:
 *    a. Załaduj formularz przez generateForm() w trybie editFlag=true z istniejącymi values.
 *    b. Poczekaj aż obliczenia (skrypty + formuły) się zakończą (calculationQueue + finishFlag).
 *    c. Wymuś przeliczenie ostatniego pola (recalculateLastChangedField) — symuluje
 *       interakcję użytkownika żeby cały graph zależności się zaktualizował.
 *    d. Zbierz nowe values, valuesToDisplay, total, shortJson.
 * 3. Wyślij wszystkie zaktualizowane pozycje atomowo do backendu (POST recalculate).
 * 4. Po sukcesie — reload strony.
 *
 * Strategia "wszystko albo nic" — przy pierwszym błędzie przerywamy całość i pokazujemy toast.
 */

import { generateForm, getTotal, recalculateLastChangedField } from '/scripts/form.js';
import { FormsManager } from '/scripts/formTools/getAvailableForms.js';
import { showToast } from '/scripts/components/toast.js';
import { confirmPrompt } from '/scripts/components/confirmPrompt.js';

async function getLatestVersion(groupNumber) {
    try {
        const response = await fetch(`/position/version/${groupNumber}/`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        return data.version || null;
    } catch (err) {
        console.error('[recalculate] Błąd pobierania wersji:', err);
        return null;
    }
}

/**
 * Wymusza widoczność spinnera na cały czas trwania procesu.
 * Używa `setProperty('display', 'block', 'important')` — `stopSpin()` w hourglass.js
 * ustawia `style.display = 'none'` co nie nadpisuje `!important`.
 * Aby ukryć po zakończeniu, używamy forceHideSpinner().
 */
function forceShowSpinner() {
    const hg = document.querySelector('.hourglass');
    const ov = document.querySelector('.overlay');
    if (hg) {
        hg.style.setProperty('display', 'block', 'important');
        hg.style.animationPlayState = 'running';
    }
    if (ov) {
        ov.style.setProperty('display', 'block', 'important');
    }
}

function forceHideSpinner() {
    const hg = document.querySelector('.hourglass');
    const ov = document.querySelector('.overlay');
    if (hg) {
        // Usuwamy wymuszone !important żeby element rzeczywiście się schował
        hg.style.removeProperty('display');
        hg.style.display = 'none';
        hg.style.animationPlayState = 'paused';
    }
    if (ov) {
        ov.style.removeProperty('display');
        ov.style.display = 'none';
    }
}

// Lokalne, bezpieczne wrappery na spinner — moduł hourglass.js zakłada istnienie
// elementów .hourglass i .overlay w DOM (są w form.njk, ale nie w order.njk).
// Te wrappery działają nawet gdy elementów nie ma.
function safeStartSpin() {
    const hg = document.querySelector('.hourglass');
    const ov = document.querySelector('.overlay');
    if (hg) {
        hg.style.animationPlayState = 'running';
        hg.style.display = 'block';
    }
    if (ov) ov.style.display = 'block';
}
function safeStopSpin() {
    const hg = document.querySelector('.hourglass');
    const ov = document.querySelector('.overlay');
    if (hg) {
        hg.style.animationPlayState = 'paused';
        hg.style.display = 'none';
    }
    if (ov) ov.style.display = 'none';
}

/**
 * Etykieta postępu wyświetlana nad/przy spinnerze podczas przeliczania.
 * Tworzona dynamicznie aby nie zaśmiecać HTML.
 */
function ensureProgressLabel() {
    let overlay = document.getElementById('recalc-overlay');
    if (!overlay) {
        // Inject keyframes raz
        if (!document.getElementById('recalc-spinner-keyframes')) {
            const style = document.createElement('style');
            style.id = 'recalc-spinner-keyframes';
            style.textContent = '@keyframes recalc-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}';
            document.head.appendChild(style);
        }

        // Overlay (czarne tło)
        overlay = document.createElement('div');
        overlay.id = 'recalc-overlay';
        overlay.style.cssText = [
            'position: fixed',
            'top: 0',
            'left: 0',
            'width: 100%',
            'height: 100%',
            'background: rgba(0, 0, 0, 0.5)',
            'backdrop-filter: blur(4px)',
            '-webkit-backdrop-filter: blur(4px)',
            'z-index: 9999',
            'display: none',
            'justify-content: center',
            'align-items: center',
            'flex-direction: column',
            'gap: 24px'
        ].join(';');

        // Spinner
        const spinner = document.createElement('div');
        spinner.id = 'recalc-spinner';
        spinner.style.cssText = [
            'width: 80px',
            'height: 80px',
            'border: 4px solid rgba(255, 255, 255, 0.2)',
            'border-top-color: #fff',
            'border-radius: 50%',
            'animation: recalc-spin 1s linear infinite'
        ].join(';');
        overlay.appendChild(spinner);

        // Etykieta
        const label = document.createElement('div');
        label.id = 'recalc-progress-label';
        label.style.cssText = [
            'padding: 12px 24px',
            'background: rgba(255, 255, 255, 0.95)',
            'backdrop-filter: blur(8px)',
            'border-radius: 12px',
            'box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3)',
            'font-size: 16px',
            'font-weight: 600',
            'color: #1a1a1a',
            'text-align: center',
            'min-width: 220px'
        ].join(';');
        overlay.appendChild(label);

        document.body.appendChild(overlay);
    }
    return overlay.querySelector('#recalc-progress-label');
}

function showProgress(current, total, message) {
    const label = ensureProgressLabel();
    const overlay = document.getElementById('recalc-overlay');
    const text = message || `${current} / ${total}`;
    label.textContent = `${t('order.recalculate_progress')} ${text}`;
    if (overlay) overlay.style.display = 'flex';
}

function hideProgress() {
    const overlay = document.getElementById('recalc-overlay');
    if (overlay) overlay.style.display = 'none';
}

/**
 * Tworzy w DOM ukryte elementy potrzebne przez generateForm() które normalnie
 * są w form.njk (formularz nowej pozycji). Bez nich generateForm wywala się
 * próbując ustawić innerHTML/onclick na null.
 *
 * Wszystkie elementy są poza widoczną częścią — display:none i nie wpływają na UX.
 */
function ensureFormHostElements() {
    const ids = {
        'dynamic-form': 'div',
        'attachment-container': 'div',
        'orderId': 'p',
        'positionId': 'p',
        'dialog-confirm': 'button',
        'dialog-close': 'button',
        'color-dialog': 'dialog',
        'dialog-title': 'h3',
        'dynamic-options-list': 'div',
        'additional-info': 'div',
        'object-count': 'span',
        'image-preview-dialog': 'dialog',
        'preview-image': 'img',
        'close-dialog-btn': 'button',
        'commission-input': 'input',
        'department-select': 'select',
        'asortment-group-select': 'select',
        'show-button': 'button',
        'reset-button': 'button',
        'buttons-space': 'div',
        'file-error-message': 'div'
    };

    let host = document.getElementById('recalc-form-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'recalc-form-host';
        host.style.display = 'none';
        host.setAttribute('aria-hidden', 'true');
        document.body.appendChild(host);
    }

    for (const [id, tag] of Object.entries(ids)) {
        if (!document.getElementById(id)) {
            const el = document.createElement(tag);
            el.id = id;
            host.appendChild(el);
        }
    }

    // .attachment-label — może być w ukrytym hoście (potrzebne tylko do .textContent='')
    if (!document.querySelector('.attachment-label')) {
        const label = document.createElement('div');
        label.className = 'attachment-label';
        host.appendChild(label);
    }
    // .hourglass i .overlay — wymagane przez startSpin/stopSpin w form.js, ale
    // nie chcemy ich pokazywać (mamy własny #recalc-overlay). Umieszczamy poza ekranem
    // i wymuszamy ukrycie przez !important — wewnętrzne stopSpin/startSpin zmieniają
    // style.display, ale !important w cssText nie pozwoli im się pokazać.
    const offscreenStyle = 'position:fixed!important;left:-9999px!important;top:-9999px!important;width:1px!important;height:1px!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;';
    if (!document.querySelector('.hourglass')) {
        const hg = document.createElement('div');
        hg.className = 'hourglass';
        hg.style.cssText = offscreenStyle;
        document.body.appendChild(hg);
    } else {
        document.querySelector('.hourglass').style.cssText = offscreenStyle;
    }
    if (!document.querySelector('.overlay')) {
        const ov = document.createElement('div');
        ov.className = 'overlay';
        ov.style.cssText = offscreenStyle;
        document.body.appendChild(ov);
    } else {
        document.querySelector('.overlay').style.cssText = offscreenStyle;
    }
}

const FORM_HOST_ID = 'dynamic-form';
const POLL_INTERVAL_MS = 50;
const MAX_WAIT_MS = 30000; // 30s na pojedynczą pozycję

/**
 * Czeka aż wszystkie obliczenia (skrypty/formuły) się zakończą.
 * Używa tych samych flag co reszta projektu: calculationQueue + finishFlag.
 */
function waitForCalculations() {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const queueEmpty = !window.calculationQueue || window.calculationQueue.length === 0;
            const finished = window.finishFlag === true;
            // Akceptujemy też stan "queue puste i nigdy nic nie ruszało" — jeśli po 2s
            // nic się nie zaczęło liczyć, zakładamy że nie ma czego liczyć.
            const elapsedQuiet = Date.now() - start > 2000 && queueEmpty;
            if ((queueEmpty && finished) || elapsedQuiet) {
                return resolve();
            }
            if (Date.now() - start > MAX_WAIT_MS) {
                return reject(new Error('Przekroczono czas oczekiwania na obliczenia'));
            }
            setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
    });
}

/**
 * Czyści host formularza przed kolejną pozycją — kasuje DOM i window state ustawiany
 * przez generateForm. Bez tego pozostałości z poprzedniej pozycji wpływają na obliczenia.
 */
function resetFormHost() {
    const host = document.getElementById(FORM_HOST_ID);
    if (host) host.innerHTML = '';
    // Reset globalnych stanów ustawianych przez generateForm
    window.lastChangedField = null;
    window.calculationQueue = [];
    window.isCalculating = false;
    window.isPriceCalculating = false;
    window.finishFlag = false;
    window.formInputs = null;
    window.formValues = null;
    window.formDisplayValues = null;
    window.allOptionsByParameter = null;
    window.calculatedParams = new Set();
    window.lockedParams = [];
    window.subParams = [];
    window.skipCountParams = [];
    window.enabledParams = {};
    window.checkedParams = {};
    window.shortJson = {};
    window.constValues = {};
    window.inputsValidators = {};
    window.inputsDefaults = {};
    window.inputFlags = {};
}

/**
 * Dla użytkowników niebędących klientem generateForm pomija tworzenie inputów
 * SUB___. Bez nich applyPriceToInput nie woła buildValuesToDisplay dla SUB___
 * i wpisy te wypadają z json_parameters_desc. Przywracamy je, kopiując wartość
 * z obliczonego bazowego parametru (SUB___CENA ← CENA, itd.).
 */
/**
 * Po waitForCalculations() skrypty cennikowe zaktualizowały window.lockedParams
 * i window.subParams. buildValuesToDisplay ustawia locked/sub tylko przy tworzeniu
 * nowego wpisu (gdy entry jeszcze nie istnieje). Dla istniejących wpisów (przekazanych
 * przez stare valuesToDisplay) locked/sub pozostają z poprzedniego zapisu.
 * Przywracamy je tutaj z globalnych list.
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

function syncSubPriceDisplayEntries(displayValues) {
    const params = window.params || [];
    const locked = window.lockedParams || [];
    const sub = window.subParams || [];
    for (const param of params) {
        if (!param?.NAME?.startsWith('SUB___')) continue;
        const baseParamName = param.NAME.slice(6);
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
 * API base for recalculate endpoints — correction mode uses admin routes.
 */
function getRecalculateApiBase(orderId) {
    if (window.correctionMode && window.correctionApiBase) {
        return window.correctionApiBase;
    }
    return `/orders/order/${orderId}`;
}

/**
 * Pobiera listę pozycji do przeliczenia z backendu.
 */
async function fetchPositions(orderId) {
    const response = await fetch(`${getRecalculateApiBase(orderId)}/positions-data`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Nie udało się pobrać pozycji (${response.status})`);
    }
    const data = await response.json();
    if (!data.success) throw new Error(data.message || 'Błąd pobierania pozycji');
    // Waluta klienta zamówienia (services/currency.js) — bez niej przeliczenie
    // nie poprawia znacznika waluty w opisach pozycji (formTools/currencyLabel.js).
    if (typeof data.priceCurrency === 'string') window.priceCurrency = data.priceCurrency;
    return data.positions || [];
}

/**
 * Rekonstruuje formularz dla pojedynczej pozycji i zwraca przeliczone dane.
 * Logika jest identyczna z admin_edit_form.js (init + forceRecalculation).
 */
async function recalculatePosition(position) {
    resetFormHost();

    // Parsowanie wartości (z bazy mogą być zwrócone jako stringi JSON lub obiekty)
    let values = position.json_parameters;
    if (typeof values === 'string') {
        try { values = JSON.parse(values); } catch { values = {}; }
    }
    values = values || {};

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

    // Buduj mapę displayValues i zeruj locked — stare blokady nie mogą przenosić się
    // na nowy formularz (chcemy obliczenia od zera jak przy nowej pozycji).
    const valuesToDisplay = new Map(valuesToDisplayList);
    for (const entry of valuesToDisplay.values()) {
        if (entry && typeof entry === 'object') entry.locked = false;
    }

    const groupNumber = String(position.asortment_group_number);
    const latestVersion = await getLatestVersion(groupNumber) || position.ver;
    const lang = position.lang || 'pl';

    // Zawsze tworzymy świeżą instancję FormsManager dla każdej pozycji —
    // identycznie jak admin_edit_form.js. Reużywanie między pozycjami może
    // pozostawić stale state (cached groups, current group pointer) z poprzedniej pozycji.
    window.formsManager = new FormsManager();
    const departments = await window.formsManager.getAvailableForms();
    const department = departments.find(d => d.products?.includes(groupNumber));
    if (!department) {
        throw new Error(`Nie znaleziono departamentu dla grupy ${groupNumber}`);
    }
    await window.formsManager.getGroups(department.num);
    window.formsManager.setCurrentRootPath(groupNumber);
    window.formsManager.setCurrentGroup(groupNumber);

    // Generuj formularz w trybie edit — identycznie jak admin_edit_form.js.
    // editFlag=true: fillFields() pre-fill inputs ze starych values.
    // Używamy latestVersion — nowe parametry z aktualnego schematu są uwzględniane.
    const result = await generateForm(latestVersion, groupNumber, values, valuesToDisplay, true, lang);
    if (!result) throw new Error(`Nie udało się wygenerować formularza (v${latestVersion}, gr=${groupNumber})`);

    const [inputs, newValues, newValuesToDisplay] = result;

    // ---- forceRecalculation (identyczne z admin_edit_form.js) ----

    // Zeruj wszystkie parametry kalkulowane/formułowe przed wymuszeniem przeliczenia.
    // Stare wartości zapisane w DB (np. CENA=96.75) mogą powodować skróty w skryptach
    // cennikowych — zerowanie gwarantuje że scripts liczą od zera jak przy nowej pozycji.
    const paramsList = window.params || [];
    for (const p of paramsList) {
        if (!p?.NAME) continue;
        if (p.SCRIPTS !== '<NULL>' || p.FORMULA !== '<NULL>') {
            newValues[p.NAME] = 0;
            if (inputs[p.NAME]) inputs[p.NAME].value = 0;
        }
    }

    // Wybieramy pierwszy param użytkownika (nie kalkulowany) z realną wartością
    // jako trigger — kalkulowane są wynikami, nie wejściami.
    let firstName = null;
    for (const p of paramsList) {
        if (!p?.NAME) continue;
        if (p.NAME.includes('___')) continue;
        if (!inputs[p.NAME]) continue;
        if (p.SCRIPTS !== '<NULL>' || p.FORMULA !== '<NULL>') continue;
        if (newValues[p.NAME] === undefined || newValues[p.NAME] === '' || newValues[p.NAME] === 0) continue;
        firstName = p.NAME;
        break;
    }
    if (firstName) {
        window.lastChangedField = {
            name: firstName,
            value: newValues[firstName],
            tagName: inputs[firstName]?.tagName || 'INPUT',
            timestamp: Date.now()
        };
        await recalculateLastChangedField();
    } else {
        console.warn(`[recalculate] Pozycja ${position.id}: nie znaleziono parametru do wymuszenia przeliczenia`);
    }
    await waitForCalculations();

    // ---- post-processing (identyczne z admin_edit_form.js) ----

    // Synchronizuj locked/sub flagi ze stanu po obliczeniach. buildValuesToDisplay
    // ustawia te flagi tylko przy tworzeniu nowego wpisu — dla istniejących wpisów
    // (przekazanych przez valuesToDisplay) trzeba je zaktualizować ręcznie.
    syncLockedAndSubFlags(newValuesToDisplay);

    // Dla adminów generateForm pomija tworzenie inputów SUB___. Uzupełniamy je ręcznie.
    syncSubPriceDisplayEntries(newValuesToDisplay);

    const total = getTotal(newValuesToDisplay);
    const jsonValuesToDisplay = JSON.stringify(Array.from(newValuesToDisplay.entries()));

    return {
        id: position.id,
        commission: position.commision || '',
        comment: position.comment || '',
        jsonValues: newValues,
        jsonValuesToDisplay,
        jsonShort: window.shortJson || {},
        total
    };
}

/**
 * Wysyła przeliczone pozycje do backendu (atomowo).
 */
async function saveRecalculated(orderId, recalculated) {
    const response = await fetch(`${getRecalculateApiBase(orderId)}/recalculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: recalculated })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
        throw new Error(data.message || `Błąd zapisu (${response.status})`);
    }
    return data;
}

/**
 * Główna funkcja — wywoływana przez przycisk "Przelicz wszystkie pozycje".
 */
export async function recalculateOrder(orderId) {
    if (!orderId) {
        showToast('error', t('order.recalculate_no_id'));
        return;
    }

    const btn = document.getElementById('recalculate-order-btn');
    if (btn) btn.disabled = true;

    try {
        ensureFormHostElements();
        // Pokaż własny overlay z spinnerem i etykietą — niezależny od .hourglass/.overlay
        // które wewnętrznie używa generateForm. Pokazany raz, ukryty w finally.
        showProgress(0, 0, t('order.recalculate_starting'));
        const positions = await fetchPositions(orderId);
        if (positions.length === 0) {
            showToast('info', t('order.recalculate_no_positions'));
            return;
        }

        showToast('info', `${t('order.recalculate_progress')} ${positions.length}...`);

        const recalculated = [];
        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];
            console.log(`[recalculate] Pozycja ${i + 1}/${positions.length} (id=${pos.id})`);
            showProgress(i + 1, positions.length);
            try {
                const result = await recalculatePosition(pos);
                recalculated.push(result);
            } catch (err) {
                console.error(`[recalculate] Błąd przy pozycji ${pos.id}:`, err);
                throw new Error(`Pozycja ${pos.id}: ${err.message}`);
            }
        }

        showProgress(positions.length, positions.length, t('order.recalculate_saving'));
        // Wszystkie pozycje przeliczone — zapisujemy atomowo
        const saveResult = await saveRecalculated(orderId, recalculated);
        showToast('success', saveResult.message || 'Przeliczono pomyślnie');

        // Reload strony żeby pokazać zaktualizowane dane
        setTimeout(() => {
            window.location.reload();
        }, 1500);
    } catch (err) {
        console.error('[recalculate] Błąd:', err);
        showToast('error', err.message || 'Błąd podczas przeliczania zamówienia');
        if (btn) btn.disabled = false;
    } finally {
        hideProgress();
    }
}

/**
 * Wpina handler do przycisku — wywoływane na stronie zamówienia.
 */
export function initRecalculateButton(orderId) {
    const btn = document.getElementById('recalculate-order-btn');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const confirmed = await confirmPrompt({
            title: t('order.recalculate_title'),
            message: t('order.recalculate_confirm'),
            confirmLabel: t('order.recalculate_btn'),
            cancelLabel: t('order.cancel'),
            confirmClass: 'btn btn-dark',
            cancelClass: 'btn btn-outline-secondary'
        });
        if (!confirmed) return;
        recalculateOrder(orderId);
    });
}

// Auto-init gdy skrypt jest załadowany na stronie zamówienia
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('recalculate-order-btn');
    if (btn) {
        const orderId = btn.dataset.orderId;
        initRecalculateButton(orderId);
    }
});
