const { usersPath } = require('../config.js');
const path = require('path');
const fs = require('fs').promises;
const db = require("../db/db_helper.js");
const { log } = require('../utils/logging');


class SyncProdStatus {
    constructor() {
        this.filePath = path.join(usersPath, 'status.txt');
        this.data = null;
        this.orgIdent = null;
        this.userIdent = null;
    }

    async init(orgIdent, userIdent) {
        this.orgIdent = orgIdent;
        this.userIdent = userIdent;
        await this.loadData();
        return await this.convertDataIntoObject();
    }

    async loadData() {
        try {
            const fileContent = await fs.readFile(this.filePath, 'utf-8');
            this.data = fileContent;
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.data = null;
            } else {
                throw error;
            }
        }
    }

    async convertDataIntoObject() {
        if (this.data === null) {
            return null;
        }

        const lines = this.data
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (lines.length === 0) {
            return [];
        }

        const headerLine = lines[0];
        let headers = headerLine.split(/\t+/).map(h => h.trim()).filter(Boolean);
        if (headers.length <= 1) {
            headers = headerLine.split(/\s+/).map(h => h.trim()).filter(Boolean);
        }

        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            let values = line.split(/\t+/).map(v => v.trim());
            if (values.length <= 1) {
                values = line.split(/\s+/).map(v => v.trim());
            }

            if (values.length === 0) {
                continue;
            }

            const rowObj = {};
            for (let j = 0; j < headers.length; j++) {
                rowObj[headers[j]] = values[j] ?? '';
            }

            if (rowObj.ORGANIZATIONIDENT?.toUpperCase() === this.orgIdent?.toUpperCase() && rowObj.USERIDENT?.toUpperCase() === this.userIdent?.toUpperCase()) {
                log('Znaleziono pasujący rekord:', rowObj);
                rows.push(rowObj);
            }
        }

        this.statusesData = rows;
        await this.checkIfStatusExistInDb();
        return this.statusesData;
    }

    async checkIfStatusExistInDb() {
        if (!this.statusesData || this.statusesData.length === 0) {
            return;
        }
        for (const record of this.statusesData) {
            const exists = await db.checkIfStatusExists(record);
            if (exists && exists.length > 0) {
                let result = await db.updateStatus(record);

            } else {
                let result = await db.insertStatus(record);

            }
        }

        const uniqueOrders = [...new Set(this.statusesData.map(r => r.ORDERNO))];
        for (const orderIdx of uniqueOrders) {
            await db.syncOrderFromStatuses(this.userIdent, orderIdx);
        }
    }


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

module.exports = { SyncProdStatus, setParcelHref, parseSpeditionNumbers, positionNumber, alignStatusesToItems };