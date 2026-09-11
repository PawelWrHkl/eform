'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureInfoFilesDir } = require('../ensureInfoFilesDir');

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'eform-infofiles-'));
}

test('zakłada <photoPath>/files, gdy photoPath istnieje', () => {
	const root = tmpRoot();
	const photoPath = path.join(root, 'data');
	const infoFilesDir = path.join(photoPath, 'files');
	fs.mkdirSync(photoPath, { recursive: true });

	assert.equal(ensureInfoFilesDir({ photoPath, infoFilesDir }), 'created');
	assert.ok(fs.statSync(infoFilesDir).isDirectory());

	fs.rmSync(root, { recursive: true, force: true });
});

test('drugie wywołanie nie tworzy nic ponownie', () => {
	const root = tmpRoot();
	const photoPath = path.join(root, 'data');
	const infoFilesDir = path.join(photoPath, 'files');
	fs.mkdirSync(infoFilesDir, { recursive: true });

	assert.equal(ensureInfoFilesDir({ photoPath, infoFilesDir }), 'exists');

	fs.rmSync(root, { recursive: true, force: true });
});

// To jest właściwy powód istnienia tego helpera: /mnt/eform jest udziałem CIFS,
// a `mkdir -p` na niezamontowanym udziale zrobiłby drzewo na dysku lokalnym,
// maskując awarię montażu i zajmując miejsce na `/`.
test('NIE tworzy nic, gdy photoPath nie istnieje (udział niezamontowany)', () => {
	const root = tmpRoot();
	const photoPath = path.join(root, 'nie-zamontowane', 'data');
	const infoFilesDir = path.join(photoPath, 'files');
	const logged = [];

	const result = ensureInfoFilesDir({
		photoPath,
		infoFilesDir,
		log: (...args) => logged.push(args.map(String).join(' '))
	});

	assert.equal(result, 'skipped-no-parent');
	assert.equal(fs.existsSync(photoPath), false, 'nie wolno utworzyć katalogu nadrzędnego');
	assert.equal(fs.existsSync(infoFilesDir), false, 'nie wolno utworzyć katalogu załączników');
	assert.match(logged.join('\n'), /photoPath nie istnieje/);

	fs.rmSync(root, { recursive: true, force: true });
});

test('błąd zapisu jest logowany, nie rzucany — start serwera nie może na tym polec', () => {
	const logged = [];
	const result = ensureInfoFilesDir({
		photoPath: '/udzial',
		infoFilesDir: '/udzial/files',
		log: (...args) => logged.push(args.map(String).join(' ')),
		fs: {
			existsSync: (p) => p === '/udzial',
			mkdirSync: () => { throw new Error('EROFS: read-only file system'); }
		}
	});

	assert.equal(result, 'failed');
	assert.match(logged.join('\n'), /nie udało się utworzyć/);
});

test('brak argumentów nie wysypuje wywołania', () => {
	assert.equal(ensureInfoFilesDir(), 'failed');
	assert.equal(ensureInfoFilesDir({ photoPath: '/x' }), 'failed');
});
