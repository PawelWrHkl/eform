'use strict';

/**
 * Automatyczne wystawianie faktur za zamówienia wysłane do klienta.
 *
 * Wołane z cyklicznego procesu (`scripts/prodStatusSync.js`) zaraz po
 * synchronizacji statusów produkcji — NIGDY z żądania HTTP, bo faktura nie może
 * zależeć od tego, czy ktoś wszedł na stronę. Zamówienie dostaje fakturę, gdy
 * cała jego produkcja ma status `!sent!` (warunki: `findAutoInvoiceCandidates`
 * w `db/repository.js`).
 *
 * FAKTURY ZBIORCZE: klient z fakturowaniem niestandardowym (`user.invoice_schedule`
 * = weekly/monthly, ustawia admin w /admin/users) nie dostaje faktury poziomu 2 za
 * każde zlecenie — po zamknięciu okresu automat wystawia mu JEDNĄ fakturę ze
 * wszystkich zleceń z tego okresu (`core/collective.js`, `InvoiceService.createCollective`).
 *
 * Konfiguracja (`.env`, domyślnie WYŁĄCZONE — brak zmiennej = nic się nie dzieje):
 *   INVOICE_AUTOGEN_ENABLED=true        włącznik
 *   INVOICE_AUTOGEN_SINCE=2026-10-01    WYMAGANE: tylko zamówienia wysłane od tego dnia
 *   INVOICE_AUTOGEN_LEVELS=1,2,3,4      poziomy (domyślnie wszystkie): 1 = HKL→organizacja,
 *                                       2 = organizacja→klient, 3 = salon→odbiorca końcowy,
 *                                       4 = organizacja→odbiorca końcowy
 *   INVOICE_AUTOGEN_ORGS=3,5            opcjonalnie: tylko te organizacje (id); puste = wszystkie
 *   INVOICE_AUTOGEN_ISSUE=true          `false` → szkice do przejrzenia zamiast faktur z numerem
 *   INVOICE_AUTOGEN_MAX_PER_RUN=100     bezpiecznik na jeden przebieg
 *
 * ⚠️ `SINCE` jest wymagane świadomie: w bazie są setki wysłanych zamówień
 * rozliczonych poza eForm. Bez progu pierwszy przebieg wystawiłby im wszystkim
 * faktury z bieżącą datą.
 *
 * Jedno zlecenie `!sent!` może dostać naraz: fakturę HKL dla organizacji (1),
 * organizacji dla klienta (2 — nie dla własnego konta organizacji) i sprzedaży do
 * odbiorcy końcowego przypisanego do zlecenia: od salonu (3) ALBO od organizacji
 * (4, gdy zlecenie złożyło własne konto organizacji). Zlecenie bez odbiorcy nie
 * dostaje faktury 3/4 — reguły w `db/repository.js:AUTO_LEVEL_SQL`.
 */

const { InvoiceService, DocumentType } = require('./main');
const defaultRepository = require('./db/repository');
const { InvoiceLevel } = require('./core/hierarchy');
const { HKL_ORG_ID } = require('./core/pricing');
const { features } = require('../../config');
const { groupCollectiveCandidates } = require('./core/collective');
const { todayIso } = require('./core/dates');
const { log: defaultLog } = require('../../utils/logging');

/** `created_by_pin` dokumentów automatu — po nim panel oznacza je na liście. */
const AUTO_ACTOR = 'AUTO';

/** Poziomy, które automat obsługuje — wszystkie relacje handlowe. */
const SUPPORTED_LEVELS = [
  InvoiceLevel.MANUFACTURER_TO_ORGANIZATION,
  InvoiceLevel.ORGANIZATION_TO_USER,
  InvoiceLevel.USER_TO_END_CLIENT,
  InvoiceLevel.ORGANIZATION_TO_END_CLIENT
];

const DEFAULT_MAX_PER_RUN = 100;

/**
 * @param {string|undefined} value
 * @returns {number[]}
 */
function parseIdList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Konfiguracja automatu z env. Czysta funkcja — błędy konfiguracji zwraca w
 * `problems`, a `active` jest prawdą tylko przy kompletnej konfiguracji.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ invoicesEnabled?: boolean }} [opts] stan flagi INVOICES_ENABLED
 * @returns {{ enabled: boolean, active: boolean, since: string|null, levels: number[], organizationIds: number[], issue: boolean, maxPerRun: number, problems: string[] }}
 */
function readAutoInvoiceConfig(env = process.env, { invoicesEnabled = !!features?.invoices } = {}) {
  const enabled = String(env.INVOICE_AUTOGEN_ENABLED).toLowerCase() === 'true';
  const problems = [];

  const rawSince = String(env.INVOICE_AUTOGEN_SINCE || '').trim();
  const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSince) ? new Date(`${rawSince}T00:00:00Z`) : null;
  const since = sinceDate && !Number.isNaN(sinceDate.getTime()) && sinceDate.toISOString().slice(0, 10) === rawSince
    ? rawSince
    : null;

  const requestedLevels = env.INVOICE_AUTOGEN_LEVELS === undefined || String(env.INVOICE_AUTOGEN_LEVELS).trim() === ''
    ? [...SUPPORTED_LEVELS]
    : parseIdList(env.INVOICE_AUTOGEN_LEVELS);
  const levels = [...new Set(requestedLevels)].filter((lv) => SUPPORTED_LEVELS.includes(lv)).sort((a, b) => a - b);
  const ignoredLevels = requestedLevels.filter((lv) => !SUPPORTED_LEVELS.includes(lv));

  const maxPerRun = Number(env.INVOICE_AUTOGEN_MAX_PER_RUN);

  if (enabled) {
    if (!invoicesEnabled) problems.push('moduł faktur jest wyłączony (INVOICES_ENABLED)');
    if (!since) problems.push(`INVOICE_AUTOGEN_SINCE musi być datą RRRR-MM-DD (jest: „${rawSince}")`);
    if (ignoredLevels.length) problems.push(`INVOICE_AUTOGEN_LEVELS: automat obsługuje tylko poziomy ${SUPPORTED_LEVELS.join(', ')} (pominięto: ${ignoredLevels.join(', ')})`);
    if (!levels.length) problems.push('INVOICE_AUTOGEN_LEVELS nie zawiera żadnego obsługiwanego poziomu');
  }

  return {
    enabled,
    // Pominięty poziom spoza zakresu to ostrzeżenie, nie blokada — reszta działa
    active: enabled && invoicesEnabled && !!since && levels.length > 0,
    since,
    levels,
    organizationIds: parseIdList(env.INVOICE_AUTOGEN_ORGS),
    issue: String(env.INVOICE_AUTOGEN_ISSUE ?? 'true').toLowerCase() !== 'false',
    maxPerRun: Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : DEFAULT_MAX_PER_RUN,
    problems
  };
}

/**
 * Jeden przebieg automatu.
 *
 * Każde zamówienie to osobny dokument i osobna transakcja (`createFromOrder`) —
 * błąd jednego (np. zerowa wartość, brak danych nabywcy) nie zatrzymuje reszty.
 * Nieudane zamówienie wraca w kolejnym przebiegu, więc błąd jest widoczny
 * w logu, dopóki ktoś go nie usunie albo nie wystawi dokumentu ręcznie.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] tylko wypisz kandydatów, nic nie wystawiaj
 * @param {ReturnType<typeof readAutoInvoiceConfig>} [opts.config]
 * @param {Object} [opts.deps] `{ repository, service, log, now }` — podmiana w testach
 * @returns {Promise<{ skipped?: string, created: object[], failed: object[], planned: object[], skippedExisting: number }>}
 */
async function runAutoInvoicing({ dryRun = false, config = readAutoInvoiceConfig(), deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const now = deps.now || (() => new Date());
  const result = { created: [], failed: [], planned: [], skippedExisting: 0 };

  if (config.problems.length) {
    config.problems.forEach((p) => log(`[invoices:auto] konfiguracja: ${p}`));
  }
  if (!config.active) {
    if (config.enabled) log('[invoices:auto] automat NIE ruszył — popraw konfigurację powyżej');
    return { ...result, skipped: config.enabled ? 'config' : 'disabled' };
  }

  const service = deps.service || new InvoiceService({ repository, log });
  let budget = config.maxPerRun;

  for (const level of config.levels) {
    if (budget <= 0) break;
    const candidates = await repository.findAutoInvoiceCandidates({
      level,
      since: config.since,
      organizationIds: config.organizationIds,
      // HKL nie sprzedaje sam sobie — poziom 1 dotyczy wyłącznie innych organizacji
      excludeOrganizationId: level === InvoiceLevel.MANUFACTURER_TO_ORGANIZATION ? HKL_ORG_ID : null,
      limit: budget
    });

    for (const order of candidates) {
      if (budget <= 0) break;
      budget--;
      const label = `zamówienie ${order.order_idx} (id ${order.id}, ${order.user_ident}), poziom ${level}`;

      if (dryRun) {
        result.planned.push({ orderId: order.id, orderIdx: order.order_idx, level, userIdent: order.user_ident });
        log(`[invoices:auto] DRY-RUN: wystawiłbym fakturę — ${label}`);
        continue;
      }

      try {
        if (await repository.hasLevelInvoice({ orderId: order.id, level })) {
          result.skippedExisting++;
          continue;
        }
        const created = await service.createFromOrder({
          orderId: order.id,
          level,
          documentType: DocumentType.INVOICE,
          issue: config.issue,
          createdByPin: AUTO_ACTOR
        });
        result.created.push({ orderId: order.id, level, invoiceId: created.id, number: created.number });
        log(`[invoices:auto] ${created.number ? `faktura ${created.number}` : `szkic #${created.id}`} — ${label}`);
      } catch (err) {
        result.failed.push({ orderId: order.id, level, error: err.message });
        log(`[invoices:auto] BŁĄD — ${label}: ${err.message}`);
      }
    }
  }

  // Faktury zbiorcze — poziom 2 dla klientów z harmonogramem tygodniowym/miesięcznym
  if (config.levels.includes(InvoiceLevel.ORGANIZATION_TO_USER) && budget > 0 && repository.findCollectiveCandidates) {
    const rows = await repository.findCollectiveCandidates({ since: config.since, organizationIds: config.organizationIds });
    const groups = groupCollectiveCandidates(rows, { todayIso: todayIso(now()) });
    for (const group of groups) {
      if (budget <= 0) break;
      budget--;
      const label = `faktura zbiorcza ${group.period.key} (${group.schedule}) — klient ${group.userIdent || group.userId}, zamówienia ${group.orderIds.join(', ')}`;

      if (dryRun) {
        result.planned.push({ collective: true, userId: group.userId, period: group.period.key, orderIds: group.orderIds, level: InvoiceLevel.ORGANIZATION_TO_USER });
        log(`[invoices:auto] DRY-RUN: wystawiłbym — ${label}`);
        continue;
      }

      try {
        // Między wyszukaniem a wystawieniem ktoś mógł zafakturować zlecenie ręcznie
        const orderIds = [];
        for (const orderId of group.orderIds) {
          if (!(await repository.hasLevelInvoice({ orderId, level: InvoiceLevel.ORGANIZATION_TO_USER }))) orderIds.push(orderId);
        }
        if (!orderIds.length) {
          result.skippedExisting += group.orderIds.length;
          continue;
        }
        const created = await service.createCollective({
          orderIds,
          period: group.period,
          issue: config.issue,
          createdByPin: AUTO_ACTOR
        });
        result.created.push({ collective: true, userId: group.userId, period: group.period.key, orderIds, level: InvoiceLevel.ORGANIZATION_TO_USER, invoiceId: created.id, number: created.number });
        log(`[invoices:auto] ${created.number ? `faktura ${created.number}` : `szkic #${created.id}`} — ${label}`);
      } catch (err) {
        result.failed.push({ collective: true, userId: group.userId, period: group.period.key, orderIds: group.orderIds, level: InvoiceLevel.ORGANIZATION_TO_USER, error: err.message });
        log(`[invoices:auto] BŁĄD — ${label}: ${err.message}`);
      }
    }
  }

  if (budget <= 0) {
    log(`[invoices:auto] wyczerpany limit ${config.maxPerRun} zamówień na przebieg (INVOICE_AUTOGEN_MAX_PER_RUN) — ewentualna reszta w następnym`);
  }
  log(`[invoices:auto] ${dryRun ? `DRY-RUN: do wystawienia ${result.planned.length}` : `wystawiono ${result.created.length}, błędy ${result.failed.length}`}`
    + ` (poziomy ${config.levels.join(', ')}, od ${config.since}${config.organizationIds.length ? `, organizacje ${config.organizationIds.join(', ')}` : ''})`);
  return result;
}

module.exports = {
  AUTO_ACTOR,
  SUPPORTED_LEVELS,
  readAutoInvoiceConfig,
  runAutoInvoicing
};
