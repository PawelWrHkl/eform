'use strict';

/** Lista wersji faktur (`changes.js`, strona admina `/invoices/changes`) musi być spójna. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { INVOICE_VERSIONS, CURRENT_INVOICE_VERSION } = require('../changes');

test('wersje faktur: najnowsza pierwsza, kolejne numery bez dziur, opis i środowisko przy każdej', () => {
  assert.equal(CURRENT_INVOICE_VERSION, INVOICE_VERSIONS[0].version);
  INVOICE_VERSIONS.forEach((v, i) => {
    assert.equal(v.version, INVOICE_VERSIONS.length - 1 - i, `numer wersji na pozycji ${i}`);
    assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['produkcja', 'test'].includes(v.env), `env wersji ${v.version}`);
    assert.ok(v.title && v.changes.length > 0, `opis wersji ${v.version}`);
    if (i > 0) assert.ok(v.date <= INVOICE_VERSIONS[i - 1].date, `data wersji ${v.version} nie późniejsza od następnej`);
  });
});
