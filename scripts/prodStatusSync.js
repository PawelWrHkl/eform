#!/usr/bin/env node
/**
 * Jednorazowy cykl tła: synchronizacja statusów produkcji WSZYSTKICH klientów
 * (`status.txt` → `position_statuses` + `order.prod_status`), automatyczne
 * faktury za zamówienia wysłane do klienta, maile z tymi fakturami
 * (`services/invoices/invoiceMailer.js`, sterowane `INVOICE_MAIL_*` w `.env`)
 * i ich PDF-y na FTP (`services/invoices/invoiceFtpExport.js`, `INVOICE_FTP_*`).
 *
 * Kto to uruchamia:
 *   - przy `PROD_STATUS_SYNC_MODE=external` — cron, niezależnie od serwera. Tak
 *     jest od 2026-10-22 na hoście :8000 (crontab użytkownika pawel) i na produkcji
 *     (`/etc/cron.d/eform-prodstatus`, `docker exec` w kontenerze `eform`): co
 *     godzinę o :05, o 00:05 z `--full`, pod `timeout 30m` — przy cronie
 *     zawieszonego przebiegu nie przerwie harmonogram serwera. Wpisy:
 *     `services/invoices/README.md`,
 *   - domyślnie (`child`) `server.js` — co `PROD_STATUS_SYNC_INTERVAL_MIN` minut
 *     jako osobny proces (`services/prodStatusScheduler.js`), więc działa także
 *     w kontenerze bez żadnej dodatkowej konfiguracji.
 * Przebieg zlecony przez serwer, który wstał jeszcze przed przełączeniem `.env`
 * na `external`/`off`, kończy się od razu (`modeBlockingServerRun`) — zmiana
 * trybu działa bez restartu serwera.
 *
 * Ręcznie:
 *   npm run prodstatus:run                       jeden cykl
 *   npm run prodstatus:dry                       nic nie zapisuje: różnice + lista faktur do wystawienia
 *   node scripts/prodStatusSync.js --full        przelicz nagłówki wszystkich zamówień z pliku
 *   node scripts/prodStatusSync.js --no-invoices sama synchronizacja statusów (bez faktur i maili)
 *   node scripts/prodStatusSync.js --no-mail     statusy + faktury, bez maili z fakturami
 *   node scripts/prodStatusSync.js --no-ftp      bez wysyłki PDF-ów faktur na FTP
 *
 * Kody wyjścia: 0 — OK (także „inny proces trzyma blokadę" i faktury pominięte
 * z powodu zerowej wartości — nic do zafakturowania), 1 — część zapisów,
 * faktur, maili z fakturami albo plików na FTP się nie udała, 2 — cykl padł.
 */

const path = require('path');
// Te same pliki i ta sama kolejność co w `server.js` (`.env.local` wygrywa):
// uruchomiony z crona skrypt nie dziedziczy już środowiska po serwerze.
require('dotenv').config({ path: [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '..', '.env')] });

const { runProdStatusCycle } = require('../services/prodStatusCycle');
const { modeBlockingServerRun } = require('../services/prodStatusScheduler');
const { closePool } = require('../db/core');
const { log } = require('../utils/logging');

const args = new Set(process.argv.slice(2));

(async () => {
    // Bez zapytań do bazy pula nie ma połączeń, więc proces kończy się sam
    const blockedBy = modeBlockingServerRun();
    if (blockedBy) {
        log(`[prodStatus] PROD_STATUS_SYNC_MODE=${blockedBy} — przebieg zlecony przez serwer pominięty (serwer wstał przed zmianą .env; po restarcie przestanie go zlecać)`);
        return;
    }

    let code = 0;
    try {
        const result = await runProdStatusCycle({
            dryRun: args.has('--dry-run'),
            full: args.has('--full'),
            invoices: !args.has('--no-invoices'),
            mail: !args.has('--no-mail'),
            ftp: !args.has('--no-ftp')
        });
        const statusFailures = result.statuses?.failed || 0;
        const invoiceFailures = result.autoInvoices?.failed?.length || 0;
        const mailFailures = result.invoiceMails?.failed?.length || 0;
        const ftpFailures = result.invoiceFtp?.failed?.length || 0;
        if (statusFailures || invoiceFailures || mailFailures || ftpFailures) code = 1;
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
