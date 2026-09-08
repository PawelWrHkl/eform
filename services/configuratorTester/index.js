/**
 * Public API of the configurator tester module — see
 * /home/pawel/.claude/plans/splendid-forging-mango.md for the full design
 * (Faza 1: no Excel truth table yet, no DB writes, no Playwright — only
 * services/formEngine driven headlessly against real historical positions).
 */

'use strict';

const { listActiveGroups } = require('./groupDiscovery');
const { runGroupSuite } = require('./caseGenerator');
const { runGroupInChild, ISOLATE_GROUPS } = require('./groupProcess');
const { buildRunReport } = require('./reportBuilder');
const { saveRunReport } = require('./outputStore');
const { saveHtmlReport } = require('./htmlReport');
const { sendTestReport } = require('./mailer');
const { log } = require('./logger');
const { pruneOutput, rotateLog } = require('./retention');

/**
 * Run the full nightly suite across every active group.
 * @param {object} [opts]
 * @param {number} [opts.randomCasesCount]
 * @param {number} [opts.seed]
 * @param {string[]} [opts.onlyGroups] - restrict to these group numbers (quick test)
 */
/** Where the browser pass points, for the report's own audit trail. */
function runBrowserChecksTarget() {
  try { return require('./browserRunner').APP_URL; } catch (_e) { return 'nieznany adres'; }
}

async function runFullSuite(opts = {}) {
  try {
    return await runFullSuiteInner(opts);
  } catch (err) {
    // A monitoring tool that dies silently is worse than none: without this,
    // a failure before the first group (an unreadable group.txt, say) meant no
    // e-mail at all and nobody knew the tester had stopped working.
    log(`ConfiguratorTester: przebieg przerwany globalnie — ${err.message}`);
    await sendFailureReport(err).catch(() => {});
    throw err;
  }
}

async function runFullSuiteInner(opts = {}) {
  // Housekeeping first, so a long-running daemon never accumulates output or
  // an unbounded log (see retention.js for the measured numbers).
  rotateLog();
  pruneOutput(require('../../config').configTestOutputDir);

  const startedAt = new Date().toISOString();
  const allGroups = listActiveGroups().map((g) => g.groupNumber);
  const groupNumbers = opts.onlyGroups && opts.onlyGroups.length ? opts.onlyGroups : allGroups;

  const groupResults = [];

  // Browser pass (Playwright over the real UI) — opt-in, because it needs a
  // reachable eForm instance and Chromium. See browserRunner.js for why it is
  // read-only.
  if (opts.browser) {
    const path = require('path');
    const { configTestOutputDir } = require('../../config');
    const { runBrowserChecks } = require('./browserRunner');
    const screenshotDir = path.join(configTestOutputDir, startedAt.slice(0, 10), 'screenshots');
    // One real position per group — the admin-redit view sets that order
    // owner's context itself, which is the only way to get a fully populated
    // configurator in the browser (see browserRunner.openPositionInBrowser).
    const { getRecentPositions } = require('./positionsSource');
    const browserPositions = [];
    for (const groupNumber of groupNumbers) {
      const rows = await getRecentPositions(groupNumber, 1);
      // The owner's identity travels with the position: the browser pass
      // compares the on-screen price against the price list, and the price-list
      // variant is per client (see excelTruthTable/priceVariant.js).
      if (rows.length) {
        browserPositions.push({
          groupNumber,
          positionId: rows[0].id,
          orgIdent: rows[0].org_ident,
          userIdent: rows[0].user_ident,
          lang: rows[0].lang || 'pl'
        });
      }
    }
    const browserResult = await runBrowserChecks({ positions: browserPositions, screenshotDir });
    if (browserResult.skipped) {
      log(`ConfiguratorTester: test w przeglądarce pominięty — ${browserResult.skipped}`);
    }
    groupResults.push({
      groupNumber: 'przeglądarka',
      skipped: !!browserResult.skipped,
      findings: browserResult.findings,
      positionsChecked: browserResult.checked,
      reason: browserResult.skipped || `Test interfejsu w przeglądarce (${runBrowserChecksTarget()}).`
    });
  }

  for (const groupNumber of groupNumbers) {
    try {
      // Each group in its own process by default — see groupProcess.js /
      // scripts/configTestGroupWorker.js for the memory numbers behind it.
      const result = ISOLATE_GROUPS
        ? await runGroupInChild(groupNumber, opts)
        : await runGroupSuite(groupNumber, opts);
      groupResults.push(result);
      log(`ConfiguratorTester: grupa ${groupNumber} — ${result.skipped ? 'pominięta' : `${result.findings.length} błędów`}`);
    } catch (err) {
      groupResults.push({ groupNumber, skipped: false, findings: [{
        priority: 'P1', code: 'BLAD_TESTU', groupNumber, positionId: null,
        message: `Nieoczekiwany błąd podczas testowania grupy ${groupNumber}: ${err.message}`,
        date: new Date().toISOString()
      }] });
      log(`ConfiguratorTester: grupa ${groupNumber} — WYJĄTEK: ${err.message}`);
    } finally {
      // Release this group's parsed workbooks before moving on, on the error
      // path too — see excelTruthTable/index.js: holding them across groups
      // exhausted the heap and killed the whole sweep after one group. The
      // compiled price scripts (5-6 MB of generated code each) go the same way.
      require('./excelTruthTable').clearSheetCache();
      require('./deployedScript').clearScriptCache();
    }
  }

  // Release the shared JSDOM realm the Excel truth table uses for formula
  // evaluation — otherwise the process keeps it (and its timers) alive.
  require('./excelTruthTable').disposeEvaluator();

  const report = buildRunReport(groupResults, { startedAt, finishedAt: new Date().toISOString() });
  const reportFilePath = saveRunReport(report);
  const htmlReportPath = saveHtmlReport(report, reportFilePath);
  await sendTestReport(report, reportFilePath);

  return { report, reportFilePath, htmlReportPath };
}

/** Tell the recipients the run itself broke — otherwise the failure is silent. */
async function sendFailureReport(err) {
  const report = buildRunReport([{
    groupNumber: '—',
    skipped: false,
    findings: [{
      priority: 'P1',
      code: 'PRZEBIEG_TESTERA_PRZERWANY',
      groupNumber: null,
      positionId: null,
      message: `Przebieg testera przerwał się przed zakończeniem: ${err.message}. Raport jest niepełny — nie traktuj braku zgłoszeń jako potwierdzenia, że konfigurator działa.`,
      date: new Date().toISOString()
    }]
  }], {});
  const reportFilePath = saveRunReport(report);
  saveHtmlReport(report, reportFilePath);
  await sendTestReport(report, reportFilePath);
}

/** Quick test for a subset of groups (e.g. "po każdej zmianie" from the PDF harmonogram). */
async function runQuickSuite(groupNumbers, opts = {}) {
  return runFullSuite(Object.assign({}, opts, { onlyGroups: groupNumbers }));
}

module.exports = { runFullSuite, runQuickSuite };
