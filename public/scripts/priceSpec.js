/**
 * Okno „Specyfikacja ceny" w podglądzie zlecenia (przycisk `[data-price-spec-open]`
 * w templates/order.njk). Treść liczy i renderuje serwer
 * (`GET /orders/order/:id/price-spec`, services/priceSpec) — tu tylko okno,
 * drukowanie i PDF (`/orders/order/:id/price-spec.pdf`).
 *
 * Natywny `<dialog>`: Esc, blokada tła i powrót fokusu na przycisk po
 * zamknięciu bez własnej obsługi.
 */

const STYLE_HREF = '/styles/priceSpec.css';

function ensureStyles() {
    if (document.querySelector(`link[href^="${STYLE_HREF}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    document.head.appendChild(link);
}

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'text') node.textContent = value;
        else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) if (child) node.appendChild(child);
    return node;
}

function readUi(button) {
    try {
        return JSON.parse(button.dataset.ui || '{}');
    } catch (_) {
        return {};
    }
}

let dialog = null;

function buildDialog(ui) {
    const body = el('div', { class: 'price-spec-modal__body', tabindex: '-1' });
    const pdfLink = el('a', { class: 'price-spec-modal__btn price-spec-modal__btn--primary', href: '#', download: true }, [
        el('span', { 'aria-hidden': 'true', text: '⤓' }),
        el('span', { class: 'price-spec-modal__btn-text', text: ui.pdf || 'PDF' })
    ]);
    pdfLink.setAttribute('aria-label', ui.pdf || 'PDF');
    const printBtn = el('button', { type: 'button', class: 'price-spec-modal__btn', 'aria-label': ui.print || 'Print' }, [
        el('span', { 'aria-hidden': 'true', text: '⎙' }),
        el('span', { class: 'price-spec-modal__btn-text', text: ui.print || 'Print' })
    ]);
    const closeBtn = el('button', { type: 'button', class: 'price-spec-modal__btn price-spec-modal__btn--icon', 'aria-label': ui.close || 'Close', text: '×' });
    const title = el('h2', { id: 'price-spec-modal-title', text: ui.title || '' });

    const node = el('dialog', { class: 'price-spec-modal', 'aria-labelledby': 'price-spec-modal-title' }, [
        el('div', { class: 'price-spec-modal__bar' }, [
            title,
            el('div', { class: 'price-spec-modal__actions' }, [printBtn, pdfLink, closeBtn])
        ]),
        body
    ]);

    closeBtn.addEventListener('click', () => node.close());
    // Klik w tło (poza ramką okna) zamyka — jak w pozostałych oknach portalu.
    node.addEventListener('click', (event) => {
        if (event.target === node) node.close();
    });
    printBtn.addEventListener('click', () => {
        document.body.classList.add('price-spec-printing');
        const cleanup = () => document.body.classList.remove('price-spec-printing');
        window.addEventListener('afterprint', cleanup, { once: true });
        window.print();
        // Część przeglądarek (mobilne) nie wysyła `afterprint`.
        setTimeout(cleanup, 1000);
    });

    document.body.appendChild(node);
    return { node, body, title, pdfLink, printBtn };
}

function showLoading(body, ui) {
    body.replaceChildren(
        el('p', { class: 'price-spec-modal__state', role: 'status', text: ui.loading || '' }),
        ...[100, 92, 96, 70, 88].map((w) => el('div', { class: 'price-spec-modal__skeleton', style: `width:${w}%` }))
    );
}

async function openPriceSpec(button) {
    const orderId = button.dataset.orderId;
    if (!orderId) return;
    const ui = readUi(button);
    ensureStyles();
    if (!dialog) dialog = buildDialog(ui);
    const { node, body, title, pdfLink, printBtn } = dialog;

    title.textContent = ui.title || '';
    pdfLink.href = `/orders/order/${encodeURIComponent(orderId)}/price-spec.pdf`;
    pdfLink.hidden = true;
    printBtn.hidden = true;
    showLoading(body, ui);
    if (!node.open) node.showModal();

    try {
        const response = await fetch(`/orders/order/${encodeURIComponent(orderId)}/price-spec`, {
            headers: { Accept: 'text/html' },
            credentials: 'same-origin'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Treść jest renderowana przez nasz serwer z autoescape Nunjucks.
        body.innerHTML = await response.text();
        pdfLink.hidden = false;
        printBtn.hidden = false;
        body.scrollTop = 0;
        body.focus({ preventScroll: true });
    } catch (err) {
        console.warn('[priceSpec]', err);
        body.replaceChildren(el('p', { class: 'price-spec-modal__state', role: 'alert', text: ui.error || 'Error' }));
    }
}

document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-price-spec-open]');
    if (!button) return;
    event.preventDefault();
    openPriceSpec(button);
});
