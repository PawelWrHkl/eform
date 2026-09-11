const path = require('path');

// Resolve once so `path.join(undefined, …)` can never throw at module load.
const ROOT_DIR = process.env.ROOT_DIR || '/mnt/eform';
const PHOTO_PATH = path.join(ROOT_DIR, 'data');

module.exports = {
  rootDir: ROOT_DIR,
  dataDir: process.env.DATA_DIR || '/mnt/eform/datadev',
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
  outputData: process.env.OUTPUT_DIR || '/mnt/eform/datadev/out',
  shortJsonDir: path.join(ROOT_DIR, 'json_short'),
  // Automatyczny tester konfiguratora (services/configuratorTester) — raporty JSON per przebieg.
  configTestOutputDir: process.env.CONFIGTEST_OUTPUT_DIR || path.join(ROOT_DIR, 'configtest-output'),
  availabeLanguages: ['pl', 'en', 'de', 'fr', 'nl'],
  defaultLanguage: 'en',
  logsDir: path.join(process.env.LOG_PATH || '/mnt/eform/log/datadev'),
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
  }
};
