'use strict';

/**
 * Moduł fakturowania — publiczne API (fasada).
 *
 * Warstwy (Clean Architecture, zależności zawsze do środka):
 *
 *   http/routes.js          ← kontroler HTTP, zna req/res, nic nie liczy
 *        ↓
 *   main.js (InvoiceService) ← przypadki użycia, orkiestracja
 *        ↓
 *   core/*                   ← czysta logika: money, taxRules, calculator,
 *                              numbering, statuses, orderMapper, currency
 *        ↓
 *   db/repository.js         ← jedyne miejsce z SQL-em
 *   render/renderer.js       ← Nunjucks → HTML → PDF
 *
 * Wszystkie zależności zewnętrzne (baza, kursy walut, czas, log) wchodzą przez
 * konstruktor — dzięki temu testy jednostkowe w `__tests__/` nie potrzebują
 * bazy, sieci ani przeglądarki.
 *
 * @typedef {import('./domain/types').Invoice} Invoice
 * @typedef {import('./domain/types').Party} Party
 */

const { DocumentType, InvoiceStatus, TaxCategory, Unit, PaymentMethod, LEGAL_NOTE_KEYS } = require('./domain/constants');
const money = require('./core/money');
const { InvoiceCalculator } = require('./core/calculator');
const { NumberingService, DEFAULT_PATTERNS, validatePattern, formatNumber, resolvePeriodKey } = require('./core/numbering');
const { CurrencyConverter } = require('./core/currency');
const statuses = require('./core/statuses');
const taxRules = require('./core/taxRules');
const orderMapper = require('./core/orderMapper');
const renderer = require('./render/renderer');
const defaultRepository = require('./db/repository');
const { toIsoDay, todayIso, addDays } = require('./core/dates');
const { ViesClient } = require('./core/vies');
const { log: defaultLog } = require('../../utils/logging');


/**
 * Waluta wszystkich dokumentów tego modułu.
 *
 * ⚠️ Świadomie **jedna, stała waluta** — cała sprzedaż jest w EUR, a wybór waluty
 * per dokument tylko mnożyłby stany do przetestowania (kursy, przeliczenia,
 * niespójne sumy między zaliczką a fakturą końcową). `profile.default_currency`
 * i parametr `currency` są ignorowane; gdyby kiedyś doszła druga waluta, jest to
 * jedyne miejsce do zmiany + odblokowanie parametru w `createFromOrder`.
 */
const DOCUMENT_CURRENCY = 'EUR';

class InvoiceService {
  /**
   * @param {Object} [deps]
   * @param {typeof defaultRepository} [deps.repository]
   * @param {{ getRate: (from: string, to: string, date: string) => Promise<any> }} [deps.currency]
   * @param {{ check: (vatId: string, country?: string) => Promise<any> }} [deps.vies]
   * @param {(msg: string, ...rest: unknown[]) => void} [deps.log]
   * @param {() => Date} [deps.now]
   */
  constructor(deps = {}) {
    this.repository = deps.repository || defaultRepository;
    this.currency = deps.currency || new CurrencyConverter({ log: deps.log });
    this.vies = deps.vies || new ViesClient({ log: deps.log });
    this.log = deps.log || defaultLog;
    this.now = deps.now || (() => new Date());
  }

  /**
   * Tworzy dokument na podstawie zamówienia eForm.
   *
   * Przebieg: dane zamówienia → strony transakcji → decyzja podatkowa
   * (per pozycja, bo montaż może mieć inną stawkę niż towar) → kalkulacja →
   * odliczenie zaliczek (dla `final`) → kurs waluty → zapis.
   *
   * @param {Object} params
   * @param {number} params.orderId
   * @param {string} [params.documentType='invoice'] Patrz `DocumentType`.
   * @param {string} [params.lang]                   Domyślnie język profilu organizacji.
   * @param {string} [params.currency]               Domyślnie waluta profilu.
   * @param {boolean} [params.issue=false]           `true` → od razu nadaje numer i status `issued`.
   * @param {boolean} [params.vatEuVerified=false]   Numer VAT-UE nabywcy potwierdzony w VIES.
   * @param {boolean} [params.useSubPrices=false]    Ceny klienta (`total_price_sub`).
   * @param {number} [params.advancePercent]         Dla `advance`: % wartości zamówienia.
   * @param {Array<{ name: string, netAmount?: number, unitPriceNet?: number, quantity?: number, unit?: string, isInstallation?: boolean, description?: string }>} [params.serviceItems]
   *        Usługi dołożone jawnie (montaż, szycie, transport). ⚠️ Pozycje
   *        zamówienia eForm są ZAWSZE towarem — w `json_parameters` nie ma flagi
   *        usługi (`MONTAZ` to kod uchwytu, patrz `core/orderMapper.js`).
   *        `isInstallation: true` kwalifikuje usługę do stawki obniżonej w PL.
   * @param {string} [params.saleDate]               Domyślnie dziś (lub `sent_date` zamówienia).
   * @param {string} [params.notes]
   * @param {string} [params.createdByPin]
   * @returns {Promise<{ id: number, number: string|null, invoice: Invoice }>}
   */
  async createFromOrder(params) {
    const {
      orderId,
      documentType = DocumentType.INVOICE,
      issue = false,
      useSubPrices = false,
      advancePercent,
      serviceItems = [],
      notes,
      createdByPin
    } = params;

    const source = await this.repository.getOrderInvoiceSource(orderId);
    if (!source) throw new Error(`Zamówienie ${orderId} nie istnieje`);
    if (!source.orderItems.length) throw new Error(`Zamówienie ${orderId} nie ma pozycji`);

    const profile = await this.repository.getOrganizationProfile(source.order.organization_id);
    if (!profile) throw new Error(`Brak organizacji ${source.order.organization_id}`);

    const lang = params.lang || profile.defaultLang;
    // Waluta jest stała — patrz DOCUMENT_CURRENCY
    const currency = DOCUMENT_CURRENCY;
    const today = todayIso(this.now());
    // `sent_date` przychodzi z mysql2 jako obiekt Date — patrz `core/dates.js`
    const saleDate = toIsoDay(params.saleDate) || toIsoDay(source.order.sent_date) || today;
    const issueDate = today;
    const dueDate = addDays(issueDate, profile.defaultPaymentDays);

    const { seller, buyer } = orderMapper.mapParties({
      organization: source.organization,
      user: source.user,
      groupShop: source.groupShop
    });
    // Profil organizacji ma priorytet nad tabelą `organization` (może zawierać
    // inne dane rejestrowe niż te używane w mailach).
    Object.assign(seller, profile.seller);

    // Weryfikacja numeru VAT-UE nabywcy. Stawki NIE warunkuje (o niej decyduje
    // para krajów — `core/taxRules.js`); zapisujemy ją na dokumencie jako dowód
    // należytej staranności. `skipVies: true` pomija odpytywanie usługi.
    const vies = await this.verifyBuyerVatId(buyer, seller, {
      skip: params.skipVies === true,
      override: params.vatEuVerified
    });

    /** Decyzja podatkowa jest podejmowana per pozycja — montaż może mieć stawkę obniżoną. */
    const resolveTax = ({ isService, isInstallation }) => {
      const treatment = taxRules.resolveTaxTreatment({
        seller,
        buyer,
        opts: { isService, isInstallation, vatEuVerified: vies.verified }
      });
      if (treatment.notes.length) treatment.notes.forEach((n) => this.log(`[invoices] order ${orderId}: ${n}`));
      return treatment;
    };

    let rawItems = orderMapper.mapOrderItemsToInvoiceItems({
      orderItems: source.orderItems,
      resolveTax,
      currency,
      useSubPrices
    });

    // Usługi dokładane jawnie — jedyna droga, żeby na fakturze pojawiła się
    // pozycja usługowa (i ewentualnie stawka obniżona za montaż).
    for (const svc of serviceItems) {
      const tax = resolveTax({ isService: true, isInstallation: svc.isInstallation === true });
      rawItems.push({
        name: svc.name,
        description: svc.description || '',
        unit: svc.unit || Unit.SERVICE,
        quantity: Number.isFinite(Number(svc.quantity)) ? Number(svc.quantity) : 1,
        unitPriceNetMinor: Number.isFinite(Number(svc.netAmount))
          ? money.toMinor(svc.netAmount, currency)
          : money.toMinor(svc.unitPriceNet, currency),
        taxRate: tax.taxRate,
        taxCategory: tax.taxCategory,
        meta: { isService: true, isInstallation: svc.isInstallation === true }
      });
    }

    // Faktura zaliczkowa: jedna pozycja będąca procentem wartości zamówienia.
    // ⚠️ Zaliczka dziedziczy stawkę i kategorię z pierwszej pozycji zamówienia —
    // przy mieszanych stawkach na jednym zamówieniu wymaga to decyzji księgowej,
    // dlatego zostawiamy jawne ostrzeżenie w logu.
    if (documentType === DocumentType.ADVANCE) {
      const percent = Number(advancePercent);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        throw new Error('Faktura zaliczkowa wymaga `advancePercent` w zakresie (0, 100]');
      }
      const rates = new Set(rawItems.map((i) => `${i.taxCategory}|${i.taxRate}`));
      if (rates.size > 1) {
        this.log(`[invoices] order ${orderId}: zaliczka na zamówieniu z wieloma stawkami VAT — użyto stawki pierwszej pozycji`);
      }
      const base = money.sum(rawItems.map((i) => i.unitPriceNetMinor));
      const first = rawItems[0];
      rawItems = [{
        name: `Zaliczka ${percent}% do zamówienia ${source.order.order_idx || orderId}`,
        description: source.order.commision || '',
        unit: Unit.SERVICE,
        quantity: 1,
        unitPriceNetMinor: money.percentOf(base, percent),
        taxRate: first.taxRate,
        taxCategory: first.taxCategory,
        meta: { advancePercent: percent, orderId }
      }];
    }

    // Kurs waluty potrzebny tylko, gdy dokument jest w innej walucie niż lokalna.
    let exchangeRate = null;
    if (currency !== profile.localCurrency) {
      try {
        exchangeRate = await this.currency.getRate(currency, profile.localCurrency, saleDate);
      } catch (err) {
        // Brak kursu nie może blokować wystawienia — dokument powstaje bez
        // przeliczenia, a szablon drukuje ostrzeżenie (patrz `vat_summary.njk`).
        this.log(`[invoices] order ${orderId}: brak kursu ${currency}/${profile.localCurrency} na ${saleDate}: ${err.message}`);
      }
    }

    const calculator = new InvoiceCalculator({ currency, localCurrency: profile.localCurrency, exchangeRate });

    let advanceSettled = 0;
    if (documentType === DocumentType.FINAL) {
      const advances = await this.repository.getAdvanceInvoicesForOrder(orderId);
      advanceSettled = InvoiceCalculator.settleAdvances(advances);
    }

    const computed = calculator.calculate(rawItems, { advanceSettled });

    /** @type {Invoice & Record<string, any>} */
    const invoice = {
      organizationId: profile.organizationId,
      documentType,
      status: issue ? InvoiceStatus.ISSUED : InvoiceStatus.DRAFT,
      issueDate,
      saleDate,
      dueDate,
      currency,
      localCurrency: profile.localCurrency,
      exchangeRate: exchangeRate || undefined,
      seller,
      buyer,
      buyerUserId: source.user.id,
      buyerGroupUserId: source.groupShop ? source.groupShop.id : null,
      buyerVatEuVerified: vies.verified,
      viesCheckedAt: vies.checkedAt,
      viesValid: vies.checked ? vies.verified : null,
      paymentMethod: profile.defaultPaymentMethod,
      items: computed.items,
      taxLines: computed.taxLines,
      totalNet: computed.totalNet,
      totalTax: computed.totalTax,
      totalGross: computed.totalGross,
      totalTaxLocal: computed.totalTaxLocal,
      advanceSettled: computed.advanceSettled,
      amountDue: computed.amountDue,
      orderId,
      orderRef: source.order.order_idx || String(orderId),
      lang,
      templateCode: profile.templateCode,
      notes: notes || source.order.comment || '',
      legalNotes: [...new Set(computed.taxLines.map((l) => l.legalNoteKey).filter(Boolean))],
      orgCode: profile.orgCode,
      numberPattern: profile.numberPatterns?.[documentType] || DEFAULT_PATTERNS[documentType],
      createdByPin
    };

    const saved = await this.repository.createInvoice(invoice, { assignNumber: issue });
    invoice.id = saved.id;
    invoice.number = saved.number;
    return { id: saved.id, number: saved.number, invoice };
  }

  /**
   * Weryfikuje numer VAT-UE nabywcy w VIES.
   *
   * Wołane automatycznie przy tworzeniu dokumentu wtedy — i tylko wtedy — gdy ma
   * to sens: kraje sprzedawcy i nabywcy są różne, oba w UE, a nabywca ma numer.
   * Sprzedaż krajowa nie wymaga VIES, więc nie zawracamy głowy usłudze KE.
   *
   * ⚠️ Nigdy nie rzuca i nie blokuje wystawienia — brak odpowiedzi VIES zwraca
   * `{ verified: false, checked: false }` i ostrzeżenie w logu.
   *
   * @param {Party} buyer
   * @param {Party} seller
   * @param {{ skip?: boolean, override?: boolean }} [opts]
   * @returns {Promise<{ verified: boolean, checked: boolean, checkedAt: string|null, reason?: string, name?: string }>}
   */
  async verifyBuyerVatId(buyer, seller, opts = {}) {
    const vatId = (buyer && (buyer.vatEuId || buyer.taxId)) || '';

    if (typeof opts.override === 'boolean') {
      return { verified: opts.override, checked: false, checkedAt: null, reason: 'Ustawione ręcznie przez wołającego' };
    }
    if (opts.skip) {
      return { verified: false, checked: false, checkedAt: null, reason: 'Pominięto weryfikację VIES' };
    }
    if (!taxRules.isIntraEuZeroRate(seller && seller.country, buyer && buyer.country)) {
      return { verified: false, checked: false, checkedAt: null, reason: 'Transakcja nie jest wewnątrzwspólnotowa — VIES nie dotyczy' };
    }
    if (!vatId) {
      return { verified: false, checked: false, checkedAt: null, reason: 'Nabywca nie ma numeru VAT-UE w danych' };
    }

    const result = await this.vies.check(vatId, buyer.country);
    if (!result.checked) {
      this.log(`[invoices] VIES nie potwierdził ${vatId}: ${result.reason}`);
    } else if (!result.valid) {
      this.log(`[invoices] VIES: numer ${vatId} jest NIEPOPRAWNY`);
    }
    return {
      verified: result.checked && result.valid === true,
      checked: !!result.checked,
      checkedAt: result.checkedAt || null,
      reason: result.reason,
      name: result.name
    };
  }

  /**
   * Wystawia szkic: nadaje numer i przełącza status na `issued`.
   * ⚠️ Numer nadajemy dopiero tutaj — porzucone szkice nie robią dziur w numeracji.
   *
   * @param {number} invoiceId
   * @param {{ actorPin?: string }} [opts]
   * @returns {Promise<{ id: number, number: string }>}
   */
  async issue(invoiceId, opts = {}) {
    const invoice = await this.repository.getInvoice(invoiceId);
    if (!invoice) throw new Error(`Faktura ${invoiceId} nie istnieje`);
    statuses.assertTransition(invoice.status, InvoiceStatus.ISSUED);

    const profile = await this.repository.getOrganizationProfile(invoice.organizationId);
    const numbering = new NumberingService({
      allocateSequence: (p) => this.repository.allocateSequence(p)
    });
    const allocated = await numbering.next({
      organizationId: invoice.organizationId,
      documentType: invoice.documentType,
      isoDate: invoice.issueDate,
      pattern: profile?.numberPatterns?.[invoice.documentType],
      orgCode: profile?.orgCode
    });

    await this.repository.updateStatus(invoiceId, {
      status: InvoiceStatus.ISSUED,
      fromStatus: invoice.status,
      number: allocated.number,
      actorPin: opts.actorPin
    });

    return { id: invoiceId, number: allocated.number };
  }

  /**
   * Zmiana statusu z walidacją przejścia.
   *
   * @param {number} invoiceId
   * @param {string} status
   * @param {{ actorPin?: string, paidAmount?: number }} [opts]
   * @returns {Promise<boolean>}
   */
  async changeStatus(invoiceId, status, opts = {}) {
    const invoice = await this.repository.getInvoice(invoiceId);
    if (!invoice) throw new Error(`Faktura ${invoiceId} nie istnieje`);
    statuses.assertTransition(invoice.status, status);

    const patch = { status, fromStatus: invoice.status, actorPin: opts.actorPin };
    if (status === InvoiceStatus.PAID) {
      patch.paidAmount = money.toMajor(opts.paidAmount ?? invoice.amountDue ?? invoice.totalGross, invoice.currency);
      patch.paidAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    }
    return this.repository.updateStatus(invoiceId, patch);
  }

  /**
   * Faktura korygująca do istniejącego dokumentu.
   *
   * Pozycje korekty podaje wołający (stan „po") — moduł liczy różnice względem
   * dokumentu pierwotnego i zapisuje je jako nowy dokument typu `correction`,
   * a dokument korygowany przechodzi w status `corrected`.
   *
   * @param {Object} params
   * @param {number} params.invoiceId          Dokument korygowany.
   * @param {import('./core/calculator').RawItem[]} params.items  Stan po korekcie.
   * @param {string} params.reason
   * @param {boolean} [params.issue=true]
   * @param {string} [params.actorPin]
   * @returns {Promise<{ id: number, number: string|null, delta: object }>}
   */
  async createCorrection({ invoiceId, items, reason, issue = true, actorPin }) {
    const original = await this.repository.getInvoice(invoiceId);
    if (!original) throw new Error(`Faktura ${invoiceId} nie istnieje`);
    if (!reason) throw new Error('Korekta wymaga podania przyczyny (`reason`)');
    statuses.assertTransition(original.status, InvoiceStatus.CORRECTED);

    const profile = await this.repository.getOrganizationProfile(original.organizationId);
    const calculator = new InvoiceCalculator({
      currency: original.currency,
      localCurrency: original.localCurrency,
      exchangeRate: original.exchangeRate
    });
    const after = calculator.calculate(items);
    const diff = InvoiceCalculator.diff(original, after);

    const today = todayIso(this.now());
    /** @type {Invoice & Record<string, any>} */
    const correction = {
      ...original,
      id: undefined,
      documentType: DocumentType.CORRECTION,
      status: issue ? InvoiceStatus.ISSUED : InvoiceStatus.DRAFT,
      number: null,
      issueDate: today,
      dueDate: addDays(today, profile?.defaultPaymentDays ?? 14),
      items: after.items,
      taxLines: after.taxLines,
      totalNet: after.totalNet,
      totalTax: after.totalTax,
      totalGross: after.totalGross,
      totalTaxLocal: after.totalTaxLocal,
      advanceSettled: 0,
      amountDue: diff.delta.totalGross,
      correctedInvoiceId: invoiceId,
      correctionReason: reason,
      orgCode: profile?.orgCode,
      numberPattern: profile?.numberPatterns?.[DocumentType.CORRECTION] || DEFAULT_PATTERNS.correction,
      createdByPin: actorPin
    };

    const saved = await this.repository.createInvoice(correction, { assignNumber: issue });
    await this.repository.updateStatus(invoiceId, {
      status: InvoiceStatus.CORRECTED,
      fromStatus: original.status,
      actorPin
    });

    return { id: saved.id, number: saved.number, delta: diff.delta };
  }

  /**
   * Kontekst renderowania (dokument + profil + szablon + logo).
   * @param {number} invoiceId
   * @returns {Promise<{ invoice: Invoice, profile: any, template: any, logoDataUri: string }>}
   */
  async buildRenderContext(invoiceId) {
    const invoice = await this.repository.getInvoice(invoiceId);
    if (!invoice) throw new Error(`Faktura ${invoiceId} nie istnieje`);
    const profile = await this.repository.getOrganizationProfile(invoice.organizationId);
    const template = await this.repository.getTemplate(invoice.templateCode);
    const logoDataUri = renderer.loadLogoDataUri(profile?.logoFile || '');
    return { invoice, profile: profile || {}, template, logoDataUri };
  }

  /**
   * Podgląd HTML dokumentu.
   * @param {number} invoiceId
   * @returns {Promise<string>}
   */
  async renderHtml(invoiceId) {
    const ctx = await this.buildRenderContext(invoiceId);
    return renderer.renderInvoiceHtml(ctx);
  }

  /**
   * PDF dokumentu.
   * @param {number} invoiceId
   * @returns {Promise<{ buffer: Buffer, filename: string }>}
   */
  async renderPdf(invoiceId) {
    const ctx = await this.buildRenderContext(invoiceId);
    const buffer = await renderer.renderInvoicePdf(ctx);
    // Nazwa pliku wyłącznie ASCII — iOS Mail i część klientów poczty potyka się
    // o polskie znaki i spacje w nazwach załączników (patrz utils/sanitizeFilename.js).
    const safe = String(ctx.invoice.number || `draft-${invoiceId}`).replace(/[^\w.-]+/g, '_');
    return { buffer, filename: `${safe}.pdf` };
  }

  /**
   * @param {Parameters<typeof defaultRepository.listInvoices>[0]} query
   */
  async list(query) {
    return this.repository.listInvoices(query);
  }

  /**
   * Aktualizacja profilu fakturowania organizacji (dane sprzedawcy, bank,
   * szablon, motyw, wzorce numeracji). Wzorce są walidowane — wzorzec bez
   * licznika oznaczałby duplikaty numerów.
   *
   * @param {number} organizationId
   * @param {Record<string, any>} patch
   * @returns {Promise<boolean>}
   */
  async updateOrganizationProfile(organizationId, patch) {
    if (patch && patch.number_patterns) {
      for (const [type, pattern] of Object.entries(patch.number_patterns)) {
        const check = validatePattern(pattern);
        if (!check.valid) throw new Error(`Wzorzec dla "${type}": ${check.error}`);
      }
    }
    return this.repository.upsertOrganizationProfile(organizationId, patch);
  }
}

module.exports = {
  InvoiceService,
  // Ponowny eksport rdzenia — pozwala używać kalkulatora/reguł bez serwisu
  // (np. w podglądzie „ile wyjdzie VAT-u" na froncie zamówienia).
  InvoiceCalculator,
  NumberingService,
  CurrencyConverter,
  taxRules,
  statuses,
  orderMapper,
  renderer,
  money,
  DocumentType,
  InvoiceStatus,
  TaxCategory,
  Unit,
  PaymentMethod,
  LEGAL_NOTE_KEYS,
  DEFAULT_PATTERNS,
  DOCUMENT_CURRENCY,
  ViesClient,
  formatNumber,
  resolvePeriodKey,
  toIsoDay,
  todayIso,
  addDays
};
