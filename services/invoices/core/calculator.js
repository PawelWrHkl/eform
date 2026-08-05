'use strict';

/**
 * Kalkulator faktury: pozycje → wartości netto/VAT/brutto → podsumowanie stawek.
 *
 * Zasady, które ten plik realizuje (i które łatwo złamać przy „drobnej" zmianie):
 *  1. Liczymy w minor units (`core/money.js`) — zero arytmetyki na floatach.
 *  2. VAT zaokrąglamy **per grupa stawek**, nie per pozycja i nie od sumy
 *     dokumentu. Suma VAT z pozycji potrafi różnić się o grosz od VAT-u
 *     policzonego od sumy netto — obowiązująca jest wersja z grup.
 *  3. Brutto dokumentu = Σ(netto grup) + Σ(VAT grup). Nigdy nie sumujemy
 *     zaokrąglonego brutta z pozycji, bo błędy by się kumulowały.
 *  4. Przeliczenie na walutę lokalną dotyczy KWOT PODATKU (tego wymaga
 *     ustawa o VAT dla faktur w walucie obcej), a nie całego dokumentu.
 *
 * Klasa nie dotyka bazy, sieci ani czasu — czysta funkcja na danych wejściowych.
 *
 * @typedef {import('../domain/types').Invoice} Invoice
 * @typedef {import('../domain/types').InvoiceItem} InvoiceItem
 * @typedef {import('../domain/types').TaxLine} TaxLine
 * @typedef {import('../domain/types').ExchangeRate} ExchangeRate
 */

const money = require('./money');
const { TaxCategory, LEGAL_NOTE_KEYS, Unit } = require('../domain/constants');

/**
 * Pozycja wejściowa (przed wyliczeniem). Kwoty mogą być podane jako liczby
 * w jednostkach głównych (`unitPriceNet: 123.45`) albo już w minor units
 * (`unitPriceNetMinor: 12345`) — mapper z zamówień korzysta z tej drugiej ścieżki.
 *
 * @typedef {Object} RawItem
 * @property {string} name
 * @property {string} [description]
 * @property {string} [unit]
 * @property {number} [quantity]
 * @property {number} [unitPriceNet]
 * @property {number} [unitPriceNetMinor]
 * @property {number} [discountPercent]
 * @property {number} [taxRate]
 * @property {string} [taxCategory]
 * @property {number} [orderItemId]
 * @property {Record<string, unknown>} [meta]
 */

class InvoiceCalculator {
  /**
   * @param {Object} [options]
   * @param {string} [options.currency='PLN']       Waluta dokumentu.
   * @param {string} [options.localCurrency='PLN']  Waluta lokalna sprzedawcy.
   * @param {ExchangeRate|null} [options.exchangeRate]
   */
  constructor(options = {}) {
    this.currency = options.currency || 'PLN';
    this.localCurrency = options.localCurrency || this.currency;
    this.exchangeRate = options.exchangeRate || null;
  }

  /**
   * Wylicza pojedynczą pozycję.
   * @param {RawItem} raw
   * @param {number} position numer porządkowy (1..n)
   * @returns {InvoiceItem}
   */
  calculateItem(raw, position) {
    const quantity = Number.isFinite(Number(raw.quantity)) ? Number(raw.quantity) : 1;
    const unitPriceNet = Number.isFinite(raw.unitPriceNetMinor)
      ? Math.trunc(raw.unitPriceNetMinor)
      : money.toMinor(raw.unitPriceNet, this.currency);

    const grossOfDiscount = money.multiply(unitPriceNet, quantity);
    const discountPercent = Number(raw.discountPercent) || 0;
    const discountAmount = money.percentOf(grossOfDiscount, discountPercent);
    const netAmount = grossOfDiscount - discountAmount;

    const taxRate = Number.isFinite(Number(raw.taxRate)) ? Number(raw.taxRate) : 0;
    const taxAmount = money.percentOf(netAmount, taxRate);

    return {
      position,
      name: raw.name || '',
      description: raw.description || '',
      unit: raw.unit || Unit.PIECE,
      quantity,
      unitPriceNet,
      discountPercent,
      netAmount,
      taxCategory: raw.taxCategory || TaxCategory.STANDARD,
      taxRate,
      // Kwota VAT na pozycji ma charakter informacyjny — wiążąca jest ta z grupy.
      taxAmount,
      grossAmount: netAmount + taxAmount,
      orderItemId: raw.orderItemId,
      meta: raw.meta || {}
    };
  }

  /**
   * Buduje podsumowanie VAT: jeden wiersz na parę (stawka, kategoria).
   * Tutaj — i tylko tutaj — następuje zaokrąglenie kwoty podatku.
   *
   * @param {InvoiceItem[]} items
   * @returns {TaxLine[]}
   */
  buildTaxLines(items) {
    /** @type {Map<string, TaxLine>} */
    const groups = new Map();

    for (const item of items) {
      const key = `${item.taxCategory}|${item.taxRate}`;
      const current = groups.get(key) || {
        taxCategory: item.taxCategory,
        taxRate: item.taxRate,
        netAmount: 0,
        taxAmount: 0,
        grossAmount: 0,
        legalNoteKey: LEGAL_NOTE_KEYS[item.taxCategory] || null
      };
      current.netAmount += item.netAmount;
      groups.set(key, current);
    }

    const lines = [...groups.values()].map((line) => {
      const taxAmount = money.percentOf(line.netAmount, line.taxRate);
      return { ...line, taxAmount, grossAmount: line.netAmount + taxAmount };
    });

    // Stabilna kolejność na dokumencie: najwyższa stawka pierwsza, potem kategoria.
    lines.sort((a, b) => (b.taxRate - a.taxRate) || a.taxCategory.localeCompare(b.taxCategory));
    return lines;
  }

  /**
   * Pełne wyliczenie dokumentu.
   *
   * @param {RawItem[]} rawItems
   * @param {Object} [opts]
   * @param {number} [opts.advanceSettled=0] Suma zaliczek (minor units) odliczana
   *        na fakturze końcowej — patrz `settleAdvances`.
   * @returns {{ items: InvoiceItem[], taxLines: TaxLine[], totalNet: number,
   *             totalTax: number, totalGross: number, totalTaxLocal: number|null,
   *             advanceSettled: number, amountDue: number }}
   */
  calculate(rawItems, opts = {}) {
    const items = (rawItems || []).map((raw, idx) => this.calculateItem(raw, idx + 1));
    const taxLines = this.buildTaxLines(items);

    const totalNet = money.sum(taxLines.map((l) => l.netAmount));
    const totalTax = money.sum(taxLines.map((l) => l.taxAmount));
    const totalGross = totalNet + totalTax;

    const advanceSettled = Math.trunc(opts.advanceSettled || 0);

    return {
      items,
      taxLines,
      totalNet,
      totalTax,
      totalGross,
      totalTaxLocal: this.convertTaxToLocal(totalTax),
      advanceSettled,
      amountDue: totalGross - advanceSettled
    };
  }

  /**
   * Przelicza kwotę podatku na walutę lokalną sprzedawcy.
   * Zwraca `null`, gdy dokument jest już w walucie lokalnej (nie ma czego liczyć)
   * albo gdy brakuje kursu — brak kursu to świadomie `null`, nie zero, żeby
   * szablon mógł pokazać ostrzeżenie zamiast fałszywej kwoty 0,00.
   *
   * @param {number} taxMinor
   * @returns {number|null}
   */
  convertTaxToLocal(taxMinor) {
    if (!this.localCurrency || this.localCurrency === this.currency) return null;
    if (!this.exchangeRate || !Number.isFinite(Number(this.exchangeRate.rate))) return null;
    return money.convert(taxMinor, Number(this.exchangeRate.rate), this.currency, this.localCurrency);
  }

  /**
   * Rozliczenie zaliczek na fakturze końcowej.
   * Suma zaliczek to kwoty BRUTTO wcześniejszych faktur zaliczkowych.
   *
   * @param {Array<{ totalGross: number }>} advanceInvoices
   * @returns {number} suma w minor units
   */
  static settleAdvances(advanceInvoices) {
    return money.sum((advanceInvoices || []).map((inv) => Math.trunc(inv.totalGross || 0)));
  }

  /**
   * Faktura korygująca: różnice (delty) między stanem „przed" a „po".
   * Zwraca strukturę z obiema wersjami i różnicą — szablon korekty drukuje
   * wszystkie trzy, bo tego wymagają przepisy.
   *
   * @param {{ totalNet: number, totalTax: number, totalGross: number, taxLines: TaxLine[] }} before
   * @param {{ totalNet: number, totalTax: number, totalGross: number, taxLines: TaxLine[] }} after
   * @returns {{ before: object, after: object, delta: { totalNet: number, totalTax: number, totalGross: number } }}
   */
  static diff(before, after) {
    return {
      before,
      after,
      delta: {
        totalNet: (after.totalNet || 0) - (before.totalNet || 0),
        totalTax: (after.totalTax || 0) - (before.totalTax || 0),
        totalGross: (after.totalGross || 0) - (before.totalGross || 0)
      }
    };
  }
}

module.exports = { InvoiceCalculator };
