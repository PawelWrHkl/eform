#!/usr/bin/env node
/**
 * One-shot configurator test run ("krótki test po każdej zmianie" z PDF-a).
 *
 * Usage:
 *   node scripts/runConfiguratorTest.js                 # wszystkie aktywne grupy
 *   node scripts/runConfiguratorTest.js 43 04            # tylko wskazane grupy
 *   node scripts/runConfiguratorTest.js --browser        # dodatkowo test UI w przeglądarce
 *   node scripts/runConfiguratorTest.js --symulacja      # dodatkowo symulacja TWORZENIA pozycji
 *   node scripts/runConfiguratorTest.js --nowe           # tylko pozycje nowsze niż ostatni przebieg
 *
 * Logs: configtest/configtest.log
 * Reports: <ROOT_DIR>/configtest-output/<data>/run-<znacznik>.json
 */
require('dotenv').config();

const { runFullSuite, runQuickSuite } = require('../services/configuratorTester');

const args = process.argv.slice(2);
const groupNumbers = args.filter((a) => !a.startsWith('--'));
const browser = args.includes('--browser');
const simulation = args.includes('--symulacja') || args.includes('--simulation');
const onlyNew = args.includes('--nowe') || args.includes('--only-new');

(async () => {
  try {
    const { report, reportFilePath, htmlReportPath, skippedDisabled } = groupNumbers.length
      ? await runQuickSuite(groupNumbers, { browser, simulation, onlyNew })
      : await runFullSuite({ browser, simulation, onlyNew });

    if (skippedDisabled) {
      console.log('Tester zablokowany po poprzednim wymuszonym restarcie hosta — usuń configtest/DISABLED, żeby odblokować.');
      process.exit(3);
    }

    console.log(`Sprawdzono grup: ${report.groupsChecked}, pominięto: ${report.groupsSkipped.length}`);
    console.log(`Znaleziono błędów: ${report.totalFindings} (P1: ${report.byPriority.P1 || 0})`);
    const t = report.totals || {};
    if (t.scriptsParsed) console.log(`Skrypty cenowe: ${t.scriptsParsed} sprawdzonych, ${t.scriptsBroken} niesparsowalnych`);
    if (t.simulated) console.log(`Symulacja tworzenia pozycji: ${t.simulationPassed}/${t.simulated} grup zdanych`);
    console.log(`Pełny raport: ${reportFilePath}`);
    if (htmlReportPath) console.log(`Raport HTML:  ${htmlReportPath}`);
    process.exit(report.byPriority.P1 > 0 ? 1 : 0);
  } catch (err) {
    console.error('ConfiguratorTester crashed:', err);
    process.exit(2);
  }
})();
