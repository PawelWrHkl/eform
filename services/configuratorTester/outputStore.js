/**
 * Persists each run's report as JSON under config.configTestOutputDir, one
 * file per run, so a mailed summary can always be traced back to the full
 * finding list later (the PDF brief's "link odtwarzający konfigurację" is,
 * for Faza 1, this file path + positionId — good enough to open the position
 * directly in eForm's own edit view).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { configTestOutputDir } = require('../../config');

function runFilePath(startedAt) {
  const day = startedAt.slice(0, 10);
  const stamp = startedAt.replace(/[:.]/g, '-');
  return path.join(configTestOutputDir, day, `run-${stamp}.json`);
}

function saveRunReport(report) {
  const filePath = runFilePath(report.startedAt);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

module.exports = { saveRunReport, runFilePath };
