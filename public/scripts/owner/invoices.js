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
/* Widok listy: tworzenie dokumentu                                    */
/* ------------------------------------------------------------------ */

function initCreateForm() {
  const form = document.getElementById('inv-create-form');
  if (!form) return;

  const orderSelect = document.getElementById('inv-order-select');
  const docType = document.getElementById('inv-doctype');
  const advanceWrap = document.getElementById('inv-advance-wrap');
  const hint = document.getElementById('inv-tax-hint');
  const submitBtn = document.getElementById('inv-create-btn');

  /** Procent zaliczki ma sens tylko dla faktury zaliczkowej. */
  const syncAdvance = () => {
    if (!advanceWrap) return;
    advanceWrap.hidden = docType.value !== 'advance';
  };

  /** Podpowiedź o stawce liczona po stronie serwera i wstawiona w `data-hint`. */
  const syncHint = () => {
    if (!hint || !orderSelect) return;
    const option = orderSelect.selectedOptions[0];
    hint.textContent = option ? option.dataset.hint || '' : '';
    hint.classList.toggle('inv-hint--zero', option ? option.dataset.zero === '1' : false);
  };

  docType.addEventListener('change', syncAdvance);
  orderSelect.addEventListener('change', syncHint);
  syncAdvance();
  syncHint();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const orderId = data.get('orderId');

    const payload = {
      documentType: data.get('documentType'),
      lang: data.get('lang'),
      issue: data.get('issue') === 'on'
    };
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
  initCreateForm();
  initRowActions();
  initProfileForm();
});
