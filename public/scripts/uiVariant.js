/* =============================================================================
   WARIANT WYGLĄDU — globalny stan (A = klasyczny, B = „Efor 2.0")
   =============================================================================
   Jedyne źródło prawdy o tym, który wygląd jest aktywny. Odpowiednik
   Context API/Reduxa w tym stacku (vanilla JS + Nunjucks SSR): mały magazyn
   stanu na `window.eformUiVariant` z subskrypcją i zdarzeniem.

   ⚠️ Ładowany SYNCHRONICZNIE w <head> (base.njk, login.njk) — ustawia klasę
   `theme-efor-v2` na <html> zanim przeglądarka cokolwiek narysuje, więc przy
   odświeżeniu nie ma mignięcia wariantu A. Ten sam wzorzec co themeToggle.js.
   Dlatego to zwykły skrypt (IIFE), nie moduł — moduły są zawsze odroczone.

   Warstwa wyłącznie prezentacyjna: wariant zmienia klasy i atrybuty na <html>,
   a style (public/styles/theme-efor-v2.css) i widoki
   (public/scripts/uiVariantView.js) reagują na nie. Żadna logika biznesowa,
   żadne zapytanie API ani stan formularza nie zależą od wariantu.

   Stan na <html>:
     • klasa `theme-efor-v2`       — tylko w wariancie B (na niej wiszą style),
     • `data-ui-variant`           — `classic` | `efor-v2` (diagnostyka, testy),
     • `data-efor-page`            — klucz podstrony (style per widok, patrz
                                     pageKey()); ustawiany zawsze, jest tani,
     • `data-efor-group`           — grupa podstron o wspólnym układzie
                                     (`order`, `configurator`, `order-data`,
                                     `lists`; inne = klucz podstrony),
     • `data-efor-positions`       — preferencja widoku pozycji oferty w B
                                     (`cards` | `table`, localStorage
                                     `eform-v2-positions`, patrz PREFS).

   Trwałość: localStorage `eform-ui-variant` — wybór jest per przeglądarka,
   przeżywa odświeżenie i wylogowanie, synchronizuje się między kartami
   (zdarzenie `storage`). Tryb jasny/ciemny (themeToggle.js, `data-theme`)
   jest od wariantu niezależny: B ma własną paletę dla obu trybów.

   API:
     eformUiVariant.get()            → 'classic' | 'efor-v2'
     eformUiVariant.isEfor()         → boolean
     eformUiVariant.set(v)           → ustawia i zapamiętuje
     eformUiVariant.toggle()
     eformUiVariant.subscribe(fn)    → fn(variant, previous); zwraca unsubscribe
     eformUiVariant.getPref(name) / setPref(name, value) — preferencje widoku B
   Zdarzenie: `eform:ui-variant-change` na window, detail = { variant, previous }.

   Kontrolki (delegacja kliknięć — działają też dla elementów dodanych później):
     [data-ui-variant-toggle]          — przełącza A ⇄ B,
     [data-ui-variant-set="classic"]   — ustawia konkretny wariant.
   ============================================================================= */
(function () {
    'use strict';

    var STORAGE_KEY = 'eform-ui-variant';
    var CLASSIC = 'classic';
    var EFOR = 'efor-v2';
    var ROOT_CLASS = 'theme-efor-v2';
    var EVENT_NAME = 'eform:ui-variant-change';
    var root = document.documentElement;
    var listeners = [];

    function normalize(value) {
        return value === EFOR ? EFOR : CLASSIC;
    }

    // localStorage potrafi rzucić (tryb prywatny Safari, zablokowane dane
    // witryny) — wtedy zostaje wariant domyślny, a strona działa normalnie.
    function readStored() {
        try {
            return normalize(window.localStorage.getItem(STORAGE_KEY));
        } catch (_) {
            return CLASSIC;
        }
    }

    function persist(value) {
        try {
            window.localStorage.setItem(STORAGE_KEY, value);
        } catch (_) { /* brak trwałości — wariant działa do końca tej strony */ }
    }

    /**
     * Klucz podstrony dla stylów per widok. Liczony z adresu, bo szablony nie
     * mają wspólnego miejsca na klasę strony, a <body> w chwili wykonania tego
     * skryptu jeszcze nie istnieje.
     * ⚠️ Kolejność warunków ma znaczenie: `/orders/order/1/new-position/`
     * zaczyna się tak samo jak `/orders/order/1`.
     */
    function pageKey(pathname) {
        var p = (pathname || '/').replace(/\/+$/, '') || '/';
        if (p === '/') return 'home';
        if (/^\/orders\/order\/\d+\/new-position$/.test(p)) return 'new-position';
        if (/^\/orders\/order\/\d+(\/(true|false))?$/.test(p)) return 'order';
        if (/^\/orders\/history\/order\/\d+/.test(p)) return 'order-sent';
        if (p === '/orders/history') return 'history';
        if (p === '/orders/add-order') return 'add-order';
        if (/^\/orders\/edit\/\d+$/.test(p)) return 'edit-order';
        if (p === '/orders' || p === '/orders/organization-orders') return 'orders';
        if (/^\/position\/\d+\/(edit|admin-redit)$/.test(p)) return 'edit-position';
        if (/^\/position\/\d+$/.test(p)) return 'position';
        if (p === '/panel') return 'panel';
        if (/^\/user\/(login|auth)/.test(p)) return 'login';
        return 'other';
    }

    /**
     * Grupa podstron o wspólnym układzie — krótszy selektor w CSS niż lista
     * kluczy (`[data-efor-group="order"]` zamiast `:is(order, order-sent)`).
     */
    var PAGE_GROUPS = {
        'order': 'order',
        'order-sent': 'order',
        'new-position': 'configurator',
        'edit-position': 'configurator',
        'add-order': 'order-data',
        'edit-order': 'order-data',
        'orders': 'lists',
        'history': 'lists'
    };

    function applyToRoot(value) {
        root.classList.toggle(ROOT_CLASS, value === EFOR);
        root.setAttribute('data-ui-variant', value);
    }

    /** Stan wszystkich przełączników na stronie (aria + podpowiedź). */
    function syncControls(value) {
        var isEfor = value === EFOR;
        var toggles = document.querySelectorAll('[data-ui-variant-toggle]');
        for (var i = 0; i < toggles.length; i++) {
            var btn = toggles[i];
            btn.setAttribute('aria-pressed', isEfor ? 'true' : 'false');
            var hint = btn.getAttribute(isEfor ? 'data-hint-classic' : 'data-hint-efor');
            if (hint) {
                btn.setAttribute('title', hint);
                btn.setAttribute('data-tooltip', hint);
            }
        }
        var setters = document.querySelectorAll('[data-ui-variant-set]');
        for (var j = 0; j < setters.length; j++) {
            var on = setters[j].getAttribute('data-ui-variant-set') === value;
            setters[j].setAttribute('aria-checked', on ? 'true' : 'false');
            setters[j].classList.toggle('is-active', on);
        }
    }

    /**
     * Płynne przejście między wariantami bez przeładowania strony.
     * View Transitions API daje przenikanie całego widoku; bez niego (Firefox,
     * starsze Safari) na 400 ms włączamy przejścia kolorów klasą
     * `efor-switching`. `prefers-reduced-motion` = zmiana natychmiastowa.
     */
    function withTransition(fn) {
        var reduce = false;
        try {
            reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_) { /* brak matchMedia — traktujemy jak zwykły tryb */ }
        if (reduce) {
            fn();
            return;
        }
        if (typeof document.startViewTransition === 'function') {
            try {
                document.startViewTransition(fn);
                return;
            } catch (_) { /* np. dokument w tle — lecimy ścieżką zapasową */ }
        }
        root.classList.add('efor-switching');
        fn();
        window.setTimeout(function () {
            root.classList.remove('efor-switching');
        }, 400);
    }

    var current = readStored();

    function notify(value, previous) {
        for (var i = 0; i < listeners.length; i++) {
            try {
                listeners[i](value, previous);
            } catch (err) {
                // Błąd jednego subskrybenta nie może zablokować pozostałych
                // ani samego przełączenia wyglądu.
                if (window.console) console.error('[uiVariant] subskrybent:', err);
            }
        }
        try {
            window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { variant: value, previous: previous } }));
        } catch (_) { /* bardzo stare przeglądarki bez CustomEvent */ }
    }

    function commit(value, options) {
        var next = normalize(value);
        var opts = options || {};
        if (opts.persist !== false) persist(next);
        if (next === current) {
            syncControls(next);
            return;
        }
        var previous = current;
        current = next;
        var run = function () {
            applyToRoot(next);
            syncControls(next);
        };
        if (opts.animate === false) run(); else withTransition(run);
        notify(next, previous);
    }

    /**
     * Drobne preferencje widoku wariantu B (np. karty/tabela pozycji oferty).
     * Też localStorage i też ustawiane tu, przed malowaniem — inaczej po
     * odświeżeniu mignąłby widok domyślny. Wartość trafia na <html> jako
     * `data-efor-<nazwa>`.
     */
    var PREFS = { positions: { key: 'eform-v2-positions', values: ['cards', 'table'], fallback: 'cards' } };

    function readPref(name) {
        var def = PREFS[name];
        if (!def) return null;
        try {
            var stored = window.localStorage.getItem(def.key);
            return def.values.indexOf(stored) !== -1 ? stored : def.fallback;
        } catch (_) {
            return def.fallback;
        }
    }

    function writePref(name, value) {
        var def = PREFS[name];
        if (!def || def.values.indexOf(value) === -1) return;
        try {
            window.localStorage.setItem(def.key, value);
        } catch (_) { /* bez trwałości — działa do końca tej strony */ }
        root.setAttribute('data-efor-' + name, value);
    }

    // ── stan początkowy: przed pierwszym malowaniem ────────────────────────
    applyToRoot(current);
    var currentPage = pageKey(window.location.pathname);
    root.setAttribute('data-efor-page', currentPage);
    root.setAttribute('data-efor-group', PAGE_GROUPS[currentPage] || currentPage);
    for (var prefName in PREFS) {
        if (Object.prototype.hasOwnProperty.call(PREFS, prefName)) {
            root.setAttribute('data-efor-' + prefName, readPref(prefName));
        }
    }

    // ── kontrolki: delegacja, bo część przycisków powstaje później ────────
    document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var toggle = target.closest('[data-ui-variant-toggle]');
        if (toggle) {
            event.preventDefault();
            commit(current === EFOR ? CLASSIC : EFOR);
            return;
        }
        var setter = target.closest('[data-ui-variant-set]');
        if (setter) {
            event.preventDefault();
            commit(setter.getAttribute('data-ui-variant-set'));
        }
    });

    document.addEventListener('DOMContentLoaded', function () {
        syncControls(current);
    });

    // Inna karta zmieniła wariant — ta nadąża, bez zapisu (już zapisane).
    window.addEventListener('storage', function (event) {
        if (event.key === STORAGE_KEY) {
            commit(event.newValue, { persist: false });
        }
    });

    window.eformUiVariant = {
        CLASSIC: CLASSIC,
        EFOR: EFOR,
        ROOT_CLASS: ROOT_CLASS,
        EVENT_NAME: EVENT_NAME,
        get: function () { return current; },
        isEfor: function () { return current === EFOR; },
        set: function (value) { commit(value); },
        toggle: function () { commit(current === EFOR ? CLASSIC : EFOR); },
        subscribe: function (fn) {
            if (typeof fn !== 'function') return function () { };
            listeners.push(fn);
            return function () {
                var idx = listeners.indexOf(fn);
                if (idx !== -1) listeners.splice(idx, 1);
            };
        },
        pageKey: pageKey,
        getPref: readPref,
        setPref: writePref
    };
})();
