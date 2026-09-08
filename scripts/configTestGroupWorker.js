#!/usr/bin/env node
/**
 * Runs ONE group's test suite and prints the result as JSON.
 *
 * Exists for memory, measured on this host: a single group peaks around
 * 1.5 GB RSS (JSDOM + a parsed price workbook), while the machine has ~0.5 GB
 * free and a half-used swap. Node reclaims that lazily inside one process, so
 * a 15-group sweep in a single process sat near its heap ceiling the whole way
 * and the first attempt died with "heap limit Allocation failed". One child per
 * group hands the memory back to the OS at exit — and a group that crashes or
 * hangs no longer takes the whole run with it.
 *
 * Not meant to be called by hand; services/configuratorTester/index.js forks it.
 */
require('dotenv').config();

const { runGroupSuite } = require('../services/configuratorTester/caseGenerator');
const { RESULT_MARKER } = require('../services/configuratorTester/groupProcess');

// Only when executed directly. Without this guard a plain `require` of this
// file ran the whole worker (and exited the requiring process).
if (require.main !== module) {
  module.exports = { RESULT_MARKER };
  return;
}

(async () => {
  const groupNumber = process.argv[2];
  const opts = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  if (!groupNumber) {
    process.stderr.write('configTestGroupWorker: brak numeru grupy\n');
    process.exit(2);
  }

  try {
    const result = await runGroupSuite(groupNumber, opts);
    process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`configTestGroupWorker(${groupNumber}): ${err.stack || err.message}\n`);
    process.exit(1);
  }
})();
