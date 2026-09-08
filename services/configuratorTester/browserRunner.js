/**
 * Browser-level (Playwright) pass over the real configurator UI.
 *
 * The brief asks for two levels of testing: the calculation engine through an
 * API, and the portal in a real browser. `engineRunner.js`/`formWalker.js`
 * cover the first; this covers the second — it catches what the headless
 * engine cannot see: a field that never renders, a save button that stays
 * disabled, a price row that is blank on screen even though the value exists.
 *
 * Built from the project owner's scaffold (`Efora_automatyczny_tester_kod`,
 * `src/runner.js`), keeping its good ideas — walk required fields, verify the
 * price after every choice, screenshot every problem — but against eForm's
 * ACTUAL interface. The scaffold's selectors (`[data-testid='configurator']`,
 * `[data-testid='next-step']`, `[data-testid='add-to-cart']`, …) describe a
 * step wizard with a shopping cart; eForm has a single dynamic form
 * (`#dynamic-form`) built from `param.txt`, one wrapper per param
 * (`.<NAME>-select-area`), and saves a position with `#show-button` instead of
 * adding to a cart. Its login form (`input[name='login']`) does not exist
 * either — eForm authenticates by PIN through `/user/auth/login`, exactly as
 * services/orderImport/browserRecalculator.js already does.
 *
 * ⚠️ READ-ONLY on purpose: this pass never clicks `#show-button`, so it writes
 * nothing to the database. Saving a position (the closest thing eForm has to
 * "add to cart") would create a real order row, which per the brief must only
 * ever happen on a test environment behind an AUTO-TEST marker — and no such
 * marker exists in the codebase yet.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { log } = require('./logger');

const APP_URL = process.env.CONFIGTEST_APP_URL
  || `http://localhost:${process.env.RECALC_APP_PORT || 8081}`;

const CALC_TIMEOUT_MS = Number(process.env.CONFIGTEST_BROWSER_TIMEOUT_MS) || 45000;
const PRICE_FIELDS = ['CENA', 'CENA_SUMA', 'SUMA_BRUTTO', 'CENA_KONCOWA'];
// Params verified against the authoring workbook in the browser pass. The same
// list the headless pass uses (caseGenerator.REFERENCE_PRICE_PARAMS) minus the
// SUB___ ones: those only exist when client prices are switched on for the
// session, which the admin-redit view does not do.
const PRICE_PARAMS_TO_VERIFY = ['CENA', 'DOPLATA', 'CENA_RABAT'];

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
}

/**
 * PIN-based login, the same URL shape browserRecalculator.js uses. Credentials
 * come from the environment; never inline them.
 */
async function login(page) {
  const pin = process.env.ADMIN_PIN;
  const password = process.env.ADMIN_PASSWORD;
  if (!pin || !password) return { ok: false, reason: 'brak ADMIN_PIN/ADMIN_PASSWORD w środowisku' };
  await page.goto(`${APP_URL}/user/auth/login?pin=${encodeURIComponent(pin)}&password=${encodeURIComponent(password)}`);
  return { ok: true };
}

/** Wait until form.js reports it has finished recalculating (same flags the app's own code waits on). */
async function waitForCalculations(page) {
  try {
    await page.waitForFunction(
      () => window.finishFlag === true && window.isCalculating !== true,
      { timeout: CALC_TIMEOUT_MS }
    );
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Open one existing position in the admin single-edit view.
 *
 * This replaced "pick department + group and configure from scratch" for a
 * concrete reason found by testing: the ADMIN_PIN account (ident SZEF) sees
 * exactly one department and ZERO groups, because prod.txt assigns products to
 * named clients and FormsManager.getGroups() honours that whitelist — so that
 * login cannot open any configurator at all. `/position/:id/admin-redit/`
 * sidesteps it: routes/positions.js sets the ORDER OWNER's context before
 * rendering (ownerService.setContextUserByIdent), so the form is built with the
 * right client's dictionaries and price scripts. services/orderImport/
 * browserRecalculator.js already drives this same route in production.
 *
 * We only load and inspect the page — the save button is never clicked.
 */
async function openPositionInBrowser(page, positionId) {
  await page.goto(`${APP_URL}/position/${positionId}/admin-redit/`);
  await page.waitForLoadState('networkidle');
  const settled = await waitForCalculations(page);
  const hasForm = await page.evaluate(() => {
    const form = document.getElementById('dynamic-form');
    return !!form && form.querySelectorAll('select, input').length > 0;
  });
  return { settled, hasForm };
}

/**
 * Inspect the rendered form WITHOUT touching it.
 *
 * The earlier version clicked through the fields like a new configuration, but
 * admin-redit opens an ALREADY configured position — so every click merely
 * re-opened a fabric/colour dialog and the run hung on it for 45s per group.
 * Verification is what this pass is for anyway: a required picklist that is
 * empty on screen is exactly the brief's "brak opcji do wybrania", and it can
 * be seen without a single click.
 */
async function inspectFields(page) {
  return page.evaluate(() => {
    const params = window.params || [];
    const blocked = [];

    for (const param of params) {
      const name = param && param.NAME;
      if (!name || name.includes('___') || param.TYPE === 'file') continue;
      if (param.SCRIPTS && param.SCRIPTS !== '<NULL>') continue;   // liczone
      if (param.FORMULA && param.FORMULA !== '<NULL>') continue;   // liczone

      const wrapper = document.querySelector(`.${name}-select-area`);
      if (!wrapper || wrapper.offsetParent === null) continue;     // ukryte

      const control = document.getElementById(name);
      if (!control || control.disabled) continue;
      if (control.tagName !== 'SELECT') continue;                  // tylko listy wyboru

      const hasValue = control.value !== '' && control.value !== '<NULL>';
      if (hasValue) continue;

      const usable = Array.from(control.options)
        .filter((o) => !o.disabled && o.value !== '' && o.value !== '<NULL>');
      if (!usable.length) blocked.push({ field: name, reason: 'lista wymaganego pola jest pusta' });
    }

    return blocked;
  });
}

/**
 * The settled value set the FORM itself arrived at, plus each param's SCRIPTS
 * column — everything needed to price this configuration independently.
 *
 * This is the only place the tester can see the coordinates the customer's form
 * actually uses. It matters because they can differ from the headless engine's:
 * for group 73 the browser settles `SZEROKOSC_POTRZEBNA` (the axis the CENA
 * sheet is indexed by) at 2830 while `formEngine.calculatePrices` settles it at
 * 2620 and prices before it settles at all. Checking the price list against
 * THESE values is therefore the only end-to-end verification of the price a
 * customer is really quoted.
 */
async function readSettledConfiguration(page) {
  return page.evaluate(() => {
    const scripts = {};
    for (const param of (window.params || [])) {
      if (param && param.NAME) scripts[param.NAME] = param.SCRIPTS;
    }
    return { values: Object.assign({}, window.formValues), scripts };
  });
}

/** Prices as the CLIENT sees them on screen, plus whether saving is possible. */
async function readOnScreenState(page) {
  return page.evaluate((priceFields) => {
    const prices = {};
    for (const name of priceFields) {
      const el = document.getElementById(name);
      if (el && el.offsetParent !== null) prices[name] = el.value;
    }
    const save = document.getElementById('show-button');
    const invalid = Array.from(document.querySelectorAll('#dynamic-form .invalid-input')).map((el) => el.id);
    return {
      prices,
      saveVisible: !!(save && save.offsetParent !== null),
      saveDisabled: !!(save && save.disabled),
      invalidFields: invalid
    };
  }, PRICE_FIELDS);
}

function finding(overrides) {
  return Object.assign({
    priority: 'P1',
    code: '',
    groupNumber: null,
    positionId: null,
    message: '',
    expected: null,
    actual: null,
    priceDiff: null,
    date: new Date().toISOString(),
    source: 'browser'
  }, overrides);
}

/**
 * Type a dimension into the real form and report back what the form did with
 * it — the only reliable answer to "does the configurator let a customer pick
 * this size?".
 *
 * Numeric inputs in `public/scripts/form.js` listen on `input` behind a 500 ms
 * debounce and then run `updateProcedure` with `validate: true`, so the value
 * has to be typed (not assigned) and the wait has to outlast the debounce
 * before `finishFlag` means anything.
 *
 * Read-only: this changes the page, never the database — the save button is not
 * touched. `window.inputFlags` is trustworthy here in a way it is not headless,
 * because the real form build populates the per-model validators.
 */
async function probeDimension(page, fieldName, valueMm) {
  const exists = await page.evaluate((name) => {
    const el = document.getElementById(name);
    return !!el && !el.disabled && el.tagName === 'INPUT';
  }, fieldName);
  if (!exists) return { ok: false, reason: `pole ${fieldName} nie jest edytowalnym polem liczbowym` };

  await page.fill(`#${fieldName}`, String(valueMm));
  await page.waitForTimeout(700);
  const settled = await waitForCalculations(page);

  const state = await page.evaluate((name) => {
    const el = document.getElementById(name);
    const save = document.getElementById('show-button');
    return {
      flag: window.inputFlags ? window.inputFlags[name] : undefined,
      markedInvalid: !!(el && el.classList.contains('invalid-input')),
      valueBack: el ? el.value : null,
      cena: window.formValues ? window.formValues.CENA : undefined,
      onScreenCena: (document.getElementById('CENA') || {}).value,
      saveDisabled: !!(save && save.disabled),
      saveVisible: !!(save && save.offsetParent !== null)
    };
  }, fieldName);

  // "Rejected" means the form said so in a way a customer would see: the red
  // border, or the validator flag it drives.
  //
  // Deliberately NOT keyed off the save button, which stays enabled even for a
  // field marked invalid — checked on the live page and traced through the
  // code: `admin_edit_form.js validateForm()` runs `checkFlags()` on submit and
  // refuses when any `inputFlags` entry is not `true`, so the click is gated
  // even though the button looks clickable. Verified end to end on group 73
  // position #6449: typing 11000 mm against a table that ends at 1000 cm gives
  // `inputFlags.SZEROKOSC === false`, a red border and CENA 0.
  const rejected = state.markedInvalid || state.flag === false;
  return { ok: true, settled, rejected, ...state };
}

/**
 * Does the form let a customer choose a size the price list has no price for?
 *
 * This is the half of the out-of-range question the headless sweep cannot
 * answer (rangeSweep.js reports it as WYMIAR_POZA_CENNIKIEM_DO_SPRAWDZENIA and
 * says so). If the form accepts the size and quotes nothing, the order can be
 * placed for 0 — the brief's worst case. If it accepts it and quotes something,
 * that price exists nowhere in the workbook.
 */
async function checkOutOfRangeDimensionInBrowser({ groupNumber, positionId, orgIdent, userIdent, lang, page }) {
  if (!orgIdent || !userIdent) return [];

  const assertions = require('./assertions');
  const excelTruthTable = require('./excelTruthTable');

  let settled;
  try {
    settled = await readSettledConfiguration(page);
  } catch (_err) {
    return [];
  }
  if (!settled || !settled.values) return [];

  let grid;
  try {
    grid = await excelTruthTable.getDimensionGrid({
      groupNumber, lang, orgIdent, userIdent, paramName: 'CENA',
      values: settled.values, scriptsField: settled.scripts.CENA
    });
  } catch (_err) {
    return [];
  }
  if (!grid.ok || !grid.widthsCm.length) return [];

  const findings = [];

  // Both axes, because a group can validate one and not the other. Each probe
  // is comfortably past the last bucket so it cannot land inside a neighbouring
  // section's range by accident, and the height probe reloads the position
  // first — the width probe left the form holding an invalid value.
  const axes = [{ field: 'SZEROKOSC', maxCm: grid.widthsCm[grid.widthsCm.length - 1] }];
  if (grid.heightsCm.length) {
    axes.push({ field: 'WYSOKOSC', maxCm: grid.heightsCm[grid.heightsCm.length - 1] });
  }

  for (let i = 0; i < axes.length; i++) {
    const { field, maxCm } = axes[i];
    if (i > 0) {
      const reopened = await openPositionInBrowser(page, positionId);
      if (!reopened.hasForm) break;
    }

    const valueMm = (maxCm + 100) * 10;
    const probe = await probeDimension(page, field, valueMm);
    if (!probe.ok) continue;

    findings.push(...assertions.checkFormAcceptsOutOfRangeDimension({
      groupNumber,
      positionId,
      fieldName: field,
      valueMm,
      maxInPriceListCm: maxCm,
      rejected: probe.rejected,
      price: probe.cena
    }));
  }

  return findings;
}

/**
 * Price the configuration the browser settled on against the authoring
 * workbook, and report any difference the same way the headless pass does.
 *
 * Only the params the price list actually defines are checked; a group that
 * does not price one in its workbook is configuration, not a defect, and is
 * skipped silently (`kind: 'no-sheet'`).
 */
async function checkBrowserPriceAgainstPriceList({ groupNumber, positionId, orgIdent, userIdent, lang, page }) {
  if (!orgIdent || !userIdent) return [];

  const assertions = require('./assertions');
  const excelTruthTable = require('./excelTruthTable');
  const { runDeployedScript } = require('./deployedScript');

  let settled;
  try {
    settled = await readSettledConfiguration(page);
  } catch (err) {
    log(`browserRunner: nie udało się odczytać wartości formularza dla pozycji #${positionId}: ${err.message}`);
    return [];
  }
  if (!settled || !settled.values) return [];

  const findings = [];
  try {
    for (const paramName of PRICE_PARAMS_TO_VERIFY) {
      const onScreen = settled.values[paramName];
      if (onScreen === undefined || onScreen === '') continue;

      let reference;
      try {
        reference = await excelTruthTable.getReferencePrice({
          groupNumber, lang, orgIdent, userIdent, paramName,
          values: settled.values,
          scriptsField: settled.scripts[paramName]
        });
      } catch (err) {
        reference = { found: false, reason: `błąd odczytu cennika: ${err.message}` };
      }
      if (reference.kind === 'no-sheet') continue;

      // Cross-check the deployed script on the SAME browser-settled values: if
      // it agrees with the browser, any workbook difference is a price-list
      // drift; if it does not, the form fed the script something else and that
      // is worth knowing on its own.
      const deployed = runDeployedScript({
        groupNumber, lang, orgIdent, userIdent, paramName,
        scriptsField: settled.scripts[paramName],
        values: settled.values
      });
      if (deployed.ok) {
        findings.push(...assertions.checkEngineMatchesDeployedScript({
          groupNumber, positionId, paramName, enginePrice: onScreen, scriptPrice: deployed.value, scriptFile: deployed.file
        }).map((f) => Object.assign(f, {
          source: 'browser',
          message: f.message.replace('bezgłowe przeliczenie', 'cena na ekranie')
        })));
      }

      // The screen includes the per-customer surcharge the script applied and
      // the workbook cannot express it — measured on group 71 #7262: workbook
      // 304, screen 317.68, the script's own label saying `*1.045`. Without
      // this every order from such a client read as overpriced by that factor,
      // one HIGH per position.
      findings.push(...assertions.checkAgainstReferencePrice({
        groupNumber, positionId, paramName, actualPrice: onScreen, source: 'przeglądarka',
        referenceFactor: deployed.ok ? deployed.factor : 1,
        reference
      }).map((f) => Object.assign(f, { source: 'browser' })));
    }
  } finally {
    // The parent process runs this pass for every group in turn, so the parsed
    // workbook (and the 5-6 MB compiled price script) must not accumulate here
    // the way they did in the group children.
    excelTruthTable.clearSheetCache();
    require('./deployedScript').clearScriptCache();
  }

  return findings;
}

/**
 * @param {object} opts
 * @param {{groupNumber:string, positionId:number, orgIdent:string, userIdent:string, lang:string}[]} opts.positions
 * @param {string} opts.screenshotDir  where evidence PNGs are written
 * @returns {Promise<{findings:Array, checked:number, skipped:string|null}>}
 */
async function runBrowserChecks({ positions, screenshotDir }) {
  if (!positions || !positions.length) {
    return { findings: [], checked: 0, skipped: 'brak pozycji, które można otworzyć w przeglądarce' };
  }
  const findings = [];
  let checked = 0;

  fs.mkdirSync(screenshotDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (err) {
    return { findings, checked, skipped: `nie udało się uruchomić Chromium: ${err.message}` };
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(CALC_TIMEOUT_MS);

  const shoot = async (groupNumber, kind) => {
    const file = `${safeName(groupNumber)}_${kind}_${Date.now()}.png`;
    try {
      await page.screenshot({ path: path.join(screenshotDir, file), fullPage: true });
      return `screenshots/${file}`;
    } catch (_err) {
      return null;
    }
  };

  try {
    const auth = await login(page);
    if (!auth.ok) {
      return { findings, checked, skipped: auth.reason };
    }

    for (const { groupNumber, positionId, orgIdent, userIdent, lang = 'pl' } of positions) {
      try {
        const opened = await openPositionInBrowser(page, positionId);

        if (!opened.hasForm) {
          findings.push(finding({
            code: 'PRZEGLADARKA_FORMULARZ_SIE_NIE_ZBUDOWAL',
            groupNumber,
            positionId,
            expected: 'wyrenderowany formularz konfiguracji',
            actual: page.url(),
            message: `Grupa ${groupNumber}, pozycja #${positionId} (przeglądarka): formularz konfiguracji w ogóle się nie zbudował.`,
            screenshot: await shoot(`${groupNumber}_${positionId}`, 'brak-formularza')
          }));
          continue;
        }

        if (!opened.settled) {
          findings.push(finding({
            code: 'PRZEGLADARKA_PRZELICZANIE_NIE_KONCZY_SIE',
            priority: 'HIGH',
            groupNumber,
            positionId,
            message: `Grupa ${groupNumber}, pozycja #${positionId} (przeglądarka): przeliczanie nie zakończyło się w ${CALC_TIMEOUT_MS / 1000}s.`,
            screenshot: await shoot(`${groupNumber}_${positionId}`, 'timeout')
          }));
          continue;
        }

        const blocked = await inspectFields(page);
        if (blocked.length) {
          findings.push(finding({
            code: 'KONFIGURATOR_NIE_PUSZCZA_DALEJ',
            groupNumber,
            positionId,
            expected: blocked.map((b) => `${b.field}: co najmniej jedna opcja`),
            actual: blocked.map((b) => `${b.field}: ${b.reason}`),
            message: `Grupa ${groupNumber}, pozycja #${positionId} (przeglądarka): ${blocked.map((b) => `${b.field} — ${b.reason}`).join('; ')}.`,
            screenshot: await shoot(`${groupNumber}_${positionId}`, 'brak-opcji')
          }));
          continue;
        }

        const state = await readOnScreenState(page);
        const visiblePrices = Object.entries(state.prices);
        const anyPrice = visiblePrices.some(([, value]) => {
          const num = parseFloat(String(value).replace(',', '.'));
          return Number.isFinite(num) && num > 0;
        });

        if (visiblePrices.length && !anyPrice) {
          findings.push(finding({
            code: 'BRAK_CENY',
            groupNumber,
            positionId,
            expected: 'cena > 0 widoczna na ekranie',
            actual: state.prices,
            message: `Grupa ${groupNumber}, pozycja #${positionId} (przeglądarka): żadne widoczne pole cenowe nie pokazuje wartości > 0 (${visiblePrices.map(([k, v]) => `${k}="${v}"`).join(', ')}).`,
            screenshot: await shoot(`${groupNumber}_${positionId}`, 'brak-ceny')
          }));
        }

        // The end-to-end price check: the price list versus what the customer
        // is actually quoted, at the coordinates the customer's own form
        // settled on. Failures here are real money, unlike the headless
        // engine's (see readSettledConfiguration).
        findings.push(...await checkBrowserPriceAgainstPriceList({
          groupNumber, positionId, orgIdent, userIdent, lang, page
        }));

        // Last for this position, because typing into the form changes the
        // page: everything read above has to happen on the untouched state.
        findings.push(...await checkOutOfRangeDimensionInBrowser({
          groupNumber, positionId, orgIdent, userIdent, lang, page
        }));

        if (state.saveVisible && state.saveDisabled) {
          findings.push(finding({
            code: 'BLOKADA_ZAPISU',
            groupNumber,
            positionId,
            expected: 'przycisk zapisu aktywny',
            actual: 'przycisk zapisu nieaktywny',
            message: `Grupa ${groupNumber}, pozycja #${positionId} (przeglądarka): przycisk zapisu jest nieaktywny${state.invalidFields.length ? ` (pola oznaczone jako błędne: ${state.invalidFields.join(', ')})` : ''}.`,
            screenshot: await shoot(`${groupNumber}_${positionId}`, 'blokada-zapisu')
          }));
        }

        checked += 1;
      } catch (err) {
        findings.push(finding({
          code: 'BLAD_TESTU_PRZEGLADARKOWEGO',
          priority: 'MEDIUM',
          groupNumber,
          positionId,
          actual: page.url(),
          message: `Grupa ${groupNumber}, pozycja #${positionId}: test w przeglądarce przerwany — ${err.message.split('\n')[0]} (adres: ${page.url()})`,
          screenshot: await shoot(`${groupNumber}_${positionId}`, 'blad')
        }));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log(`ConfiguratorTester (przeglądarka): sprawdzono ${checked}/${positions.length} pozycji, zgłoszeń: ${findings.length}`);
  return { findings, checked, skipped: null };
}

module.exports = { runBrowserChecks, APP_URL };
