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
/**
 * Ile NAJNOWSZYCH dni z raportami zostaje zawsze, niezależnie od wieku.
 *
 * ⚠️ Sam próg wieku kasował całą historię po każdej przerwie w działaniu:
 * 2026-10-12 pierwszy przebieg po trzech tygodniach przestoju usunął jedyne
 * raporty z 21.09 — akurat wtedy, gdy szef zapytał o wyniki robota „od
 * uruchomienia". Teraz przerwa nie zjada dowodów.
 */
const ALWAYS_KEEP_NEWEST = Number(process.env.CONFIGTEST_KEEP_NEWEST_DAYS) || 10;

// `logFn` wstrzykiwany, bo testy wołają to na katalogach tymczasowych i bez
// tego zapisywały fałszywe „usunięto…" do PRAWDZIWEGO configtest.log.
function pruneOutput(outputDir, keepDays = DEFAULT_KEEP_DAYS, keepNewest = ALWAYS_KEEP_NEWEST, { logFn = log } = {}) {
  if (!fs.existsSync(outputDir)) return { removed: [] };

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];

  // Only touch our own `YYYY-MM-DD` directories — never anything else that
  // happens to live under the output path.
  const days = fs.readdirSync(outputDir).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  // ⚠️ Nie `slice(-keepNewest)` wprost: `slice(-0)` zwraca CAŁĄ tablicę,
  // więc keepNewest = 0 chroniłoby wszystko zamiast niczego.
  const protectedDays = new Set(keepNewest > 0 ? days.slice(-keepNewest) : []);

  for (const entry of days) {
    if (protectedDays.has(entry)) continue;
    const parsed = Date.parse(`${entry}T00:00:00Z`);
    if (!Number.isFinite(parsed) || parsed >= cutoff) continue;
    try {
      fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch (err) {
      logFn(`ConfiguratorTester: nie udało się usunąć starych wyników ${entry} — ${err.message}`);
    }
  }

  if (removed.length) logFn(`ConfiguratorTester: usunięto wyniki starsze niż ${keepDays} dni (${removed.join(', ')})`);
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

module.exports = {
  ALWAYS_KEEP_NEWEST, pruneOutput, rotateLog, DEFAULT_KEEP_DAYS };
