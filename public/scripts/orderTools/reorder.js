/**
 * „Zamów ponownie” / „Kopiuj ofertę” — kopia zlecenia jako nowa oferta.
 * Serwer: POST /orders/copy/:orderId. Jedna funkcja dla list (orders.js)
 * i podglądu anulowanego zlecenia (orderCancel.js).
 */
import { showToast } from "../components/toast.js";
import { createInfoDialog } from "../components/htmlManipulator.js";

async function copyOrder(btn) {
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

export function openReorderDialog(btn) {
	createInfoDialog({
		title: t('orders.open_as_new'),
		message: t('orders.are_you_sure'),
		buttons: [
			{
				label: t('orders.abort'),
				className: "btn btn-secondary me-1",
				id: "cancel-btn"
			},
			{
				label: t('orders.accept'),
				action: () => copyOrder(btn),
				className: "btn btn-success ms-1",
				id: "confirm-btn"
			}
		],
		parent: document.getElementById('dialog-container')
	});
}
