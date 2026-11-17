/**
 * Faktura in blanco / refaktura (tylko admin) — strona `templates/owner/invoice_blank.njk`.
 *
 * Przebieg: formularz w krokach → podsumowanie liczone przez SERWER bez zapisu
 * (`POST /api/v1/invoices/blank/preview`, debounce) → „Podgląd PDF” zapisuje szkic bez numeru
 * (poprzedni szkic z tej strony jest porzucany, `draft` → `cancelled`) → „Wystaw” nadaje numer
 * z serii wystawcy. Niezmieniony szkic jest wystawiany (`/:id/issue`), zmieniony — porzucany
 * i zastępowany fakturą wystawioną od razu. Kwoty, VAT i numer liczy wyłącznie serwer.
 * `?draft=<id>` wznawia szkic, `?from=<id>` kopiuje nabywcę i pozycje (bez dat i numeru).
 */

import { showToast } from '/scripts/components/toast.js';
import { confirmPrompt } from '/scripts/components/confirmPrompt.js';

const json = (id) => { try { return JSON.parse(document.getElementById(id).textContent || '{}'); } catch { return {}; } };
const L = json('inv-labels');
const CFG = json('inv-blank-config');
const UNITS = ['szt', 'usl', 'kpl', 'm2', 'mb', 'godz'];
const SERVICE_TEMPLATES = new Set(['transport', 'montage', 'repair', 'rebill']);
const $ = (id) => document.getElementById(id);
const form = $('inv-blank-form');
const locale = { pl: 'pl-PL', en: 'en-GB', de: 'de-DE' }[CFG.lang] || 'pl-PL';
const money = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Do pól formularza: bez separatora tysięcy (en „1,234.50” nie dałby się odczytać)
const plain = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const parseNum = (v) => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
const tr = (key, fallback = '') => L[key] || fallback;

const state = {
  buyer: null,        // { type: 'organization'|'user', id, name, country, taxId, street, zip, city }
  draftId: null,      // szkic widoczny w podglądzie
  draftHash: '',      // treść, z której powstał szkic
  summary: null,      // ostatnia odpowiedź serwera
  touched: new Set(), // pola, przy których wolno już pokazać błąd
  showAll: false,     // po próbie podglądu/wystawienia pokazujemy wszystkie błędy
  issued: false
};

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  let body = null;
  try { body = await res.json(); } catch { /* np. przekierowanie na logowanie */ }
  if (!res.ok || (body && body.success === false)) throw Object.assign(new Error((body && body.message) || `HTTP ${res.status}`), { body });
  return body;
}
const el = (tag, props = {}, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children); return n; };

/* ------------------------------------------------------------------ */
/* Pozycje                                                             */
/* ------------------------------------------------------------------ */

/** Język dokumentu: wybrany ręcznie, inaczej według kraju nabywcy (ta sama reguła co serwer, `core/language.js`). */
function docLang() {
  if (form.elements.lang.value) return form.elements.lang.value;
  const country = ($('inv-blank-manual').checked ? form.elements.b_country.value : state.buyer?.country || '').trim().toUpperCase();
  return (CFG.langByCountry || {})[country] || state.summary?.lang || CFG.fallbackLang || 'en';
}

function lineButton(label, text, onClick) {
  const b = el('button', { type: 'button', className: 'inv-btn inv-btn--ghost', title: label, textContent: text });
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function addLine(values = {}, { focus = false, after = null } = {}) {
  // Pozycja = <tbody>: wiersz z danymi i pod nim wiersz z opisem (na fakturze opis też jest pod nazwą)
  const line = el('tbody', { className: 'inv-blank-line' });
  const main = el('tr');
  const cell = (node, cls = '') => { main.append(el('td', { className: cls }, node)); return node; };
  const name = cell(el('input', { name: 'name', maxLength: 200, value: values.name || '', placeholder: tr('blank_item_name') }));
  name.setAttribute('aria-label', tr('blank_item_name'));
  const qty = cell(el('input', { name: 'quantity', inputMode: 'decimal', value: values.quantity != null ? String(values.quantity).replace('.', ',') : '1', className: 'num' }));
  qty.setAttribute('aria-label', tr('blank_qty'));
  const unit = cell(el('select', { name: 'unit' }));
  unit.setAttribute('aria-label', tr('blank_unit'));
  UNITS.forEach((u) => unit.append(new Option(tr(`blank_unit_${u}`, u), u)));
  unit.value = values.unit || 'szt';
  const price = cell(el('input', { name: 'unitPriceNet', inputMode: 'decimal', className: 'num', placeholder: '0,00',
    value: values.unitPriceNet != null && values.unitPriceNet !== '' ? (typeof values.unitPriceNet === 'number' ? plain.format(values.unitPriceNet) : values.unitPriceNet) : '' }));
  price.setAttribute('aria-label', tr('blank_price'));
  const service = cell(el('input', { type: 'checkbox', name: 'isService', checked: values.isService === true }), 'c');
  service.setAttribute('aria-label', tr('blank_service'));
  service.addEventListener('change', () => { if (service.checked && unit.value === 'szt') unit.value = 'usl'; });
  cell(el('span', { className: 'inv-blank-net', textContent: '' }), 'num');
  const actions = el('div', { className: 'inv-blank-line-actions' },
    lineButton(tr('blank_move_up'), '↑', () => { if (line.previousElementSibling?.matches('tbody')) line.parentNode.insertBefore(line, line.previousElementSibling); changed(); }),
    lineButton(tr('blank_move_down'), '↓', () => { if (line.nextElementSibling) line.parentNode.insertBefore(line.nextElementSibling, line); changed(); }),
    lineButton(tr('blank_duplicate'), '⧉', () => { addLine(readLine(line), { after: line, focus: true }); }),
    lineButton(tr('blank_remove'), '×', () => { line.remove(); if (!lineRows().length) addLine(); changed(); }));
  const desc = el('textarea', { name: 'description', maxLength: 1000, rows: 2, value: values.description || '', placeholder: tr('blank_item_desc_hint', tr('blank_item_desc')) });
  desc.setAttribute('aria-label', tr('blank_item_desc'));
  line.append(main, el('tr', { className: 'inv-blank-desc' }, el('td', { colSpan: 4 }, desc), el('td', { colSpan: 2 }, actions)));
  // Enter w polu pozycji (nie w opisie) = nowa pozycja pod spodem
  line.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); addLine({}, { after: line, focus: true }); }
  });
  if (after) after.after(line); else $('inv-blank-lines').append(line);
  if (focus) name.focus();
  changed();
  return line;
}

function readLine(row) {
  const f = (n) => row.querySelector(`[name="${n}"]`);
  return { name: f('name').value.trim(), description: f('description').value.trim(), quantity: f('quantity').value.trim(),
    unit: f('unit').value, unitPriceNet: f('unitPriceNet').value.trim(), isService: f('isService').checked };
}
const lineRows = () => [...$('inv-blank-lines').tBodies];

function addFromTemplate(key) {
  if (!key) return;
  const names = (CFG.templates || {})[docLang()] || {};
  const row = lineRows().find((r) => !readLine(r).name && !readLine(r).unitPriceNet);
  const values = { name: key === 'other' ? '' : (names[key] || ''), isService: SERVICE_TEMPLATES.has(key), unit: SERVICE_TEMPLATES.has(key) ? 'usl' : 'szt' };
  if (key === 'rebill' && !form.elements.rebill.checked) { form.elements.rebill.checked = true; $('inv-blank-rebill-source').hidden = false; }
  if (row) {
    row.querySelector('[name=name]').value = values.name;
    row.querySelector('[name=isService]').checked = values.isService;
    row.querySelector('[name=unit]').value = values.unit;
    row.querySelector(values.name ? '[name=unitPriceNet]' : '[name=name]').focus();
    changed();
  } else {
    addLine(values).querySelector(values.name ? '[name=unitPriceNet]' : '[name=name]').focus();
  }
}

/* ------------------------------------------------------------------ */
/* Nabywca                                                             */
/* ------------------------------------------------------------------ */

const buyerInput = $('inv-blank-buyer-q');
const buyerList = $('inv-blank-buyer-list');
let searchCtl = null;
let searchTimer = null;

function addressLine(b) {
  return [b.street, [b.zip, b.city].filter(Boolean).join(' '), b.country].filter(Boolean).join(', ');
}

function showBuyerList(items, heading) {
  buyerList.replaceChildren();
  if (heading && items.length) buyerList.append(el('div', { className: 'inv-combo__item inv-blank-muted', textContent: heading }));
  for (const item of items) {
    const opt = el('div', { className: 'inv-combo__item' },
      el('strong', { textContent: `${item.type === 'organization' ? '🏢 ' : item.type === 'user' ? '👤 ' : '✎ '}${item.name}` }),
      el('div', { className: 'inv-blank-muted', textContent: [item.ident, item.organization, addressLine(item), item.taxId || item.vatEuId].filter(Boolean).join(' · ') }));
    opt.setAttribute('role', 'option');
    opt.addEventListener('mousedown', (e) => { e.preventDefault(); pickBuyer(item); });
    buyerList.append(opt);
  }
  buyerList.classList.toggle('is-open', items.length > 0);
  buyerInput.setAttribute('aria-expanded', items.length ? 'true' : 'false');
}

function pickBuyer(item) {
  buyerList.classList.remove('is-open');
  buyerInput.setAttribute('aria-expanded', 'false');
  if (item.type === 'manual') {
    $('inv-blank-manual').checked = true;
    setManual(true);
    for (const [k, v] of Object.entries({ b_name: item.name, b_street: item.street, b_zip: item.zip, b_city: item.city, b_country: item.country, b_vatEuId: item.vatEuId, b_taxId: item.taxId, b_email: item.email })) {
      form.elements[k].value = v || '';
    }
    changed();
    return;
  }
  state.buyer = item;
  renderBuyerCard();
  changed();
}

function renderBuyerCard() {
  const b = state.buyer;
  $('inv-blank-buyer-card').hidden = !b;
  $('inv-blank-buyer-search').hidden = !!b;
  if (!b) return;
  $('inv-blank-buyer-name').textContent = b.name;
  $('inv-blank-buyer-meta').textContent = [b.ident, addressLine(b)].filter(Boolean).join(' · ');
  $('inv-blank-buyer-vat').textContent = b.taxId ? `${tr('vat_eu_id', 'VAT')}: ${b.taxId}` : '';
  $('inv-blank-buyer-vies').hidden = !b.taxId;
  $('inv-blank-buyer-vies-result').textContent = '';
}

function setManual(on) {
  $('inv-blank-manual-fields').hidden = !on;
  $('inv-blank-buyer-search').hidden = on || !!state.buyer;
  $('inv-blank-buyer-card').hidden = on || !state.buyer;
}

buyerInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = buyerInput.value.trim();
  if (q.length < 2) { loadRecentBuyers(); return; }
  searchTimer = setTimeout(async () => {
    if (searchCtl) searchCtl.abort();
    searchCtl = new AbortController();
    try {
      const { items } = await api(`/api/v1/invoices/search/buyers?q=${encodeURIComponent(q)}`, { signal: searchCtl.signal });
      showBuyerList(items);
    } catch (err) {
      if (err.name !== 'AbortError') showToast('error', err.message, 5);
    }
  }, 220);
});
buyerInput.addEventListener('focus', () => { if (buyerInput.value.trim().length < 2) loadRecentBuyers(); });
buyerInput.addEventListener('blur', () => setTimeout(() => buyerList.classList.remove('is-open'), 150));

async function loadRecentBuyers() {
  try {
    const { items } = await api('/api/v1/invoices/search/buyers?recent=1');
    if (document.activeElement === buyerInput && buyerInput.value.trim().length < 2) showBuyerList(items, tr('blank_recent_buyers'));
  } catch { /* lista ostatnich to wygoda — bez niej formularz działa */ }
}

$('inv-blank-buyer-change').addEventListener('click', () => {
  state.buyer = null;
  renderBuyerCard();
  buyerInput.value = '';
  buyerInput.focus();
  changed();
});
$('inv-blank-manual').addEventListener('change', (e) => { setManual(e.target.checked); changed(); });

async function viesCheck(vatEuId, country, out) {
  out.textContent = '…';
  try {
    const r = await api('/api/v1/invoices/blank/vies', { method: 'POST', body: JSON.stringify({ vatEuId, country }) });
    if (r.reason === 'format') out.textContent = `✗ ${tr('blank_err_buyer_vat')}`;
    else if (!r.checked) out.textContent = `⚠ ${tr('blank_vies_na')}`;
    else out.textContent = r.valid ? `✓ ${tr('blank_vies_ok')}${r.name ? ` — ${r.name}` : ''}` : `✗ ${tr('blank_vies_bad')}`;
  } catch (err) {
    out.textContent = `⚠ ${err.message}`;
  }
}
$('inv-blank-buyer-vies').addEventListener('click', () => viesCheck(state.buyer?.taxId, state.buyer?.country, $('inv-blank-buyer-vies-result')));
$('inv-blank-manual-vies').addEventListener('click', () => viesCheck(form.elements.b_vatEuId.value, form.elements.b_country.value, $('inv-blank-manual-vies-result')));

/* ------------------------------------------------------------------ */
/* Treść żądania, podsumowanie, błędy                                   */
/* ------------------------------------------------------------------ */

function payload() {
  const f = form.elements;
  const manual = $('inv-blank-manual').checked;
  return {
    issuerOrganizationId: Number(f.issuerOrganizationId.value),
    buyer: manual
      ? { type: 'manual', name: f.b_name.value, street: f.b_street.value, zip: f.b_zip.value, city: f.b_city.value,
        country: f.b_country.value.trim().toUpperCase(), vatEuId: f.b_vatEuId.value, taxId: f.b_taxId.value, email: f.b_email.value }
      : (state.buyer ? { type: state.buyer.type, id: state.buyer.id } : null),
    items: lineRows().map(readLine).map((l) => ({ ...l, quantity: parseNum(l.quantity), unitPriceNet: parseNum(l.unitPriceNet) })),
    saleDate: f.saleDate.value,
    deliveryDate: f.deliveryDate.value,
    paymentDays: f.paymentDays.value,
    lang: f.lang.value,
    rebill: f.rebill.checked,
    rebillSource: f.rebillSource.value,
    notes: f.notes.value
  };
}

let previewTimer = null;
let previewSeq = 0;
function changed() {
  for (const row of lineRows()) {
    const l = readLine(row);
    const net = parseNum(l.quantity) * parseNum(l.unitPriceNet);
    row.querySelector('.inv-blank-net').textContent = Number.isFinite(net) && l.unitPriceNet ? money.format(Math.round(net * 100) / 100) : '';
  }
  if (state.issued) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshSummary, 400);
}

async function refreshSummary() {
  const seq = ++previewSeq;
  $('inv-blank-sum-body').querySelector('.inv-blank-muted')?.replaceChildren(tr('blank_summary_calc'));
  try {
    const r = await api('/api/v1/invoices/blank/preview', { method: 'POST', body: JSON.stringify(payload()) });
    if (seq !== previewSeq) return; // nowsze żądanie już poszło
    state.summary = r.valid ? r.summary : null;
    renderErrors(r.valid ? [] : r.fieldErrors || [], r.valid ? [] : r.errors || []);
    renderSummary();
  } catch (err) {
    if (seq === previewSeq) showToast('error', err.message, 5);
  }
}

function fieldNode(field) {
  if (field.startsWith('items.')) {
    const [, idx, name] = field.split('.');
    return lineRows()[Number(idx)]?.querySelector(`[name="${name}"]`) || null;
  }
  if (field === 'buyer') return $('inv-blank-manual').checked ? form.elements.b_name : buyerInput;
  return form.querySelector(`[data-field="${field}"]`);
}

const STEP_OF = (field) => (field === 'issuer' ? 'issuer' : field === 'buyer' || field.startsWith('b_') ? 'buyer' : field.startsWith('items') ? 'items' : 'terms');

function renderErrors(fieldErrors, otherErrors) {
  form.querySelectorAll('.inv-blank-err').forEach((n) => n.remove());
  form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
  const byStep = { issuer: 0, buyer: 0, items: 0, terms: 0 };
  const missing = [];
  for (const { field, code } of fieldErrors) {
    byStep[STEP_OF(field)] += 1;
    const message = tr(`blank_err_${code}`, code);
    missing.push({ field, message });
    const node = fieldNode(field);
    if (!node || !(state.showAll || state.touched.has(field))) continue;
    node.setAttribute('aria-invalid', 'true');
    const id = `err-${field.replace(/\W/g, '-')}`;
    node.setAttribute('aria-describedby', id);
    node.after(el('span', { className: 'inv-blank-err', id, textContent: message }));
  }
  for (const [step, n] of Object.entries(byStep)) {
    const badge = form.querySelector(`[data-state-for="${step}"]`);
    badge.textContent = n ? `${n} × ${tr('blank_missing').toLowerCase()}` : '✓';
    badge.classList.toggle('is-ok', !n);
  }
  const box = $('inv-blank-missing');
  box.replaceChildren();
  if (missing.length || otherErrors.length) {
    const ul = el('ul');
    for (const m of missing) {
      const a = el('a', { href: '#', textContent: m.message });
      a.addEventListener('click', (e) => { e.preventDefault(); state.showAll = true; renderErrors(fieldErrors, otherErrors); fieldNode(m.field)?.focus(); });
      ul.append(el('li', {}, a));
    }
    if (!fieldErrors.length) for (const m of otherErrors) ul.append(el('li', { textContent: m }));
    box.append(el('strong', { textContent: tr('blank_missing') }), ul);
  }
  const ok = !missing.length && !otherErrors.length;
  $('inv-blank-preview-btn').disabled = !ok;
  $('inv-blank-issue').disabled = !ok;
}

function renderSummary() {
  const body = $('inv-blank-sum-body');
  const s = state.summary;
  if (!s) { body.replaceChildren(el('p', { className: 'inv-blank-muted', textContent: tr('blank_summary_empty') })); return; }
  const dl = el('dl');
  const row = (k, v, cls = '') => dl.append(el('dt', { className: cls, textContent: k }), el('dd', { className: cls, textContent: v }));
  row(tr('blank_expected_number'), s.expectedNumber || '—');
  row(tr('blank_doc_lang'), String(s.lang).toUpperCase());
  // Stawka tylko przy krajowej/obniżonej — etykiety 0 % (WDT, odwrotne obciążenie, eksport) już ją zawierają
  for (const l of s.taxLines) row(`${tr(`blank_tax_${l.taxCategory}`, l.taxCategory)}${['standard', 'reduced'].includes(l.taxCategory) ? ` ${l.taxRate} %` : ''}`, `${money.format(l.net)} + ${money.format(l.tax)}`);
  row(tr('blank_total_net'), `${money.format(s.totals.net)} ${s.currency}`);
  row(tr('blank_total_tax'), `${money.format(s.totals.tax)} ${s.currency}`);
  row(tr('blank_total_gross'), `${money.format(s.totals.gross)} ${s.currency}`, 'total');
  const notes = [...new Set(s.taxLines.map((l) => l.legalNote).filter(Boolean)), ...(s.warnings || [])];
  body.replaceChildren(dl, el('p', { className: 'inv-blank-muted', textContent: tr('blank_expected_hint') }),
    ...(notes.length ? [el('ul', {}, ...notes.map((n) => el('li', { className: 'inv-blank-muted', textContent: n })))] : []));
  for (const [i, it] of s.items.entries()) {
    const cell = lineRows()[i]?.querySelector('.inv-blank-net');
    if (cell) cell.textContent = money.format(it.net);
  }
}

form.addEventListener('input', changed);
form.addEventListener('change', changed);
form.addEventListener('focusout', (e) => {
  const field = e.target.dataset?.field || (e.target.closest('#inv-blank-lines') ? `items.${lineRows().indexOf(e.target.closest('tbody'))}.${e.target.name}` : null);
  if (field) { state.touched.add(field); changed(); }
});
form.addEventListener('submit', (e) => e.preventDefault());
$('inv-blank-add').addEventListener('click', () => addLine({}, { focus: true }));
$('inv-blank-template').addEventListener('change', (e) => { addFromTemplate(e.target.value); e.target.value = ''; });
$('inv-blank-rebill').addEventListener('change', (e) => { $('inv-blank-rebill-source').hidden = !e.target.checked; });

/* ------------------------------------------------------------------ */
/* Szkic, podgląd PDF, wystawienie                                      */
/* ------------------------------------------------------------------ */

const hashOf = (p) => JSON.stringify(p);

async function dropDraft() {
  if (!state.draftId) return;
  const id = state.draftId;
  state.draftId = null;
  state.draftHash = '';
  try { await api(`/api/v1/invoices/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) }); } catch { /* szkic bez numeru — nieszkodliwy */ }
}

function showPreview(id, note) {
  $('inv-blank-frame').src = `/invoices/${id}/view`;
  $('inv-blank-pdf').href = `/api/v1/invoices/${id}/pdf?download=1`;
  $('inv-blank-result-note').textContent = note || '';
  $('inv-blank-result').hidden = false;
}

async function ensureValid() {
  state.showAll = true;
  clearTimeout(previewTimer);
  await refreshSummary();
  if (!state.summary) { $('inv-blank-missing').querySelector('a')?.click(); return false; }
  return true;
}

$('inv-blank-preview-btn').addEventListener('click', async () => {
  if (!(await ensureValid())) return;
  const btn = $('inv-blank-preview-btn');
  btn.disabled = true;
  try {
    const p = payload();
    if (!state.draftId || state.draftHash !== hashOf(p)) {
      await dropDraft();
      const { id } = await api('/api/v1/invoices/blank', { method: 'POST', body: JSON.stringify({ ...p, issue: false }) });
      state.draftId = id;
      state.draftHash = hashOf(p);
    }
    showPreview(state.draftId, tr('blank_draft_saved'));
    $('inv-blank-result').scrollIntoView({ behavior: 'smooth' });
    loadList();
  } catch (err) {
    showToast('error', err.message, 6);
  } finally {
    btn.disabled = false;
  }
});

$('inv-blank-issue').addEventListener('click', async () => {
  if (!(await ensureValid())) return;
  const s = state.summary;
  const ok = await confirmPrompt({
    title: tr('blank_issue'),
    message: `${s.buyer.name} · ${money.format(s.totals.gross)} ${s.currency}\n${tr('blank_issue_confirm')}`,
    confirmLabel: tr('blank_issue'),
    cancelLabel: tr('blank_edit')
  });
  if (!ok) return;
  $('inv-blank-issue').disabled = true;
  try {
    const p = payload();
    let id;
    let number;
    if (state.draftId && state.draftHash === hashOf(p)) {
      id = state.draftId;
      ({ number } = await api(`/api/v1/invoices/${id}/issue`, { method: 'POST' }));
    } else {
      await dropDraft();
      ({ id, number } = await api('/api/v1/invoices/blank', { method: 'POST', body: JSON.stringify({ ...p, issue: true }) }));
    }
    state.issued = true;
    state.draftId = null;
    $('inv-blank-actions').hidden = true;
    $('inv-blank-missing').replaceChildren();
    $('inv-blank-done').hidden = false;
    $('inv-blank-issued').textContent = `${tr('blank_issued')} ${number}`;
    $('inv-blank-pdf-done').href = `/api/v1/invoices/${id}/pdf?download=1`;
    $('inv-blank-view-done').href = `/invoices/${id}/view`;
    showPreview(id, number);
    form.querySelectorAll('input, select, textarea, button').forEach((n) => { n.disabled = true; });
    showToast('success', `${tr('blank_issued')} ${number}`, 5);
    history.replaceState(null, '', '/invoices/blank');
    loadList();
  } catch (err) {
    $('inv-blank-issue').disabled = false;
    showToast('error', err.message, 6);
  }
});

/* ------------------------------------------------------------------ */
/* Lista ostatnich, wznowienie szkicu, „nowa na podstawie”              */
/* ------------------------------------------------------------------ */

async function loadList() {
  const tbody = $('inv-blank-list');
  try {
    const { items } = await api('/api/v1/invoices/blank/list');
    if (!items.length) { tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 6, className: 'inv-blank-muted', textContent: tr('blank_list_empty') }))); return; }
    tbody.replaceChildren(...items.map((it) => {
      const draft = it.status === 'draft';
      const actions = el('div', { className: 'inv-blank-line-actions' });
      if (draft) {
        actions.append(el('a', { className: 'inv-btn inv-btn--ghost', href: `/invoices/blank?draft=${it.id}`, textContent: tr('blank_resume') }));
        const discard = el('button', { type: 'button', className: 'inv-btn inv-btn--ghost', textContent: tr('blank_discard') });
        discard.addEventListener('click', async () => {
          if (!(await confirmPrompt({ title: tr('blank_discard'), message: tr('blank_discard_confirm'), confirmLabel: tr('blank_discard') }))) return;
          try {
            await api(`/api/v1/invoices/${it.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) });
            if (state.draftId === it.id) { state.draftId = null; $('inv-blank-result').hidden = true; }
            loadList();
          } catch (err) { showToast('error', err.message, 5); }
        });
        actions.append(discard);
      } else {
        actions.append(el('a', { className: 'inv-btn inv-btn--ghost', href: `/api/v1/invoices/${it.id}/pdf?download=1`, textContent: 'PDF' }));
      }
      actions.append(el('a', { className: 'inv-btn inv-btn--ghost', href: `/invoices/blank?from=${it.id}`, textContent: tr('blank_based_on') }));
      return el('tr', {},
        el('td', { textContent: draft ? tr('blank_draft') : it.number }),
        el('td', { textContent: it.issueDate || '' }),
        el('td', { textContent: it.issuer || '' }),
        el('td', { textContent: [it.buyerName, it.orderName].filter(Boolean).join(' · ') }),
        el('td', { className: 'num', textContent: money.format(Number(it.totalGross)) }),
        el('td', {}, actions));
    }));
  } catch (err) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 6, className: 'inv-blank-err', textContent: err.message })));
  }
}

async function prefill(id, asDraft) {
  const { invoice } = await api(`/api/v1/invoices/${id}`);
  const meta = (invoice.compliance && invoice.compliance.blank) || {};
  const f = form.elements;
  if ([...f.issuerOrganizationId.options].some((o) => Number(o.value) === Number(invoice.issuerId))) f.issuerOrganizationId.value = String(invoice.issuerId);
  const b = invoice.buyer || {};
  if (meta.buyer && meta.buyer.id) {
    state.buyer = { type: meta.buyer.type, id: meta.buyer.id, name: b.name, country: b.country, taxId: b.vatEuId || b.taxId, street: b.street, zip: b.zip, city: b.city };
    renderBuyerCard();
  } else {
    pickBuyer({ type: 'manual', name: b.name, street: b.street, zip: b.zip, city: b.city, country: b.country, vatEuId: b.vatEuId, taxId: b.taxId, email: b.email });
  }
  lineRows().forEach((b) => b.remove());
  for (const it of [...invoice.items].sort((x, y) => x.position - y.position)) {
    addLine({ name: it.name, description: it.description, quantity: it.quantity, unit: it.unit, unitPriceNet: Number(it.unitPriceNet) / 100, isService: !!(it.meta && it.meta.isService) });
  }
  if (asDraft) { f.saleDate.value = invoice.saleDate || CFG.today; f.deliveryDate.value = invoice.deliveryDate || f.saleDate.value; }
  f.paymentDays.value = meta.paymentDays != null ? String(meta.paymentDays) : '';
  f.lang.value = invoice.lang || '';
  f.rebill.checked = meta.rebillSource != null;
  $('inv-blank-rebill-source').hidden = !f.rebill.checked;
  f.rebillSource.value = meta.rebillSource || '';
  f.notes.value = meta.notes || '';
  if (asDraft) {
    state.draftId = invoice.id;
    state.draftHash = hashOf(payload());
    showPreview(invoice.id, tr('blank_loaded_draft'));
  }
  showToast('success', asDraft ? tr('blank_loaded_draft') : `${tr('blank_loaded_from')} ${invoice.number || ''}`, 3);
  changed();
}

(async () => {
  const params = new URLSearchParams(location.search);
  const draft = Number(params.get('draft'));
  const from = Number(params.get('from'));
  try {
    if (draft > 0) await prefill(draft, true);
    else if (from > 0) await prefill(from, false);
    else addLine();
  } catch (err) {
    showToast('error', err.message, 6);
    if (!lineRows().length) addLine();
  }
  loadList();
})();
