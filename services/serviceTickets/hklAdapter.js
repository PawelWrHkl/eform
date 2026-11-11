/**
 * Docelowy adapter: paczki zgłoszeń z FTP → baza reklamacji HKL (decyzja Pawła 10.11.2026:
 * cron na hoście wewnętrznym, w repo eForm — produkcja eForm stoi na VPS bez dostępu do LAN).
 *
 * Baza reklamacji HKL = aplikacja PHP „Baza reklamacji” (192.168.0.196/reklamacje) z MySQL
 * `reklamacje`: tabela `orders` (jedno zgłoszenie) + `products` (pozycje), załączniki w katalogu
 * `web/reklamacje/uploads/<RANID>/` na udziale SMB. Zapis odbywa się dokładnie tak, jak robi to
 * formularz PHP (`db/insertDB.php`): INSERT do `orders`, potem `products` z ORDER_ID, pliki do
 * `uploads/<RANID>/` (RANID = UUID, jak w aplikacji).
 *
 * Przebieg (`runHklSync`, skrypt scripts/serviceHklSync.js z crona):
 *   1. lista katalogów `SRV-*` w `SERVICE_HKL_SYNC_FTP_DIR` (domyślnie `/service` — paczki produkcji),
 *   2. katalog z `ticket.json` bez znacznika `hkl-imported.json` → import zgłoszenia + znacznik
 *      `{ orders_id, ranid }` na FTP (idempotencja między przebiegami i hostami),
 *   3. `event-<n>.json` bez `hkl-imported-event-<n>.json` → dopisek doklejony do CLIENTINFO
 *      + jego pliki do tego samego `uploads/<RANID>/` + znacznik.
 * `--dry-run` tylko czyta FTP i pokazuje zmapowane wiersze; bez zapisu do MySQL, SMB i FTP.
 *
 * Mapowanie kolekcji eForm → ASORTMENTGROUP HKL: PLISY→Plisy, ROLETY→Rollo, VERTIKAL→Vertikale,
 * RZYMSKIE→Raffrollo („ff” z listy szefa = Raffrollo, Paweł 10.11), ŻALUZJE po grupie
 * (39→„Żaluzje 16/25”, 59→„Żaluzje drewniane”, reszta→„Żaluzje 35/50/70”); pozostałe działy
 * (KOMPONENTY, RAMKA MAGNETYCZNA, ZASŁONY, MOSKITIERY, PANELE) nie mają odpowiednika → puste.
 *
 * Sekrety w `.env.local`: SERVICE_HKL_DB_* (MySQL reklamacje), SERVICE_HKL_SMB_* (udział `web`).
 * Statusy z HKL nadal nie wracają — to osobny krok (odczyt `orders.STATE`/`DECISION` po RANID).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { execFile } = require('child_process');

const TYPE_PL = { repair: 'Naprawa', complaint: 'Reklamacja techniczna', transport: 'Uszkodzenie w transporcie', delivery: 'Zapytanie o dostawę' };
const LANG = { pl: 'PL', en: 'EN', de: 'DE', fr: 'FR', nl: 'NE' };
const ASORTMENT_BY_DEPARTMENT = { PLISY: 'Plisy', ROLETY: 'Rollo', VERTIKAL: 'Vertikale', RZYMSKIE: 'Raffrollo' };
const ASORTMENT_BY_GROUP = { 39: 'Żaluzje 16/25', 59: 'Żaluzje drewniane' };
const MARKER = 'hkl-imported.json';
const DEFAULT_MAX_PER_RUN = 20;
const TEXT_LIMITS = { CLIENTINFO: 1500, CLIENTINFOTRANSLATED: 1500, COMMISSION: 100, COMMISSION_INTERNAL: 100, DEALER: 200, CUSTOMER: 100, PRODUCT_SUBCOMMISSION: 255, PRODUCT_NAME: 255, PRODUCT_CODE: 200, PRODUCT_MODEL: 200, PRODUCT_COLOR: 200, PRODUCT_SIZE: 200, PRODUCT_COMMENT: 200 };

function cut(v, n) { return String(v ?? '').slice(0, n); }

function readConfig(env = process.env) {
	const problems = [];
	const rawDir = String(env.SERVICE_HKL_SYNC_FTP_DIR || '/service').trim();
	const ftpDir = `/${rawDir.replace(/^\/+|\/+$/g, '')}`;
	const cfg = {
		enabled: String(env.SERVICE_HKL_SYNC_ENABLED || '').toLowerCase() === 'true',
		ftpDir,
		ftp: { host: String(env.FTP_HOST || '').trim(), user: String(env.FTP_USER || '').trim(), password: String(env.FTP_PASSWORD || ''), secure: String(env.SERVICE_FTP_TLS || '').toLowerCase() !== 'false' },
		db: { host: env.SERVICE_HKL_DB_HOST || '192.168.0.196', port: Number(env.SERVICE_HKL_DB_PORT) || 3306, user: env.SERVICE_HKL_DB_USER || '', password: env.SERVICE_HKL_DB_PASSWORD || '', database: env.SERVICE_HKL_DB_DATABASE || 'reklamacje' },
		smb: { share: env.SERVICE_HKL_SMB_SHARE || '//192.168.0.196/web', dir: String(env.SERVICE_HKL_SMB_DIR || 'reklamacje/uploads').replace(/^\/+|\/+$/g, ''), user: env.SERVICE_HKL_SMB_USER || '', password: env.SERVICE_HKL_SMB_PASSWORD || '' },
		operator: env.SERVICE_HKL_OPERATOR || 'eForm',
		producer: env.SERVICE_HKL_PRODUCER || 'HKL',
		maxPerRun: Number(env.SERVICE_HKL_MAX_PER_RUN) > 0 ? Number(env.SERVICE_HKL_MAX_PER_RUN) : DEFAULT_MAX_PER_RUN,
		problems
	};
	if (!cfg.ftp.host || !cfg.ftp.user || !cfg.ftp.password) problems.push('brak FTP_HOST / FTP_USER / FTP_PASSWORD');
	if (!cfg.db.user || !cfg.db.password) problems.push('brak SERVICE_HKL_DB_USER / SERVICE_HKL_DB_PASSWORD (.env.local)');
	if (!cfg.smb.user || !cfg.smb.password) problems.push('brak SERVICE_HKL_SMB_USER / SERVICE_HKL_SMB_PASSWORD (.env.local) — zdjęcia nie trafią do uploads/');
	return cfg;
}

/** ASORTMENTGROUP HKL z pozycji zgłoszenia (pierwsza pozycja) albo z kolekcji wybranej ręcznie. */
function asortmentGroup(pkg) {
	const first = (pkg.items || [])[0];
	const dept = String(((first && first.department) || pkg.department || {}).pl || '').toUpperCase();
	if (!dept) return '';
	if (dept === 'ŻALUZJE') return ASORTMENT_BY_GROUP[Number(first && first.group_number)] || 'Żaluzje 35/50/70';
	return ASORTMENT_BY_DEPARTMENT[dept] || '';
}

function sizeCm(ps) {
	const w = Number(ps && ps.SZEROKOSC);
	const h = Number(ps && ps.WYSOKOSC);
	if (!w && !h) return '';
	const cm = (mm) => (mm ? (mm / 10).toFixed(1) : '?');
	return `${cm(w)} x ${cm(h)}`;
}

function day(v) { return v ? String(v).slice(0, 10) : null; }

/**
 * Zgłoszenie z `ticket.json` → wiersze `orders` i `products` (dokładnie kolumny, które zapisuje formularz PHP).
 * @param {object} pkg          ticket.json
 * @param {object} o            { now: Date, t: (key) => etykieta PL, operator, producer, ranid }
 */
function mapTicket(pkg, { now, t, operator, producer, ranid }) {
	const items = pkg.items || [];
	const label = (code) => (code ? t(`service.category.${code}`) : '');
	const head = [`[eForm ${pkg.number}] ${TYPE_PL[pkg.type] || pkg.type}${pkg.category ? ` — ${label(pkg.category)}` : ''}`];
	head.push(`Kontakt: ${[pkg.contact && pkg.contact.name, pkg.contact && pkg.contact.phone, pkg.contact && pkg.contact.email].filter(Boolean).join(', ')}`);
	if (pkg.product_address) head.push(`Adres produktu: ${pkg.product_address}`);
	if (pkg.order) head.push(`Zlecenie eForm ${pkg.order.order_idx} (plik ${pkg.order.production_file || '—'}, wysłane ${pkg.order.sent_date || '—'}${pkg.order.age_days !== null && pkg.order.age_days !== undefined ? `, ${pkg.order.age_days} dni temu` : ''})`);
	else if (pkg.order_no_text) head.push(`Numer zamówienia podany ręcznie: ${pkg.order_no_text}`);
	if (pkg.transport) head.push(`Transport: dostawa ${pkg.transport.delivered_at || '—'}, u kuriera/w protokole: ${pkg.transport.carrier_noted === true ? 'tak' : pkg.transport.carrier_noted === false ? 'nie' : '—'}`);
	if (pkg.repair) head.push(`Naprawa: wycena przed naprawą poza gwarancją — ${pkg.repair.quote_before_repair ? 'tak' : 'nie'}`);
	if (items.length) head.push(`Pozycje: ${items.map((it) => `${it.pos || '?'} ×${it.qty} ${label(it.category)}${it.note ? ` (${it.note})` : ''}`).join('; ')}`);
	const clientinfo = `${head.join('\n')}\n\n${pkg.description || ''}`.trim();
	const first = items[0];
	const orders = {
		COMMISSION: cut(pkg.commission, TEXT_LIMITS.COMMISSION),
		COMMISSION_INTERNAL: cut(pkg.order && pkg.order.production_file, TEXT_LIMITS.COMMISSION_INTERNAL),
		COMMISSION_GROUP: cut(first && first.group, 255),
		COMMISSION_GROUP_ALLPOS: '',
		PRODUCER: producer,
		COUNTRY: '',
		DEALER: cut((pkg.client && (pkg.client.ident || pkg.client.name)) || '', TEXT_LIMITS.DEALER),
		CUSTOMER: cut(pkg.end_client || (pkg.client && pkg.client.name) || '', TEXT_LIMITS.CUSTOMER),
		ASORTMENTGROUP: asortmentGroup(pkg),
		ASORTMENT: cut(first && first.group, 100),
		COUNT: String(items.reduce((s, it) => s + (Number(it.qty) || 0), 0) || 1),
		CLIENTINFO: cut(clientinfo, TEXT_LIMITS.CLIENTINFO),
		CLIENTINFOTRANSLATED: cut(pkg.description_pl || '', TEXT_LIMITS.CLIENTINFOTRANSLATED),
		STATE: 'Nowa',
		DATE_ADDED: now,
		DATE_LAST_MODIFIED: now,
		SENT_DATE: day(pkg.order && pkg.order.sent_date),
		COMPLAINTDESCRIPTION: null,
		DECISION: null,
		OPERATOR: operator,
		WHO_MAKE_DECISION: '',
		DATE_RECLAMATION: day(pkg.created_at) || day(now.toISOString()),
		CLIENT_LANGUAGE: LANG[String(pkg.client && pkg.client.lang || '').toLowerCase()] || '',
		RANID: ranid
	};
	const products = items.map((it) => {
		const ps = it.parameters_short || {};
		return {
			PRODUCT_SUBCOMMISSION: cut(`${pkg.commission} / ${it.pos || '?'}`, TEXT_LIMITS.PRODUCT_SUBCOMMISSION),
			PRODUCT_NAME: cut(it.group || '', TEXT_LIMITS.PRODUCT_NAME),
			PRODUCT_CODE: cut(it.group_number || '', TEXT_LIMITS.PRODUCT_CODE),
			PRODUCT_MODEL: cut(ps.MODEL || '', TEXT_LIMITS.PRODUCT_MODEL),
			PRODUCT_COLOR: cut(ps.KOLOR || '', TEXT_LIMITS.PRODUCT_COLOR),
			PRODUCT_EL: '-',
			PRODUCT_SIZE: cut(sizeCm(ps), TEXT_LIMITS.PRODUCT_SIZE),
			PRODUCT_RESPONSIBILITY: null,
			PRODUCT_DECISION: null,
			PRODUCT_COMMENT: cut(`${label(it.category)}${it.note ? `: ${it.note}` : ''}${Number(it.qty) > 1 ? ` (×${it.qty})` : ''}`, TEXT_LIMITS.PRODUCT_COMMENT)
		};
	});
	return { orders, products };
}

/** Dopisek klienta (`event-<n>.json`) → tekst doklejany do CLIENTINFO. */
function mapMessage(evt) {
	return `\n\n[${String(evt.at || '').slice(0, 16).replace('T', ' ')}] Dopisek klienta (eForm, nr ${evt.event}): ${evt.text || '—'}${evt.files && evt.files.length ? ` [pliki: ${evt.files.join(', ')}]` : ''}`;
}

// ── zapis ─────────────────────────────────────────────────────────────────

/** Pliki do `uploads/<ranid>/` przez smbclient (hasło przez środowisko, nie w argumentach). */
function smbPut(cfg, ranid, files, deps) {
	if (!files.length) return Promise.resolve();
	const exec = deps.execFile || execFile;
	const cmds = [`cd ${cfg.smb.dir}`, `mkdir ${ranid}`, `cd ${ranid}`, ...files.map((f) => `put "${f.localPath}" "${f.name}"`)];
	return new Promise((resolve, reject) => {
		exec('smbclient', [cfg.smb.share, '-U', cfg.smb.user, '-c', cmds.join('; ')], { env: { ...process.env, PASSWD: cfg.smb.password }, timeout: 120000 }, (err, stdout, stderr) => {
			const out = `${stdout || ''}${stderr || ''}`;
			// smbclient kończy kodem ≠ 0 po KAŻDYM nieudanym poleceniu, ale wykonuje kolejne; istniejący
			// katalog (ponowienie po częściowej awarii) to NT_STATUS_OBJECT_NAME_COLLISION — nie błąd.
			const statuses = (out.match(/NT_STATUS_\w+/g) || []).filter((st) => st !== 'NT_STATUS_OBJECT_NAME_COLLISION');
			if (statuses.length || (err && !/NT_STATUS_OBJECT_NAME_COLLISION/.test(out))) return reject(new Error(`smbclient: ${statuses.join(', ') || (err && err.message) || out.trim().slice(0, 300)}`));
			resolve(out);
		});
	});
}

async function importTicket(pkg, localFiles, { conn, cfg, t, now, deps }) {
	const ranid = crypto.randomUUID();
	const { orders, products } = mapTicket(pkg, { now, t, operator: cfg.operator, producer: cfg.producer, ranid });
	await conn.beginTransaction();
	let ordersId;
	try {
		const [r] = await conn.query('INSERT INTO `orders` SET ?', [orders]);
		ordersId = r.insertId;
		for (const p of products) await conn.query('INSERT INTO `products` SET ?', [{ ...p, ORDER_ID: ordersId }]);
		await conn.commit();
	} catch (err) {
		try { await conn.rollback(); } catch { /* j.w. */ }
		throw err;
	}
	await smbPut(cfg, ranid, localFiles, deps);
	return { orders_id: ordersId, ranid, imported_at: now.toISOString(), source: 'eForm', number: pkg.number };
}

async function importMessage(evt, marker, localFiles, { conn, cfg, now, deps }) {
	await conn.query('UPDATE `orders` SET CLIENTINFO = LEFT(CONCAT(CLIENTINFO, ?), ?), DATE_LAST_MODIFIED = ? WHERE ID = ?', [mapMessage(evt), TEXT_LIMITS.CLIENTINFO, now, marker.orders_id]);
	await smbPut(cfg, marker.ranid, localFiles, deps);
	return { orders_id: marker.orders_id, ranid: marker.ranid, event: evt.event, imported_at: now.toISOString() };
}

// ── FTP ───────────────────────────────────────────────────────────────────

async function readJson(client, remote, tmpDir) {
	const local = path.join(tmpDir, path.basename(remote));
	await client.downloadTo(local, remote);
	return JSON.parse(fs.readFileSync(local, 'utf8'));
}

async function fetchFiles(client, dir, names, tmpDir) {
	const out = [];
	for (const name of names) {
		const safe = path.basename(String(name));
		const localPath = path.join(tmpDir, safe);
		await client.downloadTo(localPath, `${dir}/${safe}`);
		out.push({ name: safe, localPath });
	}
	return out;
}

async function putJson(client, remote, data) {
	await client.uploadFrom(Readable.from([Buffer.from(JSON.stringify(data, null, 2), 'utf8')]), remote);
}

/**
 * @param {object} opts { dryRun, deps: { env, ftpClientFactory, createDb, t, now, log, execFile } }
 */
async function runHklSync({ dryRun = false, deps = {} } = {}) {
	const log = deps.log || require('../../utils/logging').log;
	const cfg = deps.cfg || readConfig(deps.env || process.env);
	const now = deps.now ? deps.now() : new Date();
	const t = deps.t || require('./mailer').makeT('pl');
	const result = { planned: [], imported: [], messages: [], failed: [], skipped: cfg.problems.slice() };
	if (cfg.problems.length && !dryRun) {
		log(`[service:hkl] konfiguracja niepełna: ${cfg.problems.join('; ')}`);
		if (!cfg.db.user || !cfg.ftp.host) return result;
	}
	const ftp = (deps.ftpClientFactory || (() => { const f = require('basic-ftp'); return new f.Client(20000); }))();
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'service-hkl-'));
	let conn = null;
	try {
		await ftp.access({ host: cfg.ftp.host, user: cfg.ftp.user, password: cfg.ftp.password, secure: cfg.ftp.secure });
		const dirs = (await ftp.list(cfg.ftpDir)).filter((e) => e.isDirectory && /^SRV-\d{4}-\d{5}$/.test(e.name)).map((e) => e.name).sort();
		let done = 0;
		for (const number of dirs) {
			if (done >= cfg.maxPerRun) break;
			const dir = `${cfg.ftpDir}/${number}`;
			const names = new Set((await ftp.list(dir)).map((e) => e.name));
			const needTicket = names.has('ticket.json') && !names.has(MARKER);
			const events = [...names].map((n) => /^event-(\d+)\.json$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).filter((n) => !names.has(`hkl-imported-event-${n}.json`)).sort((a, b) => a - b);
			if (!needTicket && !events.length) continue;
			result.planned.push(number);
			const tmpDir = path.join(tmpRoot, number);
			fs.mkdirSync(tmpDir, { recursive: true });
			try {
				if (!conn && !dryRun) conn = await (deps.createDb || ((c) => require('mysql2/promise').createConnection({ ...c, connectTimeout: 10000 })))(cfg.db);
				let marker = names.has(MARKER) ? await readJson(ftp, `${dir}/${MARKER}`, tmpDir) : null;
				if (needTicket) {
					const pkg = await readJson(ftp, `${dir}/ticket.json`, tmpDir);
					const fileNames = (pkg.files || []).filter((f) => f.event_id === null || f.event_id === undefined).map((f) => f.name);
					if (dryRun) {
						const mapped = mapTicket(pkg, { now, t, operator: cfg.operator, producer: cfg.producer, ranid: '<uuid>' });
						log(`[service:hkl] DRY-RUN ${number}: orders ${JSON.stringify({ ...mapped.orders, CLIENTINFO: mapped.orders.CLIENTINFO.slice(0, 160) + '…' })}; products ${mapped.products.length}; pliki ${fileNames.length}`);
						result.imported.push(number);
					} else {
						const files = await fetchFiles(ftp, dir, fileNames, tmpDir);
						marker = await importTicket(pkg, files, { conn, cfg, t, now, deps });
						await putJson(ftp, `${dir}/${MARKER}`, marker);
						result.imported.push(number);
						log(`[service:hkl] ${number} → orders.ID ${marker.orders_id}, RANID ${marker.ranid}, pozycji ${pkg.items ? pkg.items.length : 0}, plików ${files.length}`);
					}
				}
				for (const n of events) {
					const evt = await readJson(ftp, `${dir}/event-${n}.json`, tmpDir);
					if (dryRun) {
						log(`[service:hkl] DRY-RUN ${number} dopisek ${n}: ${mapMessage(evt).trim().slice(0, 200)}`);
						result.messages.push(`${number}#${n}`);
						continue;
					}
					if (!marker) { log(`[service:hkl] ${number} dopisek ${n}: brak znacznika importu zgłoszenia — czekam`); continue; }
					const files = await fetchFiles(ftp, dir, evt.files || [], tmpDir);
					const m = await importMessage(evt, marker, files, { conn, cfg, now, deps });
					await putJson(ftp, `${dir}/hkl-imported-event-${n}.json`, m);
					result.messages.push(`${number}#${n}`);
					log(`[service:hkl] ${number} dopisek ${n} → orders.ID ${marker.orders_id}, plików ${files.length}`);
				}
				done++;
			} catch (err) {
				result.failed.push({ number, error: err && err.message ? err.message : String(err) });
				log(`[service:hkl] ${number}: NIEUDANY import — ${err && err.message ? err.message : err}`);
			}
		}
	} finally {
		ftp.close();
		if (conn) await conn.end().catch(() => {});
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
	return result;
}

module.exports = { readConfig, asortmentGroup, mapTicket, mapMessage, importTicket, importMessage, smbPut, runHklSync, MARKER, TYPE_PL, LANG };
