#!/usr/bin/env node
'use strict';

/**
 * Zgłoszenia serwisowe z FTP (`/service`, paczki z produkcji eForm) → baza reklamacji HKL
 * (MySQL `reklamacje` na 192.168.0.196 + zdjęcia na udział `web/reklamacje/uploads/`).
 * Cron hosta wewnętrznego (produkcja eForm na VPS nie widzi LAN). Opis: services/serviceTickets/hklAdapter.js.
 *
 *   node scripts/serviceHklSync.js             import nowych paczek i dopisków (znaczniki na FTP)
 *   node scripts/serviceHklSync.js --dry-run   tylko pokaż, co by zostało zapisane
 *
 * Wymaga `SERVICE_HKL_SYNC_ENABLED=true` (poza --dry-run) i sekretów SERVICE_HKL_* w .env.local.
 * Kod wyjścia 1 = którakolwiek paczka nieudana (zostaje na FTP bez znacznika, wraca w następnym przebiegu).
 */

const path = require('path');
require('dotenv').config({ path: [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '..', '.env')] });

const { runHklSync, readConfig } = require('../services/serviceTickets/hklAdapter');
const { log } = require('../utils/logging');

(async () => {
	const dryRun = process.argv.includes('--dry-run');
	const cfg = readConfig();
	if (!dryRun && !cfg.enabled) {
		console.error(`${new Date().toISOString()} SERVICE_HKL_SYNC_ENABLED ≠ true — nic nie robię (użyj --dry-run do podglądu).`);
		process.exit(0);
	}
	const r = await runHklSync({ dryRun, deps: { cfg } });
	log(`[service:hkl] ${dryRun ? 'DRY-RUN ' : ''}przebieg: planowane ${r.planned.length}, zgłoszenia ${r.imported.length}, dopiski ${r.messages.length}, nieudane ${r.failed.length}${r.skipped.length ? `, konfiguracja: ${r.skipped.join('; ')}` : ''}`);
	process.exit(r.failed.length ? 1 : 0);
})().catch((err) => {
	console.error(`${new Date().toISOString()} serviceHklSync: ${err && err.stack || err}`);
	process.exit(1);
});
