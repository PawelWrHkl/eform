/**
 * Pliki zgłoszeń serwisowych: typ po ZAWARTOŚCI (sygnatury), nazwy na dysku
 * nadawane przez serwer, katalog tymczasowy → po COMMIT przeniesienie do
 * `outputData/service/<numer>/`, po ROLLBACK sprzątanie.
 *
 * ⚠️ Rozszerzenie i `mimetype` z przeglądarki są tylko podpowiedzią — `.exe`
 * przemianowany na `.jpg` ma sygnaturę MZ, nie JPEG, i odpada tutaj.
 * Bez biblioteki: siedem typów z decyzji 13 to kilkanaście linii.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const { LIMITS } = require('./rules');

const TICKETS_DIR = 'service';
const TMP_DIR = '.tmp';

const EXT = Object.freeze({
	'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
	'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/quicktime': 'mov'
});
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];
const MP4_BRANDS = ['isom', 'iso2', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', 'dash', 'mmp4'];

/** @returns {string|null} MIME z sygnatury albo null, gdy typ nieznany / niedozwolony */
function sniffMime(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
	if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
	if (buf.subarray(0, 8).equals(PNG)) return 'image/png';
	if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
	if (buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
	if (buf.toString('latin1', 4, 8) === 'ftyp') {
		const brand = buf.toString('latin1', 8, 12);
		if (HEIC_BRANDS.includes(brand)) return 'image/heic';
		if (brand === 'qt  ') return 'video/quicktime';
		if (MP4_BRANDS.includes(brand) || brand.startsWith('3gp')) return 'video/mp4';
	}
	return null;
}

function isImage(mime) { return String(mime || '').startsWith('image/'); }

/**
 * Sprawdza pliki z multera (`{ buffer, originalname, size }`) i nadaje nazwy dyskowe.
 * @returns {{ ok: Array<{buffer: Buffer, originalName: string, mime: string, size: number, storedName: string}>, errors: Array<{field: string, code: string, index: number}> }}
 */
function checkFiles(files, startIndex = 0) {
	const list = Array.isArray(files) ? files : [];
	const errors = [];
	const ok = [];
	if (list.length > LIMITS.maxFiles) errors.push({ field: 'files', code: 'too_many_files', index: -1 });
	list.slice(0, LIMITS.maxFiles).forEach((f, i) => {
		const size = Number(f.size ?? (f.buffer && f.buffer.length)) || 0;
		if (size > LIMITS.maxFileBytes) return errors.push({ field: 'files', code: 'file_too_big', index: i });
		const mime = sniffMime(f.buffer);
		if (!mime || !LIMITS.mimes.includes(mime)) return errors.push({ field: 'files', code: 'file_type', index: i });
		const n = startIndex + i + 1;
		ok.push({
			buffer: f.buffer,
			originalName: String(f.originalname || `file-${n}`).slice(0, 255),
			mime,
			size,
			storedName: `${String(n).padStart(2, '0')}-${crypto.randomBytes(6).toString('hex')}.${EXT[mime]}`
		});
	});
	return { ok, errors };
}

function ticketDir(outputData, number) { return path.join(outputData, TICKETS_DIR, number); }

/** Zapisuje bufory w katalogu tymczasowym. Zwraca listę z `tmpPath` (do `commitFiles` / `discardFiles`). */
async function stageFiles(fsp, outputData, files) {
	const dir = path.join(outputData, TICKETS_DIR, TMP_DIR);
	await fsp.mkdir(dir, { recursive: true });
	const staged = [];
	for (const f of files) {
		const tmpPath = path.join(dir, `${crypto.randomBytes(8).toString('hex')}-${f.storedName}`);
		await fsp.writeFile(tmpPath, f.buffer);
		staged.push({ ...f, tmpPath });
	}
	return staged;
}

/** Po COMMIT: przenosi pliki do katalogu zgłoszenia. */
async function commitFiles(fsp, outputData, number, staged) {
	if (!staged.length) return;
	const dir = ticketDir(outputData, number);
	await fsp.mkdir(dir, { recursive: true });
	for (const f of staged) await fsp.rename(f.tmpPath, path.join(dir, f.storedName));
}

/** Po ROLLBACK (albo odrzuceniu): usuwa pliki tymczasowe, błędy ignoruje. */
async function discardFiles(fsp, staged) {
	await Promise.all((staged || []).map((f) => fsp.unlink(f.tmpPath).catch(() => {})));
}

/** Usuwa cały katalog zgłoszenia (zamiatarka demo). */
async function removeTicketDir(fsp, outputData, number) {
	if (!number) return;
	await fsp.rm(ticketDir(outputData, number), { recursive: true, force: true });
}

module.exports = { sniffMime, isImage, checkFiles, ticketDir, stageFiles, commitFiles, discardFiles, removeTicketDir, EXT, TICKETS_DIR };
