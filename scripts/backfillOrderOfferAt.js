#!/usr/bin/env node
'use strict';

/**
 * Uzupełnienie wstecz znacznika oferty `order.offer_at` (migrations/add_order_offer_at.sql).
 *
 * Jedyny dowód oferty, który został w bazie: import FTP (`import_log` success/partial → order_id)
 * na koncie z `user.autoimport = 0`, po którym zlecenie NIE poszło od razu na produkcję
 * (brak `sent_date` albo wysłane ≥ 10 min po utworzeniu — automat wysyła w ciągu sekund).
 * `offer_at` = `order.created_date` (chwila importu, ta sama strefa co created_date).
 * Od `--since` (domyślnie 2026-10-30 — wtedy weszło `autoimport`; wcześniej każdy import szedł
 * od razu, a niewysłany = nieudana wysyłka, nie oferta). PDF-y nie zostawiają śladu w bazie.
 *
 * Idempotentny: rusza tylko `offer_at IS NULL`.
 *
 *   node scripts/backfillOrderOfferAt.js --dry-run            podgląd (liczby + 20 pierwszych)
 *   node scripts/backfillOrderOfferAt.js                      zapis
 *   node scripts/backfillOrderOfferAt.js --since 2026-11-03   inna data włączenia autoimportu
 *
 * Baza: DATABASE_* z .env (jak cały E-Form).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool, closePool } = require('../db/core');

const DRY = process.argv.includes('--dry-run');
const sinceArg = process.argv[process.argv.indexOf('--since') + 1];
const SINCE = process.argv.includes('--since') ? sinceArg : '2026-10-30';

const CANDIDATES_SQL = `
    FROM \`order\` o
    JOIN user u ON u.id = o.user_id
    LEFT JOIN organization org ON org.id = u.organization_id
    JOIN (SELECT DISTINCT order_id FROM import_log
          WHERE status IN ('success', 'partial') AND order_id IS NOT NULL) l ON l.order_id = o.id
    WHERE o.offer_at IS NULL
      AND u.autoimport = 0
      AND o.created_date >= ?
      AND (o.sent_date IS NULL OR TIMESTAMPDIFF(MINUTE, o.created_date, o.sent_date) >= 10)`;

async function main() {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(SINCE))) throw new Error(`--since: oczekiwano RRRR-MM-DD, jest „${SINCE}”`);
	const [[col]] = await pool.query(
		"SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order' AND COLUMN_NAME = 'offer_at'");
	if (!col.n) throw new Error('brak kolumny order.offer_at — najpierw migrations/add_order_offer_at.sql');
	const [[db]] = await pool.query('SELECT DATABASE() AS name, @@hostname AS host');
	console.log(`baza ${db.name} @ ${db.host}, od ${SINCE}${DRY ? ' — PODGLĄD (--dry-run)' : ''}`);

	const [summary] = await pool.query(
		`SELECT org.ident AS org, o.status, COUNT(*) AS n ${CANDIDATES_SQL}
		 GROUP BY org.ident, o.status ORDER BY org.ident, o.status`, [SINCE]);
	console.table(summary);
	const [sample] = await pool.query(
		`SELECT o.id, u.ident, o.status, DATE_FORMAT(o.created_date, '%Y-%m-%d %H:%i') AS created, DATE_FORMAT(o.sent_date, '%Y-%m-%d %H:%i') AS sent
		 ${CANDIDATES_SQL} ORDER BY o.id LIMIT 20`, [SINCE]);
	console.table(sample);
	if (DRY) return;

	const [ids] = await pool.query(`SELECT o.id ${CANDIDATES_SQL}`, [SINCE]);
	if (!ids.length) return console.log('nic do uzupełnienia');
	const [res] = await pool.query('UPDATE `order` SET offer_at = created_date WHERE offer_at IS NULL AND id IN (?)', [ids.map((r) => r.id)]);
	console.log(`ustawiono offer_at: ${res.affectedRows}`);
}

main()
	.catch((err) => { console.error(`BŁĄD: ${err.message}`); process.exitCode = 1; })
	.finally(() => closePool());
