import {
	generateForm,
	buildCommentSpace,
	buildVatFields,
	recalculateLastChangedField,
	getTotal
} from "/scripts/form.js";
import {
	resetSelectValues,
	processCommissionInput,
	checkFlags
} from "/scripts/formTools/formTools.js";
import { buildOrderItemStructure } from '/scripts/orderBuilder.js';
import { sendFormDataWithAttachments } from '/scripts/formTools/formDataHelper.js';
import { showToast } from "/scripts/components/toast.js";
import { FormsManager } from './formTools/getAvailableForms.js'
import { createElement } from './components/htmlManipulator.js'
import { createChecboxField, checkBoxReaction, createLastConfigInfoPopUp } from './components/lastGroupSelected.js'
import { validateAllFieldsOnSubmit } from './formTools/validateUtils.js'
import { validate } from './base.js'
import { getLocalPositionObject, checkIfLocalPositionObjectExists } from './formTools/localStorageManager.js'
import { startSpin, stopSpin } from "./components/hourglass.js";


const asortmentGroupSelect = document.getElementById("asortment-group-select");
const departmentSelect = document.getElementById("department-select");
const formContainer = document.getElementById("dynamic-form");
const attachmentContainer = document.getElementById('attachment-container');
const attachmentsLabel = document.querySelector('.attachment-label');
let sentState = false;
let isPreparingForm = false; 

function initialize() {
	console.log('initialize')
	window.formsManager = new FormsManager();
	setupGlobalListeners();
	loadJsonConfig()
	processCommissionInput(false);
	
	(async () => {
		if (performance.getEntriesByType("navigation")[0].type === "reload") {
			await refreshFormBehaviour();
		}
	})();
}


async function loadJsonConfig() {
	console.log('loadJsonConfig')
	const departments = await fetchDepartments();
	const { asortmentGroupSelect, departmentSelect } = buildMainSelect(departments);
}

export async function buildMainSelect(files) {
	const inputContainer = document.querySelector(".asortment-inputs");
	createChecboxField(inputContainer);

	
	const { container, lastConfigButton } = createLastConfigInfoPopUp();
	window.lastConfigButton = lastConfigButton
	lastConfigButton.addEventListener('click', async () => {
		console.log('🎯 Kliknięto przycisk ładowania ostatniej konfiguracji');
		let config = getLocalPositionObject();
		console.log('📦 Pobrana konfiguracja:', config);

		if (!config) {
			container.style.display = 'none';

		}

		await refreshFormBehaviour(config);
		container.style.display = 'none';
	});

	
	const hasConfig = checkIfLocalPositionObjectExists();
	if (hasConfig) {
		container.style.display = 'flex';
	} else {
		container.style.display = 'none';
	}

	departmentSelect.innerHTML = `<option value="" disabled selected>${t("form.department_label")}</option>`;
	
	for (let department of files) {
		const groups = await window.formsManager.getGroups(department.num);
		console.log('Znalezione grupy:', groups);
		if (groups.length > 0) {
			createElement("option", { value: department.num, text: department.description }, departmentSelect);
		}
	}

	departmentSelect.addEventListener("change", async () => {
		formContainer.innerHTML = "";
		attachmentContainer.innerHTML = '';
		attachmentsLabel.textContent = '';

		const selectedDepartment = departmentSelect.value;
		await buildGroupSelect(selectedDepartment, asortmentGroupSelect);
	});

	return { asortmentGroupSelect, departmentSelect };
}


async function buildGroupSelect(selectedDepartment, asortmentGroupSelect) {
	const groups = await window.formsManager.getGroups(selectedDepartment);

	asortmentGroupSelect.innerHTML = `<option value="" disabled selected>${t("form.group_label")}</option>`;

	for (let group of groups) {

		const option = createElement("option", {
			value: group.code,
			text: group.description
		}, asortmentGroupSelect);

		if (groups.length === 1) {
			option.selected = true;
			await prepareForm(group.code, selectedDepartment);
		}
	}

	
	asortmentGroupSelect.addEventListener("change", async () => {
		await prepareForm(asortmentGroupSelect.value, selectedDepartment);
	});

	return asortmentGroupSelect;
}

async function fetchDepartments() {
	console.log('fetchDepartments')
	const departments = await window.formsManager.getAvailableForms();
	console.log('Fetched departments:', departments);
	return departments;
}

function saveChoiceToLocalStorage() {
	console.log('saveChoiceToLocalStorage')
	const choice = {
		department: departmentSelect.value,
		group: asortmentGroupSelect.value
	};
	localStorage.setItem("lastChoice", JSON.stringify(choice));
}

function setupMainSelectListener(asortmentGroupSelect, departmentSelect) {
	console.log('setupMainSelectListener');
	if (!departmentSelect || !asortmentGroupSelect) return;

	departmentSelect.addEventListener("change", async () => {
		
		formContainer.innerHTML = "";
		const selectedDepartment = departmentSelect.value;
		await buildGroupSelect(selectedDepartment, asortmentGroupSelect);
	});

	asortmentGroupSelect.addEventListener("change", async () => {
		await prepareForm(asortmentGroupSelect.value, departmentSelect.value);
	});
}


async function prepareForm(asortmentGroup, department, config = null) {
	if (isPreparingForm) {
		console.warn("prepareForm is already in progress. Skipping duplicate call.");
		return;
	}

	isPreparingForm = true; 

	try {
		window.formsManager.setCurrentRootPath(asortmentGroup);
		window.formsManager.setCurrentGroup(asortmentGroup);
		saveChoiceToLocalStorage();
		const groupNumber = asortmentGroup;
		let version = await getAppVersion(groupNumber);
		showOrderReminder();
		await buildDynamicForm(version, groupNumber, config);
	} catch (err) {
		handleFormLoadError(err);
	} finally {
		isPreparingForm = false; 
	}
}
function showOrderReminder() {
	const hiddenClass = document.querySelector('.order-reminder');
	hiddenClass.style.setProperty('display', 'block', 'important');
}


async function buildDynamicForm(version, groupNumber, config = null) {

	showVersion(version);
	let lastConfigDiv = document.getElementById('last-config-info')
	lastConfigDiv.style.display = 'none'
	let inputs, values, valuesToDisplay;
	if (config && config.values && config.displayValues) {
		console.log('🔄 Ładowanie z konfiguracją:', config);
		[inputs, values, valuesToDisplay] = await generateForm(
			version,
			groupNumber,
			config.values,
			config.displayValues,
			true
		);
		window.finishFlag = true;
	} else {
		[inputs, values, valuesToDisplay] = await generateForm(version, groupNumber);
	}

	const orderId = document.getElementById('orderId').textContent;
	const comment = buildCommentSpace(formContainer);
	buildVatFields(formContainer);
	setTimeout(() => {
		console.log('siema eniu shortjson')

		setupShowButton(inputs, values, valuesToDisplay, orderId, comment, version, groupNumber);

		setupResetButton(inputs, values, valuesToDisplay);
	}, 10000);
}

function setupShowButton(inputs, values, valuesToDisplay, orderId, comment, version, groupNumber) {
	console.log('setupShowButton')
	console.log('inputs object keys:', Object.keys(inputs));
	
	const fileInputsInObject = Object.values(inputs).filter(inp => inp?.type === 'file');
	console.log('File inputs w obiekcie inputs:', fileInputsInObject.length);
	fileInputsInObject.forEach((inp, i) => {
		console.log(`  File input ${i}: name="${inp.name}", id="${inp.id}"`);
	});

	const showButton = document.getElementById('show-button');

	showButton.onclick = async function () {
		setTimeout(async () => {
			if (!await validateForm(inputs, values)) {

				showToast('error', t("form.incorrect_data"));
				return;
			}
			showToast('success', `${t('form.saved_form_success')}`);
			if (!sentState && window.finishFlag == true) {
				recalculateLastChangedField();
				setTimeout(async () => {
					await sendData(inputs, values, valuesToDisplay, orderId, comment, version, groupNumber);
					sentState = true;
				}, 1200);
			}
			else {
				startSpin();
				setTimeout(async () => {
					recalculateLastChangedField();
					setTimeout(async () => {
						await sendData(inputs, values, valuesToDisplay, orderId, comment, version, groupNumber);
						sentState = true;
						stopSpin();
					}, 1200);

				}, 1200);
			}

		}, 500);
	}
}


function setupResetButton(inputs, values, valuesToDisplay) {
	console.log('setupResetButton')
	const resetButton = document.getElementById('reset-button');
	resetButton.onclick = function () {
		showToast('info', t('form.loading_data'));
		resetSelectValues([Object.keys(values), valuesToDisplay], inputs, values, false);
		afterSend = false;
	};
}

/* Walidacja formularza */
export async function validateForm(inputs, values) {
	console.log('validateForm')
	validateAllFieldsOnSubmit(inputs, values)
	const correctFlag = await checkFlags();
	console.log('validateForm correctFlag:', correctFlag)
	if (typeof correctFlag !== 'boolean') {
		highlightInvalidFields(correctFlag);

		return false;
	}
	return true
}

function highlightInvalidFields(flags) {
	console.log('highlightInvalidFields')
	let firstInvalid = null;
	for (let { key } of flags) {
		let elem = document.getElementById(key);
		if (elem) {
			elem.classList.add("invalid-input",)
			elem.classList.add('flash-error');
			if (!firstInvalid) firstInvalid = elem;
			setTimeout(() => {
				elem.classList.remove('flash-error');
			}, 2000);
		}
	}
	if (firstInvalid) {
		firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
		firstInvalid.focus({ preventScroll: true });
	}
}

/* Wysyłka danych  */
async function sendData(inputs, values, valuesToDisplay, orderId, comment, version, groupNumber) {
	console.log('sendData')
	const commission = document.getElementById('commission-input').value;
	const selectedDepartment = departmentSelect.options[departmentSelect.selectedIndex].text;
	const selectedGroup = asortmentGroupSelect.options[asortmentGroupSelect.selectedIndex].text;
	const total = getTotal(valuesToDisplay);

	const jsonValuesToDisplay = JSON.stringify(Array.from(valuesToDisplay.entries()));

	const postBody = buildOrderItemStructure(
		parseInt(orderId), {}, 0, 0, total.total, total.total_hidden, total.total_sub || 0,
		commission, commission, values, jsonValuesToDisplay, 1, comment.value, version, groupNumber, document.documentElement.lang, selectedDepartment, selectedGroup, window.shortJson
	);

	try {
		const result = await sendFormDataWithAttachments("/position/save", postBody, "POST");
		console.log('Odpowiedź serwera:', result);

		setTimeout(() => {
			window.location.href = `/orders/order/${orderId}`;
			return result;
		}, 500);
	} catch (error) {
		console.error("Błąd przy wysyłaniu", error);
		showToast('error', t("form.error_saving_form"));
	}
}

/* Obsługa błędów ładowania formularza */
function handleFormLoadError(err) {

	console.error("NIE MA PLIKÓW", err);
	document.getElementById("dynamic-form").innerHTML = "";
	const alertBox = document.getElementById("file-error-message");
	alertBox.textContent = t("form.error_loading_form");
	alertBox.classList.remove("d-none");
	setTimeout(() => alertBox.classList.add("d-none"), 6000);
}



/*  Obsługa przycisku zapisu komisji */

















function showVersion(version) {
	console.log('showVersion')
	const versionDiv = document.getElementById('version-space')
	versionDiv.innerHTML = `v ${version}`
}

/*Obsługa globalnych zdarzeń UI */
function setupGlobalListeners() {
	console.log('setupGlobalListeners')
	document.addEventListener('click', handleImagePreviewClick);
	document.getElementById("close-dialog-btn").addEventListener('click', function () {
		this.parentElement.close();
	});
	document.getElementById("dialog-close").addEventListener('click', function () {
		document.getElementById('color-dialog').close();
	});
}

async function handleImagePreviewClick(e) {
	console.log('handleImagePreviewClick')
	const checkBox = document.getElementById('last-group-checkbox');
	const checkBoxDiv = document.getElementById('last-group-checkbox');
	checkBoxDiv.addEventListener('click', async () => { console.log('checkbox clicked') });
	let choice = await checkBoxReaction(checkBox)
	if (choice) {
		resumeForm(choice)
	}
	if (e.target.classList.contains('diag-image')) {
		const dialog = document.getElementById('image-preview-dialog');
		const previewImage = document.getElementById('preview-image');
		previewImage.src = e.target.src;
		dialog.showModal();
	}
}

async function resumeForm(choice, config = null) {

	const depSelect = document.getElementById("department-select");
	const asortSelect = document.getElementById("asortment-group-select");

	
	const departments = await window.formsManager.getAvailableForms();

	
	const department = departments.find(d => String(d.num) === String(choice.department));
	if (!department) {

		showToast('error', 'Nie znaleziono działu');
		return;
	}

	depSelect.value = choice.department;
	await buildGroupSelect(choice.department, asortSelect);
	asortSelect.value = choice.group;
	await prepareForm(choice.group, choice.department, config);
}

async function getAppVersion(groupNumber) {
	console.log('getAppVersion')
	try {
		const response = await fetch(`/position/version/${groupNumber}/`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
			}
		});
		const data = await response.json();

		return data.version;
	}
	catch (error) {
		console.error(error);
	}
}

async function refreshFormBehaviour(config = null) {

	const lastCommission = localStorage.getItem('commission');

	processCommissionInput(lastCommission)

	let lastChoice = JSON.parse(localStorage.getItem('lastChoice'))
	console.log('lastChoice z localStorage:', lastChoice)

	if (!lastChoice || !lastChoice.department || !lastChoice.group) {
		console.warn('Brak poprawnej konfiguracji lastChoice w localStorage');
		return;
	}

	setTimeout(async () => {
		console.log(config, 'KONFIGURACJAAA')
		if (config) {
			await resumeForm(lastChoice, config);
		}
		else {
			await resumeForm(lastChoice);
		}
	}, 1500);
}


function initMobileFilterControls() {
	
	const observer = new MutationObserver((mutations) => {
		mutations.forEach((mutation) => {
			mutation.addedNodes.forEach((node) => {
				if (node.nodeType === 1 && node.classList && node.classList.contains('filter-controls')) {
					setupCollapsibleFilter(node);
				}
			});
		});
	});

	
	observer.observe(document.body, {
		childList: true,
		subtree: true
	});

	
	document.querySelectorAll('.filter-controls').forEach(setupCollapsibleFilter);
}

function setupCollapsibleFilter(filterElement) {
	if (filterElement.hasAttribute('data-mobile-setup')) return;
	filterElement.setAttribute('data-mobile-setup', 'true');

	
	const header = document.createElement('div');
	header.className = 'filter-controls-header';
	header.innerHTML = `
		<span class="filter-controls-title">Filtry</span>
		<span class="filter-controls-toggle">▼</span>
	`;

	
	const content = document.createElement('div');
	content.className = 'filter-controls-content';
	while (filterElement.firstChild) {
		content.appendChild(filterElement.firstChild);
	}

	
	filterElement.appendChild(header);
	filterElement.appendChild(content);

	
	filterElement.classList.add('collapsed');

	
	header.addEventListener('click', () => {
		if (filterElement.classList.contains('collapsed')) {
			filterElement.classList.remove('collapsed');
			filterElement.classList.add('expanded');
		} else {
			filterElement.classList.remove('expanded');
			filterElement.classList.add('collapsed');
		}
	});
}


document.addEventListener('DOMContentLoaded', initMobileFilterControls);

initialize();
