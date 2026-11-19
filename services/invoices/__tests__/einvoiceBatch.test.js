'use strict';

/**
 * Skrypt „równoległych faktur” (`scripts/einvoiceShadowBatch.js`, kontrakt pkt 8):
 * strażnik tylko-do-odczytu i opcje. Sam przebieg wymaga bazy — sprawdzany ręcznie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readOnlyRepository, parseArgs } = require('../../../scripts/einvoiceShadowBatch');

test('strażnik: odczyty przechodzą, każdy zapis kończy się błędem', async () => {
  const calls = [];
  const repo = readOnlyRepository({
    getInvoice: async (id) => { calls.push(id); return { id }; },
    findManualOverlay: async () => null,
    createInvoice: async () => { throw new Error('nie powinno dojść do bazy'); },
    addInvoiceEvent: async () => {},
    updateStatus: async () => {},
    allocateIssuerSequence: async () => {}
  });
  assert.deepEqual(await repo.getInvoice(5), { id: 5 });
  assert.equal(await repo.findManualOverlay(), null);
  for (const name of ['createInvoice', 'addInvoiceEvent', 'updateStatus', 'allocateIssuerSequence']) {
    assert.throws(() => repo[name]({}), /zapis zablokowany/, name);
  }
  assert.deepEqual(calls, [5]);
});

test('opcje: wymagany okres i efor_env; domyślnie Luxan GmbH, podgląd, katalog poza repo', () => {
  const args = parseArgs(['--from', '2026-11-01', '--to', '2026-11-17', '--env', 'prod', '--expect-host', 'abc']);
  assert.equal(args.org, 'LUXANGMBH');
  assert.equal(args.send, false);
  assert.equal(args.expectHost, 'abc');
  assert.equal(args.limit, 500);
  assert.ok(!args.out.startsWith(process.cwd()), 'pliki nie lądują w drzewie repo (auto-commit)');
  assert.throws(() => parseArgs(['--from', '2026-11-01', '--to', '2026-11-17']), /--env/);
  assert.throws(() => parseArgs(['--to', '2026-11-17', '--env', 'prod']), /--from/);
  assert.throws(() => parseArgs(['--from', '2026-11-01', '--to', '2026-11-17', '--env', 'prod', '--force']), /nieznana opcja/);
});
