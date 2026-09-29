/**
 * Nazwa pliku zamówienia na FTP (`/orders-out/`) BEZ rozszerzenia:
 * `<orgIdent>_<userIdent>_<orderNo><suffix>`, np. `HKL_ryver_242`.
 *
 * ⚠️ Jedno źródło prawdy dla KAŻDEGO pliku o zamówieniu: JSON-a z wysyłki
 * (`utils/saveOrdersOutput.js setJsonFileName`), korekty (`-update`) i znacznika
 * anulowania (`.cancel`, services/orderCancellation.js). Produkcja paruje te
 * pliki po nazwie, więc znacznik z inną nazwą niż wysłany JSON byłby po cichu
 * zignorowany.
 *
 * Osobny moduł bez zależności, bo `saveOrdersOutput.js` ładuje całą warstwę
 * bazy — a nazwę pliku trzeba umieć policzyć także w testach bez MySQL.
 */
function buildOrderFileName(orgIdent, userIdent, orderNo, suffix = '') {
    return `${orgIdent}_${userIdent}_${orderNo}${suffix}`;
}

module.exports = { buildOrderFileName };
