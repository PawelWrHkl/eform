/**
 * Powiadomienie o PIERWSZYM zamówieniu klienta.
 *
 * Wysyłane raz na klienta, w momencie **wysłania** (nie utworzenia) jego
 * pierwszego zamówienia — porzucony szkic to nie jest złożone zamówienie.
 *
 * ⚠️ Do 2026-09-22 mail dotyczył wyłącznie klientów objętych ekstra rabatem
 * i brzmiał „klient dostał 1%". Od przeniesienia rabatu do `user.extra_rabat`
 * (kolumna wystartowała pusta u wszystkich) taki warunek znaczyłby, że mail
 * NIGDY nie pojedzie. Decyzja właściciela: powiadomienie ma iść przy pierwszym
 * zamówieniu **każdego** klienta, a rabat jest tylko dopiskiem, gdy klient go
 * ma. Stąd nowa nazwa pliku — z rabatem łączy go już tylko ten dopisek.
 *
 * ⚠️ Jednorazowość opiera się na DANYCH, nie na fladze: mail idzie tylko wtedy,
 * gdy to zamówienie jest jedynym wysłanym zamówieniem tego klienta. Nie ma więc
 * dodatkowej kolumny, którą trzeba by pilnować, a ponowne wywołanie dla tego
 * samego zamówienia niczego nie zduplikuje.
 *
 * ⚠️ Liczymy po `sent_date IS NOT NULL`, a nie po `status = 'sent'`. Admin może
 * cofnąć zamówienie do `active` i wysłać je ponownie (`PATCH
 * /order/:id/toggle-status`) — przy liczeniu po statusie licznik wróciłby do 1
 * i mail poszedłby drugi raz. `sent_date` raz postawiona już nie znika.
 *
 * ⚠️ Przełącznik admina rabatu (`portalUsageDiscountSwitch`) NIE bramkuje tego
 * maila. Przełącznik mówi „czy rozdajemy rabat", a to powiadomienie mówi
 * „klient złożył pierwsze zamówienie" — zgaszenie rabatu nie może uciszyć
 * informacji o nowym kliencie. Dopisek o rabacie jest osobno bramkowany, bo on
 * faktycznie zależy od rabatu.
 *
 * ⚠️ Adresaci mają DOMYŚLNĄ listę w kodzie, żeby powiadomienie działało od razu
 * po wdrożeniu także tam, gdzie nie da się dopisać zmiennej do `.env`.
 * Zmienne `FIRST_ORDER_NOTIFY_EMAIL` / `FIRST_ORDER_NOTIFY_CC` nadpisują listę.
 * ⚠️ Świadomie NOWE nazwy zmiennych: stara `PORTAL_DISCOUNT_NOTIFY_EMAIL` siedzi
 * w `.env` środowisk z czterema adresami sprzed tej zmiany i nadpisywałaby
 * nową listę po cichu. Nadal bez fallbacku na `EXTRA_MAIL` — skopiowanie tamtego
 * wzorca wysłało kiedyś testowy raport na produkcyjny adres importu.
 */

'use strict';

const nodemailer = require('nodemailer');
const { selectQuery } = require('../db/core');
const { log } = require('../utils/logging');
const { getUserExtraDiscount } = require('./portalUsageDiscount');

/** Adresat główny, gdy `FIRST_ORDER_NOTIFY_EMAIL` nie jest ustawiona. */
const DEFAULT_NOTIFY_TO = ['krzysztof.krawczyk@hkl.eu'];
/** Do wiadomości, gdy `FIRST_ORDER_NOTIFY_CC` nie jest ustawiona. */
const DEFAULT_NOTIFY_CC = ['grzegorz.fijalkowski@hkl.eu', 'pawel.woroniecki@hkl.eu'];

const transporter = nodemailer.createTransport({
    host: 'serwer2560216.home.pl',
    port: 587,
    secure: false,
    auth: {
        user: process.env.MAILBOT_USER,
        pass: process.env.MAILBOT_PASSWORD
    },
    tls: { rejectUnauthorized: false }
});

/** Lista adresów ze zmiennej środowiskowej albo domyślna z kodu. */
function addressList(envValue, domyslne) {
    const raw = (envValue || '').trim();
    if (!raw) return [...domyslne];
    return raw.split(',').map((address) => address.trim()).filter(Boolean);
}

/** Procent po polsku: 1 → „1", 2.5 → „2,5" (bez zer na końcu). */
function formatPercent(value) {
    return String(Number(value)).replace('.', ',');
}

/** Nazwa klienta do treści maila — czytelna, z identyfikatorem w nawiasie. */
function formatClient(user) {
    const name = (user.client_name || '').trim();
    const ident = (user.ident || '').trim();
    if (name && ident && name !== ident) return `${name} (${ident})`;
    return name || ident || `użytkownik #${user.id}`;
}

/**
 * @param {number|string} orderId zamówienie, które właśnie zostało wysłane
 * @param {object} [deps] wstrzyknięcia do testów (`select`, `sendMail`, `log`, `env`)
 * @returns {Promise<{sent:boolean, reason?:string, client?:string}>}
 */
async function notifyFirstOrderIfApplicable(orderId, deps = {}) {
    const select = deps.select || selectQuery;
    const sendMail = deps.sendMail || ((message) => transporter.sendMail(message));
    const zapisz = deps.log || log;
    const env = deps.env || process.env;

    try {
        const rows = await select(
            `SELECT o.user_id, u.ident, u.client_name, u.id,
                    (SELECT COUNT(*) FROM \`order\` s
                      WHERE s.user_id = o.user_id AND s.sent_date IS NOT NULL) AS wyslanych
               FROM \`order\` o
               JOIN \`user\` u ON u.id = o.user_id
              WHERE o.id = ?`,
            [orderId]
        );
        const row = rows && rows[0];
        if (!row) return { sent: false, reason: 'nie znaleziono zamówienia' };

        // Pierwsze wysłane zamówienie tego klienta — i tylko ono.
        if (Number(row.wyslanych) !== 1) {
            return { sent: false, reason: `to nie pierwsze wysłane zamówienie klienta (${row.wyslanych})` };
        }

        const to = addressList(env.FIRST_ORDER_NOTIFY_EMAIL, DEFAULT_NOTIFY_TO);
        if (!to.length) {
            zapisz('[firstOrder] FIRST_ORDER_NOTIFY_EMAIL jest puste — pomijam powiadomienie');
            return { sent: false, reason: 'brak adresatów' };
        }
        const cc = addressList(env.FIRST_ORDER_NOTIFY_CC, DEFAULT_NOTIFY_CC);

        // Rabat to już tylko DOPISEK — brak rabatu nie wstrzymuje maila.
        const extraDiscount = await getUserExtraDiscount(row.user_id, deps);
        const dopisekORabacie = extraDiscount > 0
            ? `Ekstra rabat klienta: ${formatPercent(extraDiscount)}% (user.extra_rabat).\n`
            : '';

        const client = formatClient(row);
        const text = `Klient ${client} złożył pierwsze zamówienie w eForm.\n\n`
            + `Numer zamówienia: ${orderId}\n`
            + dopisekORabacie;

        await sendMail({
            from: env.MAILBOT_USER,
            to: to.join(','),
            ...(cc.length ? { cc: cc.join(',') } : {}),
            subject: `eForm: pierwsze zamówienie klienta ${client}`,
            text
        });

        zapisz(`[firstOrder] powiadomienie o pierwszym zamówieniu klienta ${client} wysłane do ${to.join(',')}`
            + (cc.length ? ` (DW: ${cc.join(',')})` : ''));
        return { sent: true, client };
    } catch (err) {
        // Powiadomienie nie może przewrócić wysyłki zamówienia.
        zapisz('[firstOrder] nie udało się wysłać powiadomienia:', err.message);
        return { sent: false, reason: err.message };
    }
}

module.exports = {
    notifyFirstOrderIfApplicable,
    formatClient,
    DEFAULT_NOTIFY_TO,
    DEFAULT_NOTIFY_CC
};
