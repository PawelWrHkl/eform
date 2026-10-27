/**
 * Rejestr funkcji dodatkowych (kolumna `EXTRAFUNC` w `param.txt`).
 *
 * Nowa funkcja = nowy plik z fabryką + jedna linia `register` w `index.js`.
 * Rdzeń formularza (`form.js`, `validateUtils.js`) zna tylko fasadę z
 * `index.js` i NIE zmienia się przy dokładaniu kolejnych funkcji.
 *
 * Fabryka dostaje `{ param, options, requestUpdate }` i zwraca obiekt
 * (wszystkie metody opcjonalne):
 *
 *   mount({ input, values, displayValues, allOptionsByParameter })
 *       Raz, po zbudowaniu pola. Wyłącznie przeglądarka/DOM (zdarzenia, widoki).
 *   sync({ values, displayValues, allOptionsByParameter })
 *       Na końcu KAŻDEGO `updateProcedure`. Doprowadza `values`/`displayValues`
 *       do spójnego stanu. Musi działać bez DOM-u — ten sam kod liczy pozycje
 *       po stronie serwera (services/formEngine, JSDOM bez interakcji).
 *   validate({ values }) → string | null
 *       Przy zapisie pozycji: komunikat błędu albo `null`, gdy wszystko gra.
 */
export class ExtraFunctionRegistry {
    #factories = new Map();

    register(name, factory) {
        const key = String(name).toLowerCase();
        if (this.#factories.has(key)) {
            throw new Error(`EXTRAFUNC: funkcja „${key}" jest już zarejestrowana.`);
        }
        if (typeof factory !== 'function') {
            throw new TypeError(`EXTRAFUNC: fabryka „${key}" musi być funkcją.`);
        }
        this.#factories.set(key, factory);
        return this;
    }

    has(name) {
        return this.#factories.has(String(name).toLowerCase());
    }

    create(name, context) {
        const factory = this.#factories.get(String(name).toLowerCase());
        return factory ? factory(context) : null;
    }
}
