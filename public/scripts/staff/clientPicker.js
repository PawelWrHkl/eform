/*
 * Wybór klienta przez konto biura (templates/partials/staff_client_picker.njk).
 * Podpowiedzi: GET /staff/api/clients (tylko dozwoleni klienci), wybór: POST /staff/context
 * — serwer sprawdza dostęp i ustawia kontekst; dopiero wtedy przechodzimy dalej.
 */

const tr = (key) => (typeof window.t === 'function' && window.t(key)) || key;

function initPicker(root) {
    const input = root.querySelector('[role="combobox"]');
    const list = root.querySelector('[role="listbox"]');
    const recentBox = root.querySelector('[data-staff-recent]');
    const status = root.querySelector('.staff-picker__status');
    let items = [];
    let active = -1;
    let timer = null;
    let controller = null;

    function close() {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function highlight() {
        Array.from(list.children).forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
        if (active >= 0 && list.children[active]) {
            input.setAttribute('aria-activedescendant', list.children[active].id);
            list.children[active].scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function render(clients) {
        items = clients;
        active = clients.length ? 0 : -1;
        list.innerHTML = '';
        if (!clients.length) {
            const li = document.createElement('li');
            li.className = 'staff-picker__empty';
            li.setAttribute('role', 'option');
            li.setAttribute('aria-disabled', 'true');
            li.textContent = tr('staff.no_clients_found');
            list.append(li);
        }
        clients.forEach((c, i) => {
            const li = document.createElement('li');
            li.id = `staff-client-opt-${i}`;
            li.className = 'staff-picker__option';
            li.setAttribute('role', 'option');
            const name = document.createElement('strong');
            name.textContent = c.name || c.ident;
            const meta = document.createElement('span');
            meta.className = 'staff-muted';
            meta.textContent = [c.ident, c.pin ? `PIN ${c.pin}` : '', c.city, c.organization].filter(Boolean).join(' · ');
            li.append(name, ' ', meta);
            // mousedown, nie click — blur pola zamyka listę przed kliknięciem
            li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(c); });
            list.append(li);
        });
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        highlight();
    }

    async function search(q) {
        if (controller) controller.abort();
        controller = new AbortController();
        try {
            const res = await fetch(`/staff/api/clients?q=${encodeURIComponent(q)}&limit=20`, { signal: controller.signal, credentials: 'include' });
            const data = await res.json();
            render(data.success ? data.clients : []);
        } catch (e) {
            if (e.name !== 'AbortError') render([]);
        }
    }

    async function choose(client) {
        close();
        input.value = client.name || client.ident;
        status.textContent = tr('staff.switching_client');
        try {
            const res = await fetch('/staff/context', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ident: client.ident })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || tr('staff.client_denied'));
            const after = root.closest('[data-staff-picker-after]')?.dataset.staffPickerAfter;
            if (after === 'reload') window.location.reload();
            else window.location.href = `/staff?client=${encodeURIComponent(data.client.ident)}`;
        } catch (e) {
            status.textContent = e.message;
        }
    }

    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => search(input.value.trim()), 200);
    });
    input.addEventListener('focus', () => { if (list.hidden) search(input.value.trim()); });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (list.hidden) search(input.value.trim());
            else if (items.length) { active = (active + 1) % items.length; highlight(); }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length) { active = (active - 1 + items.length) % items.length; highlight(); }
        } else if (e.key === 'Enter') {
            // Enter na stronie nowego zlecenia zapisuje zlecenie (orders.js) — tu wybiera klienta.
            e.preventDefault();
            e.stopPropagation();
            if (!list.hidden && items[active]) choose(items[active]);
        } else if (e.key === 'Escape' && !list.hidden) {
            // Esc zamyka listę, a nie opuszcza strony (globalny skrót w base.njk).
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    });

    fetch('/recent-clients', { credentials: 'include' })
        .then((res) => res.json())
        .then((recent) => {
            (Array.isArray(recent) ? recent : []).slice(0, 8).forEach((c) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn btn-outline-secondary btn-sm';
                b.textContent = c.name || c.ident;
                b.title = [c.ident, c.organization].filter(Boolean).join(' · ');
                b.addEventListener('click', () => choose({ ident: c.ident, name: c.name }));
                recentBox.append(b);
            });
        })
        .catch(() => {});
}

document.querySelectorAll('[data-staff-picker]').forEach(initPicker);
