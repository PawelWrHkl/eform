const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeUserSettings,
  validateNewPassword,
  wouldDropOwnAdminRole,
  parseDeliveryDelay,
  parseAbLang,
  POLA
} = require('../userAdminService');

/* ---------------------------------------------------------------- */
/* Biała lista kolumn                                               */
/* ---------------------------------------------------------------- */

test('do zapisu trafiają tylko kolumny z białej listy', () => {
  const { values } = normalizeUserSettings({
    role: 'admin',
    // ⚠️ Nazwy kolumn są sklejane do SQL-a, więc nadmiarowe klucze z żądania
    // NIE mogą przejść dalej — inaczej mamy wektor wstrzyknięcia.
    password: 'x',
    pin: '9999',
    'id = 1; DROP TABLE user; --': 1
  });
  assert.deepEqual(Object.keys(values).sort(), [...POLA].sort());
});

/* ---------------------------------------------------------------- */
/* Poszczególne pola                                                */
/* ---------------------------------------------------------------- */

test('rola: dozwolone tylko admin, group i brak roli', () => {
  assert.equal(normalizeUserSettings({ role: 'admin' }).values.role, 'admin');
  assert.equal(normalizeUserSettings({ role: 'group' }).values.role, 'group');
  assert.equal(normalizeUserSettings({ role: '' }).values.role, null);

  const zly = normalizeUserSettings({ role: 'superadmin' });
  assert.equal(zly.errors.length, 1);
  assert.deepEqual(zly.values, {}, 'przy błędzie nie zapisujemy niczego');
});

test('delivery_delay: tylko liczba całkowita', () => {
  assert.equal(parseDeliveryDelay('10').value, 10);
  assert.equal(parseDeliveryDelay('').value, null, 'puste = brak opóźnienia');
  assert.equal(parseDeliveryDelay(null).value, null);
  ['5.5', '5,5', 'abc', '5 dni', '-3'].forEach((v) => {
    assert.ok(parseDeliveryDelay(v).error, `${v} musi być odrzucone`);
  });
  assert.ok(parseDeliveryDelay('1000').error, 'literówka rzędu wielkości odrzucona');
});

test('ab_lang: tylko języki z konfiguracji, zapis wielkimi literami', () => {
  // W bazie istniejący wiersz ma "NL" — trzymamy tę samą postać.
  assert.equal(parseAbLang('nl').value, 'NL');
  assert.equal(parseAbLang('NL').value, 'NL');
  assert.equal(parseAbLang('').value, null);
  assert.ok(parseAbLang('es').error, 'język poza availabeLanguages odrzucony');
});

test('ab_type: puste czyści kolumnę, wariant without_prices normalizowany', () => {
  assert.equal(normalizeUserSettings({ ab_type: '' }).values.ab_type, null);
  assert.equal(normalizeUserSettings({ ab_type: 'without_price' }).values.ab_type, 'without_price');
  assert.equal(normalizeUserSettings({ ab_type: 'without_prices' }).values.ab_type, 'without_price');
  assert.ok(normalizeUserSettings({ ab_type: 'cokolwiek' }).errors.length);
});

test('checkboxy zapisują 0/1, bo kolumny są tinyint(1)', () => {
  const zaznaczone = normalizeUserSettings({ intro_needed: true, client_ab: 'on' }).values;
  assert.equal(zaznaczone.intro_needed, 1);
  assert.equal(zaznaczone.client_ab, 1);

  // Brak klucza = checkbox odznaczony; kolumna `intro_needed` jest NOT NULL,
  // więc musi dostać 0, a nie null.
  const puste = normalizeUserSettings({}).values;
  assert.equal(puste.intro_needed, 0);
  assert.equal(puste.client_ab, 0);
});

test('e-mail: oczywista literówka odrzucona, puste czyści kolumnę', () => {
  assert.equal(normalizeUserSettings({ email: ' biuro@firma.nl ' }).values.email, 'biuro@firma.nl');
  assert.equal(normalizeUserSettings({ email: '' }).values.email, null);
  assert.ok(normalizeUserSettings({ email: 'biuro-firma.nl' }).errors.length);
});

/* ---------------------------------------------------------------- */
/* Hasło i zapora na własne konto                                   */
/* ---------------------------------------------------------------- */

test('hasło: minimalna długość i zgodność powtórzenia', () => {
  assert.deepEqual(validateNewPassword('tajne123', 'tajne123').errors, []);
  assert.ok(validateNewPassword('krotkie', 'krotkie').errors.length, 'poniżej 8 znaków');
  assert.ok(validateNewPassword('tajne123', 'tajne124').errors.length, 'różne powtórzenie');
  assert.ok(validateNewPassword('', '').errors.length, 'puste hasło');
});

test('admin nie może odebrać roli własnemu kontu', () => {
  const sesja = { userId: 7 };
  assert.equal(wouldDropOwnAdminRole(sesja, 7, null), true, 'zdjęcie roli sobie');
  assert.equal(wouldDropOwnAdminRole(sesja, 7, 'group'), true, 'zamiana roli na group u siebie');
  assert.equal(wouldDropOwnAdminRole(sesja, 7, 'admin'), false, 'zapis bez zmiany roli przechodzi');
  assert.equal(wouldDropOwnAdminRole(sesja, 9, null), false, 'inne konto wolno zmieniać');
  // `userId` z sesji bywa stringiem — porównanie nie może być typowane sztywno.
  assert.equal(wouldDropOwnAdminRole({ userId: '7' }, 7, null), true);
});
