/**
 * Baza wiedzy asystenta: pliki `knowledge/*.md` (w kolejności nazw) oraz dane
 * kontaktowe marki z zakładki „Kontakt" (`files/rodo/<ORG>_contact_<lang>.docx`).
 *
 * Etykiety interfejsu zapisujemy w bazie jako `{{klucz.tlumaczenia}}` — przy
 * pytaniu podstawiamy tekst z pliku tłumaczeń W JĘZYKU KLIENTA. Treść bazy
 * jest po polsku, ale nazwy przycisków są dokładnie tymi, które klient widzi
 * na ekranie (Niemiec dostaje „Erneut bestellen", a nie tłumaczenie modelu
 * z „Zamów ponownie"). Brak klucza → etykieta polska → sam klucz.
 *
 * ⚠️ Pliki `.md` czytamy przy każdym pytaniu (z cache po mtime), więc
 * poprawka bazy wiedzy działa bez restartu serwera. Komentarze HTML
 * (`<!-- … -->`) są notatkami dla redaktorów i NIE trafiają do modelu.
 *
 * ⚠️ Do modelu trafia wyłącznie ta treść — nie dokumentacja techniczna
 * (PROJECT_OVERVIEW.md opisuje wnętrzności systemu, nie portal dla klienta).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readWord } = require('../../utils/readWord');
const labels = require('./labels');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const INVOICE_LABELS_FILE = path.join(__dirname, '..', 'invoices', 'i18n', 'panel.json');
const fileCache = new Map(); // path → { mtimeMs, text, requires }

/**
 * Rozdział warunkowy: komentarz `<!-- wymaga: invoices -->` (albo
 * `!invoices`) w pliku = plik trafia do modelu tylko wtedy, gdy flaga
 * z `flagsFor` jest prawdziwa (fałszywa). Dzięki temu bot nie opowiada
 * o module, którego klient nie ma w menu.
 */
const REQUIRES_RE = /<!--\s*wymaga:\s*([!\w,\s]+?)\s*-->/;

function readCached(file) {
	const { mtimeMs } = fs.statSync(file);
	const hit = fileCache.get(file);
	if (hit && hit.mtimeMs === mtimeMs) return hit;
	const source = fs.readFileSync(file, 'utf8');
	const m = source.match(REQUIRES_RE);
	const requires = m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
	const text = source.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
	const entry = { mtimeMs, text, requires };
	fileCache.set(file, entry);
	return entry;
}

function meets(requires, flags) {
	return requires.every((r) => (r.startsWith('!') ? !flags[r.slice(1)] : !!flags[r]));
}

/**
 * Flagi rozdziałów warunkowych dla danego konta — te same warunki co menu
 * portalu (server.js: `invoicesEnabled`).
 */
function flagsFor(account, deps = {}) {
	const features = deps.features || require('../../config').features || {};
	const type = account && account.type;
	return {
		invoices: !!features.invoices && type !== 'group_shop',
		group: type === 'group'
	};
}

// `{{klucz}}` — tłumaczenia portalu; `{{inv:klucz}}` — słownik modułu faktur
// (services/invoices/i18n/panel.json, pl/en/de; brak języka → polski, jak w panelu).
const LABEL_RE = /\{\{\s*([\w!.:-]+)\s*\}\}/g;

/** Klucze `{{…}}` użyte w tekście (do testu spójności z plikami tłumaczeń). */
function labelKeys(text) {
	return [...new Set([...String(text).matchAll(LABEL_RE)].map((m) => m[1]))];
}

let invoiceLabels = null;
function loadInvoiceLabels(deps = {}) {
	if (deps.invoiceLabels) return deps.invoiceLabels;
	if (!invoiceLabels) {
		try {
			invoiceLabels = JSON.parse(fs.readFileSync(INVOICE_LABELS_FILE, 'utf8'));
		} catch (_) {
			invoiceLabels = {};
		}
	}
	return invoiceLabels;
}

function makeResolver(lang, deps = {}) {
	const l = labels.normalizeLang(lang);
	const local = labels.loadLocale(l, deps);
	const pl = l === 'pl' ? local : labels.loadLocale('pl', deps);
	const inv = loadInvoiceLabels(deps);
	const invDict = inv[l] || inv.pl || {};
	return (key) => {
		if (key.startsWith('inv:')) {
			const k = key.slice(4);
			return labels.lookup(invDict, k) || labels.lookup(inv.pl || {}, k) || null;
		}
		return labels.lookup(local, key) || labels.lookup(pl, key) || null;
	};
}

/**
 * Tekst bazy wiedzy z etykietami w języku `lang`.
 * @param {string} lang
 * @param {object} [deps]   { knowledgeDir, localesDir, invoiceLabels } — testy
 * @param {object} [flags]  wynik flagsFor(account); bez flag rozdziały warunkowe są pomijane
 */
function getKnowledgeText(lang = 'pl', deps = {}, flags = {}) {
	const dir = deps.knowledgeDir || KNOWLEDGE_DIR;
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
	const raw = files
		.map((f) => readCached(path.join(dir, f)))
		.filter((e) => meets(e.requires, flags))
		.map((e) => e.text)
		.join('\n\n');
	const resolve = makeResolver(lang, deps);
	return raw.replace(LABEL_RE, (_, key) => resolve(key) || key.replace(/^inv:/, ''));
}

/** HTML z mammotha → zwykły tekst (akapity w osobnych liniach). */
function htmlToText(html) {
	return String(html || '')
		.replace(/<\/(p|h\d|li|tr|div)>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

const contactCache = new Map(); // `${org}_${lang}` → { at, text }
const CONTACT_TTL_MS = 10 * 60 * 1000;

/**
 * Dane z zakładki „Kontakt" dla marki klienta — w języku klienta, a gdy go
 * brak, po polsku. Zwraca null, gdy marka nie ma pliku (model odsyła wtedy do
 * zakładki, zamiast zgadywać numer telefonu).
 */
async function getContactText(orgIdent, lang, deps = {}) {
	const read = deps.readWord || readWord;
	const org = String(orgIdent || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
	if (!org) return null;
	const key = `${org}_${lang}`;
	const hit = contactCache.get(key);
	if (hit && Date.now() - hit.at < CONTACT_TTL_MS) return hit.text;

	let text = null;
	for (const l of [...new Set([lang, 'pl'])]) {
		try {
			text = htmlToText(await read('rodo', `${org}_contact_${l}`)).slice(0, 2000) || null;
			if (text) break;
		} catch (_) {
			// brak pliku w tym języku — próbujemy kolejnego
		}
	}
	contactCache.set(key, { at: Date.now(), text });
	return text;
}

module.exports = { getKnowledgeText, getContactText, htmlToText, labelKeys, flagsFor, makeResolver, KNOWLEDGE_DIR };
