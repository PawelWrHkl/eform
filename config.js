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
  // Filmy wysyłane linkiem (`routes/film.js`): /film/<nazwa> — strona z odtwarzaczem,
  // /film/<nazwa>.mp4 — plik, napisy w `<nazwa>_sub/` (*_PL.srt itd.). Domyślnie `movies/`
  // w repo; katalog jest w .gitignore, bo plik 200 MB nie przeszedłby przez push
  // auto-commitu (limit GitHuba 100 MB).
  moviesDir: process.env.MOVIES_DIR || path.join(__dirname, 'movies'),
  // Publiczny adres aplikacji (np. https://e-orders.eu) — do adresów bezwzględnych
  // w podglądzie linku do filmu. nginx produkcji nie wysyła X-Forwarded-Proto, więc
  // z samego żądania wyszłoby http://. Brak = adres liczony z żądania.
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  shortJsonDir: path.join(ROOT_DIR, 'json_short'),
  // Cenniki klientów PDF (services/pricelists) — pamięć podręczna wygenerowanych plików,
  // celowo poza /data i /mnt/eformconf (źródła aplikacji zewnętrznej).
  pricelistsDir: process.env.PRICELISTS_DIR || path.join(ROOT_DIR, 'pricelists'),
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
    // `INVOICES_ADMIN_ONLY=true` — moduł faktur (menu, panel, API, odbiorca
    // w zamówieniu, asystent) widzi WYŁĄCZNIE administrator; automat i maile
    // działają normalnie. Reguła w `services/invoices/access.js`. Ma sens
    // tylko razem z `INVOICES_ENABLED=true`.
    invoicesAdminOnly: String(process.env.INVOICES_ADMIN_ONLY).toLowerCase() === 'true',

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

    // Okno „Specyfikacja ceny" w podglądzie zlecenia (services/priceSpec) —
    // rozpisanie ceny pozycji na cenę bazową i dopłaty, z PDF-em. Od 2026-10-27
    // widzi ją KAŻDY (klienci, ownerzy, grupy, konta podrzędne) — polecenie
    // właściciela: „każdy klient powinien widzieć specyfikację, nie tylko
    // admin". Brak zmiennej = włączone; `PRICE_SPEC_CLIENTS_ENABLED=false`
    // (off/0) to wyłącznik awaryjny — wtedy tylko admin. Niezależne od
    // `priceSpec` wyżej (stare wiersze „-spec").
    priceSpecClients: String(process.env.PRICE_SPEC_CLIENTS_ENABLED ?? '').trim() === ''
      ? true
      : envSwitch(process.env.PRICE_SPEC_CLIENTS_ENABLED),

    // Tryb demo (services/demoMode.js): przycisk na stronie logowania i router
    // `/demo`. Wymaga `DEMO_ORGANIZATION` (ident organizacji, której cennik
    // widzi konto demo); opcjonalnie `DEMO_MAX_ACTIVE` (30) i
    // `DEMO_MAX_PER_IP_HOUR` (5). Brak zmiennej = wyłączone.
    demo: envSwitch(process.env.DEMO_ENABLED),

    // Korekta wysłanych zleceń przez admina (routes/admin/orderCorrections.js):
    // kafelek w panelu admina, przycisk „Korekta” w historii, router
    // `/admin/order-corrections`. Brak zmiennej = WŁĄCZONE (moduł działał bez
    // flagi, a `update.sh` nie kopiuje `.env`); `ORDER_CORRECTION_ENABLED=false` wyłącza.
    orderCorrection: String(process.env.ORDER_CORRECTION_ENABLED ?? '').trim() === ''
      ? true
      : envSwitch(process.env.ORDER_CORRECTION_ENABLED),

    // Stopka AB ze stoiskiem HKL (POP-19, services/mailBot/abFooter.js): treść per
    // język i nr stoiska w services/mailBot/abFooter.json. Brak zmiennej = wyłączone
    // — włączanie per środowisko, bo `update.sh` nie kopiuje `.env`.
    abFooter: envSwitch(process.env.AB_FOOTER_ENABLED),
  },

  // Mail „korekta zlecenia” poza produkcją (brak `PRODUCTION`) idzie WYŁĄCZNIE
  // na te adresy, bez kopii — baza testowa ma prawdziwe adresy klientów
  // (polecenie Pawła 12.11.2026). Na produkcji ignorowane: mail do klienta.
  correctionMailRedirect: process.env.CORRECTION_MAIL_REDIRECT || 'pawelwr.121@gmail.com',

  // Alternatywy dla niedostępnej tkaniny — plik z agentai, który cron
  // wewnętrznego serwera (`scripts/syncFabricAlternatives.js`) kładzie tutaj,
  // a rsync `update.sh eorders_data` zanosi na produkcję. Funkcja działa na
  // tym serwerze, na którym plik jest (przycisk: `window.fabricAlternativesEnabled`,
  // base.njk; trasa `/position/fabric-alternatives/:groupNr`). Nazwa z kropką,
  // bo `express.static` (`/photos` = `<ROOT_DIR>/data`) pomija tylko pliki,
  // których NAZWA zaczyna się kropką — plik w katalogu `.coś/` serwował publicznie.
  fabricAlternativesFile: process.env.FABRIC_ALTERNATIVES_FILE
    || path.join(ROOT_DIR, 'data/data/.fabric-alternatives.json'),

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

  // ── Moduł „Serwis” — zgłoszenia reklamacyjne i serwisowe (services/serviceTickets) ──
  // `SERVICE_PANEL=true` — moduł widoczny (menu, przyciski „Zgłoś problem”, router
  // `/service`, panel admina `/admin/service`, asystent). `false` albo BRAK zmiennej =
  // wyłączony: router nie wstaje, menu nie pokazuje pozycji (decyzja Pawła 10.11.2026).
  //
  // ⚠️ Adresat maila do serwisu HKL jest WYŁĄCZNIE w `.env`: `SERVICE_NOTIFY_EMAIL`
  // (lista po przecinku) i per marka `SERVICE_NOTIFY_EMAIL_<IDENT_ORGANIZACJI>`
  // (np. `_LUXANGMBH`). Celowo bez fallbacku na `organization.email` — to skrzynki
  // zamówień produkcji (ten sam powód co `ASSISTANT_HANDOFF_EMAIL`). Brak adresu =
  // zgłoszenie zapisuje się i idzie na FTP, w dzienniku zdarzeń jest `mail_failed`.
  //
  // `SERVICE_MAIL_REDIRECT=a@x,b@y` — tryb testowy: mail do KLIENTA idzie wyłącznie
  // na te adresy (wzorzec `INVOICE_MAIL_REDIRECT`); poza produkcją baza ma prawdziwe
  // adresy klientów. Pusty = mail do klienta na adres z konta.
  //
  // Paczka dla HKL (katalog `<numer>/` z plikami i `ticket.json`) idzie na FTP
  // `FTP_HOST`/`FTP_USER` (konto orderbot, to samo co zlecenia) do katalogu
  // `SERVICE_FTP_DIR` — domyślnie `/service` przy `NODE_ENV=prod`, `/service-test`
  // poza produkcją (wzorzec `INVOICE_FTP_DIR`); lustro lokalne zawsze w
  // `outputData/service-out/`. Pliki zgłoszeń: `outputData/service/<numer>/`
  // (na produkcji `/eform/data/out` z hosta — trwały wolumen).
  //
  // Docelowy zapis do bazy reklamacji HKL robi cron hosta WEWNĘTRZNEGO (produkcja eForm na VPS
  // nie widzi LAN): `scripts/serviceHklSync.js` → services/serviceTickets/hklAdapter.js czyta
  // paczki z FTP i zapisuje do MySQL `reklamacje` (192.168.0.196) + zdjęcia na udział SMB.
  // Zmienne (sekrety w `.env.local`): `SERVICE_HKL_SYNC_ENABLED=true` (bez tego tylko --dry-run),
  // `SERVICE_HKL_SYNC_FTP_DIR` (domyślnie `/service`), `SERVICE_HKL_DB_HOST/PORT/USER/PASSWORD/DATABASE`,
  // `SERVICE_HKL_SMB_SHARE/DIR/USER/PASSWORD`, `SERVICE_HKL_OPERATOR` (`eForm`), `SERVICE_HKL_MAX_PER_RUN` (20).
  service: {
    mode: envSwitch(process.env.SERVICE_PANEL) ? 'true' : 'off',
    notifyEmail: process.env.SERVICE_NOTIFY_EMAIL || '',
    mailRedirect: process.env.SERVICE_MAIL_REDIRECT || '',
    ftpDir: process.env.SERVICE_FTP_DIR || ''
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

    // Dostawca modelu dla CZATU: `openai` (domyślnie; pola wyżej) albo
    // `anthropic` (Claude, services/assistant/anthropicClient.js). Głos zostaje
    // na OpenAI Realtime niezależnie od tej flagi i nadal wymaga OPENAI_API_KEY.
    // ⚠️ Klucz konta użytkownika Anthropic (nieprzypisany do workspace'u) działa
    // tylko z `ANTHROPIC_WORKSPACE_ID` — bez niego każde pytanie → konsultant.
    provider: String(process.env.ASSISTANT_PROVIDER || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai',
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      effort: process.env.ANTHROPIC_EFFORT || 'low'
    },

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
    // Eforek czyta na głos odpowiedzi i dymki pokazu (`ASSISTANT_TTS_ENABLED=true`) —
    // synteza mowy OpenAI (services/assistant/tts.js), zawsze OpenAI, jak rozmowa głosowa.
    tts: {
      enabled: envSwitch(process.env.ASSISTANT_TTS_ENABLED),
      url: process.env.OPENAI_TTS_URL || 'https://api.openai.com/v1/audio/speech',
      model: process.env.ASSISTANT_TTS_MODEL || 'gpt-4o-mini-tts',
      voice: process.env.ASSISTANT_TTS_VOICE || process.env.ASSISTANT_VOICE || 'marin',
      timeoutMs: Number(process.env.ASSISTANT_TTS_TIMEOUT_MS) || 30000,
      maxCharsPerDay: Number(process.env.ASSISTANT_TTS_MAX_CHARS_PER_DAY) || 30000
    },

    // Animowana maskotka (piesek Eforek, public/scripts/assistant/avatar.js) na
    // przycisku „Pomoc" i w nagłówku okna. Czysto wizualna: wyłączona = okno
    // jak dotąd, bez ładowania plików maskotki.
    avatar: {
      enabled: envSwitch(process.env.ASSISTANT_AVATAR_ENABLED),
      // `ASSISTANT_BARK_SOUND=true` — piesek szczeka (krótki dźwięk) w pokazie;
      // klient może go wyciszyć przyciskiem głośnika w dymku pokazu.
      barkSound: envSwitch(process.env.ASSISTANT_BARK_SOUND)
    },
    // `ASSISTANT_ANIMATE_ALWAYS=true` — piesek biega i się rusza także wtedy, gdy
    // system prosi o ograniczenie ruchu (prefers-reduced-motion). Pulpit zdalny
    // (RDP) i tryb „najlepsza wydajność” Windows włączają to po cichu i bez tego
    // pokaz traci animacje. `false` = szanujemy ustawienie systemu.
    animateAlways: envSwitch(process.env.ASSISTANT_ANIMATE_ALWAYS)
  }
};
