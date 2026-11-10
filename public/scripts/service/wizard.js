/**
 * Kreator zgłoszenia serwisowego (templates/service/wizard.njk) — 4 kroki:
 *   1. zlecenie → 2. rodzaj i pozycje → 3. opis i zdjęcia → 4. podsumowanie i wysyłka.
 *
 * Walidacja: `window.serviceRules` to TEN SAM plik co na serwerze (/service/rules.js),
 * więc kreator i serwer odrzucają to samo. Szkic (bez plików) żyje w sessionStorage —
 * powrót między krokami i odświeżenie nie gubią danych. Serwer: routes/service.js.
 */
import { createFilePicker, describeErrors, esc } from './files.js';

const root = document.getElementById('svc-wizard');
const rules = window.serviceRules;
const S = JSON.parse(document.getElementById('svc-strings').textContent);
const RULES = JSON.parse(document.getElementById('svc-rules').textContent);
const DEPARTMENTS = JSON.parse(document.getElementById('svc-departments').textContent);
const DEFAULTS = JSON.parse(document.getElementById('svc-defaults').textContent);
const STATUS_LABELS = JSON.parse(document.getElementById('svc-status-labels').textContent);

const t = (key, vars) => {
	let v = key.split('.').reduce((o, k) => (o || {})[k], S);
	if (typeof v !== 'string') return key;
	if (vars) v = v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
	return v;
};
const $ = (sel, el = root) => el.querySelector(sel);
const $$ = (sel, el = root) => Array.from(el.querySelectorAll(sel));
const live = $('#svc-live');
const STEP_FIELDS = {
	2: ['type', 'commission', 'departmentId', 'orderNoText', 'category', 'items', 'items.qty', 'items.category', 'items.note', 'deliveredAt'],
	3: ['description', 'files', 'contactName', 'contactPhone', 'contactEmail', 'productAddress']
};

const preselected = Number(root.dataset.preselected) || null;
const draftKey = `svc-draft:${root.dataset.noOrder ? 'none' : (preselected || 'any')}`;

const state = {
	step: 1, tab: 'delivered', orderId: preselected, noOrder: root.dataset.noOrder === 'true', order: null, type: root.dataset.type || null,
	items: {}, orderNoText: '', departmentId: '', category: '', commission: '', deliveredAt: '', carrierNoted: '', quoteBeforeRepair: true,
	description: '', contactName: DEFAULTS.contactName || '', contactPhone: DEFAULTS.contactPhone || '', contactEmail: DEFAULTS.contactEmail || '',
	endClient: '', productAddress: '', knownDismissed: false, dirty: {}
};
try {
	const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
	if (saved && typeof saved === 'object') Object.assign(state, saved, { step: 1, order: null });
} catch { /* bez szkicu */ }

function saveDraft() {
	try {
		const { order, step, ...rest } = state;
		sessionStorage.setItem(draftKey, JSON.stringify(rest));
	} catch { /* pełny storage — trudno */ }
}

// ── pliki (krok 3) ───────────────────────────────────────────────────────
const picker = createFilePicker({
	root: $('[data-panel="3"]'), listEl: $('#svc-files'), limits: RULES.limits, t,
	onChange: (files, bad) => { showFieldError('files', describeErrors(bad, t)); }
});

// ── pomocnicze ───────────────────────────────────────────────────────────
function announce(text) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }
function showGlobal(text) { const el = $('#svc-global-error'); el.textContent = text || ''; el.hidden = !text; }

function clearErrors() {
	$$('[data-error-for]').forEach((el) => { el.hidden = true; el.textContent = ''; });
	$$('.has-error').forEach((el) => el.classList.remove('has-error'));
}

function showFieldError(field, messages) {
	const el = $(`[data-error-for="${field}"]`);
	if (!el) return;
	const text = (Array.isArray(messages) ? messages : [messages]).filter(Boolean).join(' ');
	el.textContent = text;
	el.hidden = !text;
	const wrap = el.closest('.svc-field');
	if (wrap) wrap.classList.toggle('has-error', !!text);
}

function orderState() { return state.noOrder ? 'none' : (state.order ? state.order.state : null); }
function rule() { return state.type ? RULES.rules[state.type] : null; }

function selectedItems() {
	if (!state.order) return [];
	return state.order.items.filter((it) => state.items[it.id]).map((it) => ({ src: it, ...state.items[it.id] }));
}

function buildInput() {
	return {
		type: state.type, orderState: orderState(), commission: state.commission, departmentId: state.noOrder ? Number(state.departmentId) || null : null,
		orderNoText: state.orderNoText, category: state.category, description: state.description,
		items: selectedItems().map((it) => ({ key: it.src.id, qty: Number(it.qty), maxQty: it.src.qty, category: it.category || '', note: it.note || '' })),
		filesCount: picker.files.length, contactName: state.contactName, contactPhone: state.contactPhone, contactEmail: state.contactEmail,
		productAddress: state.productAddress, deliveredAt: state.deliveredAt
	};
}

function payload() {
	return {
		type: state.type, orderId: state.noOrder ? null : state.orderId, orderNoText: state.orderNoText, commission: state.commission,
		departmentId: state.noOrder ? Number(state.departmentId) || null : null, category: state.category, description: state.description,
		items: selectedItems().map((it) => ({ orderItemId: it.src.id, qty: Number(it.qty), category: it.category || '', note: it.note || '' })),
		contactName: state.contactName, contactPhone: state.contactPhone, contactEmail: state.contactEmail, productAddress: state.productAddress,
		endClient: state.endClient, deliveredAt: state.deliveredAt, carrierNoted: state.carrierNoted === '' ? null : state.carrierNoted, quoteBeforeRepair: !!state.quoteBeforeRepair
	};
}

function errorText(e) {
	const name = e.index >= 0 && e.field === 'files' && picker.files[e.index] ? picker.files[e.index].name : '';
	return t(`err.${e.code}`, { name, number: (e.ticket && e.ticket.number) || '' });
}

/** Pokazuje błędy przy polach; dla pozycji — w wierszu szczegółów. Zwraca pierwszy element do fokusu. */
function renderErrors(errors) {
	clearErrors();
	const byField = new Map();
	let first = null;
	const selected = selectedItems();
	for (const e of errors) {
		if (e.field.startsWith('items.') && e.index !== undefined && e.index >= 0 && selected[e.index]) {
			const row = $(`.svc-pos-details[data-item-id="${selected[e.index].src.id}"]`);
			const sub = e.field.split('.')[1];
			const el = row && row.querySelector(`[data-error-for="item-${sub}"]`);
			if (el) { el.textContent = errorText(e); el.hidden = false; if (!first) first = row.querySelector(`[name="${sub}"]`) || el; }
			continue;
		}
		const list = byField.get(e.field) || [];
		list.push(errorText(e));
		byField.set(e.field, list);
	}
	for (const [field, msgs] of byField) {
		showFieldError(field, msgs);
		if (!first) first = $(`[name="${field}"]`) || $(`[data-error-for="${field}"]`);
	}
	if (errors.length) announce(t('err.fix_errors', { n: errors.length }));
	if (first && typeof first.focus === 'function') first.focus({ preventScroll: false });
	if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ── nawigacja ────────────────────────────────────────────────────────────
function goto(step) {
	state.step = step;
	$$('.svc-panel').forEach((p) => { p.hidden = p.dataset.panel !== String(step); });
	$$('#svc-steps li').forEach((li) => {
		const n = Number(li.dataset.step);
		li.classList.toggle('is-active', n === step);
		li.classList.toggle('is-done', typeof step === 'number' && n < step);
	});
	const nav = $('#svc-nav');
	nav.hidden = step === 'done';
	if (typeof step === 'number') {
		$('#svc-progress').setAttribute('aria-valuenow', String(step));
		$('.svc-progress-bar').style.width = `${step * 25}%`;
		$('#svc-step-of').textContent = t('step_of', { n: step, m: 4 });
		$('#svc-back').disabled = step === 1 && !state.noOrder && !preselected;
		$('#svc-next').hidden = step === 4;
	}
	if (step === 2) renderStep2();
	if (step === 3) renderStep3();
	if (step === 4) renderSummary();
	showGlobal('');
	window.scrollTo({ top: 0, behavior: 'smooth' });
	saveDraft();
}

function validateStep(step) {
	if (step === 1) {
		if (!state.noOrder && !state.orderId) { showFieldError('order', t('err.order_required')); announce(t('err.order_required')); return false; }
		return true;
	}
	const errors = rules.validate(buildInput()).filter((e) => STEP_FIELDS[step].includes(e.field));
	if (step === 2 && !state.type) errors.unshift({ field: 'type', code: 'required' });
	renderErrors(errors);
	return errors.length === 0;
}

$('#svc-next').addEventListener('click', async () => {
	if (!validateStep(state.step)) return;
	if (state.step === 1 && !state.noOrder) {
		if (!state.order || state.order.order.id !== state.orderId) {
			const ok = await loadOrder(state.orderId);
			if (!ok) return;
		}
	}
	goto(state.step + 1);
});
$('#svc-back').addEventListener('click', () => {
	if (state.step === 1) return;
	if (state.step === 2 && (state.noOrder || preselected)) { window.location.href = '/service'; return; }
	goto(state.step - 1);
});

// ── krok 1: zlecenia ─────────────────────────────────────────────────────
async function loadOrders() {
	const form = $('#svc-order-search');
	const params = new URLSearchParams({ tab: state.tab, q: form.q.value.trim(), from: form.from.value, to: form.to.value });
	const box = $('#svc-orders');
	box.innerHTML = `<p class="svc-muted">…</p>`;
	try {
		const res = await fetch(`/service/api/orders?${params}`, { headers: { 'X-Requested-With': 'fetch' } });
		if (res.status === 401) { window.location.href = '/user/login'; return; }
		const data = await res.json();
		renderOrders(data.orders || [], !!data.more);
	} catch {
		box.innerHTML = `<p class="svc-error">${esc(t('err.server_error'))}</p>`;
	}
}

function statusLabel(order) {
	if (order.state === 'delivered') return STATUS_LABELS['!sent!'];
	return order.prod_status ? (STATUS_LABELS[order.prod_status] || order.prod_status) : STATUS_LABELS.received;
}

function renderOrders(orders, more) {
	const box = $('#svc-orders');
	if (!orders.length) { box.innerHTML = `<p class="svc-muted svc-empty">${esc(t('orders_empty'))}</p>`; $('#svc-orders-more').hidden = true; return; }
	box.innerHTML = orders.map((o) => `
		<label class="svc-order">
			<input type="radio" name="order" value="${o.id}" ${state.orderId === o.id ? 'checked' : ''}>
			<span class="svc-order-main"><span class="svc-order-no">#${esc(o.order_idx)}</span><span>${esc(o.commission)}</span>${o.end_client ? `<span class="svc-muted">${esc(o.end_client)}</span>` : ''}</span>
			<span class="svc-order-meta"><span>${esc(o.sent_date || '')}</span><span class="svc-badge ${o.state === 'delivered' ? 'svc-badge--delivered' : ''}">${esc(statusLabel(o))}</span></span>
		</label>`).join('');
	box.querySelectorAll('input[name="order"]').forEach((r) => r.addEventListener('change', () => { state.orderId = Number(r.value); state.order = null; showFieldError('order', ''); saveDraft(); }));
	const moreEl = $('#svc-orders-more');
	moreEl.hidden = !more;
	moreEl.textContent = t('orders_more', { n: orders.length });
}

$$('.svc-tab').forEach((tab) => tab.addEventListener('click', () => {
	state.tab = tab.dataset.tab;
	$$('.svc-tab').forEach((x) => { const on = x === tab; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', String(on)); });
	$('#svc-tab-hint').hidden = state.tab !== 'in_progress';
	loadOrders();
}));
$('#svc-order-search').addEventListener('submit', (e) => { e.preventDefault(); loadOrders(); });
$('#svc-no-order-link').addEventListener('click', (e) => { e.preventDefault(); state.noOrder = true; state.orderId = null; state.order = null; state.items = {}; goto(2); });

async function loadOrder(id) {
	try {
		const res = await fetch(`/service/api/orders/${id}`, { headers: { 'X-Requested-With': 'fetch' } });
		if (res.status === 401) { window.location.href = '/user/login'; return false; }
		if (!res.ok) { showGlobal(t('err.order_forbidden')); announce(t('err.order_forbidden')); return false; }
		const data = await res.json();
		if (!data.state) { showGlobal(t('err.order_not_eligible')); return false; }
		state.order = data;
		state.orderId = data.order.id;
		if (!state.dirty.commission) state.commission = data.order.commission || '';
		if (!state.endClient) state.endClient = data.order.end_client || '';
		for (const id of Object.keys(state.items)) if (!data.items.some((it) => it.id === Number(id))) delete state.items[id];
		return true;
	} catch {
		showGlobal(t('err.server_error'));
		return false;
	}
}

// ── krok 2: rodzaj i pozycje ─────────────────────────────────────────────
function renderStep2() {
	const summary = $('#svc-order-summary');
	if (state.noOrder) {
		summary.innerHTML = `<strong>${esc(t('no_order_title'))}</strong><br>${esc(t('no_order_hint'))}`;
	} else if (state.order) {
		const o = state.order.order;
		summary.innerHTML = `<strong>#${esc(o.order_idx)}</strong> · ${esc(o.commission)}${o.end_client ? ` · ${esc(o.end_client)}` : ''} · ${esc(o.sent_date || '')} · <span class="svc-badge ${o.state === 'delivered' ? 'svc-badge--delivered' : ''}">${esc(statusLabel(o))}</span>`;
	}
	const eligible = rules.eligibleTypes(orderState());
	$$('.svc-type', $('#svc-types')).forEach((label) => {
		const type = label.dataset.type;
		const input = label.querySelector('input');
		const on = eligible.includes(type);
		label.classList.toggle('is-disabled', !on);
		input.disabled = !on;
		input.checked = state.type === type && on;
		if (!on && state.type === type) state.type = null;
	});
	const dep = $('#svc-department');
	dep.innerHTML = `<option value="">${esc(t('department_select'))}</option>` + DEPARTMENTS.map((d) => `<option value="${d.id}" ${String(state.departmentId) === String(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
	$('[name="orderNoText"]').value = state.orderNoText;
	$('[name="commission"]').value = state.commission;
	$('[name="deliveredAt"]').value = state.deliveredAt;
	$$('[name="carrierNoted"]').forEach((r) => { r.checked = String(state.carrierNoted) === r.value; });
	$('[name="quoteBeforeRepair"]').checked = !!state.quoteBeforeRepair;
	renderTypeDetails();
}

function renderKnown() {
	const box = $('#svc-known');
	const show = state.type === 'delivery' && !state.noOrder && state.order && !state.knownDismissed;
	box.hidden = !show;
	if (!show) return;
	const o = state.order.order;
	box.querySelector('[data-known="status"]').textContent = statusLabel(o);
	box.querySelector('[data-known="date"]').textContent = o.delivery_date || t('known_none');
	const parcels = o.parcels && o.parcels.length ? o.parcels : [];
	box.querySelector('[data-known="parcels"]').innerHTML = parcels.length
		? parcels.map((p) => (p.href ? `<a href="${esc(p.href)}" target="_blank" rel="noopener">${esc(p.fullCode || p.code)}</a>` : esc(p.fullCode || p.code))).join(', ')
		: esc(t('known_none'));
}

function renderTypeDetails() {
	const r = rule();
	const details = $('#svc-type-details');
	renderKnown();
	details.hidden = !r || !$('#svc-known').hidden;
	if (!r) return;
	$('#svc-no-order-fields').hidden = !state.noOrder;
	$('#svc-delivery-category').hidden = r.categoryPerItem;
	if (!r.categoryPerItem) {
		const sel = $('#svc-category');
		sel.innerHTML = `<option value="">${esc(t('category_select'))}</option>` + RULES.categories[r.categories].map((c) => `<option value="${c}" ${state.category === c ? 'selected' : ''}>${esc(t(`category.${c}`))}</option>`).join('');
	}
	$('#svc-positions-block').hidden = state.noOrder || !state.order;
	if (!state.noOrder && state.order) renderPositions();
	$('#svc-extra-transport').hidden = !r.extra.includes('delivered_at');
	$('#svc-extra-repair').hidden = !r.extra.includes('quote_before_repair');
	if (r.extra.includes('delivered_at') && !state.deliveredAt && state.order) {
		const dates = selectedItems().map((it) => it.src.shipping_date).filter(Boolean).sort();
		state.deliveredAt = dates.pop() || state.order.order.delivery_date || '';
		$('[name="deliveredAt"]').value = state.deliveredAt;
	}
	updateLateWarning();
}

function updateLateWarning() {
	$('#svc-late-warning').hidden = !rules.warnings(buildInput(), new Date()).includes('late_transport_report');
}

function renderPositions() {
	const r = rule();
	const body = $('#svc-positions');
	const cats = r ? RULES.categories[r.categories] : [];
	body.innerHTML = state.order.items.map((it) => {
		const sel = state.items[it.id];
		const dept = it.department ? (it.department[root.dataset.lang] || it.department.pl) : '—';
		const parcels = it.parcels.map((p) => (p.href ? `<a href="${esc(p.href)}" target="_blank" rel="noopener">${esc(p.code)}</a>` : esc(p.code))).join(', ');
		const pos = it.sub_positions.length ? `${it.pos} <span class="svc-muted">(${it.sub_positions.map(esc).join(', ')})</span>` : esc(String(it.pos));
		return `
		<tr class="svc-pos ${sel ? 'is-selected' : ''}" data-item-id="${it.id}">
			<td class="svc-col-check"><label class="svc-check"><input type="checkbox" data-item="${it.id}" ${sel ? 'checked' : ''} aria-label="${esc(t('col.pos'))} ${esc(String(it.pos))}"></label></td>
			<td data-label="${esc(t('col.pos'))}">${pos}</td>
			<td data-label="${esc(t('department'))}">${esc(dept)}</td>
			<td data-label="${esc(t('col.group'))}">${esc(it.group || '')}</td>
			<td data-label="${esc(t('col.summary'))}">${esc(it.summary)}${it.open_ticket ? `<br><span class="svc-pos-warning">${esc(t('open_ticket_warning', { number: it.open_ticket.number }))} <a href="/service/tickets/${it.open_ticket.id}" target="_blank" rel="noopener">${esc(it.open_ticket.number)}</a></span>` : ''}</td>
			<td data-label="${esc(t('col.qty'))}">${it.qty}</td>
			<td data-label="${esc(t('col.shipping'))}">${esc(it.shipping_date || '—')}</td>
			<td data-label="${esc(t('col.parcel'))}">${parcels || '—'}</td>
		</tr>
		<tr class="svc-pos-details" data-item-id="${it.id}" ${sel ? '' : 'hidden'}>
			<td colspan="8">
				<div class="svc-grid">
					<label class="svc-field"><span>${esc(t('qty_affected'))}</span><input type="number" name="qty" min="1" max="${it.qty}" inputmode="numeric" value="${sel ? esc(sel.qty) : it.qty}"><span class="svc-error" data-error-for="item-qty" hidden></span></label>
					${r && r.categoryPerItem ? `<label class="svc-field"><span>${esc(t('category_label'))} *</span><select name="category"><option value="">${esc(t('category_select'))}</option>${cats.map((c) => `<option value="${c}" ${sel && sel.category === c ? 'selected' : ''}>${esc(t(`category.${c}`))}</option>`).join('')}</select><span class="svc-error" data-error-for="item-category" hidden></span></label>` : ''}
					<label class="svc-field"><span>${esc(t('note'))}</span><input type="text" name="note" maxlength="500" value="${sel ? esc(sel.note || '') : ''}"><span class="svc-error" data-error-for="item-note" hidden></span></label>
				</div>
			</td>
		</tr>`;
	}).join('');
	body.querySelectorAll('input[data-item]').forEach((cb) => cb.addEventListener('change', () => toggleItem(Number(cb.dataset.item), cb.checked)));
	body.querySelectorAll('.svc-pos-details').forEach((row) => {
		const id = Number(row.dataset.itemId);
		row.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', () => {
			if (!state.items[id]) return;
			state.items[id][el.name] = el.value;
			if (el.name === 'qty' && rule() && rule().extra.includes('delivered_at')) updateLateWarning();
			saveDraft();
		}));
	});
	$('#svc-select-all').checked = state.order.items.length > 0 && state.order.items.every((it) => state.items[it.id]);
}

function toggleItem(id, on) {
	const it = state.order.items.find((x) => x.id === id);
	if (!it) return;
	if (on) state.items[id] = state.items[id] || { qty: it.qty, category: '', note: '' };
	else delete state.items[id];
	const main = $(`.svc-pos[data-item-id="${id}"]`);
	const details = $(`.svc-pos-details[data-item-id="${id}"]`);
	if (main) main.classList.toggle('is-selected', on);
	if (details) details.hidden = !on;
	$('#svc-select-all').checked = state.order.items.every((x) => state.items[x.id]);
	if (!state.deliveredAt && rule() && rule().extra.includes('delivered_at')) renderTypeDetails();
	saveDraft();
}

$('#svc-select-all').addEventListener('change', (e) => {
	state.order.items.forEach((it) => { if (e.target.checked) state.items[it.id] = state.items[it.id] || { qty: it.qty, category: '', note: '' }; else delete state.items[it.id]; });
	renderPositions();
	saveDraft();
});
$('#svc-types').addEventListener('change', (e) => {
	if (e.target.name !== 'type') return;
	state.type = e.target.value;
	state.knownDismissed = false;
	showFieldError('type', '');
	renderTypeDetails();
	saveDraft();
});
$('#svc-not-answered').addEventListener('click', () => { state.knownDismissed = true; renderTypeDetails(); $('[name="commission"]').focus(); });
$('#svc-type-details').addEventListener('input', (e) => {
	const el = e.target;
	if (!el.name || el.closest('.svc-pos-details')) return;
	if (el.name === 'carrierNoted') state.carrierNoted = el.value;
	else if (el.name === 'quoteBeforeRepair') state.quoteBeforeRepair = el.checked;
	else if (el.name in state) { state[el.name] = el.value; state.dirty[el.name] = true; }
	if (el.name === 'deliveredAt') updateLateWarning();
	saveDraft();
});

// ── krok 3 ───────────────────────────────────────────────────────────────
function renderStep3() {
	const r = rule();
	$('#svc-description-required').hidden = !(r && r.descriptionRequired) && !state.noOrder;
	const req = $('#svc-files-required');
	req.textContent = r ? (r.minFiles >= 2 ? t('files_required_two') : r.minFiles === 1 ? t('files_required_one') : r.filesRecommended ? t('files_recommended') : '') : '';
	for (const name of ['description', 'contactName', 'contactPhone', 'contactEmail', 'endClient', 'productAddress']) {
		const el = $(`[name="${name}"]`);
		if (el) el.value = state[name] || '';
	}
}
$('[data-panel="3"]').addEventListener('input', (e) => {
	const el = e.target;
	if (el.name && el.name in state) { state[el.name] = el.value; saveDraft(); }
});

// ── krok 4: podsumowanie ─────────────────────────────────────────────────
function section(title, step, bodyHtml) {
	return `<section><h3>${esc(title)} <button type="button" data-goto="${step}">${esc(t('change'))}</button></h3>${bodyHtml}</section>`;
}

function renderSummary() {
	const r = rule();
	const o = state.order && state.order.order;
	const dept = DEPARTMENTS.find((d) => String(d.id) === String(state.departmentId));
	const items = selectedItems();
	const warnings = rules.warnings(buildInput(), new Date()).map((w) => t(`warn.${w}`));
	const open = items.filter((it) => it.src.open_ticket).map((it) => t('open_ticket_warning', { number: it.src.open_ticket.number }));
	$('#svc-warnings').innerHTML = [...warnings, ...open].map((w) => `<p class="svc-warning">${esc(w)}</p>`).join('');
	const orderHtml = state.noOrder
		? `<p>${esc(t('no_order_title'))}${state.orderNoText ? ` · ${esc(t('order_no_text'))}: ${esc(state.orderNoText)}` : ''}${dept ? ` · ${esc(t('department'))}: ${esc(dept.name)}` : ''}</p>`
		: `<p><strong>#${esc(o.order_idx)}</strong> · ${esc(o.commission)} · ${esc(o.sent_date || '')}</p>`;
	const typeHtml = `<p><strong>${esc(t(`type.${state.type}`))}</strong>${!r.categoryPerItem && state.category ? ` · ${esc(t(`category.${state.category}`))}` : ''}</p><p>${esc(t('commission'))}: <strong>${esc(state.commission)}</strong></p>`
		+ (items.length ? `<ul>${items.map((it) => `<li>${esc(t('col.pos'))} ${esc(String(it.src.pos))} · ${esc(it.src.summary)} · ${esc(t('col.qty'))}: ${esc(it.qty)}${it.category ? ` · ${esc(t(`category.${it.category}`))}` : ''}${it.note ? ` · ${esc(it.note)}` : ''}</li>`).join('')}</ul>` : '')
		+ (r.extra.includes('delivered_at') ? `<p>${esc(t('delivered_at'))}: ${esc(state.deliveredAt || '—')} · ${esc(t('carrier_noted'))}: ${state.carrierNoted === '1' ? esc(t('yes')) : state.carrierNoted === '0' ? esc(t('no')) : '—'}</p>` : '')
		+ (r.extra.includes('quote_before_repair') ? `<p>${esc(t('quote_before_repair'))}: ${state.quoteBeforeRepair ? esc(t('yes')) : esc(t('no'))}</p>` : '');
	const detailsHtml = `${state.description ? `<p class="svc-prewrap">${esc(state.description)}</p>` : `<p class="svc-muted">—</p>`}<p>${esc(t('files'))}: ${picker.files.length}${picker.files.length ? ` (${picker.files.map((f) => esc(f.name)).join(', ')})` : ''}</p>`
		+ `<p>${esc(t('contact'))}: ${esc(state.contactName)} · ${esc(state.contactPhone)} · ${esc(state.contactEmail)}</p>${state.endClient ? `<p>${esc(t('end_client'))}: ${esc(state.endClient)}</p>` : ''}${state.productAddress ? `<p>${esc(t('product_address_short'))}: ${esc(state.productAddress)}</p>` : ''}`;
	$('#svc-summary').innerHTML = section(t('step.order'), 1, orderHtml) + section(t('step.type'), 2, typeHtml) + section(t('step.details'), 3, detailsHtml);
	$$('#svc-summary [data-goto]').forEach((b) => b.addEventListener('click', () => goto(Number(b.dataset.goto))));
	$('#svc-submit').disabled = false;
}

$('#svc-submit').addEventListener('click', async () => {
	const btn = $('#svc-submit');
	const errors = rules.validate(buildInput());
	if (!state.type) errors.unshift({ field: 'type', code: 'required' });
	if (errors.length) { goto(STEP_FIELDS[3].includes(errors[0].field) ? 3 : 2); renderErrors(errors); return; }
	btn.disabled = true;
	btn.textContent = t('sending');
	const fd = new FormData();
	fd.append('payload', JSON.stringify(payload()));
	picker.files.forEach((f) => fd.append('files', f, f.name));
	try {
		const res = await fetch('/service/api/tickets', { method: 'POST', body: fd, headers: { 'X-Requested-With': 'fetch' } });
		const data = await res.json().catch(() => ({}));
		if (res.ok && data.success) {
			sessionStorage.removeItem(draftKey);
			$('#svc-done-number').textContent = data.ticket.number;
			$('#svc-done-open').href = `/service/tickets/${data.ticket.id}`;
			$('#svc-done-demo').hidden = !data.demo;
			$('#svc-warnings').innerHTML = '';
			goto('done');
			announce(`${t('done_title')} ${data.ticket.number}`);
			return;
		}
		if (data.errors) { goto(STEP_FIELDS[3].includes(data.errors[0].field) ? 3 : 2); renderErrors(data.errors); }
		else {
			const msg = t(`err.${data.code || 'server_error'}`, { number: (data.ticket && data.ticket.number) || '' });
			showGlobal(msg);
			announce(msg);
			if (data.code === 'duplicate' && data.ticket) { $('#svc-global-error').innerHTML = `${esc(msg)} <a href="/service/tickets/${data.ticket.id}">${esc(data.ticket.number)}</a>`; }
		}
	} catch {
		showGlobal(t('err.server_error'));
	} finally {
		btn.disabled = false;
		btn.textContent = t('submit');
	}
});

// ── start ────────────────────────────────────────────────────────────────
(async function init() {
	if (state.noOrder) { goto(2); return; }
	if (preselected) {
		if (await loadOrder(preselected)) { goto(2); return; }
		state.orderId = null;
	}
	goto(1);
	loadOrders();
}());
