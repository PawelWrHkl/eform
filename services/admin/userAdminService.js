/**
 * Administracja użytkownikami (`/admin/users`) — walidacja i normalizacja.
 *
 * Warstwa celowo BEZ dostępu do bazy: przyjmuje surowe `req.body`, oddaje
 * gotowy zestaw wartości pod `UPDATE` albo listę błędów. Dzięki temu reguły
 * (jakie role wolno ustawić, co znaczy „puste", co jest poprawnym `int`)
 * dają się przetestować bez MySQL-a.
 *
 * ⚠️ Kluczowa zasada bezpieczeństwa: kolumny do zapisu pochodzą WYŁĄCZNIE
 * z `POLA` poniżej, nigdy z kluczy przysłanych w żądaniu. `updateUserById`
 * skleja nazwy kolumn do SQL-a bez cudzysłowów, więc przepuszczenie tam
 * dowolnego klucza z formularza byłoby wektorem wstrzyknięcia.
 */

const { availabeLanguages } = require('../../config');
const { BEZ_CEN } = require('../abType');

/** Role, jakie wolno ustawić z panelu — tyle rozpoznaje `authService`. */
const ROLE_OPTIONS = [
  { value: '',      label: 'Klient (brak roli)' },
  { value: 'admin', label: 'Administrator' },
  { value: 'group', label: 'Grupa (sklep)' }
];

/**
 * Wartość `ab_type` zapisywana do bazy. W kolumnie żyje `without_price`
 * i to jej trzymamy się przy zapisie; `services/abType.js` czyta oba warianty.
 */
const AB_TYPE_DB_VALUE = 'without_price';

const AB_TYPE_OPTIONS = [
  { value: '',                label: 'Standardowy (z cenami)' },
  { value: AB_TYPE_DB_VALUE,  label: 'Bez cen (without_price)' }
];

/** Górna granica opóźnienia dostawy — zapora na literówkę typu „100" zamiast „10". */
const MAX_DELIVERY_DELAY = 365;

/** Minimalna długość nowego hasła ustawianego przez admina. */
const MIN_PASSWORD_LENGTH = 8;

/** Kolumny edytowalne z tego panelu (biała lista). */
const POLA = ['role', 'intro_needed', 'ab_type', 'ab_lang', 'delivery_delay', 'client_ab', 'email'];

function pustaWartosc(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Checkbox z formularza dociera jako `true`/`'true'`/`'on'`/`1` albo wcale.
 * Kolumny są `tinyint(1)`, więc zapisujemy 0/1, nigdy boolean.
 *
 * @param {any} value
 * @returns {0|1}
 */
function naTinyint(value) {
  if (value === true || value === 1) return 1;
  const tekst = String(value == null ? '' : value).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'tak'].includes(tekst) ? 1 : 0;
}

/**
 * `delivery_delay` — wyłącznie liczba całkowita (wymaganie: „tylko int").
 *
 * @param {any} value
 * @returns {{ value?: number|null, error?: string }}
 */
function parseDeliveryDelay(value) {
  if (pustaWartosc(value)) return { value: null };
  const tekst = String(value).trim();
  // Odrzucamy „5.5", „5,5", „5 dni", „abc" — tylko czysta liczba całkowita.
  if (!/^-?\d+$/.test(tekst)) {
    return { error: 'Opóźnienie dostawy musi być liczbą całkowitą (dni).' };
  }
  const liczba = Number(tekst);
  if (liczba < 0) return { error: 'Opóźnienie dostawy nie może być ujemne.' };
  if (liczba > MAX_DELIVERY_DELAY) {
    return { error: `Opóźnienie dostawy wygląda na pomyłkę — maksimum to ${MAX_DELIVERY_DELAY} dni.` };
  }
  return { value: liczba };
}

/**
 * `ab_lang` — kod języka albo `null`. W bazie wartość żyje wielkimi literami
 * (`"NL"`), więc zapisujemy w tej samej postaci; odczyt (`resolveAbLang`)
 * i tak normalizuje wielkość liter.
 *
 * @param {any} value
 * @returns {{ value?: string|null, error?: string }}
 */
function parseAbLang(value) {
  if (pustaWartosc(value)) return { value: null };
  const kod = String(value).trim().toLowerCase();
  if (!availabeLanguages.includes(kod)) {
    return { error: `Nieznany język potwierdzenia: ${value}. Dozwolone: ${availabeLanguages.join(', ')}.` };
  }
  return { value: kod.toUpperCase() };
}

/**
 * @param {any} value
 * @returns {{ value?: string|null, error?: string }}
 */
function parseEmail(value) {
  if (pustaWartosc(value)) return { value: null };
  const email = String(value).trim();
  if (email.length > 128) return { error: 'Adres e-mail jest dłuższy niż 128 znaków.' };
  // Świadomie luźna walidacja: ma wyłapać oczywistą literówkę (brak @ lub
  // kropki), a nie odrzucać egzotycznych, ale poprawnych adresów.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: `Adres e-mail wygląda niepoprawnie: ${email}` };
  }
  return { value: email };
}

/**
 * @param {any} value
 * @returns {{ value?: string|null, error?: string }}
 */
function parseRole(value) {
  if (pustaWartosc(value)) return { value: null };
  const rola = String(value).trim().toLowerCase();
  if (!ROLE_OPTIONS.some((o) => o.value && o.value === rola)) {
    return { error: `Nieznana rola: ${value}` };
  }
  return { value: rola };
}

/**
 * @param {any} value
 * @returns {{ value?: string|null, error?: string }}
 */
function parseAbType(value) {
  if (pustaWartosc(value)) return { value: null };
  const typ = String(value).trim().toLowerCase();
  if (!BEZ_CEN.includes(typ)) {
    return { error: `Nieznany typ potwierdzenia: ${value}` };
  }
  return { value: AB_TYPE_DB_VALUE };
}

/**
 * Składa zestaw wartości do `UPDATE user` z formularza panelu.
 *
 * @param {Record<string, any>} body surowe `req.body`
 * @returns {{ values: Record<string, any>, errors: string[] }}
 */
function normalizeUserSettings(body = {}) {
  const errors = [];
  const values = {};

  const parsery = {
    role: parseRole,
    ab_type: parseAbType,
    ab_lang: parseAbLang,
    delivery_delay: parseDeliveryDelay,
    email: parseEmail
  };

  for (const pole of POLA) {
    if (pole === 'intro_needed' || pole === 'client_ab') {
      // Checkboxy: brak klucza = odznaczone, więc zawsze zapisujemy 0/1.
      values[pole] = naTinyint(body[pole]);
      continue;
    }
    const wynik = parsery[pole](body[pole]);
    if (wynik.error) errors.push(wynik.error);
    else values[pole] = wynik.value;
  }

  return { values: errors.length ? {} : values, errors };
}

/**
 * Nowe hasło ustawiane przez admina — bez pytania o stare (admin go nie zna).
 *
 * @param {any} password
 * @param {any} confirmation
 * @returns {{ password?: string, errors: string[] }}
 */
function validateNewPassword(password, confirmation) {
  const errors = [];
  const haslo = String(password == null ? '' : password);

  if (!haslo) {
    errors.push('Podaj nowe hasło.');
  } else if (haslo.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.`);
  }
  if (confirmation !== undefined && haslo !== String(confirmation == null ? '' : confirmation)) {
    errors.push('Hasła nie są identyczne.');
  }

  return errors.length ? { errors } : { password: haslo, errors };
}

/**
 * Czy admin próbuje odebrać rolę sam sobie.
 *
 * ⚠️ Bez tej zapory jedno kliknięcie („Klient (brak roli)" na własnym koncie)
 * odcina panel administracyjny bez żadnej drogi powrotu z aplikacji.
 *
 * @param {{ userId?: number|string }|null} sessionUser
 * @param {number|string} editedUserId
 * @param {string|null} nowaRola wartość po normalizacji
 * @returns {boolean}
 */
function wouldDropOwnAdminRole(sessionUser, editedUserId, nowaRola) {
  if (!sessionUser || sessionUser.userId == null) return false;
  if (String(sessionUser.userId) !== String(editedUserId)) return false;
  return nowaRola !== 'admin';
}

module.exports = {
  normalizeUserSettings,
  validateNewPassword,
  wouldDropOwnAdminRole,
  naTinyint,
  parseDeliveryDelay,
  parseAbLang,
  ROLE_OPTIONS,
  AB_TYPE_OPTIONS,
  AB_TYPE_DB_VALUE,
  MIN_PASSWORD_LENGTH,
  MAX_DELIVERY_DELAY,
  POLA
};
