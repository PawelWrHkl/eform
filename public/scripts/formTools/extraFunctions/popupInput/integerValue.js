/**
 * Ścisłe parsowanie liczby całkowitej z tekstu pola.
 * „120" → 120, „ 007 " → 7, „-5" → -5 (tylko gdy `allowNegative`),
 * „1.5", „1,5", „1e3", „12cm", „" → `null`.
 */
export function parseStrictInteger(text, { allowNegative = false } = {}) {
    const value = String(text ?? '').trim();
    const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
    if (!pattern.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
}

/**
 * Komunikat błędu dla wpisanego tekstu albo `null`, gdy wartość jest poprawna.
 * @param {string} text
 * @param {{min?: number|null, max?: number|null}} range
 */
export function integerError(text, { min = null, max = null } = {}) {
    if (String(text ?? '').trim() === '') {
        return t('form.popup_input.err_empty');
    }
    const number = parseStrictInteger(text, { allowNegative: min !== null && min < 0 });
    if (number === null) {
        return t('form.popup_input.err_int');
    }
    if (min !== null && number < min) {
        return t('form.popup_input.err_min', { min });
    }
    if (max !== null && number > max) {
        return t('form.popup_input.err_max', { max });
    }
    return null;
}
