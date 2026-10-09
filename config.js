const path = require('path');

// Resolve once so `path.join(undefined, …)` can never throw at module load.
const ROOT_DIR = process.env.ROOT_DIR || '/mnt/eform';
const PHOTO_PATH = path.join(ROOT_DIR, 'data');

/** Przełącznik z .env: true/on/1/yes/tak → włączony, wszystko inne (także brak) → wyłączony. */
function envSwitch(value) {
  return ['true', 'on', '1', 'yes', 'tak'].includes(String(value || '').trim().toLowerCase());
}

module.exports = {
  rootDir: ROOT_DIR,
  dataDir: process.env.DATA_DIR || '/mnt/eform/datatest',
  changesDir: process.env.CHANGES_DIR || path.join(ROOT_DIR, 'data/data/changes'),
  localesDir: process.env.LOCALES_DIR || '/mnt/eform/languages' || path.join(__dirname, 'locales'),
  photoPath: PHOTO_PATH,
  // Zalaczniki INFO - pliki z zapisu `Opis <karta.pdf>` w `param.INFO` oraz
  // w kolumnie `<PARAM>_INFO` w paramdict. To strona DYSKOWA adresu
  // `/photos/files/`, pod ktorym przeglada je przeglądarka: `/photos` jest
  // zamontowane na `photoPath` (server.js), wiec te dwie rzeczy MUSZA isc
  // razem - zmiana jednej bez drugiej daje 404 na kazdym zalaczniku. Adres po
  // stronie klienta trzyma INFO_FILES_URL w public/scripts/components/info.js.
  infoFilesDir: path.join(PHOTO_PATH, 'files'),
  slopePhotoPath: path.join(ROOT_DIR, 'data/WYMIAROWANIE_SLOPOW/TYP'),
  usersPath: path.join(ROOT_DIR, 'data/data'),
  outputData: process.env.OUTPUT_DIR || '/mnt/eform/datatest/out',
  shortJsonDir: path.join(ROOT_DIR, 'json_short'),
  // Automatyczny tester konfiguratora (services/configuratorTester) — raporty JSON per przebieg.
  configTestOutputDir: process.env.CONFIGTEST_OUTPUT_DIR || path.join(ROOT_DIR, 'configtest-output'),
  availabeLanguages: ['pl', 'en', 'de', 'fr', 'nl'],
  defaultLanguage: 'en',
  logsDir: path.join(process.env.LOG_PATH || '/mnt/eform/log/datatest'),
  ftpImportPath: process.env.FTP_IMPORT_PATH || '/orders-in',
  // Local mirror of incoming FTP orders. Each file pulled from FTP is first
  // saved here as a backup before being parsed/imported. After processing,
  // it is moved to the `processed/` or `error/` sub-folder.
  localImportDir: process.env.LOCAL_IMPORT_DIR
    || path.join(ROOT_DIR, 'data', 'orders-in'),

  // ── Feature flags ──────────────────────────────────────────────────────
  // `features.vat` is THE single switch for the whole VAT feature: rate
  // resolution (services/vatCalculator.js), the read-only VAT / WARTOŚĆ VAT /
  // WARTOŚĆ BRUTTO fields on the position forms and their displayValues rows.
  // While off, nothing VAT-related is computed, injected into a template or
  // rendered — no window.vatRate, no DB lookups, no form fields, no keys in
  // saved position values.
  //
  // ONE switch, one env var: VAT_ENABLED=true turns the feature on, anything
  // else (including a missing var) keeps it off. Deliberately NOT derived from
  // NODE_ENV — production's NODE_ENV value is set on the remote server, outside
  // this repo (and this codebase already uses non-obvious values like
  // 'live-dev'), so keying the feature off it could silently leave VAT enabled
  // there. Defaulting to off fails safe instead.
  //
  // Enabled for dev/test via VAT_ENABLED=true in `.env`, which is listed in
  // exclude-list.txt and therefore never rsynced to production by update.sh —
  // production keeps its own .env without the var, hence the feature stays off
  // there until it's deliberately added.
  features: {
    vat: process.env.VAT_ENABLED === 'true',
    // Moduł fakturowania (`services/invoices`). ⚠️ Ta flaga wyłącza CAŁY moduł,
    // nie tylko wejście w menu: przy `false` nie są montowane routery
    // `/invoices` ani `/api/v1/invoices` (adresy zwracają 404), znika ikona
    // w nawigacji (`res.locals.invoicesEnabled` → `base.njk`), sekcja odbiorcy
    // końcowego w formularzu zamówienia i kartoteka odbiorców. Dzięki temu
    // środowisko z wyłączoną flagą nie wystawia żadnego wejścia do modułu —
    // ani widoku, ani API.
    //
    // Podstawowa nazwa zmiennej to `INVOICES_ENABLED`; `INVOICE`/`INVOICES`
    // przyjmujemy jako skróty, bo łatwo o pomyłkę przy ręcznej edycji `.env`.
    // Brak zmiennej = wyłączone (ta sama konwencja co `vat`).
    invoices: [process.env.INVOICES_ENABLED, process.env.INVOICES, process.env.INVOICE]
      .some((v) => String(v).toLowerCase() === 'true'),

    // Moduł „Klienci organizacji" (`/org/customers`). Przy `false` router nie
    // jest w ogóle montowany (adresy zwracają 404) — ta sama konwencja co
    // `invoices`: brak zmiennej = wyłączone.
    orgCustomers: String(process.env.ORG_CUSTOMERS_ENABLED).toLowerCase() === 'true',

    // Specyfikacja ceny (`<PARAM>_S`, np. `CENA_S` = „416(PG3)*1.1") — skrypt
    // cennika zwraca ją obok ceny, a `pricesCalculator.js calculateFromScript`
    // przy włączonej fladze tworzy z niej ukryte pole i wiersz „<opis>-spec"
    // (`locked`, widoczny w podglądzie po kłódce). Wyłączona:
    //  • wartość `_S` zostaje tylko w `values` — nie powstaje pole ani wiersz,
    //    a wiersz zapisany wcześniej znika z pozycji przy przeliczeniu,
    //  • wiersze `-spec` już zapisanych pozycji nie pokazują się nigdzie
    //    (podgląd, druk, PDF, mail — `services/orderService.js`).
    // Zmienna `PRICE_SPEC_ENABLED` w `.env` KAŻDEGO środowiska osobno
    // (`update.sh` nie kopiuje `.env`). Brak zmiennej = wyłączone — ta sama
    // konwencja co `vat`. Ta sama flaga steruje przeglądarką
    // (`window.priceSpecEnabled`, base.njk) i silnikiem JSDOM (import,
    // przeliczanie, tester — services/formEngine/jsdomEnv.js).
    priceSpec: envSwitch(process.env.PRICE_SPEC_ENABLED),
  },

  // ── Eksport klientów do systemu zewnętrznego ───────────────────────────
  // ⚠️ `enabled` jest NIEZALEŻNE od `features.orgCustomers`: moduł ma sens sam
  // w sobie (zakładanie klientów w eForm), a integracja bywa niegotowa po
  // stronie odbiorcy. Przy wyłączonej fladze zapis klienta działa normalnie,
  // a eksport kończy się statusem `skipped` — bez błędu i bez wpisu do logu.
  customerExport: {
    enabled: String(process.env.CUSTOMER_EXPORT_ENABLED).toLowerCase() === 'true',
    url: process.env.CUSTOMER_EXPORT_URL || '',
    token: process.env.CUSTOMER_EXPORT_TOKEN || '',
    hmacSecret: process.env.CUSTOMER_EXPORT_HMAC_SECRET || '',
    timeoutMs: Number(process.env.CUSTOMER_EXPORT_TIMEOUT_MS) || 10000,
    attempts: Number(process.env.CUSTOMER_EXPORT_ATTEMPTS) || 4
  },

  // ── Asystent eForm (czat AI dla klientów, services/assistant) ──────────
  // `ASSISTANT_ENABLED`: `true` = widżet dla każdego zalogowanego, `admins` =
  // pilotaż tylko dla kont admina, cokolwiek innego (także brak) = wyłączony,
  // a router `/assistant` w ogóle nie wstaje (konwencja `invoices`).
  //
  // ⚠️ Brak `OPENAI_API_KEY` przy włączonym asystencie NIE chowa widżetu:
  // każde pytanie kończy się wtedy propozycją przekazania rozmowy konsultantowi.
  // Bot, który nie może odpowiedzieć, ma przełączać do człowieka, a nie znikać.
  //
  // ⚠️ Adresat przekazań jest WYŁĄCZNIE w `.env` (`ASSISTANT_HANDOFF_EMAIL`,
  // per marka `ASSISTANT_HANDOFF_EMAIL_<IDENT_ORGANIZACJI>`, np. `_LUXANGMBH`),
  // bez fallbacku na adresy z bazy (`organization.email` to skrzynki zamówień
  // produkcji) — inaczej test z dev wysłałby rozmowę do prawdziwej obsługi.
  assistant: {
    mode: String(process.env.ASSISTANT_ENABLED || '').trim().toLowerCase() === 'admins'
      ? 'admins'
      : envSwitch(process.env.ASSISTANT_ENABLED) ? 'true' : 'off',
    apiKey: process.env.OPENAI_API_KEY || '',
    apiUrl: process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses',
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    reasoningEffort: process.env.ASSISTANT_REASONING_EFFORT || 'low',
    timeoutMs: Number(process.env.ASSISTANT_TIMEOUT_MS) || 30000,
    maxQuestionsPerHour: Number(process.env.ASSISTANT_MAX_QUESTIONS_PER_HOUR) || 40,
    handoffEmail: process.env.ASSISTANT_HANDOFF_EMAIL || '',

    // Rozmowa głosowa (OpenAI Realtime, services/assistant/voice). Osobna
    // flaga `ASSISTANT_VOICE_ENABLED=true` — działa tylko przy włączonym
    // asystencie. Limity chronią budżet: głos kosztuje ok. 2–10 centów/min.
    // ⚠️ Mikrofon w przeglądarce działa wyłącznie w bezpiecznym kontekście
    // (https albo localhost) — pod http://<ip>:8000 przycisk się nie pokaże.
    voice: {
      enabled: envSwitch(process.env.ASSISTANT_VOICE_ENABLED),
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini',
      voice: process.env.ASSISTANT_VOICE || 'marin',
      transcribeModel: process.env.ASSISTANT_VOICE_TRANSCRIBE_MODEL || 'gpt-realtime-whisper',
      callsUrl: process.env.OPENAI_REALTIME_CALLS_URL || 'https://api.openai.com/v1/realtime/calls',
      sidebandUrl: process.env.OPENAI_REALTIME_WS_URL || 'wss://api.openai.com/v1/realtime',
      maxSessionMinutes: Number(process.env.ASSISTANT_VOICE_MAX_SESSION_MINUTES) || 10,
      maxMinutesPerDay: Number(process.env.ASSISTANT_VOICE_MAX_MINUTES_PER_DAY) || 30
    },

    // Animowana maskotka (chomik, public/scripts/assistant/avatar.js) na
    // przycisku „Pomoc" i w nagłówku okna. Czysto wizualna: wyłączona = okno
    // jak dotąd, bez ładowania plików maskotki.
    avatar: {
      enabled: envSwitch(process.env.ASSISTANT_AVATAR_ENABLED)
    }
  }
};
