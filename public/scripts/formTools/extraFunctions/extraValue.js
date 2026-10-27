/**
 * Klucz w `values` (→ `json_parameters`), pod którym funkcja dodatkowa
 * parametru trzyma swoją daną — np. liczbę z `popup-input`.
 *
 * ⚠️ Sufiks `___` jest celowy: w całym systemie oznacza METADANE parametru
 * (`___DESCRIPTION`, `___DICT`, `___TITLE`, `___VISIBLE`) i takie klucze są
 * pomijane przez importer zleceń, tester konfiguratora i `stubDisplayEntries`
 * formEngine'u. Eksport na produkcję (`services/sendOrderService.js`) wysyła
 * za to WSZYSTKIE klucze `json_parameters` — liczba dociera do fabryki sama.
 *
 * `clearDisabledValues` (validateUtils.js) traktuje ten klucz jak
 * `___DESCRIPTION`: żyje i umiera razem ze swoim parametrem. Bez tego czyścił
 * go do `''` przy każdym przeliczeniu (nie jest nazwą włączonego parametru).
 */
export const EXTRA_SUFFIX = '___EXTRA';

export function extraValueKey(paramName) {
    return `${paramName}${EXTRA_SUFFIX}`;
}
