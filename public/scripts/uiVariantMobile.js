/* =============================================================================
   WARIANT B NA TELEFONIE — zachowanie powłoki „jak iOS”
   =============================================================================
   Wygląd jest w public/styles/theme-efor-v2.css (sekcja 20). Ten plik dokłada
   to, czego sam CSS nie zrobi:

     • arkusz „Więcej” — to samo menu `#mobileNav` co pod hamburgerem, ale
       wysuwane od dołu z przyciemnieniem, zamykane przyciskiem, Escape,
       dotknięciem tła albo przeciągnięciem w dół; reszta strony jest wtedy
       `inert`. Kliknięcie „Więcej” (także przez asystenta) przechwytujemy
       w fazie capture na `window` — Bootstrap 5 rejestruje swoje delegowane
       kliknięcia w fazie capture na `document` (i wcześniej niż my), więc
       dopiero `window` jest przed nim na ścieżce zdarzenia,
     • tytuł w pasku nawigacji — pojawia się, gdy duży tytuł strony zjedzie
       pod pasek; linia pod paskiem tylko wtedy, gdy coś pod nim przewinięto,
     • wiersze „Tryb ciemny” i „Przewodnik” w arkuszu klikają istniejące
       przyciski z menu konta (`data-efor-proxy`),
     • kontekst admina (organizacja, klient, ostatni klient) przenoszony do
       arkusza — ten sam węzeł `.admin-section` (owner.js wiąże się po id),
       z powrotem na miejsce przy wyjściu z B / telefonu,
     • filtry list (daty, status) schowane za wierszem „Filtry” z liczbą
       aktywnych — wyszukiwarka zostaje na wierzchu.

   Działa wyłącznie w wariancie B i poniżej 768 px; przy przełączeniu na A albo
   poszerzeniu okna sprząta po sobie. Niczego nie przenosi i nie zmienia logiki.
   ============================================================================= */

const store = window.eformUiVariant;
const root = document.documentElement;
const mobile = window.matchMedia('(max-width: 767.98px)');

const OPEN_CLASS = 'efor-sheet-open';
const TITLE_CLASS = 'efor-title-docked';
const SCROLLED_CLASS = 'efor-scrolled';

/* Elementy, które zaznaczają tytuł strony — pierwszy widoczny wygrywa. */
const TITLE_SELECTORS = [
    '#order-title-mobile',
    '#order-title',
    '.efor-dash__title',
    '.orders-topbar-center h2',
    '.panel-title',
    'main .content h1',
    'main .content h2',
    'main h1',
    'main h2'
];

const T = window.eforV2I18n || {};

let active = false;
let cleanups = [];

function squash(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
}

// ── arkusz „Więcej” ─────────────────────────────────────────────────────────

let backdrop = null;
let opener = null;

function sheet() {
    return document.getElementById('mobileNav');
}

function isOpen() {
    return root.classList.contains(OPEN_CLASS);
}

function setInert(value) {
    document.querySelectorAll('main, .m-bottomnav, .site-footer, #eform-assistant').forEach((node) => {
        node.inert = value;
    });
}

function moreButtons() {
    return document.querySelectorAll('.m-bottomnav [data-m-nav="more"], .mobile-nav .navbar-toggler');
}

function openSheet(trigger) {
    const panel = sheet();
    if (!panel || isOpen()) return;
    opener = trigger || null;
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = 'efor-sheet-backdrop';
        backdrop.addEventListener('click', () => closeSheet());
        // W pasku nawigacji, nie w <body>: arkusz żyje w kontekście warstw
        // paska, więc tło musi być w tym samym, żeby leżeć pod arkuszem.
        (panel.closest('.mobile-nav') || document.body).appendChild(backdrop);
    }
    panel.scrollTop = 0;
    panel.style.transform = '';
    root.classList.add(OPEN_CLASS);
    document.body.classList.add('m-more-open');
    moreButtons().forEach((btn) => btn.setAttribute('aria-expanded', 'true'));
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    setInert(true);
    // Fokus dopiero po chwili: Chromium odrzuca `focus()` w tej samej klatce,
    // w której arkusz wychodzi z `visibility: hidden` (sprawdzone — po
    // wymuszonym przeliczeniu stylu też)
    const close = panel.querySelector('[data-efor-sheet-close]');
    if (close) setTimeout(() => { if (isOpen()) close.focus({ preventScroll: true }); }, 80);
}

function closeSheet() {
    const panel = sheet();
    if (!panel || !isOpen()) return;
    panel.style.transform = '';
    root.classList.remove(OPEN_CLASS);
    document.body.classList.remove('m-more-open');
    moreButtons().forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    setInert(false);
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    opener = null;
}

function onCaptureClick(event) {
    const trigger = event.target.closest('.m-bottomnav [data-m-nav="more"], .mobile-nav .navbar-toggler');
    if (trigger) {
        event.preventDefault();
        event.stopPropagation();
        isOpen() ? closeSheet() : openSheet(trigger);
        return;
    }
    if (event.target.closest('[data-efor-sheet-close]')) {
        event.preventDefault();
        closeSheet();
    }
}

function onKeydown(event) {
    if (event.key === 'Escape' && isOpen()) {
        event.stopPropagation();
        closeSheet();
    }
}

/* Przeciągnięcie w dół za nagłówek arkusza (albo za treść przewiniętą do
   góry) — arkusz idzie za palcem; puszczony niżej niż 90 px się zamyka. */
function wireDrag() {
    const panel = sheet();
    if (!panel) return;
    let startY = null;
    let dy = 0;

    on(panel, 'touchstart', (event) => {
        const fromHead = event.target.closest('.efor-sheet-head');
        if (!fromHead && panel.scrollTop > 0) return;
        startY = event.touches[0].clientY;
        dy = 0;
    }, { passive: true });

    on(panel, 'touchmove', (event) => {
        if (startY === null) return;
        dy = Math.max(0, event.touches[0].clientY - startY);
        if (dy > 0) {
            panel.style.transition = 'none';
            panel.style.transform = `translateY(${dy}px)`;
        }
    }, { passive: true });

    on(panel, 'touchend', () => {
        if (startY === null) return;
        panel.style.transition = '';
        if (dy > 90) {
            closeSheet();
        } else {
            panel.style.transform = '';
        }
        startY = null;
    });
}

// ── tytuł w pasku nawigacji ─────────────────────────────────────────────────

let titleObserver = null;

function findTitle() {
    for (const selector of TITLE_SELECTORS) {
        const node = document.querySelector(selector);
        if (node && node.offsetParent !== null && squash(node.textContent)) return node;
    }
    return null;
}

function titleText(node) {
    // Bez podtytułów zagnieżdżonych w nagłówku (nazwa oferty w #order-title)
    const clone = node.cloneNode(true);
    clone.querySelectorAll('p, small, .badge, .efor-v2-only').forEach((child) => child.remove());
    return squash(clone.textContent);
}

function wireTitle() {
    const slot = document.querySelector('[data-efor-navbar-title]');
    const node = findTitle();
    if (!slot || !node) return;
    slot.textContent = titleText(node);
    root.classList.add('efor-has-title');

    const bar = document.querySelector('.mobile-nav');
    const offset = bar ? Math.round(bar.getBoundingClientRect().height) : 52;
    titleObserver = new IntersectionObserver(([entry]) => {
        const hidden = !entry.isIntersecting && entry.boundingClientRect.top < offset;
        root.classList.toggle(TITLE_CLASS, hidden);
    }, { rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 });
    titleObserver.observe(node);
}

function wireScrolled() {
    const main = document.querySelector('main');
    const update = () => {
        const y = (main ? main.scrollTop : 0) || window.scrollY;
        root.classList.toggle(SCROLLED_CLASS, y > 2);
    };
    if (main) on(main, 'scroll', update, { passive: true });
    on(window, 'scroll', update, { passive: true });
    update();
}

// ── wiersze-pośrednicy w arkuszu ────────────────────────────────────────────

function syncProxies() {
    const dark = root.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('[data-efor-proxy="#theme-toggle"]').forEach((row) => {
        row.setAttribute('aria-checked', dark ? 'true' : 'false');
    });
}

function onProxyClick(event) {
    const row = event.target.closest('[data-efor-proxy]');
    if (!row) return;
    const target = document.querySelector(row.getAttribute('data-efor-proxy'));
    if (!target) return;
    // Przewodnik prowadzi po stronie — arkusz musi zniknąć przed pierwszym krokiem
    if (row.getAttribute('data-efor-proxy') !== '#theme-toggle') closeSheet();
    target.click();
    syncProxies();
}

let themeObserver = null;

// ── kontekst admina w arkuszu ───────────────────────────────────────────────

let adminHome = null;

function moveAdminContext() {
    const section = document.querySelector('main .admin-section, .admin-section');
    const slot = document.querySelector('[data-efor-admin-slot]');
    if (!section || !slot || slot.contains(section)) return;
    adminHome = document.createComment('efor-admin-section');
    section.parentNode.insertBefore(adminHome, section);
    slot.appendChild(section);
}

/* Wiersz kontekstu pod dużym tytułem: „organizacja · klient” — admin zawsze
   widzi, w czyim kontekście pracuje; dotknięcie otwiera arkusz na grupie
   „Administracja”. Tekst z istniejących kontrolek (przycisk organizacji,
   pole klienta), więc nic nie jest liczone drugi raz. */
let contextRow = null;

function adminContextText() {
    const org = squash(document.getElementById('organizationDropdown')?.textContent);
    const client = squash(document.getElementById('userSelect')?.value);
    return [org, client].filter(Boolean).join(' · ');
}

function wireAdminContextRow() {
    if (contextRow || !document.querySelector('[data-efor-admin-slot] .admin-section')) return;
    const title = findTitle();
    const text = adminContextText();
    if (!title || !text) return;
    contextRow = document.createElement('button');
    contextRow.type = 'button';
    contextRow.className = 'efor-admin-context';
    contextRow.innerHTML = '<span class="efor-admin-context__text"></span>';
    contextRow.querySelector('.efor-admin-context__text').textContent = text;
    contextRow.setAttribute('aria-label', `${T.adminBar || 'Administracja'}: ${text}`);
    title.insertAdjacentElement('afterend', contextRow);
    on(contextRow, 'click', () => {
        openSheet(contextRow);
        const label = document.getElementById('efor-sheet-admin');
        const panel = sheet();
        if (label && panel) panel.scrollTop = Math.max(0, label.offsetTop - 64);
    });
}

function restoreAdminContext() {
    if (contextRow) contextRow.remove();
    contextRow = null;
    const section = document.querySelector('[data-efor-admin-slot] .admin-section');
    if (section && adminHome && adminHome.parentNode) {
        adminHome.parentNode.insertBefore(section, adminHome);
        adminHome.remove();
    }
    adminHome = null;
}

// ── filtry list za wierszem „Filtry” ────────────────────────────────────────

let filtersToggle = null;

function activeFilterCount(bar) {
    return [...bar.querySelectorAll('input[data-filter], select[data-filter]')]
        .filter((field) => field.value && field.value.trim() !== '').length;
}

function wireFilters() {
    const bar = document.getElementById('orders-filters-bar');
    if (!bar || filtersToggle) return;
    const fields = bar.querySelectorAll('input[data-filter], select[data-filter]');
    if (!fields.length) return;

    filtersToggle = document.createElement('button');
    filtersToggle.type = 'button';
    filtersToggle.className = 'efor-filters-toggle';
    filtersToggle.setAttribute('aria-expanded', 'false');
    filtersToggle.setAttribute('aria-controls', 'orders-filters-bar');
    filtersToggle.innerHTML = '<span class="efor-filters-toggle__label"></span><span class="efor-filters-toggle__count" aria-hidden="true"></span><span class="efor-filters-toggle__chevron" aria-hidden="true"></span>';
    filtersToggle.querySelector('.efor-filters-toggle__label').textContent = T.filters || 'Filtry';

    const search = bar.querySelector('.filter-group');
    if (search && search.nextSibling) bar.insertBefore(filtersToggle, search.nextSibling);
    else bar.appendChild(filtersToggle);

    const refresh = () => {
        const n = activeFilterCount(bar);
        const count = filtersToggle.querySelector('.efor-filters-toggle__count');
        count.textContent = n ? String(n) : '';
        filtersToggle.setAttribute('aria-label', `${T.filters || 'Filtry'}${n ? ` (${n})` : ''}`);
    };
    // Otwarte od razu, gdy filtr jest już ustawiony (np. po powrocie na listę)
    const open = (value) => {
        root.classList.toggle('efor-filters-open', value);
        filtersToggle.setAttribute('aria-expanded', value ? 'true' : 'false');
    };
    on(filtersToggle, 'click', () => open(!root.classList.contains('efor-filters-open')));
    on(bar, 'change', refresh);
    on(bar, 'input', refresh);
    refresh();
    open(activeFilterCount(bar) > 0);
}

function unwireFilters() {
    if (filtersToggle) filtersToggle.remove();
    filtersToggle = null;
    root.classList.remove('efor-filters-open');
}

// ── włączanie / wyłączanie ──────────────────────────────────────────────────

function mount() {
    if (active) return;
    active = true;
    on(window, 'click', onCaptureClick, true);
    on(document, 'click', onProxyClick);
    on(document, 'keydown', onKeydown, true);
    wireDrag();
    wireTitle();
    wireScrolled();
    syncProxies();
    moveAdminContext();
    wireAdminContextRow();
    wireFilters();
    themeObserver = new MutationObserver(syncProxies);
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}

function unmount() {
    if (!active) return;
    closeSheet();
    restoreAdminContext();
    unwireFilters();
    cleanups.forEach((fn) => fn());
    cleanups = [];
    if (titleObserver) titleObserver.disconnect();
    if (themeObserver) themeObserver.disconnect();
    titleObserver = null;
    themeObserver = null;
    root.classList.remove(TITLE_CLASS, SCROLLED_CLASS, 'efor-has-title');
    active = false;
}

function sync() {
    const wanted = Boolean(store && store.isEfor()) && mobile.matches;
    wanted ? mount() : unmount();
}

function start() {
    sync();
    if (store) store.subscribe(sync);
    mobile.addEventListener('change', sync);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}
