'use strict';

/**
 * PDF-y faktur automatu na FTP (`invoiceFtpExport.js`) — konfiguracja z env,
 * ścieżki katalogów, upload przez plik `.part` i przebieg na atrapach
 * repozytorium/serwisu/serwera FTP (bez bazy, bez Chromium, bez sieci).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  FtpEvent,
  SUPPORTED_LEVELS,
  MAX_ATTEMPTS,
  defaultRootDir,
  readInvoiceFtpConfig,
  pathSegment,
  invoiceFileName,
  buildRemoteTarget,
  uploadFile,
  runInvoiceFtpExport
} = require('../invoiceFtpExport');
const { AUTO_ACTOR } = require('../autoInvoicing');

const quiet = () => {};
const BASE_ENV = {
  INVOICE_FTP_ENABLED: 'true',
  INVOICE_FTP_SINCE: '2026-10-22',
  FTP_HOST: 'ftp.example.test',
  FTP_USER: 'orderbot@example.test',
  FTP_PASSWORD: 'sekret',
  NODE_ENV: 'test'
};

function rowFixture(overrides = {}) {
  return {
    id: 501,
    number: '2026/00121',
    level: 2,
    document_type: 'invoice',
    organization_id: 3,
    issuer_id: 3,
    buyer_user_id: 77,
    buyer_name: 'TCN B.V.',
    organization_ident: 'HKL',
    issuer_organization_ident: 'HKL',
    client_ident: 'TCN',
    failures: 0,
    ...overrides
  };
}

/**
 * Serwer FTP w pamięci: pliki wspólne dla wszystkich połączeń, każde połączenie
 * z własnym katalogiem bieżącym. `failures` — kolejka błędów per operacja.
 */
function fakeFtpServer({ failures = {}, renameOverwrites = true, sizeDelta = 0 } = {}) {
  const server = { files: new Map(), dirs: new Set(), clients: [], connects: 0 };
  const failNext = (op) => {
    if (failures[op] && failures[op].length) {
      const err = failures[op].shift();
      if (err) throw err;
    }
  };
  server.connect = async () => {
    server.connects++;
    failNext('connect');
    let cwd = '/';
    const client = {
      closed: false,
      async ensureDir(dir) {
        failNext('ensureDir');
        server.dirs.add(dir);
        cwd = dir;
      },
      async uploadFrom(stream, name) {
        failNext('uploadFrom');
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        server.files.set(path.posix.join(cwd, name), Buffer.concat(chunks));
      },
      async rename(from, to) {
        failNext('rename');
        const src = path.posix.join(cwd, from);
        const dst = path.posix.join(cwd, to);
        if (!renameOverwrites && server.files.has(dst)) throw new Error('553 file exists');
        server.files.set(dst, server.files.get(src));
        server.files.delete(src);
      },
      async remove(name) {
        server.files.delete(path.posix.join(cwd, name));
      },
      async size(name) {
        return server.files.get(path.posix.join(cwd, name)).length + sizeDelta;
      },
      close() { client.closed = true; }
    };
    server.clients.push(client);
    return client;
  };
  return server;
}

function fakeRepository(rows) {
  const repo = {
    events: [],
    queries: [],
    async findInvoicesForFtp(params) { repo.queries.push(params); return rows; },
    async addInvoiceEvent(evt) { repo.events.push(evt); }
  };
  return repo;
}

function fakeService({ failFor = [] } = {}) {
  const svc = {
    rendered: [],
    async renderPdf(id) {
      svc.rendered.push(id);
      if (failFor.includes(id)) throw new Error('Chromium nie wstał');
      return { buffer: Buffer.from(`%PDF-${id}`), filename: `${id}.pdf` };
    }
  };
  return svc;
}

// ---------------------------------------------------------------------------
// Konfiguracja
// ---------------------------------------------------------------------------

test('konfiguracja: bez zmiennych wysyłka na FTP jest wyłączona', () => {
  const cfg = readInvoiceFtpConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.active, false);
  assert.deepEqual(cfg.problems, []);
});

test('konfiguracja: włączona — test do /invoices-test, produkcja do /invoices, domyślnie FTPS', () => {
  const testCfg = readInvoiceFtpConfig(BASE_ENV);
  assert.equal(testCfg.active, true);
  assert.equal(testCfg.since, '2026-10-22');
  assert.equal(testCfg.rootDir, '/invoices-test');
  assert.equal(testCfg.secure, true);
  assert.equal(testCfg.maxPerRun, 50);
  assert.equal(testCfg.connection.user, 'orderbot@example.test');

  assert.equal(readInvoiceFtpConfig({ ...BASE_ENV, NODE_ENV: 'prod' }).rootDir, '/invoices');
  assert.equal(defaultRootDir({ NODE_ENV: 'PROD' }), '/invoices');
  assert.equal(defaultRootDir({}), '/invoices-test');
});

test('konfiguracja: INVOICE_FTP_DIR wygrywa z domyślnym, ukośniki znormalizowane', () => {
  assert.equal(readInvoiceFtpConfig({ ...BASE_ENV, INVOICE_FTP_DIR: 'faktury/eform/' }).rootDir, '/faktury/eform');
  assert.equal(readInvoiceFtpConfig({ ...BASE_ENV, INVOICE_FTP_DIR: '/invoices' }).rootDir, '/invoices');
});

test('konfiguracja: katalog z „..” albo spacją blokuje wysyłkę', () => {
  for (const dir of ['/invoices/../orders-out', '/moje faktury']) {
    const cfg = readInvoiceFtpConfig({ ...BASE_ENV, INVOICE_FTP_DIR: dir });
    assert.equal(cfg.active, false, dir);
    assert.ok(cfg.problems.some((p) => /INVOICE_FTP_DIR/.test(p)), dir);
  }
});

test('konfiguracja: bez daty progowej albo bez danych FTP nie rusza', () => {
  const noSince = readInvoiceFtpConfig({ ...BASE_ENV, INVOICE_FTP_SINCE: '30.10.2026' });
  assert.equal(noSince.active, false);
  assert.ok(noSince.problems.some((p) => /INVOICE_FTP_SINCE/.test(p)));

  const noFtp = readInvoiceFtpConfig({ ...BASE_ENV, FTP_PASSWORD: '' });
  assert.equal(noFtp.active, false);
  assert.ok(noFtp.problems.some((p) => /FTP_PASSWORD/.test(p)));
  assert.ok(!noFtp.problems.join(' ').includes('sekret'));
});

test('konfiguracja: INVOICE_FTP_TLS=false wyłącza szyfrowanie, limit z env', () => {
  const cfg = readInvoiceFtpConfig({ ...BASE_ENV, INVOICE_FTP_TLS: 'false', INVOICE_FTP_MAX_PER_RUN: '5' });
  assert.equal(cfg.secure, false);
  assert.equal(cfg.maxPerRun, 5);
});

// ---------------------------------------------------------------------------
// Ścieżki
// ---------------------------------------------------------------------------

test('katalog: ident zostaje (B&C, umlauty), znikają separatory, znaki zakazane i „..”', () => {
  assert.equal(pathSegment('B&C_Botex'), 'B&C_Botex');
  assert.equal(pathSegment('ABCMünster'), 'ABCMünster');
  assert.equal(pathSegment('Art & Images'), 'Art & Images');
  assert.equal(pathSegment('a/b\\c'), 'a_b_c');
  assert.equal(pathSegment('x:y*?'), 'x_y_');
  assert.equal(pathSegment('  TCN  '), 'TCN');
  assert.equal(pathSegment('..'), '');
  assert.equal(pathSegment('.ukryty'), 'ukryty');
  assert.equal(pathSegment(null), '');
});

test('plik: rodzaj dokumentu po polsku + numer, tylko ASCII', () => {
  assert.equal(invoiceFileName({ document_type: 'invoice', number: '2026/00134' }), 'Faktura_VAT_2026_00134.pdf');
  assert.equal(invoiceFileName({ document_type: 'correction', number: '2026/00001' }), 'Faktura_korygujaca_2026_00001.pdf');
  assert.equal(invoiceFileName({ document_type: 'invoice', number: 'FV/2026/08/2' }), 'Faktura_VAT_FV_2026_08_2.pdf');
});

test('ścieżka: poziom 1 → hkl-organizacja/<organizacja-nabywca>', () => {
  const target = buildRemoteTarget(rowFixture({
    level: 1, number: '2026/00017', organization_id: 1, issuer_id: 0,
    organization_ident: 'Cozy', issuer_organization_ident: null, client_ident: null, buyer_user_id: null
  }), '/invoices-test');
  assert.deepEqual(target, {
    dir: '/invoices-test/hkl-organizacja/Cozy',
    fileName: 'Faktura_VAT_2026_00017.pdf',
    path: '/invoices-test/hkl-organizacja/Cozy/Faktura_VAT_2026_00017.pdf'
  });
});

test('ścieżka: poziom 2 → organizacja-klient/<wystawca>/<klient>', () => {
  const target = buildRemoteTarget(rowFixture(), '/invoices');
  assert.equal(target.path, '/invoices/organizacja-klient/HKL/TCN/Faktura_VAT_2026_00121.pdf');

  // Wystawcą jest organizacja z `issuer_id`, nie `organization_id`
  const luxan = buildRemoteTarget(rowFixture({ organization_ident: 'HKL', issuer_organization_ident: 'LUXANGMBH', client_ident: 'Matthes' }), '/invoices');
  assert.equal(luxan.dir, '/invoices/organizacja-klient/LUXANGMBH/Matthes');
});

test('ścieżka: brak identu → nazwa nabywcy albo id, nigdy pusty katalog', () => {
  // Końcowa kropka znika — Windows nie przyjmuje takiej nazwy katalogu
  assert.equal(buildRemoteTarget(rowFixture({ client_ident: null }), '/invoices').dir, '/invoices/organizacja-klient/HKL/TCN B.V');
  assert.equal(buildRemoteTarget(rowFixture({ client_ident: '', buyer_name: '' }), '/invoices').dir, '/invoices/organizacja-klient/HKL/klient-77');
  assert.equal(buildRemoteTarget(rowFixture({ issuer_organization_ident: null }), '/invoices').dir, '/invoices/organizacja-klient/organizacja-3/TCN');
  assert.equal(buildRemoteTarget(rowFixture({ level: 1, organization_ident: '..' }), '/invoices').dir, '/invoices/hkl-organizacja/organizacja-3');
});

test('ścieżka: poziomy 3 i 4 nie mają katalogu', () => {
  assert.deepEqual(SUPPORTED_LEVELS, [1, 2]);
  assert.throws(() => buildRemoteTarget(rowFixture({ level: 3 }), '/invoices'), /poziom 3/);
  assert.throws(() => buildRemoteTarget(rowFixture({ level: 4 }), '/invoices'), /poziom 4/);
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test('upload: katalogi, plik .part, zmiana nazwy, kontrola rozmiaru', async () => {
  const server = fakeFtpServer();
  const client = await server.connect();
  const target = buildRemoteTarget(rowFixture(), '/invoices');
  await uploadFile(client, target, Buffer.from('%PDF-1.7 treść'));

  assert.ok(server.dirs.has('/invoices/organizacja-klient/HKL/TCN'));
  assert.deepEqual([...server.files.keys()], [target.path]);
  assert.equal(server.files.get(target.path).toString(), '%PDF-1.7 treść');
});

test('upload: serwer nie nadpisuje przy zmianie nazwy — stary plik usunięty, nowy na miejscu', async () => {
  const server = fakeFtpServer({ renameOverwrites: false });
  const client = await server.connect();
  const target = buildRemoteTarget(rowFixture(), '/invoices');
  server.files.set(target.path, Buffer.from('stary'));
  await uploadFile(client, target, Buffer.from('nowy PDF'));
  assert.equal(server.files.get(target.path).toString(), 'nowy PDF');
  assert.equal(server.files.size, 1);
});

test('upload: rozmiar na serwerze inny niż wysłany → błąd', async () => {
  const server = fakeFtpServer({ sizeDelta: -1 });
  const client = await server.connect();
  await assert.rejects(uploadFile(client, buildRemoteTarget(rowFixture(), '/invoices'), Buffer.from('PDF')), /2 B zamiast 3 B/);
});

// ---------------------------------------------------------------------------
// Przebieg
// ---------------------------------------------------------------------------

test('przebieg: wyłączona wysyłka nie dotyka bazy ani FTP', async () => {
  const repo = fakeRepository([rowFixture()]);
  const server = fakeFtpServer();
  const result = await runInvoiceFtpExport({ config: readInvoiceFtpConfig({}), deps: { repository: repo, connect: server.connect, log: quiet } });
  assert.equal(result.skipped, 'disabled');
  assert.equal(repo.queries.length, 0);
  assert.equal(server.connects, 0);
});

test('przebieg: błędna konfiguracja — nic nie wychodzi, powód w logu', async () => {
  const logs = [];
  const repo = fakeRepository([rowFixture()]);
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig({ ...BASE_ENV, INVOICE_FTP_SINCE: '' }),
    deps: { repository: repo, connect: fakeFtpServer().connect, log: (m) => logs.push(m) }
  });
  assert.equal(result.skipped, 'config');
  assert.equal(repo.queries.length, 0);
  assert.ok(logs.some((m) => /\[invoices:ftp\] konfiguracja: INVOICE_FTP_SINCE/.test(m)));
});

test('przebieg: faktury automatu → PDF → FTP po katalogach → znacznik ftp_uploaded, jedno połączenie', async () => {
  const rows = [
    rowFixture({ id: 11, level: 1, number: '2026/00017', organization_ident: 'Cozy', issuer_organization_ident: null, client_ident: null, buyer_name: 'MaizonCozy B.V.' }),
    rowFixture({ id: 12 })
  ];
  const repo = fakeRepository(rows);
  const service = fakeService();
  const server = fakeFtpServer();
  const config = readInvoiceFtpConfig(BASE_ENV);
  const result = await runInvoiceFtpExport({ config, deps: { repository: repo, service, connect: server.connect, log: quiet } });

  assert.deepEqual(repo.queries[0], {
    since: '2026-10-22', doneEvent: FtpEvent.UPLOADED, failedEvent: FtpEvent.FAILED,
    maxAttempts: MAX_ATTEMPTS, createdByPin: AUTO_ACTOR, levels: [1, 2], limit: 50
  });
  assert.deepEqual(service.rendered, [11, 12]);
  assert.deepEqual([...server.files.keys()].sort(), [
    '/invoices-test/hkl-organizacja/Cozy/Faktura_VAT_2026_00017.pdf',
    '/invoices-test/organizacja-klient/HKL/TCN/Faktura_VAT_2026_00121.pdf'
  ]);
  assert.equal(server.files.get('/invoices-test/organizacja-klient/HKL/TCN/Faktura_VAT_2026_00121.pdf').toString(), '%PDF-12');
  assert.deepEqual(repo.events.map((e) => [e.invoiceId, e.eventType, e.actorPin]), [[11, 'ftp_uploaded', AUTO_ACTOR], [12, 'ftp_uploaded', AUTO_ACTOR]]);
  assert.deepEqual(repo.events[1].payload, { path: '/invoices-test/organizacja-klient/HKL/TCN/Faktura_VAT_2026_00121.pdf', host: 'ftp.example.test', size: 7 });
  assert.equal(result.uploaded.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(server.connects, 1);
  assert.ok(server.clients.every((c) => c.closed));
});

test('przebieg: PDF się nie wyrenderował → ftp_failed tej faktury, reszta idzie dalej', async () => {
  const repo = fakeRepository([rowFixture({ id: 21, failures: 2 }), rowFixture({ id: 22, number: '2026/00122' })]);
  const logs = [];
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: repo, service: fakeService({ failFor: [21] }), connect: fakeFtpServer().connect, log: (m) => logs.push(m) }
  });
  assert.deepEqual(result.failed.map((f) => f.invoiceId), [21]);
  assert.deepEqual(result.uploaded.map((u) => u.invoiceId), [22]);
  assert.deepEqual(repo.events.map((e) => [e.invoiceId, e.eventType]), [[21, 'ftp_failed'], [22, 'ftp_uploaded']]);
  assert.deepEqual(repo.events[0].payload, { error: 'Chromium nie wstał' });
  assert.ok(logs.some((m) => /BŁĄD — faktura 2026\/00121 .*próba 3\/5/.test(m)));
});

test('przebieg: brak połączenia na starcie — bez renderu i bez znaczników (próby faktur nie przepadają)', async () => {
  const repo = fakeRepository([rowFixture({ id: 31 }), rowFixture({ id: 32 })]);
  const service = fakeService();
  const logs = [];
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: repo, service, connect: fakeFtpServer({ failures: { connect: [new Error('530 Login incorrect')] } }).connect, log: (m) => logs.push(m) }
  });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /brak połączenia z ftp\.example\.test: 530 Login incorrect/);
  assert.deepEqual(service.rendered, []);
  assert.deepEqual(repo.events, []);
  assert.ok(logs.some((m) => /2 faktur wróci w następnym przebiegu/.test(m)));
  assert.ok(!logs.join('\n').includes('sekret'));
});

test('przebieg: zerwane połączenie przy uploadzie — powtórka na nowym, faktura wysłana', async () => {
  const repo = fakeRepository([rowFixture({ id: 41 })]);
  const server = fakeFtpServer({ failures: { uploadFrom: [new Error('ECONNRESET')] } });
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: repo, service: fakeService(), connect: server.connect, log: quiet }
  });
  assert.equal(result.uploaded.length, 1);
  assert.equal(server.connects, 2);
  assert.ok(server.clients[0].closed);
  assert.deepEqual(repo.events.map((e) => e.eventType), ['ftp_uploaded']);
});

test('przebieg: upload pada dwa razy → ftp_failed, następna faktura na świeżym połączeniu', async () => {
  const repo = fakeRepository([rowFixture({ id: 51 }), rowFixture({ id: 52, number: '2026/00122' })]);
  const server = fakeFtpServer({ failures: { uploadFrom: [new Error('550 brak miejsca'), new Error('550 brak miejsca')] } });
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: repo, service: fakeService(), connect: server.connect, log: quiet }
  });
  assert.deepEqual(result.failed.map((f) => [f.invoiceId, f.error]), [[51, '550 brak miejsca']]);
  assert.deepEqual(result.uploaded.map((u) => u.invoiceId), [52]);
  assert.deepEqual(repo.events.map((e) => [e.invoiceId, e.eventType]), [[51, 'ftp_failed'], [52, 'ftp_uploaded']]);
});

test('przebieg: serwer padł w trakcie — przerwany bez znacznika bieżącej faktury, reszta nietknięta', async () => {
  const repo = fakeRepository([rowFixture({ id: 61 }), rowFixture({ id: 62, number: '2026/00122' })]);
  const service = fakeService();
  const server = fakeFtpServer({ failures: { connect: [null, new Error('ETIMEDOUT')], uploadFrom: [new Error('ECONNRESET')] } });
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: repo, service, connect: server.connect, log: quiet }
  });
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /ETIMEDOUT/);
  assert.equal(result.failed[0].invoiceId, undefined);
  assert.deepEqual(service.rendered, [61]);
  assert.deepEqual(repo.events, []);
});

test('przebieg: dry-run tylko wypisuje ścieżki — bez PDF, FTP i zapisów', async () => {
  const repo = fakeRepository([rowFixture({ id: 71 })]);
  const service = fakeService();
  const server = fakeFtpServer();
  const logs = [];
  const result = await runInvoiceFtpExport({
    dryRun: true,
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: repo, service, connect: server.connect, log: (m) => logs.push(m) }
  });
  assert.deepEqual(result.planned, [{ invoiceId: 71, number: '2026/00121', path: '/invoices-test/organizacja-klient/HKL/TCN/Faktura_VAT_2026_00121.pdf' }]);
  assert.equal(server.connects, 0);
  assert.deepEqual(service.rendered, []);
  assert.deepEqual(repo.events, []);
  assert.ok(logs.some((m) => /DRY-RUN: wysłałbym — faktura 2026\/00121/.test(m)));
});

test('przebieg: plik wysłany, ale znacznik się nie zapisał — liczony jako wysłany, ostrzeżenie w logu', async () => {
  const repo = fakeRepository([rowFixture({ id: 81 })]);
  repo.addInvoiceEvent = async () => { throw new Error('Lock wait timeout'); };
  const logs = [];
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: repo, service: fakeService(), connect: fakeFtpServer().connect, log: (m) => logs.push(m) }
  });
  assert.equal(result.uploaded.length, 1);
  assert.ok(logs.some((m) => /UWAGA — faktura 2026\/00121 .*nie zapisano znacznika \(Lock wait timeout\)/.test(m)));
});

test('przebieg: pusta kolejka — bez połączenia z FTP', async () => {
  const server = fakeFtpServer();
  const result = await runInvoiceFtpExport({
    config: readInvoiceFtpConfig(BASE_ENV),
    deps: { repository: fakeRepository([]), service: fakeService(), connect: server.connect, log: quiet }
  });
  assert.deepEqual(result, { uploaded: [], failed: [], planned: [] });
  assert.equal(server.connects, 0);
});
