'use strict';

const fsDefault = require('fs');

/**
 * Zakłada katalog załączników INFO — `config.infoFilesDir`, czyli
 * `<photoPath>/files`, adresowany w przeglądarce jako `/photos/files/…`
 * (`INFO_FILES_URL` w `public/scripts/components/info.js`). Leżą w nim pliki
 * z zapisu `Opis <karta.pdf>` w `param.INFO` i w kolumnie `<PARAM>_INFO`
 * w paramdict.
 *
 * Tworzy katalog **tylko wtedy, gdy katalog nadrzędny `photoPath` już istnieje.**
 * `/mnt/eform` to udział sieciowy (CIFS): przy niezamontowanym udziale
 * `mkdir -p` utworzyłby całe drzewo na dysku LOKALNYM pod punktem montowania —
 * zamaskowałby brak montażu (aplikacja „działa", tylko nie widzi żadnych plików)
 * i zajmował miejsce na `/`. Zapełniony `/` już raz zatrzymał syncthinga
 * i wymusił usunięcie dwóch środowisk — patrz komentarz na górze
 * `docker-compose.yml`. Dlatego brak `photoPath` to awaria infrastruktury do
 * zaraportowania w logu, a nie stan do „naprawienia" mkdirem.
 *
 * Nigdy nie rzuca — start serwera nie może zależeć od dostępności udziału.
 *
 * @returns {'created'|'exists'|'skipped-no-parent'|'failed'}
 */
function ensureInfoFilesDir({ photoPath, infoFilesDir, log = () => { }, fs = fsDefault } = {}) {
	if (!photoPath || !infoFilesDir) {
		log('⚠ ensureInfoFilesDir: brak photoPath lub infoFilesDir — pomijam');
		return 'failed';
	}

	try {
		if (!fs.existsSync(photoPath)) {
			log('⚠ photoPath nie istnieje:', photoPath, '— pomijam tworzenie', infoFilesDir, '(udział niezamontowany?)');
			return 'skipped-no-parent';
		}

		if (fs.existsSync(infoFilesDir)) {
			return 'exists';
		}

		fs.mkdirSync(infoFilesDir, { recursive: true });
		log('→ utworzono katalog załączników INFO:', infoFilesDir);
		return 'created';
	} catch (err) {
		log('⚠ nie udało się utworzyć katalogu załączników INFO', infoFilesDir, '-', err.message);
		return 'failed';
	}
}

module.exports = { ensureInfoFilesDir };
