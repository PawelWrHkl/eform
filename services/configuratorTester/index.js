/**
 * Public API of the configurator tester module — see
 * /home/pawel/.claude/plans/splendid-forging-mango.md for the full design
 * (Faza 1: no Excel truth table yet, no DB writes, no Playwright — only
 * services/formEngine driven headlessly against real historical positions).
 */

'use strict';

const { listActiveGroups } = require('./groupDiscovery');
const { runGroupSuite } = require('./caseGenerator');
const { buildRunReport } = require('./reportBuilder');
const { saveRunReport } = require('./outputStore');
const { sendTestReport } = require('./mailer');
const { log } = require('./logger');

/**
 * Run the full nightly suite across every active group.
 * @param {object} [opts]
 * @param {number} [opts.randomCasesCount]
 * @param {number} [opts.seed]
 * @param {string[]} [opts.onlyGroups] - restrict to these group numbers (quick test)
 */
async function runFullSuite(opts = {}) {
  const startedAt = new Date().toISOString();
  const allGroups = listActiveGroups().map((g) => g.groupNumber);
  const groupNumbers = opts.onlyGroups && opts.onlyGroups.length ? opts.onlyGroups : allGroups;

  const groupResults = [];
  for (const groupNumber of groupNumbers) {
    try {
      const result = await runGroupSuite(groupNumber, opts);
      groupResults.push(result);
      log(`ConfiguratorTester: grupa ${groupNumber} — ${result.skipped ? 'pominięta' : `${result.findings.length} błędów`}`);
    } catch (err) {
      groupResults.push({ groupNumber, skipped: false, findings: [{
        priority: 'P1', code: 'BLAD_TESTU', groupNumber, positionId: null,
        message: `Nieoczekiwany błąd podczas testowania grupy ${groupNumber}: ${err.message}`,
        date: new Date().toISOString()
      }] });
      log(`ConfiguratorTester: grupa ${groupNumber} — WYJĄTEK: ${err.message}`);
    }
  }

  const report = buildRunReport(groupResults, { startedAt, finishedAt: new Date().toISOString() });
  const reportFilePath = saveRunReport(report);
  await sendTestReport(report, reportFilePath);

  return { report, reportFilePath };
}

/** Quick test for a subset of groups (e.g. "po każdej zmianie" from the PDF harmonogram). */
async function runQuickSuite(groupNumbers, opts = {}) {
  return runFullSuite(Object.assign({}, opts, { onlyGroups: groupNumbers }));
}

module.exports = { runFullSuite, runQuickSuite };
