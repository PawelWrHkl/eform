/**
 * Housekeeping for the tester's own output.
 *
 * ⚠️ Measured, not hypothetical: a handful of runs produced 26 MB, with
 * full-page screenshots at roughly 1 MB each. Nightly runs across 15 groups
 * would add tens of megabytes a night, and this host has ~0.5 GB of free RAM
 * and a half-full swap — it does not need a directory growing without bound.
 * The neighbouring `import/import.log` (39 MB, never rotated) shows what
 * happens without this.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');
const { LOG_PATH } = require('./logger');

const DEFAULT_KEEP_DAYS = Number(process.env.CONFIGTEST_KEEP_DAYS) || 14;
const MAX_LOG_BYTES = Number(process.env.CONFIGTEST_MAX_LOG_BYTES) || 5 * 1024 * 1024;

/** Remove per-day output directories older than `keepDays`. */
function pruneOutput(outputDir, keepDays = DEFAULT_KEEP_DAYS) {
  if (!fs.existsSync(outputDir)) return { removed: [] };

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];

  for (const entry of fs.readdirSync(outputDir)) {
    // Only touch our own `YYYY-MM-DD` directories — never anything else that
    // happens to live under the output path.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const parsed = Date.parse(`${entry}T00:00:00Z`);
    if (!Number.isFinite(parsed) || parsed >= cutoff) continue;
    try {
      fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch (err) {
      log(`ConfiguratorTester: nie udało się usunąć starych wyników ${entry} — ${err.message}`);
    }
  }

  if (removed.length) log(`ConfiguratorTester: usunięto wyniki starsze niż ${keepDays} dni (${removed.join(', ')})`);
  return { removed };
}

/** Rotate the log once it passes `maxBytes`, keeping a single `.1` backup. */
function rotateLog(logPath = LOG_PATH, maxBytes = MAX_LOG_BYTES) {
  try {
    if (!fs.existsSync(logPath)) return { rotated: false };
    if (fs.statSync(logPath).size < maxBytes) return { rotated: false };
    fs.renameSync(logPath, `${logPath}.1`);
    return { rotated: true };
  } catch (err) {
    return { rotated: false, error: err.message };
  }
}

module.exports = { pruneOutput, rotateLog, DEFAULT_KEEP_DAYS };
