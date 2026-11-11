/*
 * Tryb surowy formularza pozycji — okno konta biura (templates/form.njk i
 * edit_position.njk z `?raw=1`, otwierane w <iframe> przez staff/positionDialog.js).
 *
 * ⚠️ Nic tu nie liczy cen: formularz buduje i wycenia ten sam silnik
 * (main.js / edit_form.js → generateForm). Ten moduł tylko:
 *   • dokłada pasek na dole: suma na żywo + „Zapisz” / „Zapisz i dodaj kolejną” / „Zapisz i nowa”,
 *     które klikają zwykły przycisk zapisu silnika (#show-button);
 *   • obsługuje klawiaturę: Enter w ostatnim polu = zapis, Esc = zamknij okno (z pytaniem przy zmianach);
 *   • zamienia listy i przyciski okna kafelków na pola „wpisz i wybierz” (staff/rawCombo.js);
 *   • rozmawia z oknem nadrzędnym przez postMessage (ta sama domena).
 */

import { getTotal } from '/scripts/form.js';
import { initRawCombos } from '/scripts/staff/rawCombo.js';

const tr = (key) => (typeof window.t === 'function' && window.t(key)) || key;
const isEdit = !!document.getElementById('positionId');
const form = document.getElementById('dynamic-form');
const combos = initRawCombos();
let mode = 'close';
let dirty = false;
let saving = false;

function notify(action, extra = {}) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'eform-raw', action, ...extra }, window.location.origin);
}

/* ---------- Pasek: suma + przyciski ---------- */

const bar = document.createElement('div');
bar.className = 'raw-bar';
const total = document.createElement('div');
total.className = 'raw-bar__total';
total.setAttribute('aria-live', 'polite');
const actions = document.createElement('div');
actions.className = 'raw-bar__actions';

function button(label, saveMode, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'btn btn-primary' : 'btn btn-outline-primary';
    b.textContent = label;
    b.disabled = true;
    b.addEventListener('click', () => save(saveMode));
    actions.append(b);
    return b;
}
const buttons = [button(tr('staff.raw.save'), 'close', true)];
if (!isEdit) {
    buttons.push(button(tr('staff.raw.save_same'), 'same', false));
    buttons.push(button(tr('staff.raw.save_new'), 'new', false));
}
const status = document.createElement('div');
status.className = 'raw-bar__status';
status.setAttribute('role', 'status');
bar.append(total, status, actions);
document.body.append(bar);

function showButton() {
    return document.getElementById('show-button');
}

function save(saveMode) {
    const btn = showButton();
    if (saving || !btn || typeof btn.onclick !== 'function') return;
    mode = saveMode;
    saving = true;
    status.textContent = tr('staff.raw.saving');
    // Znaczniki z poprzedniej próby — walidacja silnika (main.js) doda je od nowa.
    form?.querySelectorAll('.invalid-input').forEach((el) => el.classList.remove('invalid-input'));
    clickWhenIdle(btn);
    // Odrzucenie przez walidację nie wysyła zdarzenia — rozpoznajemy je po zaznaczonych polach.
    const started = Date.now();
    const watch = setInterval(() => {
        if (!saving) { clearInterval(watch); return; }
        const invalid = form?.querySelector('.invalid-input');
        if (invalid) {
            saving = false;
            status.textContent = tr('form.incorrect_data');
            clearInterval(watch);
            (combos.inputFor(invalid) || invalid).focus?.();
        } else if (Date.now() - started > 20000) {
            saving = false;
            status.textContent = '';
            clearInterval(watch);
        }
    }, 300);
}

// Silnik na czas przeliczania wyłącza #show-button (form.js disableFormButtons), a click()
// na wyłączonym przycisku nic nie robi — klikamy dopiero po zakończeniu obliczeń.
function clickWhenIdle(btn, started = Date.now()) {
    const busy = window.isCalculating || (window.calculationQueue?.length ?? 0) > 0 || btn.disabled;
    if (!busy) { btn.click(); return; }
    if (Date.now() - started > 30000) { saving = false; status.textContent = tr('form.incorrect_data'); return; }
    setTimeout(() => clickWhenIdle(btn, started), 100);
}

// Zapis jest gotowy, gdy silnik podepnie #show-button (main.js po zbudowaniu formularza).
setInterval(() => {
    const ready = typeof showButton()?.onclick === 'function';
    buttons.forEach((b) => { b.disabled = !ready; });
}, 300);

const money = (n) => (Number.isFinite(n) ? n.toFixed(2) : '–');
function refreshTotal() {
    const values = window.formDisplayValues;
    if (!(values instanceof Map) || !values.size) { total.textContent = ''; return; }
    const sums = getTotal(values) || {};
    const currency = window.priceCurrency || 'EUR';
    const parts = [`${tr('staff.raw.total')}: ${money(Number(sums.total))} ${currency}`];
    if (Number(sums.total_hidden) > 0 && Number(sums.total_hidden) !== Number(sums.total)) parts.push(`${tr('staff.raw.total_hidden')}: ${money(Number(sums.total_hidden))} ${currency}`);
    if (Number(sums.total_sub) > 0) parts.push(`SUB: ${money(Number(sums.total_sub))} ${currency}`);
    total.textContent = parts.join(' · ');
}
setInterval(refreshTotal, 500);

window.addEventListener('raw-position-saved', () => {
    saving = false;
    dirty = false;
    status.textContent = tr('staff.raw.saved');
    if (mode === 'close' || isEdit) {
        notify('saved', { close: true });
        return;
    }
    notify('saved', { close: false });
    if (mode === 'new') {
        // Przeładowanie wraca do tej samej grupy z wartościami domyślnymi (main.js, refreshFormBehaviour).
        window.location.reload();
        return;
    }
    // „Te same wartości": formularz zostaje; załączniki nie przechodzą na kolejną pozycję.
    document.querySelectorAll('input[type="file"]').forEach((input) => { input.value = ''; });
});

form?.addEventListener('input', () => { dirty = true; notify('dirty', { dirty: true }); });
form?.addEventListener('change', () => { dirty = true; notify('dirty', { dirty: true }); });

/* ---------- Klawiatura ---------- */

// Natywne pola ukryte pod polami „wpisz i wybierz” (.raw-native) nie są polami do przejścia.
const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([disabled]):not(.raw-native), select:not([disabled]):not(.raw-native)';
function isVisible(el) {
    return !!(el.offsetParent || el.getClientRects().length);
}
function lastField() {
    const fields = Array.from(form?.querySelectorAll(FIELD_SELECTOR) || []).filter(isVisible);
    return fields[fields.length - 1] || null;
}
function nestedWindowOpen() {
    if (document.querySelector('dialog[open]')) return true;
    const slope = document.getElementById('slope-modal');
    return !!(slope && isVisible(slope));
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Globalny skrót strony (base.njk) przeniósłby ramkę na inną stronę.
        e.stopPropagation();
        if (combos.isOpen()) { e.preventDefault(); combos.close(); return; }
        if (nestedWindowOpen()) return; // okno zagnieżdżone zamyka się samo
        e.preventDefault();
        notify('close-request', { dirty });
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !combos.isOpen()) {
        const target = e.target;
        if (target && target === lastField() && target.tagName !== 'TEXTAREA') {
            e.preventDefault();
            save('close');
        }
    }
}, true);

/* ---------- Okno nadrzędne ---------- */

notify('location', { href: window.location.pathname + window.location.search, edit: isEdit });
// Fokus na pierwszym polu wyboru: dział/grupa przy nowej pozycji, pierwszy parametr przy edycji.
setTimeout(() => {
    const dep = document.querySelector('#department-select:not([disabled])');
    const first = (dep && combos.inputFor(dep)) || form?.querySelector(FIELD_SELECTOR);
    if (first && isVisible(first)) first.focus();
}, 800);
