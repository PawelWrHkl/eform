/*
 * Administracja użytkownikami (/admin/users).
 *
 * Wybór konta idzie przez wyszukiwanie, bo w tabeli `user` jest blisko 2000
 * wierszy — lista rozwijana z całą bazą byłaby nieużywalna.
 */
document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('home-page');

    var szukaj      = document.getElementById('ua-search');
    var wyniki      = document.getElementById('ua-results');
    var pusty       = document.getElementById('ua-empty');
    var edytor      = document.getElementById('ua-editor');
    var formUstawien = document.getElementById('ua-settings-form');
    var formHasla   = document.getElementById('ua-password-form');
    var formWyceny  = document.getElementById('ua-price-mode-form');
    var formFakturowania = document.getElementById('ua-invoice-schedule-form');
    var formWaluty  = document.getElementById('ua-currency-form');

    /** Ostatnio wczytany użytkownik — źródło prawdy dla „przywróć wartości". */
    var wybrany = null;

    function powiadom(typ, tekst) {
        if (window.toastr && typeof toastr[typ] === 'function') toastr[typ](tekst);
        else alert(tekst);
    }

    /* --- Wyszukiwanie ------------------------------------------------ */

    var timer = null;
    szukaj.addEventListener('input', function () {
        clearTimeout(timer);
        var fraza = szukaj.value.trim();
        if (fraza.length < 2) {
            wyniki.hidden = true;
            wyniki.innerHTML = '';
            return;
        }
        // Debounce: przy pisaniu „Gordijn" nie chcemy siedmiu zapytań do bazy.
        timer = setTimeout(function () { pobierzWyniki(fraza); }, 250);
    });

    async function pobierzWyniki(fraza) {
        try {
            var resp = await fetch('/admin/api/users/search?q=' + encodeURIComponent(fraza));
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || 'Błąd wyszukiwania');
            pokazWyniki(dane.users || []);
        } catch (e) {
            powiadom('error', e.message || 'Nie udało się wyszukać użytkowników');
        }
    }

    function pokazWyniki(users) {
        wyniki.innerHTML = '';
        if (!users.length) {
            wyniki.innerHTML = '<div class="ua-result"><span class="ua-result__meta">Brak dopasowań</span></div>';
            wyniki.hidden = false;
            return;
        }

        users.forEach(function (u) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ua-result';
            btn.dataset.id = u.id;

            var lewa = document.createElement('span');
            var ident = document.createElement('span');
            ident.className = 'ua-result__ident';
            ident.textContent = u.ident || ('id ' + u.id);
            var meta = document.createElement('span');
            meta.className = 'ua-result__meta';
            meta.textContent = [u.client_name, u.pin, u.email].filter(Boolean).join(' · ');
            lewa.appendChild(ident);
            lewa.appendChild(document.createElement('br'));
            lewa.appendChild(meta);

            var prawa = document.createElement('span');
            prawa.className = 'ua-result__meta';
            prawa.textContent = u.role ? u.role : 'klient';

            btn.appendChild(lewa);
            btn.appendChild(prawa);
            btn.addEventListener('click', function () {
                Array.prototype.forEach.call(wyniki.querySelectorAll('.ua-result'), function (el) {
                    el.classList.remove('is-active');
                });
                btn.classList.add('is-active');
                wczytaj(u.id);
            });

            wyniki.appendChild(btn);
        });
        wyniki.hidden = false;
    }

    /* --- Wczytanie i wypełnienie formularza --------------------------- */

    async function wczytaj(id) {
        try {
            var resp = await fetch('/admin/api/users/' + encodeURIComponent(id));
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || 'Nie udało się pobrać użytkownika');
            wybrany = dane.user;
            wypelnij(wybrany);
        } catch (e) {
            powiadom('error', e.message || 'Nie udało się pobrać użytkownika');
        }
    }

    function wypelnij(u) {
        document.getElementById('ua-user-ident').textContent = u.ident || ('id ' + u.id);
        document.getElementById('ua-user-meta').textContent =
            [u.client_name, 'PIN: ' + u.pin, u.phone].filter(Boolean).join(' · ');
        document.getElementById('ua-user-org').textContent = u.organization_ident || 'brak organizacji';

        document.getElementById('ua-role').value = u.role || '';
        document.getElementById('ua-email').value = u.email || '';
        // `ab_type` z bazy to `without_price`; wariant `without_prices` też jest
        // akceptowany przy odczycie, więc mapujemy oba na jedną opcję listy.
        document.getElementById('ua-ab-type').value = u.ab_type ? 'without_price' : '';
        // W bazie język żyje wielkimi literami ("NL"), opcje są małymi.
        document.getElementById('ua-ab-lang').value = u.ab_lang ? String(u.ab_lang).toLowerCase() : '';
        document.getElementById('ua-delivery-delay').value =
            (u.delivery_delay === null || u.delivery_delay === undefined) ? '' : u.delivery_delay;
        document.getElementById('ua-intro-needed').checked = Number(u.intro_needed) === 1;
        document.getElementById('ua-client-ab').checked = Number(u.client_ab) === 1;

        // Wycena klientów grupy ma sens tylko dla konta grupy. `group_type`
        // pokazujemy jako ostrzeżenie, a nie blokadę: admin może ustawić tryb,
        // zanim przełączy grupę na typ `client`.
        formWyceny.hidden = u.role !== 'group';
        document.getElementById('ua-price-mode-type-warn').hidden =
            String(u.group_type || '').trim().toLowerCase() === 'client';
        var tryb = u.group_price_mode === 'markup' ? 'markup' : 'discount';
        Array.prototype.forEach.call(formWyceny.querySelectorAll('input[name="group_price_mode"]'), function (el) {
            el.checked = el.value === tryb;
        });

        // Fakturowanie niestandardowe — puste = standard (faktura za każde zlecenie)
        var harmonogram = u.invoice_schedule === 'weekly' || u.invoice_schedule === 'monthly' ? u.invoice_schedule : '';
        Array.prototype.forEach.call(formFakturowania.querySelectorAll('input[name="invoice_schedule"]'), function (el) {
            el.checked = el.value === harmonogram;
        });

        // Waluta cen — `currency_setting` z services/currency.js. Pusta opcja
        // = jak organizacja; jej podpis mówi, co to dziś znaczy.
        var waluta = u.currency_setting || { available: false };
        var dostepna = waluta.available === true;
        document.getElementById('ua-currency-missing').hidden = dostepna;
        document.getElementById('ua-currency').disabled = !dostepna;
        document.getElementById('ua-save-currency').disabled = !dostepna;
        document.getElementById('ua-currency-inherit').textContent =
            'Jak organizacja (' + (waluta.organization || 'EUR') + ')';
        document.getElementById('ua-currency').value = waluta.user || '';
        document.getElementById('ua-currency-effective').textContent =
            dostepna ? 'Obowiązuje teraz: ' + (waluta.effective || 'EUR') : '';

        document.getElementById('ua-password').value = '';
        document.getElementById('ua-password2').value = '';

        pusty.hidden = true;
        edytor.hidden = false;
    }

    document.getElementById('ua-reset-settings').addEventListener('click', function () {
        if (wybrany) wypelnij(wybrany);
    });

    /* --- Zapis ustawień ---------------------------------------------- */

    formUstawien.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!wybrany) return;

        var btn = document.getElementById('ua-save-settings');
        btn.disabled = true;
        try {
            var resp = await fetch('/admin/api/users/' + wybrany.id + '/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role: document.getElementById('ua-role').value,
                    email: document.getElementById('ua-email').value,
                    ab_type: document.getElementById('ua-ab-type').value,
                    ab_lang: document.getElementById('ua-ab-lang').value,
                    delivery_delay: document.getElementById('ua-delivery-delay').value,
                    intro_needed: document.getElementById('ua-intro-needed').checked,
                    client_ab: document.getElementById('ua-client-ab').checked
                })
            });
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || 'Zapis nie powiódł się');
            // Odświeżamy z odpowiedzi serwera, nie z pól — widać wtedy, co
            // faktycznie wylądowało w bazie po normalizacji.
            wybrany = dane.user;
            wypelnij(wybrany);
            powiadom('success', 'Ustawienia zapisane');
        } catch (e2) {
            powiadom('error', e2.message || 'Zapis nie powiódł się');
        } finally {
            btn.disabled = false;
        }
    });

    /* --- Tryb wyceny klientów grupy ---------------------------------- */

    formWyceny.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!wybrany) return;

        var zaznaczony = formWyceny.querySelector('input[name="group_price_mode"]:checked');
        if (!zaznaczony) return;

        var btn = document.getElementById('ua-save-price-mode');
        btn.disabled = true;
        try {
            var resp = await fetch('/admin/api/users/' + wybrany.id + '/group-price-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: zaznaczony.value })
            });
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || 'Zapis nie powiódł się');
            wybrany = dane.user;
            wypelnij(wybrany);
            powiadom('success', 'Tryb wyceny zapisany');
        } catch (e2) {
            powiadom('error', e2.message || 'Zapis nie powiódł się');
        } finally {
            btn.disabled = false;
        }
    });

    /* --- Fakturowanie niestandardowe ---------------------------------- */

    formFakturowania.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!wybrany) return;

        var zaznaczony = formFakturowania.querySelector('input[name="invoice_schedule"]:checked');
        if (!zaznaczony) return;

        var btn = document.getElementById('ua-save-invoice-schedule');
        btn.disabled = true;
        try {
            var resp = await fetch('/admin/api/users/' + wybrany.id + '/invoice-schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schedule: zaznaczony.value })
            });
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || 'Zapis nie powiódł się');
            wybrany = dane.user;
            wypelnij(wybrany);
            powiadom('success', 'Sposób fakturowania zapisany');
        } catch (e2) {
            powiadom('error', e2.message || 'Zapis nie powiódł się');
        } finally {
            btn.disabled = false;
        }
    });

    /* --- Waluta cen -------------------------------------------------- */

    formWaluty.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!wybrany) return;

        var btn = document.getElementById('ua-save-currency');
        btn.disabled = true;
        try {
            var resp = await fetch('/admin/api/users/' + wybrany.id + '/currency', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currency: document.getElementById('ua-currency').value })
            });
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || 'Zapis nie powiódł się');
            wybrany = dane.user;
            wypelnij(wybrany);
            powiadom('success', 'Waluta zapisana');
        } catch (e2) {
            powiadom('error', e2.message || 'Zapis nie powiódł się');
        } finally {
            // Przed migracją przycisk zostaje wyłączony (patrz wypelnij).
            btn.disabled = !(wybrany && wybrany.currency_setting && wybrany.currency_setting.available);
        }
    });

    /* --- Zmiana hasła ------------------------------------------------ */

    formHasla.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!wybrany) return;

        var haslo = document.getElementById('ua-password').value;
        var haslo2 = document.getElementById('ua-password2').value;
        var ident = wybrany.ident || ('id ' + wybrany.id);
        if (!confirm('Ustawić nowe hasło dla konta ' + ident + '? Dotychczasowe przestanie działać.')) return;

        var btn = document.getElementById('ua-save-password');
        btn.disabled = true;
        try {
            var resp = await fetch('/admin/api/users/' + wybrany.id + '/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: haslo, password2: haslo2 })
            });
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || 'Zmiana hasła nie powiodła się');
            document.getElementById('ua-password').value = '';
            document.getElementById('ua-password2').value = '';
            powiadom('success', dane.message || 'Hasło zmienione');
        } catch (e2) {
            powiadom('error', e2.message || 'Zmiana hasła nie powiodła się');
        } finally {
            btn.disabled = false;
        }
    });
});
