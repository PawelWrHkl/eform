(function () {
    var searchInput = document.getElementById('pwd-search');
    var countEl = document.getElementById('pwd-count');
    var recentOnlyCheckbox = document.getElementById('pwd-recent-only');
    var sortGroup = document.getElementById('pwd-sort-group');
    var tbody = document.getElementById('pwd-tbody');
    var mobileList = document.getElementById('pwd-mobile-list');
    var paginationContainer = document.getElementById('pwd-pagination-container');
    var emptyEl = document.getElementById('pwd-empty');

    var state = { q: '', sort: 'alpha', recentOnly: false, page: 1 };
    var currentAbortController = null;

    // Tabela haseł liczy tysiące rekordów - reder wszystkiego naraz w DOM
    // zabijał wydajność strony. Zamiast tego serwer zwraca jedną stronę
    // wyników (patrz routes/users.js: GET /user/org-pwd/search), a ten skrypt
    // podmienia tylko zawartość kontenerów.
    function fetchAndRender() {
        if (currentAbortController) currentAbortController.abort();
        currentAbortController = new AbortController();

        var params = new URLSearchParams({
            q: state.q,
            sort: state.sort,
            recentOnly: state.recentOnly ? '1' : '0',
            page: state.page,
        });

        fetch('/user/org-pwd/search?' + params.toString(), { signal: currentAbortController.signal })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (tbody) tbody.innerHTML = data.rowsHtml;
                if (mobileList) mobileList.innerHTML = data.cardsHtml;
                if (paginationContainer) paginationContainer.innerHTML = data.paginationHtml;
                if (emptyEl) emptyEl.hidden = !data.isEmpty;
                if (countEl) countEl.textContent = data.pageCount + ' / ' + data.total;
            })
            .catch(function (err) {
                if (err.name !== 'AbortError') {
                    if (typeof toastr !== 'undefined') toastr.error('Błąd wczytywania listy');
                }
            });
    }

    function debounce(fn, delay) {
        var timer = null;
        return function () {
            clearTimeout(timer);
            timer = setTimeout(fn, delay);
        };
    }

    var debouncedFetch = debounce(function () {
        state.page = 1;
        fetchAndRender();
    }, 250);

    if (searchInput) {
        searchInput.addEventListener('input', function () {
            state.q = searchInput.value.trim();
            debouncedFetch();
        });
    }

    if (recentOnlyCheckbox) {
        recentOnlyCheckbox.addEventListener('change', function () {
            state.recentOnly = recentOnlyCheckbox.checked;
            state.page = 1;
            fetchAndRender();
        });
    }

    if (sortGroup) {
        sortGroup.querySelectorAll('button[data-sort]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.sort = this.getAttribute('data-sort');
                state.page = 1;
                sortGroup.querySelectorAll('button[data-sort]').forEach(function (b) {
                    b.classList.remove('active');
                });
                this.classList.add('active');
                fetchAndRender();
            });
        });
    }

    if (paginationContainer) {
        paginationContainer.addEventListener('click', function (e) {
            var btn = e.target.closest('.pwd-page-btn');
            if (!btn || btn.disabled) return;
            var page = parseInt(btn.getAttribute('data-page'), 10);
            if (!page || page < 1) return;
            state.page = page;
            fetchAndRender();
            var listTop = tbody ? tbody.closest('.table-responsive') : null;
            (listTop || mobileList || document.body).scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    // Pierwsza strona jest już wyrenderowana przez serwer (SSR) - nie ma
    // potrzeby odpytywać /search zaraz po załadowaniu, dopiero przy pierwszej
    // interakcji użytkownika (szukanie, sortowanie, filtr, strona).

    // Poniższe obsługują pokaż/ukryj hasło i kopiowanie - przez delegację
    // zdarzeń na dokumencie, żeby działały też dla wierszy wstawionych przez
    // fetchAndRender() (bez potrzeby ponownego podpinania listenerów po
    // każdej wymianie zawartości).

    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }

    function markCopied(btn) {
        var textEl = btn.querySelector('.copy-btn-text');
        var originalText = textEl ? textEl.textContent : null;
        btn.classList.add('copied');
        if (textEl) textEl.textContent = window.t('pwds.copied_short') || 'Skopiowano';
        setTimeout(function () {
            btn.classList.remove('copied');
            if (textEl && originalText !== null) textEl.textContent = originalText;
        }, 1400);
    }

    function copyToClipboard(text, btn) {
        var msg = window.t('pwds.copied') || 'Skopiowano do schowka';
        var onDone = function () {
            if (typeof toastr !== 'undefined') toastr.success(msg);
            if (btn) markCopied(btn);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onDone).catch(function () {
                fallbackCopy(text);
                onDone();
            });
        } else {
            fallbackCopy(text);
            onDone();
        }
    }

    document.addEventListener('click', function (e) {
        var toggleBtn = e.target.closest('.pwd-toggle-btn');
        if (toggleBtn) {
            var field = toggleBtn.closest('.pwd-field');
            var span = field.querySelector('.pwd-value');
            var hidden = field.querySelector('.pwd-hidden');
            var revealed = span.getAttribute('data-revealed') === 'true';
            var isIconBtn = toggleBtn.classList.contains('pwd-icon-btn');
            if (revealed) {
                span.textContent = '••••••••';
                span.setAttribute('data-revealed', 'false');
                toggleBtn.classList.remove('revealed');
                toggleBtn.setAttribute('aria-label', 'Pokaż hasło');
                if (!isIconBtn) toggleBtn.textContent = window.t('pwds.show') || 'Pokaż';
            } else {
                span.textContent = hidden.value;
                span.setAttribute('data-revealed', 'true');
                toggleBtn.classList.add('revealed');
                toggleBtn.setAttribute('aria-label', 'Ukryj hasło');
                if (!isIconBtn) toggleBtn.textContent = window.t('pwds.hide') || 'Ukryj';
            }
            return;
        }

        var copyAllBtn = e.target.closest('.copy-all-btn');
        if (copyAllBtn) {
            var row = copyAllBtn.closest('.pwd-row');
            var pin = row.querySelector('.pwd-pin').textContent.trim();
            var password = row.querySelector('.pwd-hidden').value;
            copyToClipboard('Login: ' + pin + '\nHasło: ' + password, copyAllBtn);
            return;
        }

        var copyBtn = e.target.closest('.copy-btn');
        if (copyBtn) {
            var copyField = copyBtn.closest('.pwd-field');
            var type = copyBtn.getAttribute('data-copy');
            var text = type === 'pin'
                ? copyField.querySelector('.pwd-pin').textContent.trim()
                : copyField.querySelector('.pwd-hidden').value;
            copyToClipboard(text, copyBtn);
        }
    });
})();
