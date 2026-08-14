/**
 * Warunki handlowe per grupa asortymentowa — jedno miejsce, które łączy dwa
 * światy: pliki konfiguracyjne aplikacji zewnętrznej i nakładkę eForma.
 *
 * ## Skąd się bierze cennik klienta
 *
 * `data/<grupa>/data/<język>/prod.txt`, kolumny:
 *   PARAM_SCRIPTS      HKL/TCN/CENA=param-CENA-Cmul1.3.js,HKL/TCN/CENA_RABAT=param-CENA_RABAT-0.js,…
 *   PARAMDICT_ALIASES  HKL/TCN/KOLOR=paramdict-KOLOR-ZONNELUX.txt,…
 *   USERS              TCN,BIURO,…
 *
 * Czyli per (organizacja / klient / grupa / parametr): wariant skryptu cenowego
 * (`C`, `K`, `Cmul1.3` = cennik C razy 1,3), osobny skrypt rabatu (`-0` = zero),
 * osobny dla dopłat i osobny dla cen SUB, plus kolekcja tkanin. Nie ma tu
 * „procentu rabatu" jako liczby — rabat JEST wyborem wariantu pliku.
 *
 * ## Dlaczego nakładka, a nie dopisywanie do pliku
 *
 * ⚠️ `prod.txt` generuje APLIKACJA ZEWNĘTRZNA (pliki grup zmieniają się co kilka
 * dni; w całym eFormie nie ma ani jednego zapisu do nich). Dopisane przez nas
 * wpisy zniknęłyby przy najbliższej regeneracji, i to bez śladu. Dlatego:
 *
 *   plik  = źródło prawdy dla klientów założonych w aplikacji zewnętrznej,
 *   baza  = warunki klientów założonych w eFormie (`customer_group_terms`),
 *   odczyt = ZAWSZE przez `resolveGroupTerms`, które nakłada bazę na plik.
 *
 * Nakładka wygrywa z plikiem świadomie: jeśli aplikacja zewnętrzna kiedyś pozna
 * naszego klienta i dopisze go do `prod.txt`, wpis w bazie nadal opisuje to, co
 * ustawił operator w panelu — a rozjazd widać w panelu (kolumna „źródło").
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { dataDir } = require('../../config');
const { getClientScripts, loadClientAliases, parseScriptEntries, parseProdTxt } = require('../formEngine/clientScripts');
const orgCustomersDb = require('../../db/orgCustomers');
const { log } = require('../../utils/logging');

/** Wariant z nazwy pliku: `param-CENA-Cmul1.3.js` → `Cmul1.3`. */
function variantFromScript(fileName) {
	if (!fileName) return null;
	const match = String(fileName).match(/^param-(.+)-([^-]+)\.js$/);
	return match ? match[2] : null;
}

/** Kolekcja z nazwy pliku: `paramdict-KOLOR-ZONNELUX.txt` → `ZONNELUX`. */
function collectionFromFile(fileName) {
	if (!fileName) return null;
	const inner = String(fileName).replace(/^paramdict-/, '').replace(/\.txt$/, '');
	const lastHyphen = inner.lastIndexOf('-');
	return lastHyphen > 0 ? inner.slice(lastHyphen + 1) : null;
}

/**
 * Grupy asortymentowe dostępne w instalacji (katalogi numeryczne w `dataDir`),
 * z opisem i listą organizacji z `prod.txt`.
 *
 * @param {string} [lang]
 * @returns {Array<{ groupNumber: string, description: string, owners: string[] }>}
 */
function listGroups(lang = 'pl') {
	let entries = [];
	try {
		entries = fs.readdirSync(dataDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
			.map((e) => e.name)
			.sort((a, b) => Number(a) - Number(b));
	} catch (err) {
		log('groupTerms.listGroups: nie mogę odczytać katalogu grup:', err.message);
		return [];
	}

	return entries.map((groupNumber) => {
		let prod = null;
		try {
			prod = parseProdTxt(fs.readFileSync(path.join(dataDir, groupNumber, 'data', lang, 'prod.txt'), 'utf8'));
		} catch {
			prod = null;
		}
		return {
			groupNumber,
			description: (prod && prod.description) || '',
			owners: prod && prod.owners ? prod.owners.split(',').map((o) => o.trim()).filter(Boolean) : []
		};
	});
}

/**
 * Warunki z PLIKU dla jednego klienta w jednej grupie — dokładnie to, co widzi
 * dziś silnik i przeglądarka.
 *
 * @param {object} params
 * @param {string} params.groupNumber
 * @param {string} params.orgIdent
 * @param {string} params.userIdent
 * @param {string} [params.lang]
 * @returns {{ scripts: object, collections: object, hasAccess: boolean }}
 */
function readFileTerms({ groupNumber, orgIdent, userIdent, lang = 'pl' }) {
	const scripts = {};
	const fromFile = getClientScripts({ groupNumber, lang, orgIdent, userIdent });
	if (fromFile) {
		for (const entry of fromFile[1]) scripts[entry.param] = entry.file;
	}

	const collections = {};
	let prod = null;
	try {
		prod = parseProdTxt(fs.readFileSync(path.join(dataDir, String(groupNumber), 'data', lang, 'prod.txt'), 'utf8'));
	} catch {
		prod = null;
	}
	if (prod && prod.paramdict_aliases) {
		const org = String(orgIdent).trim().toLowerCase();
		const client = String(userIdent).trim().toLowerCase();
		for (const entry of parseScriptEntries(prod.paramdict_aliases)) {
			if (entry.organization.trim().toLowerCase() === org && entry.client.trim().toLowerCase() === client) {
				collections[entry.param] = entry.file;
			}
		}
	}

	const users = prod && prod.users ? prod.users.split(',').map((u) => u.trim().toLowerCase()) : [];
	return {
		scripts,
		collections,
		hasAccess: users.includes(String(userIdent).trim().toLowerCase())
	};
}

/**
 * Warunki efektywne: plik + nakładka z bazy, z informacją, skąd pochodzą.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {string} params.groupNumber
 * @param {string} params.orgIdent
 * @param {string} params.userIdent
 * @param {string} [params.lang]
 * @returns {Promise<{ groupNumber: string, source: 'baza'|'plik'|'brak', scripts: object, collections: object, hasAccess: boolean, priceVariant: string|null, discountVariant: string|null, fileScripts: object }>}
 */
async function resolveGroupTerms({ userId, groupNumber, orgIdent, userIdent, lang = 'pl' }) {
	const file = readFileTerms({ groupNumber, orgIdent, userIdent, lang });
	const overlay = await orgCustomersDb.getGroupTerms(userId, groupNumber);

	const scripts = { ...file.scripts, ...(overlay ? overlay.scripts : {}) };
	const collections = { ...file.collections, ...(overlay ? overlay.collections : {}) };
	const hasOwn = Object.keys(scripts).length > 0;

	return {
		groupNumber: String(groupNumber),
		source: overlay ? 'baza' : (Object.keys(file.scripts).length ? 'plik' : 'brak'),
		scripts,
		collections,
		fileScripts: file.scripts,
		hasAccess: overlay ? !!overlay.has_access : file.hasAccess,
		priceVariant: variantFromScript(scripts.CENA) || null,
		discountVariant: variantFromScript(scripts.CENA_RABAT) || null,
		configured: hasOwn
	};
}

/**
 * Warunki klienta we WSZYSTKICH grupach — widok „cenniki tego klienta".
 *
 * @param {object} params `{ userId, orgIdent, userIdent, lang }`
 * @returns {Promise<object[]>}
 */
async function listClientGroupTerms({ userId, orgIdent, userIdent, lang = 'pl' }) {
	const groups = listGroups(lang);
	const out = [];
	for (const group of groups) {
		const terms = await resolveGroupTerms({ userId, groupNumber: group.groupNumber, orgIdent, userIdent, lang });
		out.push({ ...group, ...terms });
	}
	return out;
}

/**
 * Kopiuje warunki innego klienta tej samej organizacji — najszybsza droga do
 * skonfigurowania nowego konta („taki cennik jak X"), bo warianty i kolekcje są
 * już dobrane pod grupy tej organizacji.
 *
 * @param {object} params
 * @param {number} params.userId               nowy klient (docelowy)
 * @param {number} params.organizationId
 * @param {string} params.orgIdent
 * @param {string} params.templateUserIdent    ident klienta-wzorca
 * @param {string} [params.lang]
 * @param {number|null} [params.actorUserId]
 * @returns {Promise<{ copied: string[] }>}
 */
async function copyTermsFromClient({ userId, organizationId, orgIdent, templateUserIdent, lang = 'pl', actorUserId = null }) {
	const copied = [];
	for (const group of listGroups(lang)) {
		const file = readFileTerms({ groupNumber: group.groupNumber, orgIdent, userIdent: templateUserIdent, lang });
		if (!Object.keys(file.scripts).length) continue;

		await orgCustomersDb.upsertGroupTerms({
			userId,
			organizationId,
			groupNumber: group.groupNumber,
			scripts: file.scripts,
			collections: file.collections,
			hasAccess: true,
			priceVariant: variantFromScript(file.scripts.CENA),
			discountVariant: variantFromScript(file.scripts.CENA_RABAT),
			notes: `skopiowane z ${templateUserIdent}`,
			createdByUserId: actorUserId
		});
		copied.push(group.groupNumber);
	}
	return { copied };
}

/**
 * Warianty cenników dostępne w katalogu grupy — z nazw plików `param-CENA-*.js`.
 * To one są „cennikiem" w tym systemie, więc lista rozwijana w panelu musi
 * pochodzić z dysku, a nie z wpisanej na sztywno tabelki.
 *
 * @param {string|number} groupNumber
 * @returns {{ price: string[], discount: string[] }}
 */
function listVariants(groupNumber) {
	const dir = path.join(dataDir, String(groupNumber), 'data');
	let files = [];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return { price: [], discount: [] };
	}
	const collect = (prefix) => [...new Set(files
		.filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.js'))
		.map((f) => variantFromScript(f))
		.filter(Boolean))].sort();

	return { price: collect('param-CENA'), discount: collect('param-CENA_RABAT') };
}

/**
 * Ustawia warianty cennika i rabatu dla klienta w jednej grupie.
 *
 * Nazwy plików budujemy z wariantu dla WSZYSTKICH parametrów cenowych, które
 * grupa deklaruje w `prod.txt` dla kogokolwiek (`CENA`, `DOPLATA`, `SUB___CENA`,
 * rabaty…). Inaczej trzeba by je wyklikać po jednym, a w praktyce klient dostaje
 * jeden cennik na całą grupę — dokładnie tak wyglądają wpisy istniejących kont
 * (`HKL/TCN` w grupie 43 ma `Cmul1.3` w cenie, dopłacie i cenach SUB naraz).
 *
 * Parametry bez wariantu (`param-OPIS_POZYCJI.js`) i te, których plik dla danego
 * wariantu nie istnieje, są pomijane — nie zapisujemy ścieżki, której nie ma na dysku.
 *
 * @param {object} params
 * @returns {Promise<{ scripts: object, skipped: string[] }>}
 */
async function setGroupVariant({ userId, organizationId, groupNumber, priceVariant, discountVariant, lang = 'pl', actorUserId = null, collections = null }) {
	const prodPath = path.join(dataDir, String(groupNumber), 'data', lang, 'prod.txt');
	let prod = null;
	try {
		prod = parseProdTxt(fs.readFileSync(prodPath, 'utf8'));
	} catch {
		prod = null;
	}

	// Zbiór parametrów cenowych używanych w tej grupie — z całej kolumny
	// PARAM_SCRIPTS, nie tylko z wpisów jednego klienta.
	const params = new Set();
	if (prod && prod.param_scripts) {
		for (const entry of parseScriptEntries(prod.param_scripts)) params.add(entry.param);
	}

	const dir = path.join(dataDir, String(groupNumber), 'data');
	let files = new Set();
	try {
		files = new Set(fs.readdirSync(dir));
	} catch { /* brak katalogu — nic nie zapiszemy */ }

	const scripts = {};
	const skipped = [];
	for (const param of params) {
		const isDiscount = /RABAT/.test(param);
		const variant = isDiscount ? discountVariant : priceVariant;
		if (!variant) continue;
		const fileName = `param-${param}-${variant}.js`;
		if (files.has(fileName)) scripts[param] = fileName;
		else skipped.push(param);
	}

	if (!Object.keys(scripts).length) {
		return { scripts: {}, skipped };
	}

	await orgCustomersDb.upsertGroupTerms({
		userId,
		organizationId,
		groupNumber,
		scripts,
		collections: collections || null,
		hasAccess: true,
		priceVariant: priceVariant || null,
		discountVariant: discountVariant || null,
		notes: null,
		createdByUserId: actorUserId
	});
	return { scripts, skipped };
}

module.exports = {
	listGroups,
	readFileTerms,
	resolveGroupTerms,
	listClientGroupTerms,
	copyTermsFromClient,
	listVariants,
	setGroupVariant,
	variantFromScript,
	collectionFromFile
};
