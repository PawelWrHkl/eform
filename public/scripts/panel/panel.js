(function () {
    'use strict';

    document.querySelectorAll('.panel-eye-toggle').forEach((btn) => {
        const input = document.getElementById(btn.dataset.toggleFor);
        if (!input) return;
        btn.addEventListener('click', () => {
            input.type = input.type === 'password' ? 'text' : 'password';
        });
    });

    // Podpowiedź „hasła się zgadzają" na bieżąco — zapobiega błędowi zanim
    // user wyśle formularz (Nielsen: error prevention), serwer i tak
    // weryfikuje to samo jeszcze raz (routes/userPanel.js).
    const newPwd = document.getElementById('newPassword');
    const confirmPwd = document.getElementById('confirmPassword');
    const hint = document.getElementById('panel-match-hint');
    if (newPwd && confirmPwd && hint) {
        const checkMatch = () => {
            if (!confirmPwd.value) {
                hint.textContent = '';
                hint.className = 'panel-match-hint';
                return;
            }
            const match = newPwd.value === confirmPwd.value;
            hint.textContent = match ? '✓' : '✗';
            hint.className = 'panel-match-hint ' + (match ? 'ok' : 'bad');
        };
        newPwd.addEventListener('input', checkMatch);
        confirmPwd.addEventListener('input', checkMatch);
    }

    const passwordForm = document.getElementById('panel-password-form');
    passwordForm?.addEventListener('submit', () => {
        const btn = passwordForm.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
    });
}());
