/**
 * Formularz klienta organizacji — warstwa wygody nad działającym formularzem HTML.
 *
 * ⚠️ PROGRESSIVE ENHANCEMENT: bez tego pliku strona nadal działa — to zwykły
 * `<form method="post">`, a serwer waliduje wszystko od nowa. Skrypt dokłada
 * cztery rzeczy i żadna z nich nie jest warunkiem zapisu:
 *   1. inline-walidację (komunikat pod polem, zanim operator kliknie „Zapisz"),
 *   2. zapis bez przeładowania + stan „Zapisywanie…",
 *   3. przełącznik „adres dostawy taki sam jak rejestrowy",
 *   4. podsumowanie błędów u góry formularza z przewinięciem do pierwszego pola.
 *
 * Reguły walidacji są TE SAME co na serwerze (`services/orgCustomers/validator.js`)
 * — wzorce przychodzą w atrybutach `pattern`, więc nie ma tu drugiej,
 * rozjeżdżającej się kopii reguł.
 */

import { showToast } from '/scripts/components/toast.js';

/** @returns {Record<string, any>} */
function labels() {
	const node = document.getElementById('oc-labels');
	if (!node) return { errors: {} };
	try {
		return JSON.parse(node.textContent || '{}');
	} catch {
		return { errors: {} };
	}
}

const L = labels();
const form = document.getElementById('oc-form');
const submitButton = document.getElementById('oc-submit');
const flash = document.getElementById('oc-flash');

if (form) {
	setUpDeliveryToggle();
	setUpInlineValidation();
	setUpSubmit();
}

/* ------------------------------------------------------------ walidacja */

/**
 * Komunikat pod polem. Pusty tekst = czyszczenie (pole wróciło do porządku).
 *
 * @param {HTMLElement} input
 * @param {string} message
 */
function setMessage(input, message) {
	const slot = form.querySelector(`.oc-msg[data-for="${input.name}"]`);
	input.classList.toggle('is-invalid', !!message);
	input.setAttribute('aria-invalid', message ? 'true' : 'false');
	if (slot) slot.textContent = message || '';
}

/**
 * Walidacja pojedynczego pola oparta o atrybuty HTML (`required`, `pattern`,
 * `min`, `max`, `type`) — czyli o te same reguły, które i tak wymusza serwer.
 *
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} input
 * @returns {boolean}
 */
function validateField(input) {
	if (input.type === 'hidden' || input.disabled || input.readOnly) return true;

	// `checkValidity` obsługuje required/pattern/min/max/type=email — nie ma
	// powodu pisać tego drugi raz ręcznie.
	if (input.checkValidity()) {
		setMessage(input, '');
		return true;
	}

	const key = input.validity.valueMissing ? 'required' : `${input.name}_invalid`;
	const message = input.validity.valueMissing
		? (L.required || 'required')
		: ((L.errors && L.errors[key]) || input.validationMessage);
	setMessage(input, message);
	return false;
}

function setUpInlineValidation() {
	for (const input of form.querySelectorAll('input, select, textarea')) {
		// `blur`, nie `input`: komunikat w trakcie pisania krzyczy o błędzie,
		// zanim użytkownik skończy wpisywać wartość.
		input.addEventListener('blur', () => validateField(input));
		input.addEventListener('input', () => {
			if (input.classList.contains('is-invalid')) validateField(input);
		});
	}
}

/* ------------------------------------------------------------- adresy */

/**
 * „Taki sam jak rejestrowy" — chowa blok adresu dostawy i przepisuje wartości
 * przy zapisie (serwer robi to samo, więc wyłączony JS niczego nie psuje).
 */
function setUpDeliveryToggle() {
	const toggle = form.querySelector('[name="delivery_same_as_registered"]');
	const block = document.getElementById('oc-delivery');
	if (!toggle || !block) return;

	const apply = () => {
		block.hidden = toggle.checked;
	};
	toggle.addEventListener('change', apply);
	apply();
}

/* --------------------------------------------------------------- zapis */

function setFlash(kind, message) {
	if (!flash) return;
	flash.innerHTML = '';
	const box = document.createElement('div');
	box.className = kind === 'ok' ? 'oc-flash__ok' : 'oc-flash__err';
	box.textContent = message;
	flash.appendChild(box);
	// Komunikat na górze formularza bywa poza ekranem, gdy błąd wyskoczy
	// przy ostatniej sekcji — bez tego użytkownik widzi „nic się nie stało".
	flash.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setBusy(busy) {
	if (!submitButton) return;
	submitButton.disabled = busy;
	submitButton.dataset.label = submitButton.dataset.label || submitButton.textContent.trim();
	submitButton.textContent = busy ? (submitButton.dataset.saving || '…') : submitButton.dataset.label;
}

function setUpSubmit() {
	form.addEventListener('submit', async (event) => {
		const fields = [...form.querySelectorAll('input, select, textarea')];
		const invalid = fields.filter((input) => !validateField(input));
		if (invalid.length) {
			event.preventDefault();
			invalid[0].focus();
			setFlash('err', (L.errors && L.errors.unexpected) || '');
			return;
		}

		event.preventDefault();
		setBusy(true);
		try {
			// ⚠️ `URLSearchParams`, NIE `FormData`. `fetch` z `FormData` wysyła
			// `multipart/form-data`, a serwer ma zamontowane wyłącznie
			// `bodyParser.json` i `bodyParser.urlencoded` (server.js) — żadnego
			// multera. Efekt był mylący: `req.body` przychodził PUSTY, więc
			// walidator zgłaszał „podaj nazwę klienta" nad wypełnionym polem.
			// Kodowanie urlencoded to zresztą dokładnie to, co wysyła ten sam
			// formularz przy wyłączonym JS — jedna ścieżka danych zamiast dwóch.
			const response = await fetch(form.action, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'X-Requested-With': 'XMLHttpRequest',
					'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
				},
				body: new URLSearchParams(new FormData(form)).toString()
			});
			const data = await response.json().catch(() => ({}));

			if (!response.ok || !data.success) {
				const messages = (data.messages || []).join(' • ') || (L.errors && L.errors.unexpected);
				setFlash('err', messages);
				showToast(messages, 'error');
				return;
			}

			showToast(data.message || L.saved, 'success');

			// ⚠️ Po ZAŁOŻENIU klienta nie przekierowujemy od razu: identyfikator,
			// PIN i hasło pokazujemy jeden jedyny raz (hasła nie trzymamy w postaci
			// jawnej), więc automatyczne przejście dalej skasowałoby je z ekranu.
			// Zamiast tego formularz ustępuje miejsca ekranowi potwierdzenia
			// z danymi do skopiowania i JAWNYMI krokami dalej — wcześniej zostawał
			// tu tylko zielony pasek i użytkownik nie wiedział, co się stało.
			if (data.generatedPassword) {
				showCreatedPanel(data);
				return;
			}

			setFlash('ok', data.message || L.saved);
		} catch (err) {
			setFlash('err', (L.errors && L.errors.unexpected) || String(err));
		} finally {
			setBusy(false);
		}
	});
}

/* ------------------------------------------------- ekran po utworzeniu */

/**
 * Wiersz „etykieta + wartość + Kopiuj". Przycisk kopiowania jest tu istotny:
 * operator zwykle przekazuje te dane dalej (mail, telefon), a przepisywanie
 * 12-znakowego hasła z ekranu to prosta droga do literówki.
 *
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function credentialRow(label, value) {
	const row = document.createElement('div');
	row.className = 'oc-cred';

	const name = document.createElement('span');
	name.className = 'oc-label';
	name.textContent = label;

	const box = document.createElement('div');
	box.className = 'oc-cred__box';

	const code = document.createElement('code');
	code.className = 'oc-value';
	code.textContent = value;

	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'oc-btn oc-btn--small oc-btn--ghost';
	button.textContent = L.copy || 'Kopiuj';
	button.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(value);
			button.textContent = L.copied || 'OK';
			setTimeout(() => { button.textContent = L.copy || 'Kopiuj'; }, 1500);
		} catch {
			// Schowek bywa zablokowany (brak HTTPS, uprawnienia) — wtedy
			// zaznaczamy tekst, żeby wystarczyło Ctrl+C.
			const range = document.createRange();
			range.selectNodeContents(code);
			window.getSelection().removeAllRanges();
			window.getSelection().addRange(range);
		}
	});

	box.append(code, button);
	row.append(name, box);
	return row;
}

/**
 * Zastępuje formularz potwierdzeniem z danymi logowania i krokami dalej.
 *
 * @param {{ userId: number, ident: string, pin: string, generatedPassword: string }} data
 */
function showCreatedPanel(data) {
	const panel = document.createElement('section');
	panel.className = 'oc-card oc-created';

	const title = document.createElement('h3');
	title.className = 'oc-card__title';
	title.textContent = L.created_title || '';

	const note = document.createElement('p');
	note.className = 'oc-section-hint';
	note.textContent = L.created_note || '';

	const creds = document.createElement('div');
	creds.className = 'oc-cred-grid';
	creds.append(
		credentialRow(L.ident || 'ident', data.ident || ''),
		credentialRow(L.pin || 'pin', data.pin || ''),
		credentialRow(L.password || 'password', data.generatedPassword || '')
	);

	const actions = document.createElement('div');
	actions.className = 'oc-created__actions';
	const link = (href, text, cls) => {
		const a = document.createElement('a');
		a.href = href;
		a.className = `oc-btn ${cls}`;
		a.textContent = text;
		return a;
	};
	actions.append(
		link(`/org/customers/${data.userId}`, L.go_to_customer || '', 'oc-btn--accent'),
		link('/org/customers/new', L.add_another || '', 'oc-btn--ghost'),
		link('/org/customers', L.back_to_list || '', 'oc-btn--ghost')
	);

	panel.append(title, note, creds, actions);
	form.replaceWith(panel);
	if (flash) flash.innerHTML = '';
	panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
