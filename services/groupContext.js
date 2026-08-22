/**
 * Kontekst konta podrzędnego dla użytkownika grupowego (`role = 'group'`).
 *
 * Odpowiednik kontekstu klienta u admina/ownera (`services/owner.js`), ale na
 * innym poziomie danych: konta podrzędne grupy to wiersze `group_user`, a NIE
 * `user` — dzielą wiersz `user` (a więc pin, cennik, organizację) z grupą-matką
 * i różnią się wyłącznie kolumną `order.group_user_id`. Dlatego kontekst grupy
 * nie może korzystać z `setContextUserByIdent` (ten podmienia użytkownika) —
 * trzyma osobny klucz w sesji i wskazuje, „na kogo" pracuje grupa.
 *
 * ⚠️ `getActiveGroupShopId(req)` jest jedynym miejscem, które odpowiada na
 * pytanie „którego konta podrzędnego dotyczy to żądanie": konto podrzędne
 * zalogowane samo (`isGroupShop`) ma swoje `groupShopId`, a grupa-matka —
 * wybrany kontekst. Bez tego każdy widok zamówień musiałby znać oba przypadki
 * osobno i któryś nieuchronnie by je rozjechał.
 */

const db = require('../db/db_helper');
const ownerService = require('./owner');
const { log } = require('../utils/logging');

const SESSION_KEY = 'group_shop_context';

function isGroupSession(req) {
    return !!(req?.session?.user?.isGroup || req?.session?.context_user?.isGroup);
}

/**
 * Kontekst z sesji — tylko dla sesji, która NAPRAWDĘ jest grupą (albo adminem
 * w kontekście grupy). Gdyby ktoś przełączył kontekst klienta na zwykłego
 * użytkownika, stary wpis nie może dalej filtrować jego zamówień.
 */
function getGroupShopContext(req) {
    if (!isGroupSession(req)) return null;
    return req?.session?.[SESSION_KEY] || null;
}

/** Id konta podrzędnego, którego dotyczy żądanie (sesja sklepu ALBO kontekst grupy). */
function getActiveGroupShopId(req) {
    if (req?.session?.user?.isGroupShop) {
        return req.session.user.groupShopId || null;
    }
    const ctx = getGroupShopContext(req);
    return ctx ? ctx.id : null;
}

/**
 * Ustawia kontekst po weryfikacji, że konto podrzędne należy do TEJ grupy.
 * @returns {Promise<object|null>} zapisany kontekst albo `null` (brak uprawnień)
 */
async function setGroupShopContext(req, shopId) {
    if (!req?.session || !isGroupSession(req)) return null;

    const id = parseInt(shopId, 10);
    if (!Number.isFinite(id)) return null;

    const currentUser = ownerService.getCurrentUser(req);
    const shop = await db.getGroupUserById(id);
    // Zakres po właścicielu: grupa może wejść wyłącznie w kontekst SWOJEGO
    // konta podrzędnego — inaczej id z adresu byłoby wglądem w cudze zamówienia.
    if (!shop || !currentUser || shop.user_id !== currentUser.userId) {
        log(`[groupContext] odrzucono kontekst ${shopId} dla user_id=${currentUser?.userId}`);
        return null;
    }

    const context = {
        id: shop.id,
        ident: shop.ident,
        name: shop.name || shop.ident,
        email: shop.email || null,
        setAt: new Date().toISOString()
    };
    req.session[SESSION_KEY] = context;
    return context;
}

function clearGroupShopContext(req) {
    if (!req?.session) return false;
    delete req.session[SESSION_KEY];
    return true;
}

module.exports = {
    SESSION_KEY,
    getGroupShopContext,
    getActiveGroupShopId,
    setGroupShopContext,
    clearGroupShopContext,
};
