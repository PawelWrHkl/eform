'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️ Oba `process.env` MUSZĄ być ustawione przed `require` serwisu: `config.js`
// czyta je przy ładowaniu, a serwis wylicza z nich ścieżkę pliku raz, w chwili
// require. `LOG_PATH` osobno, bo `utils/logging` zakłada katalog logów przy
// require i bez podmiany test dopisywałby się do wspólnego logu środowiska.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eform-discount-switch-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.LOG_PATH = path.join(TMP, 'log');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const przelacznik = require('../portalUsageDiscountSwitch');

function usunPlik() {
	fs.rmSync(przelacznik.SWITCH_FILE, { force: true });
}

test('bez pliku rabat jest WŁĄCZONY — zachowanie sprzed wprowadzenia przełącznika', () => {
	usunPlik();
	const state = przelacznik.getState();
	assert.equal(przelacznik.isEnabled(), true);
	assert.equal(state.configured, false, 'nikt jeszcze nie dotknął przełącznika');
});

test('wyłączenie jest trwałe i widoczne od razu', () => {
	usunPlik();
	const state = przelacznik.setEnabled(false);

	assert.equal(state.enabled, false);
	assert.ok(state.updatedAt, 'zapisujemy kiedy przełączono');
	assert.equal(przelacznik.isEnabled(), false);
	assert.equal(przelacznik.getState().configured, true);
});

test('ponowne włączenie wraca do naliczania', () => {
	przelacznik.setEnabled(false);
	przelacznik.setEnabled(true);
	assert.equal(przelacznik.isEnabled(), true);
});

// Stan czytany jest z dysku przy KAŻDYM pytaniu, bez cache w pamięci — inaczej
// przełączenie w panelu nie dotarłoby do procesu, który akurat liczy wycenę
// (host i kontenery to osobne procesy).
test('zmiana pliku z zewnątrz działa bez restartu procesu', () => {
	przelacznik.setEnabled(true);
	assert.equal(przelacznik.isEnabled(), true);

	fs.writeFileSync(przelacznik.SWITCH_FILE, JSON.stringify({ enabled: false }));
	assert.equal(przelacznik.isEnabled(), false, 'brak cache — odczyt za każdym razem');
});

// ⚠️ Asymetria domyślnych stanów: brak pliku = włączony (status quo), ale plik
// nieczytelny = wyłączony. Skoro plik istnieje, ktoś ten przełącznik ustawił;
// przy nieznanym stanie lepiej nie naliczyć rabatu niż rozdać go po cichu.
test('uszkodzony plik WYŁĄCZA rabat, zamiast po cichu go przywracać', () => {
	fs.writeFileSync(przelacznik.SWITCH_FILE, 'to nie jest JSON');

	const state = przelacznik.getState();
	assert.equal(przelacznik.isEnabled(), false);
	assert.equal(state.broken, true);
	assert.equal(state.configured, true);
});

test('nieznane pole w pliku nie wyłącza rabatu — liczy się tylko `enabled`', () => {
	fs.writeFileSync(przelacznik.SWITCH_FILE, JSON.stringify({ cokolwiek: 1 }));
	assert.equal(przelacznik.isEnabled(), true);
});

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});
