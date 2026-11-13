const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveOrderAbPolicy,
  resolveConfirmationRecipients,
  policyFromUserRow
} = require('../confirmationPolicy');

const PAWEL = 'pawel.woroniecki@hkl.eu';
const KRZYSIEK = 'krzysztof.krawczyk@hkl.eu';

/* ---------------------------------------------------------------- */
/* Odczyt zasad z wiersza `user`                                    */
/* ---------------------------------------------------------------- */

test('polityka z wiersza user: wartości z bazy w naturalnych typach', () => {
  // Tak wygląda wiersz klienta TCN: tinyint 1, język wielkimi literami.
  const p = policyFromUserRow({ ab_type: 'without_price', ab_lang: 'NL', client_ab: 1, delivery_delay: 10, extra_ab_mail: 'extra@hkl.eu' });
  assert.deepEqual(p, { withoutPrices: true, abLang: 'nl', clientAb: true, deliveryDelay: 10, extraAbMail: 'extra@hkl.eu' });
});

test('polityka z wiersza user: brak ustawień = zachowanie dotychczasowe', () => {
  const puste = { withoutPrices: false, abLang: null, clientAb: false, deliveryDelay: 0, extraAbMail: null };
  assert.deepEqual(policyFromUserRow({ ab_type: null, ab_lang: null, client_ab: null, delivery_delay: null, extra_ab_mail: null }), puste);
  assert.deepEqual(policyFromUserRow({}), puste);
  assert.deepEqual(policyFromUserRow(null), puste);
});

test('polityka z wiersza user: pusty extra_ab_mail (spacje) traktowany jak brak', () => {
  const p = policyFromUserRow({ extra_ab_mail: '   ' });
  assert.equal(p.extraAbMail, null);
});

test('polityka z wiersza user: literówka w kolumnie nie wysadza wysyłki', () => {
  const p = policyFromUserRow({ ab_type: 'WITHOUT_PRICES  ', ab_lang: 'es', client_ab: '1', delivery_delay: 'abc' });
  assert.equal(p.withoutPrices, true, 'oba zapisy ab_type i inna wielkość liter');
  assert.equal(p.abLang, null, 'nieznany język → domyślny, nie wyjątek');
  assert.equal(p.clientAb, true, 'string z formularza');
  assert.equal(p.deliveryDelay, 0, 'niepoprawna liczba → brak opóźnienia');
});

test('polityka po orderId: jedno zapytanie po właścicielu zamówienia', async () => {
  let sql = null;
  let params = null;
  const p = await resolveOrderAbPolicy(202, {
    selectQuery: async (q, d) => { sql = q; params = d; return [{ ab_type: 'without_price', ab_lang: 'NL', client_ab: 1, delivery_delay: 10, extra_ab_mail: 'extra@hkl.eu' }]; }
  });
  assert.deepEqual(params, [202]);
  assert.match(sql, /JOIN `user` u ON u\.id = o\.user_id/, 'liczy się właściciel zamówienia');
  assert.match(sql, /u\.extra_ab_mail/, 'dodatkowy odbiorca musi wejść do zapytania');
  assert.deepEqual(p, { withoutPrices: true, abLang: 'nl', clientAb: true, deliveryDelay: 10, extraAbMail: 'extra@hkl.eu' });
});

test('polityka po orderId: błąd bazy nie blokuje potwierdzenia', async () => {
  const zalogowane = [];
  const p = await resolveOrderAbPolicy(1, {
    selectQuery: async () => { throw new Error('brak połączenia'); },
    log: (...a) => zalogowane.push(a.join(' '))
  });
  assert.deepEqual(p, { withoutPrices: false, abLang: null, clientAb: false, deliveryDelay: 0, extraAbMail: null });
  assert.equal(zalogowane.length, 1, 'awaria musi zostawić ślad w logu');
});

test('polityka po orderId: brak zamówienia i brak id', async () => {
  assert.equal((await resolveOrderAbPolicy(999, { selectQuery: async () => false })).clientAb, false);
  assert.equal((await resolveOrderAbPolicy(null)).abLang, null, 'brak id nie odpytuje bazy');
});

/* ---------------------------------------------------------------- */
/* Odbiorcy potwierdzenia                                          */
/* ---------------------------------------------------------------- */

test('dev/test bez client_ab: mail nie wychodzi do klienta', () => {
  ['dev', 'test'].forEach((env) => {
    const r = resolveConfirmationRecipients({
      env, clientAb: false, confirmationEmail: 'klient@example.nl',
      organizationEmail: 'org@hkl.eu', organizationEmail2: 'szef@hkl.eu'
    });
    assert.equal(r.mainRecipient, PAWEL, env);
    assert.deepEqual(r.bccList, [KRZYSIEK], env);
    // ⚠️ Sedno tej gałęzi: żaden prawdziwy adres klienta ani organizacji.
    assert.ok(!r.bcc.includes('klient@example.nl'), env);
    assert.ok(!r.bcc.includes('org@hkl.eu'), env);
  });
});

test('client_ab: klient jest głównym odbiorcą — także na dev/test', () => {
  const dev = resolveConfirmationRecipients({
    env: 'test', clientAb: true, confirmationEmail: 'klient@example.nl',
    organizationEmail: 'org@hkl.eu'
  });
  assert.equal(dev.mainRecipient, 'klient@example.nl');
  assert.deepEqual(dev.bccList, [KRZYSIEK, PAWEL]);

  const prod = resolveConfirmationRecipients({
    env: 'production', clientAb: true, confirmationEmail: 'klient@example.nl',
    organizationEmail: 'org@hkl.eu', organizationEmail2: 'szef@hkl.eu'
  });
  assert.equal(prod.mainRecipient, 'klient@example.nl');
  assert.deepEqual(prod.bccList, ['org@hkl.eu', 'szef@hkl.eu', PAWEL], 'organizacja dostaje kopię');
});

test('client_ab bez adresu kontaktowego nie może zostawić maila bez odbiorcy', () => {
  const dev = resolveConfirmationRecipients({ env: 'test', clientAb: true, confirmationEmail: null });
  assert.equal(dev.mainRecipient, PAWEL, 'na dev wracamy na skrzynkę deweloperską');

  const prod = resolveConfirmationRecipients({
    env: 'production', clientAb: true, confirmationEmail: null, organizationEmail: 'org@hkl.eu'
  });
  assert.equal(prod.mainRecipient, 'org@hkl.eu', 'na produkcji odbiorcą zostaje organizacja');
});

test('POP-14: produkcja bez client_ab: klient w Do, organizacja i reszta HKL w BCC', () => {
  const r = resolveConfirmationRecipients({
    env: 'production', clientAb: false, confirmationEmail: 'klient@example.nl',
    organizationEmail: 'org@hkl.eu', organizationEmail2: 'szef@hkl.eu',
    extraMail: ['extra1@hkl.eu', 'extra2@hkl.eu']
  });
  assert.equal(r.mainRecipient, 'klient@example.nl');
  // EXTRA_MAIL jest tablicą z .env — musi zostać spłaszczona, nie wklejona jako tablica
  assert.deepEqual(r.bccList, ['org@hkl.eu', 'szef@hkl.eu', 'extra1@hkl.eu', 'extra2@hkl.eu', PAWEL]);
});

test('extra_ab_mail: dodatkowy odbiorca dopisany do BCC obok pozostałych adresów', () => {
  const r = resolveConfirmationRecipients({
    env: 'production', clientAb: false, confirmationEmail: 'klient@example.nl',
    organizationEmail: 'org@hkl.eu', organizationEmail2: 'szef@hkl.eu',
    extraAbMail: 'wlasciciel-ab@hkl.eu'
  });
  assert.equal(r.mainRecipient, 'klient@example.nl');
  assert.deepEqual(r.bccList, ['org@hkl.eu', 'szef@hkl.eu', PAWEL, 'wlasciciel-ab@hkl.eu']);
});

test('extra_ab_mail: brak wartości nie dodaje śmiecia do BCC', () => {
  const r = resolveConfirmationRecipients({
    env: 'production', clientAb: false, confirmationEmail: null,
    organizationEmail: 'org@hkl.eu', organizationEmail2: null, extraMail: false, extraAbMail: null
  });
  assert.equal(r.bcc, PAWEL);
});

test('puste adresy nie tworzą śmieci w nagłówku BCC', () => {
  const r = resolveConfirmationRecipients({
    env: 'production', clientAb: false, confirmationEmail: null,
    organizationEmail: 'org@hkl.eu', organizationEmail2: null, extraMail: false
  });
  assert.equal(r.bcc, PAWEL, 'bez przecinków wiodących i pustych pozycji');
});

test('POP-14: AB jak #361 — klient widzi w nagłówkach tylko siebie, kopie HKL idą w kopercie', async () => {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const { buildMailOptions } = require('../mailBot/mailBot');
  // Adresy organizacji HKL jak w tabeli `organization`; EXTRA_MAIL i SKRZYNKA_DEV jak w nagłówkach #361.
  const hkl = ['ordersefor@hkl.eu', 'eforszefhkl@hkl.eu', 'e-orders@hkl.eu', PAWEL, 'biuro@hkl.eu'];
  const { mainRecipient, bcc } = resolveConfirmationRecipients({
    env: 'production', clientAb: false, confirmationEmail: 'info@klient.example.nl',
    organizationEmail: hkl[0], organizationEmail2: hkl[1], extraMail: [hkl[2]]
  });
  // Tak jak w routes/orders.js: lista z polityki pozycyjnie, kopia konta biura w `options.bcc`.
  const options = buildMailOptions(mainRecipient, 'nl', Buffer.alloc(10, 0x41), [],
    { orderNr: '361', klient: 'Klient BV', logoPath: '/nonexistent.png' },
    bcc, 'mailTemplate.njk', 'mail.subject', { htmlContent: '<p>x</p>', bcc: hkl[4] });
  const mail = new MailComposer(options).compile();
  const raw = await new Promise((resolve, reject) => mail.build((err, m) => (err ? reject(err) : resolve(m.toString('binary')))));
  const headers = raw.split('\r\n\r\n')[0];

  assert.match(headers, /^To: info@klient\.example\.nl$/m);
  assert.doesNotMatch(headers, /^(Cc|Bcc):/mi);
  assert.doesNotMatch(headers, /hkl\.eu/i, 'żaden adres HKL w nagłówkach');
  assert.deepEqual(mail.getEnvelope().to.sort(), ['info@klient.example.nl', ...hkl].sort(), 'kopie HKL dochodzą');
});
