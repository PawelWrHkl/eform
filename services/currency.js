/**
 * Waluta cen klienta — w jakiej walucie klient widzi (i dostaje) ceny z
 * konfiguratora.
 *
 * Stan na 2026-10-08: wszystko w EUR, wyjątek to klienci organizacji
 * LUXAN_EWA_KRAWCZYK (`organization.id = 4`) — PLN. Ustawienie siedzi w
 * bazie, nie w kodzie (migracja `migrations/add_currency.sql`):
 *
 *   1. `user.currency`         — waluta KONKRETNEGO klienta (NULL = jak organizacja),
 *   2. `organization.currency` — domyślna waluta klientów organizacji (NULL = EUR),
 *   3. `DEFAULT_CURRENCY`      — EUR.
 *
 * Pierwsza niepusta i znana wartość wygrywa. Ustawienie per klient (punkt 1)
 * jest przygotowane, ale nie ma jeszcze ekranu — dziś zmienia się je w bazie.
 *
 * ⚠️ Waluta to na razie WYŁĄCZNIE etykieta: kwoty liczą skrypty cenowe
 * (`param-*.js`) i nic tu nie przelicza kursów. Do opisu każdego parametru
 * kwotowego dopisujemy na końcu `[<KOD>]`, np. „CENA HKL netto [PLN]” —
 * `public/scripts/formTools/currencyLabel.js` (formularz) i
 * `withCurrencyLabel` niżej (tłumaczenie tabel pozycji, itemTranslator.js).
 *
 * ⚠️ Waluta jest czytana z klienta ZAMÓWIENIA (`order.user_id`), nie z sesji —
 * ta sama zasada co przy rabacie i narzucie (services/groupPriceMode.js):
 * pozycję konfiguruje raz klient, raz owner/admin/grupa w jego kontekście, a
 * waluta ma wyjść ta sama.
 *
 * ⚠️ Kolumny dochodzą migracją. Zanim zostanie uruchomiona, moduł sprawdza
 * schemat (`information_schema`, wynik trzymany kilka minut) i bez kolumn
 * po prostu zwraca EUR — czyli zachowanie sprzed zmiany, bez błędu w logu
 * przy każdym otwarciu formularza.
 */

'use strict';

// `db/core` ładowany leniwie: formatowanie kwot (`formatAmount`) używają też
// moduły testowane bez MySQL-a (services/subPrices.js) — samo wczytanie
// `db/core` zakłada pulę połączeń.
const selectQuery = (...args) => require('../db/core').selectQuery(...args);
const updateQuery = (...args) => require('../db/core').updateQuery(...args);
const { log } = require('../utils/logging');

const DEFAULT_CURRENCY = 'EUR';

/**
 * Obsługiwane waluty. Dodanie kolejnej = jeden wpis tutaj i ustawienie kodu w
 * `organization.currency`/`user.currency`. Kod spoza listy jest ignorowany
 * (z wpisem w logu) — literówka w bazie nie może wypisać klientowi „[PNL]”.
 * ⚠️ Lista ma kopię w `public/scripts/formTools/currencyLabel.js`
 * (`CURRENCY_SYMBOLS`) — przeglądarka zdejmuje stare znaczniki i dobiera symbol
 * dla widoku B. Test services/__tests__/currency.test.js pilnuje zgodności.
 */
const CURRENCIES = Object.freeze({
    // `suffix` — to, co stoi ZA kwotą w sumach zlecenia, PDF-ie i mailu.
    // EUR bez spacji („103.93€”), bo tak te sumy wyglądały zawsze; złoty po
    // polsku ze spacją („103.93 zł”).
    EUR: Object.freeze({ code: 'EUR', symbol: '€', suffix: '€', name: 'Euro' }),
    PLN: Object.freeze({ code: 'PLN', symbol: 'zł', suffix: ' zł', name: 'Polski złoty' })
});

/** Kod ISO z listy `CURRENCIES` (wielkość liter i spacje bez znaczenia), inaczej `null`. */
function normalizeCurrency(value) {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(CURRENCIES, code) ? code : null;
}

/** Pierwsza znana waluta z listy kandydatów (od najważniejszego), inaczej EUR. */
function pickCurrency(...candidates) {
    for (const candidate of candidates) {
        const code = normalizeCurrency(candidate);
        if (code) return code;
    }
    return DEFAULT_CURRENCY;
}

function currencyMeta(code) {
    return CURRENCIES[normalizeCurrency(code) || DEFAULT_CURRENCY];
}

/** „€”, „zł” — do tekstów ze spacją przed symbolem („10 €”, rabat kwotowy). */
function currencySymbol(code) {
    return currencyMeta(code).symbol;
}

/** „€”, „ zł” — doklejany wprost za kwotą w sumach („103.93€”, „103.93 zł”). */
function currencySuffix(code) {
    return currencyMeta(code).suffix;
}

/**
 * Kwota z walutą tak, jak stoi w sumach zlecenia, PDF-ie i mailu:
 * `formatAmount('103.93', 'EUR')` → „103.93€”, `…'PLN'` → „103.93 zł”.
 * Liczba przechodzi bez zmian (bez zaokrąglania) — formatuje ją wołający.
 */
function formatAmount(amount, code) {
    return `${amount}${currencySuffix(code)}`;
}

// ─── Etykiety ───────────────────────────────────────────────────────────────

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Znaczniki waluty, które mogą już siedzieć w opisie: `[€]` z param.txt sprzed
 * 2026-10-08 (zdjęte tego dnia przez autorów danych, ale zostało w starych
 * wersjach reguł i w grupie 76) oraz kody z `CURRENCIES`. Świadomie BEZ
 * ogólnego `[A-Z]{3}` — w opisach są też jednostki `[PCS]`, `[SZT]`.
 */
const MARKER_RE = new RegExp(
    `\\s*\\[(?:${['€', ...Object.keys(CURRENCIES)].map(escapeRegExp).join('|')})\\]`,
    'g'
);
const TRAILING_MARKER_RE = new RegExp(`\\[(${Object.keys(CURRENCIES).join('|')})\\]\\s*$`);

/**
 * „CENA HKL [€] netto” + PLN → „CENA HKL netto [PLN]”. Stary znacznik znika,
 * kod waluty zawsze ląduje NA KOŃCU, podwójne spacje (ślad po zdjętym `[€]`)
 * są ściągane. Pusty opis zostaje pusty.
 *
 * ⚠️ Bliźniak `withCurrencyLabel` z `public/scripts/formTools/currencyLabel.js`
 * — test `services/__tests__/currency.test.js` pilnuje, że oba dają to samo.
 */
function withCurrencyLabel(description, currency) {
    const base = String(description ?? '').replace(MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
    if (!base) return base;
    return `${base} [${pickCurrency(currency)}]`;
}

/** Rdzeń nazwy parametru kwotowego (po zdjęciu `SUB___` i końcówki `_S`). */
const MONETARY_NAME_RE = /^(CENA|DOPLATA|SUMA|WARTOSC)/;

/**
 * Parametr kwotowy po samej NAZWIE — bliźniak `isMonetaryParam` z
 * `public/scripts/formTools/currencyLabel.js` dla miejsc, które znają tylko
 * klucz zapisanej pozycji (`json_parameters_desc`), bez definicji z param.txt.
 * Stawki rabatu (`*_RABAT`, także ich specyfikacja `*_RABAT_S`) — nie.
 */
function isMonetaryParamName(name) {
    if (typeof name !== 'string') return false;
    const base = name.replace(/^SUB___/, '').replace(/_S$/, '');
    if (/RABAT$/.test(base)) return false;
    return MONETARY_NAME_RE.test(base);
}

/**
 * Waluta zapisana w etykiecie: kod z końca („… [PLN]” → 'PLN') albo stary
 * `[€]` gdziekolwiek (pozycje sprzed 2026-10-08 → 'EUR'); inaczej `null`.
 */
function currencyOfLabel(label) {
    const text = String(label ?? '');
    const match = text.match(TRAILING_MARKER_RE);
    if (match) return match[1];
    return text.includes('[€]') ? 'EUR' : null;
}

// ─── Baza ───────────────────────────────────────────────────────────────────

const COLUMNS_TTL_MS = 5 * 60 * 1000;
let columnsCache = null;

/**
 * Które z kolumn `currency` już istnieją: `{ user: bool, organization: bool }`.
 * Pamiętane `COLUMNS_TTL_MS` — po migracji zaczyna działać bez restartu.
 */
async function currencyColumns(deps = {}) {
    const now = (deps.now || Date.now)();
    if (!deps.select && columnsCache && now - columnsCache.at < COLUMNS_TTL_MS) {
        return columnsCache.columns;
    }
    const select = deps.select || selectQuery;
    const rows = await select(
        `SELECT TABLE_NAME AS table_name FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'currency'
           AND TABLE_NAME IN ('user', 'organization')`
    );
    const tables = new Set((rows || []).map((row) => row.table_name || row.TABLE_NAME));
    const columns = { user: tables.has('user'), organization: tables.has('organization') };
    if (!deps.select) columnsCache = { at: now, columns };
    return columns;
}

function resetCurrencyColumnsCache() {
    columnsCache = null;
}

/** Wpis w logu, gdy w bazie siedzi kod spoza `CURRENCIES` — inaczej po cichu byłoby EUR. */
function warnUnknown(row, zapisz, where) {
    for (const [field, value] of [['user.currency', row.user_currency], ['organization.currency', row.org_currency]]) {
        if (value !== null && value !== undefined && String(value).trim() !== '' && !normalizeCurrency(value)) {
            zapisz(`[currency] nieobsługiwana waluta ${field}='${value}' (${where}) — pomijam`);
        }
    }
}

async function resolveCurrency(whereSql, param, where, deps) {
    const select = deps.select || selectQuery;
    const zapisz = deps.log || log;
    try {
        const columns = await currencyColumns(deps);
        if (!columns.user && !columns.organization) return DEFAULT_CURRENCY;
        const rows = await select(
            `SELECT ${columns.user ? 'u.currency' : 'NULL'} AS user_currency,
                    ${columns.organization ? 'org.currency' : 'NULL'} AS org_currency
             FROM \`user\` u
             LEFT JOIN organization org ON org.id = u.organization_id
             ${whereSql}`,
            [param]
        );
        const row = rows && rows[0];
        if (!row) return DEFAULT_CURRENCY;
        warnUnknown(row, zapisz, where);
        return pickCurrency(row.user_currency, row.org_currency);
    } catch (err) {
        // Brak informacji nie może zablokować formularza — EUR to zachowanie sprzed zmiany.
        zapisz('[currency] nie udało się odczytać waluty:', err.message);
        return DEFAULT_CURRENCY;
    }
}

/** Waluta klienta ZAMÓWIENIA (`order.user_id`). */
async function resolveCurrencyForOrder(orderId, deps = {}) {
    if (!orderId) return DEFAULT_CURRENCY;
    return resolveCurrency(
        'JOIN `order` o ON o.user_id = u.id WHERE o.id = ?',
        orderId,
        `zamówienie ${orderId}`,
        deps
    );
}

/** Waluta klienta po `user.ident` (silnik bez zamówienia — np. import). */
async function resolveCurrencyForUserIdent(userIdent, deps = {}) {
    if (!userIdent) return DEFAULT_CURRENCY;
    return resolveCurrency('WHERE u.ident = ? LIMIT 1', userIdent, `klient ${userIdent}`, deps);
}

/** Zmienne szablonu dla kodu i symboli waluty — patrz `currencyLocalsForOrder`. */
function currencyLocals(code) {
    const priceCurrency = currencyMeta(code).code;
    return {
        priceCurrency,
        currencySymbol: currencySymbol(priceCurrency),
        currencySuffix: currencySuffix(priceCurrency)
    };
}

/**
 * Zmienne szablonu stron jednego zamówienia: `priceCurrency` (→
 * `window.priceCurrency` w base.njk — konfigurator, rabat, Excel),
 * `currencySuffix`/`currencySymbol` (sumy w `order.njk`, `order_prices.njk`,
 * `order_to_print.njk`). Brak w kontekście = szablony biorą „€”.
 */
async function currencyLocalsForOrder(orderId, deps = {}) {
    return currencyLocals(await resolveCurrencyForOrder(orderId, deps));
}

// ─── Ustawienie w panelu admina (/admin/users) ──────────────────────────────

/** Opcje listy „Waluta cen” w panelu — z `CURRENCIES`, więc nowa waluta pojawia się sama. */
const CURRENCY_OPTIONS = Object.freeze(Object.values(CURRENCIES).map((c) => Object.freeze({
    value: c.code,
    label: `${c.code} — ${c.name} (${c.symbol})`
})));

/**
 * Waluta konta do panelu: własna (`user.currency`, `null` = jak organizacja),
 * organizacji i wynikowa. `available: false` — przed migracją (brak kolumny
 * `user.currency`); panel pokazuje wtedy komunikat zamiast listy.
 *
 * @returns {Promise<{available:boolean, user:string|null, organization:string|null, effective:string}>}
 */
async function getUserCurrencySetting(userId, deps = {}) {
    const empty = { available: false, user: null, organization: null, effective: DEFAULT_CURRENCY };
    if (!userId) return empty;
    const select = deps.select || selectQuery;
    try {
        const columns = await currencyColumns(deps);
        if (!columns.user) return empty;
        const rows = await select(
            `SELECT u.currency AS user_currency,
                    ${columns.organization ? 'org.currency' : 'NULL'} AS org_currency
             FROM \`user\` u
             LEFT JOIN organization org ON org.id = u.organization_id
             WHERE u.id = ?`,
            [userId]
        );
        const row = rows && rows[0];
        if (!row) return { ...empty, available: true };
        const user = normalizeCurrency(row.user_currency);
        const organization = normalizeCurrency(row.org_currency);
        return { available: true, user, organization, effective: pickCurrency(user, organization) };
    } catch (err) {
        (deps.log || log)('[currency] nie udało się odczytać waluty konta:', err.message);
        return empty;
    }
}

/**
 * Zapis waluty konta z panelu. `''`/`null` = „jak organizacja” (NULL w bazie).
 * Kod spoza `CURRENCIES` to błąd — literówka nie może po cichu dać EUR.
 *
 * @returns {Promise<{ok:boolean, error?:string, value?:string|null}>}
 */
async function setUserCurrency(userId, raw, deps = {}) {
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    const value = text === '' ? null : normalizeCurrency(text);
    if (text !== '' && !value) {
        return { ok: false, error: `Nieobsługiwana waluta: ${raw}. Dozwolone: ${Object.keys(CURRENCIES).join(', ')}.` };
    }
    const columns = await currencyColumns(deps);
    if (!columns.user) {
        return { ok: false, error: 'Brak kolumny user.currency — wykonaj migrację migrations/add_currency.sql' };
    }
    const update = deps.update || updateQuery;
    const result = await update('UPDATE `user` SET currency = ? WHERE id = ?', [value, userId]);
    if (!result) return { ok: false, error: 'Zapis waluty nie powiódł się' };
    return { ok: true, value };
}

module.exports = {
    DEFAULT_CURRENCY,
    CURRENCIES,
    normalizeCurrency,
    pickCurrency,
    currencySymbol,
    currencySuffix,
    formatAmount,
    currencyLocals,
    withCurrencyLabel,
    currencyOfLabel,
    isMonetaryParamName,
    currencyColumns,
    resetCurrencyColumnsCache,
    resolveCurrencyForOrder,
    resolveCurrencyForUserIdent,
    CURRENCY_OPTIONS,
    getUserCurrencySetting,
    setUserCurrency,
    currencyLocalsForOrder
};
