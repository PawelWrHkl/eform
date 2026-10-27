import { ExtraFunctionRegistry } from './registry.js';
import { parseExtraFuncCell } from './parseExtraFunc.js';
import { POPUP_INPUT, createPopupInput } from './popupInput/popupInput.js';

/**
 * Funkcje dodatkowe parametrów — kolumna `EXTRAFUNC` w `param.txt`.
 * Opis modułu, kontrakt i lista funkcji: docs/EXTRAFUNC.md (poza public/ — serwowany statycznie).
 *
 * Rdzeń formularza woła tylko trzy rzeczy z tej fasady:
 *   form.js          `activateExtraFunctions` (generateForm) + `syncExtraFunctions` (updateProcedure)
 *   validateUtils.js `validateExtraFunctions` (validateAllFieldsOnSubmit)
 */
export const extraFunctionRegistry = new ExtraFunctionRegistry()
    .register(POPUP_INPUT, createPopupInput);

export { extraValueKey, EXTRA_SUFFIX } from './extraValue.js';
export { parseExtraFuncCell } from './parseExtraFunc.js';

/** Powiązania parametr ↔ funkcja dla JEDNEGO zbudowanego formularza. */
export class ExtraFunctionsController {
    #bindings = [];

    /**
     * @param {object[]} params                 Definicje z `param.txt`.
     * @param {object} deps
     * @param {(paramName: string) => void} deps.requestUpdate  Przeliczenie formularza po zmianie parametru.
     * @param {ExtraFunctionRegistry} [deps.registry]
     */
    constructor(params, { requestUpdate, registry = extraFunctionRegistry }) {
        for (const param of params || []) {
            const specs = param.EXTRAFUNCS ?? parseExtraFuncCell(param.EXTRAFUNC);
            for (const { name, options } of specs) {
                if (!registry.has(name)) {
                    console.warn(`EXTRAFUNC: nieznana funkcja „${name}" przy ${param.NAME} — pomijam.`);
                    continue;
                }
                const instance = registry.create(name, { param, options, requestUpdate });
                this.#bindings.push({ paramName: param.NAME, name, instance });
            }
        }
    }

    get size() {
        return this.#bindings.length;
    }

    mount({ inputs, values, displayValues, allOptionsByParameter }) {
        for (const { paramName, instance } of this.#bindings) {
            instance.mount?.({ input: inputs?.[paramName], values, displayValues, allOptionsByParameter });
        }
        this.sync({ values, displayValues, allOptionsByParameter });
    }

    sync(state) {
        for (const { instance } of this.#bindings) instance.sync?.(state);
    }

    /** @returns {{param: string, message: string}[]} */
    validate(state) {
        const issues = [];
        for (const { paramName, instance } of this.#bindings) {
            const message = instance.validate?.(state);
            if (message) issues.push({ param: paramName, message });
        }
        return issues;
    }
}

let active = null;

/**
 * Nowy kontroler dla właśnie budowanego formularza. Poprzedni (inna grupa,
 * „wczytaj ostatnią konfigurację") przestaje być aktywny.
 */
export function activateExtraFunctions(params, deps) {
    active = new ExtraFunctionsController(params, deps);
    return active;
}

export function syncExtraFunctions(state) {
    active?.sync(state);
}

export function validateExtraFunctions(state) {
    return active ? active.validate(state) : [];
}
