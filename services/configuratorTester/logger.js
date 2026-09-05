/**
 * Dedicated log file for this module — configtest/configtest.log, same idea
 * as import/import.log for the order-import daemon, but NOT sharing
 * utils/logging.js: that helper's file target is hardcoded to import.log
 * whenever ORDER_IMPORT_STANDALONE=1, and to the shared app-wide daily log
 * otherwise — neither of which is a dedicated log for this module.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', '..', 'configtest', 'configtest.log');

function log(...args) {
  const message = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  // Synchronous on purpose: the CLI ends with process.exit(), which discards
  // pending async writes — the mail-delivery line was silently lost from the
  // log of a full run that way, leaving no record of whether the report was
  // actually sent.
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (_err) { /* log nie może wywrócić przebiegu */ }
}

module.exports = { log, LOG_PATH };
