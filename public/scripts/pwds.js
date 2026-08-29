(function () {
    var searchInput = document.getElementById('pwd-search');
    var countEl = document.getElementById('pwd-count');
    var recentOnlyCheckbox = document.getElementById('pwd-recent-only');
    var sortGroup = document.getElementById('pwd-sort-group');
    var tbody = document.getElementById('pwd-tbody');
    var currentSort = 'alpha';

    function getRows() {
        return tbody ? Array.prototype.slice.call(tbody.querySelectorAll('.pwd-row')) : [];
    }

    function sortRows(rows) {
        rows.sort(function (a, b) {
            if (currentSort === 'recent') {
                var ai = parseInt(a.getAttribute('data-recent-index'), 10);
                var bi = parseInt(b.getAttribute('data-recent-index'), 10);
                if (ai === -1) ai = Number.MAX_SAFE_INTEGER;
                if (bi === -1) bi = Number.MAX_SAFE_INTEGER;
                if (ai !== bi) return ai - bi;
            }
            var aIdent = a.querySelector('.pwd-ident').textContent.trim().toLowerCase();
            var bIdent = b.querySelector('.pwd-ident').textContent.trim().toLowerCase();
            return aIdent.localeCompare(bIdent);
        });
        return rows;
    }

    function applyFilterAndSort() {
        var q = searchInput ? searchInput.value.toLowerCase().trim() : '';
        var recentOnly = recentOnlyCheckbox && recentOnlyCheckbox.checked;
        var rows = sortRows(getRows());

        rows.forEach(function (row) {
            tbody.appendChild(row);
        });

        var visibleCount = 0;
        var idx = 0;
        rows.forEach(function (row) {
            var ident = row.querySelector('.pwd-ident').textContent.toLowerCase();
            var isRecent = row.getAttribute('data-recent-index') !== '-1';
            var matchesSearch = ident.includes(q);
            var matchesRecent = !recentOnly || isRecent;
            var visible = matchesSearch && matchesRecent;
            row.style.display = visible ? '' : 'none';
            if (visible) {
                idx++;
                var indexCell = row.querySelector('.pwd-index');
                if (indexCell) indexCell.textContent = idx;
                visibleCount++;
            }
        });

        if (countEl) countEl.textContent = visibleCount + ' / ' + rows.length;
    }

    if (searchInput) {
        searchInput.addEventListener('input', applyFilterAndSort);
    }

    if (recentOnlyCheckbox) {
        recentOnlyCheckbox.addEventListener('change', applyFilterAndSort);
    }

    if (sortGroup) {
        sortGroup.querySelectorAll('button[data-sort]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                currentSort = this.getAttribute('data-sort');
                sortGroup.querySelectorAll('button[data-sort]').forEach(function (b) {
                    b.classList.remove('active');
                });
                this.classList.add('active');
                applyFilterAndSort();
            });
        });
    }

    applyFilterAndSort();

    document.querySelectorAll('.pwd-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var td = this.closest('td');
            var span = td.querySelector('.pwd-value');
            var hidden = td.querySelector('.pwd-hidden');
            var revealed = span.getAttribute('data-revealed') === 'true';
            if (revealed) {
                span.textContent = '••••••••';
                span.setAttribute('data-revealed', 'false');
                this.textContent = window.t('pwds.show') || 'Pokaż';
            } else {
                span.textContent = hidden.value;
                span.setAttribute('data-revealed', 'true');
                this.textContent = window.t('pwds.hide') || 'Ukryj';
            }
        });
    });

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

    function copyToClipboard(text) {
        var msg = window.t('pwds.copied') || 'Skopiowano do schowka';
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                if (typeof toastr !== 'undefined') toastr.success(msg);
            }).catch(function () {
                fallbackCopy(text);
                if (typeof toastr !== 'undefined') toastr.success(msg);
            });
        } else {
            fallbackCopy(text);
            if (typeof toastr !== 'undefined') toastr.success(msg);
        }
    }

    document.querySelectorAll('.copy-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var td = this.closest('td');
            var type = this.getAttribute('data-copy');
            var text;
            if (type === 'pin') {
                text = td.querySelector('.pwd-pin').textContent.trim();
            } else {
                text = td.querySelector('.pwd-hidden').value;
            }
            copyToClipboard(text);
        });
    });
})();
