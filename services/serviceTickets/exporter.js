/**
 * Dostarczenie zgłoszenia do HKL — kanał domyślny: paczka plików.
 *
 *   <katalog>/<numer>/<pliki zdjęć…>
 *   <katalog>/<numer>/ticket.json          ← ZAWSZE OSTATNI (`.tmp` + rename)
 *   <katalog>/<numer>/event-<n>.json       ← dopisek klienta nr n (+ jego pliki obok)
 *
 * Katalog: FTP `FTP_HOST`/`FTP_USER` (konto orderbot, jak zlecenia) —
 * `SERVICE_FTP_DIR`, domyślnie `/service` przy `NODE_ENV=prod` i `/service-test`
 * poza produkcją (wzorzec invoiceFtpExport). Lustro lokalne zawsze:
 * `outputData/service-out/<numer>/`. Program czytający katalog może brać paczkę
 * dopiero, gdy widzi `ticket.json` — wcześniej jest niekompletna.
 *
 * Docelowy zapis do bazy reklamacji HKL (192.168.0.196, MySQL `reklamacje`) to
 * osobny adapter z tą samą metodą `deliver(pkg, opts)` — patrz PROJECT_OVERVIEW.
 */

'use strict';

const path = require('path');
const { Readable } = require('stream');

const OUT_DIR = 'service-out';
const CONNECT_TIMEOUT_MS = 15000;

function defaultRootDir(env) {
	return String(env.NODE_ENV || '').trim().toLowerCase() === 'prod' ? '/service' : '/service-test';
}

/** Konfiguracja FTP z `.env` (sekrety nie są tu nigdzie logowane). */
function readFtpConfig(env = process.env, cfg = require('../../config').service) {
	const rawDir = String((cfg && cfg.ftpDir) || '').trim();
	const rootDir = rawDir ? `/${rawDir.replace(/^\/+|\/+$/g, '')}` : defaultRootDir(env);
	const connection = { host: String(env.FTP_HOST || '').trim(), user: String(env.FTP_USER || '').trim(), password: String(env.FTP_PASSWORD || '') };
	return {
		rootDir,
		secure: String(env.SERVICE_FTP_TLS || '').toLowerCase() !== 'false',
		connection,
		// `SERVICE_FTP_ENABLED=false` = tylko lustro lokalne (np. praca bez sieci)
		enabled: String(env.SERVICE_FTP_ENABLED || 'true').toLowerCase() !== 'false' && !!(connection.host && connection.user && connection.password)
	};
}

function resolveDeps(deps = {}) {
	const d = { ...deps };
	if (!d.fsp) d.fsp = require('fs').promises;
	if (!d.outputData) d.outputData = require('../../config').outputData;
	if (!d.env) d.env = process.env;
	if (!d.ftpConfig) d.ftpConfig = readFtpConfig(d.env);
	if (!d.ftpClientFactory) {
		d.ftpClientFactory = () => {
			const ftp = require('basic-ftp');
			return new ftp.Client(CONNECT_TIMEOUT_MS);
		};
	}
	if (!d.log) d.log = require('../../utils/logging').log;
	return d;
}

/** Numer dopisku (1, 2, …) dla `event-<n>.json` — kolejność wiadomości klienta w zgłoszeniu. */
function messageOrdinal(pkg, eventId) {
	const list = (pkg.events || []).filter((e) => e.kind === 'client_message').map((e) => Number(e.id)).sort((a, b) => a - b);
	const idx = list.indexOf(Number(eventId));
	return idx >= 0 ? idx + 1 : list.length + 1;
}

/** Co wchodzi do tej paczki: całe zgłoszenie albo sam dopisek z jego plikami. */
function packageParts(pkg, eventId) {
	const files = (pkg.files || []).filter((f) => (eventId ? Number(f.event_id) === Number(eventId) : f.event_id === null || f.event_id === undefined));
	if (!eventId) return { jsonName: 'ticket.json', json: pkg, files };
	const n = messageOrdinal(pkg, eventId);
	return { jsonName: `event-${n}.json`, json: { number: pkg.number, id: pkg.id, type: pkg.type, event: n, ...pkg.message, created_by: pkg.created_by, commission: pkg.commission, order: pkg.order }, files };
}

async function uploadToFtp(d, number, parts, localDir) {
	const cfg = d.ftpConfig;
	const client = d.ftpClientFactory();
	const remoteDir = `${cfg.rootDir}/${number}`;
	try {
		await client.access({ ...cfg.connection, secure: cfg.secure });
		await client.ensureDir(remoteDir); // kończy W katalogu docelowym
		for (const f of parts.files) await client.uploadFrom(path.join(localDir, f.name), f.name);
		const tmp = `${parts.jsonName}.tmp`;
		await client.uploadFrom(Readable.from([Buffer.from(JSON.stringify(parts.json, null, 2), 'utf8')]), tmp);
		await client.rename(tmp, parts.jsonName);
	} finally {
		client.close();
	}
	return `${remoteDir}/${parts.jsonName}`;
}

/**
 * @param {object} pkg      paczka z serviceTickets.buildPackage
 * @param {object} opts     { filesDir: katalog zdjęć zgłoszenia, eventId: dopisek albo null }
 * @returns {Promise<string>} dokąd trafiło („ftp:/service-test/SRV-…/ticket.json” albo „local:…”)
 */
async function deliver(pkg, { filesDir, eventId = null } = {}, deps) {
	const d = resolveDeps(deps);
	if (!pkg || !pkg.number) throw new Error('brak paczki do eksportu');
	const parts = packageParts(pkg, eventId);
	const localDir = path.join(d.outputData, OUT_DIR, pkg.number);
	await d.fsp.mkdir(localDir, { recursive: true });
	for (const f of parts.files) {
		if (!filesDir) break;
		await d.fsp.copyFile(path.join(filesDir, f.name), path.join(localDir, f.name));
	}
	const tmp = path.join(localDir, `${parts.jsonName}.tmp`);
	await d.fsp.writeFile(tmp, JSON.stringify(parts.json, null, 2));
	await d.fsp.rename(tmp, path.join(localDir, parts.jsonName));

	if (!d.ftpConfig.enabled) {
		d.log(`[service] ${pkg.number}: FTP wyłączony/nieskonfigurowany — tylko lustro ${localDir}`);
		return `local:${path.join(localDir, parts.jsonName)}`;
	}
	const remote = await uploadToFtp(d, pkg.number, parts, localDir);
	d.log(`[service] ${pkg.number}: paczka na FTP ${remote} (${parts.files.length} plików)`);
	return `ftp:${remote}`;
}

module.exports = { deliver, readFtpConfig, defaultRootDir, packageParts, messageOrdinal, OUT_DIR };
