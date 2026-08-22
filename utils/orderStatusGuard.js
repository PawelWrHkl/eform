const db = require('../db/db_helper.js');
const { isClientGroupType } = require('../services/groupType');

function sentOrderPath(orderId) {
    return `/orders/history/order/${orderId}`;
}

function activeOrderPath(orderId) {
    return `/orders/order/${orderId}`;
}

/**
 * Zamówienie ZAŁOŻONE PRZEZ KLIENTA grupy jest dla grupy typu `client`
 * (`user.group_type = 'client'`) tylko do wglądu i zatwierdzenia — grupa-matka
 * nie edytuje ani nie usuwa ani zamówienia, ani jego pozycji.
 *
 * ⚠️ Rozstrzyga `order.created_by_group_user_id`, a NIE `group_user_id`: od
 * wprowadzenia kontekstu grupy (services/groupContext.js) zamówienie z
 * przypisanym kontem podrzędnym może być równie dobrze zamówieniem, które
 * grupa sama założyła „jako ten klient" — i tego wolno jej edytować.
 *
 * ⚠️ Dotyczy wyłącznie sesji konta grupowego. Admin i owner zachowują pełny
 * dostęp (mają go wszędzie, także przy korektach), a samo konto podrzędne
 * edytuje własne zamówienie jak dotąd.
 *
 * @returns {Promise<object|null>} powód blokady albo `null`
 */
async function getClientGroupOrderBlock(orderId, sessionUser) {
    if (!orderId || !sessionUser?.isGroup) return null;
    if (sessionUser.isAdmin || sessionUser.isOwner) return null;
    if (!isClientGroupType(sessionUser.groupType)) return null;

    const createdBy = await db.getOrderCreatedByGroupUser(orderId);
    if (!createdBy) return null;

    return {
        success: false,
        status: 'error',
        message: 'Zamówienie zostało utworzone przez klienta — możesz je podejrzeć i zatwierdzić, ale nie edytować ani usunąć.',
        redirect: activeOrderPath(orderId)
    };
}

/**
 * Returns block reason when order must not be edited, or null if editing is allowed.
 */
async function getOrderMutationBlock(orderId, sessionUser) {
    // Blokada „zamówienie klienta grupy" ma pierwszeństwo: nie zależy od
    // statusu, a tę funkcję wołają WSZYSTKIE mutacje pozycji i zamówienia
    // (routes/positions.js, routes/orders.js), więc jedno miejsce wystarczy.
    const clientGroupBlock = await getClientGroupOrderBlock(orderId, sessionUser);
    if (clientGroupBlock) return clientGroupBlock;

    const status = await db.getOrderStatus(orderId);

    if (status === 'correction') {
        if (sessionUser?.isAdmin) {
            return null;
        }
        return {
            success: false,
            status: 'error',
            message: 'Zamówienie jest w trakcie korekty administracyjnej.',
            redirect: sentOrderPath(orderId)
        };
    }

    if (status === 'sent') {
        return {
            success: false,
            status: 'error',
            message: 'Nie można edytować wysłanego zamówienia.',
            redirect: sentOrderPath(orderId)
        };
    }

    return null;
}

async function shouldRedirectFromActiveOrderView(orderId, sessionUser) {
    const status = await db.getOrderStatus(orderId);

    if (status === 'sent') {
        return { redirect: sentOrderPath(orderId) };
    }

    if (status === 'correction' && !sessionUser?.isAdmin) {
        return { redirect: sentOrderPath(orderId) };
    }

    return null;
}

async function isSentOrder(orderId) {
    return (await db.getOrderStatus(orderId)) === 'sent';
}

async function isCorrectionOrder(orderId) {
    return (await db.getOrderStatus(orderId)) === 'correction';
}

module.exports = {
    sentOrderPath,
    activeOrderPath,
    getClientGroupOrderBlock,
    getOrderMutationBlock,
    shouldRedirectFromActiveOrderView,
    isSentOrder,
    isCorrectionOrder
};
