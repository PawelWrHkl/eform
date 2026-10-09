#!/usr/bin/env node
/**
 * Standalone order-import daemon — one long-lived Node process, separate from server.js.
 *
 * Usage:
 *   npm run import:daemon
 *   import/import_efor.sh          (cron @reboot)
 *
 * Logs: import/import.log
 * PID:  import/import.pid
 */

process.env.ORDER_IMPORT_STANDALONE = '1';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runImport } = require('../services/orderImport');
const { log } = require('../utils/logging');

const ROOT = path.join(__dirname, '..');
const PIDFILE = path.join(ROOT, 'import/import.pid');
const INTERVAL_MS = (parseInt(process.env.ORDER_IMPORT_INTERVAL_SEC, 10) || 30) * 1000;

let timer = null;
let cycleRunning = false;

function writePidFile() {
  fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
  fs.writeFileSync(PIDFILE, String(process.pid));
}

function removePidFile() {
  try {
    fs.unlinkSync(PIDFILE);
  } catch (_err) {
    // ignore
  }
}

function shutdown(signal) {
  log(`OrderImport daemon stopping (${signal})`);
  if (timer) clearInterval(timer);
  removePidFile();
  process.exit(0);
}

function runPreflightScript() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/orderImportPreflight.js')], {
      cwd: ROOT,
      env: { ...process.env, ORDER_IMPORT_STANDALONE: '1' },
      stdio: 'inherit'
    });
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => {
      log(`OrderImport daemon: preflight spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    log(`OrderImport daemon: cycle start`);
    await runPreflightScript();

    const results = await runImport();
    if (results.length === 0) {
      log('OrderImport: nothing to do.');
      return;
    }

    let failed = 0;
    for (const r of results) {
      if (r.ok) {
        log(`OK    ${r.file}  ->  order id=${r.orderId} nr=${r.orderIdx ?? '?'}`);
      } else {
        failed++;
        log(`FAIL  ${r.file}  ->  ${r.error}`);
      }
    }
    log(`OrderImport: ${results.length - failed}/${results.length} imported.`);
  } catch (err) {
    log(`OrderImport daemon: cycle error: ${err.message}`);
  } finally {
    cycleRunning = false;
  }
}

function startImportDaemon() {
  if (timer) return;

  writePidFile();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log(`OrderImport daemon started pid=${process.pid} node=${process.version} interval=${INTERVAL_MS / 1000}s`);
  runCycle();
  timer = setInterval(runCycle, INTERVAL_MS);
}

module.exports = { startImportDaemon, runCycle };

if (require.main === module) {
  startImportDaemon();
}
