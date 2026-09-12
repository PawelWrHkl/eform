'use strict';

const fsDefault = require('fs');
const path = require('path');

/**
 * Numer grupy asortymentowej wchodzi tu z URL-a (`/position/version/:groupNr/`),
 * a trafia do ścieżki na dysku — więc musi być dokładnie tym, czym są nazwy
 * katalogów grup na udziale: samymi cyframi (`00`, `01`, `39`, `43`). Bez tego
 * `..%2f..` w adresie pozwoliłby zakładać katalogi poza `photoPath`.
 */
const GROUP_NUMBER = /^\d{1,6}$/;

/**
 * Katalog załączników INFO **konkretnej grupy**: `<photoPath>/<grupa>/files`,
 * adresowany w przeglądarce jako `/photos/<grupa>/files/…` (ta sama konwencja,
 * co zdjęcia wartości: `/photos/<grupa>/<PARAM>/<plik>`). Leżą w nim pliki
 * z zapisu `Opis <karta.pdf>` w kolumnie `<PARAM>_INFO` w paramdict.
 *
 * @returns {string|null} ścieżka albo null, gdy numer grupy jest niepoprawny
 */
function groupInfoFilesDir(photoPath, groupNumber) {
	if (!photoPath) return null;
	const group = String(groupNumber ?? '').trim();
	if (!GROUP_NUMBER.test(group)) return null;
	return path.join(photoPath, group, 'files');
}

/**
 * Wspólna część obu `ensure*`: tworzy katalog, ale **tylko gdy jego katalog
 * nadrzędny już istnieje**.
 *
 * `/mnt/eform` to udział sieciowy (CIFS). Przy niezamontowanym udziale
 * `mkdir -p` utworzyłby całe drzewo na dysku LOKALNYM pod punktem montowania —
 * zamaskowałby brak montażu (aplikacja „działa", tylko nie widzi żadnych plików)
 * i zajmował miejsce na `/`. Zapełniony `/` już raz zatrzymał syncthinga
 * i wymusił usunięcie dwóch środowisk — patrz komentarz na górze
 * `docker-compose.yml`. Dlatego brak katalogu nadrzędnego to awaria
 * infrastruktury do zaraportowania w logu, a nie stan do „naprawienia" mkdirem.
 *
 * Nigdy nie rzuca — ani start serwera, ani odpowiedź HTTP nie mogą zależeć od
 * dostępności udziału.
 *
 * @returns {'created'|'exists'|'skipped-no-parent'|'failed'}
 */
function ensureDirUnderExistingParent({ parentDir, targetDir, label, log, fs }) {
	try {
		if (!fs.existsSync(parentDir)) {
			log('⚠', label, '— katalog nadrzędny nie istnieje:', parentDir, '— pomijam tworzenie', targetDir);
			return 'skipped-no-parent';
		}

		if (fs.existsSync(targetDir)) {
			return 'exists';
		}

		fs.mkdirSync(targetDir);
		log('→ utworzono katalog załączników INFO:', targetDir);
		return 'created';
	} catch (err) {
		log('⚠ nie udało się utworzyć katalogu załączników INFO', targetDir, '-', err.message);
		return 'failed';
	}
}

/**
 * Globalny katalog załączników INFO — `config.infoFilesDir` (`<photoPath>/files`,
 * adres `/photos/files/`). Obsługuje INFO **parametru** (`param.INFO`), wspólne
 * dla wszystkich grup (np. karty child-safety). Zakładany przy starcie serwera.
 */
function ensureInfoFilesDir({ photoPath, infoFilesDir, log = () => { }, fs = fsDefault } = {}) {
	if (!photoPath || !infoFilesDir) {
		log('⚠ ensureInfoFilesDir: brak photoPath lub infoFilesDir — pomijam');
		return 'failed';
	}

	return ensureDirUnderExistingParent({
		parentDir: photoPath,
		targetDir: infoFilesDir,
		label: 'globalne załączniki INFO',
		log,
		fs
	});
}

/**
 * Katalog załączników INFO **wartości** dla jednej grupy (`<photoPath>/<grupa>/files`).
 * Zakładany leniwie, przy pierwszym wejściu w grupę (`/position/version/:groupNr/`),
 * bo przy starcie serwera nie wiadomo, które grupy będą używane, a nowe pojawiają
 * się bez restartu.
 *
 * Katalog grupy musi już istnieć — jeśli go nie ma, to znaczy że grupa nie ma
 * zdjęć ani danych na udziale (albo udział nie jest zamontowany), i zakładanie
 * pod nią czegokolwiek tylko zamaskowałoby problem.
 */
function ensureGroupInfoFilesDir({ photoPath, groupNumber, log = () => { }, fs = fsDefault } = {}) {
	const targetDir = groupInfoFilesDir(photoPath, groupNumber);
	if (!targetDir) {
		log('⚠ ensureGroupInfoFilesDir: niepoprawny numer grupy:', groupNumber);
		return 'failed';
	}

	return ensureDirUnderExistingParent({
		parentDir: path.dirname(targetDir),
		targetDir,
		label: `załączniki INFO grupy ${groupNumber}`,
		log,
		fs
	});
}

module.exports = { ensureInfoFilesDir, ensureGroupInfoFilesDir, groupInfoFilesDir };
