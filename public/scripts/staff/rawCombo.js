/*
 * Pole „wpisz i wybierz” w oknie pozycji konta biura (tryb surowy, staff/rawForm.js).
 *
 * Zastępuje w widoku dwa rodzaje pól formularza:
 *   • przyciski otwierające okno kafelków (DialogManager, formTools/dialogUtils_copy.js),
 *   • zwykłe listy <select> (dział, grupa, parametry).
 * Natywne pola zostają w DOM, ukryte klasą `.raw-native` — silnik czyta i zapisuje tylko je:
 *   • select → `value` + zdarzenie `change` (jak użytkownik),
 *   • przycisk → okno kafelków buduje się bez otwierania (`window.rawDialogHeadless`),
 *     a wybór to kliknięcie TEGO SAMEGO kafelka → dialog-confirm → form.js. Ceny, kupony,
 *     zależności i walidacja idą więc dokładnie tą samą ścieżką co u klienta.
 * Silnik po każdej zmianie podmienia przyciski na klony (updateFieldsAndValues.js), dlatego
 * pole zawsze bierze natywny element z `previousElementSibling`, a nie z zapamiętanej referencji.
 *
 * Zdjęcie wartości: tylko pod ikonką (wiersz listy i pole), obraz ładuje się dopiero przy podglądzie.
 * Moduł nie dotyka DOM przy imporcie — testy (services/__tests__/rawCombo.test.js) ładują
 * czyste funkcje `normalize` / `filterOptions` / `parseTileLabel`.
 */

const tr = (key, fallback) => {
    const v = typeof window !== 'undefined' && typeof window.t === 'function' ? window.t(key) : key;
    return v && v !== key ? v : (fallback || key);
};

/** Tekst do porównań: małe litery, bez polskich i innych znaków diakrytycznych, pojedyncze spacje. */
export function normalize(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ł/g, 'l')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Filtr listy: każde wpisane słowo musi wystąpić w kodzie lub opisie. Kolejność jak w źródle
 * (ulubione na górze), z wyjątkiem trafień od początku kodu — te idą pierwsze.
 * @param {Array<{code: string, desc: string, search?: string}>} options
 */
export function filterOptions(options, query) {
    const tokens = normalize(query).split(' ').filter(Boolean);
    if (!tokens.length) return options.slice();
    const ranked = [];
    options.forEach((option, index) => {
        const hay = option.search || normalize(`${option.code} ${option.desc}`);
        if (!tokens.every((t) => hay.includes(t))) return;
        ranked.push({ option, index, rank: normalize(option.code).startsWith(tokens[0]) ? 0 : 1 });
    });
    return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((r) => r.option);
}

/** Napis kafelka `KOD<br>OPIS` (albo alias) → { code, desc }. */
export function parseTileLabel(html) {
    const parts = String(html ?? '').split(/<br\s*\/?>/i).map((p) => p
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .trim());
    return { code: parts[0] || '', desc: parts.slice(1).join(' ').trim() };
}

/* ======================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIALOG_LIST = '#dynamic-options-list';
const CAMERA = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
const STOCK = ['stock-safe', 'stock-low', 'stock-critical', 'stock-zero', 'stock-coupon'];

function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Silnik liczy — zatwierdzenie kafelka w tym czasie byłoby zignorowane (dialog-confirm wyłączony). */
function engineBusy() {
    const confirm = document.getElementById('dialog-confirm');
    return !!(window.isCalculating || (window.calculationQueue?.length ?? 0) > 0 || confirm?.disabled);
}
async function waitIdle(timeout = 30000) {
    const started = Date.now();
    while (engineBusy()) {
        if (Date.now() - started > timeout) throw new Error('busy');
        await sleep(100);
    }
}

/* ---------- Opcje ---------- */

function selectOptions(select) {
    return Array.from(select.options)
        .filter((o) => o.value !== '' && !o.disabled && !o.hidden && o.style.display !== 'none')
        .map((o) => {
            const text = o.text.replace(/\s+/g, ' ').trim();
            return { value: o.value, code: '', desc: text, search: normalize(text) };
        });
}

function tilesFor(name) {
    return Array.from(document.querySelectorAll(`${DIALOG_LIST} .image-box`)).filter((b) => b.dataset.paramName === name);
}

function tileValue(box) {
    return box.querySelector('.image-name')?.dataset.value ?? '';
}

function tileOptions(name) {
    return tilesFor(name).map((box) => {
        const nameEl = box.querySelector('.image-name');
        const { code, desc } = parseTileLabel(nameEl ? nameEl.innerHTML : '');
        const badge = box.querySelector('.stock-badge');
        const stock = badge ? STOCK.find((c) => badge.classList.contains(c)) || '' : '';
        const note = (box.querySelector('.delivery-info')?.textContent || '').replace(/\s+/g, ' ').trim();
        const value = tileValue(box);
        return {
            value,
            code,
            desc,
            // Alias klienta (paramdict-…-<kolekcja>) zamiast kodu HKL — biuro widzi oba.
            alt: value && value !== code && value !== '<NONE>' ? value : '',
            search: normalize(`${code} ${desc} ${tileValue(box)}`),
            image: box.querySelector('img.diag-image')?.getAttribute('src') || '',
            stock,
            note,
            unavailable: box.classList.contains('unavailable'),
            // Kafelek „wycofany” jest w oknie nieklikalny (dialog.css .obsolete) — tu też.
            disabled: box.classList.contains('obsolete'),
            favorite: box.classList.contains('favorite')
        };
    });
}

let renderChain = Promise.resolve();
/** Buduje kafelki pola bez otwierania okna i czeka na nie. Wywołania idą po kolei (jedna lista na stronie). */
function renderTiles(button, name) {
    const job = renderChain.then(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); window.rawDialogHeadless = false; reject(new Error('timeout')); }, 15000);
        const onDone = (e) => { if (e.detail?.param === name) { cleanup(); resolve(); } };
        function cleanup() { clearTimeout(timer); window.removeEventListener('raw-dialog-rendered', onDone); }
        window.addEventListener('raw-dialog-rendered', onDone);
        window.rawDialogHeadless = true;
        button.click();
    }));
    renderChain = job.catch(() => {});
    return job;
}

const tileCache = new WeakMap(); // przycisk (instancja) → opcje; klon przycisku = nowe opcje
async function loadTileOptions(button, name) {
    if (tileCache.has(button) && tilesFor(name).length) return tileCache.get(button);
    await renderTiles(button, name);
    const options = tileOptions(name);
    tileCache.set(button, options);
    return options;
}

/** Zatwierdza wartości tą samą drogą co kliknięcie kafelka w oknie. */
async function pickTiles(button, name, values, multi) {
    if (!tilesFor(name).length) await renderTiles(button, name);
    const tiles = tilesFor(name);
    const chosen = values.map((v) => tiles.find((t) => tileValue(t) === v)).filter(Boolean);
    if (!chosen.length) throw new Error('missing');
    await waitIdle();
    document.querySelectorAll(`${DIALOG_LIST} .image-box.active`).forEach((t) => t.classList.remove('active'));
    if (!multi) {
        chosen[0].click(); // handleOptionClick → handleConfirm → dialog-confirm → form.js
        return;
    }
    chosen.forEach((t) => t.classList.add('active'));
    document.getElementById('dialog-confirm')?.click();
}

/* ---------- Pole ---------- */

function paramFor(name) {
    return (window.params || []).find((p) => p.NAME === name) || null;
}

function isTileButton(button) {
    const p = paramFor(button.id);
    return !!(p && p.GRAPHICS == 'true' && p.SOURCE != p.NAME && p.TYPE != 'link');
}

function hideNative(control) {
    control.classList.add('raw-native');
    control.tabIndex = -1;
    control.setAttribute('aria-hidden', 'true');
    control.dataset.rawCombo = '1';
}

function labelText(control) {
    if (control.labels && control.labels[0]) return control.labels[0].textContent.trim();
    const area = control.parentElement;
    const label = area?.querySelector(':scope > .field-label-row label');
    return (label?.textContent || control.getAttribute('aria-label') || control.name || control.id || '').trim();
}

function nativeOf(wrap) {
    const el = wrap.previousElementSibling;
    return el && (el.tagName === 'SELECT' || el.tagName === 'BUTTON') ? el : null;
}

const EMPTY_LABELS = () => new Set(['', tr('form.check_word'), tr('form.check_option'), 'Wybierz', 'Sprawdź']);

function currentLabel(wrap, control) {
    if (control.tagName === 'SELECT') {
        const o = control.selectedIndex >= 0 ? control.options[control.selectedIndex] : null;
        return o && o.value !== '' ? o.text.replace(/\s+/g, ' ').trim() : '';
    }
    const text = control.textContent.replace(/\s+/g, ' ').trim();
    return EMPTY_LABELS().has(text) ? '' : text;
}

function currentValues(control) {
    const raw = control.tagName === 'SELECT' ? control.value : (control.value || '');
    return String(raw).split('|').filter(Boolean);
}

function enhance(control, kind) {
    if (control.nextElementSibling?.classList.contains('raw-combo')) { hideNative(control); return; }
    const name = control.tagName === 'BUTTON' ? control.id : (control.name || control.id);
    const multi = kind === 'tiles' && paramFor(name)?.MULTI == 'true';
    const wrap = document.createElement('div');
    wrap.className = 'raw-combo';
    wrap.dataset.kind = kind;
    wrap.dataset.name = name;
    if (multi) wrap.dataset.multi = '1';
    wrap.innerHTML = `
        <input type="text" class="raw-combo__input" role="combobox" aria-autocomplete="list" aria-expanded="false"
               aria-controls="raw-combo-list" autocomplete="off" spellcheck="false">
        <button type="button" class="raw-combo__photo" tabindex="-1" hidden>${CAMERA}</button>
        <span class="raw-combo__chevron" aria-hidden="true">▾</span>`;
    const input = wrap.querySelector('input');
    input.setAttribute('aria-label', labelText(control));
    input.placeholder = tr('staff.raw.combo_placeholder', 'Wpisz, aby wyszukać…');
    const photo = wrap.querySelector('.raw-combo__photo');
    photo.setAttribute('aria-label', tr('staff.raw.photo', 'Zdjęcie'));
    photo.title = tr('staff.raw.photo', 'Zdjęcie');
    hideNative(control);
    control.after(wrap);
    input.value = currentLabel(wrap, control);
    bindInput(wrap, input);
    photo.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const opt = (wrap._options || []).find((o) => currentValues(nativeOf(wrap) || control).includes(o.value) && o.image);
        if (opt) popup.togglePreview(opt.image, photo, opt.code || opt.desc);
    });
    wrap.querySelector('.raw-combo__chevron').addEventListener('mousedown', (e) => { e.preventDefault(); input.focus(); popup.open(wrap); });
}

function scan() {
    document.querySelectorAll('.asortment-inputs select, #dynamic-form select').forEach((sel) => {
        if (!sel.multiple && !sel.dataset.rawCombo) enhance(sel, 'select');
    });
    document.querySelectorAll('#dynamic-form button[id]').forEach((btn) => {
        if (btn.dataset.rawCombo) {
            // Klon przycisku (silnik) ma już atrybut — pilnujemy tylko, by był ukryty
            if (!btn.classList.contains('raw-native')) hideNative(btn);
            return;
        }
        if (isTileButton(btn)) enhance(btn, 'tiles');
    });
}

/** Etykiety, blokada i błędy przenoszone z natywnych pól (silnik zmienia je bez zdarzeń). */
function sync() {
    document.querySelectorAll('.raw-combo').forEach((wrap) => {
        const control = nativeOf(wrap);
        wrap.hidden = !control;
        if (!control) return;
        const input = wrap.querySelector('.raw-combo__input');
        input.disabled = !!control.disabled;
        wrap.classList.toggle('is-invalid', control.classList.contains('invalid-input'));
        if (document.activeElement !== input) {
            const label = currentLabel(wrap, control);
            if (input.value !== label) input.value = label;
        }
        const photo = wrap.querySelector('.raw-combo__photo');
        const values = currentValues(control);
        photo.hidden = !(wrap._options || []).some((o) => o.image && values.includes(o.value));
    });
}

/* ---------- Lista (jedna na stronę) ---------- */

const live = { el: null, say(text) { if (!this.el) return; this.el.textContent = ''; setTimeout(() => { this.el.textContent = text; }, 30); } };

const popup = {
    box: null, list: null, foot: null, preview: null,
    cur: null,

    build() {
        this.box = document.createElement('div');
        this.box.className = 'raw-combo-pop';
        this.box.hidden = true;
        this.box.innerHTML = `<ul id="raw-combo-list" role="listbox"></ul>
            <div class="raw-combo-pop__foot" hidden><span class="raw-combo-pop__count"></span>
            <button type="button" class="btn btn-primary btn-sm raw-combo-pop__apply"></button></div>`;
        this.list = this.box.querySelector('ul');
        this.foot = this.box.querySelector('.raw-combo-pop__foot');
        this.foot.querySelector('button').textContent = tr('staff.raw.multi_apply', 'Zastosuj');
        this.foot.addEventListener('mousedown', (e) => e.preventDefault());
        this.foot.querySelector('button').addEventListener('click', () => this.applyMulti());
        this.preview = document.createElement('div');
        this.preview.className = 'raw-combo-preview';
        this.preview.hidden = true;
        this.preview.innerHTML = '<img alt="">';
        live.el = document.createElement('div');
        live.el.className = 'raw-combo-live';
        live.el.setAttribute('aria-live', 'polite');
        document.body.append(this.box, this.preview, live.el);
    },

    isOpen() { return !!this.box && !this.box.hidden; },

    position() {
        const { wrap } = this.cur;
        const rect = wrap.getBoundingClientRect();
        const below = window.innerHeight - rect.bottom;
        const up = below < 220 && rect.top > below;
        this.box.style.left = `${rect.left + window.scrollX}px`;
        this.box.style.width = `${Math.max(rect.width, 340)}px`;
        this.box.style.maxHeight = `${Math.max(160, Math.min(340, (up ? rect.top : below) - 12))}px`;
        if (up) {
            this.box.style.top = '';
            this.box.style.bottom = `${document.documentElement.clientHeight - rect.top - window.scrollY + 2}px`;
        } else {
            this.box.style.bottom = '';
            this.box.style.top = `${rect.bottom + window.scrollY + 2}px`;
        }
    },

    async open(wrap) {
        const control = nativeOf(wrap);
        const input = wrap.querySelector('.raw-combo__input');
        if (!control || input.disabled) return;
        if (this.cur && this.cur.wrap !== wrap) this.close(false);
        const multi = wrap.dataset.multi === '1';
        this.cur = { wrap, input, options: [], matches: [], active: 0, typed: !!this.cur?.typed && this.cur.wrap === wrap, multi, selected: new Set(multi ? currentValues(control) : []), loading: true, error: false };
        const cur = this.cur;
        input.setAttribute('aria-expanded', 'true');
        this.box.hidden = false;
        this.list.setAttribute('aria-multiselectable', multi ? 'true' : 'false');
        this.foot.hidden = !multi;
        this.position();
        if (wrap.dataset.kind === 'select') {
            cur.options = selectOptions(control);
            cur.loading = false;
        } else {
            this.render();
            try {
                cur.options = await loadTileOptions(control, wrap.dataset.name);
                wrap._options = cur.options;
            } catch (err) {
                cur.error = true;
            }
            cur.loading = false;
            if (this.cur !== cur) return;
        }
        // Lista startuje na aktualnej wartości (bez filtrowania, dopóki użytkownik nie pisze).
        const values = currentValues(control);
        const at = cur.options.findIndex((o) => values.includes(o.value));
        cur.active = at >= 0 ? at : 0;
        this.render();
    },

    render() {
        const cur = this.cur;
        if (!cur) return;
        this.list.innerHTML = '';
        const msg = (key, fallback) => {
            const li = document.createElement('li');
            li.className = 'raw-combo-msg';
            li.setAttribute('aria-disabled', 'true');
            li.textContent = tr(key, fallback);
            this.list.append(li);
        };
        if (cur.loading) { msg('staff.raw.combo_loading', 'Wczytywanie…'); return; }
        if (cur.error) { msg('staff.raw.combo_error', 'Nie udało się wczytać listy. Spróbuj ponownie.'); return; }
        cur.matches = filterOptions(cur.options, cur.typed ? cur.input.value : '');
        cur.active = Math.min(cur.active, Math.max(cur.matches.length - 1, 0));
        if (!cur.matches.length) { msg('staff.raw.combo_empty', 'Brak pasujących wartości'); cur.input.removeAttribute('aria-activedescendant'); return; }
        const values = currentValues(nativeOf(cur.wrap) || document.createElement('select'));
        cur.matches.forEach((o, i) => {
            const li = document.createElement('li');
            li.id = `raw-combo-opt-${i}`;
            li.className = 'raw-combo-opt';
            li.dataset.value = o.value;
            li.setAttribute('role', 'option');
            const checked = cur.multi ? cur.selected.has(o.value) : values.includes(o.value);
            li.setAttribute('aria-selected', String(cur.multi ? checked : i === cur.active));
            if (i === cur.active) li.classList.add('is-active');
            if (checked) li.classList.add('is-current');
            if (o.disabled) { li.classList.add('is-disabled'); li.setAttribute('aria-disabled', 'true'); }
            if (o.unavailable) li.classList.add('is-unavailable');
            const notes = [];
            if (o.disabled) notes.push(tr('staff.raw.obsolete', 'wycofane'));
            else if (o.unavailable) notes.push(tr('staff.raw.unavailable', 'brak na stanie'));
            if (o.note) notes.push(o.note);
            li.innerHTML = `${cur.multi ? '<span class="raw-combo-opt__check" aria-hidden="true"></span>' : ''}`
                + `${o.stock ? `<span class="raw-combo-opt__dot raw-combo-opt__dot--${esc(o.stock)}" aria-hidden="true"></span>` : ''}`
                + `${o.favorite ? '<span class="raw-combo-opt__fav" aria-hidden="true">★</span>' : ''}`
                + `<span class="raw-combo-opt__text">${o.code ? `<strong>${esc(o.code)}</strong> ` : ''}<span>${esc(o.desc)}</span>${o.alt ? ` <span class="raw-combo-opt__alt" title="${esc(tr('staff.raw.hkl_code', 'Kod HKL'))}">${esc(o.alt)}</span>` : ''}</span>`
                + `${notes.length ? `<span class="raw-combo-opt__note">${esc(notes.join(' · '))}</span>` : ''}`
                + `${o.image ? `<button type="button" class="raw-combo-opt__photo" tabindex="-1" title="${esc(tr('staff.raw.photo', 'Zdjęcie'))}" aria-label="${esc(tr('staff.raw.photo', 'Zdjęcie'))}">${CAMERA}</button>` : ''}`;
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const photo = e.target.closest('.raw-combo-opt__photo');
                if (photo) { this.togglePreview(o.image, photo, o.code || o.desc); return; }
                cur.active = i;
                this.choose(i);
            });
            const photo = li.querySelector('.raw-combo-opt__photo');
            if (photo) {
                photo.addEventListener('mouseenter', () => this.showPreview(o.image, photo, o.code || o.desc));
                photo.addEventListener('mouseleave', () => { if (!this.preview.dataset.pinned) this.hidePreview(); });
            }
            this.list.append(li);
        });
        cur.input.setAttribute('aria-activedescendant', `raw-combo-opt-${cur.active}`);
        this.list.children[cur.active]?.scrollIntoView({ block: 'nearest' });
        if (cur.multi) this.foot.querySelector('.raw-combo-pop__count').textContent = `${tr('staff.raw.multi_selected', 'Zaznaczone')}: ${cur.selected.size}`;
    },

    move(delta) {
        const cur = this.cur;
        if (!cur || !cur.matches.length) return;
        cur.active = (cur.active + delta + cur.matches.length) % cur.matches.length;
        this.render();
    },

    async choose(i) {
        const cur = this.cur;
        const option = cur?.matches[i];
        if (!option || option.disabled) return;
        if (cur.multi && option.value !== '<NONE>') {
            if (cur.selected.has(option.value)) cur.selected.delete(option.value); else cur.selected.add(option.value);
            cur.selected.delete('<NONE>');
            this.render();
            return;
        }
        const { wrap, input } = cur;
        const control = nativeOf(wrap);
        this.close(false);
        input.value = [option.code, option.desc].filter(Boolean).join(' - ');
        input.select();
        if (!control) return;
        if (control.tagName === 'SELECT') {
            control.value = option.value;
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        try {
            await pickTiles(control, wrap.dataset.name, [option.value], cur.multi);
        } catch (err) {
            live.say(tr('staff.raw.combo_error', 'Nie udało się wczytać listy. Spróbuj ponownie.'));
        }
    },

    async applyMulti() {
        const cur = this.cur;
        if (!cur || !cur.multi) return;
        const values = Array.from(cur.selected);
        const { wrap } = cur;
        const control = nativeOf(wrap);
        this.close(false);
        if (!control || !values.length) return;
        const before = currentValues(control).slice().sort().join('|');
        if (before === values.slice().sort().join('|')) return;
        try {
            await pickTiles(control, wrap.dataset.name, values, true);
        } catch (err) {
            live.say(tr('staff.raw.combo_error', 'Nie udało się wczytać listy. Spróbuj ponownie.'));
        }
    },

    close(refocus = true) {
        if (!this.cur) return;
        const { input } = this.cur;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        this.box.hidden = true;
        this.hidePreview();
        this.cur = null;
        if (refocus) input.focus();
    },

    showPreview(src, anchor, alt) {
        const img = this.preview.querySelector('img');
        if (img.getAttribute('src') !== src) img.src = src;
        img.alt = alt || '';
        const r = anchor.getBoundingClientRect();
        const width = 260;
        const left = r.right + 8 + width > window.innerWidth ? r.left - width - 8 : r.right + 8;
        this.preview.style.left = `${Math.max(4, left) + window.scrollX}px`;
        this.preview.style.top = `${Math.max(4, Math.min(r.top, window.innerHeight - width - 8)) + window.scrollY}px`;
        this.preview.hidden = false;
    },
    hidePreview() { if (this.preview) { this.preview.hidden = true; delete this.preview.dataset.pinned; } },
    togglePreview(src, anchor, alt) {
        if (!this.preview.hidden && this.preview.dataset.pinned && this.preview.querySelector('img').getAttribute('src') === src) { this.hidePreview(); return; }
        this.showPreview(src, anchor, alt);
        this.preview.dataset.pinned = '1';
    }
};

function bindInput(wrap, input) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('mousedown', () => { if (!(popup.isOpen() && popup.cur?.wrap === wrap)) setTimeout(() => popup.open(wrap), 0); });
    input.addEventListener('input', async () => {
        if (!(popup.isOpen() && popup.cur?.wrap === wrap)) await popup.open(wrap);
        if (!popup.cur) return;
        popup.cur.typed = true;
        popup.cur.active = 0;
        popup.render();
    });
    input.addEventListener('keydown', (e) => {
        const open = popup.isOpen() && popup.cur?.wrap === wrap;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) popup.open(wrap);
            else popup.move(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            e.stopPropagation();
            if (popup.cur.multi && e.ctrlKey) popup.applyMulti();
            else popup.choose(popup.cur.active);
        } else if (e.key === 'Tab' && open) {
            // Wpisany tekst + Tab = wybór podświetlonej (jak autouzupełnianie); wielokrotny — zastosuj.
            if (popup.cur.multi) popup.applyMulti();
            else if (popup.cur.typed && popup.cur.matches[popup.cur.active]) popup.choose(popup.cur.active);
            else popup.close(false);
        }
    });
    input.addEventListener('blur', () => setTimeout(() => {
        if (popup.cur?.wrap !== wrap || document.activeElement === input) return;
        if (popup.cur.multi) popup.applyMulti(); else popup.close(false);
    }, 120));
}

let started = false;
/** Start (raz na stronę): pola już istniejące + każde, które silnik dobuduje później. */
export function initRawCombos() {
    if (started) return api;
    started = true;
    popup.build();
    scan();
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; scan(); });
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(sync, 250);
    window.addEventListener('resize', () => { if (popup.isOpen()) popup.position(); });
    return api;
}

const api = {
    isOpen: () => popup.isOpen(),
    close: (refocus) => popup.close(refocus),
    /** Pole „wpisz i wybierz” dla natywnego elementu (do fokusu) albo null. */
    inputFor(control) {
        const wrap = control?.nextElementSibling;
        return wrap?.classList.contains('raw-combo') ? wrap.querySelector('.raw-combo__input') : null;
    }
};
