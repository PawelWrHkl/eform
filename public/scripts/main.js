import {
	generateForm,
	buildCommentSpace,
	buildMainSelect
  } from "/scripts/form.js";
  import {
	resetSelectValues,
	processCommissionInput,
	checkFlags
  } from "/scripts/formTools/formTools.js";
  import { buildOrderItemStructure } from '/scripts/orderBuilder.js';
  import { showToast } from "/scripts/components/toast.js";
  
  /* Inicjalizacja i główna obsługa formularza */
  function initialize() {
	setupGlobalListeners();
	setupCommissionButton();
  }
  
  /* Ładowanie konfiguracji i budowa formularza */
  async function loadJsonConfig() {
	const departments = await fetchDepartments();
	const { asortmentGroupSelect, departmentSelect } = buildMainSelect(departments);
	setupMainSelectListener(departments, asortmentGroupSelect, departmentSelect);
	setupFormButtons();
  }
  
  async function fetchDepartments() {
	const data = await fetch("/config/files.json");
	return await data.json();
  }
  
  /*Obsługa wyboru grupy asortymentowej */
  function setupMainSelectListener(departments, asortmentGroupSelect, departmentSelect) {
	asortmentGroupSelect.addEventListener("input", async function () {
	  const selectedDepartment = departments[departmentSelect.value];
	  const selectedGroupId = selectedDepartment[asortmentGroupSelect.value];
	  showOrderReminder();
  
	  let filesToGenerate = {
		params: selectedGroupId.params,
		paramdict: selectedGroupId.paramdict
	  };
  
	  try {
		await buildDynamicForm(filesToGenerate);
	  } catch (err) {
		handleFormLoadError(err);
	  }
	});
  }
  
  function showOrderReminder() {
	const hiddenClass = document.querySelector('.order-reminder');
	hiddenClass.style.setProperty('display', 'block', 'important');
  }
  
  /* Budowa dynamicznego formularza*/
  async function buildDynamicForm(filesToGenerate) {
	const formContainer = document.getElementById("dynamic-form");
	const [inputs, values, valuesToDisplay] = await generateForm(filesToGenerate);
	const orderId = document.getElementById('orderId').textContent;
	const comment = buildCommentSpace(formContainer);
  
	setupShowButton(inputs, values, valuesToDisplay, orderId, comment);
	setupResetButton(inputs, values, valuesToDisplay);
  }
  
  /* Obsługa przycisku "Pokaż" */
  function setupShowButton(inputs, values, valuesToDisplay, orderId, comment) {
	const showButton = document.getElementById('show-button');
	showButton.onclick = async function () {
	  if (!await validateForm()) {
		showToast('error', 'Niepoprawne dane!');
		return;
	  }
	  await sendData(inputs, values, valuesToDisplay, orderId, comment);
	};
  }
  
  /* Obsługa przycisku "Resetuj" */
  function setupResetButton(inputs, values, valuesToDisplay) {
	const resetButton = document.getElementById('reset-button');
	resetButton.onclick = function () {
	  showToast('info', 'Loading form...');
	  resetSelectValues([Object.keys(values), valuesToDisplay], inputs, values);
	  console.log(valuesToDisplay);
	};
  }
  
  /* Walidacja formularza */
  async function validateForm() {
	const correctFlag = await checkFlags();
	if (typeof correctFlag !== 'boolean') {
	  highlightInvalidFields(correctFlag);
	  console.log('nie wszystkie flagi ok');
	  return false;
	}
	return true;
  }
  
  function highlightInvalidFields(flags) {
	for (let { key } of flags) {
	  let elem = document.getElementById(key);
	  if (elem) {
		elem.classList.add('flash-error');
		setTimeout(() => {
		  elem.classList.remove('flash-error');
		}, 2000);
	  }
	}
  }
  
  /* Wysyłka danych  */
  async function sendData(inputs, values, valuesToDisplay, orderId, comment) {
	const commission = document.querySelector('.commission-space h5').innerHTML;
	const jsonValuesToDisplay = JSON.stringify(Array.from(valuesToDisplay.entries()));
	const postBody = buildOrderItemStructure(
	  parseInt(orderId), {}, 0, 0, 0, 0,
	  commission, commission, values, jsonValuesToDisplay, 1, comment.value
	);
	const json = JSON.stringify(postBody);
  
	try {
	  const response = await fetch("/position/save", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: json,
	  });
	  const result = await response.json();
	  showToast('success', 'Zapisano zamówienie!');
	  setTimeout(() => {
		window.location.href = `/orders/order/${orderId}`;
		return result;
	  }, 3000);
	} catch (error) {
	  console.error("Bład przy wysyłaniu", error);
	  showToast('error', 'bŁąd przy wysyłaniu zamówienia!');
	}
  }
  
  /* Obsługa błędów ładowania formularza */
  function handleFormLoadError(err) {
	console.error("NIE MA PLIKÓW", err);
	document.getElementById("dynamic-form").innerHTML = "";
	const alertBox = document.getElementById("file-error-message");
	alertBox.textContent = "Nie udało się załadować plików dla wybranej grupy.";
	alertBox.classList.remove("d-none");
	setTimeout(() => alertBox.classList.add("d-none"), 6000);
  }
  
  /* Przygotowanie przycisków formularza */
  function setupFormButtons() {
	const buttonsDiv = document.getElementById("buttons-space");
	const showButton = document.getElementById('show-button');
	const resetButton = document.getElementById('reset-button');
	buttonsDiv.appendChild(resetButton);
	buttonsDiv.appendChild(showButton);
  }
  
  /*  Obsługa przycisku zapisu komisji */
  function setupCommissionButton() {
	let saveCommissionButton = document.getElementById('commision-save-btn');
	saveCommissionButton.addEventListener('click', function () {
	  processCommissionInput();
	  loadJsonConfig();
	});
  }
  
  /*Obsługa globalnych zdarzeń UI */
  function setupGlobalListeners() {
	document.addEventListener('click', handleImagePreviewClick);
	document.getElementById("close-dialog-btn").addEventListener('click', function () {
	  this.parentElement.close();
	});
	document.getElementById("dialog-close").addEventListener('click', function () {
	  document.getElementById('color-dialog').close();
	});
  }
  
  function handleImagePreviewClick(e) {
	if (e.target.classList.contains('diag-image')) {
	  const dialog = document.getElementById('image-preview-dialog');
	  const previewImage = document.getElementById('preview-image');
	  previewImage.src = e.target.src;
	  dialog.showModal();
	}
  }
  
initialize();
  