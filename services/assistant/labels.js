/**
 * Etykiety interfejsu w języku klienta — podstawiane w bazie wiedzy
 * (`{{klucz}}`, knowledge.js) i w opisach elementów do wskazania (uiCatalog).
 *
 * ⚠️ Czytamy pliki JSON bezpośrednio, a nie przez `i18n.__()`: `i18n` ma
 * `updateFiles: true`, więc zapytanie o brakujący klucz DOPISAŁOBY go do
 * współdzielonego pliku tłumaczeń w /mnt/eform/languages.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { localesDir, availabeLanguages } = require('../../config');

const cache = new Map(); // lang → { mtimeMs, data }

function loadLocale(lang, deps = {}) {
	const dir = deps.localesDir || localesDir;
	const file = path.join(dir, `${lang}.json`);
	try {
		const { mtimeMs } = fs.statSync(file);
		const hit = cache.get(file);
		if (hit && hit.mtimeMs === mtimeMs) return hit.data;
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		cache.set(file, { mtimeMs, data });
		return data;
	} catch (_) {
		return {};
	}
}

/** Wartość klucza z kropkami (`base.orders_history`) albo null. */
function lookup(data, key) {
	let node = data;
	for (const part of String(key).split('.')) {
		if (!node || typeof node !== 'object' || !(part in node)) return null;
		node = node[part];
	}
	if (typeof node !== 'string') return null;
	// Część tłumaczeń ma doklejone znaki zerowej szerokości (np. BOM w „dodaj komentarz").
	const text = node.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
	return text || null;
}

function normalizeLang(lang) {
	const l = String(lang || '').toLowerCase().slice(0, 2);
	return availabeLanguages.includes(l) ? l : 'en';
}

module.exports = { lookup, loadLocale, normalizeLang };
