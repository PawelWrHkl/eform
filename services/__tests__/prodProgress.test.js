const test = require('node:test');
const assert = require('node:assert');
const { prodPercent, maxStatusProd, buildProgressIndex, buildCanceledOrders, fullyCanceledOrderIds, historyRows, decide, loadIndex, clientMayChange, clientMayChangeMany, PROD_LOCK_PERCENT } = require('../prodProgress');
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

test('brak pozycji w pliku → nie wolno, także świeże i z historią < 20% (Wiktoria 19.11.2026)', () => {
    assert.equal(decide(order({ order_idx: 999, prod_status: null }), index).allowed, false);
    assert.equal(decide(order({ order_idx: 999, prod_status: '!sent!' }), index).allowed, false);
    assert.deepEqual(decide(order({ order_idx: 999 }), index, { max_percent: '11.00', no_percent: 0 }), { allowed: false, percent: 11 });
});

test('pliku nie da się odczytać → nie wolno', async () => {
    const idx = await loadIndex({ filePath: '/nie/ma/status.txt', log: () => {} });
    assert.equal(idx, null);
    assert.equal(decide(order(), idx).allowed, false);
});

// ── MAXSTATUSPROD (decyzja 16.11.2026) ──────────────────────────────────────

const FILE_MAX = [
    'ORGANIZATIONIDENT\tUSERIDENT\tORDERNO\tORDERPOS\tSTATUS\tSHIPPINGDATE\tPARCELCODE\tSTATUSPROD\tMAXSTATUSPROD',
    'HKL\tTCN\t300\t1\t!production!\t\t\t11%Akcept.p.prod.\t11%Akcept.p.prod.',
    'HKL\tTCN\t300\t2\t!production!\t\t\t15%Przes.term.wys.\t17%Dost.komp.',
    'HKL\tTCN\t301\t1\t!production!\t\t\t11%Akcept.p.prod.\t11%Akcept.p.prod.',
    'HKL\tTCN\t301\t2\t!production!\t\t\t11%Akcept.p.prod.\t22%Wyc.plast.',
    'HKL\tTCN\t302\t1\t!sent!\t\t\t100%Wyslane\tAnulacja'
].join('\r\n');

test('MAXSTATUSPROD: decyduje najwyższy status pozycji, nie bieżący STATUSPROD', () => {
    const idx = buildProgressIndex(parseStatusFile(FILE_MAX));
    assert.deepEqual(decide(order({ order_idx: 300 }), idx), { allowed: true, percent: 17 });
    assert.deepEqual(decide(order({ order_idx: 301 }), idx), { allowed: false, percent: 22 }, 'teraz 11%, ale było 22%');
    assert.equal(decide(order({ order_idx: 302 }), idx).allowed, false, 'MAX = Anulacja (bez %)');
});

test('MAXSTATUSPROD: pusty albo brak kolumny (starszy plik) → STATUSPROD', () => {
    assert.equal(maxStatusProd({ STATUSPROD: '11%Akcept.p.prod.', MAXSTATUSPROD: '' }), '11%Akcept.p.prod.');
    assert.equal(maxStatusProd({ STATUSPROD: '11%Akcept.p.prod.' }), '11%Akcept.p.prod.');
    assert.equal(maxStatusProd({ STATUSPROD: '11%Akcept.p.prod.', MAXSTATUSPROD: '22%Wyc.plast.' }), '22%Wyc.plast.');
});

test('MAXSTATUSPROD: historia zapisuje najwyższy status pozycji', () => {
    const h = historyRows(parseStatusFile(FILE_MAX), '2026-11-16 12:00:00');
    assert.deepEqual(h[3], ['HKL', 'TCN', '301', '2', '22%Wyc.plast.', 22, '2026-11-16 12:00:00']);
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
    assert.deepEqual(res, [{ allowed: false, percent: 40, canceled: false }, { allowed: false, percent: null, canceled: false }]);
});

test('historia niedostępna (przed migracją): decyzja z samego pliku', async () => {
    const { deps } = fakeDeps({ history: null, record: false });
    assert.deepEqual(await clientMayChange(order(), deps), { allowed: true, percent: 15, canceled: false });
});


// ── Zlecenie anulowane przez produkcję (Wiktoria 17.11.2026) ────────────────

const FILE_ANUL = [
    'ORGANIZATIONIDENT\tUSERIDENT\tORDERNO\tORDERPOS\tSTATUS\tSHIPPINGDATE\tPARCELCODE\tSTATUSPROD\tMAXSTATUSPROD',
    'LuxanGmbH\tKN\t70\t1\t!sent!\t\t\t100%Wyslane\t100%Wyslane',
    'LuxanGmbH\tKN\t70\t2\t!sent!\t\t\tAnulacja\tAnulacja',
    'HKL\tRyver\t239\t1\t!sent!\t\t\tAnulacja\tAnulacja',
    'HKL\tRyver\t239\t2\t!sent!\t\t\tAnulacja\tAnulacja',
    // MAXSTATUSPROD „Anulacja” przy wysłanej pozycji (prawdziwy plik 19.11.2026) — to NIE jest anulowanie.
    'HKL\tRyver\t240\t1\t!sent!\t2026-09-28\t\t100%Wyslane\tAnulacja',
    // Zapowiedziany osobny STATUS dla anulowanych.
    'Cozy\tM2\t7\t1\tcancelled\t\t\t\t'
].join('\r\n');

test('anulowane przez produkcję = „Anulacja” na każdej pozycji; pojedyncza pozycja — nie', async () => {
    const canceled = buildCanceledOrders(parseStatusFile(FILE_ANUL));
    assert.deepEqual([...canceled].map(([key, o]) => [key, o.ids, [...o.positions], o.all]), [
        ['LUXANGMBH|KN|70', ['LuxanGmbH', 'KN', '70'], [2], false],
        ['HKL|RYVER|239', ['HKL', 'Ryver', '239'], [1, 2], true],
        ['COZY|M2|7', ['Cozy', 'M2', '7'], [1], true]
    ]);
    const deps = { ...fakeDeps().deps, filePath: '/fake/anul.txt', fs: { stat: async () => ({ mtimeMs: Math.random() }), readFile: async () => FILE_ANUL } };
    const res = await clientMayChangeMany([order({ user_ident: 'Ryver', order_idx: 239 }), order({ org_ident: 'LUXANGMBH', user_ident: 'KN', order_idx: 70 })], deps);
    assert.deepEqual(res.map((r) => r.canceled), [true, false], 'klucz bez wielkości liter (LuxanGmbH = LUXANGMBH)');
});

// ── Anulowanie całego zlecenia po pozycjach w eFormie (Wiktoria 20.11.2026) ──

const FILE_NR16 = [
    'ORGANIZATIONIDENT\tUSERIDENT\tORDERNO\tORDERPOS\tSTATUS\tSHIPPINGDATE\tPARCELCODE\tSTATUSPROD\tMAXSTATUSPROD',
    // KN_Wohnen_Neubrandenburg nr 16: wysłane 1–2 wypadły z pliku po 60 dniach, zostały anulowane 3–4.
    'LuxanGmbH\tKN_Wohnen_Neubrandenburg\t16\t3\t!sent!\t\t\tAnulacja\tAnulacja',
    'LuxanGmbH\tKN_Wohnen_Neubrandenburg\t16\t4\t!sent!\t\t\tAnulacja\tAnulacja',
    'HKL\tRyver\t50\t1\t!sent!\t\t\tAnulacja\tAnulacja',
    'HKL\tRyver\t50\t2\t!sent!\t\t\tAnulacja\tAnulacja',
    // podpozycje: 1-1 anulowana, 1-2 wysłana → pozycja 1 NIE jest anulowana
    'HKL\tRyver\t51\t1-1\t!sent!\t\t\tAnulacja\tAnulacja',
    'HKL\tRyver\t51\t1-2\t!sent!\t2026-11-02\t\t100%Wyslane\t100%Wyslane',
    'HKL\tRyver\t51\t2\t!sent!\t\t\tAnulacja\tAnulacja'
].join('\r\n');

test('anulowanie całego zlecenia: każda pozycja w eFormie, nie tylko te z pliku (KN_Wohnen nr 16)', () => {
    const canceled = buildCanceledOrders(parseStatusFile(FILE_NR16));
    assert.equal(canceled.get('LUXANGMBH|KN_WOHNEN_NEUBRANDENBURG|16').all, true, 'w pliku same anulowane…');
    const items = (id, org, user, no, positions) => positions.map((orderpos) => ({ id, org_ident: org, user_ident: user, order_idx: no, orderpos }));
    const rows = [
        ...items(1967, 'LUXANGMBH', 'KN_Wohnen_Neubrandenburg', '16', [1, 2, 3, 4]),
        ...items(10, 'HKL', 'Ryver', '50', [1, 2]),
        ...items(11, 'HKL', 'Ryver', '50', [null, 0]), // bez orderpos → numer z kolejności (jak widok)
        ...items(12, 'HKL', 'Ryver', '51', [1, 2])
    ];
    assert.deepEqual(fullyCanceledOrderIds(rows, canceled), [10, 11], '…ale nr 16 ma w eFormie wysłane 1–2; 51: pozycja 1 częściowo wysłana');
    assert.deepEqual([...canceled.get('HKL|RYVER|51').positions], [2]);
});
