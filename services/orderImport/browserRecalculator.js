/**
 * Browser-based order recalculator using Playwright.
 *
 * After import, this module opens each of the order's positions in a headless
 * browser through the admin single-position edit page (`/position/:id/admin-redit/`)
 * and saves it — the exact same flow `admin_edit_form.js` runs. This is the
 * flow that's actually been fixed/verified (correct owner context, correct
 * price-collection resolution, correct "hasZero" placeholder handling); the
 * order-level "Przelicz wszystkie pozycje" flow (`recalculateOrder.js`) is a
 * separate, less battle-tested reimplementation and is no longer used here.
 *
 * Uses the same Playwright installation as pdfGenerator.
 */

'use strict';

const { chromium } = require('playwright');
const { log } = require('../../utils/logging');
const { connetToDb } = require('../../db/core');

// Always-on app instance for headless recalc — not live dev PORT (8000).
const APP_URL = process.env.RECALC_APP_URL
  || `http://localhost:${process.env.RECALC_APP_PORT || 8081}`;

/**
 * Get the owner (user) credentials for an order.
 * Returns { pin, password } or null.
 */
async function getOrderOwnerCredentials(orderId) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(`
      SELECT u.pin, u.password, u.ident
      FROM \`order\` o
      JOIN user u ON u.id = o.user_id
      WHERE o.id = ?
    `, [orderId]);
    return rows.length > 0 ? rows[0] : null;
  } finally {
    await conn.end();
  }
}

/** Position ids for an order, in display order — same ordering as the order page. */
async function getOrderPositionIds(orderId) {
  const conn = await connetToDb();
  try {
    const [rows] = await conn.query(
      'SELECT id FROM order_item WHERE order_id = ? ORDER BY orderpos ASC, id ASC',
      [orderId]
    );
    return rows.map((r) => r.id);
  } finally {
    await conn.end();
  }
}

/**
 * Recalculate an order using a real browser (Playwright headless), retrying
 * the browser step itself a few times on failure/flakiness.
 *
 * By the time this runs the order is already committed to the DB (the browser
 * needs to be able to load it), so a failure here can't be recovered by
 * retrying the whole import — that would insert a duplicate order. Instead we
 * retry only this recalculation step; if it still fails after all attempts,
 * the order is left with whatever (possibly zero/approximate) prices the
 * JSDOM engine computed at insert time, and the caller is expected to flag it
 * for manual recalculation from the panel.
 *
 * @param {number} orderId - The order ID to recalculate
 * @param {object} [opts] - Options
 * @param {number} [opts.timeout] - Max time in ms per attempt (default 120000)
 * @param {number} [opts.attempts] - Total attempts (default 3)
 * @param {number} [opts.retryDelayMs] - Delay between attempts (default 5000)
 * @returns {Promise<{success: boolean, message: string, attempts: number}>}
 */
async function recalculateOrderInBrowser(orderId, opts = {}) {
  const attempts = opts.attempts || 3;
  const retryDelayMs = opts.retryDelayMs || 5000;

  let lastResult = { success: false, message: 'Nie podjęto próby przeliczania' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = await recalculateOrderInBrowserOnce(orderId, opts);
    if (lastResult.success) {
      return { ...lastResult, attempts: attempt };
    }
    log(`browserRecalculator: attempt ${attempt}/${attempts} failed for order ${orderId}: ${lastResult.message}`);
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return { ...lastResult, attempts };
}

/**
 * Open one position's admin single-edit page and save it — mirrors exactly
 * what an admin does by hand: navigate to /position/:id/admin-redit/, let
 * admin_edit_form.js's init() (generateForm + forceRecalculation) finish, then
 * click the save button (which itself re-recalculates before submitting via
 * PATCH /position/edit/save).
 */
async function recalculatePositionViaAdminEdit(page, positionId, timeout) {
  await page.goto(`${APP_URL}/position/${positionId}/admin-redit/`);
  await page.waitForLoadState('networkidle');

  // admin_edit_form.js's save button early-returns (no-op) while
  // window.isCalculating is true, so we must wait for the initial
  // forceRecalculation to fully settle before clicking, or the click would
  // silently do nothing and we'd wait forever for a PATCH that never fires.
  await page.waitForFunction(
    () => window.finishFlag === true && window.isCalculating !== true,
    { timeout }
  );

  const saveResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/position/edit/save') && resp.request().method() === 'PATCH',
    { timeout }
  );

  await page.click('#show-button');

  const response = await saveResponsePromise;
  const ok = response.ok();
  const data = await response.json().catch(() => ({}));
  return {
    success: ok,
    message: data.message || data.error || (ok ? 'OK' : `HTTP ${response.status()}`)
  };
}

async function recalculateOrderInBrowserOnce(orderId, opts = {}) {
  const timeout = opts.timeout || 120000;
  let browser;

  try {
    // Get the order owner's credentials for context
    const creds = await getOrderOwnerCredentials(orderId);
    if (!creds) {
      return { success: false, message: 'Nie znaleziono właściciela zamówienia' };
    }

    const positionIds = await getOrderPositionIds(orderId);
    if (positionIds.length === 0) {
      return { success: false, message: 'Zamówienie nie ma pozycji' };
    }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // Login as admin (admin-redit requires req.session.user.isAdmin)
    const adminPin = process.env.ADMIN_PIN || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'eforszef123';
    const loginUrl = `${APP_URL}/user/auth/login?pin=${encodeURIComponent(adminPin)}&password=${encodeURIComponent(adminPassword)}`;
    await page.goto(loginUrl);
    await page.waitForURL('**/');

    // The admin-redit route itself sets the order-owner context
    // (ownerService.setContextUserByIdent) before rendering, so there's no
    // separate "set context user" navigation step needed here.

    const failures = [];
    for (const positionId of positionIds) {
      try {
        const result = await recalculatePositionViaAdminEdit(page, positionId, timeout);
        log(`browserRecalculator: position ${positionId} (order ${orderId}) → ${result.success ? 'OK' : 'FAIL'}: ${result.message}`);
        if (!result.success) {
          failures.push(`#${positionId}: ${result.message}`);
        }
      } catch (posErr) {
        log(`browserRecalculator: error recalculating position ${positionId} (order ${orderId}): ${posErr.message}`);
        failures.push(`#${positionId}: ${posErr.message}`);
      }
    }

    if (failures.length > 0) {
      return {
        success: false,
        message: `${failures.length}/${positionIds.length} pozycji nie przeliczono: ${failures.join('; ')}`
      };
    }

    return { success: true, message: `Przeliczono ${positionIds.length} pozycji` };
  } catch (err) {
    log(`browserRecalculator: error for order ${orderId}: ${err.message}`);
    return { success: false, message: err.message };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { recalculateOrderInBrowser };
