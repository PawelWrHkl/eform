'use strict';

/**
 * Faktura przyjęta przez system zewnętrzny (e-faktura live / KSeF ACCEPTED): bez anulowania
 * (`changeStatus`), a edycja, przebudowa i „Przelicz dzienne ponownie” — w `collective.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { InvoiceService } = require('../main');
const { acceptedLockMessage } = require('../core/statuses');

function repoWith(accepted) {
  const updates = [];
  return {
    updates,
    async getInvoice(id) { return { id, number: '2026/00170', status: 'issued', currency: 'EUR', totalGross: 1000 }; },
    async getEditBlockers() { return { related: 0, allocations: 0, accepted }; },
    async updateStatus(id, patch) { updates.push(patch.status); return true; }
  };
}

test('przyjętej faktury nie da się anulować; zapłatę wolno; nieprzyjętą anulować wolno', async () => {
  const locked = repoWith(1);
  const service = new InvoiceService({ repository: locked, log: () => {} });
  await assert.rejects(service.changeStatus(5, 'cancelled'), (err) => err.message === acceptedLockMessage('2026/00170'));
  await service.changeStatus(5, 'paid');
  assert.deepEqual(locked.updates, ['paid']);

  const free = repoWith(0);
  await new InvoiceService({ repository: free, log: () => {} }).changeStatus(5, 'cancelled');
  assert.deepEqual(free.updates, ['cancelled']);
});
