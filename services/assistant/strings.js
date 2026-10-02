/**
 * Napisy widżetu i komunikatów asystenta — słownik w repo (`i18n/strings.json`).
 *
 * Nie w plikach tłumaczeń portalu: te żyją poza repo (/mnt/eform/languages)
 * i są nadpisywane z `jezyki.xlsx` przy logowaniu, więc nowe klucze wymagałyby
 * edycji arkusza poza wdrożeniem kodu. Ten sam zabieg co
 * templates/partials/efor-v2-strings.njk.
 */

'use strict';

const DICT = require('./i18n/strings.json');

/** Napisy dla języka; brakujące klucze uzupełnia polski, nieznany język = angielski. */
function forLang(lang) {
	return { ...DICT.pl, ...(DICT[lang] || DICT.en) };
}

module.exports = { forLang, DICT };
