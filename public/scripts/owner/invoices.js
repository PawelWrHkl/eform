/**
 * Panel faktur (owner) — logika strony.
 *
 * Obsługuje dwa widoki: listę dokumentów (`templates/owner/invoices.njk`) i
 * formularz profilu (`templates/owner/invoice_profile.njk`). Cała komunikacja
 * idzie przez REST API `/api/v1/invoices` — strona nie ma własnej logiki
 * biznesowej, więc reguły VAT/numeracji istnieją w jednym miejscu (serwer).
 *
 * Etykiety są wczytywane z `<script type="application/json" id="inv-labels">`,
 * żeby nie duplikować tekstów w JS (i18n panelu siedzi w module — patrz
 * `services/invoices/i18n/panel.json`).
 */

import { showToast } from '/scripts/components/toast.js';
import { confirmPrompt } from '/scripts/components/confirmPrompt.js';

/** @returns {Record<string, string>} */
function labels() {
  const node = document.getElementById('inv-labels');
  if (!node) return {};
  try {
    return JSON.parse(node.textContent || '{}');
  } catch {
    return {};
  }
}

const L = labels();

/**
 * Wywołanie API z jednolitą obsługą błędów.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // Odpowiedź bez JSON-a (np. przekierowanie na login) — obsłużone niżej
  }

  if (!res.ok || (body && body.success === false)) {
    const message = (body && body.message) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}


/* ------------------------------------------------------------------ */
/* Combobox: input z podpowiedziami z serwera                          */
/* ------------------------------------------------------------------ */

/** Ile czekamy po ostatnim znaku, zanim odpytamy serwer (ms). */
const SEARCH_DEBOUNCE_MS = 220;

/**
 * Combobox z podpowiedziami pobieranymi z endpointu.
 *
 * ⚠️ Świadomie BEZ renderowania pełnej listy w HTML-u: klientów i zamówień
 * będzie bardzo dużo, więc źródłem jest `/api/v1/invoices/search/...` z twardym
 * limitem po stronie serwera. Konsekwencje, o których trzeba pamiętać:
 *  - każde wpisanie znaku unieważnia poprzednie żądanie (`AbortController`) —
 *    inaczej wolniejsza odpowiedź na krótsze zapytanie nadpisywałaby świeższą,
 *  - `debounce` ogranicza liczbę zapytań przy szybkim pisaniu,
 *  - wybór trafia do ukrytego pola (formularz wysyła ID, nie tekst); zmiana
 *    tekstu po wyborze czyści ID, żeby nie wysłać nieaktualnego identyfikatora.
 *
 * @param {Object} params
 * @param {string} params.inputId
 * @param {string} params.listId
 * @param {string} params.hiddenId
 * @param {(query: string, signal: AbortSignal) => Promise<Array<Object>>} params.fetchItems
 * @param {(item: Object) => { value: string, label: string, html: string, data?: Record<string, string> }} params.renderItem
 * @param {(value: string, data: Record<string, string>|null) => void} [params.onPick]
 */
function initCombobox({ inputId, listId, hiddenId, fetchItems, renderItem, onPick }) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  const hidden = document.getElementById(hiddenId);
  if (!input || !list || !hidden) return;

  let controller = null;
  let timer = null;
  let entries = [];
  let activeIndex = -1;

  const close = () => {
    list.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  };

  const setActive = (index) => {
    entries.forEach((e) => e.el.classList.remove('is-active'));
    activeIndex = index;
    const current = entries[index];
    if (!current) return;
    current.el.classList.add('is-active');
    current.el.scrollIntoView({ block: 'nearest' });
  };

  const renderState = (text) => {
    list.innerHTML = `<div class="inv-combo__state">${text}</div>`;
    list.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    entries = [];
    activeIndex = -1;
  };

  const pick = (entry) => {
    if (!entry) return;
    hidden.value = entry.value;
    input.value = entry.label;
    close();
    if (onPick) onPick(entry.value, entry.data || {});
  };

  const search = async () => {
    const query = input.value.trim();

    if (controller) controller.abort();
    controller = new AbortController();

    renderState(L.searching || '…');
    try {
      const items = await fetchItems(query, controller.signal);
      if (!items.length) {
        renderState(L.no_results || '—');
        return;
      }

      list.innerHTML = '';
      entries = items.map((item) => {
        const view = renderItem(item);
        const el = document.createElement('div');
        el.className = 'inv-combo__item';
        el.setAttribute('role', 'option');
        el.innerHTML = view.html;
        Object.entries(view.data || {}).forEach(([k, v]) => { el.dataset[k] = v; });
        list.appendChild(el);
        return { el, value: view.value, label: view.label, data: view.data || {} };
      });

      // Lista jest ucięta — mówimy o tym wprost i podpowiadamy, co zrobić
      const total = typeof items.totalMatches === 'number' ? items.totalMatches : items.length;
      if (total > items.length) {
        const more = document.createElement('div');
        more.className = 'inv-combo__more';
        more.textContent = (L.results_truncated || 'Pokazano {shown} z {total} — wpisz więcej znaków')
          .replace('{shown}', String(items.length))
          .replace('{total}', String(total));
        list.appendChild(more);
      }

      list.classList.add('is-open');
      input.setAttribute('aria-expanded', 'true');
      setActive(0);
    } catch (err) {
      // Przerwane żądanie to normalny przebieg przy pisaniu — nie komunikat błędu
      if (err.name === 'AbortError') return;
      renderState(`${L.error || 'Error'}: ${err.message}`);
    }
  };

  const scheduleSearch = () => {
    clearTimeout(timer);
    timer = setTimeout(search, SEARCH_DEBOUNCE_MS);
  };

  input.addEventListener('focus', scheduleSearch);
  input.addEventListener('input', () => {
    hidden.value = '';
    if (onPick) onPick('', null);
    scheduleSearch();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!list.classList.contains('is-open')) scheduleSearch();
      else setActive(Math.min(activeIndex + 1, entries.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === 'Enter') {
      if (list.classList.contains('is-open') && entries[activeIndex]) {
        event.preventDefault();
        pick(entries[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      close();
    }
  });

  // `mousedown`, nie `click` — `blur` inputa zamknąłby listę przed kliknięciem
  list.addEventListener('mousedown', (event) => {
    const el = event.target.closest('.inv-combo__item');
    if (!el) return;
    event.preventDefault();
    pick(entries.find((e) => e.el === el));
  });

  input.addEventListener('blur', () => setTimeout(close, 150));
}

/**
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<Array<Object>>}
 */
async function fetchSearch(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const body = await res.json();
  if (!res.ok || body.success === false) throw new Error(body.message || `HTTP ${res.status}`);
  const items = body.items || [];
  // Ile pasuje ŁĄCZNIE — dropdown pokazuje tylko część, a bez tej liczby
  // wygląda to jak gubienie wyników. Doklejone do tablicy, żeby nie zmieniać
  // kontraktu `fetchItems` we wszystkich comboboxach.
  items.totalMatches = typeof body.total === 'number' ? body.total : items.length;
  return items;
}

/** Escapowanie tekstu wstawianego przez innerHTML (nazwy klientów z bazy). */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* Widok listy: wybór klienta (krok 1)                                 */
/* ------------------------------------------------------------------ */

function initClientSelect() {
  const form = document.getElementById('inv-client-form');
  if (!form) return;

  // Wybór klienta przeładowuje panel w jego kontekście (GET ?clientId=…),
  // więc adres jest linkowalny i odświeżenie strony nie gubi wyboru.
  // ⚠️ JEDEN endpoint dla wszystkich relacji: to `level` decyduje, czy szukamy
  // organizacji (1), użytkownika organizacji (2) czy odbiorcy końcowego (3/4).
  // Wcześniejsze rozgałęzienie po `data-source` trzeba by rozbudowywać przy
  // każdym nowym poziomie — i łatwo było trafić w cudzą kartotekę.
  const level = Number(form.dataset.level) || 2;
  const searchUrl = `/api/v1/invoices/search/clients?level=${level}`;

  initCombobox({
    inputId: 'inv-client-input',
    listId: 'inv-client-list',
    hiddenId: 'inv-client-id',
    fetchItems: (query, signal) => fetchSearch(`${searchUrl}&q=${encodeURIComponent(query)}`, signal),
    renderItem: (c) => ({
      value: String(c.id),
      // Odbiorca końcowy ma `name`, klient organizacji `client_name`
      label: c.name || c.client_name || c.ident || String(c.id),
      html: `<span class="inv-combo__main">${escapeHtml(c.name || c.client_name || c.ident)}</span>`
        + `<span class="inv-combo__sub">${escapeHtml([c.country, c.city, c.tax_id].filter(Boolean).join(' · '))}</span>`
    }),
    // Wybór klienta PRZENOSI na jego własny ekran (`/invoices/client/:id`).
    // Formularz nadal działa bez JS — trasa `/invoices?clientId=` przekierowuje
    // w to samo miejsce, więc obie drogi kończą się tam samo.
    onPick: (value) => {
      if (!value) return;
      window.location.href = `/invoices/client/${encodeURIComponent(value)}?level=${level}`;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Widok listy: tworzenie dokumentu                                    */
/* ------------------------------------------------------------------ */

function initCreateForm() {
  const form = document.getElementById('inv-create-form');
  if (!form) return;

  const orderHidden = document.getElementById('inv-order-id');
  const docType = document.getElementById('inv-doctype');
  const advanceWrap = document.getElementById('inv-advance-wrap');
  const hint = document.getElementById('inv-tax-hint');
  const submitBtn = document.getElementById('inv-create-btn');

  /** Procent zaliczki ma sens tylko dla faktury zaliczkowej. */
  const syncAdvance = () => {
    if (!advanceWrap) return;
    advanceWrap.hidden = docType.value !== 'advance';
  };

  /**
   * Podpowiedź o stawce i ostrzeżenie o zerowej wartości — dane policzone na
   * serwerze i wstawione w atrybuty pozycji listy (`data-hint`, `data-zero`,
   * `data-zerovalue`), więc strona niczego nie liczy sama.
   */
  const syncHint = (data) => {
    if (!hint) return;
    if (!data) {
      hint.textContent = '';
      hint.classList.remove('inv-hint--warn');
      return;
    }
    // Skutek podatkowy zależy od KLIENTA (para krajów) i jest już pokazany na
    // jego karcie — tutaj ostrzegamy tylko o zerowej wartości zamówienia,
    // bo to jedyna rzecz zależna od wybranego zamówienia.
    const zeroValue = data.zerovalue === '1';
    hint.textContent = zeroValue ? `⚠ ${L.zero_value || ''}` : '';
    hint.classList.toggle('inv-hint--warn', zeroValue);
  };

  const clientId = form.dataset.clientId;
  const formLevel = Number(form.dataset.level) || 2;
  /** Dane ostatnio wybranego zamówienia (przypisanie odbiorcy) */
  let pickedOrder = {};

  // Poziom 1: opcjonalny filtr „użytkownik organizacji". Trzyma tylko id do
  // zapytania o zamówienia — nabywcą faktury pozostaje organizacja, więc do
  // payloadu tworzenia dokumentu ta wartość NIE trafia.
  const orgUserHidden = document.getElementById('inv-orguser-id');
  const orgUserInput = document.getElementById('inv-orguser-input');
  const orderInput = document.getElementById('inv-order-input');

  /** Zmiana filtru unieważnia wybrane wcześniej zamówienie — mogło należeć do innego salonu. */
  const resetOrderPick = () => {
    // `orderHidden` jest już zadeklarowane wyżej w tej funkcji
    if (orderHidden) orderHidden.value = '';
    if (orderInput) orderInput.value = '';
    syncHint(null);
  };

  if (orgUserHidden) {
    initCombobox({
      inputId: 'inv-orguser-input',
      listId: 'inv-orguser-list',
      hiddenId: 'inv-orguser-id',
      fetchItems: (query, signal) => fetchSearch(
        `/api/v1/invoices/search/clients?level=1&orgId=${encodeURIComponent(clientId)}&q=${encodeURIComponent(query)}`,
        signal
      ),
      renderItem: (u) => ({
        value: String(u.id),
        label: u.client_name || u.ident || String(u.id),
        html: `<span class="inv-combo__main">${escapeHtml(u.client_name || u.ident)}</span>`
          + `<span class="inv-combo__sub">${escapeHtml([u.ident, u.country, u.city].filter(Boolean).join(' · '))}</span>`
      }),
      onPick: resetOrderPick
    });

    const clearBtn = document.getElementById('inv-orguser-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        orgUserHidden.value = '';
        if (orgUserInput) orgUserInput.value = '';
        resetOrderPick();
      });
    }
  }
  initCombobox({
    inputId: 'inv-order-input',
    listId: 'inv-order-list',
    hiddenId: 'inv-order-id',
    fetchItems: (query, signal) => {
      // Filtr użytkownika doklejany dopiero tutaj, przy każdym zapytaniu —
      // dzięki temu zmiana filtru działa od razu, bez przeładowania panelu.
      const orgUser = orgUserHidden && orgUserHidden.value ? `&userId=${encodeURIComponent(orgUserHidden.value)}` : '';
      return fetchSearch(
        `/api/v1/invoices/search/orders?clientId=${encodeURIComponent(clientId)}&level=${formLevel}${orgUser}&q=${encodeURIComponent(query)}`,
        signal
      );
    },
    renderItem: (o) => {
      const zeroValue = Number(o.items_net) === 0;
      const advance = Number(o.advances_gross) > 0 ? `⬤ ${o.advances_gross}` : '';
      const parts = [o.total_float ? `${o.total_float} EUR` : '', advance, zeroValue ? `⚠ ${L.zero_value || ''}` : ''];
      return {
        value: String(o.id),
        label: `${o.order_idx}${o.commision ? ` · ${o.commision}` : ''}`,
        html: `<span class="inv-combo__main">${escapeHtml(o.order_idx)}${o.commision ? ` · ${escapeHtml(o.commision)}` : ''}</span>`
          + `<span class="inv-combo__sub">${escapeHtml(parts.filter(Boolean).join(' · '))}</span>`,
        data: {
          zerovalue: zeroValue ? '1' : '0',
          // Aktualne przypisanie zamówienia — na jego podstawie panel pyta
          // przed przypisaniem albo przepięciem odbiorcy
          endclientid: o.end_client_id ? String(o.end_client_id) : '',
          endclientname: o.end_client_name || ''
        }
      };
    },
    onPick: (_value, data) => { pickedOrder = data || {}; syncHint(data); }
  });

  docType.addEventListener('change', syncAdvance);
  syncAdvance();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const orderId = data.get('orderId');
    if (!orderId) {
      // Puste pole zamówienia = user wpisał tekst, ale nie wybrał podpowiedzi
      showToast('error', L.pick_order || 'Wybierz zamówienie z listy', 3);
      return;
    }

    const payload = {
      documentType: data.get('documentType'),
      lang: data.get('lang'),
      issue: data.get('issue') === 'on',
      // Poziom hierarchii: 3 dla salonu (nabywcą jest odbiorca końcowy)
      level: Number(form.dataset.level) || 2
    };
    // Odbiorca końcowy jest nabywcą na poziomie 3 (salon) i 4 (organizacja).
    // ⚠️ Bierzemy go z KONTEKSTU FORMULARZA, nie z adresu: po przeniesieniu
    // panelu na `/invoices/client/:id` w URL nie ma już `?clientId=`, przez co
    // pole nie było wysyłane i serwer odrzucał dokument komunikatem
    // „Poziom 3 wymaga odbiorcy końcowego".
    if (payload.level === 3 || payload.level === 4) {
      payload.endClientId = Number(clientId);

      // Zamówienie musi być spięte z tym odbiorcą — pytamy, zanim to zrobimy
      const linked = pickedOrder.endclientid ? Number(pickedOrder.endclientid) : null;
      const target = Number(clientId);
      if (linked !== target) {
        const nazwaKlienta = form.dataset.clientName || '';
        const ok = await confirmPrompt(linked
          ? {
            title: L.reassign_title || 'Przepiąć zamówienie?',
            message: (L.reassign_message || 'Zamówienie jest przypisane do „{from}". Czy na pewno przypisać je do „{to}"?')
              .replace('{from}', pickedOrder.endclientname || `#${linked}`)
              .replace('{to}', nazwaKlienta),
            confirmLabel: L.reassign_confirm || 'Przepnij i wystaw',
            confirmClass: 'btn btn-warning'
          }
          : {
            title: L.assign_title || 'Przypisać zamówienie?',
            message: (L.assign_message || 'Zamówienie zostanie przypisane do odbiorcy „{to}". Kontynuować?')
              .replace('{to}', nazwaKlienta),
            confirmLabel: L.assign_confirm || 'Przypisz i wystaw'
          });
        if (!ok) return;

        const link = await fetch(`/api/v1/invoices/orders/${orderId}/end-client`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endClientId: target })
        });
        if (!link.ok) {
          const body = await link.json().catch(() => null);
          showToast('error', (body && body.message) || L.error || 'Error', 5);
          return;
        }
        pickedOrder.endclientid = String(target);
      }
    }
    if (payload.documentType === 'advance') {
      payload.advancePercent = Number(data.get('advancePercent'));
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = L.creating || '…';

    try {
      const result = await api(`/api/v1/invoices/from-order/${orderId}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('success', result.number ? `${L.title}: ${result.number}` : (L.saved || 'OK'));
      window.location.reload();
    } catch (err) {
      showToast('error', `${L.error || 'Error'}: ${err.message}`, 4);
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Widok listy: akcje na dokumencie                                    */
/* ------------------------------------------------------------------ */

function initRowActions() {
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.id;
      const action = button.dataset.action;

      if (action === 'cancel' && !window.confirm(L.confirm_cancel || 'Cancel?')) return;

      button.disabled = true;
      try {
        if (action === 'issue') {
          const result = await api(`/api/v1/invoices/${id}/issue`, { method: 'POST' });
          showToast('success', result.number);
        } else if (action === 'paid') {
          await api(`/api/v1/invoices/${id}/status`, {
            method: 'POST',
            body: JSON.stringify({ status: 'paid' })
          });
          showToast('success', L.mark_paid || 'OK');
        } else if (action === 'cancel') {
          await api(`/api/v1/invoices/${id}/status`, {
            method: 'POST',
            body: JSON.stringify({ status: 'cancelled' })
          });
          showToast('success', L.cancel_doc || 'OK');
        }
        window.location.reload();
      } catch (err) {
        showToast('error', `${L.error || 'Error'}: ${err.message}`, 4);
        button.disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Widok profilu                                                       */
/* ------------------------------------------------------------------ */

function initProfileForm() {
  const form = document.getElementById('inv-profile-form');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);

    /** @type {Record<string, any>} */
    const patch = {};
    const patterns = {};
    const footers = {};

    for (const [key, rawValue] of data.entries()) {
      const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
      if (key.startsWith('pattern_')) {
        // Puste pole = użyj wzorca domyślnego, więc nie zapisujemy pustych
        if (value) patterns[key.slice('pattern_'.length)] = value;
      } else if (key.startsWith('footer_')) {
        if (value) footers[key.slice('footer_'.length)] = value;
      } else if (key === 'theme_accent') {
        patch.theme_vars = { accent: value };
      } else {
        patch[key] = value;
      }
    }

    if (Object.keys(patterns).length) patch.number_patterns = patterns;
    if (Object.keys(footers).length) patch.footer_notes = footers;

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      await api('/api/v1/invoices/profile/current', {
        method: 'PUT',
        body: JSON.stringify(patch)
      });
      showToast('success', L.saved || 'OK');
    } catch (err) {
      // Najczęstszy błąd to zły wzorzec numeracji (walidowany na serwerze)
      showToast('error', `${L.error || 'Error'}: ${err.message}`, 5);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initClientSelect();
  initCreateForm();
  initRowActions();
  initProfileForm();
});
