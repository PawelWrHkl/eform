/**
 * Przełącznik admina dla rabatu 1% za korzystanie z serwisu
 * (`services/portalUsageDiscount.js`).
 *
 * Ten sam wzorzec co `services/accessLock.js`: stan w jednym pliku JSON
 * w `dataDir`, czytany przy KAŻDYM pytaniu — bez cache w pamięci procesu.
 * To celowe: rabat wylicza zarówno proces hosta, jak i kontenery, a stan ma być
 * wspólny i natychmiastowy, bez restartu czegokolwiek. Świadomie NIE jest to
 * zmienna środowiskowa ani flaga w `config.js` — właściciel ma to przełączać
 * sam, z panelu, w trakcie pracy.
 *
 * ⚠️ Domyślne stany są niesymetryczne i tak ma być:
 *  • **brak pliku** → rabat WŁĄCZONY. Nikt jeszcze nie dotknął przełącznika,
 *    więc obowiązuje zachowanie sprzed jego wprowadzenia.
 *  • **plik jest, ale nie da się go odczytać** → rabat WYŁĄCZONY. Istnienie
 *    pliku znaczy, że ktoś ten przełącznik ustawił; skoro nie wiemy jak, nie
 *    rozdajemy pieniędzy na ślepo. Awaria jest głośna w logu, a skutek
 *    najwyżej taki, że rabat nie zejdzie — odwrotny błąd (cicho naliczony 1%
 *    mimo wyłączenia) wyszedłby dopiero na fakturach.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../config');
const { log } = require('../utils/logging');

const SWITCH_FILE = path.join(dataDir, '.portal-usage-discount.json');

function readState() {
	if (!fs.existsSync(SWITCH_FILE)) {
		return { enabled: true, updatedAt: null, configured: false };
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(SWITCH_FILE, 'utf8'));
		return {
			enabled: parsed.enabled !== false,
			updatedAt: parsed.updatedAt || null,
			configured: true
		};
	} catch (err) {
		log('[portalUsageDiscount] nie udało się odczytać przełącznika', SWITCH_FILE, '-', err.message,
			'- rabat traktowany jako WYŁĄCZONY do czasu naprawy pliku');
		return { enabled: false, updatedAt: null, configured: true, broken: true };
	}
}

function isEnabled() {
	return readState().enabled;
}

function setEnabled(enabled) {
	const dir = path.dirname(SWITCH_FILE);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const state = {
		enabled: !!enabled,
		updatedAt: new Date().toISOString()
	};
	fs.writeFileSync(SWITCH_FILE, JSON.stringify(state));
	return state;
}

module.exports = { isEnabled, setEnabled, getState: readState, SWITCH_FILE };
