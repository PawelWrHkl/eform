/* =============================================================================
   MOBILE KREATOR KONFIGURATORA — E-orders (PRJ-06, telefon jak aplikacja)
   =============================================================================
   Konfigurator na telefonie podzielony na KROKI (Produkt, Kolor, Wymiary,
   Dodatki, Cena — wg nazw parametrow). Na ekranie:
     - naglowek kroku: tytul, „2 z 5”, pasek postepu (dotkniecie = skok),
     - pola aktywnego kroku,
     - na ostatnim kroku podsumowanie wyborow (dotkniecie wiersza = powrot),
     - pasek akcji przy kciuku: [Wstecz] [Dalej] / [Zapisz].
   „Zapisz” klika oryginalny #show-button — ten sam handler zapisu i walidacji.

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
   # formularza ani nie dotyka wartosci. Podsumowanie czyta tylko TEKST pol   #
   # spoza kroku z cenami — zadna cena nie jest kopiowana (maska liczenia).   #
   ###########################################################################
   ============================================================================= */

(function () {
    'use strict';

    const MQ = '(max-width: 767.98px)';
    const BREAKPOINT_OK = () => window.matchMedia(MQ).matches;
    const PRICE_STEP = 'preis';

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
        { id: PRICE_STEP, test: n => /^(SUB___|CENA|DOPLATA|SUMA|WARTOSC|RABAT|VAT|PODATEK)/.test(n) || /(_RABAT|_BRUTTO|_NETTO)$/.test(n) },
        { id: 'masse', test: n => /^(SZEROKOSC|WYSOKOSC|GLEBOKOSC|DLUGOSC|POW|WYMIAR|RAMAOKNA)/.test(n) || /(_SZER|_WYS|_MM|_MONTAZU)$/.test(n) },
        { id: 'farbe', test: n => /^(KOLOR|STOFF|FARBE|TASIEMKA|BUTKOLOR|PROFIL|BLENDA|RODZAJ_SIATKI|RODZAJ_TEXT)/.test(n) },
        { id: 'produkt', test: n => /^(ILOSC|MODEL|WARIANT|RODZAJ|ROZMIAR|SLOPE_TYPE|TYP)/.test(n) },
        { id: 'zusatz', test: () => true }
    ];

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        back: 'M15 5l-7 7 7 7',
        chevron: 'M9 5l7 7-7 7',
        check: 'M5 12.5l4.5 4.5L19 7.5'
    };

    function icon(name) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', 'm-ico m-ico--' + name);
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[name]);
        svg.appendChild(path);
        return svg;
    }

    // Wszystkie teksty z jezyki.xlsx (klucze form.step.*), bez slownika w kodzie.
    function tr(key, vars) {
        return typeof window.t === 'function' ? window.t('form.step.' + key, vars) : key;
    }

    function rules() {
        return Array.isArray(window.MOBILE_STEP_RULES) && window.MOBILE_STEP_RULES.length
            ? window.MOBILE_STEP_RULES
            : DEFAULT_RULES;
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
       nie zapisujemy. Pusty wiersz (ZALACZNIK_n - zawartosc idzie do zalacznikow
       przy zapisie) nie jest polem dla klienta. */
    function engineVisible(row) {
        return getComputedStyle(row).display !== 'none' && row.firstElementChild !== null;
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

    function labelOf(row) {
        const label = row.querySelector('.field-label-row label') || row.querySelector('label');
        return label ? label.textContent.replace(/\s+/g, ' ').trim() : '';
    }

    /* Tekst wartosci wiersza do podsumowania - dokladnie to, co klient widzi
       w polu (tekst przycisku, wybrana opcja, wpisana liczba). */
    function valueOf(row) {
        const btn = row.querySelector('button.button');
        if (btn) return btn.dataset.mEmpty === '1' ? '' : btn.textContent.replace(/\s+/g, ' ').trim();
        const select = row.querySelector('select');
        if (select) return select.selectedIndex >= 0 ? select.options[select.selectedIndex].text.trim() : '';
        const box = row.querySelector('input[type="checkbox"]');
        const input = row.querySelector('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"])');
        if (input) return input.value.trim() + (input.value.trim() && row.dataset.mUnit ? ' ' + row.dataset.mUnit : '');
        if (box) return box.checked ? true : '';
        return null;                                       // plik, link - bez wartosci
    }

    function controlOf(row) {
        return row.querySelector('button.button, select, input:not([type="hidden"]):not([type="file"]), textarea');
    }

    /* Jednostka z etykiety: „SZEROKOSC [MM]” -> „mm”, „POW.[M2]” -> „m²”. */
    function unitFromLabel(text) {
        const m = /\[\s*([A-Za-z0-9²]{1,4})\s*\]\s*$/.exec(text || '');
        if (!m) return '';
        return m[1].toLowerCase().replace(/^m2$/, 'm²').replace(/^cm2$/, 'cm²');
    }

    class Wizard {
        constructor(form) {
            this.form = form;
            this.steps = [];          // [{ id, rows: [] }] w kolejnosci z DOM
            this.signature = '';
            this.activeIndex = 0;
            this.reminder = form.parentNode.querySelector(':scope > h3');

            this.buildHead();
            this.buildSummary();
            this.buildBar();
            this.watchSave();
        }

        /** Tytul kroku + licznik + pasek postepu. Rodzenstwo #dynamic-form,
         *  wiec `form.innerHTML = ''` przy zmianie grupy go nie kasuje. */
        buildHead() {
            this.head = document.createElement('div');
            this.head.className = 'm-stephead';
            const row = document.createElement('div');
            row.className = 'm-stephead__row';
            this.title = document.createElement('h2');
            this.title.className = 'm-stephead__title';
            this.count = document.createElement('span');
            this.count.className = 'm-stephead__count';
            row.append(this.title, this.count);
            this.segments = document.createElement('ol');
            this.segments.className = 'm-stephead__bar';
            this.segments.setAttribute('aria-label', tr('nav'));
            this.head.append(row, this.segments);
            // Pod tytulem strony: krok 1 obejmuje tez nazwe, dzial i grupe.
            const pageTitle = document.querySelector('#commission-form .content > h1');
            if (pageTitle) pageTitle.after(this.head);
            else this.form.parentNode.insertBefore(this.head, this.form);
        }

        buildSummary() {
            this.summary = document.createElement('section');
            this.summary.className = 'm-summary';
            const title = document.createElement('h3');
            title.className = 'm-summary__title';
            title.id = 'm-summary-title';
            title.textContent = tr('summary');
            this.summary.setAttribute('aria-labelledby', title.id);
            this.summaryBody = document.createElement('div');
            this.summary.append(title, this.summaryBody);
            this.form.parentNode.insertBefore(this.summary, this.form);
        }

        /* ⚠️ Pasek idzie na <body>, a NIE obok #dynamic-form: `.content` i
           `.container` maja `animation: fadeInUp ... both` (theme.css), ktora
           zostawia `transform`, a element z transformem staje sie blokiem
           zawierajacym dla `position: fixed` (pasek ladowal w srodku dokumentu).
           Przyciski `type="button"` - formularz to <form>, domyslny <button>
           przeladowalby strone. */
        buildBar() {
            this.bar = document.createElement('div');
            this.bar.className = 'm-actionbar';
            this.bar.setAttribute('role', 'group');
            this.bar.setAttribute('aria-label', tr('nav'));

            this.backBtn = document.createElement('button');
            this.backBtn.type = 'button';
            this.backBtn.className = 'm-actionbar__btn m-actionbar__back';
            this.backBtn.append(icon('back'), document.createTextNode(tr('back')));
            this.backBtn.addEventListener('click', () => this.go(this.activeIndex - 1));

            this.nextBtn = document.createElement('button');
            this.nextBtn.type = 'button';
            this.nextBtn.className = 'm-actionbar__btn m-actionbar__next';
            this.nextBtn.textContent = tr('next');
            this.nextBtn.addEventListener('click', () => this.go(this.activeIndex + 1));

            this.saveBtn = document.createElement('button');
            this.saveBtn.type = 'button';
            this.saveBtn.className = 'm-actionbar__btn m-actionbar__save';
            this.saveBtn.addEventListener('click', () => {
                const original = document.getElementById('show-button');
                if (!original || original.disabled) return;
                this.revealUntil = Date.now() + 4000;  // walidacja oznacza pola po chwili
                original.click();
            });

            this.bar.append(this.backBtn, this.nextBtn, this.saveBtn);
            document.body.appendChild(this.bar);
        }

        /** Tekst i stan `disabled` przycisku zapisu - lustro #show-button
         *  (silnik wylacza go na czas przeliczania). */
        watchSave() {
            const original = document.getElementById('show-button');
            if (!original) return;
            const sync = () => {
                this.saveBtn.textContent = original.textContent.trim();
                this.saveBtn.disabled = original.disabled;
            };
            new MutationObserver(sync).observe(original, { attributes: true, attributeFilter: ['disabled'], childList: true, characterData: true, subtree: true });
            sync();
        }

        /** Przelicza kroki; przerysowuje naglowek tylko gdy zestaw sie zmienil. */
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
                // nie tworzy kroku i nie podtrzymuje istniejacego.
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
                this.renderSegments();
            }
            if (this.activeIndex >= this.steps.length) this.activeIndex = Math.max(this.steps.length - 1, 0);

            this.markRows(rows);
            this.apply(rows);
            // Tylko tuz po probie zapisu - inaczej czerwone pole na dalszym kroku
            // sciagaloby klienta z powrotem przy kazdym cofnieciu.
            if (Date.now() < (this.revealUntil || 0)) this.revealInvalid(rows);
        }

        renderSegments() {
            this.segments.innerHTML = '';
            this.steps.forEach((step, index) => {
                const item = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'm-stephead__seg';
                button.setAttribute('aria-label', `${index + 1}. ${tr(step.id)}`);
                button.addEventListener('click', () => this.go(index));
                item.appendChild(button);
                this.segments.appendChild(item);
            });
        }

        /** Chowa wszystko, co nie nalezy do aktywnego kroku. */
        apply(rows) {
            const on = this.steps.length > 1;          // jeden krok = brak sensu dzielenia
            const step = on ? this.steps[this.activeIndex] : null;
            const last = !on || this.activeIndex === this.steps.length - 1;

            rows.forEach(row => this.setHidden(row, on && row.dataset.mStep !== step.id));

            /* Wybor zlecenia / dzialu / grupy nalezy do pierwszego kroku.
               Nie da sie go schowac przez `display` (processCommissionInput
               ustawia `block !important`) - ta sama technika, co dla wierszy.
               Edycja pozycji (edit_position.njk) nie ma wyboru grupy - jej
               odpowiednikiem jest karta z nazwa pomieszczenia. */
            const asortment = document.querySelector('#commission-form .asortment-inputs')
                || document.querySelector('#commission-form .commission-space')?.closest('.container');
            if (asortment) this.setHidden(asortment, on && this.activeIndex > 0);

            // „Wartosci prosze uzupelniac zgodnie z kolejnoscia” - kolejnosc niesie kreator.
            if (this.reminder) this.setHidden(this.reminder, on);

            /* Komentarz, reset i zalaczniki - na ostatnim kroku; zapis jest w
               pasku akcji, wiec #show-button (dalej klikany przez pasek)
               znika z tresci. Pole komentarza (form.js buildCommentSpace -
               dziecko #dynamic-form, ale nie wiersz parametru) otwiera przycisk
               z #buttons-space, wiec idzie razem z nim. */
            const buttons = document.getElementById('buttons-space');
            if (buttons) this.setHidden(buttons, !last);
            const save = document.getElementById('show-button');
            if (save) this.setHidden(save, on);
            const comment = this.form.querySelector(':scope > .comment-space');
            if (comment) this.setHidden(comment, !last);

            this.head.hidden = !on;
            this.bar.hidden = !on;
            this.summary.hidden = !(on && last);
            document.body.classList.toggle('m-stepper-fixed', on);
            if (on) {
                this.title.textContent = tr(step.id);
                this.count.textContent = tr('counter', { n: this.activeIndex + 1, m: this.steps.length });
                Array.from(this.segments.children).forEach((item, index) => {
                    const button = item.firstChild;
                    button.classList.toggle('is-done', index < this.activeIndex);
                    button.classList.toggle('is-active', index === this.activeIndex);
                    if (index === this.activeIndex) button.setAttribute('aria-current', 'step');
                    else button.removeAttribute('aria-current');
                });
                this.backBtn.hidden = this.activeIndex === 0;
                this.nextBtn.hidden = last;
                this.saveBtn.hidden = !last;
                if (last) this.renderSummary();
            }
            this.publishHeight(on);
        }

        /** Na ostatnim kroku: co wybrano, pogrupowane po krokach. */
        renderSummary() {
            const body = document.createDocumentFragment();
            this.steps.forEach((step, index) => {
                if (index === this.steps.length - 1 || step.id === PRICE_STEP) return;
                const list = document.createElement('ul');
                list.className = 'm-summary__list';
                step.rows.forEach(row => {
                    const label = labelOf(row);
                    const value = valueOf(row);
                    if (!label || value === null) return;
                    const item = document.createElement('li');
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'm-summary__row';
                    const name = document.createElement('span');
                    name.className = 'm-summary__label';
                    name.textContent = label;
                    const val = document.createElement('span');
                    val.className = 'm-summary__value';
                    if (value === true) val.appendChild(icon('check'));
                    else val.textContent = value || '—';
                    if (!value) button.classList.add('is-empty');
                    button.append(name, val, icon('chevron'));
                    button.addEventListener('click', () => this.go(index, row));
                    item.appendChild(button);
                    list.appendChild(item);
                });
                if (!list.children.length) return;
                const group = document.createElement('div');
                group.className = 'm-summary__group';
                const heading = document.createElement('h4');
                heading.className = 'm-summary__step';
                heading.textContent = tr(step.id);
                group.append(heading, list);
                body.appendChild(group);
            });
            this.summaryBody.replaceChildren(body);
        }

        setHidden(el, hide) {
            if (hide) el.dataset.mHidden = '1';
            else delete el.dataset.mHidden;
        }

        go(index, row) {
            if (index < 0 || index >= this.steps.length) return;
            const changed = index !== this.activeIndex;
            this.activeIndex = index;
            this.refresh();

            if (changed) {
                this.form.classList.remove('m-step-enter');
                void this.form.offsetWidth;            // restart animacji wejscia
                this.form.classList.add('m-step-enter');
            }
            if (row) {
                row.scrollIntoView({ block: 'center' });
                const control = controlOf(row);
                if (control) control.focus({ preventScroll: true });
                return;
            }
            const scroller = scrollContainerOf(this.form);
            if (scroller) scroller.scrollTo({ top: 0 });
            else window.scrollTo({ top: 0 });
        }

        /** Walidacja zapisu (main.js `highlightInvalidFields`) dokłada polom
         *  klase `.invalid-input` i przewija do pierwszego z nich. Gdyby takie
         *  pole lezalo na innym kroku, uzytkownik zobaczylby pusty przeskok -
         *  wiec przechodzimy na krok, ktory je zawiera. */
        revealInvalid(rows) {
            if (this.steps.length < 2) return;
            const activeId = this.steps[this.activeIndex].id;
            if (rows.some(r => r.dataset.mStep === activeId && r.querySelector('.invalid-input'))) return;
            const row = rows.find(r => r.dataset.mStep !== activeId && r.dataset.mHidden === '1' && engineVisible(r) && r.querySelector('.invalid-input'));
            if (!row) return;
            const index = this.steps.findIndex(s => s.id === row.dataset.mStep);
            this.revealUntil = 0;
            if (index >= 0) this.go(index, row);
        }

        /** Wysokosc paska trafia do `--m-stepper-h`, z ktorej <main> liczy swoj
         *  `padding-bottom`, a asystent swoje polozenie (assistant.css). */
        publishHeight(visible) {
            const value = visible ? Math.round(this.bar.offsetHeight) + 'px' : '0px';
            document.documentElement.style.setProperty('--m-stepper-h', value);
        }

        /** Placeholder vs. wybrana wartosc (kolor tekstu), jednostka i klawiatura
         *  pol liczbowych - wylacznie atrybuty prezentacji. */
        markRows(rows) {
            const placeholder = typeof window.t === 'function' ? String(window.t('form.check_word') || '').trim() : '';
            rows.forEach(row => {
                row.querySelectorAll('button.button').forEach(btn => {
                    const text = (btn.textContent || '').trim();
                    const empty = text === '' || (placeholder !== '' && text === placeholder);
                    if (empty) btn.dataset.mEmpty = '1';
                    else delete btn.dataset.mEmpty;
                });
                const input = row.firstElementChild && row.firstElementChild.classList.contains('field-label-row')
                    ? row.querySelector(':scope > input[type="number"]') : null;
                if (!input) return;
                const unit = unitFromLabel(labelOf(row));
                if (unit) row.dataset.mUnit = unit;
                else delete row.dataset.mUnit;
                if (!input.hasAttribute('inputmode')) input.setAttribute('inputmode', input.step === '1' ? 'numeric' : 'decimal');
            });
        }
    }

    function boot() {
        if (!BREAKPOINT_OK()) return;

        const form = document.getElementById('dynamic-form');
        if (!form || !form.parentNode || form.dataset.mStepper === '1') return;
        form.dataset.mStepper = '1';

        // Komunikat przy polu slownikowym bez wyboru (CSS ::after) - istniejacy klucz.
        if (typeof window.t === 'function') {
            document.documentElement.style.setProperty('--m-t-required', JSON.stringify(String(window.t('form.obligo_field'))));
        }

        /* showModal() daje fokus pierwszemu polu okna kafelkow - wyszukiwarce,
           a na telefonie to wysuwa klawiature na pol ekranu. Fokus dostaje
           tytul okna (`autofocus` na samym <dialog> Chromium pomija);
           szukanie dalej jednym dotknieciem. */
        const tilesTitle = document.getElementById('dialog-title');
        if (tilesTitle) {
            tilesTitle.tabIndex = -1;
            tilesTitle.setAttribute('autofocus', '');
        }

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
        // Wpisanie wartosci (input.value) nie jest mutacja DOM - podsumowanie i tak
        // odswiezamy, gdy klient zmienia pola.
        form.addEventListener('change', schedule);

        window.addEventListener('resize', schedule, { passive: true });
        wizard.refresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
