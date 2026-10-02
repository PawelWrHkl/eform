const { usersPath } = require('../config.js');
const path = require('path');
const fs = require('fs').promises;
const { convertToSQLDate } = require('../utils/humanize_date.js');
const { log } = require('../utils/logging');

/** Eksport systemu produkcyjnego, nadpisywany z zewnątrz — eForm go tylko czyta. */
const STATUS_FILE = path.join(usersPath, 'status.txt');


/**
 * `status.txt` → tablica wierszy `{ ORGANIZATIONIDENT, USERIDENT, ORDERNO,
 * ORDERPOS, STATUS, SHIPPINGDATE, PARCELCODE }` (nazwy kolumn z nagłówka).
 *
 * Kolumny rozdziela tabulator; gdy linia go nie ma, dzielimy po białych
 * znakach (stary format pliku). ⚠️ Ident klienta potrafi zawierać spację
 * („Gonska Polsterei_SV"), dlatego tabulator ma pierwszeństwo.
 *
 * @param {string|null} content
 * @returns {Array<Record<string, string>>}
 */
function parseStatusFile(content) {
    if (content === null || content === undefined) return [];

    const lines = String(content)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    if (lines.length === 0) return [];

    const headerLine = lines[0];
    let headers = headerLine.split(/\t+/).map(h => h.trim()).filter(Boolean);
    if (headers.length <= 1) {
        headers = headerLine.split(/\s+/).map(h => h.trim()).filter(Boolean);
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        let values = lines[i].split(/\t+/).map(v => v.trim());
        if (values.length <= 1) {
            values = lines[i].split(/\s+/).map(v => v.trim());
        }
        const rowObj = {};
        for (let j = 0; j < headers.length; j++) {
            rowObj[headers[j]] = values[j] ?? '';
        }
        rows.push(rowObj);
    }
    return rows;
}

/**
 * Klucz pozycji w `position_statuses`: (klient, nr zamówienia, pozycja).
 * Wielkie litery, bo MySQL porównuje te kolumny bez rozróżniania wielkości
 * liter — klucz w JS musi dawać te same dopasowania co `WHERE` w bazie.
 */
function statusKey(userIdent, orderIdx, orderPos) {
    return [userIdent, orderIdx, orderPos].map(v => String(v ?? '').trim().toUpperCase()).join('|');
}

/** Pola porównywane z bazą — w tej samej postaci, w jakiej zapisuje je `db/statuses.js`. */
function comparable(status, shippingDate, parcelCode) {
    return {
        status: String(status ?? '').trim(),
        shippingDate: shippingDate ? String(shippingDate).slice(0, 10) : '',
        parcelCode: String(parcelCode ?? '').trim()
    };
}

/**
 * Co trzeba zapisać, żeby `position_statuses` odpowiadała plikowi.
 *
 * Czysta funkcja (bez I/O) — całe porównanie da się sprawdzić testem. Zasady:
 *  - wiersz pliku bez klienta w eForm jest pomijany (nie ma czego aktualizować),
 *  - `ORDERNO` musi być liczbą całkowitą (`position_statuses.order_idx` to INT),
 *  - powtórzony klucz w pliku: wygrywa ostatni wiersz — tak samo jak przy
 *    dotychczasowej synchronizacji wiersz po wierszu,
 *  - wiersze z bazy, których nie ma w pliku, zostają (plik to okno czasowe,
 *    a historia statusów jest pokazywana w szczegółach zamówienia).
 *
 * @param {Array<Record<string, string>>} fileRows  wynik `parseStatusFile`
 * @param {Array<Record<string, any>>} dbRows       wiersze `position_statuses`
 * @param {Iterable<string>} knownUserIdents        identy klientów eForm
 * @returns {{ inserts: object[], updates: object[], orders: Array<{ userIdent: string, orderIdx: number }>, allOrders: Array<{ userIdent: string, orderIdx: number }>, stats: Record<string, number> }}
 */
function diffStatuses(fileRows, dbRows, knownUserIdents) {
    const known = new Set([...knownUserIdents].map(ident => String(ident).trim().toUpperCase()));

    const existing = new Map();
    for (const row of dbRows || []) {
        const key = statusKey(row.user_ident, row.order_idx, row.order_pos);
        if (!existing.has(key)) existing.set(key, []);
        existing.get(key).push(comparable(row.status, row.shipping_date, row.parcel_code));
    }

    const stats = { fileRows: fileRows.length, unknownUser: 0, invalid: 0, unchanged: 0 };
    const latest = new Map();
    for (const row of fileRows) {
        const userIdent = String(row.USERIDENT ?? '').trim();
        const orderNo = String(row.ORDERNO ?? '').trim();
        if (!userIdent || !/^\d+$/.test(orderNo)) { stats.invalid++; continue; }
        if (!known.has(userIdent.toUpperCase())) { stats.unknownUser++; continue; }
        const record = { ...row, USERIDENT: userIdent, ORDERNO: Number(orderNo), ORDERPOS: String(row.ORDERPOS ?? '').trim() };
        latest.set(statusKey(userIdent, record.ORDERNO, record.ORDERPOS), record);
    }

    const inserts = [];
    const updates = [];
    const touched = new Map();
    const all = new Map();
    for (const [key, record] of latest) {
        const orderKey = statusKey(record.USERIDENT, record.ORDERNO, '');
        const order = { userIdent: record.USERIDENT, orderIdx: record.ORDERNO };
        all.set(orderKey, order);

        const want = comparable(record.STATUS, convertToSQLDate(record.SHIPPINGDATE), record.PARCELCODE);
        const have = existing.get(key);
        if (!have) {
            inserts.push(record);
        } else if (have.some(h => h.status !== want.status || h.shippingDate !== want.shippingDate || h.parcelCode !== want.parcelCode)) {
            updates.push(record);
        } else {
            stats.unchanged++;
            continue;
        }
        touched.set(orderKey, order);
    }

    return { inserts, updates, orders: [...touched.values()], allOrders: [...all.values()], stats };
}

/**
 * Synchronizacja statusów produkcji WSZYSTKICH klientów z `status.txt`.
 *
 * ⚠️ Dawniej robiło to wejście klienta w „Zamówienia wysłane" — i tylko dla
 * niego. Klient, który nie zaglądał na tę stronę, miał w bazie stare statusy,
 * a od `order.prod_status = '!sent!'` zależy automatyczne wystawianie faktur,
 * więc synchronizacja chodzi teraz cyklicznie w osobnym procesie
 * (`scripts/prodStatusSync.js`, uruchamiany przez `services/prodStatusScheduler.js`).
 *
 * Zapisujemy tylko różnice: jeden SELECT całej tabeli zamiast dwóch zapytań na
 * każdy z ~3 tys. wierszy pliku. Nagłówki zamówień (`prod_status`,
 * `delivery_date`, `spedition_numbers`) przeliczamy dla zamówień, których
 * pozycje się zmieniły, a z `full: true` — dla wszystkich z pliku.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] tylko policz różnice, nic nie zapisuj
 * @param {boolean} [opts.full=false]   przelicz nagłówki wszystkich zamówień z pliku
 * @param {string} [opts.filePath]
 * @param {Object} [opts.deps]          `{ db, readFile, log }` — podmiana w testach
 * @returns {Promise<Record<string, any>>} podsumowanie przebiegu
 */
async function syncAllProdStatuses({ dryRun = false, full = false, filePath = STATUS_FILE, deps = {} } = {}) {
    const statusDb = deps.db || require('../db/statuses.js');
    const readFile = deps.readFile || ((p) => fs.readFile(p, 'utf-8'));
    const logger = deps.log || log;
    const startedAt = Date.now();

    let content;
    try {
        content = await readFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger(`[prodStatus] brak pliku ${filePath} — synchronizacja pominięta`);
            return { skipped: 'no-file', filePath };
        }
        throw error;
    }

    const [dbRows, idents] = await Promise.all([
        statusDb.getAllPositionStatuses(),
        statusDb.getKnownUserIdents()
    ]);
    const diff = diffStatuses(parseStatusFile(content), dbRows, idents);
    const orders = full ? diff.allOrders : diff.orders;
    const summary = {
        ...diff.stats,
        inserted: diff.inserts.length,
        updated: diff.updates.length,
        failed: 0,
        ordersSynced: orders.length,
        dryRun
    };

    if (!dryRun) {
        // `insertStatus`/`updateStatus` połykają błąd i zwracają `false`
        // (konwencja `db/core`) — liczymy to jako nieudany zapis.
        for (const record of diff.inserts) {
            if (!(await statusDb.insertStatus(record))) summary.failed++;
        }
        for (const record of diff.updates) {
            if (!(await statusDb.updateStatus(record))) summary.failed++;
        }
        for (const order of orders) {
            if (!(await statusDb.syncOrderFromStatuses(order.userIdent, order.orderIdx))) summary.failed++;
        }
    }

    summary.durationMs = Date.now() - startedAt;
    logger(`[prodStatus] ${dryRun ? 'DRY-RUN ' : ''}plik: ${summary.fileRows} wierszy, nowe: ${summary.inserted}, zmienione: ${summary.updated}, `
        + `bez zmian: ${summary.unchanged}, poza eForm: ${summary.unknownUser}, błędne: ${summary.invalid}, `
        + `zamówienia: ${summary.ordersSynced}${full ? ' (pełne)' : ''}, błędy zapisu: ${summary.failed}, ${summary.durationMs} ms`);
    return summary;
}

function setParcelHref(statuses) {
    if (!Array.isArray(statuses)) {
        return statuses;
    }
    for (const status of statuses) {
        let [parcel, code] = status.parcel_code?.split(' ') ?? ['', ''];
        if (code) {
            switch (parcel) {
                case 'DPD':
                    status.parcel_href = `https://www.dpd.com.pl/tracking/?parcelNumber=${code}`;
                    break;
                case 'UPS':
                    status.parcel_href = `https://www.ups.com/track?loc=en_US&tracknum=${code}`;
                    break;
                case 'DHL':
                    status.parcel_href = `https://www.dhl.com/en/express/tracking.html?AWB=${code}&brand=DHL`;
                    break;
                default:
                    status.parcel_href = null;
            }
        }
    }

    return statuses;
}

function parseSpeditionNumbers(speditionNumbersJson) {
    if (!speditionNumbersJson) {
        return [];
    }

    try {
        const parcelCodes = typeof speditionNumbersJson === 'string'
            ? JSON.parse(speditionNumbersJson)
            : speditionNumbersJson;

        if (!Array.isArray(parcelCodes)) {
            return [];
        }

        return parcelCodes.map(parcelCode => {
            if (!parcelCode) return null;

            const [carrier, code] = parcelCode.split(' ');
            if (!code) return { carrier: 'N/A', code: parcelCode, href: null, fullCode: parcelCode };

            let href = null;
            switch (carrier) {
                case 'DPD':
                    href = `https://www.dpd.com.pl/tracking/?parcelNumber=${code}`;
                    break;
                case 'UPS':
                    href = `https://www.ups.com/track?loc=en_US&tracknum=${code}`;
                    break;
                case 'DHL':
                    href = `https://www.dhl.com/en/express/tracking.html?AWB=${code}&brand=DHL`;
                    break;
            }

            return {
                carrier,
                code,
                href,
                fullCode: parcelCode
            };
        }).filter(item => item !== null);
    } catch (error) {
        // log('Error parsing spedition numbers: ' + error);
        return [];
    }
}


/**
 * Numer pozycji zamówienia wyciągnięty z ORDERPOS.
 *
 * ⚠️ ORDERPOS z pliku produkcji NIE jest liczbą. Występują:
 *   `7`        — zwykła pozycja,
 *   `1-1`,`1-2`— PODPOZYCJE jednej pozycji zamówienia (np. rozbicie na paczki
 *                albo na elementy zestawu),
 *   `B793638`  — kod produkcyjny bez odniesienia do numeru pozycji.
 * Dlatego bierzemy wiodącą liczbę, a gdy jej nie ma — `null` (taki status nie
 * przypina się do żadnego wiersza, ale nadal zostaje zapisany w bazie).
 *
 * @param {string|number} orderPos
 * @returns {number|null}
 */
function positionNumber(orderPos) {
    const match = String(orderPos ?? '').trim().match(/^(\d+)/);
    return match ? Number(match[1]) : null;
}

/** Im wyżej na liście, tym bardziej „blokujący" status dla całej pozycji. */
const BLOCKING_ORDER = ['!backorder!', '!preparation!', '!production!'];

/**
 * Statusy ustawione w kolejności POZYCJI zamówienia.
 *
 * ⚠️ Widok parował dotąd statusy z wierszami po ZWYKŁYM INDEKSIE
 * (`statuses[globalIndex - 1]`). Przy schemacie `1-1`, `1-2` jedna pozycja ma
 * kilka statusów, więc liczba statusów przestaje się zgadzać z liczbą wierszy —
 * i od pierwszej podpozycji każdy kolejny wiersz pokazywałby CUDZY status.
 *
 * Gdy pozycja ma kilka podpozycji, pokazujemy tę, która realnie wstrzymuje
 * wysyłkę: dowolny status inny niż `!sent!` wygrywa (od najbardziej
 * blokującego), a jeśli wszystkie wyszły — ten z NAJPÓŹNIEJSZĄ datą wysyłki,
 * bo pozycja jest kompletna dopiero z ostatnią paczką.
 *
 * @param {Array<Record<string, any>>} statuses  wiersze `position_statuses`
 * @param {Array<Record<string, any>>} orderItems pozycje zamówienia (z `orderpos`)
 * @returns {Array<Record<string, any>|null>} tablica równoległa do `orderItems`
 */
function alignStatusesToItems(statuses, orderItems) {
    if (!Array.isArray(statuses) || statuses.length === 0) return [];
    if (!Array.isArray(orderItems) || orderItems.length === 0) return statuses;

    const byPosition = new Map();
    let matched = 0;
    for (const status of statuses) {
        const pos = positionNumber(status.order_pos);
        if (pos === null) continue;
        if (!byPosition.has(pos)) byPosition.set(pos, []);
        byPosition.get(pos).push(status);
        matched++;
    }

    // Żaden status nie ma numeru pozycji (same kody produkcyjne) — zostawiamy
    // dotychczasowe parowanie po indeksie, żeby nic nie zniknęło z widoku.
    if (matched === 0) return statuses;

    return orderItems.map((item, index) => {
        const pos = Number(item.orderpos) || (index + 1);
        const group = byPosition.get(pos);
        if (!group || group.length === 0) return null;
        if (group.length === 1) return group[0];

        const blocking = BLOCKING_ORDER
            .map((code) => group.find((s) => s.status === code))
            .find(Boolean);
        if (blocking) return { ...blocking, subPositions: group.length };

        const latest = group.reduce((acc, s) => (
            String(s.shipping_date || '') > String(acc.shipping_date || '') ? s : acc
        ), group[0]);
        return { ...latest, subPositions: group.length };
    });
}

module.exports = {
    STATUS_FILE,
    parseStatusFile,
    statusKey,
    diffStatuses,
    syncAllProdStatuses,
    setParcelHref,
    parseSpeditionNumbers,
    positionNumber,
    alignStatusesToItems
};