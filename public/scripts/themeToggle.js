(function () {
    const STORAGE_KEY = 'eform-theme';

    function getPreferredTheme() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return stored;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(STORAGE_KEY, theme);

        const sunIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
        const moonIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
        const smallSunIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
        const smallMoonIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

        const toggle = document.getElementById('theme-toggle');
        if (toggle && toggle.getAttribute('role') === 'switch') {
            // Pozycja menu konta (base.njk): etykieta i suwak są w szablonie.
            toggle.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
        } else if (toggle) {
            toggle.innerHTML = theme === 'dark' ? sunIcon : moonIcon;
            toggle.setAttribute('aria-label', theme === 'dark' ? 'Przełącz na tryb jasny' : 'Przełącz na tryb ciemny');
        }

        const loginToggle = document.getElementById('theme-toggle-login');
        if (loginToggle) {
            loginToggle.innerHTML = theme === 'dark' ? smallSunIcon : smallMoonIcon;
            loginToggle.setAttribute('aria-label', theme === 'dark' ? 'Przełącz na tryb jasny' : 'Przełącz na tryb ciemny');
        }
    }

    // Natychmiast ustaw motyw przed renderowaniem (zapobiega flashowi)
    applyTheme(getPreferredTheme());

    document.addEventListener('DOMContentLoaded', function () {
        // Przełącznik siedzi w menu konta (base.njk); bez menu (np. strona
        // logowania) tworzymy okrągły przycisk przed flagami języków.
        let btn = document.getElementById('theme-toggle');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'theme-toggle';
            btn.className = 'theme-toggle';
            btn.type = 'button';
            btn.setAttribute('aria-label', 'Przełącz motyw');

            const langHeader = document.querySelector('.languages');
            const langSwitcher = document.querySelector('.language-switcher');
            if (langHeader && langSwitcher) {
                langHeader.insertBefore(btn, langSwitcher);
            } else {
                document.body.appendChild(btn);
            }
        }

        // Ustaw ikonę
        applyTheme(getPreferredTheme());

        btn.addEventListener('click', function () {
            const current = document.documentElement.getAttribute('data-theme') || 'light';
            const next = current === 'dark' ? 'light' : 'dark';
            applyTheme(next);
        });

        // Login page toggle button (already in HTML)
        const loginToggle = document.getElementById('theme-toggle-login');
        if (loginToggle) {
            applyTheme(getPreferredTheme());
            loginToggle.addEventListener('click', function () {
                const current = document.documentElement.getAttribute('data-theme') || 'light';
                const next = current === 'dark' ? 'light' : 'dark';
                applyTheme(next);
            });
        }

        // Reaguj na zmianę preferencji systemowych
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
            if (!localStorage.getItem(STORAGE_KEY)) {
                applyTheme(e.matches ? 'dark' : 'light');
            }
        });

    });
})();
