'use strict';

/**
 * Jeden cykl pracy w tle: statusy produkcji wszystkich klientów → automatyczne
 * faktury za zamówienia, które właśnie dostały `!sent!` → maile z fakturami →
 * PDF-y faktur na FTP.
 *
 * Kolejność ma znaczenie: automat faktur czyta `order.prod_status`, więc musi
 * widzieć statusy po synchronizacji z tego samego cyklu.
 *
 * ⚠️ BLOKADA NA BAZĘ: z jednej bazy korzysta kilka instancji naraz (host :8000
 * i kontenery dev/test dzielą bazę testową), a każda uruchamia ten cykl.
 * Synchronizacja statusów zniosłaby równoległość, ale dwa równoległe przebiegi
 * automatu wystawiłyby dwie faktury za to samo zamówienie. `GET_LOCK` jest
 * zwalniany przez MySQL także wtedy, gdy proces padnie (zamknięte połączenie).
 * Nazwa blokady zawiera nazwę bazy — blokady MySQL są wspólne dla całego
 * serwera, a na jednym serwerze bywa kilka baz.
 */

const { connetToDb } = require('../db/core');
const { syncAllProdStatuses } = require('./prodStatus');
const { log: defaultLog } = require('../utils/logging');

/**
 * @param {string} [database]
 * @returns {string} maks. 64 znaki (limit `GET_LOCK`)
 */
function lockName(database = process.env.DATABASE || 'eform') {
    return `eform:prodstatus:${database}`.slice(0, 64);
}

/**
 * @param {string} name
 * @returns {Promise<{ release: () => Promise<void> }|null>} `null`, gdy blokadę trzyma ktoś inny
 */
async function acquireDbLock(name) {
    const conn = await connetToDb();
    try {
        const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
        if (Number(rows[0] && rows[0].acquired) !== 1) {
            await conn.end();
            return null;
        }
    } catch (err) {
        await conn.end();
        throw err;
    }
    return {
        release: async () => {
            try {
                await conn.query('SELECT RELEASE_LOCK(?)', [name]);
            } finally {
                await conn.end();
            }
        }
    };
}

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]  nic nie zapisuj (statusy: tylko różnice; faktury i maile: tylko lista)
 * @param {boolean} [opts.full=false]    przelicz nagłówki wszystkich zamówień z pliku
 * @param {boolean} [opts.invoices=true] uruchom automat faktur po synchronizacji
 * @param {boolean} [opts.mail=true]     wyślij maile z fakturami automatu (`invoiceMailer.js`); tylko razem z `invoices`
 * @param {boolean} [opts.ftp=true]      wyślij PDF-y faktur automatu na FTP (`invoiceFtpExport.js`); tylko razem z `invoices`
 * @param {Object} [opts.deps]           `{ acquireLock, syncStatuses, runAutoInvoicing, runInvoiceMailing, runInvoiceFtpExport, log }`
 * @returns {Promise<{ skipped?: string, statuses?: object, autoInvoices?: object|null, invoiceMails?: object|null, invoiceFtp?: object|null }>}
 */
async function runProdStatusCycle({ dryRun = false, full = false, invoices = true, mail = true, ftp = true, deps = {} } = {}) {
    const log = deps.log || defaultLog;
    const lock = await (deps.acquireLock || acquireDbLock)(lockName());
    if (!lock) {
        log('[prodStatus] inny proces właśnie przetwarza tę bazę — cykl pominięty');
        return { skipped: 'locked' };
    }

    try {
        const statuses = await (deps.syncStatuses || syncAllProdStatuses)({ dryRun, full });
        let autoInvoices = null;
        let invoiceMails = null;
        let invoiceFtp = null;
        if (invoices) {
            // Leniwie: sama synchronizacja statusów nie potrzebuje modułu faktur
            const runAutoInvoicing = deps.runAutoInvoicing || require('./invoices/autoInvoicing').runAutoInvoicing;
            autoInvoices = await runAutoInvoicing({ dryRun });
            // Maile PO automacie, w tym samym przebiegu: faktura wystawiona przed
            // chwilą wychodzi od razu, a nieudane z poprzednich przebiegów są
            // ponawiane. Wyłączone w `.env` = nic się nie dzieje (`INVOICE_MAIL_ENABLED`).
            if (mail) {
                try {
                    const runInvoiceMailing = deps.runInvoiceMailing || require('./invoices/invoiceMailer').runInvoiceMailing;
                    invoiceMails = await runInvoiceMailing({ dryRun });
                } catch (err) {
                    // Statusy i faktury są już zapisane — awaria poczty (SMTP, zapytanie)
                    // to częściowa porażka cyklu (kod 1), nie jego przerwanie
                    log(`[invoices:mail] przebieg przerwany: ${err && err.message ? err.message : err}`);
                    invoiceMails = { sent: [], failed: [{ error: String(err && err.message ? err.message : err) }], planned: [] };
                }
            }
            // FTP w tym samym przebiegu co mail, ale z własną kolejką — nie zależy
            // od tego, czy mail wyszedł (`INVOICE_FTP_ENABLED`)
            if (ftp) {
                try {
                    const runInvoiceFtpExport = deps.runInvoiceFtpExport || require('./invoices/invoiceFtpExport').runInvoiceFtpExport;
                    invoiceFtp = await runInvoiceFtpExport({ dryRun });
                } catch (err) {
                    log(`[invoices:ftp] przebieg przerwany: ${err && err.message ? err.message : err}`);
                    invoiceFtp = { uploaded: [], failed: [{ error: String(err && err.message ? err.message : err) }], planned: [] };
                }
            }
        }
        return { statuses, autoInvoices, invoiceMails, invoiceFtp };
    } finally {
        await lock.release();
    }
}

module.exports = { lockName, acquireDbLock, runProdStatusCycle };
