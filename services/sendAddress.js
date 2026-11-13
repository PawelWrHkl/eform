/**
 * Adres wysyłki zlecenia na inny adres (`send_address`) — np. klient końcowy
 * hurtownika. Sprawdzany na serwerze przed zapisem (POP-02).
 *
 * Reguły wzięte z błędnych adresów, które przeszły do PROD (A&A, 10–11.2026):
 * kod pocztowy „Mülheim”/„Hannover”, numer telefonu w polu kodu, miasto „45470”.
 * Limity = kolumny `send_address` (telefon 50 po `migration_phone_lengths.sql`).
 */
const LIMITS = { name: 126, street: 255, zip: 10, city: 126, country: 60, phone: 50, email: 80 };
const REQUIRED = ['name', 'street', 'zip', 'city', 'country'];

/**
 * @param {Record<string, any>} raw  `orderSendAddress` z formularza
 * @returns {{ value: { name, street, zip, city, country, phone, email, neutral: boolean }, errors: string[] }}
 *          `errors` — nazwy błędnych pól (puste = adres poprawny)
 */
function normalizeSendAddress(raw = {}) {
    const value = {};
    for (const field of Object.keys(LIMITS)) value[field] = String(raw[field] ?? '').trim();
    value.neutral = [true, 1, '1', 'true'].includes(raw.neutral);

    const errors = new Set();
    for (const field of REQUIRED) if (!value[field]) errors.add(field);
    for (const [field, max] of Object.entries(LIMITS)) if (value[field].length > max) errors.add(field);
    if (value.zip && !/\d/.test(value.zip)) errors.add('zip');
    if (value.city && !/\p{L}/u.test(value.city)) errors.add('city');
    if (value.phone && !/^\+?[\d\s\-()./]{6,}$/.test(value.phone)) errors.add('phone');
    if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) errors.add('email');

    return { value, errors: [...errors] };
}

module.exports = { normalizeSendAddress, LIMITS };
