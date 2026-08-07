/**
 * Odbiorcy końcowi (poziom 3) — ekran CRUD.
 *
 * Cała komunikacja przez `/api/v1/invoices/end-clients`; strona nie ma logiki
 * biznesowej (walidacja typu firma/osoba, uprawnienia i biała lista kolumn
 * siedzą na serwerze). Wyszukiwanie jest serwerowe z debounce — lista klientów
 * salonu może być duża.
 */

import { showToast } from '/scripts/components/toast.js';

/** @returns {Record<string, string>} */
function json(id, fallback) {
  const node = document.getElementById(id);
  if (!node) return fallback;
  try {
    return JSON.parse(node.textContent || '');
  } catch {
    return fallback;
  }
}

const L = json('inv-labels', {});
/** Definicje numerów rejestrowych per kraj — z `core/compliance.js`. */
const REGISTRY_DEFS = json('ec-registry-defs', {});

const SEARCH_DEBOUNCE_MS = 220;

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Brak JSON-a (np. przekierowanie na login) — obsłużone przez !res.ok
  }
  if (!res.ok || (body && body.success === false)) {
    throw new Error((body && body.message) || `HTTP ${res.status}`);
  }
  return body;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------------------------------------------------------- */
/* Lista                                                             */
/* ---------------------------------------------------------------- */

const rowsEl = document.getElementById('ec-rows');
const searchEl = document.getElementById('ec-search');
let controller = null;
let timer = null;

async function refreshList() {
  if (controller) controller.abort();
  controller = new AbortController();

  rowsEl.innerHTML = `<tr><td colspan="7" class="inv-empty">${escapeHtml(L.searching || '…')}</td></tr>`;
  try {
    const query = encodeURIComponent(searchEl ? searchEl.value.trim() : '');
    const res = await fetch(`/api/v1/invoices/end-clients/search?q=${query}&limit=50`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    const body = await res.json();
    const items = body.items || [];

    if (!items.length) {
      rowsEl.innerHTML = `<tr><td colspan="7" class="inv-empty">${escapeHtml(L.no_results || '—')}</td></tr>`;
      return;
    }

    rowsEl.innerHTML = items.map((c) => `
      <tr data-id="${c.id}">
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.client_type === 'person' ? (L.type_person || 'person') : (L.type_company || 'company'))}</td>
        <td>${escapeHtml(c.tax_id || '—')}</td>
        <td>${escapeHtml(c.country || '')}</td>
        <td>${escapeHtml(c.city || '')}</td>
        <td>${escapeHtml(c.email || '')}</td>
        <td class="inv-actions">
          <button class="inv-link" data-ec-action="edit" data-id="${c.id}">${escapeHtml(L.edit || 'edit')}</button>
          <button class="inv-link inv-link--danger" data-ec-action="delete" data-id="${c.id}">${escapeHtml(L.deactivate || 'delete')}</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    if (err.name === 'AbortError') return;
    rowsEl.innerHTML = `<tr><td colspan="7" class="inv-empty">${escapeHtml(`${L.error || 'Error'}: ${err.message}`)}</td></tr>`;
  }
}

/* ---------------------------------------------------------------- */
/* Formularz                                                         */
/* ---------------------------------------------------------------- */

const formCard = document.getElementById('ec-form-card');
const form = document.getElementById('ec-form');
const formTitle = document.getElementById('ec-form-title');
const registryWrap = document.getElementById('ec-registry-fields');
const registryHint = document.getElementById('ec-registry-hint');

/**
 * Pola numerów rejestrowych zależą od kraju odbiorcy — francuska firma dostaje
 * SIREN/SIRET/NAF, niemiecka Steuernummer i USt-IdNr. Definicje przychodzą
 * z serwera, żeby nie duplikować ich w JS.
 *
 * @param {string} country
 * @param {Record<string, string>} [values]
 */
function renderRegistryFields(country, values = {}) {
  const code = String(country || '').toUpperCase().slice(0, 2);

  // ⚠️ Pomijamy numery, które moduł i tak bierze z pól ogólnych: `NIP` z
  // `tax_id`, a numery VAT-UE (USt-IdNr., Btw-id, N° TVA) z `vat_eu_id`
  // (patrz `core/compliance.js:buildRegistryRows`). Bez tego formularz pytał
  // o ten sam numer dwa razy — raz jako „NIP", raz jako „NIP" w rejestrach.
  const fields = (REGISTRY_DEFS[code] || []).filter((f) => !f.fromTaxId && !f.fromVatEu);

  registryHint.textContent = fields.length
    ? `${code}: ${fields.map((f) => f.label).join(', ')}`
    : (L.registry_none || '');

  registryWrap.innerHTML = fields.map((f) => `
    <label class="inv-field">
      <span class="inv-label">${escapeHtml(f.label)}${f.required ? ' *' : ''}</span>
      <input name="registry_${escapeHtml(f.key)}" value="${escapeHtml(values[f.key] || '')}">
    </label>`).join('');
}

function openForm(client) {
  form.reset();
  formCard.hidden = false;
  formTitle.textContent = client ? (L.end_client_edit || '') : (L.end_client_new || '');
  document.getElementById('ec-id').value = client ? client.id : '';

  if (client) {
    for (const [key, value] of Object.entries(client)) {
      const field = form.elements.namedItem(key);
      if (!field || typeof value === 'object') continue;
      if (field.type === 'checkbox') field.checked = !!Number(value);
      else field.value = value == null ? '' : value;
    }
  }
  renderRegistryFields(client ? client.country : 'PL', client ? client.registry_numbers : {});
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  /** @type {Record<string, any>} */
  const payload = {};
  const registry = {};

  for (const [key, raw] of data.entries()) {
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (key === 'id') continue;
    if (key.startsWith('registry_')) {
      if (value) registry[key.slice('registry_'.length)] = value;
    } else {
      payload[key] = value;
    }
  }
  payload.registry_numbers = registry;
  // Niezaznaczony checkbox nie trafia do `FormData`, więc wartość ustawiamy
  // jawnie — inaczej odznaczenie nigdy by się nie zapisało.
  payload.print_delivery_address = form.elements.namedItem('print_delivery_address').checked ? 1 : 0;

  const id = document.getElementById('ec-id').value;
  try {
    if (id) {
      await api(`/api/v1/invoices/end-clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/v1/invoices/end-clients', { method: 'POST', body: JSON.stringify(payload) });
    }
    showToast('success', L.saved || 'OK');
    formCard.hidden = true;
    refreshList();
  } catch (err) {
    showToast('error', `${L.error || 'Error'}: ${err.message}`, 5);
  }
});

/* ---------------------------------------------------------------- */
/* Zdarzenia                                                         */
/* ---------------------------------------------------------------- */

document.getElementById('ec-new').addEventListener('click', () => openForm(null));
document.getElementById('ec-cancel').addEventListener('click', () => { formCard.hidden = true; });

form.elements.namedItem('country').addEventListener('change', (event) => {
  // Zmiana kraju przebudowuje pola rejestrowe, zachowując już wpisane wartości
  const current = {};
  registryWrap.querySelectorAll('input').forEach((input) => {
    if (input.value) current[input.name.slice('registry_'.length)] = input.value;
  });
  renderRegistryFields(event.target.value, current);
});

// Typ „osoba prywatna" nie wymaga NIP-u — serwer waliduje to samo
document.getElementById('ec-type').addEventListener('change', (event) => {
  const taxId = document.getElementById('ec-tax-id');
  taxId.required = event.target.value === 'company';
});

rowsEl.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-ec-action]');
  if (!button) return;
  const { ecAction: action, id } = button.dataset;

  if (action === 'edit') {
    try {
      const { client } = await api(`/api/v1/invoices/end-clients/${id}`);
      openForm(client);
    } catch (err) {
      showToast('error', `${L.error || 'Error'}: ${err.message}`, 4);
    }
    return;
  }

  if (action === 'delete') {
    if (!window.confirm(L.confirm_deactivate || 'Deactivate?')) return;
    try {
      await api(`/api/v1/invoices/end-clients/${id}`, { method: 'DELETE' });
      showToast('success', L.saved || 'OK');
      refreshList();
    } catch (err) {
      showToast('error', `${L.error || 'Error'}: ${err.message}`, 4);
    }
  }
});

if (searchEl) {
  searchEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refreshList, SEARCH_DEBOUNCE_MS);
  });
}

refreshList();
