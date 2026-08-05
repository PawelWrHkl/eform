#!/usr/bin/env node
/**
 * Repair zero prices on already-imported orders (standalone process).
 *
 * Re-seeds the price-group descriptions from translation_dictionary /
 * client_aliases, re-applies param.txt visibility, then recalculates the order in
 * a real headless browser — the same flow the import runs. See
 * services/orderImport/zeroPriceRepair.js.
 *
 * Usage:
 *   node scripts/repairOrderPrices.js 2908 [2909 …]
 *   node scripts/repairOrderPrices.js 2908 --dry-run   # only re-seed params, no recalc
 *
 * Exit codes: 0 all repaired / nothing to fix, 1 some position still prices 0,
 * 2 crash.
 */
process.env.ORDER_IMPORT_STANDALONE = '1';
require('dotenv').config();

const { repairZeroPriceOrder } = require('../services/orderImport/zeroPriceRepair');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const orderIds = args.filter((a) => /^\d+$/.test(a)).map(Number);

(async () => {
  if (!orderIds.length) {
    console.error('Użycie: node scripts/repairOrderPrices.js <orderId> [orderId…] [--dry-run]');
    process.exit(2);
  }

  let stillZero = 0;
  for (const orderId of orderIds) {
    const result = await repairZeroPriceOrder(orderId, { recalculate: !dryRun });
    const zeroBefore = result.zeroBefore.map((p) => `#${p}`).join(', ') || '(brak)';
    console.log(`order ${orderId}: pozycje z ceną 0 przed: ${zeroBefore}`);
    if (result.seeded.length) console.log(`   uzupełnione opisy: ${result.seeded.join(', ')}`);
    if (result.cleared.length) console.log(`   wyczyszczone wyłączone pola: ${result.cleared.join(', ')}`);
    if (result.recalc) console.log(`   recalc: ${result.recalc.success ? 'OK' : 'FAIL'} — ${result.recalc.message}`);
    console.log(`   → ${result.message}`);
    if (result.zeroAfter.length) stillZero++;
  }

  process.exit(stillZero === 0 ? 0 : 1);
})().catch((err) => {
  console.error('repairOrderPrices crashed:', err);
  process.exit(2);
});
