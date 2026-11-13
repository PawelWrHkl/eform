/* POP-21 — „Dodaj pozycję” w zasięgu przy długiej ofercie (order.njk).
   Przycisk w nagłówku przewija się razem z treścią: w B i na telefonie nagłówek
   jest statyczny, a w A `position: fixed` z #order-nav nie działa, odkąd `.content`
   ma animację `fadeInUp … both` (theme.css) — zostawia `transform`, a ten robi
   z przodka blok zawierający dla `fixed`. Stąd:
     1) kopia przycisku na końcu listy pozycji (ta sama, co dawniej tylko w B, karty),
     2) pływający przycisk w <body>, gdy nie widać ani nagłówka, ani końca listy,
     3) po powrocie z dodawania widok przewija się do nowej pozycji i ją podświetla.
   Logika dodawania bez zmian — oba przyciski to zwykłe linki na ten sam adres
   (okno biura, staff/positionDialog.js, przechwytuje je po adresie). */
(() => {
    const NEW_POS = /\/orders\/order\/(\d+)\/new-position\/?$/;
    const KEY = 'eform-add-position-before';
    const rows = () => [...document.querySelectorAll('tr[data-id], .mobile-item-card[data-id]')];
    const maxId = () => Math.max(0, ...rows().map((el) => Number(el.dataset.id) || 0));

    // Największe id pozycji przed wejściem w dodawanie. `window` + przechwytywanie,
    // bo okno biura zatrzymuje kliknięcie już na `document`.
    window.addEventListener('click', (event) => {
        const link = event.target.closest && event.target.closest('a[href]');
        const match = link && NEW_POS.exec(new URL(link.href, location.href).pathname);
        if (!match) return;
        try {
            sessionStorage.setItem(KEY, JSON.stringify({ order: match[1], max: maxId() }));
        } catch (_) { /* bez sessionStorage — tylko bez przewinięcia po powrocie */ }
    }, true);

    let before = null;
    try {
        before = JSON.parse(sessionStorage.getItem(KEY));
        sessionStorage.removeItem(KEY);
    } catch (_) { /* bez sessionStorage — bez przewinięcia */ }
    if (before && String(before.order) === document.getElementById('order-title')?.dataset.id) {
        // Okno biura po zapisie przeładowuje stronę, a przeglądarka przywróciłaby wtedy
        // dawne przewinięcie już po naszym — na to jedno wczytanie wyłączone.
        history.scrollRestoration = 'manual';
        window.addEventListener('pagehide', () => { history.scrollRestoration = 'auto'; });
        window.addEventListener('load', () => {
            // Pozycje są w tabeli i w kartach naraz — bierzemy te, które widać.
            const fresh = rows().filter((el) => Number(el.dataset.id) > before.max && el.getClientRects().length);
            if (!fresh.length) return;
            // `instant`: `html` ma płynne przewijanie — przy 30+ pozycjach podświetlenie gasłoby w trakcie jazdy.
            fresh[0].scrollIntoView({ block: 'center', behavior: 'instant' });
            fresh.forEach((el) => el.classList.add('add-position-new'));
        });
    }

    const source = document.querySelector('#order-buttons.d-md-flex #new-order-button[href]');
    const lists = document.querySelectorAll('.order-table-container > .table-scroll');
    if (!source || !lists.length) return; // wysłane / tylko do wglądu / pusta oferta

    const href = source.getAttribute('href');
    const label = source.textContent.replace(/\s+/g, ' ').trim();

    const end = document.createElement('a');
    end.className = 'efor-add-position add-position-end';
    end.href = href;
    end.innerHTML = '<span class="efor-add-position__plus" aria-hidden="true">+</span>';
    end.append(label);
    lists[lists.length - 1].after(end);

    // Na telefonie sam „+” (napis chowa CSS) — nazwa zostaje w aria-label/title.
    const fab = document.createElement('a');
    fab.className = 'action-btn action-btn-send add-position-fab';
    fab.href = href;
    fab.hidden = true;
    fab.title = label;
    fab.setAttribute('aria-label', label);
    const plus = document.createElement('span');
    plus.className = 'add-position-fab__plus';
    plus.textContent = '+';
    const text = document.createElement('span');
    text.className = 'add-position-fab__label';
    text.textContent = label;
    fab.append(plus, text);
    document.body.append(fab);

    // Przeliczane przy przewijaniu, nie IntersectionObserverem: skok na koniec (End,
    // suwak) przeskakuje przycisk bez przecięcia i obserwator nic by nie zgłosił.
    // 80 px — stały nagłówek strony, pod którym przycisk z nagłówka już nie jest widoczny.
    const heads = [...document.querySelectorAll('#order-nav a[href]')].filter((a) => NEW_POS.test(a.pathname));
    const footer = document.querySelector('.site-footer');
    const phone = window.matchMedia('(max-width: 767.98px)');
    const update = () => {
        // Telefon A: pod przewijanym `main` stoi stopka z linkami (jej wysokość zależy
        // od zawijania) — przycisk 12 px nad nią. W B stopki nie ma, wtedy CSS.
        const footerTop = phone.matches && footer && footer.offsetParent ? footer.getBoundingClientRect().top : innerHeight;
        fab.style.bottom = footerTop < innerHeight ? `${Math.round(innerHeight - footerTop + 12)}px` : '';
        const inView = (el) => {
            const box = el.getBoundingClientRect();
            return box.height > 0 && box.bottom > 80 && box.top < innerHeight;
        };
        // Koniec listy doszedł do dolnej krawędzi pływającego (albo już minął) — chowamy
        // go, zanim na siebie najadą; ta linia leży też nad dolnymi paskami telefonu.
        const fabBottomEdge = innerHeight - (parseFloat(getComputedStyle(fab).bottom) || 0);
        const pastEnd = end.getBoundingClientRect().top < fabBottomEdge;
        fab.hidden = pastEnd || heads.some(inView);
    };
    let queued = false;
    const schedule = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; update(); });
    };
    // `scroll` nie bubbluje — przechwytywanie łapie też przewijany `main` na telefonie.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('load', schedule);
    window.addEventListener('eform:ui-variant-change', schedule);
    schedule();
})();
