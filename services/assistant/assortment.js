/**
 * Asortyment konfiguratora dla Eforka: działy (np. PLISY) i ich grupy / systemy
 * (np. EOS, COSIFLOR, BASIC) dostępne dla konta — dokładnie to, co klient widzi
 * w listach „Wybierz dział” / „Wybierz grupę”.
 *
 * Te same pliki i ta sama reguła co przeglądarka
 * (public/scripts/formTools/getAvailableForms.js):
 *   • `<dataDir>/data/<lang>/group.txt` — działy (transponowany TSV: NUM,
 *     PRODUCTS = numery grup, DESCRIPTION),
 *   • `<dataDir>/<grupa>/data/<lang>/prod.txt` — nagłówek grupy (CODE,
 *     DESCRIPTION, USERS); gdy USERS jest wypełnione, grupa jest tylko dla
 *     wymienionych kont (ident klienta, bez wielkości liter),
 *   • dział bez żadnej grupy dla konta znika (jak w liście działów).
 * Pliki grup mają po kilkaset kB (PARAM_SCRIPTS) — wynik trzymamy 10 min w pamięci.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { parseTransposedTsv } = require('../configuratorTester/groupDiscovery');

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // lang → { at, departments }

/** Pola nagłówka prod.txt (wiersze „POLE<TAB>wartość”), bez parsowania całego pliku. */
function headerFields(file, wanted) {
	const text = fs.readFileSync(file, 'utf8');
	const out = {};
	let pos = 0;
	while (pos < text.length && Object.keys(out).length < wanted.length) {
		let end = text.indexOf('\n', pos);
		if (end < 0) end = text.length;
		const line = text.slice(pos, end).replace(/\r$/, '');
		const tab = line.indexOf('\t');
		const key = (tab >= 0 ? line.slice(0, tab) : line).trim().toLowerCase();
		if (wanted.includes(key) && !(key in out)) out[key] = (line.slice(tab + 1).split('\t')[0] || '').trim();
		pos = end + 1;
	}
	return out;
}

function load(lang, deps = {}) {
	const dataDir = deps.dataDir || config.dataDir;
	const now = deps.now ? deps.now() : Date.now();
	const hit = cache.get(`${dataDir}|${lang}`);
	if (hit && now - hit.at < TTL_MS) return hit.departments;
	let groupTxt = path.join(dataDir, 'data', lang, 'group.txt');
	if (!fs.existsSync(groupTxt)) groupTxt = path.join(dataDir, 'data', 'pl', 'group.txt');
	const departments = parseTransposedTsv(fs.readFileSync(groupTxt, 'utf8'))
		.filter((d) => d.num && d.description)
		.map((d) => {
			const groups = String(d.products || '').split(',').map((g) => g.trim()).filter(Boolean).map((num) => {
				let file = path.join(dataDir, num, 'data', lang, 'prod.txt');
				if (!fs.existsSync(file)) file = path.join(dataDir, num, 'data', 'pl', 'prod.txt');
				if (!fs.existsSync(file)) return null;
				try {
					const h = headerFields(file, ['code', 'description', 'users']);
					const users = h.users ? h.users.split(',').map((u) => u.trim().toUpperCase()).filter(Boolean) : null;
					return { num, code: h.code || num, name: h.description || num, users };
				} catch (_) {
					return null;
				}
			}).filter(Boolean);
			return { num: d.num, name: d.description, groups };
		});
	cache.set(`${dataDir}|${lang}`, { at: now, departments });
	return departments;
}

/**
 * Asortyment konta: [{ department, groups: [nazwa…] }] — tylko grupy dla tego
 * identu (jak getGroups w przeglądarce) i działy, w których coś zostało.
 */
function forUser(lang, userIdent, deps = {}) {
	const ident = String(userIdent || '').trim().toUpperCase();
	return load(lang, deps)
		.map((d) => ({
			department: d.name,
			groups: d.groups.filter((g) => !g.users || (ident && g.users.includes(ident))).map((g) => g.name)
		}))
		.filter((d) => d.groups.length);
}

module.exports = { forUser, load, headerFields, _cache: cache };
