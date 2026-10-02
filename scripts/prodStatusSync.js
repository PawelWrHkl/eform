#!/usr/bin/env node
/**
 * Jednorazowy cykl tła: synchronizacja statusów produkcji WSZYSTKICH klientów
 * (`status.txt` → `position_statuses` + `order.prod_status`) i automatyczne
 * faktury za zamówienia wysłane do klienta.
 *
 * Kto to uruchamia:
 *   - domyślnie `server.js` — co `PROD_STATUS_SYNC_INTERVAL_MIN` minut jako
 *     osobny proces (`services/prodStatusScheduler.js`), więc działa także
 *     w kontenerze bez żadnej dodatkowej konfiguracji,
 *   - przy `PROD_STATUS_SYNC_MODE=external` — cron/systemd, np.
 *     `0 * * * * cd /ścieżka/eform && node scripts/prodStatusSync.js`.
 *
 * Ręcznie:
 *   npm run prodstatus:run                       jeden cykl
 *   npm run prodstatus:dry                       nic nie zapisuje: różnice + lista faktur do wystawienia
 *   node scripts/prodStatusSync.js --full        przelicz nagłówki wszystkich zamówień z pliku
 *   node scripts/prodStatusSync.js --no-invoices sama synchronizacja statusów
 *
 * Kody wyjścia: 0 — OK (także „inny proces trzyma blokadę"), 1 — część zapisów
 * albo faktur się nie udała, 2 — cykl padł.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runProdStatusCycle } = require('../services/prodStatusCycle');
const { closePool } = require('../db/core');
const { log } = require('../utils/logging');

const args = new Set(process.argv.slice(2));

(async () => {
    let code = 0;
    try {
        const result = await runProdStatusCycle({
            dryRun: args.has('--dry-run'),
            full: args.has('--full'),
            invoices: !args.has('--no-invoices')
        });
        const statusFailures = result.statuses?.failed || 0;
        const invoiceFailures = result.autoInvoices?.failed?.length || 0;
        if (statusFailures || invoiceFailures) code = 1;
    } catch (err) {
        log(`[prodStatus] cykl przerwany: ${err && err.stack ? err.stack : err}`);
        code = 2;
    }

    // Bez `process.exit()` od razu: logger dopisuje do pliku asynchronicznie
    // i twarde wyjście ucinałoby ostatnie linie. Zamknięta pula pozwala
    // procesowi skończyć się samemu; timer to tylko bezpiecznik na wypadek
    // uchwytu, który trzymałby pętlę zdarzeń (unref — sam jej nie trzyma).
    process.exitCode = code;
    try { await closePool(); } catch { /* pula mogła już być zamknięta */ }
    setTimeout(() => process.exit(code), 15000).unref();
})();
