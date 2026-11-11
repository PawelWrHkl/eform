/*
 * Okno pozycji konta biura w podglądzie zlecenia (templates/order.njk, tylko staff).
 *
 * „Dodaj pozycję” i „Edytuj” otwierają <dialog> z ramką na ten sam formularz
 * w trybie surowym (`?raw=1`, staff/rawForm.js) — ten sam silnik, te same ceny.
 * Link „Pełny formularz” jest zawsze widoczny: nowa pozycja przechodzi na zwykły
 * form.njk z wartościami z okna (`?resume=1`, localStorage), edycja na zwykłą edycję.
 */

const tr = (key) => (typeof window.t === 'function' && window.t(key)) || key;

const dialog = document.createElement('dialog');
dialog.className = 'staff-raw-dialog';
dialog.setAttribute('aria-labelledby', 'staff-raw-title');
dialog.innerHTML = `
    <div class="staff-raw-dialog__head">
        <h2 id="staff-raw-title" class="staff-raw-dialog__title"></h2>
        <span class="staff-raw-dialog__saved" role="status" aria-live="polite"></span>
        <a class="btn btn-outline-secondary btn-sm staff-raw-dialog__full" href="#"></a>
        <button type="button" class="btn btn-outline-secondary btn-sm staff-raw-dialog__close"></button>
    </div>
    <iframe class="staff-raw-dialog__frame"></iframe>`;
document.body.append(dialog);

const title = dialog.querySelector('.staff-raw-dialog__title');
const savedInfo = dialog.querySelector('.staff-raw-dialog__saved');
const fullLink = dialog.querySelector('.staff-raw-dialog__full');
const closeBtn = dialog.querySelector('.staff-raw-dialog__close');
const frame = dialog.querySelector('iframe');
fullLink.textContent = tr('staff.raw.full_form');
closeBtn.textContent = tr('staff.raw.close');
closeBtn.setAttribute('aria-label', tr('staff.raw.close'));
frame.title = tr('staff.raw.frame_title');

let dirty = false;
let savedCount = 0;

function withRaw(href) {
    const url = new URL(href, window.location.origin);
    url.searchParams.set('raw', '1');
    return url.pathname + url.search;
}

function fullFormHref(href, isEdit) {
    const url = new URL(href, window.location.origin);
    url.searchParams.delete('raw');
    if (!isEdit) url.searchParams.set('resume', '1');
    return url.pathname + url.search;
}

export function openPositionDialog(href, isEdit) {
    dirty = false;
    savedCount = 0;
    savedInfo.textContent = '';
    title.textContent = isEdit ? tr('staff.raw.title_edit') : tr('staff.raw.title_new');
    fullLink.href = fullFormHref(href, isEdit);
    frame.src = withRaw(href);
    dialog.showModal();
    frame.focus();
}

function closeDialog(force = false) {
    if (!force && dirty && !window.confirm(tr('staff.raw.confirm_discard'))) return;
    dialog.close();
    frame.src = 'about:blank';
    // Tabela pozycji jest renderowana na serwerze — po zapisach odświeżamy stronę.
    if (savedCount > 0) window.location.reload();
}

closeBtn.addEventListener('click', () => closeDialog());
dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
// Esc w oknie nie może uruchomić globalnego „wstecz" z base.njk/order.njk.
window.addEventListener('keydown', (e) => {
    if (dialog.open && e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeDialog();
    }
}, true);

window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin || e.source !== frame.contentWindow) return;
    const data = e.data || {};
    if (data.type !== 'eform-raw') return;
    if (data.action === 'dirty') dirty = true;
    else if (data.action === 'close-request') closeDialog();
    else if (data.action === 'location' && data.href) fullLink.href = fullFormHref(data.href, !!data.edit);
    else if (data.action === 'saved') {
        dirty = false;
        savedCount += 1;
        savedInfo.textContent = `${tr('staff.raw.saved_count')}: ${savedCount}`;
        if (data.close) closeDialog(true);
    }
});

// Przechwycenie linków przed ich własnymi onclick (stopPropagation w wierszu tabeli).
document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    // „Pełny formularz" w samym oknie ma prowadzić na zwykłą stronę, nie otwierać okna od nowa.
    if (!link || link.closest('.staff-raw-dialog')) return;
    const path = new URL(link.href, window.location.origin).pathname;
    const isNew = /\/orders\/order\/\d+\/new-position\/?$/.test(path);
    const isEdit = /^\/position\/\d+\/edit\/?$/.test(path);
    if (!isNew && !isEdit) return;
    e.preventDefault();
    e.stopPropagation();
    openPositionDialog(link.href, isEdit);
}, true);

window.eformStaffPositionDialog = { open: openPositionDialog };
