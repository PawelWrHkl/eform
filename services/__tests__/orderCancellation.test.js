'use strict';

/**
 * Anulowanie wysłanego zlecenia (services/orderCancellation.js).
 * Baza, system plików i FTP są atrapami — test nie potrzebuje MySQL ani sieci.
 */

const test = require('node:test');
const assert = require('node:assert');

const cancellation = require('../orderCancellation');
const { buildOrderFileName } = require('../../utils/orderFileName');

const {
    cancelSentOrder,
    getCancellationInfo,
    attachCancelDeadlines,
    buildCancelMarkerName,
    cancellationWindowStart,
    wallClockNow,
    formatDeadlineLabel,
    canRoleCancel,
    isActorBlocked,
    describeActor,
    RESULT_MESSAGE_KEYS
} = cancellation;

// 2026-09-28 12:00 w Warszawie (CEST = UTC+2).
const NOW = new Date('2026-09-28T10:00:00Z');
const NOW_WALL = '2026-09-28 12:00:00';
const WINDOW_START = '2026-09-27 12:00:00';

const klient = { userId: 7, ident: 'ryver', pin: '1234', isOwner: false, isAdmin: false };

/** Zlecenie w bazie: wysłane 2 h temu (okno otwarte), nazwa pliku HKL_ryver_242. */
function sentOrder(overrides = {}) {
    return {
        id: 3100,
        status: 'sent',
        order_idx: '242',
        user_id: 7,
        employee_id: null,
        group_user_id: null,
        user_ident: 'ryver',
        org_ident: 'HKL',
        sent_at: '2026-09-28 10:00:00',
        cancel_deadline: '2026-09-29 10:00:00',
        within_window: 1,
        seconds_left: 22 * 3600,
        ...overrides
    };
}

/** Atrapa bazy: zapamiętuje wywołania w kolejności (razem z atrapą fs/FTP). */
function fakeWorld({ state = sentOrder(), markResult = 1, statusAfter = 'canceled', record = null, deadlines = [] } = {}) {
    const calls = [];
    const db = {
        getOrderCancellationState: async (orderId, window) => {
            calls.push(['getOrderCancellationState', orderId, window]);
            return typeof state === 'function' ? state() : state;
        },
        markOrderCanceled: async (orderId, data) => {
            calls.push(['markOrderCanceled', orderId, data]);
            return markResult;
        },
        getOrderStatus: async (orderId) => {
            calls.push(['getOrderStatus', orderId]);
            return statusAfter;
        },
        getOrderCancellationRecord: async (orderId) => {
            calls.push(['getOrderCancellationRecord', orderId]);
            return record;
        },
        getCancelableOrderDeadlines: async (ids, window) => {
            calls.push(['getCancelableOrderDeadlines', ids, window]);
            return deadlines;
        }
    };
    const files = {};
    const fs = {
        mkdir: async (dir, opts) => { calls.push(['mkdir', dir, opts]); },
        writeFile: async (file, content) => { calls.push(['writeFile', file, content]); files[file] = content; }
    };
    const ftp = { accessed: null, uploads: [], closed: 0 };
    const ftpClientFactory = () => ({
        access: async (cfg) => { calls.push(['ftp.access', cfg.host]); ftp.accessed = cfg; },
        uploadFrom: async (local, remote) => { calls.push(['ftp.uploadFrom', local, remote]); ftp.uploads.push({ local, remote }); },
        close: () => { ftp.closed += 1; }
    });
    const logs = [];
    const deps = {
        db,
        fs,
        ftpClientFactory,
        outputData: '/mnt/eform/datatest/out',
        isProduction: () => false,
        env: { FTP_HOST: 'ftp.example', FTP_USER: 'u', FTP_PASSWORD: 'p' },
        log: (...args) => logs.push(args.join(' ')),
        now: () => NOW
    };
    return { deps, calls, files, ftp, logs };
}

const ctxKlienta = (extra = {}) => ({ orderId: '3100', sessionUser: klient, ...extra });

// ── Nazwa pliku ──────────────────────────────────────────────────────────────

test('znacznik ma DOKŁADNIE nazwę wysłanego JSON-a z rozszerzeniem .cancel', () => {
    // Przykład z wymagań: HKL_ryver_242.json → HKL_ryver_242.cancel
    assert.equal(buildOrderFileName('HKL', 'ryver', '242'), 'HKL_ryver_242');
    assert.equal(buildCancelMarkerName({ orgIdent: 'HKL', userIdent: 'ryver', orderNo: '242' }), 'HKL_ryver_242.cancel');
    // Numer zamówienia sklepu grupy ma postać `12-3` — nazwa nadal się składa.
    assert.equal(buildCancelMarkerName({ orgIdent: 'TCN', userIdent: 'abc', orderNo: '12-3' }), 'TCN_abc_12-3.cancel');
});

test('wysyłka JSON-a korzysta z tej samej funkcji nazwy (utils/saveOrdersOutput.js)', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../../utils/saveOrdersOutput.js'), 'utf8');
    assert.match(source, /require\('\.\/orderFileName'\)/);
    assert.match(source, /this\.fileName = buildOrderFileName\(this\.orgIdent, this\.userIdent, this\.orderNo, suffix\)/);
});

// ── Czas ─────────────────────────────────────────────────────────────────────

test('„teraz" liczone w czasie warszawskim, latem i zimą', () => {
    assert.equal(wallClockNow(NOW), NOW_WALL);
    assert.equal(wallClockNow(new Date('2026-01-28T10:00:00Z')), '2026-01-28 11:00:00');
});

test('okno anulowania zaczyna się dokładnie 24 h przed „teraz"', () => {
    assert.equal(cancellationWindowStart(NOW_WALL), WINDOW_START);
    // Przełom miesiąca/roku
    assert.equal(cancellationWindowStart('2027-01-01 00:30:00'), '2026-12-31 00:30:00');
});

test('termin pokazywany w formacie eFormu', () => {
    assert.equal(formatDeadlineLabel('2026-09-29 10:00:00'), '29.09.2026 10:00');
    assert.equal(formatDeadlineLabel(null), '');
    assert.equal(formatDeadlineLabel('bzdura'), '');
});

// ── Uprawnienia ──────────────────────────────────────────────────────────────

test('kto może anulować: klient, owner, admin, grupa — tak; sklep grupy — nie', () => {
    assert.equal(canRoleCancel(klient), true);
    assert.equal(canRoleCancel({ ...klient, isOwner: true }), true);
    assert.equal(canRoleCancel({ ...klient, isAdmin: true, isOwner: true }), true);
    assert.equal(canRoleCancel({ ...klient, isGroup: true }), true);
    assert.equal(canRoleCancel({ ...klient, isGroupShop: true }), false, 'sklep nie wysyła sam, więc i nie anuluje');
    assert.equal(canRoleCancel(null), false);
});

test('pracownik: potrzebuje can_send_orders, a bez can_see_all_orders — tylko własne zlecenia', () => {
    const pracownik = { userId: 7, isEmployee: true };
    assert.equal(canRoleCancel(pracownik, { can_send_orders: false }), false);
    assert.equal(canRoleCancel(pracownik, { can_send_orders: true }), true);

    const ctx = { sessionUser: pracownik, sessionEmployee: { id: 5 }, employeePermissions: { can_send_orders: true, can_see_all_orders: false } };
    assert.equal(isActorBlocked({ employee_id: 5 }, ctx), false, 'własne');
    assert.equal(isActorBlocked({ employee_id: 9 }, ctx), true, 'cudze');
    assert.equal(isActorBlocked({ employee_id: null }, ctx), true, 'założone przez właściciela');

    const wszystkie = { ...ctx, employeePermissions: { can_send_orders: true, can_see_all_orders: true } };
    assert.equal(isActorBlocked({ employee_id: 9 }, wszystkie), false);
});

test('audyt: kto anulował', () => {
    assert.equal(describeActor({ sessionUser: klient }), 'user:ryver');
    assert.equal(describeActor({ sessionUser: { isAdmin: true, isOwner: true, ident: 'admin' }, contextUser: { ident: 'ryver' } }), 'admin:admin -> ryver');
    assert.equal(describeActor({ sessionUser: { isOwner: true, ident: 'HKL' } }), 'owner:HKL');
    assert.equal(describeActor({ sessionUser: { isEmployee: true }, sessionEmployee: { id: 12, login: 'jan' } }), 'employee:12 (jan)');
    assert.equal(describeActor({ sessionUser: { isGroup: true, ident: 'TCN' } }), 'group:TCN');
    assert.ok(describeActor({ sessionUser: { ident: 'x'.repeat(300) } }).length <= 100, 'mieści się w VARCHAR(100)');
});

// ── Anulowanie: ścieżka szczęśliwa ───────────────────────────────────────────

test('anulowanie poza produkcją: pusty znacznik w outputData, potem status w bazie', async () => {
    const { deps, calls, files, ftp } = fakeWorld();
    const wynik = await cancelSentOrder(ctxKlienta(), deps);

    assert.equal(wynik.success, true);
    assert.equal(wynik.status, 200);
    assert.equal(wynik.code, 'canceled');
    assert.equal(wynik.fileName, 'HKL_ryver_242.cancel');
    assert.equal(wynik.delivery, 'local');

    assert.deepStrictEqual(files, { '/mnt/eform/datatest/out/HKL_ryver_242.cancel': '' }, 'plik pusty, obok JSON-a');
    assert.equal(ftp.uploads.length, 0, 'poza produkcją bez FTP');

    const mark = calls.find(c => c[0] === 'markOrderCanceled');
    assert.equal(mark[1], 3100);
    assert.deepStrictEqual(mark[2], { canceledAt: NOW_WALL, canceledBy: 'user:ryver', windowStart: WINDOW_START });
});

test('KOLEJNOŚĆ: znacznik powstaje PRZED zmianą statusu', async () => {
    const { deps, calls } = fakeWorld();
    await cancelSentOrder(ctxKlienta(), deps);
    const order = calls.map(c => c[0]);
    assert.ok(order.indexOf('writeFile') < order.indexOf('markOrderCanceled'), order.join(' → '));
});

test('sprawdzenie okna i UPDATE dostają TEN SAM początek okna', async () => {
    // Inaczej zlecenie, które przeszło sprawdzenie o 11:59:59, mogłoby „przeterminować
    // się" w trakcie wysyłki znacznika — znacznik na FTP, status bez zmian.
    const { deps, calls } = fakeWorld();
    await cancelSentOrder(ctxKlienta(), deps);
    const check = calls.find(c => c[0] === 'getOrderCancellationState')[2];
    const mark = calls.find(c => c[0] === 'markOrderCanceled')[2];
    assert.equal(check.windowStart, WINDOW_START);
    assert.equal(check.now, NOW_WALL);
    assert.equal(check.windowHours, 24);
    assert.equal(mark.windowStart, check.windowStart);
});

test('produkcja: znacznik idzie na FTP do /orders-out/ pod tą samą nazwą', async () => {
    const { deps, ftp, files } = fakeWorld();
    deps.isProduction = () => true;
    const wynik = await cancelSentOrder(ctxKlienta(), deps);

    assert.equal(wynik.success, true);
    assert.equal(wynik.delivery, 'ftp');
    assert.deepStrictEqual(ftp.uploads, [{ local: '/mnt/eform/datatest/out/HKL_ryver_242.cancel', remote: '/orders-out/HKL_ryver_242.cancel' }]);
    assert.deepStrictEqual(
        { host: ftp.accessed.host, user: ftp.accessed.user, password: ftp.accessed.password, secure: ftp.accessed.secure },
        { host: 'ftp.example', user: 'u', password: 'p', secure: false }
    );
    assert.equal(ftp.closed, 1, 'połączenie zamknięte');
    assert.equal(files['/mnt/eform/datatest/out/HKL_ryver_242.cancel'], '', 'lokalna kopia zostaje');
});

// ── Awarie: nic nie może zostać „anulowane w połowie" ────────────────────────

test('awaria FTP: status NIE zmienia się, klient dostaje błąd do ponowienia', async () => {
    const { deps, calls, ftp } = fakeWorld();
    deps.isProduction = () => true;
    deps.ftpClientFactory = () => ({
        access: async () => { throw new Error('ECONNREFUSED'); },
        uploadFrom: async () => { ftp.uploads.push('nie powinno'); },
        close: () => { ftp.closed += 1; }
    });
    const wynik = await cancelSentOrder(ctxKlienta(), deps);

    assert.equal(wynik.success, false);
    assert.equal(wynik.status, 502);
    assert.equal(wynik.code, 'marker_failed');
    assert.equal(calls.some(c => c[0] === 'markOrderCanceled'), false, 'bez zapisu statusu');
    assert.equal(ftp.closed, 1, 'połączenie zamknięte także po błędzie');
});

test('awaria zapisu lokalnego pliku: status NIE zmienia się', async () => {
    const { deps, calls } = fakeWorld();
    deps.fs.writeFile = async () => { throw new Error('EACCES'); };
    const wynik = await cancelSentOrder(ctxKlienta(), deps);
    assert.equal(wynik.code, 'marker_failed');
    assert.equal(calls.some(c => c[0] === 'markOrderCanceled'), false);
});

test('błąd bazy po udanym znaczniku: 500 i ślad w logu (ponowienie dokończy zapis)', async () => {
    const { deps, logs } = fakeWorld({ markResult: null });
    const wynik = await cancelSentOrder(ctxKlienta(), deps);
    assert.equal(wynik.status, 500);
    assert.equal(wynik.code, 'server_error');
    assert.ok(logs.some(l => l.includes('HKL_ryver_242.cancel') && l.includes('NIE został zmieniony')), logs.join('\n'));
});

test('wyścig dwóch kart: UPDATE nic nie zmienił, ale zlecenie jest już anulowane → sukces', async () => {
    const { deps } = fakeWorld({ markResult: 0, statusAfter: 'canceled' });
    const wynik = await cancelSentOrder(ctxKlienta(), deps);
    assert.equal(wynik.success, true);
    assert.equal(wynik.code, 'already_canceled');
});

test('status zmienił się w międzyczasie (np. korekta admina) → 409 i ostrzeżenie w logu', async () => {
    const { deps, logs } = fakeWorld({ markResult: 0, statusAfter: 'correction' });
    const wynik = await cancelSentOrder(ctxKlienta(), deps);
    assert.equal(wynik.status, 409);
    assert.equal(wynik.code, 'not_sent');
    assert.ok(logs.some(l => l.includes("'correction'")));
});

// ── Odmowy: bez znacznika i bez zmian w bazie ────────────────────────────────

async function assertRefused(worldOpts, ctx, expected) {
    const { deps, calls, files } = fakeWorld(worldOpts);
    const wynik = await cancelSentOrder(ctx, deps);
    assert.equal(wynik.success, expected.success ?? false);
    assert.equal(wynik.status, expected.status);
    assert.equal(wynik.code, expected.code);
    assert.deepStrictEqual(files, {}, 'żadnego znacznika');
    assert.equal(calls.some(c => c[0] === 'markOrderCanceled'), false, 'bez zapisu statusu');
}

test('po 24 h: odmowa „minął czas"', async () => {
    await assertRefused({ state: sentOrder({ within_window: 0, seconds_left: -60 }) }, ctxKlienta(), { status: 409, code: 'window_expired' });
});

test('zlecenie niewysłane (aktywne, do zatwierdzenia, w korekcie): odmowa', async () => {
    for (const status of ['active', 'pending_approval', 'correction', null]) {
        await assertRefused({ state: sentOrder({ status }) }, ctxKlienta(), { status: 409, code: 'not_sent' });
    }
});

test('już anulowane: sukces bez ponownego znacznika (idempotencja)', async () => {
    await assertRefused({ state: sentOrder({ status: 'canceled' }) }, ctxKlienta(), { success: true, status: 200, code: 'already_canceled' });
});

test('nie ma takiego zlecenia / zły identyfikator: 404', async () => {
    await assertRefused({ state: null }, ctxKlienta(), { status: 404, code: 'not_found' });
    await assertRefused({}, ctxKlienta({ orderId: 'abc' }), { status: 404, code: 'not_found' });
});

test('sklep grupy i pracownik bez uprawnień: 403', async () => {
    await assertRefused({}, ctxKlienta({ sessionUser: { ...klient, isGroupShop: true } }), { status: 403, code: 'forbidden' });
    await assertRefused({}, ctxKlienta({
        sessionUser: { userId: 7, isEmployee: true },
        sessionEmployee: { id: 5 },
        employeePermissions: { can_send_orders: false }
    }), { status: 403, code: 'forbidden' });
});

test('brak składnika nazwy pliku: nie zgadujemy nazwy — 500 bez znacznika', async () => {
    await assertRefused({ state: sentOrder({ org_ident: null }) }, ctxKlienta(), { status: 500, code: 'server_error' });
});

test('każdy kod wyniku ma klucz tłumaczenia', () => {
    for (const code of ['canceled', 'already_canceled', 'not_found', 'forbidden', 'not_sent', 'window_expired', 'marker_failed', 'server_error']) {
        assert.match(RESULT_MESSAGE_KEYS[code] || '', /^cancel_order\./, code);
    }
});

// ── Podgląd i lista ──────────────────────────────────────────────────────────

test('podgląd: w oknie → przycisk z terminem i pozostałym czasem', async () => {
    const { deps } = fakeWorld();
    const info = await getCancellationInfo(3100, { sessionUser: klient }, deps);
    assert.deepStrictEqual(info, {
        status: 'sent',
        canceled: false,
        cancelable: true,
        canCancel: true,
        deadlineLabel: '29.09.2026 10:00',
        secondsLeft: 22 * 3600,
        canceledAtLabel: ''
    });
});

test('podgląd: sklep grupy widzi termin, ale bez przycisku', async () => {
    const { deps } = fakeWorld();
    const info = await getCancellationInfo(3100, { sessionUser: { ...klient, isGroupShop: true } }, deps);
    assert.equal(info.cancelable, true);
    assert.equal(info.canCancel, false);
});

test('podgląd: po terminie — bez przycisku', async () => {
    const { deps } = fakeWorld({ state: sentOrder({ within_window: 0, seconds_left: -5 }) });
    const info = await getCancellationInfo(3100, { sessionUser: klient }, deps);
    assert.equal(info.cancelable, false);
    assert.equal(info.canCancel, false);
    assert.equal(info.secondsLeft, 0);
});

test('podgląd anulowanego: data anulowania z bazy', async () => {
    const { deps } = fakeWorld({ state: sentOrder({ status: 'canceled', within_window: 1 }), record: { canceled_at_label: '28.09.2026 12:00', canceled_by: 'user:ryver' } });
    const info = await getCancellationInfo(3100, { sessionUser: klient }, deps);
    assert.equal(info.canceled, true);
    assert.equal(info.cancelable, false, 'anulowanego nie anuluje się drugi raz');
    assert.equal(info.canceledAtLabel, '28.09.2026 12:00');
});

test('lista wysłanych: termin tylko przy zleceniach, które baza uznała za możliwe do anulowania', async () => {
    const { deps, calls } = fakeWorld({ deadlines: [{ id: 2, cancel_deadline: '2026-09-29 08:15:00', seconds_left: 3600 }] });
    const orders = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await attachCancelDeadlines(orders, { sessionUser: klient }, deps);

    assert.deepStrictEqual(calls.find(c => c[0] === 'getCancelableOrderDeadlines')[1], [1, 2, 3]);
    assert.equal(orders[0].cancelDeadlineLabel, undefined);
    assert.equal(orders[1].cancelDeadlineLabel, '29.09.2026 08:15');
    assert.equal(orders[1].cancelSecondsLeft, 3600);
    assert.equal(orders[2].cancelDeadlineLabel, undefined);
});

test('lista wysłanych: rola bez prawa anulowania nie pyta nawet bazy', async () => {
    const { deps, calls } = fakeWorld();
    const orders = [{ id: 1 }];
    await attachCancelDeadlines(orders, { sessionUser: { ...klient, isGroupShop: true } }, deps);
    assert.equal(calls.length, 0);
    assert.equal(orders[0].cancelDeadlineLabel, undefined);
});
