/**
 * Boots a JSDOM "browser" capable of running the real `public/scripts/form.js`
 * pipeline server-side, then exposes a small JS API back to Node.
 *
 * High-level flow:
 *   1. createEngineWindow()        → fresh JSDOM with the harness HTML and
 *                                    our ResourceLoader (which knows how to
 *                                    serve /scripts/*, /data/* and the in-
 *                                    memory engine bundle).
 *   2. installPreloadGlobals(...)  → seeds globals the frontend reads at
 *                                    bootstrap (window.t, window.langs, group
 *                                    flags, document.documentElement.lang…).
 *   3. patchFetch(...)             → intercepts the few fetch() targets that
 *                                    don't live under /data/ or /scripts/,
 *                                    namely /user/uid.
 *   4. loadEngine()                → injects two <script> tags:
 *                                      a) the esbuild IIFE bundle of form.js,
 *                                      b) a tiny adapter exposing
 *                                         window.__engine = { generateForm,
 *                                         updateProcedure, getTotal }.
 *
 * The exported `bootEngine()` returns a `{ window, dispose }` pair plus a
 * thin async API. Callers should always `dispose()` to release JSDOM memory.
 *
 * Note on JSDOM limitations: jsdom 27 does not execute `<script type="module">`
 * (neither inline nor via src). That's why we bundle to an IIFE classic script
 * via esbuild — see bundler.js.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const { dataDir, features } = require('../../config');
const { buildHarnessHtml } = require('./harnessHtml');
const { FormEngineResourceLoader, PUBLIC_DIR } = require('./resourceLoader');
const { getBundle } = require('./bundler');
const { getClientScripts, loadClientAliases } = require('./clientScripts');
const path = require('path');
const fs = require('fs');

const ENGINE_BOOTSTRAP_TIMEOUT_MS = 15000;

// Synthetic URLs served from the in-memory virtualSources map.
const BUNDLE_URL = '/__engine/form-bundle.js';
const ADAPTER_URL = '/__engine/adapter.js';
const FORMULA_PARSER_URL = '/__engine/formula-parser.js';
const FORMULA_PARSER_PATH = path.join(
  __dirname, '..', '..', 'node_modules', 'hot-formula-parser', 'dist', 'formula-parser.min.js'
);

let cachedFormulaParserSrc = null;
function getFormulaParserSrc() {
  if (cachedFormulaParserSrc === null) {
    cachedFormulaParserSrc = fs.readFileSync(FORMULA_PARSER_PATH, 'utf8');
  }
  return cachedFormulaParserSrc;
}

const ADAPTER_SOURCE = `
(function () {
  if (!window.__engineForm) {
    window.__engineReady('bundle did not expose __engineForm');
    return;
  }
  window.__engine = {
    generateForm: window.__engineForm.generateForm,
    updateProcedure: window.__engineForm.updateProcedure,
    getTotal: window.__engineForm.getTotal
  };
  window.__engineReady();
})();
`;

function defaultTranslate(key) {
  return String(key);
}

function installPreloadGlobals(window, opts) {
  const { lang, isGroup, isGroupShop, langs, orgIdent, userIdent, currency } = opts;

  window.t = defaultTranslate;
  // Waluta cen klienta (services/currency.js) — ta sama, którą przeglądarka
  // dostaje z szablonu; form.js dopisuje ją do opisów parametrów kwotowych
  // (formTools/currencyLabel.js). Brak = EUR i bez ruszania zapisanych opisów.
  if (currency) window.priceCurrency = currency;
  window.langs = langs || ['pl', 'en', 'de', 'fr', 'nl'];
  window.isGroup = !!isGroup;
  window.isGroupShop = !!isGroupShop;
  // Specyfikacja ceny `_S` — ta sama flaga `PRICE_SPEC_ENABLED`, którą
  // przeglądarka dostaje z base.njk (config.js `features.priceSpec`), więc
  // import i przeliczanie tworzą wiersze `_S` dokładnie tam, gdzie formularz.
  window.priceSpecEnabled = !!features.priceSpec;

  // Some scripts read these at module-evaluation time.
  window.shortJson = {};
  window.attachments = [];
  window.calculationQueue = [];
  window.lockedParams = [];
  window.subParams = [];
  window.skipCountParams = [];
  window.enabledParams = {};
  window.validParams = {};
  window.inputFlags = {};
  window.inputsValidators = {};
  window.inputsDefaults = {};
  window.calculatedParams = new Set();
  window.constValues = {};
  window.afterSend = false;
  window.finishFlag = false;
  window.spin = false;
  window.isCalculating = false;
  window.isPriceCalculating = false;
  window.params = [];
  window.formInputs = {};
  window.formValues = {};
  window.formDisplayValues = new window.Map();
  window.allOptionsByParameter = {};
  window.tempGroupNumber = '';

  // No-op spinner / toast / dialog hooks (UI-only side effects in browser).
  window.startSpin = () => {};
  window.stopSpin = () => {};

  // toastr is loaded from a CDN in the layout; stub it so calls don't throw.
  const toastrNoop = () => {};
  window.toastr = {
    success: toastrNoop, error: toastrNoop, warning: toastrNoop, info: toastrNoop,
    options: {}, clear: toastrNoop, remove: toastrNoop
  };

  // formsManager is normally populated by main.js/edit_form.js BEFORE
  // generateForm() runs: it logs in, calls /user/owner/ to learn the
  // session's org/client identity, then reads prod.txt's PARAM_SCRIPTS
  // column to resolve per-client price scripts (see selectPrices() in
  // dataLoader.js). The engine has no login session, so we resolve the same
  // [path, scripts] pair directly from disk given the caller-supplied
  // orgIdent/userIdent (see clientScripts.js for why this matters — without
  // it, any param whose SCRIPTS is the literal 'true' never gets its SOURCE
  // resolved and silently prices as blank/0).
  window.formsManager = {
    loadDataPerClient: async (group) => loadClientAliases({
      groupNumber: group || window.tempGroupNumber,
      lang,
      orgIdent,
      userIdent
    }),
    getClientScripts: async () => getClientScripts({
      groupNumber: window.tempGroupNumber,
      lang,
      orgIdent,
      userIdent
    }),
    getOrgIdent: async () => orgIdent || '',
    getUserIdent: async () => userIdent || '',
    getAliases: () => ({ file: null }),
    getAvailableForms: async () => [],
    getGroups: async () => [],
    setCurrentRootPath: () => {},
    setCurrentGroup: () => {}
  };

  if (window.document && window.document.documentElement) {
    window.document.documentElement.lang = lang || 'pl';
  }
}

function patchFetch(window, { uid }) {
  // jsdom 27 no longer ships a window.fetch — we install Node's global one.
  const baseFetch = typeof window.fetch === 'function'
    ? window.fetch.bind(window)
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const ResponseCtor = window.Response || globalThis.Response;
  const RequestCtor = window.Request || globalThis.Request;
  if (!ResponseCtor) {
    throw new Error('formEngine: no Response constructor available (Node 18+ required)');
  }
  if (!window.Response) window.Response = ResponseCtor;
  if (!window.Request && RequestCtor) window.Request = RequestCtor;
  if (!window.fetch && baseFetch) window.fetch = baseFetch;

  function jsonResponse(payload) {
    return new ResponseCtor(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /** Sama ścieżka z adresu — bezwzględnego albo względnego. */
  const pathnameOf = (url) => {
    try { return new URL(url, 'http://engine.local').pathname; } catch (_e) { return url; }
  };

  window.fetch = (input /* , init */) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';

    if (url === '/user/uid' || url.endsWith('/user/uid')) {
      return Promise.resolve(jsonResponse({ success: true, uid: uid || `engine_${Date.now()}` }));
    }

    // Ta sama podmiana wersji reguł, co w przeglądarce: `dataLoader.parseData()`
    // pyta o nią, gdy `param.txt` żądanej wersji zwróci 404. Bez tego silnik
    // bezgłowy (import, przeliczanie, tester) padał na `data.dictValues` przy
    // każdej pozycji, której wersja zniknęła z udziału — a takich jest 522.
    if (pathnameOf(url).startsWith('/position/rules-version/')) {
      const { resolveUsableVersion } = require('../rulesVersion');
      const segments = pathnameOf(url).split('/').filter(Boolean);
      const groupNr = segments[2];
      const query = new URL(url, 'http://engine.local').searchParams;
      const wynik = resolveUsableVersion(groupNr, query.get('requested'), query.get('lang') || 'pl');
      return Promise.resolve(jsonResponse(wynik));
    }

    if (url === '/env' || url.endsWith('/env')) {
      // Etykieta wersji dla skryptów, które o nią pytają. Specyfikacja ceny
      // `_S` już od niej NIE zależy — steruje nią `window.priceSpecEnabled`
      // (`PRICE_SPEC_ENABLED`, ustawiane w installPreloadGlobals).
      return Promise.resolve(jsonResponse({ body: { version: 'Testowa' } }));
    }

    // /data/* and /scripts/* are also reachable via fetch (DataLoader uses it).
    const path = require('path');
    const fs = require('fs').promises;
    let pathname = url;
    try { pathname = new URL(url).pathname; } catch (_e) { /* relative */ }

    let abs = null;
    if (pathname.startsWith('/scripts/')) {
      abs = path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
    } else if (pathname.startsWith('/data/')) {
      abs = path.join(dataDir, pathname.replace(/^\/data\//, ''));
    }
    if (abs) {
      return fs.readFile(abs).then(
        (buf) => new ResponseCtor(buf, { status: 200 }),
        () => new ResponseCtor('', { status: 404 })
      );
    }

    // Block external network — return a benign success-shaped JSON 200 so
    // top-level fetches in the bundle (getConfigNum, getUserName, etc.) don't
    // throw inside the realm and escape as unhandledRejection.
    return Promise.resolve(new ResponseCtor(
      '{"success":true,"engine":true,"name":"engine","isEmployee":false,"body":{}}',
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
  };
}

/**
 * Append the bundle <script src=BUNDLE_URL> followed by the adapter
 * <script src=ADAPTER_URL>. The adapter resolves window.__engineReady once
 * window.__engine is exposed.
 *
 * formula.js is loaded first as a classic script — it defines the global
 * window.FormulaHandler that pricesCalculator/createForm/etc. depend on.
 */
function loadEngine(window) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('formEngine: bridge script did not load within timeout'));
    }, ENGINE_BOOTSTRAP_TIMEOUT_MS);

    window.__engineReady = (err) => {
      clearTimeout(timer);
      if (err) reject(new Error(`formEngine bridge error: ${err}`));
      else resolve();
    };

    const formulaParserScript = window.document.createElement('script');
    formulaParserScript.src = '/__engine/formula-parser.js';
    formulaParserScript.onerror = () => window.__engineReady('formula-parser failed to load');
    formulaParserScript.onload = () => {
      const formulaScript = window.document.createElement('script');
      formulaScript.src = '/scripts/formula.js';
      formulaScript.onerror = () => window.__engineReady('formula.js failed to load');
      formulaScript.onload = () => {
        const bundleScript = window.document.createElement('script');
        bundleScript.src = BUNDLE_URL;
        bundleScript.onerror = () => window.__engineReady('bundle script failed to load');
        bundleScript.onload = () => {
          const adapterScript = window.document.createElement('script');
          adapterScript.src = ADAPTER_URL;
          adapterScript.onerror = () => window.__engineReady('adapter script failed to load');
          window.document.body.appendChild(adapterScript);
        };
        window.document.body.appendChild(bundleScript);
      };
      window.document.body.appendChild(formulaScript);
    };
    window.document.body.appendChild(formulaParserScript);
  });
}

/**
 * @param {object} opts
 * @param {string} opts.lang        - Language code (pl/en/de/fr/nl).
 * @param {string} [opts.uid]       - Forced UID; otherwise a synthetic one.
 * @param {boolean} [opts.isGroup]
 * @param {boolean} [opts.isGroupShop]
 * @param {string} [opts.orgIdent]  - Order owner's organization.ident (e.g. "HKL"),
 *                                    used to resolve per-client price scripts.
 * @param {string} [opts.userIdent] - Order owner's user.ident (e.g. "TCN"),
 *                                    used to resolve per-client price scripts.
 * @param {string} [opts.currency]  - Client's price currency (services/currency.js),
 *                                    appended to monetary param labels.
 * @returns {Promise<{window, dispose: () => void, PUBLIC_DIR: string}>}
 */
async function bootEngine(opts = {}) {
  const html = buildHarnessHtml({ lang: opts.lang || 'pl' });

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    // Suppress benign errors (missing images, external resources) during form processing
    const errStr = (err && err.message) ? err.message : String(err);
    if (errStr.includes('Could not load img') || errStr.includes('cannot read') || 
        errStr.includes('ENOENT') || errStr.includes('formEngine: cannot read')) {
      // Silently ignore missing resource files (images, data files) - not critical for form processing
      return;
    }
    process.stderr.write(`[jsdom] ${err && err.stack ? err.stack : err}\n`);
  });
  if (process.env.FORM_ENGINE_DEBUG) {
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
      virtualConsole.on(m, (...a) => process.stderr.write(`[jsdom:${m}] ${a.join(' ')}\n`));
    }
  }

  const dom = new JSDOM(html, {
    url: 'http://engine.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: new FormEngineResourceLoader({
      virtualSources: {
        [BUNDLE_URL]: getBundle(),
        [ADAPTER_URL]: ADAPTER_SOURCE,
        [FORMULA_PARSER_URL]: getFormulaParserSrc()
      }
    }),
    virtualConsole
  });

  const { window } = dom;

  installPreloadGlobals(window, {
    lang: opts.lang || 'pl',
    langs: opts.langs,
    isGroup: opts.isGroup,
    isGroupShop: opts.isGroupShop,
    orgIdent: opts.orgIdent,
    userIdent: opts.userIdent,
    currency: opts.currency
  });
  patchFetch(window, { uid: opts.uid });

  await loadEngine(window);

  return {
    window,
    dispose: () => {
      try { window.close(); } catch (_e) { /* ignore */ }
    },
    PUBLIC_DIR
  };
}

module.exports = { bootEngine };
