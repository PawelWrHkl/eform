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
  const p = policyFromUserRow({ ab_type: 'without_price', ab_lang: 'NL', client_ab: 1, delivery_delay: 10 });
  assert.deepEqual(p, { withoutPrices: true, abLang: 'nl', clientAb: true, deliveryDelay: 10 });
});

test('polityka z wiersza user: brak ustawień = zachowanie dotychczasowe', () => {
  const puste = { withoutPrices: false, abLang: null, clientAb: false, deliveryDelay: 0 };
  assert.deepEqual(policyFromUserRow({ ab_type: null, ab_lang: null, client_ab: null, delivery_delay: null }), puste);
  assert.deepEqual(policyFromUserRow({}), puste);
  assert.deepEqual(policyFromUserRow(null), puste);
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
    selectQuery: async (q, d) => { sql = q; params = d; return [{ ab_type: 'without_price', ab_lang: 'NL', client_ab: 1, delivery_delay: 10 }]; }
  });
  assert.deepEqual(params, [202]);
  assert.match(sql, /JOIN `user` u ON u\.id = o\.user_id/, 'liczy się właściciel zamówienia');
  assert.deepEqual(p, { withoutPrices: true, abLang: 'nl', clientAb: true, deliveryDelay: 10 });
});

test('polityka po orderId: błąd bazy nie blokuje potwierdzenia', async () => {
  const zalogowane = [];
  const p = await resolveOrderAbPolicy(1, {
    selectQuery: async () => { throw new Error('brak połączenia'); },
    log: (...a) => zalogowane.push(a.join(' '))
  });
  assert.deepEqual(p, { withoutPrices: false, abLang: null, clientAb: false, deliveryDelay: 0 });
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

test('produkcja bez client_ab: odbiorcą organizacja, klient w BCC', () => {
  const r = resolveConfirmationRecipients({
    env: 'production', clientAb: false, confirmationEmail: 'klient@example.nl',
    organizationEmail: 'org@hkl.eu', organizationEmail2: 'szef@hkl.eu',
    extraMail: ['extra1@hkl.eu', 'extra2@hkl.eu']
  });
  assert.equal(r.mainRecipient, 'org@hkl.eu');
  // EXTRA_MAIL jest tablicą z .env — musi zostać spłaszczona, nie wklejona jako tablica
  assert.deepEqual(r.bccList, ['klient@example.nl', 'szef@hkl.eu', 'extra1@hkl.eu', 'extra2@hkl.eu', PAWEL]);
});

test('puste adresy nie tworzą śmieci w nagłówku BCC', () => {
  const r = resolveConfirmationRecipients({
    env: 'production', clientAb: false, confirmationEmail: null,
    organizationEmail: 'org@hkl.eu', organizationEmail2: null, extraMail: false
  });
  assert.equal(r.bcc, PAWEL, 'bez przecinków wiodących i pustych pozycji');
});
