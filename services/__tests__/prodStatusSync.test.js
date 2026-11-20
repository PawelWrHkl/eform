/**
 * Pełna synchronizacja statusów produkcji (`services/prodStatus.js`):
 * parser `status.txt`, porównanie z `position_statuses` i przebieg z atrapą bazy.
 *
 * Uruchomienie: npm test  (albo pojedynczo:
 *   ROOT_DIR=/tmp/eform-test NODE_ENV=test node --test --test-force-exit services/__tests__/prodStatusSync.test.js)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStatusFile, diffStatuses, statusKey, syncAllProdStatuses } = require('../prodStatus');

const HEADER = 'ORGANIZATIONIDENT\tUSERIDENT\tORDERNO\tORDERPOS\tSTATUS\tSHIPPINGDATE\tPARCELCODE';

function file(...lines) {
  return [HEADER, ...lines].join('\r\n') + '\r\n';
}

function dbRow(userIdent, orderIdx, orderPos, status, shippingDate, parcelCode) {
  return { user_ident: userIdent, order_idx: orderIdx, order_pos: orderPos, status, shipping_date: shippingDate, parcel_code: parcelCode };
}

test('parseStatusFile: kolumny z nagłówka, CRLF, ident ze spacją', () => {
  const rows = parseStatusFile(file(
    'LuxanGmbH\tGonska Polsterei_SV\t1\t1\t!sent!\t2026-08-28\tUPS 1Z3776V26878049845',
    ''
  ));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    ORGANIZATIONIDENT: 'LuxanGmbH',
    USERIDENT: 'Gonska Polsterei_SV',
    ORDERNO: '1',
    ORDERPOS: '1',
    STATUS: '!sent!',
    SHIPPINGDATE: '2026-08-28',
    PARCELCODE: 'UPS 1Z3776V26878049845'
  });
});

test('parseStatusFile: pusty plik i brak pliku → brak wierszy', () => {
  assert.deepEqual(parseStatusFile(''), []);
  assert.deepEqual(parseStatusFile(null), []);
  assert.deepEqual(parseStatusFile(HEADER), []);
});

test('diffStatuses: nowy wiersz → INSERT, zmieniony → UPDATE, ten sam → nic', () => {
  const rows = parseStatusFile(file(
    'HKL\tRyver\t67\t1\t!sent!\t2026-08-05\tBUS',       // zmiana statusu
    'HKL\tRyver\t67\t2\t!sent!\t2026-08-05\tBUS',       // bez zmian
    'HKL\tRyver\t68\t1\t!production!\t2026-10-05\t-'   // nowy
  ));
  const db = [
    dbRow('Ryver', 67, '1', '!production!', '2026-08-01', '-'),
    dbRow('Ryver', 67, '2', '!sent!', '2026-08-05', 'BUS')
  ];
  const diff = diffStatuses(rows, db, ['Ryver']);

  assert.deepEqual(diff.inserts.map((r) => [r.ORDERNO, r.ORDERPOS]), [[68, '1']]);
  assert.deepEqual(diff.updates.map((r) => [r.ORDERNO, r.ORDERPOS]), [[67, '1']]);
  assert.equal(diff.stats.unchanged, 1);
  // Nagłówek przeliczamy tylko dla zamówień, w których coś się zmieniło
  assert.deepEqual(diff.orders.sort((a, b) => a.orderIdx - b.orderIdx), [
    { userIdent: 'Ryver', orderIdx: 67 },
    { userIdent: 'Ryver', orderIdx: 68 }
  ]);
});

test('diffStatuses: sama zmiana daty albo numeru paczki też jest zmianą', () => {
  const rows = parseStatusFile(file(
    'HKL\tRyver\t1\t1\t!sent!\t2026-08-06\tBUS',
    'HKL\tRyver\t1\t2\t!sent!\t2026-08-05\tUPS 1Z1'
  ));
  const db = [
    dbRow('Ryver', 1, '1', '!sent!', '2026-08-05', 'BUS'),
    dbRow('Ryver', 1, '2', '!sent!', '2026-08-05', '-')
  ];
  assert.equal(diffStatuses(rows, db, ['Ryver']).updates.length, 2);
});

test('diffStatuses: wielkość liter identu bez znaczenia — jak w MySQL', () => {
  const rows = parseStatusFile(file('HKL\tRYVER\t1\t1\t!sent!\t2026-08-05\tBUS'));
  const db = [dbRow('Ryver', 1, '1', '!sent!', '2026-08-05', 'BUS')];
  const diff = diffStatuses(rows, db, ['ryver']);
  assert.equal(diff.inserts.length, 0);
  assert.equal(diff.updates.length, 0);
  assert.equal(diff.stats.unchanged, 1);
});

test('diffStatuses: pomija klientów spoza eForm i wiersze bez liczbowego ORDERNO', () => {
  const rows = parseStatusFile(file(
    'HKL\tNieznany\t1\t1\t!sent!\t2026-08-05\tBUS',
    'HKL\tRyver\tB793638\t1\t!sent!\t2026-08-05\tBUS',
    'HKL\tRyver\t2\t1\t!sent!\t2026-08-05\tBUS'
  ));
  const diff = diffStatuses(rows, [], ['Ryver']);
  assert.equal(diff.stats.unknownUser, 1);
  assert.equal(diff.stats.invalid, 1);
  assert.equal(diff.inserts.length, 1);
});

test('diffStatuses: powtórzony klucz w pliku — wygrywa ostatni wiersz', () => {
  const rows = parseStatusFile(file(
    'HKL\tRyver\t1\t1\t!production!\t2026-08-01\t-',
    'HKL\tRyver\t1\t1\t!sent!\t2026-08-05\tBUS'
  ));
  const diff = diffStatuses(rows, [], ['Ryver']);
  assert.equal(diff.inserts.length, 1);
  assert.equal(diff.inserts[0].STATUS, '!sent!');
});

test('diffStatuses: allOrders zawiera także zamówienia bez zmian (tryb --full)', () => {
  const rows = parseStatusFile(file('HKL\tRyver\t1\t1\t!sent!\t2026-08-05\tBUS'));
  const diff = diffStatuses(rows, [dbRow('Ryver', 1, '1', '!sent!', '2026-08-05', 'BUS')], ['Ryver']);
  assert.deepEqual(diff.orders, []);
  assert.deepEqual(diff.allOrders, [{ userIdent: 'Ryver', orderIdx: 1 }]);
});

test('statusKey: klucz niewrażliwy na wielkość liter i spacje', () => {
  assert.equal(statusKey(' Ryver ', 1, '1-1'), statusKey('RYVER', '1', '1-1'));
});

/** Atrapa `db/statuses.js` z zapisem wywołań. */
function fakeStatusDb({ rows = [], idents = ['Ryver'], failInsert = false, items = [] } = {}) {
  const calls = { insert: [], update: [], sync: [], cancel: [], itemKeys: [] };
  return {
    calls,
    getAllPositionStatuses: async () => rows,
    getKnownUserIdents: async () => idents,
    insertStatus: async (r) => { calls.insert.push(r); return !failInsert; },
    updateStatus: async (r) => { calls.update.push(r); return true; },
    syncOrderFromStatuses: async (u, o) => { calls.sync.push([u, o]); return { affectedRows: 1 }; },
    getOrderItemsByKeys: async (keys) => { if (keys.length) calls.itemKeys.push(keys); return items; },
    cancelOrdersFromProd: async (ids, opts) => { if (ids.length) calls.cancel.push([ids, opts.dryRun]); return ids; }
  };
}

test('syncAllProdStatuses: zapisuje różnice i przelicza nagłówki zmienionych zamówień', async () => {
  const db = fakeStatusDb({ rows: [dbRow('Ryver', 1, '1', '!production!', '2026-08-01', '-')] });
  const summary = await syncAllProdStatuses({
    filePath: 'status.txt',
    deps: {
      db,
      log: () => {},
      readFile: async () => file('HKL\tRyver\t1\t1\t!sent!\t2026-08-05\tBUS', 'HKL\tRyver\t2\t1\t!sent!\t2026-08-05\tBUS')
    }
  });
  assert.equal(summary.inserted, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(db.calls.sync.sort(), [['Ryver', 1], ['Ryver', 2]]);
});

test('syncAllProdStatuses: dry-run niczego nie zapisuje', async () => {
  const db = fakeStatusDb();
  const summary = await syncAllProdStatuses({
    dryRun: true,
    deps: { db, log: () => {}, readFile: async () => file('HKL\tRyver\t1\t1\t!sent!\t2026-08-05\tBUS') }
  });
  assert.equal(summary.inserted, 1);
  assert.deepEqual(db.calls, { insert: [], update: [], sync: [], cancel: [], itemKeys: [] });
});

test('syncAllProdStatuses: nieudany zapis liczony jako błąd (insertStatus zwraca false)', async () => {
  const db = fakeStatusDb({ failInsert: true });
  const summary = await syncAllProdStatuses({
    deps: { db, log: () => {}, readFile: async () => file('HKL\tRyver\t1\t1\t!sent!\t2026-08-05\tBUS') }
  });
  assert.equal(summary.failed, 1);
});

test('syncAllProdStatuses: brak pliku → cykl pominięty bez błędu', async () => {
  const db = fakeStatusDb();
  const summary = await syncAllProdStatuses({
    deps: {
      db,
      log: () => {},
      readFile: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }
    }
  });
  assert.equal(summary.skipped, 'no-file');
  assert.deepEqual(db.calls.insert, []);
});

test('syncAllProdStatuses: błąd odczytu bazy przerywa — nie traktujemy go jak pustej tabeli', async () => {
  const db = fakeStatusDb();
  db.getAllPositionStatuses = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    syncAllProdStatuses({ deps: { db, log: () => {}, readFile: async () => file('HKL\tRyver\t1\t1\t!sent!\t2026-08-05\tBUS') } }),
    /ECONNREFUSED/
  );
  assert.deepEqual(db.calls.insert, []);
});

test('syncAllProdStatuses: zlecenie z „Anulacja” na każdej pozycji → anulowane w eFormie (Paweł 19.11.2026)', async () => {
  const header = `${HEADER}\tSTATUSPROD\tMAXSTATUSPROD`;
  const content = [header,
    'LuxanGmbH\tKN\t70\t1\t!sent!\t\t\tAnulacja\tAnulacja',
    'LuxanGmbH\tKN\t70\t2\t!sent!\t\t\tAnulacja\tAnulacja',
    'HKL\tRyver\t239\t1\t!sent!\t2026-09-28\t\t100%Wyslane\tAnulacja',
    'HKL\tRyver\t5\t1\t!sent!\t\t\tAnulacja\tAnulacja',
    'HKL\tRyver\t5\t2\t!production!\t\t\t11%Akcept.p.prod.\t11%Akcept.p.prod.'
  ].join('\r\n');
  const logs = [];
  // Pozycje w eFormie: KN 70 ma dwie (obie anulowane), Ryver 5 — dwie (druga w produkcji).
  const items = [
    { id: 4012, org_ident: 'LUXANGMBH', user_ident: 'KN', order_idx: '70', orderpos: 1 },
    { id: 4012, org_ident: 'LUXANGMBH', user_ident: 'KN', order_idx: '70', orderpos: 2 },
    { id: 4013, org_ident: 'HKL', user_ident: 'Ryver', order_idx: '5', orderpos: 1 },
    { id: 4013, org_ident: 'HKL', user_ident: 'Ryver', order_idx: '5', orderpos: 2 }
  ];
  const db = fakeStatusDb({ idents: ['Ryver', 'KN'], items });
  const summary = await syncAllProdStatuses({ deps: { db, log: (m) => logs.push(m), readFile: async () => content } });
  assert.deepEqual(db.calls.itemKeys, [[['LuxanGmbH', 'KN', '70'], ['HKL', 'Ryver', '5']]], 'MAXSTATUSPROD przy wysłanej (Ryver 239) — nie kandydat');
  assert.deepEqual(db.calls.cancel, [[[4012], false]], 'tylko całe zlecenie; pojedyncza pozycja — nie');
  assert.equal(summary.canceledByProd, 1);
  assert.match(logs.join('\n'), /anulowane przez produkcję .*4012/);

  const dry = fakeStatusDb({ idents: ['KN'], items });
  await syncAllProdStatuses({ dryRun: true, deps: { db: dry, log: () => {}, readFile: async () => content } });
  assert.equal(dry.calls.cancel[0][1], true, 'dry-run tylko liczy');
});

test('syncAllProdStatuses: pozycja z eFormu, której nie ma w pliku, blokuje anulowanie (KN_Wohnen nr 16, Wiktoria 20.11.2026)', async () => {
  const content = [`${HEADER}\tSTATUSPROD\tMAXSTATUSPROD`,
    'LuxanGmbH\tKN_Wohnen_Neubrandenburg\t16\t3\t!sent!\t\t\tAnulacja\tAnulacja',
    'LuxanGmbH\tKN_Wohnen_Neubrandenburg\t16\t4\t!sent!\t\t\tAnulacja\tAnulacja'
  ].join('\r\n');
  const items = [1, 2, 3, 4].map((orderpos) => ({ id: 1967, org_ident: 'LUXANGMBH', user_ident: 'KN_Wohnen_Neubrandenburg', order_idx: '16', orderpos }));
  const db = fakeStatusDb({ idents: ['KN_Wohnen_Neubrandenburg'], items });
  const summary = await syncAllProdStatuses({ deps: { db, log: () => {}, readFile: async () => content } });
  assert.deepEqual(db.calls.cancel, []);
  assert.equal(summary.canceledByProd, 0);
});

test('syncAllProdStatuses: błąd anulowania liczony jako błąd, cykl idzie dalej', async () => {
  const db = { ...fakeStatusDb(), cancelOrdersFromProd: async () => { throw new Error('baza'); } };
  const summary = await syncAllProdStatuses({ deps: { db, log: () => {}, readFile: async () => file('HKL\tRyver\t1\t1\t!sent!\t2026-08-05\tBUS') } });
  assert.equal(summary.failed, 1);
});
