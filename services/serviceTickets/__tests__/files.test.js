'use strict';
/** Pliki zgłoszeń (files.js): typ po sygnaturze, limity, katalog tymczasowy. */
const test = require('node:test');
const assert = require('node:assert');
const files = require('../files');

const pad = (b) => Buffer.concat([b, Buffer.alloc(32)]);
const JPG = pad(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
const PNG = pad(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
const WEBP = pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]));
const HEIC = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]));
const MP4 = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypisom')]));
const MOV = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')]));
const PDF = pad(Buffer.from('%PDF-1.7'));
const EXE = pad(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'));

test('sniffMime: siedem dozwolonych typów po sygnaturze, .exe przemianowany na .jpg odpada', () => {
	assert.equal(files.sniffMime(JPG), 'image/jpeg');
	assert.equal(files.sniffMime(PNG), 'image/png');
	assert.equal(files.sniffMime(WEBP), 'image/webp');
	assert.equal(files.sniffMime(HEIC), 'image/heic');
	assert.equal(files.sniffMime(MP4), 'video/mp4');
	assert.equal(files.sniffMime(MOV), 'video/quicktime');
	assert.equal(files.sniffMime(PDF), 'application/pdf');
	assert.equal(files.sniffMime(EXE), null);
	assert.equal(files.sniffMime(Buffer.from('<svg/>')), null);
	assert.equal(files.sniffMime(Buffer.alloc(3)), null);
});

test('checkFiles: nazwa z serwera, oryginalna tylko jako metadana; za duży / zły typ / za dużo → kody', () => {
	const { ok, errors } = files.checkFiles([
		{ buffer: JPG, originalname: 'zdjęcie z budowy.jpg', size: JPG.length },
		{ buffer: EXE, originalname: 'wirus.jpg', size: EXE.length },
		{ buffer: PNG, originalname: 'a.png', size: 21 * 1024 * 1024 }
	]);
	assert.equal(ok.length, 1);
	assert.equal(ok[0].mime, 'image/jpeg');
	assert.equal(ok[0].originalName, 'zdjęcie z budowy.jpg');
	assert.match(ok[0].storedName, /^01-[0-9a-f]{12}\.jpg$/);
	assert.deepEqual(errors.map((e) => `${e.code}@${e.index}`), ['file_type@1', 'file_too_big@2']);
	const many = files.checkFiles(Array.from({ length: 11 }, () => ({ buffer: JPG, originalname: 'x.jpg', size: 10 })));
	assert.equal(many.errors[0].code, 'too_many_files');
	assert.equal(many.ok.length, 10);
	assert.match(files.checkFiles([{ buffer: JPG, size: 10 }], 3).ok[0].storedName, /^04-/, 'numeracja ciągła przy dopisku');
});

test('stage → commit przenosi z .tmp do katalogu zgłoszenia; discard sprząta .tmp', async () => {
	const calls = [];
	const fsp = {
		mkdir: async (p) => calls.push(['mkdir', p]),
		writeFile: async (p) => calls.push(['write', p]),
		rename: async (a, b) => calls.push(['rename', a, b]),
		unlink: async (p) => calls.push(['unlink', p]),
		rm: async (p) => calls.push(['rm', p])
	};
	const { ok } = files.checkFiles([{ buffer: JPG, originalname: 'a.jpg', size: 5 }, { buffer: PDF, originalname: 'b.pdf', size: 5 }]);
	const staged = await files.stageFiles(fsp, '/out', ok);
	assert.equal(staged.length, 2);
	assert.ok(staged.every((s) => s.tmpPath.startsWith('/out/service/.tmp/')));
	await files.commitFiles(fsp, '/out', 'SRV-2026-00001', staged);
	const renames = calls.filter((c) => c[0] === 'rename');
	assert.equal(renames.length, 2);
	assert.equal(renames[0][2], `/out/service/SRV-2026-00001/${staged[0].storedName}`);
	await files.discardFiles(fsp, staged);
	assert.equal(calls.filter((c) => c[0] === 'unlink').length, 2);
	await files.removeTicketDir(fsp, '/out', 'SRV-2026-00001');
	assert.deepEqual(calls.at(-1), ['rm', '/out/service/SRV-2026-00001']);
});
