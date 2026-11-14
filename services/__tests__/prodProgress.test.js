const test = require('node:test');
const assert = require('node:assert');
const { prodPercent, buildProgressIndex, historyRows, decide, loadIndex, clientMayChange, clientMayChangeMany, PROD_LOCK_PERCENT } = require('../prodProgress');
const { parseStatusFile } = require('../prodStatus');

const FILE = [
    'ORGANIZATIONIDENT\tUSERIDENT\tORDERNO\tORDERPOS\tSTATUS\tSHIPPINGDATE\tPARCELCODE\tSTATUSPROD',
    'HKL\tTCN\t222\t1\t!production!\t\t\t11%Akcept.p.prod.',
    'HKL\tTCN\t222\t2\t!production!\t\t\t15%Przes.term.wys.',
    'HKL\tTCN\t223\t1\t!production!\t\t\t11%Akcept.p.prod.',
    'HKL\tTCN\t223\t2\t!production!\t\t\t20%Wyc.sz-y/r-ki',
    'Cozy\tM2\t1\t1\t!sent!\t2026-09-23\tBUS\t100%Wyslane',
    'HKL\tX\t5\t1\t!production!\t\t\t'
].join('\r\n');

const index = buildProgressIndex(parseStatusFile(FILE));
const order = (o) => ({ org_ident: 'HKL', user_ident: 'TCN', order_idx: 222, prod_status: '!production!', ...o });

test('procent z STATUSPROD', () => {
    assert.equal(prodPercent('11%Akcept.p.prod.'), 11);
    assert.equal(prodPercent('100%Wyslane'), 100);
    assert.equal(prodPercent(''), null);
    assert.equal(prodPercent('Wyslane'), null);
    assert.equal(PROD_LOCK_PERCENT, 20);
});

test('poniżej 20% na wszystkich pozycjach → wolno', () => {
    assert.deepEqual(decide(order(), index), { allowed: true, percent: 15 });
});

test('jedna pozycja na 20% blokuje całe zlecenie', () => {
    assert.deepEqual(decide(order({ order_idx: 223 }), index), { allowed: false, percent: 20 });
});

test('wielkość liter identów bez znaczenia, 100% → nie wolno', () => {
    assert.equal(decide({ org_ident: 'COZY', user_ident: 'm2', order_idx: '1' }, index).allowed, false);
});

test('pozycja bez procentu → blokada', () => {
    assert.deepEqual(decide(order({ user_ident: 'X', order_idx: 5 }), index), { allowed: false, percent: null });
});

test('brak w pliku: świeże (bez statusu produkcji) wolno, stare (z prod_status) nie', () => {
    assert.equal(decide(order({ order_idx: 999, prod_status: null }), index).allowed, true);
    assert.equal(decide(order({ order_idx: 999, prod_status: '!sent!' }), index).allowed, false);
});

test('pliku nie da się odczytać → nie wolno', async () => {
    const idx = await loadIndex({ filePath: '/nie/ma/status.txt', log: () => {} });
    assert.equal(idx, null);
    assert.equal(decide(order(), idx).allowed, false);
});

// ── Historia (statusy się cofają) ───────────────────────────────────────────

test('historia: choć raz ≥ 20% → blokada na stałe, nawet gdy plik pokazuje teraz mniej', () => {
    assert.deepEqual(decide(order(), index, { max_percent: '20.00', no_percent: 0 }), { allowed: false, percent: 20 });
    assert.deepEqual(decide(order(), index, { max_percent: '11.00', no_percent: 0 }), { allowed: true, percent: 15 });
});

test('historia: status bez % (Got.do fakt., Zafakturowane, Anulacja) kiedykolwiek → blokada', () => {
    assert.equal(decide(order(), index, { max_percent: '11.00', no_percent: 1 }).allowed, false);
    for (const s of ['Got.do fakt.', 'Zafakturowane', 'Anulacja']) assert.equal(prodPercent(s), null, s);
});

test('historia: zlecenie wypadło z pliku — nadal zablokowane po historii, bez niej po prod_status', () => {
    assert.equal(decide(order({ order_idx: 999, prod_status: null }), index, { max_percent: '33.00', no_percent: 0 }).allowed, false);
});

test('wiersze historii: znormalizowany klucz, procent albo null, data pierwszego zobaczenia', () => {
    const rows = parseStatusFile(FILE);
    const h = historyRows(rows, '2026-11-13 12:00:00');
    assert.deepEqual(h[0], ['HKL', 'TCN', '222', '1', '11%Akcept.p.prod.', 11, '2026-11-13 12:00:00']);
    assert.deepEqual(h[5], ['HKL', 'X', '5', '1', '', null, '2026-11-13 12:00:00']);
});

function fakeDeps({ history = [], record = true } = {}) {
    const calls = { record: 0, keys: null };
    return {
        calls,
        deps: {
            filePath: '/fake/status.txt',
            fs: { stat: async () => ({ mtimeMs: Math.random() }), readFile: async () => FILE },
            statusDb: {
                recordProdStatusHistory: async (rows) => { calls.record = rows.length; return record; },
                getProdStatusHistoryMax: async (keys) => { calls.keys = keys; return history; }
            },
            log: () => {},
            now: () => '2026-11-13 12:00:00'
        }
    };
}

test('lista: nowa wersja pliku zapisuje historię, decyzja łączy plik i historię jednym zapytaniem', async () => {
    const { deps, calls } = fakeDeps({ history: [{ org_ident: 'hkl', user_ident: 'tcn', order_idx: '222', max_percent: '40.00', no_percent: 0 }] });
    const res = await clientMayChangeMany([order(), order({ order_idx: 999, prod_status: null })], deps);
    assert.equal(calls.record, 6);
    assert.deepEqual(calls.keys, [['HKL', 'TCN', '222'], ['HKL', 'TCN', '999']]);
    assert.deepEqual(res, [{ allowed: false, percent: 40 }, { allowed: true, percent: null }]);
});

test('historia niedostępna (przed migracją): decyzja z samego pliku', async () => {
    const { deps } = fakeDeps({ history: null, record: false });
    assert.deepEqual(await clientMayChange(order(), deps), { allowed: true, percent: 15 });
});
