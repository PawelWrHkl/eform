#!/usr/bin/env node
/**
 * 05:30 watchdog for the nightly configuratorTester run (deploy/eform-
 * configtest-watchdog.service + .timer). Started, on its own systemd timer,
 * strictly AFTER the 02:00 nightly window has had 3.5h to finish.
 *
 * 2026-09-21 incident: a nightly run died mid-group with no clean shutdown
 * — no OOM message, no exit code, nothing — and took the whole host down
 * with it (main eform server, import daemon, everything). A process-level
 * memory cap (see deploy/eform-configtest.service) should stop the SAME
 * failure mode next time, but "should" is not a guarantee for a background
 * job nobody is watching at 5am. This is the backstop: if the run marker
 * (services/configuratorTester/runLock.js) is still there at 05:30, the run
 * either hung or died without cleanup either way, the host may already be
 * degraded (leaked Chromium, exhausted memory, thrashing) — so this reboots
 * the WHOLE machine and disables the tester until a human clears it
 * (`rm configtest/DISABLED`), rather than let it silently retry into the
 * same failure the next night.
 *
 * Runs as root (see the .service unit) so it can reboot without sudo.
 */
require('dotenv').config();

const { readRunMarker, disable } = require('../services/configuratorTester/runLock');
const { log } = require('../services/configuratorTester/logger');
const { execFileSync } = require('child_process');

// A marker older than this is not "still running the 02:00 job" — it is
// orphaned state from days ago (e.g. the watchdog itself was down for a
// while). Rebooting the host over week-old stale JSON would be a surprise
// with no useful effect; that case is logged instead, for a human to look at.
const MAX_MARKER_AGE_MS = 24 * 60 * 60 * 1000;

function main() {
  const marker = readRunMarker();
  if (!marker) {
    log('ConfiguratorTester watchdog: brak przebiegu w toku o 05:30 — OK.');
    return;
  }

  const startedAt = Date.parse(marker.startedAt);
  const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
  if (ageMs > MAX_MARKER_AGE_MS) {
    log(`ConfiguratorTester watchdog: znaleziono STARY znacznik przebiegu (${marker.startedAt}, pid=${marker.pid}) — to nie dzisiejsza noc, zostawiam bez ruszania hosta. Sprawdź ręcznie configtest/run-in-progress.json.`);
    return;
  }

  const reason = `Przebieg rozpoczęty ${marker.startedAt} (pid=${marker.pid}) nadal "w toku" o 05:30 — albo wisi, albo padł bez czystego zamknięcia (dokładnie jak 2026-09-21). Wymuszony restart hosta przez watchdog.`;
  log(`ConfiguratorTester watchdog: ${reason}`);
  disable(reason);

  try {
    execFileSync('/usr/sbin/reboot', [], { stdio: 'inherit' });
  } catch (err) {
    log(`ConfiguratorTester watchdog: nie udało się wywołać reboot (${err.message}) — spróbuj "systemctl reboot" ręcznie.`);
    process.exitCode = 1;
  }
}

main();
