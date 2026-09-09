/**
 * Przejazd symulacji tworzenia pozycji po wszystkich działach i grupach.
 *
 * Listę działów i grup bierze **z interfejsu**, nie z plików — bo to interfejs
 * stosuje whitelistę klientów z `prod.txt` (`users`). Grupa nieobecna na liście
 * nie jest usterką: ten klient po prostu jej nie ma.
 *
 * Konto do symulacji musi widzieć działy i grupy. Konto administratora ich NIE
 * widzi (`ADMIN_PIN`, ident SZEF — zero grup, bo `FormsManager.getGroups()`
 * honoruje whitelistę), dlatego symulacja ma własne dane w
 * `CONFIGTEST_SIM_PIN` / `CONFIGTEST_SIM_PASSWORD`.
 *
 * ⚠️ Nic nie zapisuje: `positionSimulator` nie klika `#show-button`, a otwierane
 * zamówienie (`CONFIGTEST_SIM_ORDER_ID`) służy tylko jako kontekst dla ekranu
 * nowej pozycji.
 */

'use strict';

const { chromium } = require('playwright');
const { log } = require('./logger');
const assertions = require('./assertions');
const { simulatePosition } = require('./positionSimulator');

const APP_URL = process.env.CONFIGTEST_APP_URL
  || `http://localhost:${process.env.RECALC_APP_PORT || 8081}`;
const ORDER_ID = process.env.CONFIGTEST_SIM_ORDER_ID;

/** Działy i ich grupy — dokładnie tak, jak widzi je zalogowany klient. */
async function discoverDepartmentsAndGroups(page) {
  await page.goto(`${APP_URL}/orders/order/${ORDER_ID}/new-position/`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(
    () => document.querySelectorAll('#department-select option').length > 1,
    { timeout: 60000 }
  );

  const departments = await page.evaluate(() => Array.from(document.querySelectorAll('#department-select option'))
    .filter((o) => o.value)
    .map((o) => ({ num: o.value, name: o.textContent.trim() })));

  const result = [];
  const seenGroups = new Set();

  for (const department of departments) {
    // ⚠️ Lista grup MUSI zostać opróżniona przed przełączeniem działu.
    // `buildGroupSelect` (main.js) najpierw wstawia placeholder, potem dokłada
    // opcje — więc czekanie na `options.length > 1` spełnia się NATYCHMIAST na
    // starych opcjach poprzedniego działu. Bez tego czyszczenia odkrywanie
    // przypisywało grupy 71/43/20 (dział 1) także działom 2, 3 i 4, a symulacja
    // słusznie odpowiadała „grupa niedostępna w tym dziale".
    await page.evaluate(() => {
      const select = document.getElementById('asortment-group-select');
      if (select) select.innerHTML = '';
    });

    await page.selectOption('#department-select', department.num);
    // Grupy dociągają się asynchronicznie (prod.txt per grupa). Brak grup to
    // legalny stan — dział bez produktów dla tego klienta.
    await page.waitForFunction(
      () => document.querySelectorAll('#asortment-group-select option').length > 1,
      { timeout: 30000 }
    ).catch(() => {});

    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#asortment-group-select option'))
      .filter((o) => o.value)
      .map((o) => ({ code: o.value, name: o.textContent.trim() })));

    // Ta sama grupa bywa w kilku działach — symulujemy ją raz.
    const fresh = groups.filter((g) => !seenGroups.has(String(g.code)));
    fresh.forEach((g) => seenGroups.add(String(g.code)));
    result.push({ ...department, groups: fresh, allGroups: groups });
  }
  return result;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.groupNumbers] ogranicz do wskazanych grup
 * @returns {Promise<{findings:Array, simulated:number, passed:number, skipped:string|null, results:Array}>}
 */
async function runSimulationChecks({ groupNumbers = null } = {}) {
  const pin = process.env.CONFIGTEST_SIM_PIN;
  const password = process.env.CONFIGTEST_SIM_PASSWORD;
  if (!pin || !password) {
    return { findings: [], simulated: 0, passed: 0, skipped: 'brak CONFIGTEST_SIM_PIN/CONFIGTEST_SIM_PASSWORD', results: [] };
  }
  if (!ORDER_ID) {
    return { findings: [], simulated: 0, passed: 0, skipped: 'brak CONFIGTEST_SIM_ORDER_ID (zamówienie, w którym otwieramy nową pozycję)', results: [] };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (err) {
    return { findings: [], simulated: 0, passed: 0, skipped: `nie udało się uruchomić Chromium: ${err.message}`, results: [] };
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(process.env.CONFIGTEST_BROWSER_TIMEOUT_MS) || 45000);

  const findings = [];
  const results = [];
  let simulated = 0;
  let passed = 0;

  try {
    await page.goto(`${APP_URL}/user/auth/login?pin=${encodeURIComponent(pin)}&password=${encodeURIComponent(password)}`);

    let tree;
    try {
      tree = await discoverDepartmentsAndGroups(page);
    } catch (err) {
      return { findings, simulated, passed, skipped: `nie udało się odczytać listy działów: ${err.message}`, results };
    }

    const totalGroups = tree.reduce((sum, d) => sum + d.groups.length, 0);
    log(`ConfiguratorTester (symulacja): ${tree.length} działów, ${totalGroups} grup do sprawdzenia (${APP_URL})`);

    for (const department of tree) {
      for (const group of department.groups) {
        if (groupNumbers && !groupNumbers.map(String).includes(String(group.code))) continue;

        let simulation;
        try {
          simulation = await simulatePosition({
            page,
            appUrl: APP_URL,
            orderId: ORDER_ID,
            departmentNumber: department.num,
            groupNumber: group.code
          });
        } catch (err) {
          // Wyjątek w trakcie prowadzenia formularza to informacja o testerze,
          // nie dowód usterki konfiguratora — stąd MEDIUM.
          findings.push({
            priority: 'MEDIUM',
            code: 'BLAD_SYMULACJI',
            groupNumber: group.code,
            positionId: null,
            expected: 'przejście przez konfigurator',
            actual: err.message,
            message: `Grupa ${group.code} (dział ${department.num}): symulacja przerwana błędem — ${err.message.split('\n')[0]}`,
            date: new Date().toISOString(),
            source: 'simulation'
          });
          continue;
        }

        simulated += 1;
        if (simulation.ok) passed += 1;

        // Krok, którego eForm nie ma: niezależny wzorzec z arkusza cennika,
        // policzony na wartościach USTALONYCH PRZEZ FORMULARZ. Tylko dla
        // kompletnej konfiguracji — przy niedokończonej porównywanie ceny nie
        // ma sensu (patrz checkSimulation).
        if (simulation.stage === 'werdykt' && simulation.complete) {
          try {
            simulation.priceListChecks = await comparePricesWithPriceList(page, simulation, group.code);
            findings.push(...(simulation.priceListChecks.findings || []));
          } catch (err) {
            log(`ConfiguratorTester (symulacja): grupa ${group.code} — porównanie z cennikiem nieudane: ${err.message}`);
          }
        }

        results.push(simulation);
        findings.push(...assertions.checkSimulation(simulation).map((f) => Object.assign(f, { source: 'simulation' })));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log(`ConfiguratorTester (symulacja): zdanych ${passed}/${simulated}, zgłoszeń: ${findings.length}`);
  return { findings, simulated, passed, skipped: null, results };
}

/**
 * Porównanie ceny, którą pokazał formularz, z niezależnym cennikiem z
 * `/mnt/eformconf` — na wartościach, na których ustalił się FORMULARZ.
 *
 * To jest ta część, w której automat jest mocniejszy od eForma: aplikacja
 * potrafi tylko powiedzieć „policzyłem 0", ale nie ma żadnego zewnętrznego
 * punktu odniesienia i nie wie, czy 447.26 to właściwa liczba.
 *
 * Dopłata per klient (mnożnik `f` z tabeli `uid` na końcu skryptu) nie istnieje
 * w arkuszu, dlatego wzorzec jest nią skalowany — czynnik odczytujemy z etykiety,
 * którą skrypt sam zwraca (`deployedScript.factorFromLabel`).
 */
async function comparePricesWithPriceList(page, simulation, groupNumber) {
  const excelTruthTable = require('./excelTruthTable');
  const { runDeployedScript } = require('./deployedScript');

  const settled = await page.evaluate(() => {
    const scripts = {};
    for (const p of (window.params || [])) if (p && p.NAME) scripts[p.NAME] = p.SCRIPTS;
    return { values: Object.assign({}, window.formValues), scripts };
  });

  const owner = await page.evaluate(async () => {
    const response = await fetch('/user/owner/');
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.idents ? data.idents : null;
  });
  if (!owner || !owner.orgIdent || !owner.userIdent) {
    return { findings: [], compared: 0, reason: 'nie udało się ustalić tożsamości klienta' };
  }

  const findings = [];
  let compared = 0;

  try {
    for (const paramName of ['CENA', 'DOPLATA']) {
      const onScreen = settled.values[paramName];
      if (onScreen === undefined || onScreen === '') continue;

      const reference = await excelTruthTable.getReferencePrice({
        groupNumber,
        lang: 'pl',
        orgIdent: owner.orgIdent,
        userIdent: owner.userIdent,
        paramName,
        values: settled.values,
        scriptsField: settled.scripts[paramName]
      });
      if (reference.kind === 'no-sheet' || reference.kind === 'unknown-axis') continue;

      const deployed = runDeployedScript({
        groupNumber,
        lang: 'pl',
        orgIdent: owner.orgIdent,
        userIdent: owner.userIdent,
        paramName,
        scriptsField: settled.scripts[paramName],
        values: settled.values
      });

      compared += 1;
      findings.push(...assertions.checkAgainstReferencePrice({
        groupNumber,
        paramName,
        actualPrice: onScreen,
        source: 'konfigurator (symulacja)',
        referenceFactor: deployed.ok ? deployed.factor : 1,
        reference
      }).map((f) => Object.assign(f, { source: 'simulation' })));
    }
  } finally {
    excelTruthTable.clearSheetCache();
    require('./deployedScript').clearScriptCache();
  }

  return { findings, compared };
}

module.exports = { runSimulationChecks, discoverDepartmentsAndGroups, comparePricesWithPriceList, APP_URL };
