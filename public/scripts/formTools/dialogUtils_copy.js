import {
  logFunctionName,
  buildValuesToDisplay,

  updateFieldInputs,
  updateFieldStates,
} from './formTools.js';
import {
  showToast,
  showToastInContainer
} from '../components/index.js';
import { createElement } from '../components/htmlManipulator.js'
import { createInfoIcon, INFO_FILES_URL } from '../components/info.js';
import { stopSpin, startSpin } from "../components/hourglass.js";
import { getEnvVersion } from "../getEnv.js";
import { getUserName } from "../base.js";
import { chcekIfDateDeliveryCorrect } from './checkIfDateDeliveryCorrect.js';



export class DialogManager {
  constructor() {
    this.isMultiChoice = false;
    this.isLink;
    this.isInfo;
    this.selectedValues = [];
    this.currentSort = 'default';
    this.dialog = document.getElementById('color-dialog');
    this.dialogContainer = document.getElementById('dialog-container');
    this.listContainer = document.getElementById('dynamic-options-list');
    this.dialogTitle = document.getElementById('dialog-title');
    this.confirmButton = document.getElementById('dialog-confirm');
    this.closeButton = document.getElementById('dialog-close');
    this.extraInfo = document.getElementById('additional-info');
    this.options = [];
    this.param = null;
    this.groupNumber = null;
    this.activeFilters = {};
    this.favList = [];
    this.deleteFavsBtn = '';

    if (this.confirmButton) {
      this.confirmButton.addEventListener('click', () => this.handleConfirm());
    }

    if (this.closeButton) {
      this.closeButton.addEventListener('click', () => this.handleCancel());
    }


  }


  async initialize(param, options, groupNumber, filters, attrs) {

    logFunctionName('DialogManager.initialize');
    this.param = param;
    this.user = await getUserName();
    this.options = options;
    this.groupNumber = groupNumber;
    this.filters = filters || {};
    this.attrValues = attrs
    this.org = await window.formsManager.getOrgIdent();

    this.isMultiChoice = param?.MULTI == 'true' ?? false;

    this.isLink = param?.LINK == 'true' ?? false;


    this.isInfo = param?.INFO != '<NULL>' ?? false;
    this.extraInfoText = param?.INFO;

    this.selectedValues = [];
    this.confirmButton.style.display = this.isMultiChoice ? 'inline-block' : 'none';
    if (this.dialogTitle) {

      this.dialogTitle.textContent = param.DESCRIPTION;
    }


    const imageMap = await this.fetchImageMap(param, options, groupNumber);

    this.env = await getEnvVersion();


    if (this.attrValues && this.attrValues != undefined && Object.keys(this.attrValues).length > 0) {
      this.getUniqueCategories()
    }


    this.setupUI();


    await this.renderOptions(imageMap);


    this.dialog.showModal();


    if (this.listContainer) {
      this.listContainer.scrollTop = 0;
    }

    stopSpin()

    if (this.deleteFavsBtn) {
      this.clearFavs()
    }
  }


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


  setupUI() {

    if (this.listContainer) {
      this.listContainer.innerHTML = '';
    }


    this.removeExistingUIElements();


    this.addSearchAndFilters();

    this.setupExtraInfo();

  }


  setupExtraInfo(text, link) {

    const container = this.extraInfo;
    if (!container) return;


    container.innerHTML = '';


    let infoHtml = text || this.extraInfoText || '';
    let href = link || this.param?.LINK_URL || this.param?.LINK || null;


    const bracketMatch = infoHtml.match(/<([^>]+)>/);
    if (bracketMatch) {
      const extractedPath = bracketMatch[1].trim();


      infoHtml = infoHtml.replace(/<[^>]+>/, '').trim();


      if (extractedPath.startsWith('http:') || extractedPath.startsWith('https:')) {
        href = extractedPath;
      } else {
        href = extractedPath;
      }
    }

    if (this.isInfo && infoHtml) {
      const panel = createElement('div', {
        class: ['extra-info-panel', 'mb-3', 'd-grid'],
        role: 'region',
        'aria-label': 'additional information',
        style: { gap: '0.75rem' }
      }, container);


      const topRow = createElement('div', {
        class: ['d-flex', 'align-items-start'],
        style: { gap: '0.5rem' }
      }, panel);


      const iconWrap = createElement('div', {
        class: ['extra-info-icon', 'flex-shrink-0']
      }, topRow);

      iconWrap.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.12"></circle>
          <path d="M11 17h2v-6h-2v6zm0-8h2V7h-2v2z" fill="currentColor"></path>
        </svg>`;


      const content = createElement('div', {
        class: ['extra-info-content', 'flex-grow-1']
      }, topRow);

      let normalized = String(infoHtml || '');
      normalized = normalized.replace(/\\n/g, '\n');

      const htmlWithBreaks = normalized.replace(/\n/g, '<br>');
      content.innerHTML = htmlWithBreaks;


      if (this.isLink || href) {
        const buttonRow = createElement('div', {
          class: ['d-flex', 'justify-content-start', 'ms-1']
        }, panel);

        const linkHref = href || '#';


        let finalHref;
        let buttonText;

        if (linkHref.startsWith('http:') || linkHref.startsWith('https:')) {

          finalHref = linkHref;
          buttonText = linkHref;
        } else {

          finalHref = INFO_FILES_URL + linkHref;
          buttonText = linkHref;
        }

        const btn = createElement('a', {
          class: ['btn', 'btn-outline-secondary', 'ms-4'],
          href: finalHref,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: buttonText
        }, buttonRow);
      }
    } else if (this.isLink && (this.param || link)) {

      const panel = createElement('div', {
        class: ['extra-info-panel', 'mb-3'],
        role: 'region',
        'aria-label': 'link'
      }, container);
      const content = createElement('div', { class: ['extra-info-content'] }, panel);
      const linkHref = href || '#';


      let finalHref;
      let buttonText;

      if (linkHref.startsWith('http:') || linkHref.startsWith('https:')) {

        finalHref = linkHref;
        buttonText = linkHref;
      } else {

        finalHref = INFO_FILES_URL + linkHref;
        buttonText = linkHref;
      }

      createElement('a', {
        class: ['extra-info-cta', 'btn', 'btn-sm', 'btn-outline-secondary'],
        href: finalHref,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: buttonText
      }, content);
    }
  }


  removeExistingUIElements() {

    const existingSearch = this.dialogContainer.querySelector('.search-container');
    if (existingSearch) existingSearch.remove();


    const existingFilters = this.dialogContainer.querySelector('.filter-controls');
    if (existingFilters) existingFilters.remove();
  }


  addSearchAndFilters() {

    const controlsContainer = document.createElement('div');
    controlsContainer.classList.add('dialog-controls');


    const searchContainer = this.createSearchField();
    controlsContainer.appendChild(searchContainer);



    const filterControls = this.createFilterControls();
    if (filterControls) {
      controlsContainer.appendChild(filterControls);
    }

    const sortingContainer = this.createSortingControls(this.handleSortChange.bind(this), this.currentSort || 'default');
    controlsContainer.appendChild(sortingContainer);

    if (this.dialogContainer && this.listContainer) {
      this.dialogContainer.insertBefore(controlsContainer, this.listContainer);
    }


    setTimeout(() => {

      let dialogSortMethod = localStorage.getItem(`${this.param.NAME}-dialogSortMethod`) || 'default';

      const selectElement = sortingContainer.querySelector('select');
      if (selectElement) {
        selectElement.value = dialogSortMethod;



        if (selectElement.value !== dialogSortMethod) {
          console.warn('Failed to set select value, falling back to first option');
          selectElement.selectedIndex = 0;
        }
      }

      this.handleSortChange(dialogSortMethod || 'default');
    }, 10);
  }

  createSortingControls(onSortChange, currentSort = 'default') {
    const options = [
      { value: 'default', label: `${t('form.default')}` },
      { value: 'favorites', label: `${t('form.favorites_first')}` },
      { value: 'az', label: 'A-Z' },
      { value: 'za', label: 'Z-A' }
    ];

    const sortingContainer = createElement('div', {
      class: ['sorting-controls', 'mb-2', 'd-flex', 'align-items-center', 'justify-content-end'],

    });

    this.deleteFavsBtn = createElement('button', {
      class: ['btn', 'btn-outline-secondary', 'me-2', 'clear-favorites-btn'],
      type: 'button',
      id: `clear-favorites-btn`,
      'aria-expanded': 'false',
      text: `${t("form.clear_favorites")}`,
      style: { backgroundColor: '#fff', color: '#000' }
    }, sortingContainer);

    const select = createElement('select', {
      id: 'sortOptions',
      class: ['form-select', 'sorting-select'],
      onchange: (e) => {
        const selectedValue = e.target.value;
        if (typeof onSortChange === 'function') {
          onSortChange(selectedValue);
        }
      }
    }, sortingContainer);




    for (const [idx, opt] of options.entries()) {
      const option = createElement('option', {
        value: opt.value,
        text: opt.label
      }, select);
      option.textContent = opt.label;
    }

    return sortingContainer;
  }


  handleSortChange(sortMethod) {

    const method = sortMethod || 'default';


    this.currentSort = method;
    this.applySorting(method);
    localStorage.setItem(`${this.param.NAME}-dialogSortMethod`, method);
  }

  createSearchField() {
    const searchContainer = document.createElement('div');
    searchContainer.classList.add('search-container', 'mb-2');
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = t('form.search_input_placeholder');
    searchInput.classList.add('search-input', 'form-control');
    searchInput.addEventListener('input', () => this.handleSearch(searchInput));

    searchContainer.appendChild(searchInput);

    this.searchInput = searchInput;
    return searchContainer;
  }

  createFilterControls() {
    const existingControls = this.dialogContainer.querySelector('.dialog-controls');
    const filterControls = createElement('div', {
      class: ['filter-controls', 'mb-2'],
      style: { border: '1px solid gray' },
      existingControls
    });
    let isFilters = false;
    if (this.filters) {
      isFilters = Object?.keys(this?.filters).length ?? 0 > 0;
    }
    if (!isFilters) {
      filterControls.classList.add('d-none')
      return filterControls;
    }

    const isMobile = window.innerWidth <= 768;
    let content = filterControls;

    if (isMobile) {
      const header = createElement('div', {
        class: ['filter-controls-header'],
      }, filterControls);

      const title = createElement('span', {
        class: ['filter-controls-title'],
        text: 'Filtry'
      }, header);

      const toggle = createElement('span', {
        class: ['filter-controls-toggle'],
        text: '▼'
      }, header);


      content = createElement('div', {
        class: ['filter-controls-content']
      }, filterControls);


      filterControls.classList.add('collapsed');

      header.addEventListener('click', () => {
        if (filterControls.classList.contains('collapsed')) {
          filterControls.classList.remove('collapsed');
          filterControls.classList.add('expanded');
        } else {
          filterControls.classList.remove('expanded');
          filterControls.classList.add('collapsed');
        }
      });
    }

    for (const [filterName, filterValues] of Object.entries(this.filters)) {
      if (!filterName || filterName.trim() === '' || filterName.trim() === '-') continue;

      const filterGroup = createElement('div', { class: ['filter-group', 'me-3'] }, content);







      const dropdown = createElement('div', { class: ['dropdown', 'd-inline-block'] }, filterGroup);

      const dropdownToggle = createElement('button', {
        class: ['btn', 'btn-outline-secondary', 'dropdown-toggle'],
        type: 'button',
        id: `${filterName}-dropdown`,
        'data-bs-toggle': 'dropdown',
        'aria-expanded': 'false',
        text: `${this.formatFilterName(filterName)}`
      }, dropdown);

      const dropdownMenu = createElement('ul', {
        class: ['dropdown-menu', 'p-2', 'dropdown-scroll'],
        'aria-labelledby': `${filterName}-dropdown`,
        style: { maxHeight: '320px', overflowY: 'auto' }
      }, dropdown);


      const allLi = createElement('li', {}, dropdownMenu);
      const allCheckbox = createElement('input', {
        type: 'checkbox',
        class: ['dropdown-option', 'form-check-input', 'me-2'],
        value: '',
        id: `${filterName}-all`
      }, allLi);
      createElement('label', {
        class: ['form-check-label'],
        text: t("form.all_word"),
        for: `${filterName}-all`
      }, allLi);




      let sortedValues = Array.isArray(filterValues)

        ? Array.from(filterValues).sort((a, b) => {

          // Guard: push null/undefined values to the end
          if (a == null && b == null) return 0;
          if (a == null) return 1;
          if (b == null) return -1;

          const aStr = String(a);
          const bStr = String(b);

          if (aStr.includes('#') && bStr.includes('#')) {

            const extractValue = (str) => {

              const match = String(str).match(/#(.+)$/);

              return match ? match[1].trim().slice(0, 1) : '';

            };

            const aValue = extractValue(aStr);
            const bValue = extractValue(bStr);

            const aIsNumber = /^\d+$/.test(aValue);
            const bIsNumber = /^\d+$/.test(bValue);


            if (!aIsNumber && !bIsNumber) {
              return aValue.localeCompare(bValue, undefined, {
                sensitivity: 'base',
                numeric: false
              });
            }


            if (!aIsNumber && bIsNumber) {
              return -1;
            }

            if (aIsNumber && !bIsNumber) {
              return 1;
            }


            return parseInt(aValue, 10) - parseInt(bValue, 10);
          }


          const aNum = parseFloat(aStr.replace(',', '.'));
          const bNum = parseFloat(bStr.replace(',', '.'));

          if (!isNaN(aNum) && !isNaN(bNum)) {
            return aNum - bNum;
          }

          if (!isNaN(aNum) && isNaN(bNum)) {
            return 1;
          }

          if (isNaN(aNum) && !isNaN(bNum)) {
            return -1;
          }

          return aStr.localeCompare(bStr, undefined, { sensitivity: 'base' });

        })
        : [];
      const aliasesFile = formsManager.getAliases(this.param.NAME).file
      if (aliasesFile == 'paramdict-KOLOR-COZY.txt' && window.tempGroupNumber == '59') {
        sortedValues = [
          'Prijsgroup #Bamboe Pk1',
          'Prijsgroup #Bamboe Pk2',
          'Prijsgroup #Eco Pk1',
          'Prijsgroup #Eco Pk2',
          'Prijsgroup #Retro Pk 1',
          'Prijsgroup #Structuur Pk2',
          'Prijsgroup #Mat Pk3',
          'Prijsgroup #Luxe Pk4'];

      }

      sortedValues.forEach(value => {
        if (!value || value.trim() === '' || value.trim() === '-' || value.trim() === '?') return;
        const li = createElement('li', {}, dropdownMenu);
        const checkbox = createElement('input', {
          type: 'checkbox',
          class: ['dropdown-option', 'form-check-input', 'me-2'],
          value: value,
          id: `${filterName}-${value}`
        }, li);


        let displayText = value;
        if (filterName === this.stan) {
          const translations = {
            'ZERO': t('form.status_zero') || 'Niedostępne',
            'SAFE': t('form.status_safe') || 'Dostępne',
            'LOW': t('form.status_low') || 'Niski stan',
            'CRITICAL': t('form.status_critical') || 'Stan krytyczny',
            'OBSOLETE': t('form.status_obsolete') || 'Obsolet'
          };
          displayText = translations[value] || value;
        }

        createElement('label', {
          class: ['form-check-label'],
          text: displayText,
          for: `${filterName}-${value}`
        }, li);
      });



      dropdownMenu.addEventListener('change', (e) => this.handleFilter(e, filterName));
    }

    const clearFiltersBtn = createElement('button', {
      class: ['btn', 'btn-outline-secondary', 'clear-filters-btn'],
      type: 'button',
      id: `clear-filters-btn`,
      'aria-expanded': 'false',
      text: `${t("form.reset_filters")}`,
      style: { float: 'right', backgroundColor: '#fff', color: '#000' }
    }, content);



    clearFiltersBtn.addEventListener('click', (e) => {
      e.preventDefault();

      const checkboxes = filterControls.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => {
        if (cb.id && cb.id.endsWith('-all')) {
          cb.checked = true;
        } else {
          cb.checked = false;
        }
      });


      this.activeFilters = {};


      const searchTerm = this.searchInput ? this.searchInput.value.toLowerCase() : '';
      this.filterAndDisplayOptions(searchTerm, this.activeFilters);
    });

    return filterControls;
  }

  formatFilterName(name) {
    return name
  }

  getAvailableFilters() {

    return this.filters
  }

  getUniqueCategories() {

    const attrVals = this.attrValues.STAN

    const attrDesc = this.attrValues.INFO
    const categories = new Set();
    const stockStatuses = new Set();
    const missingStanOptions = [];
    const pricesGroups = new Set();

    this.options.forEach(option => {
      if (attrVals) {

        const val = option?.VALUE ?? '';
        const normalizedValue = val.replace(/~\d+$/, '');

        const foundEntry = attrVals.find(entry => {
          const entryKeys = Object.keys(entry)[0];
          if (entryKeys === normalizedValue) {
            option.OBSOLETE = false;
            return entry
          }
          else if (entryKeys.endsWith('-OBS')) {
            if (entryKeys.slice(0, -4) === normalizedValue) {
              option.OBSOLETE = true;
              return entry;
            }
          }
        });

        if (foundEntry) {
          const entryKey = Object.keys(foundEntry)[0];

          if (entryKey.endsWith('-OBS')) {
            option.STAN = foundEntry[entryKey];

          } else {
            option.STAN = foundEntry[normalizedValue];
          }

          const match = String(option.STAN).match(/ZERO|SAFE|LOW|CRITICAL|COUPON/i);
          console.log(match, 'stan magazynowy', option.VALUE, option.STAN, option.OBSOLETE)
          if (match && match[0] != 'ZERO' && match[0] != 'COUPON') {
            stockStatuses.add(match[0].toUpperCase());
          } else if (match && match[0] == 'COUPON') {
            stockStatuses.add('COUPON');
          } else {
            if (option.OBSOLETE) {
              stockStatuses.add('OBSOLETE')
            } else if (match) {
              stockStatuses.add(match[0].toUpperCase());
            }
          }
        } else {
          missingStanOptions.push(option.VALUE);
        }

        if (attrDesc) {
          const foundDesc = attrDesc.find(entry => Object.keys(entry)[0] === normalizedValue);
          if (foundDesc) {
            const value = foundDesc[normalizedValue];
            option.ATTR_DESC = value
          }
        }
      } else {
        return [];
      }
    });

    if (missingStanOptions.length > 0) {
    }


    if (stockStatuses.size > 0 && (this.env || this.user.pin == '0000')) {

      this.stan = t('form.warehouse_stock') || 'Stan magazynowy';
      this.filters[this.stan] = Array.from(stockStatuses);
    }

    if (this.param.NAME == 'KOLOR') {
      this.options.forEach(option => {
        if (option?.ALIAS) {
          pricesGroups.add(option.ALIAS_DESCRIPTION)
        }
        else {
          pricesGroups.add(option.DESCRIPTION)
        }


      });
      this.prices = t('form.price_groups') || 'Grupa cenowa';
      this.filters[this.prices] = Array.from(pricesGroups);
    }


    return Array.from(categories);
  }

  async renderOptions(imageMap) {
    if (!this.listContainer) return;

    this.listContainer.innerHTML = '';
    this.listContainer.classList.add('options-grid');

    const favs = await this.fetchFavorites(tempGroupNumber);

    const favoriteOptions = [];
    const otherOptions = [];
    const safeFavs = Array.isArray(favs) ? favs : [];

    for (const option of this.options) {
      if (safeFavs.includes(option.VALUE)) {
        favoriteOptions.push(option);
        this.favList.push(option.VALUE)
      } else {
        otherOptions.push(option);
      }
    }
    this.counter = document.getElementById('object-count');

    this.counter.textContent = this.options.length;

    for (const option of favoriteOptions) {
      const optionElement = this.createOptionElement(option, imageMap, true);
      this.listContainer.appendChild(optionElement);
    }

    for (const option of otherOptions) {
      const optionElement = this.createOptionElement(option, imageMap, false);
      this.listContainer.appendChild(optionElement);
    }


    if (this.currentSort) {
      this.applySorting(this.currentSort);
    }
  }

  createOptionElement(option, imageMap, isFav) {
    const colorBox = document.createElement('div');
    colorBox.classList.add('image-box');
    colorBox.id = option.VALUE;
    colorBox.dataset.paramName = this.param.NAME;
    colorBox.dataset.paramDescription = option.DESCRIPTION;
    const top = document.createElement('div');
    top.classList.add('image-box-top');
    const bottom = document.createElement('div');
    bottom.classList.add('image-box-bottom');
    if (this.isMultiChoice) {
      colorBox.classList.add('multi-selectable');
    }
    for (const [key, value] of Object.entries(option)) {

      if (['VALUE', 'DESCRIPTION', 'ROW_NUM', 'INFO'].includes(key)) continue;


      if (value) {
        colorBox.dataset[key.toLowerCase()] = value;
      }
    }
    let circleElem = createElement('span', {

      'aria-hidden': 'true'
    });
    let deliveryInfo;
    if (option?.STAN) {
      try {

        const raw = String(option?.STAN || '');
        const match = raw.match(/ZERO|SAFE|LOW|CRITICAL|COUPON/i);
        const status = match ? match[0].toUpperCase() : null;
        if (status) {
          const map = {
            ZERO: { class: 'stock-zero' },
            SAFE: { class: 'stock-safe' },
            LOW: { class: 'stock-low' },
            COUPON: { class: 'stock-coupon' },
            CRITICAL: { class: 'stock-critical' }
          };
          const info = map[status] || { class: 'stock-unknown' };

          if (status == 'ZERO' && option.OBSOLETE) {
            colorBox.classList.add("obsolete")
          }
          else if (status == "ZERO") {
            colorBox.classList.add("unavailable")
          }
          const attrDescText = String(option?.ATTR_DESC ?? '');
          console.log(option?.ATTR_DESC)
          if (attrDescText.includes('KUPON')) {
            option.IS_CUPON = true;
          }
          // Mark coupon fabrics on the tile so the form can persist a coupon flag
          // into the position values (→ json_parameters) when one is selected.
          // Only fabric tiles (those with stock STAN) carry this dataset attribute.
          colorBox.dataset.coupon = (status === 'COUPON' || option.IS_CUPON) ? '1' : '0';
          // Zawsze twórz badge dla statusu
          circleElem = createElement('span', {
            class: ['stock-badge', info.class],
            'aria-hidden': 'true'
          });

          if (attrDescText) {
            let date = chcekIfDateDeliveryCorrect(attrDescText);
            // ({ date, isCupon } = checkIfCupon(dateResult));


            if (!option.IS_CUPON) {
              deliveryInfo = createElement('div', {
                class: ['delivery-info'],
                'aria-hidden': 'true',
                text: date
              });
            } else {
              deliveryInfo = createElement('div', {
                class: ['delivery-info'],
                'aria-hidden': 'true'
              });

              createInfoIcon({
                info: t('form.cupon_info'),
                parent: deliveryInfo,
                defaultLabel: t('form.cupon_info_label'),
                infoStyle: 'btn-cupon',
                downloadLabel: "Pobierz"
              });
            }
          }
        }
      } catch (err) {
        console.error('Error creating stock badge', err);
      }
    }

    if (option.ATTRIBUTES) {
      try {

        for (const [attrKey, attrValue] of Object.entries(option.ATTRIBUTES)) {
          const sanitizedKey = attrKey.replace(/ /g, '-').toLowerCase();
          colorBox.setAttribute(`data-${sanitizedKey}`, attrValue);
        }
      }
      catch (err) { 'blad' }
    }

    colorBox.addEventListener('click', () => this.handleOptionClick(colorBox));

    const filename = imageMap[option.VALUE];

    // Ikonki informacyjne kafelka: kupon (stala tresc dla tkanin kuponowych) oraz
    // INFO przypisane do TEJ konkretnej wartosci slownika (kolumna <PARAM>_INFO).
    // Obie ida do wspolnego stosu, bo CSS pozycjonuje .param-info-icon w kafelku
    // absolutnie w lewym gornym rogu - dwie osobne nachodzilyby na siebie.
    const isCuponOption = option?.IS_CUPON === true || option?.IS_CUPON === 'true';
    const valueInfo = option?.INFO;
    const hasValueInfo = valueInfo && valueInfo !== '<NULL>' && String(valueInfo).trim() !== '';
    if (isCuponOption || hasValueInfo) {
      const infoStack = createElement('div', { class: ['tile-info-stack'] }, top);

      if (isCuponOption) {
        createInfoIcon({
          info: t('form.cupon_info'),
          parent: infoStack,
          defaultLabel: t('form.cupon_info_label'),
          infoStyle: 'i',
          downloadLabel: "Pobierz"
        });
      }

      if (hasValueInfo) {
        createInfoIcon({
          info: valueInfo,
          parent: infoStack,
          defaultLabel: t('Dodatkowe informacje'),
          infoStyle: 'i',
          downloadLabel: t('Pobierz'),
          className: 'value-info-icon'
        });
      }
    }
    if (filename) {
      const imageWrapper = this.createImageWrapper(option, filename);
      top.appendChild(imageWrapper);
    }

    const colorName = document.createElement('p');
    colorName.classList.add('image-name');

    if (option?.ALIAS) {
      option.PRESENATION = { value: option.ALIAS, description: option.ALIAS_DESCRIPTION }
      colorName.innerHTML = `${option.ALIAS}<br>${option.ALIAS_DESCRIPTION}`;
    }
    else {
      option.PRESENATION = { value: option.VALUE, description: option.DESCRIPTION }

      colorName.innerHTML = `${option.VALUE}<br>${option.DESCRIPTION}`;
    }

    colorName.dataset.id = `${option.ROW_NUM}-${this.param.NAME}`;
    colorName.dataset.value = option.VALUE;


    const heartIcon = createElement('img', {
      class: ['icon', 'heart-icon'],
      src: isFav ? '/img/heart-on.png' : '/img/heart-off.png',
      alt: 'Podgląd',
      loading: 'lazy',
      onclick: async (e) => {
        e.stopPropagation();
        await this.favouriteBehavior(e.currentTarget, option);
      }
    });

    if (isFav) {
      colorBox.classList.add('favorite');
      bottom.classList.add('favorite');
    }
    if (circleElem) {
      bottom.appendChild(circleElem);
    }
    else {
      colorName.classList.add('ml-3');
    }


    bottom.appendChild(colorName);
    bottom.appendChild(heartIcon);
    colorBox.appendChild(top);
    colorBox.appendChild(bottom);
    if (deliveryInfo) {
      colorBox.appendChild(deliveryInfo);
    }
    else {
      bottom.classList.add('mt-2');
    }
    return colorBox;

  }


  async fetchFavorites(groupNumber) {
    try {
      const response = await fetch(`/position/favs/${groupNumber}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Błąd pobierania ulubionych: ${response.status}`);
      }

      const data = await response.json();
      return data.favorites;
    } catch (error) {
      console.error('Błąd pobierania ulubionych:', error);
      return [];
    }
  }


  applySorting(sortMethod) {

    const container = this.listContainer;
    if (!container) return;

    const items = Array.from(container.querySelectorAll('.image-box'));

    items.sort((a, b) => {
      switch (sortMethod) {
        case 'default':

          const aValue = a.querySelector('.image-name').dataset.value;
          const bValue = b.querySelector('.image-name').dataset.value;
          const aIndex = this.options.findIndex(opt => opt.VALUE === aValue);
          const bIndex = this.options.findIndex(opt => opt.VALUE === bValue);
          return aIndex - bIndex;
        case 'az':
          return a.querySelector('.image-name').textContent.localeCompare(
            b.querySelector('.image-name').textContent
          );
        case 'za':
          return b.querySelector('.image-name').textContent.localeCompare(
            a.querySelector('.image-name').textContent
          );
        case 'favorites':
          const aFav = a.classList.contains('favorite');
          const bFav = b.classList.contains('favorite');

          if (aFav && !bFav) return -1;
          if (!aFav && bFav) return 1;

          const aVal = a.querySelector('.image-name').dataset.value;
          const bVal = b.querySelector('.image-name').dataset.value;
          const aIdx = this.options.findIndex(opt => opt.VALUE === aVal);
          const bIdx = this.options.findIndex(opt => opt.VALUE === bVal);
          return aIdx - bIdx;
        default:
          return 0;
      }
    });

    container.innerHTML = '';
    items.forEach(item => container.appendChild(item));
  }

  async favouriteBehavior(element, option) {
    try {
      const productValue = option.VALUE;
      const groupNumber = tempGroupNumber;

      const response = await fetch('/position/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productValue, groupNumber })
      });

      if (response.ok) {
        const result = await response.json();
        element.src = result.isFavorite
          ? '/img/heart-on.png'
          : '/img/heart-off.png';
        const parent = element.parentElement;
        if (parent) {
          parent.classList.toggle('favorite', result.isFavorite);
        }
      } else {
        console.error('Błąd serwera:', response.status);
      }
    } catch (error) {
      console.error('Błąd połączenia:', error);
    }
  }
  closeDialog() {
    const imagePreviewDialog = document.getElementById('image-preview-dialog');
    if (imagePreviewDialog.open) {
      const closeBtn = document.querySelectorAll('.close-dialog-btn');
      closeBtn.forEach(btn => btn.addEventListener('click', () => {
        imagePreviewDialog.close();

      }));

    }
  }

  createImageWrapper(option, filename) {

    let normalizedValue = option.VALUE


    const imageSrc = `/photos/${this.groupNumber}/${this.param.NAME}/${filename}`;
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


  handleOptionClick(clickedElement) {

    if (this.isMultiChoice && clickedElement.id != '<NONE>') {


      clickedElement.classList.toggle('active');


      const value = clickedElement.querySelector('.image-name').dataset.value;


      const index = this.selectedValues.indexOf(value);
      if (index === -1) {
        this.selectedValues.push(value);
      } else {
        this.selectedValues.splice(index, 1);
      }

    }
    else {
      document.querySelectorAll('.image-box').forEach(e => e.classList.remove('active'));
      clickedElement.classList.add('active');
      this.handleConfirm()
      document.getElementById('dialog-confirm').click();
    }

  }




  handlePreviewClick(imageSrc) {
    const previewDialog = document.getElementById('image-preview-dialog');
    const previewImage = document.getElementById('preview-image');
    previewImage.src = imageSrc;
    previewDialog.showModal();


    previewDialog.addEventListener('click', (e) => {
      if (e.target === previewDialog) {
        previewDialog.close();
      }
    });
  }


  handleSearch(searchInput) {
    const searchTerm = searchInput.value.toLowerCase();
    this.filterAndDisplayOptions(searchTerm, this.activeFilters);

  }


  handleFilter(event, filterName) {
    const dropdownMenu = event.currentTarget;
    const escapedFilterName = CSS.escape(filterName);
    const allCheckbox = dropdownMenu.querySelector(`#${escapedFilterName}-all`);
    const otherCheckboxes = Array.from(
      dropdownMenu.querySelectorAll(`input[type="checkbox"]:not([id="${escapedFilterName}-all"])`)
    );
    if (event.target.id === `${filterName}-all`) {
      if (event.target.checked) {
        otherCheckboxes.forEach(cb => { cb.checked = false; });
        this.activeFilters[filterName] = [];
      }
    } else {
      if (allCheckbox.checked) {
        allCheckbox.checked = false;
      }
      const checked = otherCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
      if (checked.length > 0) {
        this.activeFilters[filterName] = checked;
      } else {
        delete this.activeFilters[filterName];
      }
    }

    const searchTerm = this.searchInput ? this.searchInput.value.toLowerCase() : '';
    this.filterAndDisplayOptions(searchTerm, this.activeFilters);
  }


  filterAndDisplayOptions(searchTerm, filters) {
    if (!this.listContainer) return;
    let numberOfOptions = 0;
    const optionElements = this.listContainer.querySelectorAll('.image-box');


    const normalizedSearchTerm = (searchTerm || '').toLowerCase();

    optionElements.forEach(element => {
      const name = element.querySelector('.image-name').textContent.toLowerCase();
      const matchesSearch = !normalizedSearchTerm || name.includes(normalizedSearchTerm);

      const option = this.options.find(
        o => o.VALUE === element.querySelector('.image-name').dataset.value
      );

      let matchesFilters = true;


      for (const [filterName, selectedValues] of Object.entries(filters)) {


        if (filterName === this.stan && selectedValues.length > 0) {
          let stanValue = option.STAN || '';
          if (stanValue == "ZERO" && option.OBSOLETE) { stanValue = "OBSOLETE" }
          const match = String(stanValue).match(/ZERO|SAFE|LOW|CRITICAL|OBSOLETE|COUPON/i);
          const status = match ? match[0].toUpperCase() : '';

          if (!selectedValues.includes(status)) {
            matchesFilters = false;
            break;
          }
          continue;
        }


        if (filterName === this.prices && selectedValues.length > 0) {

          const priceGroup = option?.ALIAS ? option.ALIAS_DESCRIPTION : option.DESCRIPTION;

          if (!selectedValues.includes(priceGroup)) {
            matchesFilters = false;
            break;
          }
          continue;
        }


        const attributeValue = option.ATTRIBUTES?.[filterName];
        if (selectedValues.length > 0 && (!attributeValue || !selectedValues.includes(attributeValue))) {
          matchesFilters = false;
          break;
        }
      }

      element.style.display = (matchesSearch && matchesFilters) ? 'block' : 'none';
      if (element.style.display == "block") { numberOfOptions++ }
    });
    this.counter.textContent = numberOfOptions
  }

  handleConfirm() {



    const selectedData = this.getSelectedValue();

    if (!selectedData) {
      showToastInContainer(this.dialog, 'warning', t('form.empty_select_warning'));
      return;
    }


    if (typeof window.dialogConfirmHandler === 'function') {
      window.dialogConfirmHandler(selectedData);

    }

    this.dialog.close();
  }


  handleCancel() {
    this.removeExistingUIElements()
    this.dialog.close();
  }

  removeExistingUIElements() {
    const existingControls = this.dialogContainer.querySelector('.dialog-controls');
    if (existingControls) existingControls.remove();
  }

  getSelectedValue() {
    const activeBoxes = document.querySelectorAll('.image-box.active');
    if (activeBoxes.length === 0) return [];

    return Array.from(activeBoxes).map(activeBox => ({
      value: activeBox.querySelector('.image-name').dataset.value,
      paramName: activeBox.dataset.paramName,
      paramDescription: activeBox.dataset.paramDescription
    }));
  }

  clearFavs() {
    if (this.favList.length === 0) {
      showToastInContainer(this.dialog, 'info', t('form.favorites_cleared_no_favs'));
      return;
    }
    this.deleteFavsBtn.addEventListener('click', async () => {
      try {
        const response = await fetch(`/position/favs/clear/${this.groupNumber}`, {
          method: 'POST',
          body: JSON.stringify({ favList: this.favList }),
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        if (!response.ok) {
          showToastInContainer(this.dialog, 'info', t('form.favorites_error'));
          throw new Error(`Błąd czyszczenia ulubionych: ${response.status}`);



        }
        else if (response.ok) {
          showToastInContainer(this.dialog, 'success', t('form.favorites_cleared_success'));
          for (const box of document.querySelectorAll('.icon.heart-icon')) {
            box.src = '/img/heart-off.png';
          }
        }
      } catch (error) {
        console.error('Błąd podczas czyszczenia ulubionych:', error);
      }
    });
  }

}


function updateFormWithSelectedValue(values, inputs, selectedData, options) {

  let valuesString = false;
  let { value, paramName, paramDescription } = selectedData;
  if (selectedData.length > 1) {
    ({ value, paramName, paramDescription } = selectedData[0]);
    valuesString = selectedData.map(obj => obj.value).join('|');
    value = valuesString
  }

  const currentInput = inputs[paramName];
  if (currentInput && currentInput.tagName === "BUTTON") {

    const currentOption = options[paramName].find(v => v.VALUE === value)
    if (currentOption?.ALIAS) {
      currentInput.innerText = `${currentOption.ALIAS} - ${currentOption.ALIAS_DESCRIPTION}`;
    }

    else if (currentOption?.VALUE == "<NONE>") {
      currentInput.innerText = paramDescription
    }
    else {
      currentInput.innerText = `${value} - ${paramDescription}`;
      if (valuesString) {
        currentInput.innerText = `${valuesString}`;
      }
      else {
        currentInput.innerText = `${value} - ${paramDescription}`;
      }
    }

    currentInput.value = value;
  }

  return [value, paramName];
}

const dialogManager = new DialogManager();


export async function createDialog(param, options, grNr, filters, attrs) {
  logFunctionName('createDialog');

  await dialogManager.initialize(param, options, grNr, filters, attrs);


}


export function getInfoFromDialog(values, inputs, options, selectedData = null) {

  logFunctionName('getInfoFromDialog');

  if (!selectedData) {
    const activeBoxes = document.querySelectorAll('.image-box.active');

    if (activeBoxes.length === 0) return;

    const selectedItems = Array.from(activeBoxes).map(box => ({
      value: box.querySelector('.image-name').dataset.value,
      paramName: box.dataset.paramName,
      paramDescription: box.dataset.paramDescription
    }));

    selectedData = selectedItems.length === 1 ? selectedItems[0] : selectedItems;
  }


  const result = updateFormWithSelectedValue(
    values,
    inputs,
    selectedData,
    options,
    'siema'
  );

  document.getElementById("color-dialog").close();
  return result;
}
