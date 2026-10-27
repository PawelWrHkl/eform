import { createElement } from '../../../components/htmlManipulator.js';
import { createInfoIcon } from '../../../components/info.js';
import { parseStrictInteger, integerError } from './integerValue.js';

let dialogSequence = 0;

/**
 * Okno `popup-input`: wybór TAK / NIE, a po TAK — pole na liczbę całkowitą.
 *
 *  - NIE  → okno zamyka się od razu, wynik `{ choice: 'no' }`.
 *  - TAK  → odsłania pole liczby i „Zatwierdź"; wynik `{ choice: 'yes', number }`.
 *  - Anuluj / ✕ / Esc → `null`, formularz bez zmian.
 *
 * UX: natywny `<dialog>` + `showModal()` (pułapka fokusu, `inert` tła, Esc
 * i powrót fokusu na pole formularza robi przeglądarka), wybór jako dwie
 * duże karty (`role="radio"`), `type="text"` + `inputmode="numeric"` zamiast
 * `type="number"` (to drugie przyjmuje „e", zmienia wartość kółkiem myszy
 * i po cichu oddaje `""` dla „12,5"), stepper −/+ z dużym polem dotyku,
 * walidacja na żywo dopiero po pierwszej próbie zatwierdzenia, na telefonie
 * arkusz od dołu ekranu (CSS).
 *
 * @param {object} opts
 * @param {string} opts.title             Nagłówek — opis parametru.
 * @param {string} opts.yesLabel          Opis wartości TAK ze słownika.
 * @param {string} opts.noLabel           Opis wartości NIE ze słownika.
 * @param {'yes'|'no'|null} [opts.current] Obecny wybór (edycja).
 * @param {number|null} [opts.number]     Obecna liczba (edycja).
 * @param {string} [opts.label]           Etykieta pola liczby.
 * @param {string} [opts.unit]            Jednostka przy polu.
 * @param {number|null} [opts.min]
 * @param {number|null} [opts.max]
 * @param {number} [opts.step]            Krok przycisków −/+.
 * @param {string} [opts.note]            Tekst informacyjny (opcja `info=`).
 * @param {string} [opts.info]            Zapis INFO wartości TAK (`Opis <plik.pdf>`).
 * @param {string|null} [opts.infoRoot]   Katalog załączników INFO.
 * @returns {Promise<{choice: 'yes', number: number} | {choice: 'no'} | null>}
 */
export function promptPopupInput({
    title,
    yesLabel,
    noLabel,
    current = null,
    number = null,
    label = t('form.popup_input.prompt'),
    unit = '',
    min = null,
    max = null,
    step = 1,
    note = '',
    info = '',
    infoRoot = null,
} = {}) {
    return new Promise((resolve) => {
        const id = `xf-prompt-${++dialogSequence}`;
        const dialog = createElement('dialog', {
            id,
            class: ['xf-prompt'],
            'aria-labelledby': `${id}-title`,
        }, document.body);

        const form = createElement('form', { class: ['xf-prompt__form'], novalidate: '' }, dialog);

        const header = createElement('header', { class: ['xf-prompt__header'] }, form);
        createElement('h2', { id: `${id}-title`, class: ['xf-prompt__title'], text: title || '' }, header);
        const closeBtn = createElement('button', {
            type: 'button',
            class: ['xf-prompt__close'],
            'aria-label': t('form.popup_input.close'),
            html: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        }, header);

        const choices = createElement('div', {
            class: ['xf-prompt__choices'],
            role: 'radiogroup',
            'aria-label': t('form.check_option'),
        }, form);
        const yesBtn = choiceButton(choices, yesLabel, 'yes');
        const noBtn = choiceButton(choices, noLabel, 'no');

        const amount = createElement('section', { class: ['xf-prompt__amount'], 'aria-describedby': `${id}-hint` }, form);
        amount.hidden = true;
        createElement('label', { for: `${id}-input`, class: ['xf-prompt__label'], text: label }, amount);

        const field = createElement('div', { class: ['xf-prompt__field'] }, amount);
        const minus = createElement('button', {
            type: 'button',
            class: ['xf-prompt__step'],
            'aria-label': t('form.popup_input.decrease'),
            text: '−',
        }, field);
        const input = createElement('input', {
            id: `${id}-input`,
            type: 'text',
            class: ['xf-prompt__input'],
            inputmode: 'numeric',
            pattern: min !== null && min < 0 ? '-?[0-9]*' : '[0-9]*',
            autocomplete: 'off',
            enterkeyhint: 'done',
            'aria-describedby': `${id}-hint ${id}-error`,
            value: number ?? '',
        }, field);
        if (unit) createElement('span', { class: ['xf-prompt__unit'], text: unit, 'aria-hidden': 'true' }, field);
        const plus = createElement('button', {
            type: 'button',
            class: ['xf-prompt__step'],
            'aria-label': t('form.popup_input.increase'),
            text: '+',
        }, field);

        createElement('p', { id: `${id}-hint`, class: ['xf-prompt__hint'], text: rangeHint(min, max, unit) }, amount);
        const error = createElement('p', { id: `${id}-error`, class: ['xf-prompt__error'], 'aria-live': 'assertive' }, amount);

        if (note || info) {
            const infoBox = createElement('div', { class: ['xf-prompt__info'] }, amount);
            if (note) createElement('p', { class: ['xf-prompt__note'], text: note }, infoBox);
            if (info) {
                createInfoIcon({
                    info,
                    parent: infoBox,
                    rootFilePath: infoRoot ?? undefined,
                    defaultLabel: t('form.popup_input.info_label'),
                    downloadLabel: t('form.popup_input.download'),
                });
            }
        }

        const actions = createElement('footer', { class: ['xf-prompt__actions'] }, form);
        const cancelBtn = createElement('button', {
            type: 'button',
            class: ['xf-prompt__btn', 'xf-prompt__btn--ghost'],
            text: t('form.popup_input.cancel'),
        }, actions);
        const confirmBtn = createElement('button', {
            type: 'submit',
            class: ['xf-prompt__btn', 'xf-prompt__btn--primary'],
            text: t('form.popup_input.confirm'),
        }, actions);
        confirmBtn.hidden = true;

        const allowNegative = min !== null && min < 0;
        let attempted = false;
        let settled = false;

        const showError = (message) => {
            error.textContent = message || '';
            input.setAttribute('aria-invalid', message ? 'true' : 'false');
            field.classList.toggle('is-invalid', !!message);
        };

        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (dialog.open) {
                if (typeof dialog.close === 'function') dialog.close();
                else dialog.removeAttribute('open');
            }
            dialog.remove();
            resolve(result);
        };

        const revealAmount = () => {
            yesBtn.setAttribute('aria-checked', 'true');
            noBtn.setAttribute('aria-checked', 'false');
            amount.hidden = false;
            confirmBtn.hidden = false;
            input.focus();
            input.select();
        };

        const stepBy = (direction) => {
            const currentNumber = parseStrictInteger(input.value, { allowNegative });
            const base = currentNumber ?? (min !== null ? min - direction * step : 0);
            let next = base + direction * step;
            if (min !== null) next = Math.max(min, next);
            if (max !== null) next = Math.min(max, next);
            input.value = String(next);
            if (attempted) showError(integerError(input.value, { min, max }));
            input.focus();
        };

        yesBtn.addEventListener('click', revealAmount);
        noBtn.addEventListener('click', () => finish({ choice: 'no' }));

        input.addEventListener('input', () => {
            const sanitized = input.value.replace(allowNegative ? /[^0-9-]/g : /[^0-9]/g, '')
                .replace(/(?!^)-/g, '');
            if (sanitized !== input.value) input.value = sanitized;
            if (attempted) showError(integerError(input.value, { min, max }));
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowUp') { event.preventDefault(); stepBy(1); }
            if (event.key === 'ArrowDown') { event.preventDefault(); stepBy(-1); }
        });
        minus.addEventListener('click', () => stepBy(-1));
        plus.addEventListener('click', () => stepBy(1));

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            // Enter przed wyborem TAK niczego nie zatwierdza.
            if (amount.hidden) return;
            attempted = true;
            const message = integerError(input.value, { min, max });
            showError(message);
            if (message) {
                input.focus();
                input.select();
                return;
            }
            finish({ choice: 'yes', number: parseStrictInteger(input.value, { allowNegative }) });
        });

        cancelBtn.addEventListener('click', () => finish(null));
        closeBtn.addEventListener('click', () => finish(null));
        // Esc: natywne `cancel` zamknęłoby okno bez naszej wiedzy.
        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            finish(null);
        });
        dialog.addEventListener('close', () => finish(null));

        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }

        if (current === 'yes') {
            revealAmount();
        } else {
            noBtn.setAttribute('aria-checked', current === 'no' ? 'true' : 'false');
            (current === 'no' ? noBtn : yesBtn).focus();
        }
    });
}

function choiceButton(parent, text, choice) {
    return createElement('button', {
        type: 'button',
        class: ['xf-prompt__choice', `xf-prompt__choice--${choice}`],
        role: 'radio',
        'aria-checked': 'false',
        dataset: { choice },
        text,
    }, parent);
}

function rangeHint(min, max, unit) {
    const suffix = unit ? ` ${unit}` : '';
    const intOnly = t('form.popup_input.hint_int');
    if (min !== null && max !== null) return `${intOnly} · ${t('form.popup_input.range', { min, max })}${suffix}`;
    if (min !== null) return `${intOnly} · ${t('form.popup_input.range_min', { min })}${suffix}`;
    if (max !== null) return `${intOnly} · ${t('form.popup_input.range_max', { max })}${suffix}`;
    return intOnly;
}
