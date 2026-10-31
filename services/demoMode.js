/**
 * Tryb demo — konto klienta na czas jednej sesji (formularz na stronie logowania).
 *
 * Konto demo to prawdziwy wiersz `user` (rola `demo`, pin `DEMO<8 hex>`, ident
 * `DEMO_<8 hex>`) w organizacji `DEMO_ORGANIZATION` — cały portal (zlecenia,
 * pozycje, numeracja, PDF) chodzi po `user_id`, więc nic nie trzeba udawać.
 * Znika razem ze zleceniami, pozycjami, adresami i załącznikami:
 *  • przy wylogowaniu (routes/users.js),
 *  • po 8 h od założenia, nawet przy aktywnej sesji (middleware/demoSession.js),
 *  • w „zamiatarce" co 10 min — sesje porzucone i utracone przy restarcie.
 * Wysyłka i anulowanie zleceń demo zmieniają tylko status w bazie — bez FTP,
 * maili i produkcji (routes/orders.js, services/orderCancellation.js); bramka
 * patrzy na WŁAŚCICIELA zlecenia, więc obejmuje też admina w jego kontekście.
 */
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');

const DEMO_SESSION_MS = 8 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
// Kraje klientów tej instalacji (`user.country`) — od kraju zależy stawka VAT.
const DEMO_COUNTRIES = ['DE', 'AT', 'CH', 'NL', 'BE', 'FR', 'PL', 'CZ', 'SK', 'DK', 'SE', 'NO', 'IT', 'LT'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Kolejność ma znaczenie: `order` trzyma klucze obce do adresów, a `employee`
// (NO ACTION) i `send_address` (RESTRICT) blokują usunięcie `user`.
const PURGE_STATEMENTS = [
	'DELETE oi FROM order_item oi JOIN `order` o ON o.id = oi.order_id WHERE o.user_id IN (?)',
	'DELETE FROM `order` WHERE user_id IN (?)',
	'DELETE FROM send_address WHERE user_id IN (?)',
	'DELETE FROM order_address WHERE user_id IN (?)',
	'DELETE FROM delivery_address WHERE user_id IN (?)',
	'DELETE FROM contact_info WHERE user_id IN (?)',
	'DELETE FROM employee WHERE user_id IN (?)',
	'DELETE FROM `user` WHERE id IN (?)'
];

function isDemoIdent(ident) {
	return /^DEMO_[0-9A-F]{8}$/i.test(String(ident || ''));
}

function isDemoPin(pin) {
	return /^DEMO[0-9A-F]{8}$/i.test(String(pin || ''));
}

function resolveDeps(deps = {}) {
	return {
		getConnection: deps.getConnection || (() => require('../db/core').connetToDb()),
		unlink: deps.unlink || ((file) => require('fs').promises.unlink(file)),
		outputData: deps.outputData || require('../config').outputData,
		env: deps.env || process.env,
		log: deps.log || require('../utils/logging').log
	};
}

async function withConnection(d, fn) {
	const conn = await d.getConnection();
	try {
		return await fn(conn);
	} finally {
		conn.end();
	}
}

function validateDemoForm(body = {}) {
	const values = {
		company: String(body.company || '').trim().slice(0, 128),
		email: String(body.email || '').trim().slice(0, 128),
		country: String(body.country || '').trim().toUpperCase()
	};
	const errors = [];
	if (!values.company) errors.push('demo.error_company');
	if (!EMAIL_RE.test(values.email)) errors.push('demo.error_email');
	if (!DEMO_COUNTRIES.includes(values.country)) errors.push('demo.error_country');
	return { values, errors };
}

/** Lista krajów do selecta, z nazwami w języku strony (bez kluczy tłumaczeń). */
function countryOptions(locale) {
	const names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
	return DEMO_COUNTRIES
		.map((code) => ({ code, name: names.of(code) }))
		.sort((a, b) => a.name.localeCompare(b.name, locale));
}

// Formularz jest publiczny: limit nowych kont z jednego IP na godzinę.
const recentByIp = new Map();

function takeIpSlot(ip, { now = Date.now(), env = process.env } = {}) {
	const limit = parseInt(env.DEMO_MAX_PER_IP_HOUR, 10) || 5;
	const hits = (recentByIp.get(ip) || []).filter((t) => t > now - 3600 * 1000);
	const allowed = hits.length < limit;
	if (allowed) hits.push(now);
	recentByIp.set(ip, hits);
	return allowed;
}

/**
 * Zakłada konto demo. `null` = osiągnięty limit aktywnych kont (`DEMO_MAX_ACTIVE`).
 * @returns {Promise<{pin: string, password: string, ident: string}|null>}
 */
async function createDemoAccount({ company, email, country }, deps) {
	const d = resolveDeps(deps);
	const orgIdent = d.env.DEMO_ORGANIZATION;
	const maxActive = parseInt(d.env.DEMO_MAX_ACTIVE, 10) || 30;
	return withConnection(d, async (conn) => {
		const [[org]] = await conn.query('SELECT id FROM organization WHERE ident = ?', [orgIdent]);
		if (!org) throw new Error(`[demo] DEMO_ORGANIZATION "${orgIdent}" nie istnieje w tabeli organization`);
		const [[{ active }]] = await conn.query("SELECT COUNT(*) AS active FROM `user` WHERE role = 'demo'");
		if (active >= maxActive) return null;

		const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
		const account = { pin: `DEMO${hex}`, ident: `DEMO_${hex}`, password: crypto.randomBytes(16).toString('hex') };
		// `first_login_at` = chwila założenia — od niej liczy zamiatarka.
		await conn.query(
			`INSERT INTO \`user\` (pin, password, client_name, email, country, ident, organization_id, role, first_login_at, intro_needed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'demo', NOW(), 1)`,
			[account.pin, bcrypt.hashSync(account.password, 10), company, email, country, account.ident, org.id]
		);
		return account;
	});
}

function attachmentNames(raw) {
	try {
		const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return Array.isArray(list) ? list.map((a) => a?.savedName).filter(Boolean) : [];
	} catch {
		return [];
	}
}

/**
 * Usuwa konta demo razem z ich danymi. Rusza WYŁĄCZNIE wiersze z rolą `demo`
 * i pinem `DEMO…` — przekazane id prawdziwego klienta jest ignorowane.
 * @returns {Promise<number>} liczba usuniętych kont
 */
async function purgeDemoUsers(userIds, deps) {
	const d = resolveDeps(deps);
	const requested = (userIds || []).filter((id) => Number.isInteger(id));
	if (!requested.length) return 0;

	const { ids, files } = await withConnection(d, async (conn) => {
		await conn.beginTransaction();
		try {
			const [users] = await conn.query(
				"SELECT id FROM `user` WHERE id IN (?) AND role = 'demo' AND pin LIKE 'DEMO%'",
				[requested]
			);
			const demoIds = users.map((u) => u.id);
			if (!demoIds.length) {
				await conn.rollback();
				return { ids: [], files: [] };
			}
			const [items] = await conn.query(
				'SELECT oi.attachments FROM order_item oi JOIN `order` o ON o.id = oi.order_id WHERE o.user_id IN (?)',
				[demoIds]
			);
			// „Inny adres wysyłki" (db/orders.js insertSendAddress) nie ma user_id —
			// wisi tylko na zleceniu, więc zbieramy go przed usunięciem zleceń.
			const [sendAddresses] = await conn.query(
				'SELECT DISTINCT send_address_id AS id FROM `order` WHERE user_id IN (?) AND send_address_id IS NOT NULL',
				[demoIds]
			);
			for (const sql of PURGE_STATEMENTS) await conn.query(sql, [demoIds]);
			if (sendAddresses.length) {
				await conn.query('DELETE FROM send_address WHERE id IN (?)', [sendAddresses.map((a) => a.id)]);
			}
			await conn.commit();
			return { ids: demoIds, files: items.flatMap((i) => attachmentNames(i.attachments)) };
		} catch (err) {
			await conn.rollback();
			throw err;
		}
	});

	// Załączniki leżą w outputData pod nazwą `<posId>_<pole>_<plik>`.
	await Promise.all(files.map((name) =>
		d.unlink(path.join(d.outputData, path.basename(name))).catch(() => {})
	));
	if (ids.length) d.log(`[demo] usunięto konta demo: ${ids.join(', ')} (załączników: ${files.length})`);
	return ids.length;
}

async function purgeExpiredDemoUsers(deps) {
	const d = resolveDeps(deps);
	const [rows] = await withConnection(d, (conn) => conn.query(
		"SELECT id FROM `user` WHERE role = 'demo' AND pin LIKE 'DEMO%' AND first_login_at < NOW() - INTERVAL ? MINUTE",
		[DEMO_SESSION_MS / 60000 + 10]
	));
	return rows.length ? purgeDemoUsers(rows.map((r) => r.id), deps) : 0;
}

function startDemoSweeper() {
	const { log } = resolveDeps();
	const sweep = () => {
		const hourAgo = Date.now() - 3600 * 1000;
		for (const [ip, hits] of recentByIp) if (!hits.some((t) => t > hourAgo)) recentByIp.delete(ip);
		purgeExpiredDemoUsers().catch((err) => log('[demo] zamiatarka nie zadziałała:', err.message));
	};
	sweep();
	setInterval(sweep, SWEEP_EVERY_MS).unref();
}

module.exports = {
	DEMO_SESSION_MS,
	DEMO_COUNTRIES,
	isDemoIdent,
	isDemoPin,
	validateDemoForm,
	countryOptions,
	takeIpSlot,
	createDemoAccount,
	purgeDemoUsers,
	purgeExpiredDemoUsers,
	startDemoSweeper
};
