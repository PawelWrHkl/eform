/**
 * Cykl tła (`services/prodStatusCycle.js`) i harmonogram w procesie serwera
 * (`services/prodStatusScheduler.js`) — bez bazy i bez uruchamiania procesów.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runProdStatusCycle, lockName } = require('../prodStatusCycle');
const { readSchedulerConfig, isSpawnedByServer, modeBlockingServerRun, startProdStatusScheduler, SCRIPT } = require('../prodStatusScheduler');

const quiet = () => {};

function fakeLock() {
  const lock = { released: 0, release: async () => { lock.released++; } };
  return lock;
}

test('cykl: najpierw statusy, potem faktury, potem maile z fakturami, blokada zwolniona', async () => {
  const order = [];
  const lock = fakeLock();
  const result = await runProdStatusCycle({
    deps: {
      log: quiet,
      acquireLock: async () => lock,
      syncStatuses: async () => { order.push('statuses'); return { inserted: 1 }; },
      runAutoInvoicing: async () => { order.push('invoices'); return { created: [] }; },
      runInvoiceMailing: async ({ dryRun }) => { order.push(`mail:${dryRun}`); return { sent: [], failed: [], planned: [] }; }
    }
  });
  assert.deepEqual(order, ['statuses', 'invoices', 'mail:false']);
  assert.equal(result.statuses.inserted, 1);
  assert.deepEqual(result.invoiceMails, { sent: [], failed: [], planned: [] });
  assert.equal(lock.released, 1);
});

test('cykl: dry-run dociera do maili jako dry-run (nic nie wysyła)', async () => {
  let mailDry = null;
  await runProdStatusCycle({
    dryRun: true,
    deps: {
      log: quiet,
      acquireLock: async () => fakeLock(),
      syncStatuses: async () => ({}),
      runAutoInvoicing: async () => ({ created: [] }),
      runInvoiceMailing: async ({ dryRun }) => { mailDry = dryRun; return { sent: [], failed: [], planned: [] }; }
    }
  });
  assert.equal(mailDry, true);
});

test('cykl: --no-mail — faktury tak, maili nie', async () => {
  let mailed = false;
  const result = await runProdStatusCycle({
    mail: false,
    deps: {
      log: quiet,
      acquireLock: async () => fakeLock(),
      syncStatuses: async () => ({}),
      runAutoInvoicing: async () => ({ created: [] }),
      runInvoiceMailing: async () => { mailed = true; }
    }
  });
  assert.equal(mailed, false);
  assert.equal(result.invoiceMails, null);
  assert.deepEqual(result.autoInvoices, { created: [] });
});

test('cykl: awaria poczty nie przerywa cyklu — zapisana jako nieudana wysyłka, blokada zwolniona', async () => {
  const lock = fakeLock();
  const logs = [];
  const result = await runProdStatusCycle({
    deps: {
      log: (m) => logs.push(m),
      acquireLock: async () => lock,
      syncStatuses: async () => ({ inserted: 2 }),
      runAutoInvoicing: async () => ({ created: [{ invoiceId: 1 }] }),
      runInvoiceMailing: async () => { throw new Error('SMTP nie odpowiada'); }
    }
  });
  assert.equal(result.statuses.inserted, 2);
  assert.equal(result.autoInvoices.created.length, 1);
  assert.equal(result.invoiceMails.failed.length, 1);
  assert.match(result.invoiceMails.failed[0].error, /SMTP nie odpowiada/);
  assert.ok(logs.some((m) => /\[invoices:mail\] przebieg przerwany: SMTP nie odpowiada/.test(m)));
  assert.equal(lock.released, 1);
});

test('cykl: blokadę trzyma inny proces → nic nie robimy', async () => {
  let ran = false;
  const result = await runProdStatusCycle({
    deps: { log: quiet, acquireLock: async () => null, syncStatuses: async () => { ran = true; } }
  });
  assert.equal(result.skipped, 'locked');
  assert.equal(ran, false);
});

test('cykl: błąd synchronizacji zwalnia blokadę i nie uruchamia faktur', async () => {
  const lock = fakeLock();
  let invoices = false;
  await assert.rejects(runProdStatusCycle({
    deps: {
      log: quiet,
      acquireLock: async () => lock,
      syncStatuses: async () => { throw new Error('db down'); },
      runAutoInvoicing: async () => { invoices = true; }
    }
  }), /db down/);
  assert.equal(lock.released, 1);
  assert.equal(invoices, false);
});

test('cykl: --no-invoices pomija automat faktur i maile', async () => {
  let invoices = false;
  let mailed = false;
  const result = await runProdStatusCycle({
    invoices: false,
    deps: {
      log: quiet,
      acquireLock: async () => fakeLock(),
      syncStatuses: async () => ({}),
      runAutoInvoicing: async () => { invoices = true; },
      runInvoiceMailing: async () => { mailed = true; }
    }
  });
  assert.equal(invoices, false);
  assert.equal(mailed, false);
  assert.equal(result.autoInvoices, null);
  assert.equal(result.invoiceMails, null);
});

test('lockName: zawiera nazwę bazy i mieści się w limicie GET_LOCK', () => {
  assert.equal(lockName('eform'), 'eform:prodstatus:eform');
  assert.ok(lockName('x'.repeat(100)).length <= 64);
});

test('harmonogram: domyślnie child co 60 min', () => {
  assert.deepEqual(readSchedulerConfig({}), { mode: 'child', intervalMin: 60, warnings: [] });
});

test('harmonogram: za krótki interwał i nieznany tryb → wartości domyślne z ostrzeżeniem', () => {
  const cfg = readSchedulerConfig({ PROD_STATUS_SYNC_MODE: 'cron', PROD_STATUS_SYNC_INTERVAL_MIN: '1' });
  assert.equal(cfg.mode, 'child');
  assert.equal(cfg.intervalMin, 60);
  assert.equal(cfg.warnings.length, 2);
  assert.equal(readSchedulerConfig({ PROD_STATUS_SYNC_INTERVAL_MIN: '15' }).intervalMin, 15);
});

test('harmonogram: nieudany cykl --full jest powtarzany w następnym', () => {
  const spawned = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.kill = () => {};
    spawned.push({ args, child });
    return child;
  };
  const scheduler = startProdStatusScheduler({ env: {}, spawnFn, log: quiet, startDelayMs: 10 * 60 * 1000 });
  try {
    scheduler.runNow();
    spawned[0].child.emit('exit', 2, null);
    scheduler.runNow();
    assert.deepEqual(spawned[1].args, [SCRIPT, '--full']);
  } finally {
    scheduler.stop();
  }
});

test('harmonogram: przebieg rozpoznaje, że odpalił go serwer (rodzic server.js w /proc)', () => {
  const read = [];
  const cmdline = (args) => (file) => { read.push(file); return `${args.join('\0')}\0`; };
  // Kontener produkcji: `npm start` → `node --openssl-legacy-provider server.js`
  assert.equal(isSpawnedByServer({ ppid: 19, readFile: cmdline(['node', '--openssl-legacy-provider', 'server.js']) }), true);
  assert.equal(read[0], '/proc/19/cmdline');
  // Host :8000: potomek `node --watch server.js`
  assert.equal(isSpawnedByServer({ ppid: 7, readFile: cmdline(['/home/pawel/.nvm/versions/node/v23.10.0/bin/node', 'server.js']) }), true);
  // Cron przez powłokę, `npm run prodstatus:run`, plik o podobnej nazwie
  assert.equal(isSpawnedByServer({ ppid: 7, readFile: cmdline(['/bin/sh', '-c', 'node scripts/prodStatusSync.js']) }), false);
  assert.equal(isSpawnedByServer({ ppid: 7, readFile: cmdline(['npm', 'run', 'prodstatus:run']) }), false);
  assert.equal(isSpawnedByServer({ ppid: 7, readFile: cmdline(['node', 'old_server.js']) }), false);
  // `docker exec` (rodzic poza przestrzenią PID-ów kontenera, ppid 0) i system bez /proc
  const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.equal(isSpawnedByServer({ ppid: 0, readFile: missing }), false);
});

test('harmonogram: po przełączeniu .env na external/off przebieg zlecony przez serwer jest pomijany', () => {
  assert.equal(modeBlockingServerRun({ env: { PROD_STATUS_SYNC_MODE: 'external' }, spawnedByServer: true }), 'external');
  assert.equal(modeBlockingServerRun({ env: { PROD_STATUS_SYNC_MODE: 'off' }, spawnedByServer: true }), 'off');
  // Cron albo ręcznie — przebieg idzie zawsze
  assert.equal(modeBlockingServerRun({ env: { PROD_STATUS_SYNC_MODE: 'external' }, spawnedByServer: false }), null);
  // Tryb child (domyślny; nieznana wartość też daje child) — serwer jest właściwym wyzwalaczem
  assert.equal(modeBlockingServerRun({ env: {}, spawnedByServer: true }), null);
  assert.equal(modeBlockingServerRun({ env: { PROD_STATUS_SYNC_MODE: 'cron' }, spawnedByServer: true }), null);
});

test('harmonogram: tryb external/off — serwer niczego nie uruchamia', () => {
  let spawned = 0;
  const spawnFn = () => { spawned++; return new EventEmitter(); };
  assert.equal(startProdStatusScheduler({ env: { PROD_STATUS_SYNC_MODE: 'external' }, spawnFn, log: quiet }), null);
  assert.equal(startProdStatusScheduler({ env: { PROD_STATUS_SYNC_MODE: 'off' }, spawnFn, log: quiet }), null);
  assert.equal(spawned, 0);
});

test('harmonogram: osobny proces z tym samym node, bez nakładania się cykli', () => {
  const spawned = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.kill = () => {};
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  const scheduler = startProdStatusScheduler({ env: {}, spawnFn, log: quiet, startDelayMs: 10 * 60 * 1000 });
  try {
    assert.equal(scheduler.runNow(), true);
    assert.equal(spawned[0].cmd, process.execPath);
    // Pierwszy cykl dnia przelicza nagłówki wszystkich zamówień
    assert.deepEqual(spawned[0].args, [SCRIPT, '--full']);

    // Poprzedni cykl jeszcze trwa → kolejny termin przepada
    assert.equal(scheduler.runNow(), false);
    assert.equal(spawned.length, 1);

    spawned[0].child.emit('exit', 0, null);
    assert.equal(scheduler.runNow(), true);
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[1].args, [SCRIPT]);
  } finally {
    scheduler.stop();
  }
});
