
import { createElement } from './htmlManipulator.js'

export async function createChecboxField(parent, id, textLabel= t('form.last_choice')) {
  const checkBoxLabel = textLabel;
  if (document.getElementById('check-form') == null) {
    if (!document.getElementById('form-check')) {
      const checkDiv = createElement("div", { id: 'check-form', class: ["form-check"] }, parent);
      createElement("label", { class: ["form-check-label", 'checkboxtext'], for: "last-group-checkbox", text: checkBoxLabel }, checkDiv);
      const checkBox = createElement("input", { type: "checkbox", class: ["form-check-input"], id: "last-group-checkbox" }, checkDiv);

      return checkBox;
    }
  }
}

export async function checkBoxReaction(checkBox) {
  if (checkBox && checkBox.checked) {
    console.log('checkbox checked')
    checkBox.checked = false;
    checkBox.disabled = true;
    checkBox.parentElement.hidden = true;

    return await getLastChoice();
  }
}


export async function getLastChoice() {
  console.log('getLastChoice')
  let choice = JSON.parse(localStorage.getItem('lastChoice'))

  if (choice?.department && choice?.group) {
    return choice
  } else {
    console.log('No last choice found');
    return null;
  }
}

/** Ikona „historia" (strzałka wokół zegara) — przycisk ostatniej konfiguracji. */
const LAST_CONFIG_ICON = '<svg class="last-config-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">'
  + '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
  + 'd="M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2"/></svg>';

/**
 * „Załaduj ostatnią konfigurację".
 *
 * Z `parent` (pasek `.asortment-inputs`): mała ikona z dymkiem, wstawiona
 * PRZED checkboxem „ostatni wybór" (`#check-form`). Bez `parent` — dawne
 * pływające okno na środku strony.
 *
 * ⚠️ Identyfikatory `last-config-info` (kontener: main.js pokazuje/chowa go
 * `style.display`, wariant B przenosi go do karty wyboru) i
 * `last-config-confirm` (przycisk; robot kopiowania copyLineRunner.js) bez zmian.
 */
export function createLastConfigInfoPopUp(parent = null) {
  const label = t('position.get_last_config');

  if (parent) {
    const infoContainer = createElement('div', {
      class: ['last-config-info', 'last-config-inline'],
      id: 'last-config-info'
    }, parent);
    const checkForm = parent.querySelector('#check-form');
    if (checkForm) parent.insertBefore(infoContainer, checkForm);

    const loadButton = createElement('button', {
      // Bez `.btn` — mobilne style robią z każdego `.btn` pasek na całą szerokość (width:100% !important).
      // `has-tooltip`: dymek z `data-tooltip` (layout.css) i bez shimmeru `button::after` (theme.css).
      class: ['last-config-icon-btn', 'has-tooltip'],
      type: 'button',
      id: 'last-config-confirm'
    }, infoContainer);
    loadButton.setAttribute('aria-label', label);
    loadButton.dataset.tooltip = label;
    loadButton.innerHTML = LAST_CONFIG_ICON;
    // Tekst zostaje w przycisku (czytniki ekranu, wariant B pokazuje go w karcie wyboru).
    createElement('span', { class: ['last-config-label'], text: label }, loadButton);

    return { container: infoContainer, lastConfigButton: loadButton }
  }

  const body = document.body
  body.style.display='block'

  const infoContainer = createElement('div', {
    class: ['last-config-info',  'bg-transparent', 'justify-content-center', 'align-items-center', 'p-3'],
    id:'last-config-info'
  }, body)

  const loadButton = createElement('button', {
    class: ['btn', 'btn-outline-secondary'],
    text: label,
    type: 'button',
    id:'last-config-confirm'
  }, infoContainer)

  return { container: infoContainer, lastConfigButton: loadButton }
}
