/*
 * Wybór klienta przez konto biura (templates/partials/staff_client_picker.njk).
 * Jedno pole „wpisz i wybierz”: po otwarciu lista „ostatnio wybierani” (/recent-clients),
 * pod nią pozostali dozwoleni klienci; wpisywanie zawęża listę (GET /staff/api/clients).
 * Wybór: POST /staff/context — serwer sprawdza dostęp i ustawia kontekst; dopiero wtedy
 * przechodzimy dalej. Pole zostaje z nazwą wybranego klienta.
 */

const tr = (key) => (typeof window.t === 'function' && window.t(key)) || key;

function initPicker(root) {
    const input = root.querySelector('[role="combobox"]');
    const list = root.querySelector('[role="listbox"]');
    const meta = root.querySelector('.staff-picker__meta');
    const status = root.querySelector('.staff-picker__status');
    const current = { ident: root.dataset.currentIdent || '', name: root.dataset.currentName || '' };
    let items = [];          // tylko wybieralne wiersze (bez nagłówków), w kolejności na liście
    let active = -1;
    let timer = null;
    let controller = null;
    let typed = false;
    let busy = false;
    let recent = null;

    const recentReady = fetch('/recent-clients', { credentials: 'include' })
        .then((res) => res.json())
        .then((rows) => { recent = (Array.isArray(rows) ? rows : []).slice(0, 8).map((c) => ({ ident: c.ident, name: c.name, organization: c.organization })); })
        .catch(() => { recent = []; });

    function close() {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function restore() {
        if (busy) return;
        input.value = current.name;
        typed = false;
    }

    function highlight() {
        list.querySelectorAll('[role="option"]').forEach((li) => li.setAttribute('aria-selected', String(Number(li.dataset.index) === active)));
        const el = list.querySelector(`[data-index="${active}"]`);
        if (el) {
            input.setAttribute('aria-activedescendant', el.id);
            el.scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function header(text) {
        const li = document.createElement('li');
        li.className = 'staff-picker__header';
        li.setAttribute('role', 'presentation');
        li.textContent = text;
        list.append(li);
    }

    function option(c) {
        const index = items.length;
        items.push(c);
        const li = document.createElement('li');
        li.id = `staff-client-opt-${index}`;
        li.dataset.index = String(index);
        li.className = 'staff-picker__option';
        if (c.ident && c.ident === current.ident) li.classList.add('is-current');
        li.setAttribute('role', 'option');
        const name = document.createElement('strong');
        name.textContent = c.name || c.ident;
        const info = document.createElement('span');
        info.className = 'staff-muted';
        info.textContent = [c.ident, c.pin ? `PIN ${c.pin}` : '', c.city, c.organization].filter(Boolean).join(' · ');
        li.append(name, ' ', info);
        // mousedown, nie click — blur pola zamyka listę przed kliknięciem
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(c); });
        list.append(li);
    }

    /** sections: [{ title, clients }] — nagłówek tylko, gdy sekcji jest więcej niż jedna. */
    function render(sections) {
        items = [];
        list.innerHTML = '';
        const nonEmpty = sections.filter((s) => s.clients.length);
        if (!nonEmpty.length) {
            const li = document.createElement('li');
            li.className = 'staff-picker__empty';
            li.setAttribute('role', 'presentation');
            li.textContent = tr('staff.no_clients_found');
            list.append(li);
        }
        nonEmpty.forEach((s) => {
            if (nonEmpty.length > 1 && s.title) header(s.title);
            s.clients.forEach(option);
        });
        const at = items.findIndex((c) => c.ident === current.ident);
        active = items.length ? (typed || at < 0 ? 0 : at) : -1;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        highlight();
    }

    async function fetchClients(q) {
        if (controller) controller.abort();
        controller = new AbortController();
        const res = await fetch(`/staff/api/clients?q=${encodeURIComponent(q)}&limit=30`, { signal: controller.signal, credentials: 'include' });
        const data = await res.json();
        return data.success ? data.clients : [];
    }

    async function show() {
        const q = typed ? input.value.trim() : '';
        try {
            if (q) {
                render([{ clients: await fetchClients(q) }]);
                return;
            }
            const [all] = await Promise.all([fetchClients(''), recentReady]);
            const seen = new Set((recent || []).map((c) => String(c.ident).toUpperCase()));
            render([
                { title: tr('staff.recent_clients'), clients: recent || [] },
                { title: tr('staff.all_clients'), clients: all.filter((c) => !seen.has(String(c.ident).toUpperCase())) }
            ]);
        } catch (e) {
            if (e.name !== 'AbortError') render([]);
        }
    }

    async function choose(client) {
        close();
        input.value = client.name || client.ident;
        if (client.ident === current.ident) { typed = false; return; }
        busy = true;
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
            current.ident = data.client.ident;
            current.name = data.client.name || data.client.ident;
            input.value = current.name;
            if (meta) meta.textContent = [data.client.ident, data.client.organization].filter(Boolean).join(' · ');
            const after = root.closest('[data-staff-picker-after]')?.dataset.staffPickerAfter;
            if (after === 'reload') window.location.reload();
            else window.location.href = `/staff?client=${encodeURIComponent(data.client.ident)}`;
        } catch (e) {
            busy = false;
            status.textContent = e.message;
            restore();
        }
    }

    input.addEventListener('focus', () => input.select());
    input.addEventListener('mousedown', () => { if (list.hidden) setTimeout(show, 0); });
    root.querySelector('.staff-picker__chevron')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.focus();
        if (list.hidden) show(); else close();
    });
    input.addEventListener('input', () => {
        typed = true;
        clearTimeout(timer);
        timer = setTimeout(show, 200);
    });
    input.addEventListener('blur', () => setTimeout(() => { close(); restore(); }, 150));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (list.hidden) show();
            else if (items.length) { active = (active + 1) % items.length; highlight(); }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length) { active = (active - 1 + items.length) % items.length; highlight(); }
        } else if (e.key === 'Enter') {
            // Enter na stronie nowego zlecenia zapisuje zlecenie (orders.js) — tu wybiera klienta.
            e.preventDefault();
            e.stopPropagation();
            if (!list.hidden && items[active]) choose(items[active]);
            else show();
        } else if (e.key === 'Escape' && !list.hidden) {
            // Esc zamyka listę, a nie opuszcza strony (globalny skrót w base.njk).
            e.preventDefault();
            e.stopPropagation();
            close();
            restore();
            input.select();
        }
    });
}

document.querySelectorAll('[data-staff-picker]').forEach(initPicker);
