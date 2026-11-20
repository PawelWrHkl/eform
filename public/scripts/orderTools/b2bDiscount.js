// Okno „Rabat B2B dla klienta” (services/b2bDiscount.js) — osobny przycisk
// `#b2b-discount-btn` w pasku zlecenia po kłódce (templates/order_prices.njk),
// tylko dla organizacji klienta i admina. Rabat B2C (Centrum rabatów) to osobne okno.
import { showToast } from "../components/toast.js";
import { createElement } from "../components/htmlManipulator.js";
import { currencySymbol, getPriceCurrency } from "../formTools/currencyLabel.js";

const waluta = () => currencySymbol(getPriceCurrency());
const fmtPct = (v) => `${parseFloat(Number(v).toFixed(2))}%`;
const fmtMoney = (v) => `${Number(v || 0).toFixed(2)} ${waluta()}`;
const parseInput = (input) => parseFloat(String(input.value).replace(',', '.'));

/** Dane okna (services/b2bDiscount.js getInfo); `null` = brak uprawnień albo błąd. */
async function fetchB2bDiscount(orderId) {
    try {
        const response = await fetch(`/orders/order/${orderId}/b2b-discount`, { headers: { Accept: 'application/json' } });
        if (!response.ok) return null;
        const data = await response.json();
        return data.success && data.canManage ? data : null;
    } catch (error) {
        console.error('Error fetching B2B discount:', error);
        return null;
    }
}

async function postB2bDiscount(orderId, points, amount) {
    try {
        const response = await fetch(`/orders/order/${orderId}/b2b-discount`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points, amount })
        });
        const data = await response.json().catch(() => ({}));
        return response.ok ? data : { success: false, message: data.message || t('order.b2b_discount_error') };
    } catch (error) {
        console.error('Error saving B2B discount:', error);
        return { success: false, message: t('order.b2b_discount_error') };
    }
}

/**
 * Zapis rabatu i przeliczenie pozycji istniejącym „Przelicz wszystkie pozycje”.
 * Nowy procent + kwota = dwa kroki: kwota zamienia się na procent wartości zlecenia
 * PO rabacie %, a ta jest znana dopiero po przeliczeniu z nowym procentem.
 */
async function applyB2bDiscount(orderId, points, amount, dialog, button) {
    const { recalculateOrder, isRecalculating } = await import('../recalculateOrder.js');
    if (isRecalculating()) {
        showToast('warning', t('order.b2b_discount_busy'));
        return;
    }
    button.disabled = true;
    let result = await postB2bDiscount(orderId, points, amount);
    if (!result.success) {
        showToast('error', result.message || t('order.b2b_discount_error'));
        button.disabled = false;
        return;
    }
    dialog.close();
    dialog.remove();
    if (result.needsSecondPass) {
        if (!(await recalculateOrder(orderId, { reload: false }))) return;
        result = await postB2bDiscount(orderId, points, amount);
        if (!result.success) {
            showToast('error', result.message || t('order.b2b_discount_error'));
            return;
        }
    }
    // Przeliczamy też bez zmiany rabatu — przycisk obiecuje „przelicz pozycje”, a pozycje
    // mogą być liczone starszą regułą (np. punkty sprzed 2026-11-19).
    showToast('success', t(result.changed || result.needsSecondPass ? 'order.b2b_discount_saved' : 'order.b2b_discount_unchanged'));
    await recalculateOrder(orderId);
}

function numberField(parent, { id, label, unit, value, disabled, max }) {
    createElement('label', { for: id, text: label, class: ['discount-checkbox-label'] }, parent);
    const container = createElement('div', { class: ['discount-input-container'] }, parent);
    const input = createElement('input', {
        type: 'number', id, min: '0', step: '0.01', value: String(value || 0),
        disabled, class: ['discount-input'], inputmode: 'decimal', ...(max ? { max } : {})
    }, container);
    createElement('span', { text: unit, class: ['discount-unit'] }, container);
    return input;
}

export async function showB2bDiscountModal(orderId) {
    const info = await fetchB2bDiscount(orderId);
    if (!info) {
        showToast('error', t('order.b2b_discount_forbidden'));
        return;
    }
    document.getElementById('b2b-discount-dialog')?.remove();
    const dialog = createElement('dialog', { id: 'b2b-discount-dialog', class: ['dialog', 'discount-dialog'], 'aria-labelledby': 'b2b-discount-title' },
        document.getElementById('dialog-container') || document.body);
    createElement('h2', { id: 'b2b-discount-title', text: t('order.b2b_discount_title'), class: ['discount-dialog-title'] }, dialog);
    const section = createElement('section', { class: ['discount-section', 'b2b-discount-section'] }, dialog);
    createElement('p', { text: t('order.b2b_discount_hint'), class: ['discount-hint'] }, section);

    const listRates = Array.isArray(info.listRates) ? info.listRates : [];
    if (listRates.length) {
        createElement('p', { text: `${t('order.b2b_discount_list_rates')}: ${listRates.map(fmtPct).join(' · ')}`, class: ['discount-hint'] }, section);
    }

    const pointsInput = numberField(section, {
        id: 'b2b-points-input', label: t('order.b2b_discount_points'), unit: t('order.b2b_discount_points_unit'),
        value: info.points, disabled: !info.editable, max: '100'
    });
    const amountInput = numberField(section, {
        id: 'b2b-amount-input', label: `${t('order.b2b_discount_amount')} (${waluta()})`, unit: waluta(),
        value: info.amount, disabled: !info.editable
    });
    createElement('p', { text: `${t('order.b2b_discount_amount_base')}: ${fmtMoney(info.baseAfterPercent)}`, class: ['discount-hint'] }, section);
    if (info.amountPct > 0) {
        createElement('p', {
            text: t('order.b2b_discount_amount_current', { percent: fmtPct(info.amountPct), amount: fmtMoney(info.currentAmount) }),
            class: ['discount-hint']
        }, section);
    }
    if (info.pending) createElement('p', { text: t('order.b2b_discount_pending'), class: ['discount-hint', 'discount-hint--warn'], role: 'status' }, section);
    if (!info.editable) createElement('p', { text: t('order.b2b_discount_locked'), class: ['discount-hint', 'discount-hint--warn'], role: 'status' }, section);

    const buttons = createElement('div', { class: ['discount-button-container'] }, dialog);
    if (info.editable) {
        const apply = createElement('button', { type: 'button', class: ['btn', 'btn-success'], text: t('order.b2b_discount_apply') }, buttons);
        apply.addEventListener('click', () => {
            const points = parseInput(pointsInput);
            const amount = parseInput(amountInput);
            if (!Number.isFinite(points) || points < 0 || points > 100) {
                showToast('error', t('order.b2b_discount_points_invalid'));
                return;
            }
            if (!Number.isFinite(amount) || amount < 0) {
                showToast('error', t('order.b2b_discount_amount_invalid'));
                return;
            }
            applyB2bDiscount(orderId, points, amount, dialog, apply);
        });
    }
    const cancel = createElement('button', { type: 'button', class: ['btn', 'btn-secondary'], text: t('order.cancel') }, buttons);
    cancel.addEventListener('click', () => { dialog.close(); dialog.remove(); });

    dialog.showModal();
    // `.dialog` startuje ukryty (dialog.css) — tak samo odsłania go okno Centrum rabatów.
    setTimeout(() => {
        dialog.style.display = 'grid';
        dialog.style.visibility = 'visible';
        dialog.style.opacity = '1';
    }, 50);
}

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('b2b-discount-btn');
    if (btn) btn.addEventListener('click', () => showB2bDiscountModal(btn.dataset.orderId));
});
