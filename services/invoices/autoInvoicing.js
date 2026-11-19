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
 * FAKTURY DZIENNE HKL (od `INVOICE_DAILY_SINCE`): jedna faktura za dzień wysyłki —
 * organizacji (poziom 1, zlecenia wszystkich jej klientów) i każdemu klientowi HKL
 * (poziom 2; klient z fakturą tygodniową/miesięczną dostaje zbiorczą). Od 18.11.2026
 * (Paweł, mail szefa: „dajemy zbiorczo per dzień wysyłki”) to JEDYNA faktura relacji HKL —
 * per zlecenie HKL → organizacja i HKL → klient HKL nie powstają; organizacja → klient
 * (poziom 2 innych organizacji), poziomy 3 i 4 zostają per zlecenie. Autor `DAILY_ACTOR`,
 * mail jak reszta automatu, FTP w `dzienne/`. Dzień zamyka się o północy — dzienna powstaje
 * w pierwszym przebiegu następnego dnia — i nie powstaje druga za ten sam dzień: zlecenie
 * ze spóźnionym statusem dołącza przycisk „Przelicz dzienne ponownie” w panelu admina
 * (`recalculateDailyInvoices`). Numeracja: jedna seria HKL `{YY}{NR:6}` (`repository.HKL_SERIES`).
 *
 * RĘCZNA EDYCJA (admin i biuro, 17.11.2026): szkic przygotowany przed !sent! automat
 * wystawia po !sent! zamiast budować fakturę od zera — nakładka ręcznych zmian
 * (`core/manualEdit.js`) nakłada się na aktualne zamówienie, mail i FTP jak zawsze.
 * Nakładkę stosuje też faktura dzienna i zbiorcza. Nakładka niepasująca do zamówienia
 * (ruszona pozycja zmieniona albo usunięta) → „do przejrzenia”, bez wystawienia.
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
 *   INVOICE_DAILY_SINCE=2026-11-06      faktury dzienne HKL za dni wysyłki od tego dnia; puste = wyłączone
 *                                       (wtedy relacje HKL wracają do faktur per zlecenie)
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

const { InvoiceService, DocumentType, ZERO_TOTAL_ERROR_CODE, NO_LETTERHEAD_ERROR_CODE } = require('./main');
const { MANUAL_EDIT_CONFLICT_CODE } = require('./core/manualEdit');
const defaultRepository = require('./db/repository');
const { InvoiceLevel } = require('./core/hierarchy');
const { HKL_ORG_ID } = require('./core/pricing');
const { features } = require('../../config');
const { groupCollectiveCandidates, groupDailyCandidates, sortDailyOrders, DAILY_ACTOR } = require('./core/collective');
const { todayIso } = require('./core/dates');
const { log: defaultLog } = require('../../utils/logging');

/** `created_by_pin` dokumentów automatu — po nim panel oznacza je na liście. */
const AUTO_ACTOR = 'AUTO';

/** Poziomy faktur dziennych HKL: 1 (organizacja) i 2 (klient HKL). */
const DAILY_LEVELS = [InvoiceLevel.MANUFACTURER_TO_ORGANIZATION, InvoiceLevel.ORGANIZATION_TO_USER];

/** Nabywca faktury dziennej (`repository.findDailyInvoices`): organizacja albo klient HKL i sklep grupowy. */
const dailyBuyer = (group) => ({
  level: group.level, organizationId: group.organizationId, userId: group.userId, groupUserId: group.groupUserId, day: group.period.key
});

/** Poziomy, które automat obsługuje — wszystkie relacje handlowe. */
const SUPPORTED_LEVELS = [
  InvoiceLevel.MANUFACTURER_TO_ORGANIZATION,
  InvoiceLevel.ORGANIZATION_TO_USER,
  InvoiceLevel.USER_TO_END_CLIENT,
  InvoiceLevel.ORGANIZATION_TO_END_CLIENT
];

const DEFAULT_MAX_PER_RUN = 100;

/** @returns {string|null} data RRRR-MM-DD albo `null` przy pustej/złej wartości */
function parseIsoDay(value) {
  const raw = String(value || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
  return date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : null;
}

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
 * @returns {{ enabled: boolean, active: boolean, since: string|null, dailySince: string|null, levels: number[], organizationIds: number[], issue: boolean, maxPerRun: number, problems: string[] }}
 */
function readAutoInvoiceConfig(env = process.env, { invoicesEnabled = !!features?.invoices } = {}) {
  const enabled = String(env.INVOICE_AUTOGEN_ENABLED).toLowerCase() === 'true';
  const problems = [];

  const rawSince = String(env.INVOICE_AUTOGEN_SINCE || '').trim();
  const since = parseIsoDay(rawSince);
  const rawDailySince = String(env.INVOICE_DAILY_SINCE || '').trim();
  const dailySince = parseIsoDay(rawDailySince);

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
    if (rawDailySince && !dailySince) problems.push(`INVOICE_DAILY_SINCE musi być datą RRRR-MM-DD (jest: „${rawDailySince}") — faktury dzienne wyłączone`);
  }

  return {
    enabled,
    // Pominięty poziom spoza zakresu to ostrzeżenie, nie blokada — reszta działa
    active: enabled && invoicesEnabled && !!since && levels.length > 0,
    since,
    dailySince,
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
 * błąd jednego (np. brak danych nabywcy) nie zatrzymuje reszty. Nieudane
 * zamówienie wraca w kolejnym przebiegu, więc błąd jest widoczny w logu, dopóki
 * ktoś go nie usunie albo nie wystawi dokumentu ręcznie.
 *
 * Zamówienie o ZEROWEJ wartości netto na danym poziomie (`ZERO_TOTAL_ERROR_CODE`
 * — np. testowe zlecenie bez cen, klient bez cen SUB___ przy fakturze
 * organizacja → klient) to nie awaria, tylko „nic do zafakturowania": trafia do
 * `skippedZero`, jednym zbiorczym wpisem w logu, i NIE psuje kodu wyjścia cyklu
 * (scripts/prodStatusSync.js). Wraca w kolejnym przebiegu — po uzupełnieniu cen
 * faktura powstanie sama.
 *
 * Tak samo dokument wystawcy-organizacji BEZ formatki (`NO_LETTERHEAD_ERROR_CODE`,
 * automat woła serwis z `requireLetterhead`): czeka w `skippedNoLetterhead`, jeden
 * wpis w logu na wystawcę, bez wpływu na kod wyjścia — po przypisaniu formatki
 * dokument powstanie sam (2026-10-22: Luxan Sp. z o.o.).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] tylko wypisz kandydatów, nic nie wystawiaj
 * @param {ReturnType<typeof readAutoInvoiceConfig>} [opts.config]
 * @param {Object} [opts.deps] `{ repository, service, log, now }` — podmiana w testach
 * @returns {Promise<{ skipped?: string, created: object[], failed: object[], skippedZero: object[], skippedNoLetterhead: object[], waitingRecalc: object[], waitingReview: object[], planned: object[], skippedExisting: number }>}
 */
async function runAutoInvoicing({ dryRun = false, config = readAutoInvoiceConfig(), deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const now = deps.now || (() => new Date());
  const result = { created: [], failed: [], skippedZero: [], skippedNoLetterhead: [], waitingRecalc: [], waitingReview: [], planned: [], skippedExisting: 0 };

  if (config.problems.length) {
    config.problems.forEach((p) => log(`[invoices:auto] konfiguracja: ${p}`));
  }
  if (!config.active) {
    if (config.enabled) log('[invoices:auto] automat NIE ruszył — popraw konfigurację powyżej');
    return { ...result, skipped: config.enabled ? 'config' : 'disabled' };
  }

  const service = deps.service || new InvoiceService({ repository, log });
  let budget = config.maxPerRun;
  // Relacje HKL (poziom 1 i klienci HKL) mają tylko fakturę dzienną, póki dzienne są włączone
  const hklDailyOnly = !!config.dailySince;

  // Szkice przygotowane ręcznie (admin/biuro), których zamówienie doszło do !sent!:
  // wystawiamy TĘ wersję — nakładka na aktualne zamówienie, autor AUTO (mail i FTP jak zawsze)
  if (repository.findPreparedDraftsReady) {
    const ready = await repository.findPreparedDraftsReady({ since: config.since, hklDailyOnly, limit: budget });
    for (const d of ready) {
      const level = Number(d.level);
      if (budget <= 0) break;
      if (!config.levels.includes(level) || (config.organizationIds.length && !config.organizationIds.includes(Number(d.organization_id)))) continue;
      budget--;
      const label = `przygotowana ręcznie (szkic #${d.id}) — zamówienie ${d.order_idx} (id ${d.order_id}, ${d.user_ident}), poziom ${level}`;
      if (dryRun) {
        result.planned.push({ orderId: Number(d.order_id), level, prepared: true });
        log(`[invoices:auto] DRY-RUN: wystawiłbym — ${label}`);
        continue;
      }
      try {
        const draft = await repository.getInvoice(Number(d.id));
        const meta = (draft && draft.compliance && draft.compliance.manualEdit) || {};
        const created = await service.createFromOrder({
          orderId: Number(d.order_id),
          level,
          documentType: DocumentType.INVOICE,
          issue: config.issue,
          createdByPin: AUTO_ACTOR,
          requireLetterhead: true,
          replaceId: Number(d.id),
          manualEdit: { ...meta, issuedAt: now().toISOString() }
        });
        result.created.push({ orderId: Number(d.order_id), level, invoiceId: created.id, number: created.number, prepared: true });
        log(`[invoices:auto] ${created.number ? `faktura ${created.number}` : `szkic #${created.id}`} — ${label}`);
      } catch (err) {
        if (err && err.code === MANUAL_EDIT_CONFLICT_CODE) {
          result.waitingReview.push({ invoiceId: Number(d.id), orderId: Number(d.order_id), level, label: `${d.order_idx} (szkic #${d.id}, ${d.user_ident})` });
          if (!Number(d.review)) {
            await repository.addInvoiceEvent({ invoiceId: Number(d.id), eventType: 'manual_review', actorPin: AUTO_ACTOR, payload: { conflicts: err.conflicts || [] } });
          }
          continue;
        }
        if (err && err.code === ZERO_TOTAL_ERROR_CODE) {
          result.skippedZero.push({ orderId: Number(d.order_id), level, label: `${d.order_idx} (id ${d.order_id}, ${d.user_ident}, poziom ${level})` });
          continue;
        }
        if (err && err.code === NO_LETTERHEAD_ERROR_CODE) {
          result.skippedNoLetterhead.push({ orderId: Number(d.order_id), level, issuer: err.issuerName || '', label: `${d.order_idx} (id ${d.order_id}, ${d.user_ident}, poziom ${level})` });
          continue;
        }
        result.failed.push({ orderId: Number(d.order_id), level, error: err.message });
        log(`[invoices:auto] BŁĄD — ${label}: ${err.message}`);
      }
    }
  }

  for (const level of config.levels) {
    if (budget <= 0) break;
    if (hklDailyOnly && level === InvoiceLevel.MANUFACTURER_TO_ORGANIZATION) continue;
    const candidates = await repository.findAutoInvoiceCandidates({
      level,
      since: config.since,
      organizationIds: config.organizationIds,
      // Poziom 1: HKL nie sprzedaje sam sobie. Poziom 2: klienci HKL mają fakturę dzienną
      excludeOrganizationId: level === InvoiceLevel.MANUFACTURER_TO_ORGANIZATION
        || (hklDailyOnly && level === InvoiceLevel.ORGANIZATION_TO_USER) ? HKL_ORG_ID : null,
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
          createdByPin: AUTO_ACTOR,
          requireLetterhead: true
        });
        result.created.push({ orderId: order.id, level, invoiceId: created.id, number: created.number });
        log(`[invoices:auto] ${created.number ? `faktura ${created.number}` : `szkic #${created.id}`} — ${label}`);
      } catch (err) {
        if (err && err.code === ZERO_TOTAL_ERROR_CODE) {
          result.skippedZero.push({ orderId: order.id, level, label: `${order.order_idx} (id ${order.id}, ${order.user_ident}, poziom ${level})` });
          continue;
        }
        if (err && err.code === NO_LETTERHEAD_ERROR_CODE) {
          result.skippedNoLetterhead.push({ orderId: order.id, level, issuer: err.issuerName || '', label: `${order.order_idx} (id ${order.id}, ${order.user_ident}, poziom ${level})` });
          continue;
        }
        result.failed.push({ orderId: order.id, level, error: err.message });
        log(`[invoices:auto] BŁĄD — ${label}: ${err.message}`);
      }
    }
  }

  // Faktury zbiorcze — poziom 2 dla klientów z harmonogramem tygodniowym/miesięcznym,
  // i faktury dzienne HKL (poziomy 1 i 2) — dokument z wielu zamówień naraz
  const groups = [];
  if (config.levels.includes(InvoiceLevel.ORGANIZATION_TO_USER) && budget > 0 && repository.findCollectiveCandidates) {
    const rows = await repository.findCollectiveCandidates({ since: config.since, organizationIds: config.organizationIds });
    groups.push(...groupCollectiveCandidates(rows, { todayIso: todayIso(now()) })
      .map((g) => ({ ...g, level: InvoiceLevel.ORGANIZATION_TO_USER, actor: AUTO_ACTOR })));
  }
  if (config.dailySince && budget > 0 && repository.findDailyCandidates) {
    for (const level of DAILY_LEVELS.filter((lv) => config.levels.includes(lv))) {
      const rows = await repository.findDailyCandidates({ level, since: config.dailySince, organizationIds: config.organizationIds });
      groups.push(...groupDailyCandidates(rows, { todayIso: todayIso(now()) }).map((g) => ({ ...g, actor: DAILY_ACTOR })));
    }
  }

  for (const group of groups) {
    if (budget <= 0) break;
    const { level } = group;
    const daily = group.actor === DAILY_ACTOR;
    const kind = daily ? { daily: true } : { collective: true };
    const what = daily ? `faktura dzienna HKL ${group.period.key} (poziom ${level})` : `faktura zbiorcza ${group.period.key} (${group.schedule})`;
    const label = `${what} — ${daily && level === InvoiceLevel.MANUFACTURER_TO_ORGANIZATION ? 'organizacja' : 'klient'} ${group.userIdent || group.userId}, zamówienia ${group.orderIds.join(', ')}`;
    const short = `${daily ? 'dzienna' : 'zbiorcza'} ${group.period.key} (${group.userIdent || group.userId}, zamówienia ${group.orderIds.join(', ')})`;

    // Dzienna za ten dzień już jest — drugiej nie wystawiamy, spóźnione zlecenia
    // dołącza „Przelicz dzienne ponownie” (`recalculateDailyInvoices`)
    if (daily && repository.findDailyInvoices && (await repository.findDailyInvoices(dailyBuyer(group))).length) {
      result.waitingRecalc.push({ level, period: group.period.key, orderIds: group.orderIds, label: short });
      continue;
    }
    budget--;

    if (dryRun) {
      result.planned.push({ ...kind, userId: group.userId, period: group.period.key, orderIds: group.orderIds, level });
      log(`[invoices:auto] DRY-RUN: wystawiłbym — ${label}`);
      continue;
    }

    try {
      // Między wyszukaniem a wystawieniem ktoś mógł zafakturować zlecenie ręcznie. Dzienna
      // tego nie sprawdza: jej kandydaci są już bez faktur, a `hasLevelInvoice` liczy też szkic
      // przygotowany w edytorze, którego zmiany dzienna ma właśnie nieść.
      const orderIds = [];
      for (const orderId of group.orderIds) {
        if (daily || !(await repository.hasLevelInvoice({ orderId, level }))) orderIds.push(orderId);
      }
      if (!orderIds.length) {
        result.skippedExisting += group.orderIds.length;
        continue;
      }
      const created = await service.createCollective({
        orderIds,
        period: group.period,
        level,
        issue: config.issue,
        createdByPin: group.actor,
        requireLetterhead: true
      });
      result.created.push({ ...kind, userId: group.userId, period: group.period.key, orderIds, level, invoiceId: created.id, number: created.number });
      log(`[invoices:auto] ${created.number ? `faktura ${created.number}` : `szkic #${created.id}`} — ${label}`);
    } catch (err) {
      const failed = { ...kind, userId: group.userId, period: group.period.key, orderIds: group.orderIds, level };
      if (err && err.code === MANUAL_EDIT_CONFLICT_CODE) {
        result.waitingReview.push({ ...failed, label: short });
        continue;
      }
      if (err && err.code === ZERO_TOTAL_ERROR_CODE) {
        result.skippedZero.push({ ...failed, label: short });
        continue;
      }
      if (err && err.code === NO_LETTERHEAD_ERROR_CODE) {
        result.skippedNoLetterhead.push({ ...failed, issuer: err.issuerName || '', label: short });
        continue;
      }
      result.failed.push({ ...failed, error: err.message });
      log(`[invoices:auto] BŁĄD — ${label}: ${err.message}`);
    }
  }

  if (budget <= 0) {
    log(`[invoices:auto] wyczerpany limit ${config.maxPerRun} zamówień na przebieg (INVOICE_AUTOGEN_MAX_PER_RUN) — ewentualna reszta w następnym`);
  }
  if (result.skippedZero.length) {
    log(`[invoices:auto] pominięto ${result.skippedZero.length} — zerowa wartość netto, nic do zafakturowania `
      + `(uzupełnij ceny pozycji albo wystaw dokument ręcznie): ${result.skippedZero.map((s) => s.label).join('; ')}`);
  }
  if (result.waitingReview.length) {
    log(`[invoices:auto] do przejrzenia ${result.waitingReview.length} — ręczna edycja faktury nie pasuje do zmienionego zamówienia; `
      + `otwórz edytor faktury i zapisz ponownie: ${result.waitingReview.map((w) => w.label).join('; ')}`);
  }
  if (result.waitingRecalc.length) {
    log(`[invoices:auto] czeka ${result.waitingRecalc.length} — zlecenia doszły po fakturze dziennej za swój dzień; `
      + `dołączy je „Przelicz dzienne ponownie” w panelu faktur: ${result.waitingRecalc.map((w) => w.label).join('; ')}`);
  }
  const waitingByIssuer = new Map();
  for (const s of result.skippedNoLetterhead) waitingByIssuer.set(s.issuer, [...(waitingByIssuer.get(s.issuer) || []), s.label]);
  for (const [issuer, labels] of waitingByIssuer) {
    log(`[invoices:auto] czeka ${labels.length} — wystawca ${issuer || '—'} bez formatki (papieru firmowego); `
      + `dokumenty powstaną po jej przypisaniu (panel /invoices/profile albo scripts/setInvoiceTemplate.js): ${labels.join('; ')}`);
  }
  log(`[invoices:auto] ${dryRun ? `DRY-RUN: do wystawienia ${result.planned.length}` : `wystawiono ${result.created.length}, błędy ${result.failed.length}${result.skippedZero.length ? `, pominięte (zerowa wartość) ${result.skippedZero.length}` : ''}${result.skippedNoLetterhead.length ? `, czeka na formatkę ${result.skippedNoLetterhead.length}` : ''}`}`
    + ` (poziomy ${config.levels.join(', ')}, od ${config.since}${config.organizationIds.length ? `, organizacje ${config.organizationIds.join(', ')}` : ''})`);
  return result;
}

/**
 * „Przelicz dzienne ponownie” — przycisk w panelu faktur admina (Paweł, 17.11.2026:
 * „jak coś dojdzie potem, to przycisk … przelicz dzienne ponownie i tyle”). Zlecenie,
 * którego status doszedł po wystawieniu dziennej za jego dzień, trafia do TEJ SAMEJ
 * faktury: ten sam numer i data wystawienia, nowa treść (stara wersja znika w jednej
 * transakcji). Nowa wersja to nowy rekord bez znaczników, więc mail i FTP pójdą
 * ponownie (FTP nadpisze plik). Dzień bez dziennej dostaje ją od razu, jak w automacie.
 * Nie rusza faktury opłaconej albo z korektą ani kilku dziennych za ten sam dzień.
 *
 * @param {Object} [opts]
 * @param {ReturnType<typeof readAutoInvoiceConfig>} [opts.config]
 * @param {Object} [opts.deps] `{ repository, service, log, now }`
 * @returns {Promise<{ skipped?: string, recalculated: object[], created: object[], failed: object[] }>}
 */
async function recalculateDailyInvoices({ config = readAutoInvoiceConfig(), deps = {} } = {}) {
  const repository = deps.repository || defaultRepository;
  const log = deps.log || defaultLog;
  const now = deps.now || (() => new Date());
  const result = { recalculated: [], created: [], failed: [] };
  if (!config.active || !config.dailySince) return { ...result, skipped: config.active ? 'daily-disabled' : 'config' };

  const service = deps.service || new InvoiceService({ repository, log });
  for (const level of DAILY_LEVELS.filter((lv) => config.levels.includes(lv))) {
    const rows = await repository.findDailyCandidates({ level, since: config.dailySince, organizationIds: config.organizationIds });
    for (const group of groupDailyCandidates(rows, { todayIso: todayIso(now()) })) {
      const label = `dzienna ${group.period.key}, poziom ${level} (${group.userIdent || group.userId})`;
      try {
        const existing = await repository.findDailyInvoices(dailyBuyer(group));
        if (existing.length > 1) {
          throw new Error(`za ten dzień są ${existing.length} faktury dzienne (${existing.map((e) => e.number).join(', ')}) — połącz ręcznie`);
        }
        const old = existing[0] || null;
        if (old && (old.status !== 'issued' || old.related)) {
          throw new Error(`faktura ${old.number} ${old.related ? 'ma korektę' : `ma status ${old.status}`} — przelicz ręcznie`);
        }
        // Zmiany zrobione w samej fakturze dziennej (edytor) przebudowa by skasowała;
        // zmiany zamówień (nakładki) przebudowa stosuje sama
        if (old && old.edited) {
          throw new Error(`faktura ${old.number} była edytowana ręcznie — dopisz zlecenie w edytorze faktury`);
        }
        const late = rows.filter((r) => group.orderIds.includes(Number(r.id)));
        const orderIds = old ? sortDailyOrders([...old.orders, ...late]) : group.orderIds;
        const created = await service.createCollective({
          orderIds,
          period: group.period,
          level,
          issue: old ? true : config.issue,
          createdByPin: DAILY_ACTOR,
          requireLetterhead: true,
          replace: old ? { id: old.id, number: old.number, issueDate: old.issueDate } : null
        });
        (old ? result.recalculated : result.created).push({ level, period: group.period.key, orderIds, invoiceId: created.id, number: created.number });
        log(`[invoices:auto] ${old ? 'przeliczona' : 'wystawiona'} ${label}: ${created.number || `szkic #${created.id}`}, zamówienia ${orderIds.join(', ')}`);
      } catch (err) {
        result.failed.push({ level, period: group.period.key, orderIds: group.orderIds, error: err.message });
        log(`[invoices:auto] BŁĄD przeliczenia — ${label}: ${err.message}`);
      }
    }
  }
  return result;
}

module.exports = {
  AUTO_ACTOR,
  SUPPORTED_LEVELS,
  readAutoInvoiceConfig,
  runAutoInvoicing,
  recalculateDailyInvoices
};
