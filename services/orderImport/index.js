/**
 * Top-level entry point for the FTP order import pipeline.
 *
 *   runImport()  →  for every *.json on the FTP:
 *                     1. download to `<localImportDir>/incoming/`
 *                     2. parse + validate
 *                     3. resolve user (DB), back-fill missing fields
 *                     4. translate parameters to canonical keys
 *                     5. insert the order + items inside a single DB
 *                        transaction (rolled back on any failure)
 *                     6. move local + remote file to processed/error
 *
 * Returns a per-file summary array so the CLI / cron can report progress.
 *
 * The function is fully self-contained — no Express/HTTP layer, so it can be
 * scheduled, tested, or invoked manually with the same code path.
 */

const fs = require('fs').promises;
const path = require('path');

const ftp = require('./ftpClient');
const cache = require('./localCache');
const { validateOrderPayload } = require('./orderValidator');
const { tryRecoverValidOrderPayload } = require('./payloadRecovery');
const { resolveOrderUser } = require('./userResolver');
const { importResolvedOrder } = require('./orderImporter');
const { resolvePayloadAliases } = require('./aliasResolver');
const importLogger = require('./importLogger');
const { makeTransactionalDeps } = require('./transactionalDb');
const { connetToDb } = require('../../db/core');
const { log } = require('../../utils/logging');
const { sendImportSummary } = require('../mailBot/importMailer');

const MAX_FILE_ATTEMPTS = 3;

function formatError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.errno) parts.push(`errno=${err.errno}`);
  if (err.sqlState) parts.push(`sqlState=${err.sqlState}`);
  if (err.stack) parts.push(`\n${err.stack}`);
  return parts.length ? parts.join(' ') : String(err);
}

function isTransientError(err) {
  const code = err && err.code;
  return [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'PROTOCOL_CONNECTION_LOST',
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT'
  ].includes(code) || /connect ETIMEDOUT/i.test(err && err.message ? err.message : '');
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
  // Some exporters double-encode the whole order as a JSON string.
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      throw new Error(`Invalid JSON (double-encoded): ${err.message}`);
    }
  }
  return parsed;
}

async function processOneFile(fileName) {
  const result = {
    file: fileName,
    ok: false,
    orderId: null,
    sent: false,
    sendError: null,
    warnings: [],
    error: null
  };

  const paths = cache.paths();
  let localPath;
  // Captured as soon as the payload is parsed so it survives into the error
  // branch below — otherwise a failed import logs userIdent=null.
  let userIdent = null;

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_FILE_ATTEMPTS; attempt++) {
    let conn;
    try {
      localPath = cache.incomingPathFor(fileName);

      // 1. Download (or keep from local fallback) into the incoming dir — this
      // doubles as the local backup required for audit ("kopia na serwerze").
      await ftp.downloadOrderFile(fileName, localPath, { localFallbackDir: paths.incoming });

      const parsed = await readJson(localPath);
      const recovery = await tryRecoverValidOrderPayload(fileName, parsed, {
        localProcessedDir: paths.processed
      });
      const payload = recovery.payload;
      if (recovery.recovered) {
        log(`WARN: ${fileName} on FTP is not a valid order JSON (looks like json_parameters_desc). `
          + `Recovered last good order payload from ${recovery.source}`);
      }
      if (payload && payload.userIdent) userIdent = payload.userIdent;

      const validation = validateOrderPayload(payload);
      if (!validation.ok) {
        throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
      }

      // Resolve client aliases in item parameters before user resolution
      const { items: resolvedItems, errors: aliasErrors } = await resolvePayloadAliases(validation.data.items, validation.data.userIdent);

      if (aliasErrors.length > 0) {
        throw new Error(`Alias resolution failed:\n${aliasErrors.join('\n')}`);
      }

      validation.data.items = resolvedItems;

      const resolved = await resolveOrderUser(validation.data);

      // Single DB transaction so partial inserts don't leave orphan rows.
      conn = await connetToDb();
      await conn.beginTransaction();
      const importResult = await importResolvedOrder({
        payload: resolved.payload,
        user: resolved.user,
        lang: resolved.lang,
        deps: makeTransactionalDeps(conn)
      });
      await conn.commit();
      await conn.end();
      conn = null;

      result.ok = true;
      result.orderId = importResult.orderId;

      // Log import result
      await importLogger.logSuccess({
        fileName,
        orderId: importResult.orderId,
        userIdent: validation.data.userIdent,
        itemsCount: resolvedItems.length
      });

      // Recalculate prices in a real browser (Playwright headless)
      // This runs AFTER commit so the order data is visible to the browser session.
      try {
        const {
          snapshotOrderParameters,
          restoreOrderParametersAfterRecalc
        } = require('./orderImporter');
        const paramSnapshot = await snapshotOrderParameters(importResult.orderId);

        const { recalculateOrderInBrowser } = require('./browserRecalculator');
        // recalculateOrderInBrowser retries internally a few times — the order
        // is already committed by this point, so we can't retry the whole
        // import without risking a duplicate. If every attempt fails, the
        // order keeps whatever (possibly zero/approximate) prices the JSDOM
        // engine computed at insert time and must be recalculated manually.
        const recalcResult = await recalculateOrderInBrowser(importResult.orderId);
        if (recalcResult.success) {
          // Browser recalculate can leave params empty in json_parameters — bring
          // back the imported ones from the pre-recalc snapshot, EXCEPT the fields
          // the form disabled on purpose via param.txt ENABLE (those stay empty;
          // see restoreParametersAfterRecalc).
          const restored = await restoreOrderParametersAfterRecalc(importResult.orderId, paramSnapshot);
          if (restored > 0) {
            log(`Import: restored import params on ${restored} position(s) for order ${importResult.orderId}`);
          }
          const { rebuildDisplayValuesForOrder } = require('./displayValueRebuilder');
          await rebuildDisplayValuesForOrder(importResult.orderId);
          log(`Import+recalculate OK for order ${importResult.orderId} (attempt ${recalcResult.attempts}/3)`);
        } else {
          log(`WARN: import OK but recalculate failed for order ${importResult.orderId} after ${recalcResult.attempts} attempts: ${recalcResult.message}`);
          result.warnings.push(
            `Przeliczanie cen w przeglądarce nie powiodło się po ${recalcResult.attempts} próbach (${recalcResult.message}) — `
            + `zamówienie ma tylko przybliżone ceny, wymaga ręcznego przeliczenia z panelu.`
          );
        }

        // Zero price = the price scripts matched no price-group block, which in
        // practice means `json_parameters` lacks the "#N" tag (or the description
        // key itself). Re-seed those from translation_dictionary/client_aliases and
        // recalculate once more before giving up — see zeroPriceRepair.js.
        try {
          const { selectQuery } = require('../../db/core');
          const zeroRows = await selectQuery(
            `SELECT orderpos, unit_price FROM order_item
             WHERE order_id = ? AND (unit_price IS NULL OR unit_price = 0)
             ORDER BY orderpos`,
            importResult.orderId
          );
          if (zeroRows && zeroRows.length > 0) {
            const positionsList = zeroRows.map((r) => `#${r.orderpos}`).join(', ');
            log(`WARN: order ${importResult.orderId} has ${zeroRows.length} zero-price position(s): ${positionsList}`
              + ' — uruchamiam naprawę opisów i ponowne przeliczenie');

            const { repairZeroPriceOrder } = require('./zeroPriceRepair');
            const repair = await repairZeroPriceOrder(importResult.orderId);
            if (repair.repaired) {
              result.warnings.push(
                `Pozycje ${positionsList} miały cenę 0 — uzupełniono grupy cenowe i przeliczono ponownie (OK).`
              );
            } else {
              // Still zero: a real price-list problem, not missing metadata.
              result.warnings.push(
                `Pozycje z ceną 0 (do sprawdzenia grupy cenowej): ${repair.zeroAfter.map((p) => `#${p}`).join(', ')}`
                + ` — ponowne przeliczenie nie pomogło (${repair.message}).`
              );
            }
          }
        } catch (zeroErr) {
          log(`WARN: zero-price check/repair failed for order ${importResult.orderId}: ${zeroErr.message}`);
          result.warnings.push(`Kontrola cen 0 nie powiodła się: ${zeroErr.message}`);
        }
      } catch (recalcErr) {
        log(`WARN: import OK but recalculate error for order ${importResult.orderId}: ${recalcErr.message}`);
      }

      
//       AUTOMATYCZNA WYSYŁKA PO IMPORTOWANIU ZAMÓWIENIA WYŁĄCZONA, BO CZĘSTO WYSYŁA SIĘ NIEPRAWIDŁOWE DANE (np. z niepoprawnym adresem e-mail klienta) I TRZEBA RĘCZNIE POPRAWIĆ ZAMÓWIENIE PRZED WYSYŁKĄ
//       try {
//         const { sendImportedOrder } = require('./sendAfterImport');
//         const sendResult = await sendImportedOrder({
//           orderId: importResult.orderId,
//           user: resolved.user,
//           lang: resolved.lang
//         });
//         result.sent = !!sendResult.sent;
//         if (sendResult.skipped) {
//           result.sendError = `skipped: ${sendResult.skipped}`;
//           log(`WARN: import OK but send skipped for order ${importResult.orderId}: ${sendResult.skipped}`);
//         } else if (sendResult.error) {
//           result.sendError = sendResult.error;
//           log(`WARN: import OK but send failed for order ${importResult.orderId}: ${sendResult.error}`);
//         }
//       } catch (sendErr) {
//         result.sendError = sendErr.message;
//         log(`WARN: import OK but send error for order ${importResult.orderId}: ${sendErr.message}`);
//       }
// // 


      await cache.moveToProcessed(localPath);
      try {
        await ftp.moveRemoteFile(fileName, 'processed', { localFallbackDir: paths.incoming });
      } catch (err) {
        log(`WARN: import OK but FTP move to processed failed for ${fileName}: ${err.message}`);
      }
      return result;
    } catch (err) {
      lastError = err;
      if (conn) {
        try { await conn.rollback(); } catch (_e) { /* ignore */ }
        try { await conn.end(); } catch (_e) { /* ignore */ }
      }
      if (attempt < MAX_FILE_ATTEMPTS && isTransientError(err)) {
        log(`WARN: transient import error for ${fileName}, retry ${attempt}/${MAX_FILE_ATTEMPTS}: ${err.message}`);
        // Exponential backoff: 1s, 2s, 4s
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      break;
    }
  }

  result.error = lastError && lastError.message ? lastError.message : String(lastError || 'unknown error');
  const errorDetails = formatError(lastError);
  try {
    if (localPath) await cache.moveToError(localPath, errorDetails);
  } catch (_e) { /* file may already be missing */ }
  try {
    await ftp.moveRemoteFile(fileName, 'error', { localFallbackDir: paths.incoming });
  } catch (mvErr) {
    log(`WARN: failed to move FTP file ${fileName} to error/: ${mvErr.message}`);
  }
  log(`Import failed for ${fileName}: ${result.error}`);
  if (lastError && lastError.stack) {
    log(`Import failure details for ${fileName}: ${formatError(lastError)}`);
  }

  // Log error to import_log table
  try {
    await importLogger.logError({
      fileName,
      userIdent,
      errorMessage: result.error,
      errorDetails
    });
  } catch (_logErr) { /* don't let logging failure mask the real error */ }

  return result;
}

async function runImport() {
  await cache.ensureDirs();
  const paths = cache.paths();

  const files = await ftp.listOrderFiles({ localFallbackDir: paths.incoming });
  log(`OrderImport: found ${files.length} file(s)`);

  const results = [];
  for (const fileName of files) {
    // Skip files that have already been moved into incoming/ but came from a
    // crashed previous run — they will be retried below as the listing above
    // also includes them in local-fallback mode. That's intentional.
    // eslint-disable-next-line no-await-in-loop
    results.push(await processOneFile(fileName));
  }

  if (results.length > 0) {
    sendImportSummary(results).catch((err) =>
      log(`ImportMailer: unexpected error: ${err.message}`)
    );
  }

  return results;
}

module.exports = {
  runImport,
  processOneFile,
  // exported for tests
  _internals: { readJson, formatError, isTransientError }
};
