/*
 * Skróty klawiszowe konta biura (wszystkie strony poza oknem pozycji).
 * Pojedyncze litery bez modyfikatorów — nie działają w polach tekstowych,
 * listach i przy otwartym oknie, a przeglądarki ich nie używają
 * (Ctrl/Alt/Cmd + litera zostają dla przeglądarki; „/" pomijamy — szybkie
 * wyszukiwanie Firefoksa). Ściągawka pod „?".
 */

const tr = (key) => (typeof window.t === 'function' && window.t(key)) || key;

const SHORTCUTS = [
    { key: 'n', label: 'staff.shortcuts.new_order', run: () => { window.location.href = '/orders/add-order'; } },
    {
        key: 'p',
        label: 'staff.shortcuts.new_position',
        run: () => {
            // W podglądzie zlecenia: „Dodaj pozycję" (okno biura — staff/positionDialog.js).
            const add = document.querySelector('a#new-order-button, a[href$="/new-position/"]');
            if (add) add.click();
            return !!add;
        }
    },
    {
        key: 'k',
        label: 'staff.shortcuts.change_client',
        run: () => {
            const input = document.getElementById('staff-client-input');
            if (input) input.focus();
            else window.location.href = '/staff';
        }
    }
];

function isEditable(el) {
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

let help = null;
function toggleHelp() {
    if (!help) {
        help = document.createElement('dialog');
        help.className = 'staff-shortcuts';
        help.setAttribute('aria-labelledby', 'staff-shortcuts-title');
        const h = document.createElement('h2');
        h.id = 'staff-shortcuts-title';
        h.textContent = tr('staff.shortcuts.title');
        const list = document.createElement('dl');
        [...SHORTCUTS, { key: '?', label: 'staff.shortcuts.help' }].forEach(({ key, label }) => {
            const dt = document.createElement('dt');
            const kbd = document.createElement('kbd');
            kbd.textContent = key.toUpperCase();
            dt.append(kbd);
            const dd = document.createElement('dd');
            dd.textContent = tr(label);
            list.append(dt, dd);
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-outline-secondary btn-sm';
        close.textContent = tr('staff.raw.close');
        close.addEventListener('click', () => help.close());
        help.append(h, list, close);
        document.body.append(help);
    }
    if (help.open) help.close();
    else help.showModal();
}

document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (isEditable(e.target)) return;
    if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
    if (document.querySelector('dialog[open]')) return;
    const shortcut = SHORTCUTS.find((s) => s.key === e.key.toLowerCase() && !e.shiftKey);
    if (!shortcut) return;
    e.preventDefault();
    shortcut.run();
});
