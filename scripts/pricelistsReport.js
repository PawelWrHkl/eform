#!/usr/bin/env node
/**
 * Raport rozjazdów cenników → `<ROOT_DIR>/pricelists/report.json`.
 * Uruchamiany w tle ze strony `/admin/pricelists` („Przelicz”) albo ręcznie:
 *
 *   node scripts/pricelistsReport.js
 *
 * Tylko odczyt: pliki grup, prod.txt, skoroszyty /mnt/eformconf (z kopii
 * tymczasowej), SELECT-y. Jeden przebieg naraz (plik blokady z PID-em).
 */
require('dotenv').config();

const fs = require('fs');
const report = require('../services/pricelists/report');
const { closePool } = require('../db/core');

(async () => {
  const running = report.runningInfo();
  // Blokadę z NASZYM PID-em zapisał już serwer, który nas uruchomił.
  if (running && running.pid !== process.pid) {
    console.log(`Raport już się liczy (PID ${running.pid}, od ${running.startedAt}).`);
    return;
  }
  fs.mkdirSync(report.REPORT_DIR, { recursive: true });
  fs.writeFileSync(report.LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const result = await report.buildReport({ progress: (msg) => console.log(new Date().toISOString(), msg) });
    report.writeReport(result);
    console.log(`Gotowe w ${result.durationSec} s → ${report.REPORT_FILE}`);
  } finally {
    fs.rmSync(report.LOCK_FILE, { force: true });
    await closePool().catch(() => {});
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
