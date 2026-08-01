const path = require('path');

// Resolve once so `path.join(undefined, …)` can never throw at module load.
const ROOT_DIR = process.env.ROOT_DIR || '/mnt/eform';

module.exports = {
  rootDir: ROOT_DIR,
  dataDir: process.env.DATA_DIR || '/mnt/eform/datatest',
  changesDir: process.env.CHANGES_DIR || path.join(ROOT_DIR, 'data/data/changes'),
  localesDir: process.env.LOCALES_DIR || '/mnt/eform/languages' || path.join(__dirname, 'locales'),
  photoPath: path.join(ROOT_DIR, 'data'),
  slopePhotoPath: path.join(ROOT_DIR, 'data/WYMIAROWANIE_SLOPOW/TYP'),
  usersPath: path.join(ROOT_DIR, 'data/data'),
  outputData: process.env.OUTPUT_DIR || '/mnt/eform/datatest/out',
  shortJsonDir: path.join(ROOT_DIR, 'json_short'),
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
    vat: process.env.VAT_ENABLED === 'true'
  }
};
