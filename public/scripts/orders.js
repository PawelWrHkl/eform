import { showToast } from "./components/toast.js";
import { createInfoDialog } from "./components/htmlManipulator.js";
// import { confirmPrompt } from "./components/confirmPrompt.js";
import { initSearchTool } from "./components/searchingTool.js";
import { validate } from './base.js'

const otherAddrFlag = { value: false };
const addrFlag = { value: false };

async function confirmMissingAddress() {
	const addrId = document.getElementById('address-select')?.value;

	return true;
}
async function prepareRestData() {

	const orderCommision = document.getElementById("commission-input").value;
	const comment = document.getElementById('comment').value;
	const addrId = document.getElementById('address-select').value;
	const mailId = document.getElementById('mail-select').value;

	const orderSendAddress = {
		'name': document.getElementById('sendName').value,
		'phone': document.getElementById('sendPhone').value,
		'email': document.getElementById('sendEmail').value,
		'street': document.getElementById("sendStreet").value,
		'city': document.getElementById("sendCity").value,
		'zip': document.getElementById("sendZip").value,
		'country': document.getElementById("sendCountry_code")?.value ?? '',

	}
	let body = JSON.stringify({
		commission: orderCommision,
		comment: comment,
		addrId: addrId,
		mailId: mailId,
		...(otherAddrFlag.value ? { orderSendAddress: orderSendAddress } : false)
	})
	return body;
}



/**
 * Spina zamówienie z odbiorcą końcowym (opcjonalna sekcja formularza).
 *
 * ⚠️ Osobne żądanie PO zapisie zamówienia, nie pole w `save-order`: walidacja
 * (czy odbiorca należy do właściciela zamówienia) siedzi w module faktur
 * i tam też jest jedyne miejsce zapisujące `order.end_client_id`. Moduł bywa
 * wyłączony — wtedy sekcji nie ma w HTML-u i ta funkcja nic nie robi.
 *
 * @param {number|string} orderId
 * @returns {Promise<void>}
 */
async function linkEndClient(orderId) {
	const checkbox = document.getElementById('end-client-checkbox');
	const hidden = document.getElementById('end-client-id');
	if (!checkbox || !hidden) return;

	// Odznaczony checkbox = ODPIĘCIE (null), nie „zostaw jak było" — inaczej
	// nie dałoby się cofnąć błędnego powiązania z poziomu edycji zamówienia.
	const endClientId = checkbox.checked && hidden.value ? Number(hidden.value) : null;
	if (!checkbox.checked && !hidden.dataset.wasLinked) return;

	try {
		const response = await fetch(`/api/v1/invoices/orders/${orderId}/end-client`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ endClientId })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			showToast('error', (body && body.message) || t('new-order.end_client_link_error'), 5);
		}
	} catch (error) {
		console.error(error);
		showToast('error', t('new-order.end_client_link_error'), 5);
	}
}

async function createOrder() {
	const requestBody = await prepareRestData();

	try {
		const response = await fetch("/orders/save-order", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: requestBody,
			isEmployee: window.isEmployee
		});
		const result = await response.json();

		if (result.redirect) {
			newOrderButton.disabled = true;
			// Powiązanie dopiero teraz — wcześniej nie było id zamówienia
			const newOrderId = String(result.redirect).split('/').pop();
			await linkEndClient(newOrderId);
			showToast('success', t('orders.saved_success_label'));
			setTimeout(() => {
				window.location.href = result.redirect;
			}, 500);

		}
	}

	catch (error) {
		console.error(error);
	}
}
async function updateOrder(orderId) {
	const requestBody = await prepareRestData();
	try {
		const response = await fetch(`/orders/update-order/${orderId}`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: requestBody,
		});
		const result = await response.json();

		if (result.redirect) {
			await linkEndClient(orderId);
			showToast('success', t('orders.saved_success_label'));
			window.location.href = result.redirect;
		}
	}
	catch (error) {
		console.error(error);
	}
}

const confirmationDialog = document.getElementById('delete-dialog');
const closeBtn = document.getElementById('cancel-btn');
const confirmBtn = document.getElementById('confirm-btn');
const statusInfo = document.getElementById('status-info');

async function deleteItem(path) {
	const res = await fetch(path, {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' }
	});
	if (!res.ok) throw new Error(`${t('order.error_word')}: ${res.statusText}`);
	const data = await res.json();
	statusInfo.innerHTML = t(data.message) + `. ${t('order.redirecting_word')}`;

	statusInfo.classList.add(data.success ? 'alert-success' : 'alert-danger');
	document.getElementById('for-sure').style.display = 'none';
	if (data.success) {
		closeBtn.hidden = confirmBtn.hidden = true;
		setTimeout(() => {
			if (path.includes('position')) location.reload();
			else window.location.href = '/orders';
		}, 300);
	}
}

function openDeleteDialog(btn) {
	confirmationDialog.showModal();
	closeBtn.onclick = () => confirmationDialog.close();
	confirmBtn.onclick = () => deleteItem(btn.dataset.href);
}

// Event delegation in capture phase — fires before <tr> onclick, works for static and dynamic buttons
document.addEventListener('click', (e) => {
	const deleteBtn = e.target.closest('.delete-position-btn');
	if (deleteBtn) { e.stopPropagation(); openDeleteDialog(deleteBtn); return; }

	const sendBtn = e.target.closest('.send-order-btn');
	if (sendBtn) { e.stopPropagation(); buildAndShowDialog(sendBtn, 'sendOrder'); return; }

	const submitApprovalBtn = e.target.closest('.submit-approval-btn');
	if (submitApprovalBtn) { e.stopPropagation(); buildAndShowDialog(submitApprovalBtn, 'submitForApproval'); return; }

	const copyBtn = e.target.closest('.copy-order-btn');
	if (copyBtn) { e.stopPropagation(); buildAndShowDialog(copyBtn, 'copyItem'); return; }
}, true);

async function copyItem(btn) {
	const orderId = btn.dataset.id;
	try {
		const response = await fetch(`/orders/copy/${orderId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' }
		});
		const result = await response.json();
		if (result.redirect) {
			showToast('success', t('orders.copied_success_label'));
			setTimeout(() => { window.location.href = result.redirect; }, 500);
		}
	} catch (error) {
		showToast('error', error.message);
	}
}


function buildAndShowDialog(btn, functionName) {
	const parent = document.getElementById('dialog-container');
	const title = functionName === 'sendOrder'
		? `${t('orders.send_order')}`
		: functionName === 'submitForApproval'
			? t('group.submit_for_approval_title')
			: functionName === 'copyItem'
				? `${t('orders.open_as_new')}`
				: "";
	const label = functionName === 'sendOrder'
		? `${t('orders.send_word')}`
		: functionName === 'submitForApproval'
			? t('orders.send_word')
			: functionName === 'copyItem'
				? `${t('orders.accept')}`
				: "";

	const { buttons, dialog } = createInfoDialog({
		title: title,
		message: `${t('orders.are_you_sure')}`,
		buttons: [
			{
				label: `${t('orders.abort')}`,
				className: "btn btn-secondary me-1",
				id: "cancel-btn"
			},
			{
				label: label,
				action: () => {
					if (functionName == 'sendOrder') {
						sendOrder(btn)
					}
					else if (functionName == 'submitForApproval') {
						submitForApproval(btn)
					}
					else if (functionName == 'copyItem') {
						copyItem(btn)
					}
				},
				className: "btn btn-success ms-1",
				id: "confirm-btn"
			}
		],
		parent
	});
}

async function submitForApproval(btn) {
	const orderId = btn.dataset.id;
	try {
		const response = await fetch(`/orders/submit-for-approval/${orderId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' }
		});
		const result = await response.json();
		if (result.success) {
			showToast('success', t('group.submit_for_approval_success'));
			setTimeout(() => { window.location.href = result.redirect || '/orders'; }, 1200);
		} else {
			showToast('error', result.message || t('group.error_server'));
		}
	} catch (e) {
		showToast('error', t('group.error_connection'));
	}
}

async function sendOrder(sendBtn) {
	const orderId = sendBtn.dataset.id
	try {
		const response = await fetch(`/orders/send/${orderId}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ status: 'sent' })
		});
		const result = await response.json();
		console.log(response)
		if (result.status === "success") {
			showToast('success', `${t('orders.send_success_label')}`);
			setTimeout(() => {
				window.location.href = result.redirect;
			}, 1500);

		}
		else {
			showToast('error', result.message);
		}
	}
	catch (error) {
		showToast('error', error);
	}
}

function toggleAddressDropdown(addrCheckId, addrClass) {
	const checkbox = document.getElementById(addrCheckId);
	const newAddrFields = document.querySelectorAll(addrClass);
	let addrFlag;
	if (checkbox.checked) {
		newAddrFields.forEach(row => row.classList.remove('d-none'));
		addrFlag = true
	} else {
		newAddrFields.forEach(row => row.classList.add('d-none'));
		addrFlag = false
	}
	return addrFlag
}

function setAddressSelectorsEnabled(enabled) {
	const addressSelect = document.getElementById('address-select');
	const mailSelect = document.getElementById('mail-select');
	const addressContainer = document.getElementById('address-dropdown-container');
	const mailContainer = document.getElementById('mail-dropdown-container');

	if (addressSelect) {
		addressSelect.disabled = !enabled;
		addressContainer?.classList.toggle('opacity-50', !enabled);
	}

	if (mailSelect) {
		mailSelect.disabled = !enabled;
		mailContainer?.classList.toggle('opacity-50', !enabled);
	}
}




const updateOrderButton = document.getElementById('update-order');
const newOrderButton = document.getElementById("save-order-btn");

if (updateOrderButton) {

	const orderId = updateOrderButton.dataset.id;
	updateOrderButton.addEventListener('click', async () => {
		if (validate('.validate') && await confirmMissingAddress()) {
			updateOrder(orderId)
		}
	})
}

else if (newOrderButton) {
	const runCreateOrder = async () => {
		if (validate('.validate') && await confirmMissingAddress()) {
			createOrder();
		}
	};

	newOrderButton.addEventListener('click', runCreateOrder);

	document.addEventListener('keydown', (event) => {

		if (event.key === 'Enter') {
			event.preventDefault();
			runCreateOrder();
		}
	});
}

function manageMutualCheckboxes(activeCheckboxId) {
	const showAddressesCheckbox = document.getElementById('show-addresses-checkbox');
	const showSendAddressCheckbox = document.getElementById('show-send-address-checkbox');

	if (activeCheckboxId === 'show-addresses-checkbox' && showAddressesCheckbox?.checked) {
		if (showSendAddressCheckbox) {
			showSendAddressCheckbox.checked = false;
			// Trigger change event to update UI
			showSendAddressCheckbox.dispatchEvent(new Event('change'));
		}
	} else if (activeCheckboxId === 'show-send-address-checkbox' && showSendAddressCheckbox?.checked) {
		if (showAddressesCheckbox) {
			showAddressesCheckbox.checked = false;
			// Trigger change event to update UI
			showAddressesCheckbox.dispatchEvent(new Event('change'));
		}
	}
}

document.getElementById('show-addresses-checkbox')?.addEventListener('change', () => {
	manageMutualCheckboxes('show-addresses-checkbox');
	addrFlag.value = toggleAddressDropdown('show-addresses-checkbox', '.new-addr');
	setAddressSelectorsEnabled(addrFlag.value);
});

const showAddressesCheckbox = document.getElementById('show-addresses-checkbox');
if (showAddressesCheckbox) {
	setAddressSelectorsEnabled(showAddressesCheckbox.checked);
}


document.getElementById('show-send-address-checkbox')?.addEventListener('change', () => {
	manageMutualCheckboxes('show-send-address-checkbox');
	otherAddrFlag.value = toggleAddressDropdown('show-send-address-checkbox', '.new-send-addr');
	const addressSelect = document.getElementById('address-select');
	const mailSelect = document.getElementById('mail-select');
	const addressContainer = document.getElementById('address-dropdown-container');
	if (addressSelect) {
		if (otherAddrFlag.value) {
			addressSelect.value = '';
			mailSelect.value = '';
			addressSelect.disabled = true;
			mailSelect.disabled = true;
			addressSelect.dispatchEvent(new Event('change'));
			mailSelect.dispatchEvent(new Event('change'));
			addressContainer?.classList.add('opacity-50');
		} else {
			addressSelect.disabled = false;
			mailSelect.disabled = false;
			addressContainer?.classList.remove('opacity-50');
		}
	}
});

const textarea = document.getElementById('comment');
const charCount = document.getElementById('charCount');

textarea?.addEventListener('input', function () {
	charCount.textContent = `${this.value.length}/250`;
});

function escapeHtml(str) {
	return String(str ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const searchMount = document.getElementById('orders-search-mount');
const isSent = searchMount?.dataset.sent === 'true';
const isEmployee = searchMount?.dataset.isEmployee === 'true';
const isOrganization = searchMount?.dataset.organization === 'true';
const orderPath = isSent ? '/orders/history/order' : '/orders/order';

function renderTableRow(order) {
	const id = escapeHtml(String(order.id));

	// Render tracking numbers with dropdown
	let trackingCell = '';
	if (isSent) {
		let trackingHTML = '<span class="text-muted">-</span>';
		if (order.parsedSpeditionNumbers && order.parsedSpeditionNumbers.length > 0) {
			const items = order.parsedSpeditionNumbers.filter(tr => tr.carrier).map(tracking => {
				if (tracking.href) {
					return `<li><a class="dropdown-item d-flex align-items-center" href="${escapeHtml(tracking.href)}" target="_blank" rel="noopener noreferrer">
						<span class="badge bg-primary me-2">${escapeHtml(tracking.carrier)}</span>
						<span>${escapeHtml(tracking.code)}</span>
						<i class="bi bi-box-arrow-up-right ms-auto text-muted" style="font-size: 0.85rem;"></i>
					</a></li>`;
				} else {
					return `<li><span class="dropdown-item text-muted d-flex align-items-center">
						<span class="badge bg-secondary me-2">${escapeHtml(tracking.carrier)}</span>
						<span>${escapeHtml(tracking.code || tracking.fullCode)}</span>
					</span></li>`;
				}
			}).join('');
			trackingHTML = `<div class="dropdown" onclick="event.stopPropagation()">
				<button class="btn btn-sm dropdown-toggle" type="button" id="trackingDropdown${id}" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false">
					${order.parsedSpeditionNumbers.length} ${escapeHtml(t('orders.tracking_parcels') || 'przesyłek')}
				</button>
				<ul class="dropdown-menu" aria-labelledby="trackingDropdown${id}">${items}</ul>
			</div>`;
		}
		trackingCell = `<td>${trackingHTML}</td>`;
	}

	const extraCells = isSent ? `
		<td>${escapeHtml(order.sent_date)}</td>
		<th scope="row" data-prod-status="${escapeHtml(order.prod_status || '')}">${order.prod_status ? escapeHtml(t(order.prod_status)) : escapeHtml(t('order.status_order_sent'))}</th>
		<th scope="row">${order.delivery_date ? escapeHtml(order.delivery_date) : (!order.prod_status && order.max_prod_days ? escapeHtml(order.max_prod_days + ' ' + t('termin.days')) : '-')}</th>
		${trackingCell}
		<td>
			<button class="btn btn-outline-secondary copy-order-btn stop-propagation" data-id="${id}" onclick="event.stopPropagation()">${escapeHtml(t('orders.reorder'))}</button>
		</td>` : '';

	const actionBtns = (!isSent && !isEmployee) ? `
		<td class="buttons">
			<button class="action-btn action-btn-delete p-1 delete-position-btn stop-propagation has-tooltip"
				data-tooltip="${escapeHtml(t('orders.delete_order'))}"
				data-href="/orders/order/${id}/delete" type="button" onclick="event.stopPropagation()">
				<img src="/img/delete.png" style="height:24px;"/>
			</button>
			<a class="action-btn action-btn-edit p-1 stop-propagation has-tooltip"
				data-tooltip="${escapeHtml(t('orders.edit_order_tooltip'))}" href="/orders/edit/${id}">
				<img src="/img/edit-text.png">
			</a>
			<button class="action-btn action-btn-send p-1 stop-propagation send-order-btn has-tooltip"
				data-tooltip="${escapeHtml(t('orders.send_order_tooltip'))}"
				type="button" data-id="${id}">
				<img src="/img/send.png">
			</button>
		</td>` : '';

	return `<tr onclick="window.location.href='${orderPath}/${id}'" class="order-row" data-commission="${escapeHtml(order.commision)}">
		<th scope="row">${escapeHtml(order.order_idx)}</th>
		${isOrganization ? `<td>${escapeHtml(order.user_ident || '')}${order.user_name ? ` (${escapeHtml(order.user_name)})` : ''}</td>` : ''}
		<td>${escapeHtml(order.commision)}${order.name ? ` (${escapeHtml(order.name)} ${escapeHtml(order.surname)})` : ''}</td>
		<td>${escapeHtml(order.created_date)}</td>
		${extraCells}${actionBtns}
	</tr>`;
}

function renderMobileCard(order) {
	const id = escapeHtml(String(order.id));

	// Render tracking numbers for mobile
	let trackingHTML = '';
	if (isSent && order.parsedSpeditionNumbers && order.parsedSpeditionNumbers.length > 0) {
		const items = order.parsedSpeditionNumbers.filter(tr => tr.carrier).map(tracking => {
			if (tracking.href) {
				return `<li><a class="dropdown-item d-flex align-items-center" href="${escapeHtml(tracking.href)}" target="_blank" rel="noopener noreferrer">
					<span class="badge bg-primary me-2">${escapeHtml(tracking.carrier)}</span>
					<span>${escapeHtml(tracking.code)}</span>
				</a></li>`;
			} else {
				return `<li><span class="dropdown-item text-muted d-flex align-items-center">
					<span class="badge bg-secondary me-2">${escapeHtml(tracking.carrier)}</span>
					<span>${escapeHtml(tracking.code || tracking.fullCode)}</span>
				</span></li>`;
			}
		}).join('');
		trackingHTML = `<div class="dropdown" onclick="event.stopPropagation()">
			<button class="btn btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false">
				${order.parsedSpeditionNumbers.length} ${escapeHtml(t('orders.tracking_parcels') || 'przesyłek')}
			</button>
			<ul class="dropdown-menu">${items}</ul>
		</div>`;
	}

	const extraInfo = isSent ? `
		<div class="mobile-order-extra">
			<span>${escapeHtml(order.sent_date)}</span>
			<span>${order.prod_status ? escapeHtml(t(order.prod_status)) : escapeHtml(t('order.status_order_sent'))}</span>
			<span>${order.delivery_date ? escapeHtml(order.delivery_date) : (!order.prod_status && order.max_prod_days ? escapeHtml(order.max_prod_days + ' ' + t('termin.days')) : '-')}</span>
		</div>
		${trackingHTML}` : '';

	const actions = isSent
		? `<button class="btn btn-outline-secondary copy-order-btn stop-propagation" data-id="${id}" onclick="event.stopPropagation()">${escapeHtml(t('orders.reorder'))}</button>`
		: (!isEmployee ? `
			<button class="action-btn action-btn-delete delete-position-btn stop-propagation"
				data-href="/orders/order/${id}/delete" type="button" onclick="event.stopPropagation()">
				${escapeHtml(t('orders.delete'))}
			</button>
			<a class="action-btn action-btn-edit stop-propagation" href="/orders/edit/${id}">${escapeHtml(t('orders.edit'))}</a>
			<button class="action-btn action-btn-send stop-propagation send-order-btn" type="button" data-id="${id}">${escapeHtml(t('orders.send'))}</button>` : '');

	return `<div class="mobile-order-card" data-commission="${escapeHtml(order.commision)}" onclick="window.location.href='${orderPath}/${id}'">
		<div class="mobile-order-header">
			<span class="mobile-order-number">#${escapeHtml(order.order_idx)}</span>
			<span class="mobile-order-date">${escapeHtml(order.created_date)}</span>
		</div>
		<div class="mobile-order-commission">${escapeHtml(order.commision)}</div>
		${isOrganization && order.user_ident ? `<div class="mobile-order-client text-muted" style="font-size:0.85rem;">${escapeHtml(order.user_ident)}${order.user_name ? ` (${escapeHtml(order.user_name)})` : ''}</div>` : ''}
		${extraInfo}
		<div class="mobile-order-actions">${actions}</div>
	</div>`;
}

// Populate status select from initial server-rendered rows (sent orders only)
if (isSent) {
	const statusSelect = document.getElementById('filter-prod-status');
	if (statusSelect) {
		const statusCells = document.querySelectorAll('[data-prod-status]');
		const unique = new Set();
		statusCells.forEach(el => {
			const raw = el.dataset.prodStatus;
			if (raw) unique.add(raw);
		});
		unique.forEach(raw => {
			const opt = document.createElement('option');
			opt.value = raw;
			opt.textContent = t(raw) || raw;
			statusSelect.appendChild(opt);
		});
	}
}

initSearchTool({
	mountSelector: '#orders-search-mount',
	placeholder: t('orders.search_placeholder') || 'Szukaj...',
	apiUrl: '/orders/search',
	tableBodySelector: '.d-none.d-md-table tbody',
	mobileListSelector: '.mobile-orders-list',
	paginationSelector: 'nav[aria-label="Paginate"]',
	debounceMs: 300,
	renderTableRow,
	renderMobileCard
});

// Disable row transform while Bootstrap dropdown is open
document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.order-row .dropdown').forEach(function (dropdown) {
        const row = dropdown.closest('.order-row');
        if (!row) return;
        dropdown.addEventListener('show.bs.dropdown', function () { row.classList.add('dropdown-active'); });
        dropdown.addEventListener('hide.bs.dropdown', function () { row.classList.remove('dropdown-active'); });
    });
});