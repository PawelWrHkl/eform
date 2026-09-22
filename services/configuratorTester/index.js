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
const { markRunStart, markRunEnd, isDisabled } = require('./runLock');

/**
 * Run the full nightly suite across every active group.
 * @param {object} [opts]
 * @param {number} [opts.randomCasesCount]
 * @param {number} [opts.seed]
 * @param {string[]} [opts.onlyGroups] - restrict to these group numbers (quick test)
 * @param {boolean} [opts.browser] - dodatkowo przejazd po UI istniejących pozycji
 * @param {boolean} [opts.simulation] - dodatkowo symulacja TWORZENIA nowej pozycji
 */
/** Where the browser pass points, for the report's own audit trail. */
function runBrowserChecksTarget() {
  try { return require('./browserRunner').APP_URL; } catch (_e) { return 'nieznany adres'; }
}

async function runFullSuite(opts = {}) {
  // Kill-switch po wymuszonym restarcie hosta (deploy/eform-configtest-
  // watchdog.service, 2026-09-21: przelot bez sufitu pamięci zjadł cały RAM
  // i zabił wszystko w tle). Blokada jest CELOWO cicha — bez maila, bez
  // wpisu w raporcie — bo to znany, zamierzony stan po incydencie, nie
  // awaria; log wystarcza, a odblokowanie jest ręczne
  // (`rm configtest/DISABLED`, patrz runLock.js).
  if (isDisabled()) {
    log('ConfiguratorTester: zablokowany po poprzednim wymuszonym restarcie (configtest/DISABLED) — pomijam przebieg.');
    return { report: null, reportFilePath: null, htmlReportPath: null, skippedDisabled: true };
  }

  markRunStart();
  try {
    return await runFullSuiteInner(opts);
  } catch (err) {
    // A monitoring tool that dies silently is worse than none: without this,
    // a failure before the first group (an unreadable group.txt, say) meant no
    // e-mail at all and nobody knew the tester had stopped working.
    log(`ConfiguratorTester: przebieg przerwany globalnie — ${err.message}`);
    await sendFailureReport(err).catch(() => {});
    throw err;
  } finally {
    // Zawsze, także na ścieżce błędu — inaczej watchdog o 5:30 widziałby
    // "przebieg w toku" na zawsze po zwykłym wyjątku, nie tylko po realnym
    // zawieszeniu, i resetowałby host bez potrzeby co noc.
    markRunEnd();
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

  // Parsowanie wdrożonych skryptów cenowych — PIERWSZE, bo jest tanie
  // (`new vm.Script`, bez wykonania: 1532 pliki w kilka sekund) i wyjaśnia
  // wyniki wszystkich warstw niżej. Zepsuty plik daje „według cennika" zamiast
  // ceny, a pozycja zapisuje się bez wartości — dokładnie to znaleziono na
  // grupie 76. Wyłączalne `CONFIGTEST_SCRIPT_SYNTAX=false` tylko na wypadek,
  // gdyby kiedyś przeszkadzało; domyślnie chodzi zawsze.
  if (process.env.CONFIGTEST_SCRIPT_SYNTAX !== 'false') {
    try {
      const { checkGroupScripts } = require('./scriptSyntaxCheck');
      const syntax = checkGroupScripts(groupNumbers);
      groupResults.push({
        groupNumber: 'skrypty cenowe',
        skipped: false,
        findings: syntax.findings,
        stats: { scriptsParsed: syntax.checked, scriptsBroken: syntax.broken },
        reason: `Parsowanie wdrożonych skryptów cenowych (${syntax.checked} plików, bez uruchamiania).`
      });
      log(`ConfiguratorTester: skrypty cenowe — sprawdzono ${syntax.checked}, niesparsowalnych ${syntax.broken}`);
    } catch (err) {
      // Awaria samego sprawdzenia nie może przewrócić całego przebiegu.
      log(`ConfiguratorTester: sprawdzenie składni skryptów nieudane — ${err.message}`);
    }
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

  // Symulacja tworzenia pozycji — warstwa, która odpowiada na pytanie
  // właściciela wprost: „czy da się TERAZ złożyć pozycję w tej grupie".
  // Przechodzi konfigurator jak człowiek (dział → grupa → wypełnienie pól →
  // werdykt) i wydaje ocenę WALIDATOREM APLIKACJI, a ceny porównuje
  // z niezależnym cennikiem. Idzie na końcu, bo jest najdroższa (Chromium,
  // realna sesja) i najbardziej zależna od środowiska.
  //
  // ⚠️ Nic nie zapisuje — `positionSimulator` nie klika `#show-button`.
  if (opts.simulation) {
    try {
      const { runSimulationChecks } = require('./simulationRunner');
      const simulation = await runSimulationChecks({ groupNumbers: opts.onlyGroups || null });
      if (simulation.skipped) {
        log(`ConfiguratorTester: symulacja pominięta — ${simulation.skipped}`);
      }
      groupResults.push({
        groupNumber: 'symulacja',
        skipped: !!simulation.skipped,
        findings: simulation.findings,
        stats: { simulated: simulation.simulated, simulationPassed: simulation.passed },
        reason: simulation.skipped
          || `Symulacja tworzenia pozycji w przeglądarce: zdanych ${simulation.passed}/${simulation.simulated}.`
      });
    } catch (err) {
      // Zgłaszamy jako wynik, nie jako wyjątek — reszta raportu jest ważna
      // nawet wtedy, gdy przeglądarka nie wstała.
      log(`ConfiguratorTester: symulacja przerwana — ${err.message}`);
      groupResults.push({
        groupNumber: 'symulacja',
        skipped: false,
        findings: [{
          priority: 'MEDIUM',
          code: 'BLAD_SYMULACJI',
          groupNumber: null,
          positionId: null,
          message: `Symulacja tworzenia pozycji przerwała się: ${err.message}. Brak zgłoszeń z tej warstwy NIE oznacza, że konfigurator działa.`,
          date: new Date().toISOString(),
          source: 'simulation'
        }]
      });
    }
  }

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
