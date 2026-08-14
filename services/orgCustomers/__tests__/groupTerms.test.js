'use strict';

/**
 * Warunki per grupa asortymentowa: nakładka z bazy vs pliki `prod.txt`.
 *
 * Testy pilnują reguły, na której stoi cały mechanizm: **plik jest źródłem
 * prawdy dla klientów aplikacji zewnętrznej, baza tylko dokłada tych z eForma**.
 * Gdyby nakładka zaczęła dotykać starych kont, popsułaby ceny w całej instalacji.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { variantFromScript, collectionFromFile } = require('../groupTerms');
const {
	getClientScripts,
	loadClientAliases,
	primeClientOverlay,
	clearClientOverlay
} = require('../../formEngine/clientScripts');

/** Atrapa bazy — zwraca nakładkę tylko dla wskazanego `userId`. */
function fakeDb(userId, terms) {
	return {
		async getGroupTerms(id) {
			return Number(id) === userId ? terms : null;
		}
	};
}

test('wariant cennika i kolekcja czytane z nazw plików', () => {
	// Tak wygląda realny wpis HKL/TCN dla grupy 43.
	assert.equal(variantFromScript('param-CENA-Cmul1.3.js'), 'Cmul1.3');
	assert.equal(variantFromScript('param-CENA_RABAT-0.js'), '0');
	assert.equal(variantFromScript('param-SUB___CENA-J.js'), 'J');
	assert.equal(variantFromScript('param-OPIS_POZYCJI.js'), null); // brak wariantu
	assert.equal(variantFromScript(null), null);

	assert.equal(collectionFromFile('paramdict-KOLOR-ZONNELUX.txt'), 'ZONNELUX');
	assert.equal(collectionFromFile('paramdict-KOLOR_DODATKOWY-LUXAN2024.txt'), 'LUXAN2024');
	assert.equal(collectionFromFile(null), null);
});

test('bez nakładki klient spoza prod.txt nie dostaje żadnego skryptu (dziś = cena 0)', () => {
	clearClientOverlay();
	const scripts = getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'KLIENT-ZEFORMA' });

	assert.equal(scripts, null);
});

test('nakładka dokłada skrypty klientowi, którego nie ma w prod.txt', async () => {
	clearClientOverlay();
	await primeClientOverlay(
		{ userId: 777, orgIdent: 'HKL', userIdent: 'KLIENT-ZEFORMA', groupNumber: '43' },
		{ db: fakeDb(777, { scripts: { CENA: 'param-CENA-C.js', CENA_RABAT: 'param-CENA_RABAT-0.js' }, collections: {}, has_access: 1 }) }
	);

	const result = getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'KLIENT-ZEFORMA' });
	assert.ok(result, 'nakładka powinna dać komplet wpisów');
	const [rootPath, entries] = result;
	assert.equal(rootPath, '/data/43/data/');
	assert.deepEqual(
		entries.map((e) => `${e.param}=${e.file}`).sort(),
		['CENA=param-CENA-C.js', 'CENA_RABAT=param-CENA_RABAT-0.js']
	);
});

test('nakładka nadpisuje pojedynczy parametr, resztę zostawia z pliku', async () => {
	clearClientOverlay();
	// TCN istnieje w prod.txt grupy 43 z cennikiem Cmul1.3.
	const zPliku = getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'TCN' });
	assert.ok(zPliku, 'TCN musi być w prod.txt — inaczej test nie ma czego sprawdzać');
	const plikoweCena = zPliku[1].find((e) => e.param === 'CENA').file;
	const liczbaWpisow = zPliku[1].length;

	await primeClientOverlay(
		{ userId: 888, orgIdent: 'HKL', userIdent: 'TCN', groupNumber: '43' },
		{ db: fakeDb(888, { scripts: { CENA: 'param-CENA-A.js' }, collections: {}, has_access: 1 }) }
	);

	const zNakladka = getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'TCN' });
	assert.equal(zNakladka[1].find((e) => e.param === 'CENA').file, 'param-CENA-A.js');
	// Pozostałe parametry (DOPLATA, SUB___CENA, rabaty…) zostają z pliku.
	assert.equal(zNakladka[1].length, liczbaWpisow);
	assert.notEqual(plikoweCena, 'param-CENA-A.js');
});

test('po wyczyszczeniu nakładki stary klient wraca do konfiguracji z pliku', async () => {
	clearClientOverlay();
	const przed = getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'TCN' });
	const cenaZPliku = przed[1].find((e) => e.param === 'CENA').file;

	await primeClientOverlay(
		{ userId: 888, orgIdent: 'HKL', userIdent: 'TCN', groupNumber: '43' },
		{ db: fakeDb(888, { scripts: { CENA: 'param-CENA-A.js' }, collections: {}, has_access: 1 }) }
	);
	clearClientOverlay();

	const po = getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'TCN' });
	assert.equal(po[1].find((e) => e.param === 'CENA').file, cenaZPliku);
});

test('nakładka jest per grupa — wpis dla 43 nie dotyka grupy 71', async () => {
	clearClientOverlay();
	await primeClientOverlay(
		{ userId: 999, orgIdent: 'HKL', userIdent: 'TCN', groupNumber: '43' },
		{ db: fakeDb(999, { scripts: { CENA: 'param-CENA-A.js' }, collections: {}, has_access: 1 }) }
	);

	const grupa71 = getClientScripts({ groupNumber: '71', lang: 'nl', orgIdent: 'HKL', userIdent: 'TCN' });
	assert.notEqual(grupa71[1].find((e) => e.param === 'CENA').file, 'param-CENA-A.js');
	clearClientOverlay();
});

test('brak wpisu w bazie nie zostawia śmieci w pamięci', async () => {
	clearClientOverlay();
	const primed = await primeClientOverlay(
		{ userId: 111, orgIdent: 'HKL', userIdent: 'NIEMA', groupNumber: '43' },
		{ db: fakeDb(222, { scripts: { CENA: 'param-CENA-A.js' } }) }
	);

	assert.equal(primed, false);
	assert.equal(getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'NIEMA' }), null);
});

test('awaria bazy nie wywraca odczytu — zostaje konfiguracja z pliku', async () => {
	clearClientOverlay();
	const primed = await primeClientOverlay(
		{ userId: 333, orgIdent: 'HKL', userIdent: 'TCN', groupNumber: '43' },
		{ db: { async getGroupTerms() { throw new Error('DB padła'); } } }
	);

	assert.equal(primed, false);
	assert.ok(getClientScripts({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'TCN' }));
});

test('kolekcje tkanin też idą przez nakładkę', async () => {
	clearClientOverlay();
	await primeClientOverlay(
		{ userId: 444, orgIdent: 'HKL', userIdent: 'KLIENT-ZEFORMA', groupNumber: '43' },
		{ db: fakeDb(444, { scripts: {}, collections: { KOLOR: 'paramdict-KOLOR-ZONNELUX.txt' }, has_access: 1 }) }
	);

	// Plik istnieje w katalogu grupy 43 — sprawdzamy, że nakładka do niego trafia.
	const aliases = loadClientAliases({ groupNumber: '43', lang: 'nl', orgIdent: 'HKL', userIdent: 'KLIENT-ZEFORMA' });
	assert.ok(Object.prototype.hasOwnProperty.call(aliases, 'KOLOR'));
	clearClientOverlay();
});
