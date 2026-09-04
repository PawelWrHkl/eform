#!/usr/bin/env node
/**
 * Standalone configurator-tester daemon — one long-lived Node process,
 * separate from server.js, modeled on scripts/orderImportDaemon.js.
 *
 * Runs the full suite once per night at CONFIGTEST_NIGHTLY_HOUR (default 2),
 * checking every CONFIGTEST_INTERVAL_SEC (default 300s) whether it's time.
 *
 * Usage:
 *   npm run configtest:daemon
 *
 * New .env vars (see /home/pawel/.claude/plans/splendid-forging-mango.md):
 *   CONFIGTEST_NOTIFY_EMAIL     - recipient of error-report emails
 *   CONFIGTEST_INTERVAL_SEC     - how often to check the clock (default 300)
 *   CONFIGTEST_NIGHTLY_HOUR     - local hour (0-23) to run the full suite (default 2)
 *   CONFIGTEST_RANDOM_CASES     - random/kombinacji cases per group per run (default 5)
 *   CONFIGTEST_OUTPUT_DIR       - override report output dir (default <ROOT_DIR>/configtest-output)
 *
 * Logs: configtest/configtest.log
 * PID:  configtest/configtest.pid
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runFullSuite } = require('../services/configuratorTester');
const { log } = require('../services/configuratorTester/logger');

const ROOT = path.join(__dirname, '..');
const PIDFILE = path.join(ROOT, 'configtest/configtest.pid');
const INTERVAL_MS = (parseInt(process.env.CONFIGTEST_INTERVAL_SEC, 10) || 300) * 1000;
const NIGHTLY_HOUR = Number.isInteger(parseInt(process.env.CONFIGTEST_NIGHTLY_HOUR, 10))
  ? parseInt(process.env.CONFIGTEST_NIGHTLY_HOUR, 10)
  : 2;
const RANDOM_CASES = parseInt(process.env.CONFIGTEST_RANDOM_CASES, 10) || 5;

let timer = null;
let cycleRunning = false;
let lastRunDay = null;

function writePidFile() {
  fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
  fs.writeFileSync(PIDFILE, String(process.pid));
}

function removePidFile() {
  try { fs.unlinkSync(PIDFILE); } catch (_err) { /* ignore */ }
}

function shutdown(signal) {
  log(`ConfiguratorTester daemon stopping (${signal})`);
  if (timer) clearInterval(timer);
  removePidFile();
  process.exit(0);
}

async function maybeRunNightly() {
  if (cycleRunning) return;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() !== NIGHTLY_HOUR || lastRunDay === today) return;

  cycleRunning = true;
  lastRunDay = today;
  try {
    log('ConfiguratorTester daemon: nightly cycle start');
    const { report, reportFilePath } = await runFullSuite({ randomCasesCount: RANDOM_CASES });
    log(`ConfiguratorTester daemon: cycle done — ${report.totalFindings} błędów (P1: ${report.byPriority.P1 || 0}), raport: ${reportFilePath}`);
  } catch (err) {
    log(`ConfiguratorTester daemon: cycle error: ${err.message}`);
  } finally {
    cycleRunning = false;
  }
}

function startDaemon() {
  if (timer) return;

  writePidFile();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log(`ConfiguratorTester daemon started pid=${process.pid} node=${process.version} nightlyHour=${NIGHTLY_HOUR} checkInterval=${INTERVAL_MS / 1000}s`);
  maybeRunNightly();
  timer = setInterval(maybeRunNightly, INTERVAL_MS);
}

module.exports = { startDaemon };

if (require.main === module) {
  startDaemon();
}
