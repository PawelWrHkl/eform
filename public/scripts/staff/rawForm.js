/*
 * Tryb surowy formularza pozycji — okno konta biura (templates/form.njk i
 * edit_position.njk z `?raw=1`, otwierane w <iframe> przez staff/positionDialog.js).
 *
 * ⚠️ Nic tu nie liczy cen: formularz buduje i wycenia ten sam silnik
 * (main.js / edit_form.js → generateForm). Ten moduł tylko:
 *   • dokłada pasek na dole: suma na żywo + „Zapisz” / „Zapisz i dodaj kolejną” / „Zapisz i nowa”,
 *     które klikają zwykły przycisk zapisu silnika (#show-button);
 *   • obsługuje klawiaturę: Enter w ostatnim polu = zapis, Esc = zamknij okno (z pytaniem przy zmianach),
 *     wpisywanie tekstu na liście wyboru = wyszukiwanie;
 *   • rozmawia z oknem nadrzędnym przez postMessage (ta sama domena).
 */

import { getTotal } from '/scripts/form.js';

const tr = (key) => (typeof window.t === 'function' && window.t(key)) || key;
const isEdit = !!document.getElementById('positionId');
const form = document.getElementById('dynamic-form');
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
        if (form?.querySelector('.invalid-input')) {
            saving = false;
            status.textContent = tr('form.incorrect_data');
            clearInterval(watch);
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

const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([disabled]), select:not([disabled])';
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
        if (searchPopup.isOpen()) { e.preventDefault(); searchPopup.close(); return; }
        if (nestedWindowOpen()) return; // okno zagnieżdżone zamyka się samo
        e.preventDefault();
        notify('close-request', { dirty });
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !searchPopup.isOpen()) {
        const target = e.target;
        if (target && target === lastField() && target.tagName !== 'TEXTAREA') {
            e.preventDefault();
            save('close');
        }
    }
}, true);

/* ---------- Wyszukiwanie w listach wyboru ---------- */

const searchPopup = (() => {
    const box = document.createElement('div');
    box.className = 'raw-search';
    box.hidden = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control form-control-sm';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'raw-search-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', tr('staff.raw.search_options'));
    const list = document.createElement('ul');
    list.id = 'raw-search-list';
    list.setAttribute('role', 'listbox');
    box.append(input, list);
    document.body.append(box);

    let select = null;
    let matches = [];
    let active = 0;

    const usable = (o) => o.value !== '' && !o.disabled && !o.hidden && o.style.display !== 'none';

    function render() {
        const q = input.value.trim().toLowerCase();
        matches = Array.from(select.options).filter((o) => usable(o) && o.text.toLowerCase().includes(q)).slice(0, 60);
        active = Math.min(active, Math.max(matches.length - 1, 0));
        list.innerHTML = '';
        matches.forEach((o, i) => {
            const li = document.createElement('li');
            li.id = `raw-search-opt-${i}`;
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', String(i === active));
            li.textContent = o.text;
            li.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(i); });
            list.append(li);
        });
        if (matches.length) {
            input.setAttribute('aria-activedescendant', `raw-search-opt-${active}`);
            list.children[active].scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }
    function open(target, firstChar) {
        select = target;
        const rect = target.getBoundingClientRect();
        box.style.top = `${rect.bottom + window.scrollY + 2}px`;
        box.style.left = `${rect.left + window.scrollX}px`;
        box.style.width = `${Math.max(rect.width, 280)}px`;
        box.hidden = false;
        input.value = firstChar;
        active = 0;
        render();
        input.focus();
    }
    function close(refocus = true) {
        if (box.hidden) return;
        box.hidden = true;
        if (refocus && select) select.focus();
    }
    function pick(i) {
        const option = matches[i];
        if (!option) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        close();
    }
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(active); }
        else if (e.key === 'Tab') { close(false); }
    });
    input.addEventListener('blur', () => setTimeout(() => close(false), 150));

    document.addEventListener('keydown', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLSelectElement) || box.hidden === false) return;
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.key === ' ') return;
        if (!target.closest('#dynamic-form, .asortment-inputs')) return;
        e.preventDefault();
        open(target, e.key);
    });

    return { isOpen: () => !box.hidden, close };
})();

/* ---------- Okno nadrzędne ---------- */

notify('location', { href: window.location.pathname + window.location.search, edit: isEdit });
// Fokus na pierwszym polu wyboru: dział/grupa przy nowej pozycji, pierwszy parametr przy edycji.
setTimeout(() => {
    const first = document.querySelector('#department-select:not([disabled])') || form?.querySelector(FIELD_SELECTOR);
    if (first && isVisible(first)) first.focus();
}, 800);
