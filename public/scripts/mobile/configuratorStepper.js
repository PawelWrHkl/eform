/* =============================================================================
   MOBILE KREATOR KONFIGURATORA — E-orders (ETAP 1, wersja krokowa)
   =============================================================================
   Jednoekranowy konfigurator podzielony na KROKI: widac tylko sekcje aktywnego
   kroku, resztę chowamy. Pasek z numerami jest przypiety do dolu ekranu.

   ###########################################################################
   # DLACZEGO NIGDZIE TU NIE MA `display`                                     #
   #                                                                         #
   # Widocznoscia pojedynczych pol rzadzi silnik konfiguratora, inline i BEZ  #
   # `!important`:  paramDiv.style.display = 'grid' | 'none'                  #
   # (createForm.js: applySingleParamVisibility, hideLockedParamRows,         #
   #  hideRegularPriceRowsDuringCalc, hideParams; form.js: pola VAT i rabatu).#
   # `.asortment-container` dostaje z kolei `display: block` z priorytetem    #
   # `important` (createForm.js: processCommissionInput).                     #
   #                                                                         #
   # Gdyby kreator chowal kroki przez `display`, wchodzilby tej logice w      #
   # droge w obie strony: albo odslonilby pola ukryte przez ENABLE / ceny     #
   # zablokowane dla salonu / pola chronione haslem, albo (przy inline        #
   # `!important`) w ogole by nie zadzialal.                                  #
   #                                                                         #
   # Dlatego kreator zaznacza elementy atrybutem `data-m-hidden="1"`, a CSS   #
   # (mobile/configurator.css) wynosi je poza ekran `position: absolute` +    #
   # `visibility: hidden`. To jest ORTOGONALNE do `display`: pole ukryte      #
   # przez silnik pozostaje ukryte, a pole widoczne po prostu czeka na swoj   #
   # krok. Skrypt NIE przenosi, nie usuwa i nie przestawia zadnego wezla      #
   # formularza ani nie dotyka wartosci.                                      #
   ###########################################################################
   ============================================================================= */

(function () {
    'use strict';

    const MQ = '(max-width: 767.98px)';
    const BREAKPOINT_OK = () => window.matchMedia(MQ).matches;

    /* --------------------------------------------------------------- kroki --
       Nazwy parametrow w HKL sa stabilne miedzy grupami asortymentowymi
       (ILOSC / MODEL / KOLOR* / SZEROKOSC / WYSOKOSC / CENA* / WARTOSC*...),
       sprawdzone na param.txt grup 11, 20 i 59. Klasyfikacja jest czysto
       opisowa - nie zmienia tego, CO silnik renderuje ani w jakiej kolejnosci.

       Dowolna grupa moze dostac wlasny podzial bez ruszania tego pliku:
           window.MOBILE_STEP_RULES = [{ id, test(name) }, ...]
       Reguly sa sprawdzane po kolei; pierwsze trafienie wygrywa, brak
       trafienia = kosz `zusatz`. */
    const DEFAULT_RULES = [
        { id: 'preis', test: n => /^(SUB___|CENA|DOPLATA|SUMA|WARTOSC|RABAT|VAT|PODATEK)/.test(n) || /(_RABAT|_BRUTTO|_NETTO)$/.test(n) },
        { id: 'masse', test: n => /^(SZEROKOSC|WYSOKOSC|GLEBOKOSC|DLUGOSC|POW|WYMIAR|RAMAOKNA)/.test(n) || /(_SZER|_WYS|_MM|_MONTAZU)$/.test(n) },
        { id: 'farbe', test: n => /^(KOLOR|STOFF|FARBE|TASIEMKA|BUTKOLOR|PROFIL|BLENDA|RODZAJ_SIATKI|RODZAJ_TEXT)/.test(n) },
        { id: 'produkt', test: n => /^(ILOSC|MODEL|WARIANT|RODZAJ|ROZMIAR|SLOPE_TYPE|TYP)/.test(n) },
        { id: 'zusatz', test: () => true }
    ];

    /* Etykiety trzymamy TU, a nie w plikach tlumaczen: locale zyja poza
       repozytorium (config.localesDir = /mnt/eform/languages), wiec dodanie
       kluczy wymagaloby wdrozenia poza kodem. Gdyby klucz `form.step.<id>`
       kiedys tam powstal, ma pierwszenstwo - patrz stepLabel(). */
    const LABELS = {
        pl: { produkt: 'Produkt', farbe: 'Kolor', masse: 'Wymiary', zusatz: 'Dodatki', preis: 'Cena', _nav: 'Kroki konfiguracji', _next: 'Dalej', _back: 'Wstecz' },
        de: { produkt: 'Produkt', farbe: 'Stoff', masse: 'Maße', zusatz: 'Zusatz', preis: 'Preis', _nav: 'Konfigurationsschritte', _next: 'Weiter', _back: 'Zurück' },
        en: { produkt: 'Product', farbe: 'Fabric', masse: 'Size', zusatz: 'Extras', preis: 'Price', _nav: 'Configuration steps', _next: 'Next', _back: 'Back' },
        nl: { produkt: 'Product', farbe: 'Stof', masse: 'Maten', zusatz: 'Extra', preis: 'Prijs', _nav: 'Configuratiestappen', _next: 'Volgende', _back: 'Terug' },
        fr: { produkt: 'Produit', farbe: 'Tissu', masse: 'Dimensions', zusatz: 'Options', preis: 'Prix', _nav: 'Étapes de configuration', _next: 'Suivant', _back: 'Retour' }
    };

    function rules() {
        return Array.isArray(window.MOBILE_STEP_RULES) && window.MOBILE_STEP_RULES.length
            ? window.MOBILE_STEP_RULES
            : DEFAULT_RULES;
    }

    function stepLabel(id) {
        const key = 'form.step.' + id;
        if (typeof window.t === 'function') {
            const translated = window.t(key);
            if (translated && translated !== key) return translated;
        }
        const lang = (document.documentElement.lang || 'de').slice(0, 2).toLowerCase();
        return (LABELS[lang] || LABELS.de)[id] || id;
    }

    /* Nazwa parametru wiersza. Kontrolka niesie ja w `name`/`id` (ustawia je
       form.js po zbudowaniu pola); klasa `<NAME>-select-area` jest zapasem,
       bo parametry TYPE='link' dostaja w zamian klase `link-area`. */
    function paramNameOf(row) {
        const control = row.querySelector('[name]');
        if (control && control.name) return String(control.name).toUpperCase();
        const match = String(row.className).match(/([A-Za-z0-9_]+)-select-area/);
        return match ? match[1].toUpperCase() : '';
    }

    function classify(name) {
        for (const rule of rules()) {
            try {
                if (rule && typeof rule.test === 'function' && rule.test(name)) return rule.id;
            } catch (_) { /* wlasna regula uzytkownika - nie moze wywrocic UI */ }
        }
        return 'zusatz';
    }

    /* Czy SILNIK uznaje ten wiersz za widoczny. Sprawdzamy wyliczony `display`,
       a nie `offsetParent`: wiersze schowane przez kreator sa wynoszone poza
       ekran `position: absolute`, wiec `offsetParent` dalej by je zwracal jako
       widoczne. `display` zmienia wylacznie silnik (i bootstrapowe `.d-none`),
       wiec to dokladnie ta informacja, ktorej potrzebujemy. Czytamy - nigdy
       nie zapisujemy. */
    function engineVisible(row) {
        return getComputedStyle(row).display !== 'none';
    }

    function scrollContainerOf(el) {
        let node = el.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            const overflowY = getComputedStyle(node).overflowY;
            if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    class Wizard {
        constructor(form) {
            this.form = form;
            this.steps = [];          // [{ id, rows: [] }] w kolejnosci z DOM
            this.signature = '';
            this.activeIndex = 0;

            /* ⚠️ Pasek ladujemy na <body>, a NIE obok #dynamic-form.
               Jest `position: fixed`, a `.content` i `.container` - obaj
               przodkowie tamtego miejsca - maja `animation: fadeInUp ... both`
               z theme.css. Fill-mode `both` zostawia na nich `transform`
               na stale, a element z transformem staje sie blokiem zawierajacym
               dla potomkow `position: fixed`. Pasek przestawal byc liczony
               wzgledem okna i ladowal w srodku dokumentu (zmierzone: top 2082px
               przy oknie 844px). Na <body> zadnego transformu nie ma. */
            this.nav = document.createElement('nav');
            this.nav.className = 'm-stepper';
            this.nav.setAttribute('aria-label', stepLabel('_nav'));
            this.list = document.createElement('ol');
            this.list.className = 'm-stepper__list';
            this.nav.appendChild(this.list);
            document.body.appendChild(this.nav);

            this.buildPager();
        }

        /** Wiersz [Wstecz] [Dalej] pod polami kroku. */
        buildPager() {
            this.pager = document.createElement('div');
            this.pager.className = 'm-steppager';

            // type="button" jest OBOWIAZKOWE: kreator siedzi w <form
            // id="commission-form">, a domyslny <button> to submit, ktory
            // przeladowalby strone i zgubil konfiguracje.
            this.prevBtn = document.createElement('button');
            this.prevBtn.type = 'button';
            this.prevBtn.className = 'm-steppager__btn m-steppager__back';
            this.prevBtn.textContent = stepLabel('_back');
            this.prevBtn.addEventListener('click', () => this.go(this.activeIndex - 1));

            this.nextBtn = document.createElement('button');
            this.nextBtn.type = 'button';
            this.nextBtn.className = 'm-steppager__btn m-steppager__next';
            this.nextBtn.textContent = stepLabel('_next');
            this.nextBtn.addEventListener('click', () => this.go(this.activeIndex + 1));

            this.pager.appendChild(this.prevBtn);
            this.pager.appendChild(this.nextBtn);
            this.form.parentNode.insertBefore(this.pager, this.form.nextSibling);
        }

        /** Przelicza kroki; przerysowuje pasek tylko gdy zestaw sie zmienil. */
        refresh() {
            const rows = Array.from(this.form.children).filter(
                node => node.nodeType === 1 && /-select-area|link-area/.test(node.className || '')
            );

            const byStep = new Map();
            const order = [];
            rows.forEach(row => {
                const id = classify(paramNameOf(row));
                row.dataset.mStep = id;
                // Wiersz ukryty przez SILNIK (ENABLE / haslo / ceny dla salonu)
                // nie tworzy kroku i nie podtrzymuje istniejacego. Wiersze
                // schowane przez kreator maja nietkniety `display`, wiec
                // `engineVisible` nadal je widzi - i o to chodzi.
                if (!engineVisible(row)) return;
                if (!byStep.has(id)) { byStep.set(id, []); order.push(id); }
                byStep.get(id).push(row);
            });

            this.steps = order.map(id => ({ id, rows: byStep.get(id) }));
            const signature = order.join('|');

            if (signature !== this.signature) {
                // Zmiana grupy asortymentowej przebudowuje formularz od zera -
                // kreator wraca wtedy na pierwszy krok.
                this.signature = signature;
                this.activeIndex = 0;
                this.renderBar();
            }
            if (this.activeIndex >= this.steps.length) this.activeIndex = Math.max(this.steps.length - 1, 0);

            this.markEmptyChoosers(rows);
            this.apply(rows);
            this.revealInvalid(rows);
        }

        renderBar() {
            this.list.innerHTML = '';
            this.steps.forEach((step, index) => {
                const item = document.createElement('li');
                item.className = 'm-stepper__item';
                item.dataset.step = step.id;

                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'm-stepper__btn';

                const num = document.createElement('span');
                num.className = 'm-stepper__num';
                num.textContent = String(index + 1);

                const label = document.createElement('span');
                label.className = 'm-stepper__label';
                label.textContent = stepLabel(step.id);

                button.appendChild(num);
                button.appendChild(label);
                button.addEventListener('click', () => this.go(index));

                item.appendChild(button);
                this.list.appendChild(item);
            });
        }

        /** Chowa wszystko, co nie nalezy do aktywnego kroku. */
        apply(rows) {
            const on = this.steps.length > 1;          // jeden krok = brak sensu dzielenia
            const activeId = on ? this.steps[this.activeIndex].id : null;

            rows.forEach(row => {
                const hide = on && row.dataset.mStep !== activeId;
                this.setHidden(row, hide);
            });

            /* Wybor zlecenia / dzialu / grupy nalezy do pierwszego kroku -
               na dalszych tylko zabiera ekran. Nie da sie go schowac przez
               `display`, bo processCommissionInput() ustawia `block` z
               priorytetem `important` - stad ta sama technika, co dla wierszy. */
            const asortment = document.querySelector('#commission-form .asortment-inputs');
            if (asortment) this.setHidden(asortment, on && this.activeIndex > 0);

            /* Zapis / reset / zalaczniki pokazuja sie dopiero na ostatnim kroku
               (podsumowanie) - jeden ekran, jedna glowna akcja. */
            const buttons = document.getElementById('buttons-space');
            const last = !on || this.activeIndex === this.steps.length - 1;
            if (buttons) this.setHidden(buttons, !last);

            this.nav.style.display = on ? '' : 'none';
            this.pager.style.display = on ? '' : 'none';
            document.body.classList.toggle('m-stepper-fixed', on);
            this.publishHeight(on);

            this.prevBtn.disabled = this.activeIndex === 0;
            this.nextBtn.hidden = last;

            Array.from(this.list.children).forEach((item, index) => {
                item.classList.toggle('is-active', index === this.activeIndex);
                item.classList.toggle('is-done', index < this.activeIndex);
            });
        }

        setHidden(el, hide) {
            if (hide) el.dataset.mHidden = '1';
            else delete el.dataset.mHidden;
        }

        go(index) {
            if (index < 0 || index >= this.steps.length) return;
            this.activeIndex = index;
            this.refresh();

            const scroller = this.steps.length ? scrollContainerOf(this.form) : null;
            if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
            else window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        /** Walidacja zapisu (main.js `highlightInvalidFields`) dokłada polom
         *  klase `.invalid-input` i przewija do pierwszego z nich. Gdyby takie
         *  pole lezalo na innym kroku, uzytkownik zobaczylby pusty przeskok -
         *  wiec przechodzimy na krok, ktory je zawiera. */
        revealInvalid(rows) {
            if (this.steps.length < 2) return;
            const activeId = this.steps[this.activeIndex].id;
            const row = rows.find(r => r.dataset.mStep !== activeId && r.querySelector('.invalid-input'));
            if (!row) return;
            const index = this.steps.findIndex(s => s.id === row.dataset.mStep);
            if (index >= 0 && index !== this.activeIndex) this.go(index);
        }

        /** Wysokosc paska trafia do `--m-stepper-h`, z ktorej <main> liczy swoj
         *  `padding-bottom`. Mierzymy zamiast wpisywac na sztywno, bo etykiety
         *  krokow roznia sie dlugoscia miedzy jezykami i przy waskim ekranie
         *  moga zawinac sie do dwoch linii. */
        publishHeight(visible) {
            const value = visible ? Math.round(this.nav.offsetHeight) + 'px' : '0px';
            document.documentElement.style.setProperty('--m-stepper-h', value);
        }

        /** Placeholder vs. wybrana wartosc - wylacznie kolor tekstu w CSS. */
        markEmptyChoosers(rows) {
            const placeholder = typeof window.t === 'function' ? String(window.t('form.check_word') || '').trim() : '';
            rows.forEach(row => {
                row.querySelectorAll('button.button').forEach(btn => {
                    const text = (btn.textContent || '').trim();
                    const empty = text === '' || (placeholder !== '' && text === placeholder);
                    if (empty) btn.dataset.mEmpty = '1';
                    else delete btn.dataset.mEmpty;
                });
            });
        }
    }

    function boot() {
        if (!BREAKPOINT_OK()) return;

        const form = document.getElementById('dynamic-form');
        if (!form || !form.parentNode || form.dataset.mStepper === '1') return;
        form.dataset.mStepper = '1';

        const wizard = new Wizard(form);

        let timer = null;
        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(() => wizard.refresh(), 180);
        };

        /* `attributeFilter` celowo pomija `data-*`: bez tego wlasne znaczniki
           (data-m-step / data-m-hidden / data-m-empty) wywolywalyby obserwatora
           w kolko. `style` jest obserwowany, bo to nim silnik pokazuje i chowa
           wiersze, a `class` - bo tak oznaczane sa bledy walidacji. */
        new MutationObserver(schedule).observe(form, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });

        window.addEventListener('resize', schedule, { passive: true });
        wizard.refresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
