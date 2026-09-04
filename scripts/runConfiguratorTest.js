#!/usr/bin/env node
/**
 * One-shot configurator test run ("krótki test po każdej zmianie" z PDF-a).
 *
 * Usage:
 *   node scripts/runConfiguratorTest.js                 # wszystkie aktywne grupy
 *   node scripts/runConfiguratorTest.js 43 04            # tylko wskazane grupy
 *
 * Logs: configtest/configtest.log
 * Reports: <ROOT_DIR>/configtest-output/<data>/run-<znacznik>.json
 */
require('dotenv').config();

const { runFullSuite, runQuickSuite } = require('../services/configuratorTester');

const groupNumbers = process.argv.slice(2).filter((a) => !a.startsWith('--'));

(async () => {
  try {
    const { report, reportFilePath } = groupNumbers.length
      ? await runQuickSuite(groupNumbers)
      : await runFullSuite();

    console.log(`Sprawdzono grup: ${report.groupsChecked}, pominięto: ${report.groupsSkipped.length}`);
    console.log(`Znaleziono błędów: ${report.totalFindings} (P1: ${report.byPriority.P1 || 0})`);
    console.log(`Pełny raport: ${reportFilePath}`);
    process.exit(report.byPriority.P1 > 0 ? 1 : 0);
  } catch (err) {
    console.error('ConfiguratorTester crashed:', err);
    process.exit(2);
  }
})();
