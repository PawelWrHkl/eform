/**
 * Proponowane pytania w oknie asystenta (chipsy przy pustej rozmowie).
 *
 * Treść: `i18n/suggestions.json` — najpierw pytania dopasowane do bieżącego
 * ekranu (`pages`, pierwsze dopasowanie ścieżki wygrywa), potem
 * najpopularniejsze (`default`), bez powtórzeń, najwyżej `max`. Pytania
 * z `requires` (np. `invoices`) tylko dla kont, które mają dany moduł —
 * te same flagi co rozdziały bazy wiedzy (knowledge.flagsFor).
 */

'use strict';

const DATA = require('./i18n/suggestions.json');
const { normalizeLang } = require('./labels');

const PAGES = DATA.pages.map((p) => ({ re: new RegExp(p.path), show: p.show }));

function allowed(question, flags) {
	const r = question.requires;
	if (!r) return true;
	return r.startsWith('!') ? !flags[r.slice(1)] : !!flags[r];
}

/**
 * @param {string} path   ścieżka strony (req.path)
 * @param {string} lang
 * @param {object} flags  np. { invoices: true }
 * @returns {string[]}    treści pytań w języku `lang`
 */
function forPage(path, lang, flags = {}, data = DATA) {
	const l = normalizeLang(lang);
	const pages = data === DATA ? PAGES : data.pages.map((p) => ({ re: new RegExp(p.path), show: p.show }));
	const page = pages.find((p) => p.re.test(String(path || '')));
	const ids = [...new Set([...(page ? page.show : []), ...data.default])];
	const out = [];
	for (const id of ids) {
		const q = data.questions[id];
		if (!q || !allowed(q, flags)) continue;
		const text = q[l] || q.en || q.pl;
		if (text) out.push(text);
		if (out.length >= (data.max || 5)) break;
	}
	return out;
}

module.exports = { forPage, DATA };
