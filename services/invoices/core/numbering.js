'use strict';

/**
 * Numeracja dokumentów według wzorca definiowanego per organizacja.
 *
 * Wzorzec to string ze znacznikami w klamrach, np.:
 *   `FV/{YYYY}/{MM}/{NR}`              → `FV/2026/08/17`
 *   `INV/{ORG}/{YYYY}/{NR:5}`          → `INV/HKL/2026/00017`
 *   `ZAL/{YYYY}{MM}{DD}/{NR:3}`        → `ZAL/20260805/003`
 *
 * Obsługiwane znaczniki:
 *   {YYYY} rok, {YY} rok 2-cyfrowy, {MM} miesiąc, {DD} dzień,
 *   {NR} licznik, {NR:n} licznik dopełniony zerami do n znaków,
 *   {ORG} kod organizacji (`organization.ident`), {TYPE} kod typu dokumentu.
 *
 * ⚠️ Licznik jest zerowany według **okresu wynikającego ze wzorca**: jeśli wzorzec
 * zawiera {MM} — numeracja jest miesięczna, jeśli tylko {YYYY} — roczna, jeśli
 * żadnego z nich — ciągła. Klucz okresu wyliczany przez `resolvePeriodKey`
 * trafia do tabeli `invoice_sequence`, więc zmiana wzorca w trakcie roku
 * zaczyna nowy licznik zamiast dublować numery.
 */

const TOKEN_RE = /\{(YYYY|YY|MM|DD|NR(?::\d+)?|ORG|TYPE)\}/g;

/** Ten sam wzorzec bez flagi `g` — regexp z `g` trzyma `lastIndex` między
 *  wywołaniami `.test()`, co daje naprzemienne false/true. Klasyczna pułapka,
 *  dlatego walidacja używa wersji bez flagi. */
const TOKEN_RE_SINGLE = /^\{(YYYY|YY|MM|DD|NR(?::\d+)?|ORG|TYPE)\}$/;

/** Domyślne wzorce per typ dokumentu — używane, gdy organizacja nie ma własnych. */
const DEFAULT_PATTERNS = Object.freeze({
  proforma: 'PF/{YYYY}/{MM}/{NR}',
  advance: 'ZAL/{YYYY}/{MM}/{NR}',
  final: 'FV/{YYYY}/{MM}/{NR}',
  invoice: 'FV/{YYYY}/{MM}/{NR}',
  correction: 'KOR/{YYYY}/{MM}/{NR}'
});

/**
 * @param {string} isoDate `YYYY-MM-DD`
 * @returns {{ YYYY: string, YY: string, MM: string, DD: string }}
 */
function dateParts(isoDate) {
  const [y = '', m = '', d = ''] = String(isoDate || '').split('-');
  return { YYYY: y, YY: y.slice(-2), MM: m, DD: d };
}

/**
 * Klucz okresu, w którym licznik jest niezależny.
 * Wynika ze wzorca, nie z założenia — patrz komentarz na górze pliku.
 *
 * @param {string} pattern
 * @param {string} isoDate
 * @returns {string} np. `2026-08`, `2026` albo `all`
 */
function resolvePeriodKey(pattern, isoDate) {
  const p = dateParts(isoDate);
  const hasYear = /\{(YYYY|YY)\}/.test(pattern);
  const hasMonth = /\{MM\}/.test(pattern);
  const hasDay = /\{DD\}/.test(pattern);
  if (hasDay && hasMonth && hasYear) return `${p.YYYY}-${p.MM}-${p.DD}`;
  if (hasMonth && hasYear) return `${p.YYYY}-${p.MM}`;
  if (hasYear) return p.YYYY;
  return 'all';
}

/**
 * Podstawia znaczniki wzorca.
 *
 * @param {Object} params
 * @param {string} params.pattern
 * @param {number} params.sequence      Kolejny numer w okresie (1..n).
 * @param {string} params.isoDate       Data wystawienia `YYYY-MM-DD`.
 * @param {string} [params.orgCode]     `organization.ident`.
 * @param {string} [params.typeCode]    Kod typu dokumentu.
 * @returns {string}
 */
function formatNumber({ pattern, sequence, isoDate, orgCode = '', typeCode = '' }) {
  const p = dateParts(isoDate);
  return String(pattern).replace(TOKEN_RE, (token, name) => {
    if (name.startsWith('NR')) {
      const [, width] = name.split(':');
      const str = String(sequence);
      return width ? str.padStart(Number(width), '0') : str;
    }
    if (name === 'ORG') return orgCode;
    if (name === 'TYPE') return typeCode;
    return p[name] ?? token;
  });
}

/**
 * Walidacja wzorca przed zapisaniem w profilu organizacji.
 * Wzorzec bez licznika oznaczałby duplikaty numerów — odrzucamy.
 *
 * @param {string} pattern
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePattern(pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return { valid: false, error: 'Wzorzec numeracji musi być niepustym tekstem.' };
  }
  if (!/\{NR(?::\d+)?\}/.test(pattern)) {
    return { valid: false, error: 'Wzorzec musi zawierać znacznik licznika {NR} lub {NR:n}.' };
  }
  const unknown = (pattern.match(/\{[^}]*\}/g) || []).filter((t) => !TOKEN_RE_SINGLE.test(t));
  if (unknown.length) {
    return { valid: false, error: `Nieznane znaczniki we wzorcu: ${unknown.join(', ')}` };
  }
  return { valid: true };
}

/**
 * Serwis numeracji. Sam nie zna SQL-a — dostaje `allocateSequence`, które
 * ma **atomowo** zarezerwować kolejny numer w okresie (w MySQL: `INSERT …
 * ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
 * patrz `db/repository.js`). Dzięki temu dwa równoległe requesty nie dostaną
 * tego samego numeru, a testy nie potrzebują bazy.
 */
class NumberingService {
  /**
   * @param {Object} deps
   * @param {(params: { organizationId: number, documentType: string, periodKey: string }) => Promise<number>} deps.allocateSequence
   */
  constructor(deps) {
    if (!deps || typeof deps.allocateSequence !== 'function') {
      throw new Error('NumberingService wymaga zależności `allocateSequence`.');
    }
    this.allocateSequence = deps.allocateSequence;
  }

  /**
   * @param {Object} params
   * @param {number} params.organizationId
   * @param {string} params.documentType
   * @param {string} params.isoDate
   * @param {string} [params.pattern]     Wzorzec organizacji; gdy brak — domyślny dla typu.
   * @param {string} [params.orgCode]
   * @returns {Promise<{ number: string, sequence: number, periodKey: string, pattern: string }>}
   */
  async next({ organizationId, documentType, isoDate, pattern, orgCode }) {
    const effectivePattern = pattern || DEFAULT_PATTERNS[documentType] || DEFAULT_PATTERNS.invoice;
    const check = validatePattern(effectivePattern);
    if (!check.valid) throw new Error(`Nieprawidłowy wzorzec numeracji: ${check.error}`);

    const periodKey = resolvePeriodKey(effectivePattern, isoDate);
    const sequence = await this.allocateSequence({ organizationId, documentType, periodKey });

    return {
      number: formatNumber({ pattern: effectivePattern, sequence, isoDate, orgCode, typeCode: documentType }),
      sequence,
      periodKey,
      pattern: effectivePattern
    };
  }
}

module.exports = {
  DEFAULT_PATTERNS,
  dateParts,
  resolvePeriodKey,
  formatNumber,
  validatePattern,
  NumberingService
};
