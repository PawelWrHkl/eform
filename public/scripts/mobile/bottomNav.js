/* =============================================================================
   DOLNY PASEK NAWIGACJI — zachowanie (E-orders, ETAP 2)
   =============================================================================
   Sam pasek jest renderowany w templates/base.njk i dziala bez tego skryptu
   (linki to zwykle <a href>, "Mehr" to natywny collapse Bootstrapa).
   Ten plik dokłada trzy rzeczy, ktorych nie da sie zrobic w samym HTML-u:

     1. podswietlenie aktywnej zakladki wg sciezki (serwer nie wystawia
        `currentPath` w res.locals, a dopisywanie go byloby zmiana backendu),
     2. klasa `m-more-open` na <body>, gdy arkusz "Mehr" jest otwarty,
     3. schowanie paska na konfiguratorze pozycji - tam jedyna akcja dolna to
        "Speichern" i brief zabrania, zeby nawigacja z nia kolidowala.

   Skrypt NIE przenosi zadnego wezla, nie zmienia hrefow i nie dotyka logiki.
   ============================================================================= */

(function () {
    'use strict';

    function markActive() {
        const nav = document.querySelector('.m-bottomnav');
        if (!nav) return;

        const path = window.location.pathname.replace(/\/+$/, '') || '/';
        const items = Array.from(nav.querySelectorAll('[data-m-path]'));

        /* Najdluzsze pasujace dopasowanie wygrywa: `/orders/history` musi
           podswietlic "Bestellungen", a nie "Angebote" (`/orders` jest jego
           prefiksem). Dlatego sortujemy malejaco po dlugosci sciezki. */
        let best = null;
        items
            .slice()
            .sort((a, b) => b.dataset.mPath.length - a.dataset.mPath.length)
            .some(item => {
                const target = item.dataset.mPath.replace(/\/+$/, '') || '/';
                const hit = target === '/' ? path === '/' : (path === target || path.startsWith(target + '/'));
                if (hit) { best = item; return true; }
                return false;
            });

        items.forEach(item => item.classList.toggle('is-active', item === best));
    }

    function wireMoreSheet() {
        const sheet = document.getElementById('mobileNav');
        if (!sheet) return;

        const sync = () => document.body.classList.toggle('m-more-open', sheet.classList.contains('show'));

        // Bootstrap emituje te zdarzenia niezaleznie od tego, ktory przycisk
        // (hamburger czy "Mehr") otworzyl collapse.
        sheet.addEventListener('shown.bs.collapse', sync);
        sheet.addEventListener('hidden.bs.collapse', sync);
        sheet.addEventListener('show.bs.collapse', () => document.body.classList.add('m-more-open'));
        sheet.addEventListener('hide.bs.collapse', () => document.body.classList.remove('m-more-open'));
        sync();
    }

    /* Konfigurator pozycji (templates/form.njk) - pasek znika, a rezerwa
       miejsca w `main` schodzi do zera, zeby pod przyciskiem zapisu nie
       zostala pusta luka. */
    function hideOnConfigurator() {
        if (!document.getElementById('commission-form')) return;
        const nav = document.querySelector('.m-bottomnav');
        if (nav) nav.style.display = 'none';
        document.documentElement.style.setProperty('--m-bottomnav-h', '0px');
    }

    function boot() {
        hideOnConfigurator();
        markActive();
        wireMoreSheet();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
