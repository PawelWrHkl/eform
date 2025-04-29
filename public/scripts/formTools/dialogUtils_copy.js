import { logFunctionName,
  buildValuesToDisplay,
  resetDependences,
  updateFieldInputs,
  updateFieldStates,
} from './formTools.js';
import { showToast,
        showToastInContainer } from '../components/index.js';
import {createElement} from '../components/htmlManipulator.js'
export class DialogManager {
constructor() {
  this.dialog = document.getElementById('color-dialog');
  this.dialogContainer = document.getElementById('dialog-container');
  this.listContainer = document.getElementById('dynamic-options-list');
  this.dialogTitle = document.getElementById('dialog-title');
  this.confirmButton = document.getElementById('dialog-confirm');
  this.closeButton = document.getElementById('dialog-close');
  this.options = [];
  this.param = null;
  this.groupNumber = null;
  this.activeFilters = {};
  
  // Podpięcie istniejących przycisków
  if (this.confirmButton) {
    this.confirmButton.addEventListener('click', () => this.handleConfirm());
  }
  
  if (this.closeButton) {
    this.closeButton.addEventListener('click', () => this.handleCancel());
  }
}

// Inicjalizacja dialogu
async initialize(param, options, groupNumber) {
  logFunctionName('DialogManager.initialize');
  this.param = param;
  this.options = options;
  this.groupNumber = groupNumber;
  
  // Aktualizacja tytułu dialogu
  if (this.dialogTitle) {
    this.dialogTitle.textContent = `Wybór ${param.DESCRIPTION}`;
  }
  
  // Pobranie mapy obrazów
  const imageMap = await this.fetchImageMap(param, options, groupNumber);
  
  // Przygotowanie interfejsu
  this.setupUI();
  
  // Renderowanie opcji
  this.renderOptions(imageMap);
  
  // Pokazanie dialogu
  this.dialog.showModal();
}

// Pobranie mapy obrazów z serwera
async fetchImageMap(param, options, groupNumber) {
  const response = await fetch('/position/check-images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      options: options, 
      groupNumber: groupNumber, 
      folderName: param.NAME 
    })
  });
  
  return await response.json();
}

// Przygotowanie interfejsu użytkownika
setupUI() {
  // Czyszczenie listy opcji
  if (this.listContainer) {
    this.listContainer.innerHTML = '';
  }
  
  // Usunięcie wcześniejszych elementów UI, jeśli istnieją
  this.removeExistingUIElements();
  
  // Dodanie pola wyszukiwania i filtrów przed listą opcji
  this.addSearchAndFilters();
}

// Usunięcie wcześniejszych elementów UI
removeExistingUIElements() {
  // Usunięcie wcześniejszego pola wyszukiwania
  const existingSearch = this.dialogContainer.querySelector('.search-container');
  if (existingSearch) existingSearch.remove();
  
  // Usunięcie wcześniejszych kontrolek filtrowania
  const existingFilters = this.dialogContainer.querySelector('.filter-controls');
  if (existingFilters) existingFilters.remove();
}

// Dodanie pola wyszukiwania i filtrów
addSearchAndFilters() {
  // Tworzenie kontenera dla wyszukiwania i filtrów
  const controlsContainer = document.createElement('div');
  controlsContainer.classList.add('dialog-controls');
  
  // Dodanie pola wyszukiwania
  const searchContainer = this.createSearchField();
  controlsContainer.appendChild(searchContainer);
  
  // Dodanie kontrolek filtrowania
  const filterControls = this.createFilterControls();
  if (filterControls) {
    controlsContainer.appendChild(filterControls);
  }
  
  // Wstawienie kontrolek przed listą opcji
  if (this.dialogContainer && this.listContainer) {
    this.dialogContainer.insertBefore(controlsContainer, this.listContainer);
  }
}

// Tworzenie pola wyszukiwania
createSearchField() {
  const searchContainer = document.createElement('div');
  searchContainer.classList.add('search-container', 'mb-2');
  
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Wyszukaj po nazwie...';
  searchInput.classList.add('search-input', 'form-control');
  searchInput.addEventListener('input', () => this.handleSearch(searchInput));
  
  searchContainer.appendChild(searchInput);
  
  this.searchInput = searchInput;
  return searchContainer;
}

// Tworzenie kontrolek filtrowania
createFilterControls() {
  const filterControls = createElement('div', {
    class: ['filter-controls', 'mb-2'],
    style: { border: '1px solid gray' }
  });

  const testFilters = {
    "GRUBOŚĆ": ["cienka", "średnia", "gruba"],
    "PRZEJRZYSTOŚĆ": ["nieprzeźroczysta", "półprzeźroczysta", "przeźroczysta"]
  };

  for (const [filterName, filterValues] of Object.entries(testFilters)) {
    const filterGroup = createElement('div', { class: ['filter-group', 'me-3'] }, filterControls);

    createElement('label', {
      class: ['filter-label'],
      text: this.formatFilterName(filterName) + ': '
    }, filterGroup);

    // Dropdown Bootstrap
    const dropdown = createElement('div', { class: ['dropdown', 'd-inline-block'] }, filterGroup);

    const dropdownToggle = createElement('button', {
      class: ['btn', 'btn-outline-secondary', 'dropdown-toggle'],
      type: 'button',
      id: `${filterName}-dropdown`,
      'data-bs-toggle': 'dropdown',
      'aria-expanded': 'false',
      text: `Wybierz ${this.formatFilterName(filterName)}`
    }, dropdown);

    const dropdownMenu = createElement('ul', {
      class: ['dropdown-menu', 'p-2'],
      'aria-labelledby': `${filterName}-dropdown`
    }, dropdown);

    // "Wszystkie"
    const allLi = createElement('li', {}, dropdownMenu);
    const allCheckbox = createElement('input', {
      type: 'checkbox',
      class: ['dropdown-option', 'form-check-input', 'me-2'],
      value: '',
      id: `${filterName}-all`
    }, allLi);
    createElement('label', {
      class: ['form-check-label'],
      text: 'Wszystkie',
      for: `${filterName}-all`
    }, allLi);

    // Pozostałe opcje
    filterValues.forEach(value => {
      const li = createElement('li', {}, dropdownMenu);
      const checkbox = createElement('input', {
        type: 'checkbox',
        class: ['dropdown-option', 'form-check-input', 'me-2'],
        value: value,
        id: `${filterName}-${value}`
      }, li);
      createElement('label', {
        class: ['form-check-label'],
        text: value,
        for: `${filterName}-${value}`
      }, li);
    });

    // Obsługa zmian (delegacja zdarzeń)
    dropdownMenu.addEventListener('change', (e) => this.handleFilter(e, filterName));
  }

  return filterControls;
}

// Formatowanie nazwy filtra (pierwsza litera duża, reszta małe)
formatFilterName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

// Pobieranie dostępnych filtrów z opcji
getAvailableFilters() {

  if (this.options.length === 0) {
    return {
      "GRUBOŚĆ": ["cienka", "średnia", "gruba"],
      "PRZEJRZYSTOŚĆ": ["nieprzeźroczysta", "półprzeźroczysta", "przeźroczysta"]
    };
  }
  
  // Standardowa implementacja dla rzeczywistych danych
  const filters = {};
  
  this.options.forEach(option => {
    for (const [key, value] of Object.entries(option)) {
      if (['VALUE', 'DESCRIPTION', 'ROW_NUM'].includes(key)) continue;
      
      if (!filters[key]) {
        filters[key] = new Set();
      }
      
      if (value) {
        filters[key].add(value);
      }
    }
  });
  
  const result = {};
  for (const [key, valueSet] of Object.entries(filters)) {
    if (valueSet.size > 1) {
      result[key] = Array.from(valueSet);
    }
  }
  
  return result;
}

// Pobranie unikalnych kategorii z opcji
getUniqueCategories() {
  const categories = new Set();
  this.options.forEach(option => {
    if (option.CATEGORY) {
      categories.add(option.CATEGORY);
    }
  });
  return Array.from(categories);
}

// Renderowanie opcji
renderOptions(imageMap) {
  if (!this.listContainer) return;
  
  this.listContainer.innerHTML = '';
  this.listContainer.classList.add('options-grid');
  
  for (let option of this.options) {
    const optionElement = this.createOptionElement(option, imageMap);
    this.listContainer.appendChild(optionElement);
  }
}

// Tworzenie elementu opcji
createOptionElement(option, imageMap) {
  const colorBox = document.createElement('div');
  colorBox.classList.add('image-box');
  colorBox.id = option.VALUE;
  colorBox.dataset.paramName = this.param.NAME;
  colorBox.dataset.paramDescription = option.DESCRIPTION;
  
  // Dodanie wszystkich właściwości opcji jako atrybuty data-*
  for (const [key, value] of Object.entries(option)) {
    // Pomijamy standardowe pola
    if (['VALUE', 'DESCRIPTION', 'ROW_NUM'].includes(key)) continue;
    
    // Dodaj właściwość jako atrybut data-*
    if (value) {
      colorBox.dataset[key.toLowerCase()] = value;
    }
  }
  
  // Dodanie obsługi kliknięcia
  colorBox.addEventListener('click', () => this.handleOptionClick(colorBox));
  
  // Dodanie obrazu jeśli istnieje
  const ext = imageMap[option.VALUE];
  if (ext) {
    const imageWrapper = this.createImageWrapper(option, ext);
    colorBox.appendChild(imageWrapper);
  }
  
  // Dodanie nazwy i opisu
  const colorName = document.createElement('p');
  colorName.classList.add('image-name');
  colorName.innerHTML = `${option.VALUE}<br>${option.DESCRIPTION}`;
  colorName.dataset.id = `${option.ROW_NUM}-${this.param.NAME}`;
  colorName.dataset.value = option.VALUE;
  
  colorBox.appendChild(colorName);
  
  return colorBox;
}

// Tworzenie wrappera dla obrazu
createImageWrapper(option, ext) {
  const imageSrc = `/data/${this.groupNumber}/${this.param.NAME}/${option.VALUE}.${ext}`;
  
  const colorImage = document.createElement('img');
  colorImage.classList.add('diag-image');
  colorImage.src = imageSrc;
  colorImage.alt = option.DESCRIPTION;
  colorImage.loading = 'lazy';
  
  const previewOverlay = document.createElement('img');
  previewOverlay.classList.add('preview-box');
  previewOverlay.src = '/img/window.png';
  previewOverlay.alt = 'Podgląd';
  previewOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    this.handlePreviewClick(imageSrc);
  });
  
  const imageWrapper = document.createElement('div');
  imageWrapper.classList.add('image-wrapper');
  imageWrapper.appendChild(colorImage);
  imageWrapper.appendChild(previewOverlay);
  
  return imageWrapper;
}

// Obsługa kliknięcia opcji
handleOptionClick(clickedElement) {
  document.querySelectorAll('.image-box').forEach(e => e.classList.remove('active'));
  clickedElement.classList.add('active');
}

// Obsługa kliknięcia podglądu
handlePreviewClick(imageSrc) {
  const previewDialog = document.getElementById('image-preview-dialog');
  const previewImage = document.getElementById('preview-image');
  previewImage.src = imageSrc;
  previewDialog.showModal();
}

// Obsługa wyszukiwania
handleSearch(searchInput) {
  const searchTerm = searchInput.value.toLowerCase();
  this.filterAndDisplayOptions(searchTerm, this.activeFilters);
}

// Obsługa filtrowania
handleFilter(event, filterName) {

  const dropdownMenu = event.currentTarget;
  const checked = Array.from(dropdownMenu.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => cb.value)
    .filter(val => val !== ''); 

  if (checked.length > 0) {
    this.activeFilters[filterName] = checked;
  } else {
    delete this.activeFilters[filterName];
  }

  const searchTerm = this.searchInput ? this.searchInput.value.toLowerCase() : '';
  this.filterAndDisplayOptions(searchTerm, this.activeFilters);
}

filterAndDisplayOptions(searchTerm, filters) {
  if (!this.listContainer) return;
  const optionElements = this.listContainer.querySelectorAll('.image-box');

  optionElements.forEach(element => {
    const name = element.querySelector('.image-name').textContent.toLowerCase();
    const matchesSearch = !searchTerm || name.includes(searchTerm);

    let matchesFilters = true;
    for (const [filterName, filterValues] of Object.entries(filters)) {
      const elementFilterValue = element.dataset[filterName.toLowerCase()];
      if (!filterValues.includes(elementFilterValue)) {
        matchesFilters = false;
        break;
      }
    }
    element.style.display = (matchesSearch && matchesFilters) ? 'block' : 'none';
  });
}

handleConfirm() {
  const selectedData = this.getSelectedValue();
  if (!selectedData) {
    showToastInContainer(this.dialog,'warning', 'Nie wybrano żadnej opcji.');
    return;
  }
  
  // Wywołanie funkcji obsługi z zewnętrznego modułu
  if (typeof window.dialogConfirmHandler === 'function') {
    window.dialogConfirmHandler(selectedData);
  } else {
    // Domyślna obsługa, jeśli handler nie jest zdefiniowany
    const values = window.formValues || {};
    const inputs = window.formInputs || {};
    updateFormWithSelectedValue(values, inputs, selectedData);
  }
  
  this.close();
}

// Obsługa przycisku anulowania
handleCancel() {
  this.close();
}

// Pobranie wybranej wartości
getSelectedValue() {
  const activeBox = document.querySelector('.image-box.active');
  if (!activeBox) return null;
  
  return {
    value: activeBox.querySelector('.image-name').dataset.value,
    paramName: activeBox.dataset.paramName,
    paramDescription: activeBox.dataset.paramDescription
  };
}

// Zamknięcie dialogu
close() {
  this.dialog.close();
}
}

// Funkcja pomocnicza do aktualizacji formularza
function updateFormWithSelectedValue(values, inputs, selectedData) {
const { value, paramName, paramDescription } = selectedData;
values[paramName] = value;

const currentInput = inputs[paramName];
if (currentInput && currentInput.tagName === "BUTTON") {
  currentInput.innerText = `${value} - ${paramDescription}`;
  currentInput.value = value;
}

return [value, paramName];
}

const dialogManager = new DialogManager();

// Funkcja do tworzenia dialogu - wywoływana z createInputField
export async function createDialog(param, options, grNr) {
logFunctionName('createDialog');
await dialogManager.initialize(param, options, grNr);

// Rejestracja globalnej funkcji obsługi potwierdzenia
window.dialogConfirmHandler = (selectedData) => {
  const values = window.formValues || {};
  const inputs = window.formInputs || {};
  
  getInfoFromDialog(values, inputs, selectedData);
};
}

// Funkcja do obsługi wybranej wartości z dialogu
export function getInfoFromDialog(values, inputs, selectedData = null) {
logFunctionName('getInfoFromDialog');

// Jeśli nie przekazano selectedData, pobierz z aktywnego elementu
if (!selectedData) {
  const activeBox = document.querySelector('.image-box.active');
  if (!activeBox) return;
  
  selectedData = {
    value: activeBox.querySelector('.image-name').dataset.value,
    paramName: activeBox.dataset.paramName,
    paramDescription: activeBox.dataset.paramDescription
  };
}

const result = updateFormWithSelectedValue(values, inputs, selectedData);
document.getElementById("color-dialog").close();
return result;
}
