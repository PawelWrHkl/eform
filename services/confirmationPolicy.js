/**
 * Zasady potwierdzenia zamówienia (AB) — JEDNO miejsce dla wszystkich torów wysyłki.
 *
 * Te same reguły muszą obowiązywać niezależnie od tego, czy potwierdzenie leci
 * z panelu (`routes/orders.js`), z importu FTP, czy z ręcznej wysyłki na
 * produkcję (`services/orderImport/sendAfterImport.js`):
 *   - `user.ab_type = without_price` → PDF bez jakichkolwiek cen,
 *   - `user.ab_lang`                 → wymuszony język PDF-a i maila,
 *   - `user.client_ab`               → potwierdzenie wprost na adres klienta,
 *   - `user.delivery_delay`          → dni doliczane do czasu produkcji.
 *
 * ⚠️ Dlaczego odczyt idzie po `orderId`, a nie z gotowego wiersza `user`:
 * import wczytywał klienta zapytaniem, które tych kolumn NIE wybierało
 * (`services/orderImport/userResolver.js`), więc `userHidesPrices(user)` czy
 * `userAbLang(user)` dostawały `undefined` i reguły po cichu nie działały —
 * bez żadnego błędu w logu. Zapytanie po zamówieniu nie zależy od tego, co
 * wywołujący akurat wybrał w swoim SELECT-cie.
 *
 * ⚠️ Liczy się WŁAŚCICIEL zamówienia, nie osoba klikająca „wyślij": dokument
 * trafia do klienta, a admin i owner wysyłają w jego imieniu.
 */

const { log } = require('../utils/logging');
const { isWithoutPrices, resolveAbLang, isClientAb } = require('./abType');

/**
 * @typedef {Object} AbPolicy
 * @property {boolean} withoutPrices PDF bez cen (`ab_type`)
 * @property {string|null} abLang wymuszony język potwierdzenia (`ab_lang`)
 * @property {boolean} clientAb potwierdzenie wprost do klienta (`client_ab`)
 * @property {number} deliveryDelay dni doliczane do czasu produkcji
 * @property {string|null} extraAbMail dodatkowy odbiorca BCC (`extra_ab_mail`)
 */

/** Polityka „nic nie wymuszamy" — zachowanie jak przed wprowadzeniem kolumn. */
function domyslnaPolityka() {
  return { withoutPrices: false, abLang: null, clientAb: false, deliveryDelay: 0, extraAbMail: null };
}

/**
 * Złożenie polityki z surowego wiersza `user`.
 *
 * @param {{ab_type?: any, ab_lang?: any, client_ab?: any, delivery_delay?: any, extra_ab_mail?: any}|null} row
 * @returns {AbPolicy}
 */
function policyFromUserRow(row) {
  if (!row) return domyslnaPolityka();
  // Lazy require z tego samego powodu co niżej: `productionDays` wciąga
  // warstwę bazy, a ten moduł ma dać się wczytać bez otwierania puli MySQL.
  const { resolveDeliveryDelay } = require('./productionDays');
  const extraAbMail = typeof row.extra_ab_mail === 'string' ? row.extra_ab_mail.trim() : '';
  return {
    withoutPrices: isWithoutPrices(row.ab_type),
    abLang: resolveAbLang(row.ab_lang),
    clientAb: isClientAb(row.client_ab),
    deliveryDelay: resolveDeliveryDelay(row.delivery_delay),
    extraAbMail: extraAbMail || null
  };
}

/**
 * Polityka potwierdzenia dla właściciela danego zamówienia — jedno zapytanie.
 *
 * @param {number|string} orderId
 * @param {{selectQuery?: Function, log?: Function}} [deps] wstrzyknięcie na potrzeby testów
 * @returns {Promise<AbPolicy>}
 */
async function resolveOrderAbPolicy(orderId, deps = {}) {
  const zaloguj = deps.log || log;

  if (!orderId) return domyslnaPolityka();
  // ⚠️ `require` w środku funkcji celowo: `db/core` przy wczytaniu zakłada pulę
  // MySQL, która nie pozwala procesowi testowemu się zakończyć. Wersja z
  // wstrzykniętym `selectQuery` (testy) nie dotyka bazy w ogóle.
  const zapytaj = deps.selectQuery || require('../db/core').selectQuery;
  try {
    const rows = await zapytaj(
      'SELECT u.ab_type, u.ab_lang, u.client_ab, u.delivery_delay, u.extra_ab_mail ' +
      'FROM `order` o JOIN `user` u ON u.id = o.user_id WHERE o.id = ?',
      [orderId]
    );
    return policyFromUserRow(rows && rows[0]);
  } catch (err) {
    // Brak informacji nie może wstrzymać wysyłki — logujemy i zachowujemy się
    // jak przed wprowadzeniem tych kolumn.
    zaloguj('[ab] nie udało się odczytać zasad potwierdzenia:', err.message);
    return domyslnaPolityka();
  }
}

/**
 * Wybór odbiorcy i listy BCC potwierdzenia.
 *
 * Funkcja czysta — cała logika środowiskowa w jednym miejscu, żeby panel
 * i import nie rozjechały się przy kolejnej zmianie.
 *
 * Reguły:
 *   - `dev`/`test`: mail leci na skrzynkę deweloperską, ŻEBY nie zaczepić
 *     prawdziwych klientów z lokalnego środowiska;
 *   - `client_ab` z adresem kontaktowym: głównym odbiorcą jest klient (także
 *     na dev/test — to świadoma decyzja, żeby dało się to przetestować);
 *   - produkcja bez `client_ab`: odbiorcą jest organizacja, klient w BCC.
 *
 * @param {Object} p
 * @param {string} [p.env] wartość `NODE_ENV`
 * @param {boolean} [p.clientAb]
 * @param {string|null} [p.confirmationEmail] adres kontaktowy zamówienia (klient)
 * @param {string|null} [p.organizationEmail]
 * @param {string|null} [p.organizationEmail2]
 * @param {string|string[]|false} [p.extraMail] `EXTRA_MAIL` z `.env`
 * @param {string|null} [p.extraAbMail] dodatkowy odbiorca BCC (`user.extra_ab_mail`)
 * @returns {{mainRecipient: string|null, bccList: string[], bcc: string}}
 */
function resolveConfirmationRecipients({
  env = process.env.NODE_ENV,
  clientAb = false,
  confirmationEmail = null,
  organizationEmail = null,
  organizationEmail2 = null,
  extraMail = false,
  extraAbMail = null
} = {}) {
  const SKRZYNKA_DEV = 'pawel.woroniecki@hkl.eu';
  const SKRZYNKA_DEV_BCC = 'krzysztof.krawczyk@hkl.eu';

  let mainRecipient;
  let bccList;

  if (env === 'test' || env === 'dev') {
    mainRecipient = SKRZYNKA_DEV;
    bccList = [SKRZYNKA_DEV_BCC];
    if (clientAb && confirmationEmail) {
      mainRecipient = confirmationEmail;
      bccList.push(SKRZYNKA_DEV);
    }
  } else {
    mainRecipient = clientAb && confirmationEmail ? confirmationEmail : organizationEmail;
    bccList = clientAb && confirmationEmail
      ? [organizationEmail, organizationEmail2, extraMail, SKRZYNKA_DEV]
      : [confirmationEmail, organizationEmail2, extraMail, SKRZYNKA_DEV];
  }

  bccList.push(extraAbMail);
  bccList = bccList.filter(Boolean).flat();
  return { mainRecipient, bccList, bcc: bccList.join(', ') };
}

module.exports = {
  resolveOrderAbPolicy,
  resolveConfirmationRecipients,
  policyFromUserRow
};
