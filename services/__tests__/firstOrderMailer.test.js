'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    notifyFirstOrderIfApplicable,
    DEFAULT_NOTIFY_TO,
    DEFAULT_NOTIFY_CC
} = require('../firstOrderMailer');

/** Baza-atrapa: zwraca to, co podstawimy, i zapamiętuje zapytania. */
function fakeSelect(odpowiedzi) {
    const wywolania = [];
    const select = async (sql, params) => {
        wywolania.push({ sql, params });
        const kolejna = odpowiedzi.shift();
        if (kolejna instanceof Error) throw kolejna;
        return kolejna ?? [];
    };
    select.wywolania = wywolania;
    return select;
}

/** Zebrane maile zamiast prawdziwej wysyłki. */
function fakeMailer() {
    const wyslane = [];
    const sendMail = async (message) => { wyslane.push(message); return { messageId: 'test' }; };
    sendMail.wyslane = wyslane;
    return sendMail;
}

/** Klient z jednym wysłanym zamówieniem i podanym rabatem. */
function pierwszeZamowienie({ extraRabat = '0.00', wyslanych = 1 } = {}) {
    return fakeSelect([
        [{ user_id: 42, ident: 'ABC', client_name: 'Klient ABC', id: 42, wyslanych }],
        [{ extra_rabat: extraRabat }]
    ]);
}

const cicho = { log: () => {}, env: {} };

test('pierwsze wysłane zamówienie wysyła mail na domyślną listę z kodu', async () => {
    // ⚠️ Domyślna lista MUSI działać bez zmiennych środowiskowych — kontenery
    // mają własne pliki `.env`, do których nie sięgamy przy wdrożeniu.
    const sendMail = fakeMailer();
    const wynik = await notifyFirstOrderIfApplicable(3100, { ...cicho, select: pierwszeZamowienie(), sendMail });

    assert.equal(wynik.sent, true);
    assert.equal(sendMail.wyslane.length, 1);

    const mail = sendMail.wyslane[0];
    assert.equal(mail.to, DEFAULT_NOTIFY_TO.join(','));
    assert.equal(mail.to, 'krzysztof.krawczyk@hkl.eu');
    assert.equal(mail.cc, DEFAULT_NOTIFY_CC.join(','));
    assert.equal(mail.cc, 'grzegorz.fijalkowski@hkl.eu,pawel.woroniecki@hkl.eu');
    assert.match(mail.subject, /pierwsze zamówienie klienta Klient ABC \(ABC\)/);
    assert.match(mail.text, /złożył pierwsze zamówienie w eForm/);
    assert.match(mail.text, /Numer zamówienia: 3100/);
});

test('mail idzie dla klienta BEZ rabatu — i nie wspomina o rabacie', async () => {
    // Sedno zmiany z 2026-09-22: wcześniej brak rabatu wstrzymywał wysyłkę,
    // więc przy pustej kolumnie `extra_rabat` mail nie poszedłby nigdy.
    const sendMail = fakeMailer();
    const wynik = await notifyFirstOrderIfApplicable(3100, {
        ...cicho, select: pierwszeZamowienie({ extraRabat: '0.00' }), sendMail
    });

    assert.equal(wynik.sent, true);
    assert.doesNotMatch(sendMail.wyslane[0].text, /rabat/i, 'bez rabatu ani słowa o rabacie');
});

test('klient z rabatem dostaje dopisek z własnym procentem', async () => {
    const sendMail = fakeMailer();
    await notifyFirstOrderIfApplicable(3100, {
        ...cicho, select: pierwszeZamowienie({ extraRabat: '2.50' }), sendMail
    });

    assert.match(sendMail.wyslane[0].text, /Ekstra rabat klienta: 2,5%/);
});

test('zmienne środowiskowe nadpisują obie listy', async () => {
    const sendMail = fakeMailer();
    await notifyFirstOrderIfApplicable(3100, {
        log: () => {},
        select: pierwszeZamowienie(),
        sendMail,
        env: {
            FIRST_ORDER_NOTIFY_EMAIL: 'szef@hkl.eu , biuro@hkl.eu',
            FIRST_ORDER_NOTIFY_CC: 'archiwum@hkl.eu'
        }
    });

    assert.equal(sendMail.wyslane[0].to, 'szef@hkl.eu,biuro@hkl.eu', 'spacje przycięte');
    assert.equal(sendMail.wyslane[0].cc, 'archiwum@hkl.eu');
});

test('stara zmienna PORTAL_DISCOUNT_NOTIFY_EMAIL nie ma już wpływu', async () => {
    // ⚠️ Siedzi w `.env` środowisk z listą sprzed tej zmiany (4 adresy).
    // Gdyby nadal działała, po cichu nadpisywałaby nową listę.
    const sendMail = fakeMailer();
    await notifyFirstOrderIfApplicable(3100, {
        log: () => {},
        select: pierwszeZamowienie(),
        sendMail,
        env: { PORTAL_DISCOUNT_NOTIFY_EMAIL: 'stary.adres@hkl.eu' }
    });

    assert.equal(sendMail.wyslane[0].to, DEFAULT_NOTIFY_TO.join(','));
    assert.doesNotMatch(sendMail.wyslane[0].to, /stary\.adres/);
});

test('drugie i kolejne zamówienie klienta nie wysyła nic', async () => {
    const sendMail = fakeMailer();
    const wynik = await notifyFirstOrderIfApplicable(3100, {
        ...cicho, select: pierwszeZamowienie({ wyslanych: 2 }), sendMail
    });

    assert.equal(wynik.sent, false);
    assert.match(wynik.reason, /nie pierwsze wysłane/);
    assert.equal(sendMail.wyslane.length, 0);
});

test('jednorazowość liczy się po sent_date, nie po statusie', async () => {
    // Admin może cofnąć zamówienie do `active` i wysłać ponownie
    // (PATCH /order/:id/toggle-status). Przy liczeniu po `status = 'sent'`
    // licznik wróciłby do 1 i mail poszedłby drugi raz.
    const select = pierwszeZamowienie();
    await notifyFirstOrderIfApplicable(3100, { ...cicho, select, sendMail: fakeMailer() });

    const { sql } = select.wywolania[0];
    assert.match(sql, /sent_date IS NOT NULL/);
    assert.doesNotMatch(sql, /status\s*=\s*'sent'/);
});

test('nieznane zamówienie nie wysyła nic', async () => {
    const sendMail = fakeMailer();
    const wynik = await notifyFirstOrderIfApplicable(9999, { ...cicho, select: fakeSelect([[]]), sendMail });

    assert.equal(wynik.sent, false);
    assert.equal(sendMail.wyslane.length, 0);
});

test('lista adresatów wyczyszczona do zera pomija wysyłkę z wpisem w logu', async () => {
    const wpisy = [];
    const sendMail = fakeMailer();
    const wynik = await notifyFirstOrderIfApplicable(3100, {
        log: (...a) => wpisy.push(a),
        select: pierwszeZamowienie(),
        sendMail,
        env: { FIRST_ORDER_NOTIFY_EMAIL: ' , , ' }
    });

    assert.equal(wynik.sent, false);
    assert.equal(sendMail.wyslane.length, 0);
    assert.equal(wpisy.length, 1);
});

test('błąd bazy ani błąd wysyłki nie przewracają wysyłki zamówienia', async () => {
    const wynik1 = await notifyFirstOrderIfApplicable(3100, {
        ...cicho, select: fakeSelect([new Error('baza padła')]), sendMail: fakeMailer()
    });
    assert.equal(wynik1.sent, false);
    assert.equal(wynik1.reason, 'baza padła');

    const wynik2 = await notifyFirstOrderIfApplicable(3100, {
        ...cicho,
        select: pierwszeZamowienie(),
        sendMail: async () => { throw new Error('serwer pocztowy nie odpowiada'); }
    });
    assert.equal(wynik2.sent, false);
    assert.equal(wynik2.reason, 'serwer pocztowy nie odpowiada');
});
