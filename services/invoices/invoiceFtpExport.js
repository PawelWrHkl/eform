'use strict';

/**
 * PDF-y faktur automatu na FTP — w tym samym cyklu co mail
 * (`services/prodStatusCycle.js`, zaraz po `invoiceMailer.js`): status 100 %
 * (`!sent!`) → faktura → mail → plik na FTP.
 *
 * Serwer i konto: te same `FTP_HOST` / `FTP_USER` / `FTP_PASSWORD` co eksport
 * zleceń (`orderbot@e-orders.eu`), połączenie szyfrowane (FTPS). Układ:
 *
 *   <katalog>/hkl-organizacja/<ORGANIZACJA>/<plik>.pdf              poziom 1: HKL → organizacja (nabywca)
 *   <katalog>/organizacja-klient/<ORGANIZACJA>/<KLIENT>/<plik>.pdf  poziom 2: organizacja (wystawca) → klient
 *
 * Katalogi to identy z eForma (`organization.ident`, `user.ident`) — jak w
 * nazwach plików zleceń na tym samym FTP (`HKL_TCN_190_pdf.pdf`); zamieniane są
 * tylko znaki niedozwolone w ścieżce. Faktura sklepu grupy trafia do katalogu
 * konta klienta (`invoice.buyer_user_id`). Plik: `<rodzaj>_<numer>.pdf` po
 * polsku, np. `Faktura_VAT_2026_00134.pdf` — rodzaj w nazwie, bo dokumenty
 * różnych rodzajów mają osobne serie i mogą dostać ten sam numer.
 *
 * ⚠️ Test i produkcja piszą na TO SAMO konto FTP, a numeracja w obu bazach jest
 * osobna — ten sam numer to w nich różne dokumenty. Dlatego domyślny katalog
 * zależy od środowiska: `/invoices` przy `NODE_ENV=prod`, `/invoices-test` poza
 * produkcją.
 *
 * Kolejka jest niezależna od maila: te same faktury automatu (wystawione, od
 * `INVOICE_FTP_SINCE`), ale własne znaczniki w `invoice_event` (`ftp_uploaded` /
 * `ftp_failed`) — awaria poczty nie zatrzymuje FTP i odwrotnie, a fakturę wysłaną
 * mailem przez inną instancję na tej samej bazie wrzuci najbliższy przebieg.
 * Poziomy 3 i 4 (odbiorcy końcowi) nie mają jeszcze katalogu — nie są wysyłane.
 *
 * Upload: plik `.part` → zmiana nazwy → kontrola rozmiaru, żeby odbiorca
 * czytający katalog nie wziął niedokończonego PDF-a. Ponowne wysłanie tej samej
 * faktury nadpisuje plik (ta sama ścieżka).
 *
 * Konfiguracja (`.env`, domyślnie WYŁĄCZONE):
 *   INVOICE_FTP_ENABLED=true        włącznik
 *   INVOICE_FTP_SINCE=2026-10-30    WYMAGANE: tylko faktury utworzone od tego dnia
 *                                   (włączenie nie wyśle całej historii)
 *   INVOICE_FTP_DIR=/invoices       katalog główny (domyślnie — wyżej)
 *   INVOICE_FTP_TLS=false           awaryjnie bez szyfrowania (domyślnie FTPS)
 *   INVOICE_FTP_MAX_PER_RUN=50      bezpiecznik na jeden przebieg
 */

const path = require('path');
const { Readable } = require('stream');
const defaultRepository = require('./db/repository');
const renderer = require('./render/renderer');
const { AUTO_ACTOR } = require('./autoInvoicing');
const { InvoiceLevel } = require('./core/hierarchy');
const { sanitizeFilename } = require('../../utils/sanitizeFilename');
const { log: defaultLog } = require('../../utils/logging');

const FtpEvent = Object.freeze({
  UPLOADED: 'ftp_uploaded',
  FAILED: 'ftp_failed'
});

/** Katalog pierwszego stopnia per poziom faktury — inne poziomy nie są wysyłane. */
const LEVEL_FOLDERS = Object.freeze({
  [InvoiceLevel.MANUFACTURER_TO_ORGANIZATION]: 'hkl-organizacja',
  [InvoiceLevel.ORGANIZATION_TO_USER]: 'organizacja-klient'
});
const SUPPORTED_LEVELS = Object.keys(LEVEL_FOLDERS).map(Number);

/** Po tylu nieudanych próbach faktura przestaje wracać (np. PDF, który się nie renderuje). */
const MAX_ATTEMPTS = 5;
const DEFAULT_MAX_PER_RUN = 50;
const CONNECT_TIMEOUT_MS = 30000;

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function defaultRootDir(env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'prod' ? '/invoices' : '/invoices-test';
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ enabled: boolean, active: boolean, since: string|null, rootDir: string, secure: boolean, maxPerRun: number, connection: { host: string, user: string, password: string }, problems: string[] }}
 */
function readInvoiceFtpConfig(env = process.env) {
  const enabled = String(env.INVOICE_FTP_ENABLED).toLowerCase() === 'true';
  const problems = [];

  const rawSince = String(env.INVOICE_FTP_SINCE || '').trim();
  const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSince) ? new Date(`${rawSince}T00:00:00Z`) : null;
  const since = sinceDate && !Number.isNaN(sinceDate.getTime()) && sinceDate.toISOString().slice(0, 10) === rawSince
    ? rawSince
    : null;

  const rawDir = String(env.INVOICE_FTP_DIR || '').trim();
  const rootDir = rawDir ? `/${rawDir.replace(/^\/+|\/+$/g, '')}` : defaultRootDir(env);
  const dirValid = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rootDir)
    && !rootDir.split('/').some((seg) => seg === '.' || seg === '..');

  const connection = {
    host: String(env.FTP_HOST || '').trim(),
    user: String(env.FTP_USER || '').trim(),
    password: String(env.FTP_PASSWORD || '')
  };
  const maxPerRun = Number(env.INVOICE_FTP_MAX_PER_RUN);

  if (enabled) {
    if (!since) problems.push(`INVOICE_FTP_SINCE musi być datą RRRR-MM-DD (jest: „${rawSince}")`);
    if (!dirValid) problems.push(`INVOICE_FTP_DIR: dozwolone litery, cyfry, „.", „_", „-" i „/" (jest: „${rawDir}")`);
    if (!connection.host || !connection.user || !connection.password) problems.push('brak FTP_HOST / FTP_USER / FTP_PASSWORD — nie ma dokąd wysłać');
  }

  return {
    enabled,
    active: enabled && problems.length === 0,
    since,
    rootDir,
    secure: String(env.INVOICE_FTP_TLS).toLowerCase() !== 'false',
    maxPerRun: Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : DEFAULT_MAX_PER_RUN,
    connection,
    problems
  };
}

/**
 * Ident z eForma jako nazwa katalogu: bez separatorów ścieżki, znaków
 * zakazanych w Windows (katalog bywa kopiowany na dysk księgowości) i nazw
 * „.", „..". Reszta zostaje — `B&C`, `ABCMünster` są na tym FTP od lat.
 *
 * @param {unknown} value
 * @returns {string} pusty, gdy z wartości nic nie zostało
 */
function pathSegment(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
}

const plTranslate = renderer.createTranslator('pl');

/**
 * @param {{ document_type: string, number: string }} row
 * @returns {string} np. `Faktura_VAT_2026_00134.pdf`
 */
function invoiceFileName(row) {
  return sanitizeFilename(`${plTranslate(`doc.${row.document_type}`)}_${row.number}.pdf`);
}

/**
 * Miejsce faktury na FTP (wiersz z `repository.findInvoicesForFtp`).
 *
 * @param {Record<string, any>} row
 * @param {string} rootDir
 * @returns {{ dir: string, fileName: string, path: string }}
 */
function buildRemoteTarget(row, rootDir) {
  const level = Number(row.level);
  const folder = LEVEL_FOLDERS[level];
  if (!folder) throw new Error(`poziom ${row.level} nie ma katalogu na FTP`);

  const segments = [rootDir, folder];
  if (level === InvoiceLevel.MANUFACTURER_TO_ORGANIZATION) {
    // Poziom 1: `organization_id` faktury to organizacja-NABYWCA
    segments.push(pathSegment(row.organization_ident) || `organizacja-${row.organization_id}`);
  } else {
    segments.push(pathSegment(row.issuer_organization_ident) || `organizacja-${row.issuer_id}`);
    segments.push(pathSegment(row.client_ident) || pathSegment(row.buyer_name) || `klient-${row.buyer_user_id}`);
  }

  const dir = path.posix.join(...segments);
  const fileName = invoiceFileName(row);
  return { dir, fileName, path: path.posix.join(dir, fileName) };
}

/**
 * @param {ReturnType<typeof readInvoiceFtpConfig>} config
 * @returns {Promise<import('basic-ftp').Client>}
 */
async function defaultConnect(config) {
  const ftp = require('basic-ftp');
  const client = new ftp.Client(CONNECT_TIMEOUT_MS);
  try {
    await client.access({ ...config.connection, secure: config.secure });
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}

/**
 * Zakłada brakujące katalogi i wgrywa plik pod tymczasową nazwą, potem zmienia
 * nazwę na docelową i sprawdza rozmiar.
 *
 * @param {import('basic-ftp').Client} client
 * @param {{ dir: string, fileName: string }} target
 * @param {Buffer} buffer
 */
async function uploadFile(client, { dir, fileName }, buffer) {
  // `ensureDir` przy ścieżce bezwzględnej zaczyna od „/" i kończy W katalogu docelowym
  await client.ensureDir(dir);
  const partName = `${fileName}.part`;
  await client.uploadFrom(Readable.from([buffer]), partName);
  try {
    await client.rename(partName, fileName);
  } catch {
    // Serwer, który przy zmianie nazwy nie nadpisuje pliku z poprzedniej próby
    await client.remove(fileName, true);
    await client.rename(partName, fileName);
  }
  const size = await client.size(fileName);
  if (size !== buffer.length) throw new Error(`na FTP ${size} B zamiast ${buffer.length} B`);
}

/**
 * Jeden przebieg: wszystkie faktury automatu czekające na FTP.
 *
 * Brak połączenia przerywa przebieg BEZ znaczników `ftp_failed` — awaria
 * serwera nie zużywa prób faktur. Błąd pojedynczego uploadu jest ponawiany raz
 * na nowym połączeniu (serwer zrywa połączenia bezczynne w trakcie renderu PDF).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]  tylko lista ścieżek, bez PDF, FTP i zapisów
 * @param {ReturnType<typeof readInvoiceFtpConfig>} [opts.config]
 * @param {Object} [opts.deps] `{ repository, service, connect, log }` — podmiana w testach
 * @returns {Promise<{ skipped?: string, uploaded: object[], failed: object[], planned: object[] }>}
 */
async function runInvoiceFtpExport({ dryRun = false, config = readInvoiceFtpConfig(), deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const connect = deps.connect || defaultConnect;
  const result = { uploaded: [], failed: [], planned: [] };

  config.problems.forEach((p) => log(`[invoices:ftp] konfiguracja: ${p}`));
  if (!config.active) {
    if (config.enabled) log('[invoices:ftp] wysyłka na FTP NIE ruszyła — popraw konfigurację powyżej');
    return { ...result, skipped: config.enabled ? 'config' : 'disabled' };
  }

  const pending = await repository.findInvoicesForFtp({
    since: config.since,
    doneEvent: FtpEvent.UPLOADED,
    failedEvent: FtpEvent.FAILED,
    maxAttempts: MAX_ATTEMPTS,
    createdByPin: AUTO_ACTOR,
    levels: SUPPORTED_LEVELS,
    limit: config.maxPerRun
  });
  const summary = () => log(`[invoices:ftp] ${dryRun ? `DRY-RUN: do wysłania ${result.planned.length}` : `wysłano ${result.uploaded.length}, błędy ${result.failed.length}`}`
    + ` (${config.connection.host}${config.rootDir}; faktury od ${config.since})`);

  const markFailed = async (row, label, err) => {
    result.failed.push({ invoiceId: row.id, number: row.number, error: err.message });
    log(`[invoices:ftp] BŁĄD — ${label}: ${err.message} (próba ${Number(row.failures || 0) + 1}/${MAX_ATTEMPTS})`);
    try {
      await repository.addInvoiceEvent({ invoiceId: row.id, eventType: FtpEvent.FAILED, actorPin: AUTO_ACTOR, payload: { error: err.message } });
    } catch (err2) {
      log(`[invoices:ftp] nie zapisano nieudanej próby — ${label}: ${err2.message}`);
    }
  };

  let client = null;
  const closeClient = () => {
    if (client) client.close();
    client = null;
  };
  const openClient = async () => {
    try {
      client = await connect(config);
    } catch (err) {
      throw Object.assign(new Error(`brak połączenia z ${config.connection.host}: ${err.message}`), { connectFailed: true });
    }
  };
  const uploadWithRetry = async (target, buffer) => {
    try {
      if (!client) await openClient();
      await uploadFile(client, target, buffer);
    } catch (err) {
      if (err.connectFailed) throw err;
      closeClient();
      await openClient();
      await uploadFile(client, target, buffer);
    }
  };

  if (pending.length && !dryRun) {
    try {
      await openClient();
    } catch (err) {
      result.failed.push({ error: err.message });
      log(`[invoices:ftp] ${err.message} — ${pending.length} faktur wróci w następnym przebiegu`);
      return result;
    }
  }

  // Leniwie: InvoiceService ciągnie VIES/NBP, a przy pustej kolejce nie jest potrzebny
  let service = deps.service || null;
  try {
    for (const row of pending) {
      const label = `faktura ${row.number} (id ${row.id}, ${row.buyer_name})`;
      let target;
      try {
        target = buildRemoteTarget(row, config.rootDir);
      } catch (err) {
        if (dryRun) log(`[invoices:ftp] DRY-RUN: pominąłbym — ${label}: ${err.message}`);
        else await markFailed(row, label, err);
        continue;
      }
      if (dryRun) {
        result.planned.push({ invoiceId: row.id, number: row.number, path: target.path });
        log(`[invoices:ftp] DRY-RUN: wysłałbym — ${label} → ${target.path}`);
        continue;
      }

      try {
        service = service || new (require('./main').InvoiceService)({ repository, log });
        const pdf = await service.renderPdf(row.id);
        await uploadWithRetry(target, pdf.buffer);

        const payload = { path: target.path, host: config.connection.host, size: pdf.buffer.length };
        try {
          await repository.addInvoiceEvent({ invoiceId: row.id, eventType: FtpEvent.UPLOADED, actorPin: AUTO_ACTOR, payload });
        } catch (err) {
          // Plik jest na FTP — powtórka w następnym przebiegu nadpisze go tym samym
          log(`[invoices:ftp] UWAGA — ${label}: plik wysłany, ale nie zapisano znacznika (${err.message}); pójdzie ponownie`);
        }
        result.uploaded.push({ invoiceId: row.id, number: row.number, path: target.path });
        log(`[invoices:ftp] ${label} → ${target.path}`);
      } catch (err) {
        closeClient();
        if (err.connectFailed) {
          result.failed.push({ error: err.message });
          log(`[invoices:ftp] ${err.message} — przebieg przerwany, reszta wróci w następnym`);
          break;
        }
        await markFailed(row, label, err);
      }
    }
  } finally {
    closeClient();
  }

  if (pending.length >= config.maxPerRun) {
    log(`[invoices:ftp] wyczerpany limit ${config.maxPerRun} plików na przebieg (INVOICE_FTP_MAX_PER_RUN) — reszta w następnym`);
  }
  summary();
  return result;
}

module.exports = {
  FtpEvent,
  LEVEL_FOLDERS,
  SUPPORTED_LEVELS,
  MAX_ATTEMPTS,
  defaultRootDir,
  readInvoiceFtpConfig,
  pathSegment,
  invoiceFileName,
  buildRemoteTarget,
  uploadFile,
  runInvoiceFtpExport
};
