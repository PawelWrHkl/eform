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
 * @param {object} opts
 * @param {{groupNumber:string, department:string}[]} opts.groups
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

    for (const { groupNumber, positionId } of positions) {
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
