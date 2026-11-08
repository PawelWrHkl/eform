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

        // Dostęp biura — tylko dla roli „Biuro" (staff).
        formBiura.hidden = u.role !== 'staff';
        if (!formBiura.hidden) wczytajDostepBiura(u.id);

        pusty.hidden = true;
        edytor.hidden = false;
    }

    /* --- Konta biura (rola staff) ------------------------------------- */

    var formBiura = document.getElementById('ua-staff-access-form');
    var organizacjeBiura = document.getElementById('ua-staff-orgs');
    var bladBiura = document.getElementById('ua-staff-access-error');
    var formNowegoBiura = document.getElementById('ua-new-staff-form');

    function tr(klucz) {
        var tekst = typeof window.t === 'function' ? window.t(klucz) : '';
        return tekst || klucz;
    }

    function el(tag, klasa, tekst) {
        var node = document.createElement(tag);
        if (klasa) node.className = klasa;
        if (tekst != null) node.textContent = tekst;
        return node;
    }

    async function wczytajDostepBiura(id) {
        organizacjeBiura.innerHTML = '';
        bladBiura.hidden = true;
        try {
            var resp = await fetch('/admin/api/users/' + encodeURIComponent(id) + '/staff-access');
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || tr('staff.admin.error_server'));
            (dane.organizations || []).forEach(function (org) {
                organizacjeBiura.appendChild(budujOrganizacje(org, (dane.access || {})[org.id]));
            });
        } catch (e) {
            bladBiura.textContent = e.message || tr('staff.admin.error_server');
            bladBiura.hidden = false;
        }
    }

    function budujOrganizacje(org, zapis) {
        var box = el('fieldset', 'ua-staff-org');
        box.dataset.org = org.id;
        box._wybrani = new Set(zapis ? zapis.clientIds : []);
        box._zaladowani = false;

        var naglowek = el('label', 'ua-staff-org__head');
        var zaznacz = el('input', 'ua-staff-org__check');
        zaznacz.type = 'checkbox';
        zaznacz.checked = !!zapis;
        var licznik = el('span', 'ua-staff-org__count');
        naglowek.append(zaznacz, el('strong', null, org.ident), el('span', 'ua-result__meta', org.name || ''), licznik);

        var cialo = el('div', 'ua-staff-org__body');
        cialo.hidden = !zapis;

        var wszyscyEtykieta = el('label', 'ua-staff-future');
        var wszyscy = el('input');
        wszyscy.type = 'checkbox';
        wszyscy.checked = !!(zapis && zapis.allClients);
        wszyscyEtykieta.append(wszyscy, document.createTextNode(' ' + tr('staff.admin.all_and_future')));

        var narzedzia = el('div', 'ua-staff-tools');
        var filtr = el('input', 'ua-input');
        filtr.type = 'search';
        filtr.placeholder = tr('staff.admin.filter_placeholder');
        var wszystkich = el('button', 'btn btn-outline-secondary btn-sm', tr('staff.admin.select_all'));
        wszystkich.type = 'button';
        var nikogo = el('button', 'btn btn-outline-secondary btn-sm', tr('staff.admin.select_none'));
        nikogo.type = 'button';
        narzedzia.append(filtr, wszystkich, nikogo);

        var lista = el('div', 'ua-staff-clients');
        cialo.append(wszyscyEtykieta, narzedzia, lista);
        box.append(naglowek, cialo);

        function odswiezLicznik() {
            if (!zaznacz.checked) { licznik.textContent = ''; return; }
            var ile = box._zaladowani ? lista.querySelectorAll('input:checked').length : box._wybrani.size;
            licznik.textContent = wszyscy.checked ? tr('staff.admin.count_all') : tr('staff.admin.count_selected') + ' ' + ile;
        }
        function odswiezBlokade() {
            narzedzia.hidden = wszyscy.checked;
            lista.classList.toggle('is-disabled', wszyscy.checked);
            Array.prototype.forEach.call(lista.querySelectorAll('input'), function (i) { i.disabled = wszyscy.checked; });
            odswiezLicznik();
        }

        zaznacz.addEventListener('change', function () {
            cialo.hidden = !zaznacz.checked;
            if (zaznacz.checked) zaladujKlientow(box, lista, odswiezBlokade);
            odswiezLicznik();
        });
        wszyscy.addEventListener('change', odswiezBlokade);
        lista.addEventListener('change', odswiezLicznik);
        filtr.addEventListener('input', function () {
            var fraza = filtr.value.trim().toLowerCase();
            Array.prototype.forEach.call(lista.children, function (wiersz) {
                wiersz.hidden = !!fraza && wiersz.textContent.toLowerCase().indexOf(fraza) === -1;
            });
        });
        function ustawWidocznych(stan) {
            Array.prototype.forEach.call(lista.children, function (wiersz) {
                if (!wiersz.hidden) wiersz.querySelector('input').checked = stan;
            });
            odswiezLicznik();
        }
        wszystkich.addEventListener('click', function () { ustawWidocznych(true); });
        nikogo.addEventListener('click', function () { ustawWidocznych(false); });

        if (zapis) zaladujKlientow(box, lista, odswiezBlokade);
        odswiezBlokade();
        return box;
    }

    async function zaladujKlientow(box, lista, poZaladowaniu) {
        if (box._zaladowani || box._laduje) return;
        box._laduje = true;
        try {
            var resp = await fetch('/admin/api/organizations/' + encodeURIComponent(box.dataset.org) + '/clients');
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || tr('staff.admin.error_server'));
            (dane.clients || []).forEach(function (k) {
                var wiersz = el('label', 'ua-staff-client');
                var check = el('input');
                check.type = 'checkbox';
                check.value = k.id;
                check.checked = box._wybrani.has(k.id);
                var opis = [k.client_name, k.ident, 'PIN ' + k.pin, k.city].filter(Boolean).join(' · ');
                if (k.role === 'group') opis += ' · ' + tr('staff.admin.group_badge');
                wiersz.append(check, document.createTextNode(' ' + opis));
                lista.appendChild(wiersz);
            });
            box._zaladowani = true;
        } catch (e) {
            powiadom('error', e.message || tr('staff.admin.error_server'));
        } finally {
            box._laduje = false;
            poZaladowaniu();
        }
    }

    function zbierzDostepBiura() {
        var organizacje = [];
        Array.prototype.forEach.call(organizacjeBiura.querySelectorAll('.ua-staff-org'), function (box) {
            if (!box.querySelector('.ua-staff-org__check').checked) return;
            var wszyscy = box.querySelector('.ua-staff-future input').checked;
            var ids = wszyscy ? [] : (box._zaladowani
                ? Array.prototype.map.call(box.querySelectorAll('.ua-staff-clients input:checked'), function (i) { return Number(i.value); })
                : Array.from(box._wybrani));
            organizacje.push({ id: Number(box.dataset.org), allClients: wszyscy, clientIds: ids });
        });
        return { organizations: organizacje };
    }

    formBiura.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!wybrany) return;
        var btn = document.getElementById('ua-save-staff-access');
        btn.disabled = true;
        try {
            var resp = await fetch('/admin/api/users/' + wybrany.id + '/staff-access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(zbierzDostepBiura())
            });
            var dane = await resp.json();
            if (!dane.success) throw new Error(dane.message || tr('staff.admin.error_server'));
            powiadom('success', tr('staff.admin.access_saved'));
            wczytajDostepBiura(wybrany.id);
        } catch (e2) {
            powiadom('error', e2.message || tr('staff.admin.error_server'));
        } finally {
            btn.disabled = false;
        }
    });

    formNowegoBiura.addEventListener('submit', async function (e) {
        e.preventDefault();
        var dane = Object.fromEntries(new FormData(formNowegoBiura).entries());
        var btn = formNowegoBiura.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            var resp = await fetch('/admin/api/staff-accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dane)
            });
            var wynik = await resp.json();
            if (!wynik.success) throw new Error(wynik.message || tr('staff.admin.error_server'));
            formNowegoBiura.reset();
            powiadom('success', tr('staff.admin.new_created'));
            wybrany = wynik.user;
            wypelnij(wybrany);
        } catch (e2) {
            powiadom('error', e2.message || tr('staff.admin.error_server'));
        } finally {
            btn.disabled = false;
        }
    });

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
