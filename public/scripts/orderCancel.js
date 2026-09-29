/**
 * Anulowanie wysłanego zlecenia (do 24 h od wysłania) — strona przeglądarki.
 * Serwer: POST /orders/order/:orderId/cancel → services/orderCancellation.js.
 *
 * Przyciski `.cancel-order-btn` renderują:
 *  • templates/partials/order_cancellation.njk — podgląd wysłanego zlecenia,
 *  • templates/partials/cancel_order_btn.njk   — wiersz na liście wysłanych.
 *
 * ⚠️ DWA potwierdzenia, bo operacji nie da się cofnąć: najpierw skutki
 * + wymagane zaznaczenie „rozumiem, że nie można cofnąć", potem ostatnie
 * „Czy na pewno?". Domyślny fokus i Enter NIE trafiają w przycisk
 * anulowania — przypadkowe naciśnięcie klawisza niczego nie anuluje.
 *
 * ⚠️ Nasłuch w fazie PRZECHWYTYWANIA (`true`): przyciski na liście mają
 * `onclick="event.stopPropagation()"` (żeby klik nie otwierał wiersza), więc
 * zdarzenie nie wypłynęłoby do `document`. Tak samo robi orders.js.
 *
 * Termin w przeglądarce służy WYŁĄCZNIE wygodzie (odliczanie, ukrycie
 * przycisku po czasie) — o tym, czy wolno anulować, decyduje serwer.
 */
import { showToast } from "./components/toast.js";
import { createInfoDialog } from "./components/htmlManipulator.js";

const TICK_MS = 30 * 1000;
const ERROR_TOAST_SECONDS = 6;
const ACK_CHECKBOX_ID = 'cancel-order-ack';

let inFlight = false;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function translationsLoaded() {
    try {
        if (window.translationsReady) await window.translationsReady;
    } catch (_) { /* brak tłumaczeń = klucze zamiast tekstu, ale bez wywrotki */ }
}

function dialogParent() {
    return document.getElementById('dialog-container') || document.body;
}

/** `5 h 12 min` / `12 min` / `< 1 min` */
function formatTimeLeft(seconds) {
    const h = t('cancel_order.hours_short');
    const min = t('cancel_order.minutes_short');
    if (seconds < 60) return `< 1 ${min}`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours} ${h} ${minutes} ${min}` : `${minutes} ${min}`;
}

/** „Nr 242 · „Nazwa zlecenia”” — nagłówek treści obu okien. */
function orderLabelHtml(btn) {
    const no = btn.dataset.orderNo ? `${escapeHtml(btn.dataset.orderNo)}` : '';
    const commission = btn.dataset.commission ? ` · „${escapeHtml(btn.dataset.commission)}”` : '';
    return no || commission ? `<strong class="order-cancel-dialog__order">${no}${commission}</strong><br>` : '';
}

function openFirstStep(btn) {
    const { buttons, diag } = createInfoDialog({
        title: t('cancel_order.step1_title'),
        message: `${orderLabelHtml(btn)}${escapeHtml(t('cancel_order.step1_message'))}`,
        parent: dialogParent(),
        className: 'order-cancel-dialog',
        checkbox: { id: ACK_CHECKBOX_ID, name: t('cancel_order.step1_checkbox') },
        buttons: [
            { label: t('cancel_order.keep_order'), className: 'btn btn-secondary me-1', id: 'cancel-btn' },
            {
                label: t('cancel_order.step1_continue'),
                className: 'btn btn-warning ms-1',
                id: 'confirm-btn',
                action: () => openFinalStep(btn)
            }
        ]
    });

    // `createInfoDialog` wstawia pole wyboru NAD treścią — zgoda ma iść po
    // przeczytaniu skutków, więc przenosimy je pod opis.
    const ackRow = diag.querySelector('#diag-checkbox-container');
    const message = [...diag.querySelectorAll(':scope > p')].pop();
    if (ackRow && message) message.after(ackRow);

    // „Dalej" dopiero po świadomym zaznaczeniu, że operacji nie da się cofnąć.
    const continueBtn = buttons[1];
    const ack = document.getElementById(ACK_CHECKBOX_ID);
    continueBtn.disabled = true;
    ack?.addEventListener('change', () => { continueBtn.disabled = !ack.checked; });
}

function openFinalStep(btn) {
    createInfoDialog({
        title: t('cancel_order.step2_title'),
        message: `${orderLabelHtml(btn)}<span class="order-cancel-dialog__warning">${escapeHtml(t('cancel_order.step2_message'))}</span>`,
        parent: dialogParent(),
        className: 'order-cancel-dialog order-cancel-dialog--final',
        buttons: [
            // Pierwszy w kolejności = domyślny fokus po `showModal()` — bezpieczny.
            { label: t('cancel_order.keep_order'), className: 'btn btn-secondary me-1', id: 'cancel-btn' },
            {
                label: t('cancel_order.step2_confirm'),
                className: 'btn btn-danger ms-1',
                id: 'confirm-btn',
                action: () => submitCancellation(btn)
            }
        ]
    });
}

function allButtonsFor(orderId) {
    return document.querySelectorAll(`.cancel-order-btn[data-id="${CSS.escape(String(orderId))}"]`);
}

function setBusy(orderId, busy) {
    allButtonsFor(orderId).forEach(button => {
        button.disabled = busy;
        button.classList.toggle('is-busy', busy);
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
}

async function readJson(response) {
    try {
        return await response.json();
    } catch (_) {
        // Odmowa `checkOrderOwnership` to przekierowanie na stronę HTML.
        return { success: false, message: t(response.redirected ? 'cancel_order.error_forbidden' : 'cancel_order.error_server') };
    }
}

async function submitCancellation(btn) {
    const orderId = btn.dataset.id;
    if (!orderId || inFlight) return;
    inFlight = true;
    setBusy(orderId, true);
    showToast('info', t('cancel_order.in_progress'));

    try {
        const response = await fetch(`/orders/order/${encodeURIComponent(orderId)}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin'
        });
        const data = await readJson(response);

        if (data.success) {
            showToast('success', data.message || t('cancel_order.success'));
            setTimeout(() => { window.location.href = data.redirect || '/orders/canceled'; }, 900);
            return;
        }

        showToast('error', data.message || t('cancel_order.error_server'), ERROR_TOAST_SECONDS);
        if (data.code === 'window_expired' || data.code === 'not_sent') {
            // Termin minął albo status zmienił się gdzie indziej — przycisk
            // nie ma już sensu; odświeżenie pokaże aktualny stan.
            allButtonsFor(orderId).forEach(expireButton);
            setTimeout(() => window.location.reload(), 2500);
        }
    } catch (error) {
        console.error('[orderCancel]', error);
        showToast('error', t('cancel_order.error_connection'), ERROR_TOAST_SECONDS);
    } finally {
        inFlight = false;
        setBusy(orderId, false);
    }
}

/** Po upływie okna: przycisk znika, w podglądzie pojawia się informacja. */
function expireButton(button) {
    const notice = button.closest('[data-cancel-window]');
    if (notice) {
        notice.classList.add('is-expired');
        notice.querySelector('[data-cancel-open]')?.setAttribute('hidden', '');
        notice.querySelector('[data-cancel-countdown]')?.setAttribute('hidden', '');
        notice.querySelector('[data-cancel-closed]')?.removeAttribute('hidden');
    }
    button.remove();
}

function startCountdowns() {
    const notices = [...document.querySelectorAll('[data-cancel-window]')].map(el => ({
        el,
        deadline: Date.now() + (Number(el.dataset.secondsLeft) || 0) * 1000
    }));
    const listButtons = [...document.querySelectorAll('.cancel-order-btn[data-seconds-left]')].map(el => ({
        el,
        deadline: Date.now() + (Number(el.dataset.secondsLeft) || 0) * 1000
    }));
    if (notices.length === 0 && listButtons.length === 0) return;

    const tick = () => {
        const now = Date.now();
        for (const item of notices) {
            if (!item.el.isConnected || item.el.classList.contains('is-expired')) continue;
            const left = Math.floor((item.deadline - now) / 1000);
            if (left <= 0) {
                const button = item.el.querySelector('.cancel-order-btn');
                if (button) expireButton(button);
                else item.el.classList.add('is-expired');
                continue;
            }
            const countdown = item.el.querySelector('[data-cancel-countdown]');
            const value = item.el.querySelector('[data-cancel-countdown-value]');
            if (countdown && value) {
                value.textContent = formatTimeLeft(left);
                countdown.removeAttribute('hidden');
            }
        }
        for (const item of listButtons) {
            if (item.el.isConnected && item.deadline <= now) item.el.remove();
        }
    };

    tick();
    setInterval(tick, TICK_MS);
}

document.addEventListener('click', async (event) => {
    const btn = event.target.closest('.cancel-order-btn');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled || inFlight) return;
    await translationsLoaded();
    openFirstStep(btn);
}, true);

translationsLoaded().then(startCountdowns);
