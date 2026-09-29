const db = require('../db/db_helper.js');
const { log } = require('../utils/logging');

/**
 * Samodzielna wysyłka zamówień przez konto podrzędne grupy
 * (`group_user.send_order_policy`, przełącznik grupy-matki w
 * /group/shops/:id/edit).
 *
 * Wyłączona (domyślnie, także `NULL`) — konto tylko wysyła zamówienie do
 * zatwierdzenia (`POST /orders/submit-for-approval/:orderId`), a na produkcję
 * idzie ono dopiero z panelu grupy. Włączona — konto wysyła je samo zwykłym
 * torem `POST /orders/send/:orderId`, tym samym, którym wysyła grupa-matka
 * pracująca w kontekście tego konta.
 *
 * ⚠️ Czytane z bazy przy każdym żądaniu, NIE z sesji: grupa-matka zmienia
 * ustawienie, gdy konto jest zalogowane, i zmiana ma działać od razu — w obie
 * strony. Błąd bazy = brak zgody (zachowanie sprzed przełącznika).
 *
 * @returns {Promise<boolean>} `false` dla każdej sesji innej niż konto podrzędne
 */
async function canGroupShopSendOrders(sessionUser) {
    if (!sessionUser?.isGroupShop || !sessionUser.groupShopId) return false;
    try {
        return (await db.getGroupUserSendOrderPolicy(sessionUser.groupShopId)) === true;
    } catch (err) {
        log('[groupShopSendPolicy] nie udało się odczytać send_order_policy:', err.message);
        return false;
    }
}

/**
 * Powód, dla którego konto podrzędne NIE może samo wysłać tego zamówienia,
 * albo `null` (wysyłka dozwolona / to nie jest sesja konta podrzędnego).
 *
 * ⚠️ Zamówienie, które już czeka w kolejce grupy (`pending_approval`), zostaje
 * po stronie grupy-matki także przy włączonym ustawieniu: `changeOrderStatus`
 * nie sprawdza bieżącego statusu, więc równoległe „Wyślij" konta i
 * „Zatwierdź i wyślij" grupy wysłałyby je na produkcję dwa razy. Grupa może je
 * zatwierdzić albo odrzucić (wraca do `active`, konto wyśle je samo).
 *
 * @returns {Promise<{status: number, message: string}|null>}
 */
async function getGroupShopSendBlock(sessionUser, orderId) {
    if (!sessionUser?.isGroupShop) return null;

    if (!(await canGroupShopSendOrders(sessionUser))) {
        return {
            status: 403,
            message: 'Zamówienie sklepu musi zostać zatwierdzone przez centralę. Użyj opcji „Wyślij do zatwierdzenia".'
        };
    }

    if (await db.getOrderStatus(orderId) === 'pending_approval') {
        return {
            status: 409,
            message: 'Zamówienie czeka już na zatwierdzenie przez centralę.'
        };
    }

    return null;
}

module.exports = { canGroupShopSendOrders, getGroupShopSendBlock };
