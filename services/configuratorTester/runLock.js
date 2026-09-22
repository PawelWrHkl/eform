/**
 * "Is a nightly run in progress" marker + kill-switch, for the 05:30
 * watchdog (scripts/configTestWatchdog.js) — see deploy/eform-configtest-
 * watchdog.service. Two tiny JSON/marker files next to the log, same idea as
 * configtest/state.json: convenience state, not a source of truth.
 *
 * Why this exists: the 2026-09-21 incident left the daemon dead mid-group
 * with no clean shutdown line at all — an in-memory-only "am I running" flag
 * (like the daemon's own `cycleRunning`) is invisible to anything outside
 * that one process. The watchdog runs as its own systemd timer and needs to
 * ask "did last night's run ever finish?" from a fresh process, so the
 * answer has to live on disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const DIR = path.join(__dirname, '..', '..', 'configtest');
const RUN_MARKER_PATH = path.join(DIR, 'run-in-progress.json');
const DISABLED_PATH = path.join(DIR, 'DISABLED');

function markRunStart() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(RUN_MARKER_PATH, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }, null, 2));
  } catch (err) {
    log(`ConfiguratorTester: nie udało się zapisać znacznika przebiegu (${err.message})`);
  }
}

function markRunEnd() {
  try { fs.unlinkSync(RUN_MARKER_PATH); } catch (_err) { /* nie było go — nic się nie stało */ }
}

/**
 * @returns {{startedAt: string, pid: number}|null} znacznik, jeśli istnieje i da się go odczytać.
 */
function readRunMarker() {
  try {
    return JSON.parse(fs.readFileSync(RUN_MARKER_PATH, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function isDisabled() {
  return fs.existsSync(DISABLED_PATH);
}

/**
 * Kill-switch po wymuszonym restarcie hosta (watchdog) — tester NIE wraca
 * sam po ponownym uruchomieniu, dopóki ktoś ręcznie nie usunie tego pliku
 * (`rm configtest/DISABLED`). Celowo NIE ma kodu do automatycznego
 * kasowania — poranny przegląd przez człowieka jest tu częścią procedury,
 * nie skutkiem ubocznym.
 */
function disable(reason) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(DISABLED_PATH, `${new Date().toISOString()} ${reason}\nUsuń ten plik ręcznie, żeby tester znów mógł chodzić (rm configtest/DISABLED).\n`);
  } catch (err) {
    log(`ConfiguratorTester: nie udało się zapisać blokady (${err.message})`);
  }
}

module.exports = { markRunStart, markRunEnd, readRunMarker, isDisabled, disable, RUN_MARKER_PATH, DISABLED_PATH };
