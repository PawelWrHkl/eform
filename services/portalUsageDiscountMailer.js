/**
 * Powiadomienie o pierwszym zamówieniu nowego klienta LUXANGMBH.
 *
 * Wysyłane raz na klienta, w momencie **wysłania** (nie utworzenia) jego
 * pierwszego zamówienia — porzucony szkic to nie jest złożone zamówienie.
 *
 * ⚠️ Jednorazowość opiera się na DANYCH, nie na fladze: mail idzie tylko wtedy,
 * gdy to zamówienie jest jedynym wysłanym zamówieniem tego klienta. Nie ma więc
 * dodatkowej kolumny, którą trzeba by pilnować, a ponowne wywołanie dla tego
 * samego zamówienia niczego nie zduplikuje.
 *
 * ⚠️ Adresaci WYŁĄCZNIE z `PORTAL_DISCOUNT_NOTIFY_EMAIL`. Świadomie bez
 * fallbacku na `EXTRA_MAIL` — skopiowanie tamtego wzorca wysłało kiedyś testowy
 * raport na produkcyjny adres importu. Brak zmiennej = pominięta wysyłka z
 * wpisem w logu.
 */

'use strict';

const nodemailer = require('nodemailer');
const { selectQuery } = require('../db/core');
const { log } = require('../utils/logging');
const { isEligibleUser, PORTAL_DISCOUNT_PERCENT } = require('./portalUsageDiscount');
const { isEnabled: isDiscountSwitchEnabled } = require('./portalUsageDiscountSwitch');

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

function recipients() {
    const raw = process.env.PORTAL_DISCOUNT_NOTIFY_EMAIL;
    if (!raw) return [];
    return raw.split(',').map((address) => address.trim()).filter(Boolean);
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
 * @returns {Promise<{sent:boolean, reason?:string, client?:string}>}
 */
async function notifyFirstOrderIfApplicable(orderId) {
    try {
        // Osobne sprawdzenie, a nie poleganie na `isEligibleUser()`: ta funkcja
        // mówi o uprawnieniu klienta, a nie o tym, czy rabat jest włączony.
        // Mail informuje „klient dostał 1%", więc przy wyłączonym przełączniku
        // byłby po prostu nieprawdą.
        if (!isDiscountSwitchEnabled()) {
            return { sent: false, reason: 'rabat za korzystanie z serwisu jest wyłączony przełącznikiem admina' };
        }

        const rows = await selectQuery(
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

        // Mail dotyczy wyłącznie klientów, którzy faktycznie dostali rabat.
        if (!(await isEligibleUser(row.user_id))) {
            return { sent: false, reason: 'klient nie jest objęty rabatem za korzystanie z serwisu' };
        }

        const to = recipients();
        if (!to.length) {
            log('[portalUsageDiscount] brak PORTAL_DISCOUNT_NOTIFY_EMAIL — pomijam powiadomienie');
            return { sent: false, reason: 'brak adresatów' };
        }

        const client = formatClient(row);
        const text = `Klient ${client} złożył pierwsze zamówienie w eForm i dostał ${PORTAL_DISCOUNT_PERCENT}% rabatu`
            + ' z tytułu korzystania z serwisu.\n\n'
            + `Numer zamówienia: ${orderId}\n`;

        await transporter.sendMail({
            from: process.env.MAILBOT_USER,
            to: to.join(','),
            subject: `eForm: pierwsze zamówienie klienta ${client} — rabat ${PORTAL_DISCOUNT_PERCENT}%`,
            text
        });

        log(`[portalUsageDiscount] powiadomienie o pierwszym zamówieniu klienta ${client} wysłane do ${to.join(',')}`);
        return { sent: true, client };
    } catch (err) {
        // Powiadomienie nie może przewrócić wysyłki zamówienia.
        log('[portalUsageDiscount] nie udało się wysłać powiadomienia:', err.message);
        return { sent: false, reason: err.message };
    }
}

module.exports = { notifyFirstOrderIfApplicable, formatClient };
