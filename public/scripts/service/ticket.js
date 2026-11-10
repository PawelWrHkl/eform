/**
 * Podgląd zgłoszenia serwisowego — dopisek klienta (tekst i/lub pliki).
 * Serwer: POST /service/tickets/:id/messages → services/serviceTickets.addClientMessage.
 */
import { createFilePicker, describeErrors, esc } from './files.js';

const root = document.getElementById('svc-ticket');
const form = document.getElementById('svc-message-form');
if (root && form) {
	const S = JSON.parse(document.getElementById('svc-strings').textContent);
	const RULES = JSON.parse(document.getElementById('svc-rules').textContent);
	const t = (key, vars) => {
		let v = key.split('.').reduce((o, k) => (o || {})[k], S);
		if (typeof v !== 'string') return key;
		if (vars) v = v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
		return v;
	};
	const live = document.getElementById('svc-live');
	const errMessage = form.querySelector('[data-error-for="message"]');
	const errFiles = form.querySelector('[data-error-for="files"]');
	const existing = root.querySelectorAll('.svc-card .svc-files:not(.svc-files--picked) .svc-file').length;
	const picker = createFilePicker({
		root: form, listEl: form.querySelector('[data-files-list]'), limits: RULES.limits, t,
		startCount: existing,
		onChange: (files, bad) => {
			const msgs = describeErrors(bad, t);
			errFiles.textContent = msgs.join(' ');
			errFiles.hidden = !msgs.length;
		}
	});
	const submit = form.querySelector('[data-submit]');
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const message = form.message.value.trim();
		errMessage.hidden = true;
		if (!message && !picker.files.length) {
			errMessage.textContent = t('err.required');
			errMessage.hidden = false;
			form.message.focus();
			return;
		}
		submit.disabled = true;
		const fd = new FormData();
		fd.append('message', message);
		picker.files.forEach((f) => fd.append('files', f, f.name));
		try {
			const res = await fetch(`/service/tickets/${root.dataset.ticketId}/messages`, { method: 'POST', body: fd, headers: { 'X-Requested-With': 'fetch' } });
			const data = await res.json().catch(() => ({}));
			if (res.ok && data.success) {
				live.textContent = t('message_sent');
				window.location.reload();
				return;
			}
			const msgs = data.errors ? describeErrors(data.errors, t) : [t(`err.${data.code || 'server_error'}`)];
			errMessage.innerHTML = esc(msgs.join(' '));
			errMessage.hidden = false;
			live.textContent = msgs.join(' ');
		} catch (err) {
			errMessage.textContent = t('err.server_error');
			errMessage.hidden = false;
		} finally {
			submit.disabled = false;
		}
	});
}
