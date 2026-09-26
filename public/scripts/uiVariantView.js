/* =============================================================================
   WIDOKI WARIANTU B („Efor 2.0") — warstwa prezentacji dokładana przez JS
   =============================================================================
   Tam, gdzie makieta wymaga INNEGO układu niż obecny markup, a sam CSS nie
   wystarcza (karty wyboru produktu, panel ceny obok formularza, podsumowanie
   oferty), ten plik dokłada widok nad ISTNIEJĄCYM DOM-em:

     • nic tu nie liczy cen, nie woła API i nie zmienia stanu formularza —
       karty wyboru ustawiają wartość w istniejącym <select> i wysyłają
       `change` (resztę robi dotychczasowy kod), panel ceny tylko CZYTA pola
       cenowe, przycisk „Zapisz” w panelu klika oryginalny przycisk,
     • wszystko działa wyłącznie w wariancie B — przy przełączeniu na A każdy
       adapter sprząta po sobie (unmount) albo jest chowany przez CSS
       (`.efor-v2-only`), a przeniesione węzły wracają na swoje miejsce.

   Adapter = { name, pages[], mount(), unmount?() }. `pages` to klucze z
   `data-efor-page` (public/scripts/uiVariant.js → pageKey()). Błąd jednego
   adaptera nie może zepsuć strony — każdy mount/unmount jest w try/catch.
   ============================================================================= */

const store = window.eformUiVariant;
const T = window.eforV2I18n || {};
const root = document.documentElement;
const page = root.getAttribute('data-efor-page') || 'other';

const adapters = [];

function register(adapter) {
    adapters.push(Object.assign({ pages: ['*'], mounted: false }, adapter));
}

function applies(adapter) {
    return adapter.pages.includes('*') || adapter.pages.includes(page);
}

function activate() {
    for (const adapter of adapters) {
        if (!applies(adapter) || adapter.mounted) continue;
        try {
            adapter.mount();
            adapter.mounted = true;
        } catch (err) {
            console.error(`[efor-v2] ${adapter.name}: mount`, err);
        }
    }
}

function deactivate() {
    for (const adapter of adapters) {
        // Adapter bez `unmount` zostawia tylko elementy `.efor-v2-only`, które
        // w wariancie A chowa CSS — zostaje zamontowany, żeby powrót do B nie
        // dublował nasłuchów.
        if (!adapter.mounted || typeof adapter.unmount !== 'function') continue;
        try {
            adapter.unmount();
        } catch (err) {
            console.error(`[efor-v2] ${adapter.name}: unmount`, err);
        }
        adapter.mounted = false;
    }
}

// ── narzędzia ──────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

/** `<svg><use href="#id"/></svg>` z symbolu w partials/efor-v2-icons.njk. */
function icon(id, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.appendChild(use);
    return svg;
}

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
}

const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** Tekst węzła BEZ treści wskazanych dzieci (np. tytuł oferty bez nazwy). */
function ownText(node, skipSelector) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    if (skipSelector) clone.querySelectorAll(skipSelector).forEach((n) => n.remove());
    return squash(clone.textContent);
}

/**
 * Placeholder w miejscu przenoszonego węzła — `restore()` odkłada węzeł
 * dokładnie tam, skąd go wzięliśmy (wariant A ma mieć identyczny DOM).
 */
function moveInto(node, target) {
    const marker = document.createComment(`efor-v2: ${node.id || node.className || node.nodeName}`);
    node.parentNode.insertBefore(marker, node);
    target.appendChild(node);
    return function restore() {
        if (marker.parentNode) {
            marker.parentNode.insertBefore(node, marker);
            marker.remove();
        }
    };
}

/**
 * `apply()` tylko na desktopie (≥ 768 px), `revert()` po zejściu poniżej —
 * także przy zmianie szerokości okna bez przeładowania. Na telefonie widoki
 * B, do których przenosimy węzły (panel podsumowania, kafelki wyboru), są
 * ukryte, więc przeniesione tam sumy czy przyciski zniknęłyby z ekranu.
 * Zwraca funkcję sprzątającą (odpina nasłuch i cofa zmiany).
 */
const desktopMQ = window.matchMedia('(min-width: 768px)');

function whenDesktop(apply, revert) {
    let applied = false;
    const sync = () => {
        if (desktopMQ.matches && !applied) {
            apply();
            applied = true;
        } else if (!desktopMQ.matches && applied) {
            revert();
            applied = false;
        }
    };
    sync();
    desktopMQ.addEventListener('change', sync);
    return () => {
        desktopMQ.removeEventListener('change', sync);
        if (applied) revert();
        applied = false;
    };
}

// ── adapter: powłoka (okruszki, awatar, karta konta) ───────────────────────

const LEGAL_FORMS = new Set(['sp', 'z', 'o', 'oo', 'sa', 'sk', 'spk', 'gmbh', 'ag', 'kg', 'ug', 'ohg', 'bv', 'nv', 'vof', 'sarl', 'sas', 'eurl', 'ltd', 'llc', 'inc', 'co', 'srl', 'spa', 'e', 'k']);

/** Inicjały do awatara: „Paweł Woroniecki” → PW, „Testowy sp. z o.o.” → TE. */
export function initialsOf(name) {
    const words = String(name || '')
        .split(/[\s.,&/()+-]+/)
        .map((w) => w.trim())
        .filter((w) => /\p{L}/u.test(w) && !LEGAL_FORMS.has(w.toLowerCase()));
    if (!words.length) return '';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

function pageTitle() {
    switch (page) {
        case 'order':
        case 'order-sent':
            return ownText(document.getElementById('order-title'), 'p');
        case 'new-position':
            return T.eyebrowNewPos;
        case 'edit-position':
            return T.eyebrowEditPos;
        case 'position':
            return ownText(document.querySelector('.order-header'), '.text-muted') || T.eyebrowPosition;
        case 'home':
            return '';
        default: {
            const heading = document.querySelector('main .content h1, main .content h2, main h1, main h2');
            return heading ? ownText(heading, 'p, small, .badge') : '';
        }
    }
}

function buildBreadcrumb() {
    const trail = document.querySelector('[data-efor-breadcrumb]');
    if (!trail || trail.childElementCount) return;

    const crumbs = [];
    // navActiveState.js podświetla przy edycji danych oferty „Utwórz nową
    // ofertę” — w okruszkach ta strona należy jednak do „Twoich ofert”.
    const active = page === 'edit-order'
        ? document.getElementById('orders-nav-btn')
        : document.querySelector('.desktop-nav .custom-nav-link.active[href]');
    if (active && page !== 'home') {
        crumbs.push({ href: active.getAttribute('href'), label: squash(active.textContent) });
    } else if (['order', 'order-sent', 'new-position', 'edit-position', 'position'].includes(page)) {
        const offers = document.getElementById(page === 'order-sent' ? 'orders-history-nav-btn' : 'orders-nav-btn');
        if (offers) crumbs.push({ href: offers.getAttribute('href'), label: squash(offers.textContent) });
    }

    // Konfigurator / edycja pozycji: ogniwo „Oferta” prowadzi z powrotem do oferty
    const orderId = squash(document.getElementById('orderId')?.textContent);
    if ((page === 'new-position' || page === 'edit-position') && /^\d+$/.test(orderId)) {
        crumbs.push({ href: `/orders/order/${orderId}`, label: T.offer });
    }

    // Listy (oferty, zamówienia): sekcja z menu i nagłówek to ta sama strona,
    // tylko inaczej nazwana („Wysłane zlecenia” / „Wysłane zamówienia”).
    const title = ['orders', 'history', 'panel'].includes(page) && crumbs.length ? '' : pageTitle();
    if (title && !crumbs.some((c) => c.label === title)) crumbs.push({ label: title });
    if (!crumbs.length) return;

    crumbs.forEach((crumb, index) => {
        const last = index === crumbs.length - 1;
        const li = el('li');
        if (last || !crumb.href) {
            li.appendChild(el('span', { 'aria-current': last ? 'page' : null, text: crumb.label, title: crumb.label }));
        } else {
            li.appendChild(el('a', { href: crumb.href, text: crumb.label }));
        }
        trail.appendChild(li);
    });
}

function fillAccount(data) {
    if (!data) return;
    const initials = initialsOf(window.hideParentUserInfo ? (data.shopName || data.name) : data.name);
    document.querySelectorAll('.efor-avatar[data-efor-initials]').forEach((node) => {
        if (!initials) return;
        node.textContent = initials;
        node.classList.add('has-initials');
    });

    const card = document.querySelector('[data-efor-user-card]');
    if (!card) return;
    const nameEl = card.querySelector('[data-efor-user-name]');
    const mailEl = card.querySelector('[data-efor-user-mail]');
    // Konto podrzędne grupy typu `client` widzi WYŁĄCZNIE swoją filię — nazwa
    // i mail grupy-matki są dla niego mylące (ta sama reguła co base.js).
    if (window.hideParentUserInfo) {
        nameEl.textContent = squash(data.shopName || data.name);
        mailEl.textContent = '';
    } else {
        nameEl.textContent = squash(data.name);
        mailEl.textContent = squash(data.email);
        card.dataset.shop = squash(data.shopName);
    }
    refreshAccountExtra();
}

/**
 * Trzecia linia karty: kontekst ownera/admina („ID: … (nazwa)”), panel
 * pracownika albo konto podrzędne grupy. Czytane z `#user-info`, które
 * base.js wypełnia z opóźnieniem — stąd obserwator.
 */
function refreshAccountExtra() {
    const card = document.querySelector('[data-efor-user-card]');
    const extraEl = card?.querySelector('[data-efor-user-extra]');
    if (!extraEl) return;
    const info = document.getElementById('user-info');
    let extra = '';
    const ident = info?.querySelector('#ident');
    if (ident) {
        const after = ident.nextSibling && ident.nextSibling.nodeType === Node.TEXT_NODE ? ident.nextSibling.textContent : '';
        extra = squash(`${ident.textContent} ${after}`);
    }
    const employee = info?.querySelector('#employee-info');
    if (!extra && employee) {
        extra = squash(`${employee.textContent} ${employee.nextElementSibling?.textContent || ''}`);
    }
    if (!extra && card.dataset.shop) extra = card.dataset.shop;
    extraEl.textContent = extra;
    extraEl.title = extra;
}

let accountObserver = null;

register({
    name: 'shell',
    mount() {
        buildBreadcrumb();
        fillAccount(window.eformUser);
        window.addEventListener('eform:user-loaded', (event) => fillAccount(event.detail));
        const info = document.getElementById('user-info');
        if (info && !accountObserver) {
            accountObserver = new MutationObserver(refreshAccountExtra);
            accountObserver.observe(info, { childList: true, subtree: true, characterData: true });
        }
    }
});

// ── adapter: oferta (karty pozycji, podsumowanie, status) ──────────────────
//
// Makieta pokazuje pozycje jako karty z turkusowym nagłówkiem i panel
// „Podsumowanie” z prawej. Karty to istniejąca lista `.mobile-items-list`
// (order.njk renderuje ją dla każdej tabeli z tymi samymi warunkami ról co
// tabelę), więc tu nie powstaje żaden drugi widok danych — CSS pokazuje ją na
// desktopie. Tabela zostaje dostępna przełącznikiem „Karty / Tabela”.
// Panel podsumowania dostaje ORYGINALNE węzły `#total-container` i
// `.send-order-actions` (przeniesione, nie skopiowane — przyciski wysyłki
// działają dalej na swoich nasłuchach), a przy powrocie do wariantu A wracają
// dokładnie na swoje miejsce.

const orderView = {
    restore: [],
    created: [],
    onCardClick: null
};

/** „HKL Razem: 103.93€” → etykieta + kwota w osobnych spanach (do układu panelu). */
function splitTotals(container) {
    const undo = [];
    container.querySelectorAll('.total-price .total').forEach((node) => {
        if (node.querySelector('.efor-total__value')) return;
        const original = node.innerHTML;
        const text = squash(node.textContent);
        const cut = text.lastIndexOf(':');
        if (cut === -1) return;
        node.textContent = '';
        node.appendChild(el('span', { class: 'efor-total__label', text: text.slice(0, cut).trim() }));
        node.appendChild(el('span', { class: 'efor-total__value', text: text.slice(cut + 1).trim() }));
        undo.push(() => { node.innerHTML = original; });
    });
    return undo;
}

function positionsCount() {
    const cards = document.querySelectorAll('.mobile-items-list .mobile-item-card');
    return cards.length || document.querySelectorAll('.order-table th.order-idx').length;
}

function setPositionsView(value) {
    store.setPref('positions', value);
    document.querySelectorAll('.efor-view-switch [data-view]').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.view === value ? 'true' : 'false');
    });
    // stickyColumns.js liczy przesunięcia przypiętych kolumn przy `resize` —
    // ukryta tabela miała szerokości 0, po pokazaniu trzeba je przeliczyć.
    window.dispatchEvent(new Event('resize'));
}

function buildPositionsBar(count) {
    const current = store.getPref('positions');
    const bar = el('div', { class: 'efor-positions-bar efor-v2-only' }, [
        el('h2', { class: 'efor-positions-bar__title' }, [
            T.cardPositions,
            el('span', { class: 'efor-count', text: String(count) })
        ]),
        el('div', { class: 'efor-view-switch', role: 'group', 'aria-label': T.viewLabel }, [
            el('button', { type: 'button', 'data-view': 'cards', 'aria-pressed': current === 'cards' ? 'true' : 'false' }, [icon('efor-i-grid'), T.viewCards]),
            el('button', { type: 'button', 'data-view': 'table', 'aria-pressed': current === 'table' ? 'true' : 'false' }, [icon('efor-i-rows'), T.viewTable])
        ])
    ]);
    bar.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-view]');
        if (btn) setPositionsView(btn.dataset.view);
    });
    return bar;
}

register({
    name: 'order',
    pages: ['order', 'order-sent'],
    mount() {
        const wrapper = document.querySelector('main .content > .container');
        const tableContainer = document.querySelector('.order-table-container');

        // Status oferty w nagłówku (makieta: „● Entwurf”)
        const navMain = document.querySelector('#order-nav .order-nav-main');
        if (navMain) {
            const sent = page === 'order-sent';
            const pill = el('span', { class: `efor-pill efor-order-status efor-v2-only${sent ? ' efor-pill--sent' : ''}` }, [
                el('span', { class: 'efor-pill__dot', 'aria-hidden': 'true' }),
                sent ? T.statusSent : T.statusDraft
            ]);
            navMain.appendChild(pill);
            orderView.created.push(pill);
        }

        if (!wrapper || !tableContainer) return;
        const count = positionsCount();

        const bar = buildPositionsBar(count);
        tableContainer.insertBefore(bar, tableContainer.firstChild);
        orderView.created.push(bar);

        // „Dodaj kolejną pozycję” pod kartami — ten sam adres i napis, co
        // przycisk w nagłówku (brak przycisku = oferta tylko do wglądu).
        // ⚠️ order.njk ma DWA `#order-buttons`/`#new-order-button` (mobilny
        // z samą ikoną i desktopowy z napisem) — bierzemy ten z napisem.
        const addBtn = document.querySelector('#order-buttons.d-md-flex #new-order-button[href]')
            || document.querySelector('#new-order-button.custom-order-btn[href]');
        if (addBtn) {
            const more = el('a', { class: 'efor-add-position efor-v2-only', href: addBtn.getAttribute('href') }, [
                el('span', { class: 'efor-add-position__plus', 'aria-hidden': 'true', text: '+' }),
                squash(addBtn.textContent)
            ]);
            const totals = tableContainer.querySelector('#total-container');
            tableContainer.insertBefore(more, totals || null);
            orderView.created.push(more);
        }

        // Panel „Podsumowanie” — tylko desktop (patrz whenDesktop)
        const totals = document.getElementById('total-container');
        const send = wrapper.querySelector('.send-order-actions');
        if (totals || send) {
            const undo = [];
            const buildSummary = () => {
                const body = el('div', { class: 'efor-summary__body' }, [
                    el('div', { class: 'efor-summary__row' }, [
                        el('span', { text: T.positionsCount }),
                        el('strong', { text: String(count) })
                    ])
                ]);
                const aside = el('aside', { class: 'efor-summary efor-card efor-v2-only', 'aria-label': T.cardSummary }, [
                    el('h2', { class: 'efor-card__head', text: T.cardSummary }),
                    body
                ]);
                wrapper.appendChild(aside);
                undo.push(() => aside.remove());
                if (totals) {
                    undo.push(...splitTotals(totals));
                    undo.push(moveInto(totals, body));
                }
                if (send) undo.push(moveInto(send, body));
            };
            const removeSummary = () => {
                while (undo.length) undo.pop()();
            };
            orderView.restore.push(whenDesktop(buildSummary, removeSummary));
        }

        // Karta pozycji otwiera szczegóły jednym kliknięciem, jak wiersz tabeli
        // (mobileCards.js na telefonie rozwija kartę — tam zostawiamy po staremu).
        orderView.onCardClick = (event) => {
            if (window.innerWidth < 768) return;
            const card = event.target.closest('.mobile-item-card');
            if (!card || event.target.closest('a, button, input, select, textarea, label, .mobile-item-actions')) return;
            const url = card.getAttribute('data-position-url');
            if (url) window.location.href = url;
        };
        tableContainer.addEventListener('click', orderView.onCardClick);
        orderView.restore.push(() => tableContainer.removeEventListener('click', orderView.onCardClick));
    },
    unmount() {
        // Najpierw przywracamy teksty/węzły (odwrotna kolejność), potem
        // usuwamy własne elementy — `moveInto` odkłada węzły przed znacznik.
        while (orderView.restore.length) {
            const undo = orderView.restore.pop();
            try { undo(); } catch (err) { console.error('[efor-v2] order: restore', err); }
        }
        orderView.created.forEach((node) => node.remove());
        orderView.created = [];
    }
});

// ── adapter: konfigurator — karty wyboru produktu i systemu ────────────────
//
// Makiety 4–7: produkt (dział) i system (grupa) wybiera się kafelkami, nie
// listą. Kafelki to WIDOK nad istniejącymi `#department-select` /
// `#asortment-group-select`: klik ustawia wartość selecta i wysyła `change`,
// więc cały dotychczasowy przepływ (main.js: buildGroupSelect → prepareForm)
// działa bez zmian. Wartości ustawiane programowo (np. „Ostatni wybór” —
// main.js resumeForm pisze do `select.value` bez zdarzenia) łapie obserwator
// i krótki odczyt co 500 ms. Selecty chowa CSS dopiero, gdy kafelki powstały
// (`.efor-chooser-ready`) — jeśli ten kod się wyłoży, zostaje zwykła lista.

const ILLUSTRATIONS = [
    { id: 'efor-p-pleated', re: /plis|pliss|pleat/iu, num: '1' },
    { id: 'efor-p-venetian', re: /żaluz|zaluz|jalou|venetian|jaloez/iu, num: '2' },
    { id: 'efor-p-roller', re: /rolet|rollo|roller|rolgordijn|store/iu, num: '3' },
    { id: 'efor-p-vertical', re: /vertik|vertic|lamellen/iu, num: '4' },
    { id: 'efor-p-components', re: /kompon|compon/iu, num: '5' },
    { id: 'efor-p-magnetic', re: /magnet/iu, num: '6' },
    { id: 'efor-p-roman', re: /rzyms|raff|roman|bateau|vouw/iu, num: '7' },
    { id: 'efor-p-curtains', re: /zasł|zaslon|vorh|curtain|rideau|gordijn/iu, num: '8' },
    { id: 'efor-p-insect', re: /moskit|insekt|insect|mousti|horren/iu, num: '9' }
];

/** Ilustracja działu: najpierw po nazwie (niezależne od numeracji w bazie), potem po numerze. */
function illustrationFor(value, label) {
    const byName = ILLUSTRATIONS.find((item) => item.re.test(label || ''));
    if (byName) return byName.id;
    const byNum = ILLUSTRATIONS.find((item) => item.num === String(value));
    return byNum ? byNum.id : 'efor-p-window';
}

function readOptions(select) {
    if (!select) return [];
    return [...select.options]
        .filter((o) => o.value !== '' && !o.disabled)
        .map((o) => ({ value: o.value, label: squash(o.textContent) }));
}

function selectedLabel(select) {
    const opt = select && select.value !== '' ? select.options[select.selectedIndex] : null;
    return opt ? squash(opt.textContent) : '';
}

const chooser = {
    root: null,
    card: null,
    dept: null,
    group: null,
    expanded: null,
    keys: {},
    observer: null,
    timer: null,
    restore: []
};

function skeletonCards(count, cls) {
    return Array.from({ length: count }, () => el('span', { class: `efor-choice efor-choice--skeleton ${cls}`, 'aria-hidden': 'true' }, [
        el('span', { class: 'efor-skeleton efor-choice__media' }),
        el('span', { class: 'efor-skeleton efor-choice__line' })
    ]));
}

function renderProducts(grid) {
    const opts = readOptions(chooser.dept);
    const key = JSON.stringify(opts) + chooser.dept.value;
    if (chooser.keys.products === key) return;
    chooser.keys.products = key;
    grid.textContent = '';
    if (!opts.length) {
        grid.append(...skeletonCards(6, 'efor-choice--product'));
        return;
    }
    for (const o of opts) {
        const on = chooser.dept.value === o.value;
        grid.appendChild(el('button', {
            type: 'button',
            class: `efor-choice efor-choice--product${on ? ' is-selected' : ''}`,
            'aria-pressed': on ? 'true' : 'false',
            'data-kind': 'product',
            'data-value': o.value
        }, [
            el('span', { class: 'efor-choice__media', 'aria-hidden': 'true' }, [icon(illustrationFor(o.value, o.label), 'efor-choice__illu')]),
            el('span', { class: 'efor-choice__name', text: o.label }),
            el('span', { class: 'efor-choice__go', 'aria-hidden': 'true' }, [icon('efor-i-arrow-right')])
        ]));
    }
}

function renderSystems(grid) {
    const opts = readOptions(chooser.group);
    const illu = illustrationFor(chooser.dept.value, selectedLabel(chooser.dept));
    const key = JSON.stringify(opts) + chooser.group.value + illu;
    if (chooser.keys.systems === key) return;
    chooser.keys.systems = key;
    grid.textContent = '';
    if (!opts.length) {
        grid.append(...skeletonCards(3, 'efor-choice--system'));
        return;
    }
    for (const o of opts) {
        const on = chooser.group.value === o.value;
        grid.appendChild(el('button', {
            type: 'button',
            class: `efor-choice efor-choice--system${on ? ' is-selected' : ''}`,
            'aria-pressed': on ? 'true' : 'false',
            'data-kind': 'system',
            'data-value': o.value
        }, [
            el('span', { class: 'efor-choice__media', 'aria-hidden': 'true' }, [icon(illu, 'efor-choice__illu')]),
            el('span', { class: 'efor-choice__name', text: o.label }),
            el('span', { class: 'efor-choice__pick' }, [
                el('span', { class: 'efor-choice__radio', 'aria-hidden': 'true' }, [icon('efor-i-check')]),
                el('span', { text: on ? T.selected : T.select })
            ])
        ]));
    }
}

function summaryItem(kind, label, value, illu) {
    return el('div', { class: 'efor-sum-item' }, [
        illu ? el('span', { class: 'efor-sum-item__media', 'aria-hidden': 'true' }, [icon(illu)]) : null,
        el('span', { class: 'efor-sum-item__text' }, [
            el('span', { class: 'efor-sum-item__label', text: label }),
            el('strong', { class: 'efor-sum-item__value', text: value || '—' })
        ]),
        el('button', { type: 'button', class: 'efor-sum-item__edit', 'data-edit': kind, title: `${T.change}: ${label}` }, [
            icon('efor-i-pencil'),
            el('span', { class: 'efor-sr-only', text: `${T.change}: ${label}` })
        ])
    ]);
}

function renderChooser() {
    if (!chooser.root) return;
    const hasDept = chooser.dept.value !== '';
    const hasGroup = chooser.group.value !== '' && readOptions(chooser.group).some((o) => o.value === chooser.group.value);
    let mode = !hasDept ? 'product' : (!hasGroup ? 'system' : 'done');
    if (chooser.expanded === 'product' || (chooser.expanded === 'system' && hasDept)) mode = chooser.expanded;
    chooser.root.dataset.mode = mode;

    const productStep = chooser.root.querySelector('[data-step="product"]');
    const systemStep = chooser.root.querySelector('[data-step="system"]');
    const summary = chooser.root.querySelector('.efor-chooser__summary');
    productStep.hidden = mode !== 'product';
    systemStep.hidden = mode !== 'system';
    summary.hidden = mode === 'product';

    if (mode === 'product') renderProducts(productStep.querySelector('.efor-choice-grid'));
    if (mode === 'system') renderSystems(systemStep.querySelector('.efor-choice-grid'));

    const sumKey = [mode, chooser.dept.value, selectedLabel(chooser.dept), chooser.group.value, selectedLabel(chooser.group)].join('|');
    if (chooser.keys.summary !== sumKey) {
        chooser.keys.summary = sumKey;
        summary.textContent = '';
        const deptLabel = selectedLabel(chooser.dept);
        summary.appendChild(summaryItem('product', T.product, deptLabel, illustrationFor(chooser.dept.value, deptLabel)));
        if (mode === 'done') summary.appendChild(summaryItem('system', T.system, selectedLabel(chooser.group)));
    }
}

function pickOption(select, value) {
    chooser.expanded = null;
    if (select.value === value) {
        renderChooser();
        return;
    }
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    renderChooser();
}

register({
    name: 'chooser',
    pages: ['new-position'],
    mount() {
        const card = document.querySelector('.asortment-container');
        const dept = document.getElementById('department-select');
        const group = document.getElementById('asortment-group-select');
        if (!card || !dept || !group) return;
        Object.assign(chooser, { card, dept, group, expanded: null, keys: {} });

        const step = (name, title) => el('section', { class: 'efor-chooser__step', 'data-step': name }, [
            el('h3', { class: 'efor-chooser__title', text: title }),
            el('div', { class: `efor-choice-grid efor-choice-grid--${name}` })
        ]);
        chooser.root = el('div', { class: 'efor-chooser efor-v2-only' }, [
            el('div', { class: 'efor-chooser__summary', hidden: true }),
            step('product', T.chooseProduct),
            step('system', T.chooseSystem)
        ]);
        const inputs = card.querySelector('.asortment-inputs');
        card.insertBefore(chooser.root, inputs ? inputs.nextSibling : null);
        card.classList.add('efor-chooser-ready');

        // „Wczytaj ostatnią konfigurację” — z pływającego okna do karty wyboru
        // (tylko desktop: na telefonie kafelków nie ma, okno zostaje po staremu)
        const lastConfig = document.getElementById('last-config-info');
        if (lastConfig) {
            let putBack = null;
            chooser.restore.push(whenDesktop(
                () => { putBack = moveInto(lastConfig, chooser.root); },
                () => { if (putBack) putBack(); putBack = null; }
            ));
        }

        chooser.root.addEventListener('click', (event) => {
            const choice = event.target.closest('button.efor-choice');
            if (choice) {
                pickOption(choice.dataset.kind === 'product' ? chooser.dept : chooser.group, choice.dataset.value);
                return;
            }
            const edit = event.target.closest('[data-edit]');
            if (edit) {
                chooser.expanded = edit.dataset.edit;
                renderChooser();
                chooser.root.querySelector(`[data-step="${edit.dataset.edit}"] button.efor-choice`)?.focus();
            }
        });

        const onChange = () => { chooser.expanded = null; renderChooser(); };
        dept.addEventListener('change', onChange);
        group.addEventListener('change', onChange);
        chooser.observer = new MutationObserver(renderChooser);
        chooser.observer.observe(dept, { childList: true, subtree: true });
        chooser.observer.observe(group, { childList: true, subtree: true });
        chooser.timer = window.setInterval(renderChooser, 500);
        chooser.restore.push(() => {
            dept.removeEventListener('change', onChange);
            group.removeEventListener('change', onChange);
        });
        renderChooser();
    },
    unmount() {
        chooser.observer?.disconnect();
        window.clearInterval(chooser.timer);
        while (chooser.restore.length) chooser.restore.pop()();
        chooser.card?.classList.remove('efor-chooser-ready');
        chooser.root?.remove();
        chooser.root = null;
    }
});

// ── adapter: konfigurator — panel „Podsumowanie ceny” ──────────────────────
//
// Makiety 8–9: ceny w osobnym panelu obok parametrów. Pola cenowe są
// wyliczane i wypełniane przez silnik (pricesCalculator.js) i szukane po `id`
// w całym dokumencie, więc NIE przenosimy ich — panel jest lustrem tylko do
// odczytu: co 400 ms (i przy każdej mutacji formularza) czyta etykiety
// i wartości widocznych pól cenowych. Oryginalne wiersze cen chowa CSS (tylko
// te bez ręcznego nadpisania i tylko na szerokim ekranie), przycisk „Zapisz”
// w panelu klika oryginalny `#show-button`.

const CUSTOM_PRICE_FIELDS = ['VAT', 'WARTOSC_VAT', 'WARTOSC_BRUTTO', 'RABAT_KLIENTA', 'WARTOSC_PO_RABACIE'];
const AREA_SUFFIX = '-select-area';

function areaName(area) {
    const cls = [...area.classList].find((c) => c.endsWith(AREA_SUFFIX));
    return cls ? cls.slice(0, -AREA_SUFFIX.length) : '';
}

function paramDef(name) {
    return Array.isArray(window.params) ? window.params.find((p) => p && p.NAME === name) : null;
}

/** Pole cenowe = wiersz 2 / suma w param.txt (LISTROW/LISTSUM) albo pole VAT/rabatu z form.js. */
function isPriceArea(name) {
    const def = paramDef(name);
    if (def) return def.LISTROW == '2' || def.LISTSUM == 'true';
    return CUSTOM_PRICE_FIELDS.includes(name);
}

function isShown(area) {
    return area.style.display !== 'none' && !area.classList.contains('d-none');
}

const UNIT_RE = /\s*\[(€|eur|m2|m²|%)\]\s*/i;

function formatValue(raw, unit, lang) {
    const value = squash(raw);
    if (value === '' || /^0+([.,]0+)?$/.test(value)) return '';
    const num = Number(value.replace(',', '.'));
    if (!unit || !Number.isFinite(num)) return value;
    const u = unit.toLowerCase();
    if (u === '%') return value.includes('%') ? value : `${value}%`;
    const digits = u === '€' || u === 'eur' ? 2 : undefined;
    let text = value;
    try {
        text = new Intl.NumberFormat(lang, digits ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 3 }).format(num);
    } catch (_) { /* nieznany język — zostaje surowa liczba */ }
    return `${text} ${u === 'm2' || u === 'm²' ? 'm²' : '€'}`;
}

function collectPriceRows(form) {
    const lang = root.lang || 'en';
    const rows = [];
    form.querySelectorAll(`:scope > div[class*="${AREA_SUFFIX}"]`).forEach((area) => {
        const name = areaName(area);
        if (!name || !isPriceArea(name) || !isShown(area)) return;
        const input = area.querySelector('input');
        if (!input) return;
        const labelNode = area.querySelector('label');
        const rawLabel = ownText(labelNode, '.param-info-icon, .param-info-tooltip') || name;
        const unitMatch = rawLabel.match(UNIT_RE);
        rows.push({
            name,
            area,
            label: rawLabel.replace(UNIT_RE, ' ').replace(/\s+/g, ' ').replace(/[\s:]+$/, '').trim(),
            value: formatValue(input.value, unitMatch && unitMatch[1], lang),
            masked: input.classList.contains('price-value-masked'),
            // pole z ręcznym nadpisaniem ceny zostaje w siatce (tam jest checkbox)
            mirror: input.disabled && !area.querySelector('.manual-override-row'),
            sum: paramDef(name)?.LISTSUM == 'true'
        });
    });
    // Suma = ostatni widoczny wiersz LISTSUM (tak liczy getTotal() w form.js)
    const sums = rows.filter((r) => r.sum);
    if (sums.length) sums[sums.length - 1].total = true;
    return rows;
}

const pricePanel = {
    host: null,
    aside: null,
    rowsBox: null,
    totalBox: null,
    hint: null,
    save: null,
    media: null,
    key: '',
    timer: null,
    observer: null,
    stepperObserver: null
};

function renderPricePanel() {
    const form = document.getElementById('dynamic-form');
    if (!form || !pricePanel.aside) return;
    const rows = collectPriceRows(form);
    const original = document.getElementById('show-button');
    const ready = form.children.length > 0;
    const saveDisabled = !original || original.disabled || !ready;
    // Dopóki nie wybrano grupy, formularza nie ma — pusty panel byłby szumem.
    if (pricePanel.aside.hidden === ready) pricePanel.aside.hidden = !ready;

    // Oznaczenie wierszy, które panel przejmuje (CSS chowa je w siatce).
    // ⚠️ Tylko przy RÓŻNICY — `#dynamic-form` jest obserwowany także na zmiany
    // klas, więc zdejmowanie i zakładanie klasy przy każdym odczycie
    // zapętlałoby obserwator.
    const mirrored = new Set(rows.filter((r) => r.mirror).map((r) => r.area));
    form.querySelectorAll(`:scope > div[class*="${AREA_SUFFIX}"]`).forEach((area) => {
        const want = mirrored.has(area);
        if (area.classList.contains('efor-price-mirrored') !== want) area.classList.toggle('efor-price-mirrored', want);
    });

    const key = JSON.stringify(rows.map(({ area, ...r }) => r)) + saveDisabled + (original ? original.textContent : '');
    if (key === pricePanel.key) return;
    pricePanel.key = key;

    pricePanel.rowsBox.textContent = '';
    const plain = rows.filter((r) => !r.total);
    for (const r of plain) {
        pricePanel.rowsBox.appendChild(el('div', { class: 'efor-price-row' }, [
            el('dt', { text: r.label }),
            el('dd', {}, [r.masked ? el('span', { class: 'efor-skeleton efor-price-row__skeleton', 'aria-label': T.calculating }) : (r.value || '—')])
        ]));
    }
    const total = rows.find((r) => r.total);
    pricePanel.totalBox.hidden = !total;
    pricePanel.totalBox.classList.toggle('is-empty', !total || !total.value);
    if (total) {
        pricePanel.totalBox.querySelector('.efor-price-total__label').textContent = total.label;
        const valueNode = pricePanel.totalBox.querySelector('.efor-price-total__value');
        valueNode.textContent = '';
        valueNode.appendChild(total.masked ? el('span', { class: 'efor-skeleton efor-price-total__skeleton', 'aria-label': T.calculating }) : document.createTextNode(total.value || '—'));
    }
    pricePanel.hint.hidden = !!(total && total.value);

    if (original) pricePanel.save.querySelector('span').textContent = squash(original.textContent);
    pricePanel.save.disabled = saveDisabled;

    // nagłówek: ilustracja + „DZIAŁ · GRUPA” (tylko konfigurator nowej pozycji)
    const dept = document.getElementById('department-select');
    const group = document.getElementById('asortment-group-select');
    const deptLabel = selectedLabel(dept);
    pricePanel.media.hidden = !deptLabel;
    if (deptLabel) {
        pricePanel.media.textContent = '';
        pricePanel.media.append(
            el('span', { class: 'efor-price-panel__illu', 'aria-hidden': 'true' }, [icon(illustrationFor(dept.value, deptLabel))]),
            el('span', { class: 'efor-price-panel__caption', text: [deptLabel, selectedLabel(group)].filter(Boolean).join(' · ') })
        );
    }
}

/** „−/+” przy ilości (makieta 8). Przyciski zmieniają wartość i wysyłają `input` — resztę robi form.js. */
function attachQtyStepper() {
    const input = document.getElementById('ILOSC');
    const area = input?.closest(`div[class*="${AREA_SUFFIX}"]`);
    if (!area || area.querySelector('.efor-qty-btn') || input.disabled) return;
    const step = (delta) => {
        const min = Number(input.min) > 0 ? Number(input.min) : 1;
        const max = input.max !== '' && Number.isFinite(Number(input.max)) ? Number(input.max) : Infinity;
        const current = parseInt(input.value, 10);
        const next = Math.min(max, Math.max(min, (Number.isFinite(current) ? current : min) + delta));
        if (String(next) === input.value) return;
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const minus = el('button', { type: 'button', class: 'efor-qty-btn efor-qty-btn--minus efor-v2-only', 'aria-label': '−1', text: '−' });
    const plus = el('button', { type: 'button', class: 'efor-qty-btn efor-qty-btn--plus efor-v2-only', 'aria-label': '+1', text: '+' });
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    area.classList.add('efor-qty-area');
    area.append(minus, plus);
}

function detachQtyStepper() {
    document.querySelectorAll('.efor-qty-btn').forEach((btn) => btn.remove());
    document.querySelectorAll('.efor-qty-area').forEach((area) => area.classList.remove('efor-qty-area'));
}

register({
    name: 'price-panel',
    pages: ['new-position', 'edit-position'],
    mount() {
        // Panel idzie do `.content` (siatka [parametry | panel] w CSS), a nie
        // obok `#dynamic-form`: kontener formularza (`.order-reminder`) dostaje
        // z main.js inline `display: block !important`, którego żaden arkusz
        // nie przebije — nie da się z niego zrobić siatki.
        const form = document.getElementById('dynamic-form');
        const host = form?.closest('.content');
        if (!form || !host) return;
        pricePanel.host = host;
        pricePanel.rowsBox = el('dl', { class: 'efor-price-panel__rows' });
        pricePanel.media = el('div', { class: 'efor-price-panel__media', hidden: true });
        pricePanel.totalBox = el('div', { class: 'efor-price-total', hidden: true }, [
            el('span', { class: 'efor-price-total__label' }),
            el('strong', { class: 'efor-price-total__value' })
        ]);
        pricePanel.hint = el('p', { class: 'efor-price-panel__hint' }, [icon('efor-i-info'), T.priceHint]);
        pricePanel.save = el('button', { type: 'button', class: 'efor-btn efor-btn--primary efor-price-panel__save', disabled: true }, [icon('efor-i-save'), el('span')]);
        pricePanel.save.addEventListener('click', () => document.getElementById('show-button')?.click());
        pricePanel.aside = el('aside', { class: 'efor-price-panel efor-card efor-v2-only', 'aria-label': T.cardPrices }, [
            el('h2', { class: 'efor-card__head', text: T.cardPrices }),
            el('div', { class: 'efor-card__body' }, [
                pricePanel.media,
                pricePanel.rowsBox,
                pricePanel.totalBox,
                pricePanel.hint,
                pricePanel.save
            ])
        ]);
        host.appendChild(pricePanel.aside);
        host.classList.add('efor-price-ready');

        pricePanel.observer = new MutationObserver(() => {
            renderPricePanel();
            attachQtyStepper();
        });
        pricePanel.observer.observe(form, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'disabled'] });
        pricePanel.timer = window.setInterval(() => {
            if (!document.hidden) renderPricePanel();
        }, 400);
        renderPricePanel();
        attachQtyStepper();
    },
    unmount() {
        pricePanel.observer?.disconnect();
        window.clearInterval(pricePanel.timer);
        document.querySelectorAll('.efor-price-mirrored').forEach((area) => area.classList.remove('efor-price-mirrored'));
        detachQtyStepper();
        pricePanel.host?.classList.remove('efor-price-ready');
        pricePanel.aside?.remove();
        pricePanel.aside = null;
        pricePanel.key = '';
    }
});

// ── start ──────────────────────────────────────────────────────────────────

export { register, icon, el, squash, ownText, moveInto, T, page };

if (store) {
    store.subscribe((variant) => (variant === store.EFOR ? activate() : deactivate()));
    if (store.isEfor()) activate();
}
