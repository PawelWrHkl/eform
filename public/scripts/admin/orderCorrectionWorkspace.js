import { showToast } from '../components/toast.js';
import { confirmPrompt } from '../components/confirmPrompt.js';

const submitBtn = document.getElementById('submit-correction-btn');
const abortBtn = document.getElementById('abort-correction-btn');

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

async function submitCorrection(orderId) {
    const apiBase = window.correctionApiBase || `/admin/order-corrections/${orderId}`;
    const res = await fetch(`${apiBase}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices: getPrices() })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        throw new Error(data.message || 'Błąd wysyłki korekty');
    }
    return data;
}

if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
        const orderId = submitBtn.dataset.id;
        const confirmed = await confirmPrompt({
            title: 'Wyślij korektę',
            message: 'Korekta zostanie wysłana jako plik JSON z sufiksem <strong>_correction</strong> (ten sam katalog co zlecenie) oraz mailem do klienta (poza produkcją tylko na adres testowy). Kontynuować?',
            confirmLabel: 'Wyślij korektę',
            cancelLabel: 'Anuluj',
            confirmClass: 'btn btn-warning'
        });
        if (!confirmed) return;

        submitBtn.disabled = true;
        if (abortBtn) abortBtn.disabled = true;
        try {
            const data = await submitCorrection(orderId);
            showToast(data.message || 'Korekta wysłana', 'success');
            setTimeout(() => {
                window.location.href = data.redirect || '/admin/order-corrections';
            }, 1200);
        } catch (err) {
            showToast(err.message, 'error');
            submitBtn.disabled = false;
            if (abortBtn) abortBtn.disabled = false;
        }
    });
}

if (abortBtn) {
    abortBtn.addEventListener('click', async () => {
        const orderId = abortBtn.dataset.id;
        const confirmed = await confirmPrompt({
            title: 'Anuluj korektę',
            message: 'Czy na pewno anulować korektę? Zamówienie wróci do statusu „wysłane” bez wysyłki nowego pliku ani maila do klienta.',
            confirmLabel: 'Anuluj korektę',
            cancelLabel: 'Wróć',
            confirmClass: 'btn btn-danger'
        });
        if (!confirmed) return;

        abortBtn.disabled = true;
        if (submitBtn) submitBtn.disabled = true;
        try {
            const apiBase = window.correctionApiBase || `/admin/order-corrections/${orderId}`;
            const res = await fetch(`${apiBase}/cancel`, {
                method: 'POST',
                headers: { 'Accept': 'application/json' }
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || 'Nie udało się anulować korekty');
            }
            showToast(data.message || 'Korekta anulowana', 'success');
            setTimeout(() => {
                window.location.href = data.redirect || '/admin/order-corrections';
            }, 800);
        } catch (err) {
            showToast(err.message || 'Błąd połączenia z serwerem', 'error');
            abortBtn.disabled = false;
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}
