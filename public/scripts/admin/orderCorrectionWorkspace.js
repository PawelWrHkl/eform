/**
 * Korekta wysłanego zlecenia — przeglądarka.
 *  • `.open-order-correction-btn` (podgląd wysłanego, partials/order_cancellation.njk)
 *    → POST /orders/correction/:id/open → edycja zlecenia,
 *  • `#submit-correction-btn` / `#abort-correction-btn` (order.njk w korekcie
 *    i moduł admina admin/order_corrections/workspace.njk) → `${correctionApiBase}/submit|cancel`.
 * O dostępie (rola, produkcja < 20%) decyduje serwer.
 */
import { showToast } from '../components/toast.js';
import { confirmPrompt } from '../components/confirmPrompt.js';

const submitBtn = document.getElementById('submit-correction-btn');
const abortBtn = document.getElementById('abort-correction-btn');

async function translationsLoaded() {
    try {
        if (window.translationsReady) await window.translationsReady;
    } catch (_) { /* brak tłumaczeń = klucze zamiast tekstu */ }
}

function getPrices() {
    const prices = { hiddenPrices: [], visiblePrices: [] };
    document.querySelectorAll('.total-hidden').forEach((el) => {
        const text = el.innerText?.trim();
        if (text) prices.hiddenPrices.push(text);
    });
    document.querySelectorAll('.total').forEach((el) => {
        const text = el.innerText?.trim();
        if (text) prices.visiblePrices.push(text);
    });
    return prices;
}

/** POST JSON; sukces → komunikat i przejście pod `redirect`, błąd → wyjątek z komunikatem serwera. */
async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'same-origin',
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.message || t('order_correction.error_server'));
    return data;
}

async function run(buttons, confirmOptions, action) {
    await translationsLoaded();
    if (!(await confirmPrompt(confirmOptions))) return;
    buttons.forEach((b) => { if (b) b.disabled = true; });
    try {
        const data = await action();
        if (data.message) showToast('success', data.message);
        setTimeout(() => { window.location.href = data.redirect || window.location.pathname; }, 900);
    } catch (err) {
        showToast('error', err.message || t('order_correction.error_server'), 6);
        buttons.forEach((b) => { if (b) b.disabled = false; });
    }
}

const apiBase = (orderId) => window.correctionApiBase || `/admin/order-corrections/${orderId}`;

document.querySelectorAll('.open-order-correction-btn').forEach((btn) => {
    btn.addEventListener('click', () => run([btn], {
        title: t('order_correction.open_title'),
        message: t('order_correction.open_message'),
        confirmLabel: t('order_correction.open_confirm'),
        cancelLabel: t('order_correction.back'),
        confirmClass: 'btn btn-warning'
    }, () => post(`/orders/correction/${encodeURIComponent(btn.dataset.id)}/open`)));
});

if (submitBtn) {
    submitBtn.addEventListener('click', () => run([submitBtn, abortBtn], {
        title: t('order_correction.submit_title'),
        message: t('order_correction.submit_message'),
        confirmLabel: t('order_correction.submit'),
        cancelLabel: t('order_correction.back'),
        confirmClass: 'btn btn-warning'
    }, () => post(`${apiBase(submitBtn.dataset.id)}/submit`, { prices: getPrices() })));
}

if (abortBtn) {
    abortBtn.addEventListener('click', () => run([abortBtn, submitBtn], {
        title: t('order_correction.abort_title'),
        message: t('order_correction.abort_message'),
        confirmLabel: t('order_correction.abort'),
        cancelLabel: t('order_correction.back'),
        confirmClass: 'btn btn-danger'
    }, () => post(`${apiBase(abortBtn.dataset.id)}/cancel`)));
}
