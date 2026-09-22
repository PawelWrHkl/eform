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
 *   CONFIGTEST_NIGHTLY_ALL_POSITIONS - 'true' to recheck every saved position
 *                                 each night instead of only the new ones
 *   CONFIGTEST_RANGE_CASES_PER_GROUP - self-generated configurations per price
 *                                 table (default 400)
 *   CONFIGTEST_RANGE_BASES_PER_GROUP - how many different base configurations
 *                                 to sweep from (default 3)
 *   CONFIGTEST_APP_URL          - eForm instance for the browser pass; the pass
 *                                 runs only when this is set (see below)
 *   CONFIGTEST_NIGHTLY_BROWSER  - 'false' to skip the browser pass even then
 *   CONFIGTEST_SIM_PIN / _PASSWORD / _ORDER_ID - konto i zamówienie dla symulacji
 *                                 tworzenia pozycji; komplet włącza ją automatycznie
 *   CONFIGTEST_NIGHTLY_SIMULATION - 'false' to skip the position-creation simulation
 *   CONFIGTEST_SCRIPT_SYNTAX    - 'false' to skip parsing the deployed price scripts
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
    // `onlyNew`: recheck the positions that came in since the last night's run
    // rather than the whole history every night (runState.js). The price-list
    // range sweep runs in full regardless — the workbooks change without any
    // new order being placed.
    // The browser pass is the only oracle for the price a customer is actually
    // quoted (browserRunner: the headless engine can settle a formula-driven
    // price axis differently), and it is the only thing that can answer whether
    // the form accepts a size the price list has no price for. It runs only
    // when CONFIGTEST_APP_URL is set explicitly, on purpose: the default target
    // (RECALC_APP_PORT, else 8081) turned out to be a DIFFERENT copy of the app
    // with an empty department list, and pointing this at the wrong instance
    // produces confident nonsense rather than an error.
    const withBrowser = !!process.env.CONFIGTEST_APP_URL
      && process.env.CONFIGTEST_NIGHTLY_BROWSER !== 'false';

    // Symulacja TWORZENIA pozycji — warstwa, która odpowiada wprost na pytanie
    // „czy klient da dziś radę złożyć pozycję w tej grupie". Włącza się sama,
    // gdy ma komplet danych: adres instancji i konto do zalogowania
    // (`CONFIGTEST_SIM_PIN`/`_PASSWORD`) plus zamówienie, w którym otwiera
    // ekran nowej pozycji (`CONFIGTEST_SIM_ORDER_ID`). Brak któregokolwiek →
    // pomijamy z wpisem w raporcie, nigdy po cichu.
    const withSimulation = !!process.env.CONFIGTEST_APP_URL
      && !!process.env.CONFIGTEST_SIM_PIN
      && !!process.env.CONFIGTEST_SIM_PASSWORD
      && !!process.env.CONFIGTEST_SIM_ORDER_ID
      && process.env.CONFIGTEST_NIGHTLY_SIMULATION !== 'false';

    const { report, reportFilePath, skippedDisabled } = await runFullSuite({
      randomCasesCount: RANDOM_CASES,
      onlyNew: process.env.CONFIGTEST_NIGHTLY_ALL_POSITIONS !== 'true',
      browser: withBrowser,
      simulation: withSimulation
    });
    if (skippedDisabled) {
      log('ConfiguratorTester daemon: nightly cycle pominięty — tester zablokowany (configtest/DISABLED).');
    } else {
      log(`ConfiguratorTester daemon: cycle done — ${report.totalFindings} błędów (P1: ${report.byPriority.P1 || 0}), raport: ${reportFilePath}`);
    }
  } catch (err) {
    log(`ConfiguratorTester daemon: cycle error: ${err.message}`);
  } finally {
    cycleRunning = false;
  }
}

/**
 * Czy z PID-u w pliku chodzi żywy proces.
 *
 * ⚠️ Dwa demony naraz to dwa pełne przeloty o 2:00, dwa maile do tych samych
 * czterech osób i podwojone zużycie pamięci (jedna grupa ~1.5 GB). Łatwo o to
 * po instalacji unitu systemd obok ręcznie odpalonego `npm run configtest:daemon`,
 * dlatego drugi start kończy się czysto (kod 0) z wyjaśnieniem, a unit ma
 * `Restart=on-failure`, żeby nie wpadł w pętlę restartów.
 */
function alreadyRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0); // tylko sprawdzenie istnienia procesu
    return pid;
  } catch (_err) {
    return false; // brak pliku albo martwy PID — wolna droga
  }
}

function startDaemon() {
  if (timer) return;

  const running = alreadyRunning();
  if (running) {
    log(`ConfiguratorTester daemon: już chodzi (pid=${running}) — ten start pomijam, żeby nie było dwóch przelotów naraz.`);
    process.exit(0);
  }

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
