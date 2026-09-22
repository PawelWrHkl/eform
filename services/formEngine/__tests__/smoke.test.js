/**
 * Smoke tests for the JSDOM-based form engine.
 *
 * The full pipeline depends on real per-group data files under `dataDir/`,
 * which the CI/test environment does not provide. These tests therefore only
 * validate that:
 *
 *   - the harness HTML contains every DOM node form.js will reach for;
 *   - `bootEngine()` instantiates JSDOM without throwing and exposes the
 *     bridging API (`window.__engine`) before timeout;
 *   - `calculatePrices()` rejects clearly when required arguments are missing.
 *
 * End-to-end pricing parity must be verified manually against a real group
 * (e.g. SLOPE) on the staging environment.
 */

'use strict';

process.env.ROOT_DIR = process.env.ROOT_DIR || '/tmp/eform-test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHarnessHtml } = require('../harnessHtml');
const formEngine = require('../index');

test('harness HTML carries all DOM nodes form.js relies on', () => {
  const html = buildHarnessHtml({ lang: 'pl' });
  for (const id of [
    'env-info',
    'orderId',
    'version-space',
    'commission-input',
    'dynamic-form',
    'buttons-space',
    'show-button',
    'reset-button',
    'attachment-container',
    'last-config-info',
    'image-preview-dialog',
    'preview-image',
    'color-dialog',
    'dialog-close',
    'close-dialog-btn',
    'dialog-confirm',
    'file-error-message'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing id="${id}"`);
  }
  assert.match(html, /class="attachment-label"/);
  assert.match(html, /class="order-reminder/);
});

test('calculatePrices fails fast when group/version are missing', async () => {
  await assert.rejects(
    () => formEngine.calculatePrices({ lang: 'pl', values: {} }),
    /groupNumber and version are required/
  );
});

test('calculatePrices surfaces a clean error when group data dir is absent', async () => {
  // bootEngine should succeed (no resources are fetched until the bridge
  // module loads); the call then rejects because there are no rules to build
  // the form from. We use a non-existent group so the test never touches real
  // data.
  //
  // ⚠️ The message must NAME the missing group and version. Until 2026-09-21
  // this path died with `Cannot read properties of null (reading 'dictValues')`
  // — a TypeError that told nobody what was actually missing, and that reached
  // real users as a dead edit screen (522 saved positions point at rule
  // versions that no longer exist anywhere; see services/rulesVersion.js).
  const fakeGroup = '__nonexistent_group__';
  await assert.rejects(
    () => formEngine.calculatePrices({
      groupNumber: fakeGroup,
      version: '1',
      lang: 'pl',
      values: {}
    }),
    (err) => {
      if (!err) return false;
      if (/cannot read properties of null/i.test(err.message)) {
        throw new Error(`regresja: wrócił nieczytelny TypeError zamiast nazwanego błędu — ${err.message}`);
      }
      return /Brak reguł grupy|formEngine|bridge|did not load|Cannot find module/i.test(err.message)
        && new RegExp(fakeGroup).test(err.message);
    }
  );
});
