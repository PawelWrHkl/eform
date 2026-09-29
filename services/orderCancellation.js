/**
 * Anulowanie WYSŁANEGO zlecenia przez klienta — do 24 h od wysłania.
 *
 * Cykl życia zlecenia: `active` (edycja) → `sent` (wysłane, JSON na FTP
 * `/orders-out/`) → `canceled` (anulowane). Anulowania NIE DA SIĘ COFNĄĆ —
 * anulowanego zlecenia nie wyśle już żaden tor (utils/orderStatusGuard.js
 * i bramki w routes/orders.js, routes/group.js), można je co najwyżej
 * „Zamówić ponownie" jako nowe.
 *
 * Produkcja dowiaduje się o anulowaniu z PUSTEGO pliku o tej samej nazwie co
 * wysłany JSON, z rozszerzeniem `.cancel`: `HKL_ryver_242.json` →
 * `HKL_ryver_242.cancel` (nazwa z utils/orderFileName.js — tej samej funkcji,
 * której używa wysyłka).
 *
 * ⚠️ KOLEJNOŚĆ: najpierw znacznik, potem status w bazie. Odwrotnie awaria FTP
 * dawałaby najgorszy możliwy stan — klient widzi „anulowane", a produkcja
 * produkuje. W tej kolejności awaria FTP nie zmienia niczego (klient dostaje
 * błąd i może ponowić), a awaria zapisu po udanym znaczniku zostawia stan
 * „produkcja wie, eForm jeszcze nie" — ponowne kliknięcie nadpisuje ten sam
 * plik i kończy zapis. Ten sam `windowStart` idzie do sprawdzenia i do
 * `UPDATE`, więc zlecenie, które przeszło sprawdzenie, nie „przeterminuje się"
 * w trakcie wysyłania znacznika.
 *
 * ⚠️ Znacznik idzie na FTP zawsze, gdy działamy jako produkcja
 * (`PRODUCTION`) — także dla klientów z `ignore_mail_list.json`. Ich JSON mógł
 * pójść na produkcję ręcznie (checkbox „zlecenie produkcyjne"), a tego nigdzie
 * nie zapisujemy; zbędny `.cancel` dla nieznanego zlecenia jest nieszkodliwy,
 * brakujący — kosztuje wyprodukowany towar. Poza produkcją znacznik ląduje
 * lokalnie w `config.outputData`, obok JSON-a (lustro `OrderSender.saveToFile`).
 */

'use strict';

const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { buildOrderFileName } = require('../utils/orderFileName');

dayjs.extend(utc);
dayjs.extend(timezone);

const CANCELED_STATUS = 'canceled';
const CANCELLATION_WINDOW_HOURS = 24;
const CANCEL_MARKER_EXTENSION = '.cancel';
const FTP_ORDERS_OUT_DIR = '/orders-out';
const TIME_ZONE = 'Europe/Warsaw';
const DB_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/**
 * Kod wyniku → klucz tłumaczenia (`cancel_order.*` w /mnt/eform/languages).
 * Serwis zwraca kody, tekst wybiera kontroler w języku żądania.
 */
const RESULT_MESSAGE_KEYS = {
    canceled: 'cancel_order.success',
    already_canceled: 'cancel_order.already_canceled',
    not_found: 'cancel_order.error_not_found',
    forbidden: 'cancel_order.error_forbidden',
    not_sent: 'cancel_order.error_not_sent',
    window_expired: 'cancel_order.error_window_expired',
    marker_failed: 'cancel_order.error_marker',
    server_error: 'cancel_order.error_server'
};

/**
 * Domyślne zależności ładowane leniwie: `db/db_helper` otwiera połączenia do
 * MySQL już przy imporcie, a testy podają własne atrapy.
 */
function resolveDeps(deps = {}) {
    const resolved = { ...deps };
    if (!resolved.db) resolved.db = require('../db/db_helper.js');
    if (!resolved.fs) resolved.fs = require('fs').promises;
    if (!resolved.outputData) resolved.outputData = require('../config').outputData;
    if (!resolved.isProduction) resolved.isProduction = require('../utils/productionSendGuard').isProductionVersion;
    if (!resolved.ftpClientFactory) {
        resolved.ftpClientFactory = () => {
            const ftp = require('basic-ftp');
            return new ftp.Client();
        };
    }
    if (!resolved.env) resolved.env = process.env;
    if (!resolved.log) resolved.log = require('../utils/logging').log;
    if (!resolved.now) resolved.now = () => new Date();
    return resolved;
}

/** „Teraz" jako czas ścienny w Warszawie — w tym formacie baza trzyma `sent_date`. */
function wallClockNow(now) {
    return dayjs(now).tz(TIME_ZONE).format(DB_FORMAT);
}

/**
 * Początek okna anulowania: `now − 24 h` liczone na CZASIE ŚCIENNYM, tak jak
 * `DATE_ADD(sent_date, INTERVAL 24 HOUR)` w bazie (dayjs.utc = arytmetyka bez
 * strefy). Dzięki temu sprawdzenie, `UPDATE` i pokazany termin mówią to samo.
 */
function cancellationWindowStart(nowWallClock) {
    return dayjs.utc(nowWallClock).subtract(CANCELLATION_WINDOW_HOURS, 'hour').format(DB_FORMAT);
}

/** `2026-09-29 14:35:00` → `29.09.2026 14:35` (format dat w całym eFormie). */
function formatDeadlineLabel(dbDateTime) {
    if (!dbDateTime) return '';
    const parsed = dayjs.utc(String(dbDateTime));
    return parsed.isValid() ? parsed.format('DD.MM.YYYY HH:mm') : '';
}

function windowParams(deps) {
    const now = wallClockNow(deps.now());
    return { now, windowStart: cancellationWindowStart(now), windowHours: CANCELLATION_WINDOW_HOURS };
}

/** `HKL_ryver_242.cancel` — ta sama nazwa co wysłany `HKL_ryver_242.json`. */
function buildCancelMarkerName({ orgIdent, userIdent, orderNo }) {
    return `${buildOrderFileName(orgIdent, userIdent, orderNo)}${CANCEL_MARKER_EXTENSION}`;
}

/**
 * Czy ta ROLA może w ogóle anulować (niezależnie od konkretnego zlecenia).
 * Te same zasady co przy wysyłce (`POST /orders/send/:orderId`):
 *  • konto podrzędne grupy (sklep/klient) nie wysyła samo — wysyła centrala,
 *    więc i anulowanie zostaje po stronie centrali,
 *  • pracownik potrzebuje `can_send_orders` — wycofanie z produkcji waży tyle,
 *    co wysłanie na nią.
 */
function canRoleCancel(sessionUser, employeePermissions) {
    if (!sessionUser) return false;
    if (sessionUser.isGroupShop) return false;
    if (sessionUser.isEmployee && !employeePermissions?.can_send_orders) return false;
    return true;
}

/**
 * Blokada dla KONKRETNEGO zlecenia. Samą przynależność zlecenia do konta
 * sprawdza wcześniej `checkOrderOwnership`; tu dochodzi zawężenie pracownika
 * bez `can_see_all_orders` do jego własnych zleceń (jak w podglądzie historii).
 */
function isActorBlocked(order, { sessionUser, sessionEmployee, employeePermissions }) {
    if (!canRoleCancel(sessionUser, employeePermissions)) return true;
    if (sessionUser.isEmployee && !employeePermissions?.can_see_all_orders) {
        return Number(order?.employee_id) !== Number(sessionEmployee?.id);
    }
    return false;
}

/** Kto anulował — do kolumny `order.canceled_by` (audyt, max 100 znaków). */
function describeActor({ sessionUser, sessionEmployee, contextUser } = {}) {
    let label;
    if (sessionUser?.isEmployee) {
        label = `employee:${sessionEmployee?.id ?? '?'}${sessionEmployee?.login ? ` (${sessionEmployee.login})` : ''}`;
    } else if (sessionUser?.isAdmin || sessionUser?.isOwner) {
        const role = sessionUser.isAdmin ? 'admin' : 'owner';
        label = `${role}:${sessionUser.ident || sessionUser.pin || '?'}`;
        if (contextUser?.ident) label += ` -> ${contextUser.ident}`;
    } else if (sessionUser?.isGroup) {
        label = `group:${sessionUser.ident || sessionUser.pin || '?'}`;
    } else {
        label = `user:${sessionUser?.ident || sessionUser?.pin || '?'}`;
    }
    return label.slice(0, 100);
}

function isWithinWindow(state) {
    return Number(state?.within_window) === 1;
}

function secondsLeft(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}

function result(status, code, extra = {}) {
    return { success: status < 400, status, code, ...extra };
}

/**
 * Zapisuje pusty znacznik `.cancel`: lokalnie zawsze (audyt + źródło wysyłki),
 * na FTP `/orders-out/` — gdy działamy jako produkcja.
 * ⚠️ Rzuca przy każdym błędzie. W przeciwieństwie do `OrderSender.saveToFile`
 * (który błąd FTP tylko loguje) tu błąd MUSI dojść do klienta — inaczej
 * zlecenie zostałoby „anulowane" tylko w eFormie.
 */
async function writeCancelMarker(fileName, deps) {
    const localPath = path.join(deps.outputData, fileName);
    await deps.fs.mkdir(deps.outputData, { recursive: true });
    await deps.fs.writeFile(localPath, '');

    if (!deps.isProduction()) {
        return { target: 'local', localPath };
    }

    const remotePath = `${FTP_ORDERS_OUT_DIR}/${fileName}`;
    const client = deps.ftpClientFactory();
    try {
        await client.access({
            host: deps.env.FTP_HOST,
            user: deps.env.FTP_USER,
            password: deps.env.FTP_PASSWORD,
            secure: false
        });
        await client.uploadFrom(localPath, remotePath);
    } finally {
        client.close();
    }
    return { target: 'ftp', localPath, remotePath };
}

/**
 * Anuluje wysłane zlecenie.
 *
 * @param {object} ctx `{ orderId, sessionUser, sessionEmployee, employeePermissions, contextUser }`
 * @returns {Promise<{success: boolean, status: number, code: string, fileName?: string}>}
 *   `code` → klucz komunikatu w `RESULT_MESSAGE_KEYS`; `status` → kod HTTP.
 */
async function cancelSentOrder(ctx, deps) {
    const d = resolveDeps(deps);
    const orderId = parseInt(ctx?.orderId, 10);
    if (!Number.isFinite(orderId)) return result(404, 'not_found');

    const window = windowParams(d);
    const state = await d.db.getOrderCancellationState(orderId, window);
    if (!state) return result(404, 'not_found');

    if (isActorBlocked(state, ctx)) return result(403, 'forbidden');

    // Ponowne kliknięcie / druga karta — cel już osiągnięty, to nie błąd.
    if (state.status === CANCELED_STATUS) return result(200, 'already_canceled', { alreadyCanceled: true });
    if (state.status !== 'sent') return result(409, 'not_sent');
    if (!isWithinWindow(state)) return result(409, 'window_expired');

    if (!state.org_ident || !state.user_ident || !state.order_idx) {
        d.log(`[orderCancellation] zlecenie ${orderId}: brak składników nazwy pliku (org=${state.org_ident}, user=${state.user_ident}, nr=${state.order_idx}) — nie anuluję`);
        return result(500, 'server_error');
    }

    const fileName = buildCancelMarkerName({
        orgIdent: state.org_ident,
        userIdent: state.user_ident,
        orderNo: state.order_idx
    });
    const actor = describeActor(ctx);

    let delivery;
    try {
        delivery = await writeCancelMarker(fileName, d);
    } catch (err) {
        d.log(`[orderCancellation] zlecenie ${orderId}: nie udało się zapisać znacznika ${fileName} — status bez zmian:`, err?.message || err);
        return result(502, 'marker_failed');
    }

    const changed = await d.db.markOrderCanceled(orderId, {
        canceledAt: window.now,
        canceledBy: actor,
        windowStart: window.windowStart
    });

    if (changed === null) {
        d.log(`[orderCancellation] ⚠️ zlecenie ${orderId}: znacznik ${fileName} zapisany (${delivery.target}), ale status NIE został zmieniony (błąd bazy) — ponowne anulowanie dokończy zapis`);
        return result(500, 'server_error');
    }
    if (changed === 0) {
        // Ktoś był szybszy (druga karta) albo status zmienił się w międzyczasie.
        const current = await d.db.getOrderStatus(orderId);
        if (current === CANCELED_STATUS) return result(200, 'already_canceled', { alreadyCanceled: true, fileName });
        d.log(`[orderCancellation] ⚠️ zlecenie ${orderId}: znacznik ${fileName} zapisany, ale status zmienił się w międzyczasie na '${current}' — anulowanie NIE zapisane`);
        return result(409, 'not_sent');
    }

    d.log(`[orderCancellation] anulowano zlecenie ${orderId} (${fileName} → ${delivery.target}${delivery.remotePath ? ` ${delivery.remotePath}` : ''}) przez ${actor}`);
    return result(200, 'canceled', { fileName, delivery: delivery.target });
}

/**
 * Stan anulowania do podglądu wysłanego zlecenia.
 * @returns {Promise<object|null>} `{ status, canceled, cancelable, canCancel, deadlineLabel, secondsLeft, canceledAtLabel }`
 */
async function getCancellationInfo(orderId, ctx = {}, deps) {
    const d = resolveDeps(deps);
    const state = await d.db.getOrderCancellationState(orderId, windowParams(d));
    if (!state) return null;

    const canceled = state.status === CANCELED_STATUS;
    const cancelable = state.status === 'sent' && isWithinWindow(state);
    const info = {
        status: state.status,
        canceled,
        cancelable,
        canCancel: cancelable && !isActorBlocked(state, ctx),
        deadlineLabel: cancelable ? formatDeadlineLabel(state.cancel_deadline) : '',
        secondsLeft: cancelable ? secondsLeft(state.seconds_left) : 0,
        canceledAtLabel: ''
    };
    if (canceled) {
        const record = await d.db.getOrderCancellationRecord(orderId);
        info.canceledAtLabel = record?.canceled_at_label || '';
    }
    return info;
}

/**
 * Dopisuje do zleceń z listy wysłanych termin anulowania (`cancelDeadlineLabel`,
 * `cancelSecondsLeft`) — tylko tym, które jeszcze da się anulować.
 * Lista jest już zawężona do zleceń, które pytający widzi (`filterOrdersByPermission`).
 */
async function attachCancelDeadlines(orders, ctx = {}, deps) {
    if (!Array.isArray(orders) || orders.length === 0) return orders;
    if (!canRoleCancel(ctx.sessionUser, ctx.employeePermissions)) return orders;

    const d = resolveDeps(deps);
    const rows = await d.db.getCancelableOrderDeadlines(orders.map(order => order.id), windowParams(d));
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    for (const order of orders) {
        const row = byId.get(Number(order.id));
        if (!row) continue;
        order.cancelDeadlineLabel = formatDeadlineLabel(row.cancel_deadline);
        order.cancelSecondsLeft = secondsLeft(row.seconds_left);
    }
    return orders;
}

module.exports = {
    CANCELED_STATUS,
    CANCELLATION_WINDOW_HOURS,
    CANCEL_MARKER_EXTENSION,
    RESULT_MESSAGE_KEYS,
    wallClockNow,
    cancellationWindowStart,
    formatDeadlineLabel,
    buildCancelMarkerName,
    canRoleCancel,
    isActorBlocked,
    describeActor,
    writeCancelMarker,
    cancelSentOrder,
    getCancellationInfo,
    attachCancelDeadlines
};
