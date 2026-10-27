/**
 * Human-readable VAT-rate text for the read-only VAT field, shared by
 * form.js's buildVatFields() and pricesCalculator.js's applyVatToGrossValue()
 * (kept in its own module so both can import it without a circular
 * dependency between form.js and formTools/updateFieldsAndValues.js).
 *
 * Always returns something meaningful — 0% is a real, legitimate rate
 * (cross-border/export sale), not an "empty" state, so it gets a reason
 * suffix instead of being left to look like a blank/broken field.
 */
export function formatVatRateLabel(vatRate) {
    if (vatRate !== 0) return `${vatRate}%`;

    const reasonKeys = {
        'eu-reverse-charge': 'form.vat_reason_eu_reverse_charge',
        'export': 'form.vat_reason_export',
        'unknown': 'form.vat_reason_unknown'
    };
    const reasonKey = reasonKeys[window.vatReason];
    return reasonKey ? `0% (${t(reasonKey)})` : '0%';
}

/**
 * Który tor VAT-u (decyzja właściciela 2026-10-26):
 *  • false — klient HKL (org id 3, `window.isHklOrg`): VAT od zwykłego
 *    `SUMA_BRUTTO`, pola widoczne;
 *  • true — każda inna organizacja albo grupa: konto podrzędne
 *    (`window.isGroupShop`) i grupa-matka (`window.isGroup`, od 2026-10-27 —
 *    grupy siedzą w organizacji HKL, ale ceną ich klienta jest `SUB___`):
 *    VAT od `SUB___WARTOSC_KONCOWA`, a wszystkie pola VAT ukryte tak jak
 *    parametry z `=HASLO()`.
 */
export function vatUsesClientPrice() {
    return !window.isHklOrg || !!window.isGroupShop || !!window.isGroup;
}
