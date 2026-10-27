import { createElement } from '../../../components/htmlManipulator.js';
import { valueInfoFilesUrl } from '../../../components/info.js';
import { extraValueKey } from '../extraValue.js';
import { parseStrictInteger } from './integerValue.js';
import { promptPopupInput } from './popupInputDialog.js';

export const POPUP_INPUT = 'popup-input';

/**
 * Konfiguracja z opcji `EXTRAFUNC`, np. `popup-input(unit=cm|min=10|max=500)`.
 * Domyślnie: TAK = `Y`, NIE = pierwsza inna wartość słownika, liczba
 * całkowita ≥ 1, bez górnej granicy.
 */
export function popupInputConfig(options = {}) {
    const toInt = (raw, fallback) => {
        if (raw === undefined || raw === '') return fallback;
        const number = Number(raw);
        if (!Number.isInteger(number)) {
            console.warn(`EXTRAFUNC popup-input: „${raw}" to nie liczba całkowita — używam ${fallback}.`);
            return fallback;
        }
        return number;
    };
    return {
        trigger: options.trigger || 'Y',
        no: options.no || '',
        min: toInt(options.min, 1),
        max: toInt(options.max, null),
        step: Math.max(1, toInt(options.step, 1)),
        unit: options.unit || '',
        label: options.label || '',
        note: options.info || '',
    };
}

/**
 * Tekst dla ludzi: opis wybranej wartości + liczba („TAK: 120 cm").
 * Trafia do `option_description`, z którego czyta KAŻDY widok zlecenia,
 * PDF, mail i PDF produkcyjny (services/orderService.js `jsonTextBackToMap`).
 * Bez „ - " — PDF dzieli komórkę na pierwszym „ - " (utils/pdfValueParts.js).
 */
export function describeWithNumber(baseDescription, number, unit) {
    const amount = unit ? `${number} ${unit}` : String(number);
    const base = String(baseDescription ?? '').trim();
    return base ? `${base}: ${amount}` : amount;
}

// To samo źródło opisu co `buildValuesToDisplay` — alias klienta ma pierwszeństwo.
function optionDescription(option) {
    if (!option) return '';
    return option.ALIAS ? (option.ALIAS_DESCRIPTION ?? '') : (option.DESCRIPTION ?? '');
}

/**
 * `popup-input` — parametr słownikowy TAK/NIE (`Y`/`N` w paramdict).
 *
 * W formularzu pole jest PRZYCISKIEM; klik otwiera okno z wyborem TAK / NIE.
 * NIE zamyka okno i ustawia NIE; TAK odsłania w oknie pole na liczbę całkowitą.
 *
 * Lista `<select>` z `createForm.js` zostaje w DOM-ie, ukryta — dalej niesie
 * wartość dla rdzenia (zapis, edycja/`fillFields`, `resetSelectValues`,
 * walidacja). Wybór z okna przechodzi przez jej zdarzenie `change`, czyli
 * dokładnie tę samą ścieżkę co zwykły wybór z listy.
 *
 * Zapis (oba, bo czytają je różni odbiorcy):
 *  - `values[<PARAM>___EXTRA]` = liczba → `json_parameters` → plik JSON dla fabryki,
 *  - `displayValues.get(<PARAM>).option_description` = „TAK: 120 cm" → tabele, PDF, maile.
 *
 * Stan jest UZGADNIANY w `sync` po każdym przeliczeniu, a nie łatany w
 * miejscach, które zmieniają wartość: reset zależności (`DEPENDENCES`),
 * wyłączenie przez `ENABLE`, „wczytaj ostatnią konfigurację", edycja i
 * przeliczenie serwerowe przechodzą przez ten sam punkt.
 */
export function createPopupInput({ param, options }) {
    const config = popupInputConfig(options);
    const name = param.NAME;
    const key = extraValueKey(name);

    let select = null;
    let trigger = null;
    let dialogOpen = false;
    let lastOptions = null;

    const isTriggered = (values) => String(values[name] ?? '') === config.trigger;
    // Liczba z `localStorage` albo importu może przyjść jako tekst „120".
    const storedNumber = (values) => {
        const raw = values[key];
        if (Number.isInteger(raw)) return raw;
        return typeof raw === 'string' ? parseStrictInteger(raw, { allowNegative: config.min < 0 }) : null;
    };

    function choiceOptions(allOptionsByParameter) {
        const list = allOptionsByParameter?.[name] ?? [];
        const yes = list.find(option => option.VALUE === config.trigger) ?? null;
        const no = (config.no && list.find(option => option.VALUE === config.no))
            || list.find(option => option.VALUE && option.VALUE !== config.trigger)
            || null;
        return { list, yes, no };
    }

    function renderTrigger(values) {
        if (!trigger) return;
        const { list, yes } = choiceOptions(lastOptions);
        const value = String(values[name] ?? '');
        const number = storedNumber(values);
        let text;
        if (value === config.trigger) {
            text = number === null
                ? `${optionDescription(yes)} — ${t('form.popup_input.missing')}`
                : describeWithNumber(optionDescription(yes), number, config.unit);
        } else if (value) {
            text = optionDescription(list.find(option => option.VALUE === value)) || value;
        } else {
            text = t('form.check_word');
        }
        trigger.textContent = text;
        trigger.classList.toggle('is-set', value !== '');
        trigger.classList.toggle('is-missing', value === config.trigger && number === null);
        trigger.setAttribute('aria-label', `${param.DESCRIPTION}: ${text}`);
    }

    function commit(values, value) {
        select.value = value;
        // `form.js` (słuchacz `change`) wpisuje wartość i odpala przeliczenie,
        // a jego `sync` dopisuje liczbę do opisu i odświeża przycisk.
        select.dispatchEvent(new Event('change'));
        renderTrigger(values);
    }

    async function open(values) {
        if (dialogOpen) return;
        dialogOpen = true;
        const { yes, no } = choiceOptions(lastOptions);
        const value = String(values[name] ?? '');
        try {
            const result = await promptPopupInput({
                title: param.DESCRIPTION,
                yesLabel: optionDescription(yes) || config.trigger,
                noLabel: optionDescription(no) || no?.VALUE || 'N',
                current: value === config.trigger ? 'yes' : (value ? 'no' : null),
                number: storedNumber(values),
                label: config.label || undefined,
                unit: config.unit,
                min: config.min,
                max: config.max,
                step: config.step,
                note: config.note,
                info: yes?.INFO || '',
                infoRoot: valueInfoFilesUrl(window.tempGroupNumber),
            });
            if (!result) return;
            if (result.choice === 'yes') {
                values[key] = result.number;
                commit(values, config.trigger);
            } else {
                delete values[key];
                commit(values, no?.VALUE ?? 'N');
            }
        } finally {
            dialogOpen = false;
            trigger?.focus();
        }
    }

    return {
        mount({ input, values, allOptionsByParameter }) {
            if (!input || input.tagName !== 'SELECT') {
                console.warn(`EXTRAFUNC popup-input: ${name} nie jest listą wyboru — funkcja pominięta.`);
                return;
            }
            select = input;
            lastOptions = allOptionsByParameter;

            select.classList.add('xf-native-hidden');
            select.setAttribute('aria-hidden', 'true');
            select.tabIndex = -1;

            // Klasa `button` — ten sam wygląd co przyciski pól z oknem wyboru (GRAPHICS).
            trigger = createElement('button', {
                type: 'button',
                id: `${name}__popup`,
                class: ['button', 'xf-trigger'],
                'aria-haspopup': 'dialog',
            }, null);
            select.insertAdjacentElement('afterend', trigger);
            trigger.addEventListener('click', () => open(values));

            // Walidacja rdzenia oznacza błąd na (ukrytej) liście — przenosimy go na przycisk.
            new MutationObserver(() => {
                trigger.classList.toggle('invalid-input', select.classList.contains('invalid-input'));
            }).observe(select, { attributes: true, attributeFilter: ['class'] });

            renderTrigger(values);
        },

        sync({ values, displayValues, allOptionsByParameter }) {
            if (allOptionsByParameter) lastOptions = allOptionsByParameter;
            if (!isTriggered(values)) {
                delete values[key];
            } else {
                const number = storedNumber(values);
                const entry = displayValues?.get(name);
                if (number !== null && entry && entry.option_value) {
                    const { yes } = choiceOptions(lastOptions);
                    entry.option_description = describeWithNumber(optionDescription(yes), number, config.unit);
                }
            }
            renderTrigger(values);
        },

        validate({ values }) {
            if (!isTriggered(values) || storedNumber(values) !== null) return null;
            return t('form.popup_input.required');
        },
    };
}
