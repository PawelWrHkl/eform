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
