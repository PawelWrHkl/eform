/**
 * Wybór plików do zgłoszenia serwisowego (kreator i dopisek): aparat na telefonie,
 * „dodaj pliki”, przeciągnij i upuść, miniatury z usuwaniem, limity widoczne od razu.
 * Typ sprawdza ostatecznie SERWER po sygnaturze — tu tylko szybka podpowiedź dla klienta.
 */
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;
const OTHER_EXT = /\.(pdf|mp4|mov)$/i;

export function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
	return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * @param {object} o { root, listEl, limits: {maxFiles, maxFileBytes}, t: (key, vars) => string, onChange(files, errors), startCount }
 * @returns {{ files: File[], errors: () => Array, reset: () => void }}
 */
export function createFilePicker({ root, listEl, limits, t, onChange, startCount = 0 }) {
	const files = [];
	const bad = [];

	function accepted(file) {
		if (file.size > limits.maxFileBytes) return 'file_too_big';
		const name = file.name || '';
		const type = file.type || '';
		if (type.startsWith('image/') || IMAGE_EXT.test(name)) return null;
		if (['video/mp4', 'video/quicktime', 'application/pdf'].includes(type) || OTHER_EXT.test(name)) return null;
		return 'file_type';
	}

	function add(list) {
		bad.length = 0;
		for (const f of list) {
			if (startCount + files.length >= limits.maxFiles) { bad.push({ code: 'too_many_files', name: f.name }); break; }
			const code = accepted(f);
			if (code) { bad.push({ code, name: f.name }); continue; }
			files.push(f);
		}
		render();
		onChange(files, bad);
	}

	function remove(idx) {
		const [f] = files.splice(idx, 1);
		if (f && f.__url) URL.revokeObjectURL(f.__url);
		render();
		onChange(files, bad);
	}

	function render() {
		listEl.innerHTML = '';
		files.forEach((f, idx) => {
			const li = document.createElement('li');
			li.className = 'svc-file';
			const isImg = (f.type || '').startsWith('image/') && !/heic|heif/i.test(f.type + f.name);
			if (isImg) {
				f.__url = f.__url || URL.createObjectURL(f);
				li.innerHTML = `<img src="${f.__url}" alt="">`;
			} else {
				const ext = (f.name.split('.').pop() || '').slice(0, 4).toUpperCase();
				li.innerHTML = `<span class="svc-file-icon" aria-hidden="true">${esc(ext)}</span>`;
			}
			li.insertAdjacentHTML('beforeend', `<span class="svc-file-name" title="${esc(f.name)}">${esc(f.name)} · ${formatBytes(f.size)}</span><button type="button" class="svc-file-remove" aria-label="${esc(t('remove_file'))} ${esc(f.name)}">×</button>`);
			li.querySelector('.svc-file-remove').addEventListener('click', () => remove(idx));
			listEl.appendChild(li);
		});
	}

	root.querySelectorAll('input[type="file"][data-add-files]').forEach((input) => {
		input.addEventListener('change', () => { add(Array.from(input.files || [])); input.value = ''; });
	});
	const drop = root.querySelector('.svc-dropzone');
	if (drop) {
		['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
		['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
		drop.addEventListener('drop', (e) => add(Array.from(e.dataTransfer && e.dataTransfer.files || [])));
		drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const inp = root.querySelector('input[type="file"][multiple]'); if (inp) inp.click(); } });
	}

	return { files, errors: () => bad.slice(), reset: () => { files.splice(0); bad.length = 0; render(); } };
}

/** Komunikaty błędów z kodów (`service.err.<code>`), z nazwą pliku gdy jest. */
export function describeErrors(errors, t) {
	return errors.map((e) => t(`err.${e.code}`, { name: e.name || '', number: e.number || '' }));
}
