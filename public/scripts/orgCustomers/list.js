/**
 * Lista klientów organizacji — dwa drobiazgi nad działającym HTML-em.
 *
 * ⚠️ Sama lista, filtry, sortowanie i paginacja są serwerowe (zwykłe GET-y),
 * więc strona działa bez tego pliku. Skrypt dokłada tylko:
 *   1. potwierdzenie przed dezaktywacją (akcja odwracalna, ale myląca, gdy
 *      klient zniknie z domyślnie filtrowanej listy „aktywni"),
 *   2. eksport bez przeładowania, z wynikiem w toaście.
 */

import { showToast } from '/scripts/components/toast.js';

const table = document.getElementById('oc-table');

if (table) {
	for (const form of table.querySelectorAll('form[data-confirm]')) {
		form.addEventListener('submit', (event) => {
			if (!window.confirm(form.dataset.confirm)) event.preventDefault();
		});
	}

	for (const form of table.querySelectorAll('form[action$="/export"]')) {
		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			const button = form.querySelector('button');
			const label = button.textContent;
			button.disabled = true;
			button.textContent = '…';
			try {
				const response = await fetch(form.action, {
					method: 'POST',
					headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
				});
				const data = await response.json().catch(() => ({}));
				showToast(data.message || String(response.status), data.success ? 'success' : 'error');
			} catch (err) {
				showToast(String(err && err.message ? err.message : err), 'error');
			} finally {
				button.disabled = false;
				button.textContent = label;
			}
		});
	}
}
