/**
 * What the tester already checked, so a nightly run can pick up where the last
 * one stopped instead of re-pricing the whole history every night.
 *
 * Kept deliberately small and boring: the highest `order_item.id` seen per
 * group, in one JSON file next to the log. It is a convenience, not a source of
 * truth — a missing or corrupt file must only ever cost one wider run, never a
 * skipped one, so every read failure falls back to "nothing checked yet".
 *
 * Note what is NOT incremental: the price-list range sweep (rangeSweep.js) runs
 * in full every night regardless, because the workbooks in /mnt/eformconf can
 * change without a single new order being placed — which is exactly the case
 * the brief is most worried about.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

// Resolved per call, not once at load: the unit tests point
// CONFIGTEST_STATE_PATH at a scratch file, and a constant captured at require
// time would have them writing into the real state.
function statePath() {
  return process.env.CONFIGTEST_STATE_PATH
    || path.join(__dirname, '..', '..', 'configtest', 'state.json');
}

function readState() {
  try {
    const file = statePath();
    if (!fs.existsSync(file)) return { lastPositionId: {} };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { lastPositionId: (parsed && parsed.lastPositionId) || {} };
  } catch (err) {
    log(`ConfiguratorTester: nie udało się odczytać stanu (${err.message}) — traktuję jak pierwszy przebieg`);
    return { lastPositionId: {} };
  }
}

/** Highest position id already checked for a group, or null on the first run. */
function getLastCheckedPositionId(groupNumber) {
  const value = readState().lastPositionId[String(groupNumber)];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * Record how far this group got. Only ever moves forward: an out-of-order or
 * partial run must not rewind the mark and cause positions to be re-checked
 * for ever.
 */
function setLastCheckedPositionId(groupNumber, positionId) {
  const id = Number(positionId);
  if (!Number.isFinite(id)) return;

  const state = readState();
  const key = String(groupNumber);
  const previous = Number(state.lastPositionId[key]);
  if (Number.isFinite(previous) && previous >= id) return;

  state.lastPositionId[key] = id;
  try {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`ConfiguratorTester: nie udało się zapisać stanu (${err.message}) — następny przebieg sprawdzi te pozycje ponownie`);
  }
}

module.exports = { getLastCheckedPositionId, setLastCheckedPositionId, statePath };
