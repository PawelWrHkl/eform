'use strict';

/**
 * `scripts/prodStatusSync.js` jako PRAWDZIWY proces potomny pliku `server.js` —
 * dokładnie to, co robi harmonogram serwera, który wstał przed przełączeniem
 * `.env` na cron (`PROD_STATUS_SYNC_MODE=external`). Bez bazy: pominięty
 * przebieg kończy się, zanim o cokolwiek ją zapyta. Tylko Linux (`/proc`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { SCRIPT } = require('../prodStatusScheduler');

test('skrypt: przebieg zlecony przez server.js przy PROD_STATUS_SYNC_MODE=external kończy się od razu, kodem 0, bez bazy',
  { skip: process.platform !== 'linux' && 'tylko Linux (/proc)' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodstatus-trigger-'));
    try {
      // Atrapa serwera — jak `runNow`: spawn(process.execPath, [SCRIPT]) z env serwera
      const fakeServer = path.join(dir, 'server.js');
      fs.writeFileSync(fakeServer, [
        "const { spawnSync } = require('child_process');",
        `const r = spawnSync(process.execPath, [${JSON.stringify(SCRIPT)}], { env: process.env, encoding: 'utf8', timeout: 20000 });`,
        'process.stdout.write(JSON.stringify({ status: r.status, signal: r.signal, out: r.stdout, err: r.stderr }));'
      ].join('\n'));

      const env = {
        ...process.env,
        PROD_STATUS_SYNC_MODE: 'external',
        LOG_PATH: dir,
        // Gdyby skrypt jednak sięgnął do bazy — zamknięty port zamiast bazy testowej
        DATABASE_HOST: '127.0.0.1',
        DATABASE_PORT: '9'
      };
      const started = Date.now();
      const r = spawnSync(process.execPath, [fakeServer], { env, encoding: 'utf8', timeout: 30000 });
      assert.equal(r.status, 0, r.stderr);

      const child = JSON.parse(r.stdout);
      assert.equal(child.status, 0, child.err);
      assert.match(child.out, /PROD_STATUS_SYNC_MODE=external — przebieg zlecony przez serwer pominięty/);
      assert.doesNotMatch(child.out, /plik: \d+ wierszy|invoices:/);
      assert.ok(Date.now() - started < 15000, 'pominięty przebieg nie może na nic czekać');

      const logFile = fs.readdirSync(dir).find((f) => /^log-\d{4}-\d{2}-\d{2}\.txt$/.test(f));
      assert.ok(logFile, 'linia trafia też do dziennego logu');
      assert.match(fs.readFileSync(path.join(dir, logFile), 'utf8'), /przebieg zlecony przez serwer pominięty/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
