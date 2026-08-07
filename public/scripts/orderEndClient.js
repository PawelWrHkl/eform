/**
 * Odbiorca końcowy na formularzu zamówienia (nowe zamówienie i edycja).
 *
 * Spina zamówienie z kartoteką fakturową (`invoice_end_client`), dzięki czemu
 * fakturę dla tego odbiorcy wystawia się potem wprost w panelu faktur —
 * zamówienie jest już przy nim, nie trzeba go szukać po numerze.
 *
 * ⚠️ Podpowiedzi lecą z ENDPOINTU, nie z listy wyrenderowanej w HTML:
 * odbiorców salonu może być bardzo dużo (ta sama zasada co w panelu faktur).
 * Zapytania są opóźnione i przerywane — inaczej każde naciśnięcie klawisza
 * zostawiałoby wyścig odpowiedzi, w którym wygrywa ta wolniejsza.
 *
 * Samo POWIĄZANIE zapisuje `public/scripts/orders.js` po utworzeniu/zapisie
 * zamówienia (`PUT /api/v1/invoices/orders/:id/end-client`) — tam jest znany
 * identyfikator zamówienia, a walidacja właściciela siedzi po stronie serwera.
 */

import { openAddAddressModal } from './createNewAddress.js';
import { showToast } from './components/toast.js';

const i18n = (key) => (typeof t === 'function' ? t(key) : key);

const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_URL = '/api/v1/invoices/end-clients/search';

const checkbox = document.getElementById('end-client-checkbox');
const container = document.getElementById('end-client-container');
const hint = document.getElementById('end-client-hint');
const input = document.getElementById('end-client-input');
const hidden = document.getElementById('end-client-id');
const list = document.getElementById('end-client-list');
const addBtn = document.getElementById('add-end-client-btn');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* Odsłanianie sekcji                                                  */
/* ------------------------------------------------------------------ */

function toggleSection() {
  const on = checkbox.checked;
  container.classList.toggle('d-none', !on);
  if (hint) hint.classList.toggle('d-none', !on);
  // Odznaczenie musi CZYŚCIĆ wybór — inaczej zamówienie zostałoby spięte
  // z odbiorcą, którego użytkownik przed chwilą świadomie schował.
  if (!on) {
    hidden.value = '';
    input.value = '';
    closeList();
  } else {
    input.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Combobox                                                            */
/* ------------------------------------------------------------------ */

let controller = null;
let timer = null;

function closeList() {
  list.innerHTML = '';
  list.classList.remove('is-open');
  input.setAttribute('aria-expanded', 'false');
}

/**
 * @param {Array<Record<string, any>>} items
 */
function renderList(items) {
  if (!items.length) {
    list.innerHTML = `<div class="end-client-combo__empty">${escapeHtml(i18n('new-order.end_client_no_results'))}</div>`;
    list.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    return;
  }

  list.innerHTML = items.map((c) => {
    const sub = [c.country, c.city, c.tax_id].filter(Boolean).join(' · ');
    return `<button type="button" class="end-client-combo__item" role="option" data-id="${c.id}" data-name="${escapeHtml(c.name)}">
      <span class="end-client-combo__main">${escapeHtml(c.name)}</span>
      <span class="end-client-combo__sub">${escapeHtml(sub)}</span>
    </button>`;
  }).join('');
  list.classList.add('is-open');
  input.setAttribute('aria-expanded', 'true');
}

async function search(query) {
  if (controller) controller.abort();
  controller = new AbortController();
  try {
    const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=20`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    const body = await res.json();
    renderList(body.items || []);
  } catch (err) {
    // Przerwane żądanie to normalny efekt pisania, nie błąd do pokazania
    if (err.name !== 'AbortError') closeList();
  }
}

/* ------------------------------------------------------------------ */
/* Nowy odbiorca                                                       */
/* ------------------------------------------------------------------ */

function openNewEndClientModal() {
  // Pola celowo w minimalnym zestawie potrzebnym do faktury; resztę (numery
  // rejestrowe, adres dostawy) uzupełnia się w kartotece `/invoices/end-clients`.
  // Format tupli wymagany przez `createNewAddress.js`: [nazwa_pola, etykieta, opcje].
  // Nazwa pola = klucz w payloadzie, więc musi się zgadzać z kolumnami
  // `invoice_end_client` przyjmowanymi przez `POST /api/v1/invoices/end-clients`.
  const fields = [
    ['name', i18n('new-order.end_client_name'), { required: true }],
    ['tax_id', i18n('new-order.end_client_tax_id')],
    ['street', i18n('new-order.street')],
    ['zip', i18n('new-order.zip')],
    ['city', i18n('new-order.city')],
    ['country', i18n('new-order.country')],
    ['email', i18n('new-order.email')],
    ['phone', i18n('new-order.phone')]
  ];

  openAddAddressModal(fields, '/api/v1/invoices/end-clients', {
    title: i18n('new-order.end_client_add'),
    onSubmit: (response, payload) => {
      const id = response && (response.id ?? response.data?.id);
      if (!id) {
        showToast('error', i18n('new-order.end_client_save_error'), 4);
        return;
      }
      // Świeżo utworzony odbiorca od razu wybrany — inaczej trzeba by go
      // jeszcze raz wyszukać, co jest zaskakujące zaraz po dodaniu.
      hidden.value = String(id);
      input.value = payload.name || '';
      closeList();
      showToast('success', i18n('new-order.end_client_saved'));
    }
  });
}

/* ------------------------------------------------------------------ */
/* Zdarzenia                                                           */
/* ------------------------------------------------------------------ */

if (checkbox && container && input && hidden && list) {
  checkbox.addEventListener('change', toggleSection);

  input.addEventListener('input', () => {
    // Wpisanie własnego tekstu unieważnia poprzedni wybór: liczy się
    // identyfikator z listy, a nie to, co widnieje w polu.
    hidden.value = '';
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value.trim()), SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('focus', () => {
    if (!list.classList.contains('is-open')) search(input.value.trim());
  });

  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-id]');
    if (!item) return;
    hidden.value = item.dataset.id;
    input.value = item.dataset.name;
    closeList();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#end-client-container')) closeList();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeList();
  });

  if (addBtn) {
    addBtn.addEventListener('click', (event) => {
      event.preventDefault();
      openNewEndClientModal();
    });
  }
}
