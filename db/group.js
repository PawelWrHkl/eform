const { selectQuery, insertQuery, updateQuery, deleteQuery } = require('./core');
const bcrypt = require('bcryptjs');
const { log } = require('../utils/logging');

async function getGroupUsersByParentId(parentUserId) {
    const query = `
        SELECT id, user_id, ident, pin, plain, name, street, zip, city, phone, email, tax_id,
               discount_percent
        FROM group_user
        WHERE user_id = ?
        ORDER BY id, ident
    `;
    const result = await selectQuery(query, [parentUserId]);
    return result || [];
}

async function getGroupUserById(id) {
    const query = `
        SELECT id, user_id, ident, pin, name, street, zip, city, phone, email, tax_id,
               discount_percent
        FROM group_user
        WHERE id = ?
    `;
    const result = await selectQuery(query, [id]);
    return result?.[0] || null;
}

async function getGroupUserByLogin(login) {
    const query = `SELECT * FROM group_user WHERE pin = ?`;
    const result = await selectQuery(query, [login]);
    return result?.[0] || null;
}

async function isGroupLoginTaken(login, excludeId = null) {
    let query = `SELECT id FROM group_user WHERE pin = ?`;
    const params = [login];
    if (excludeId) {
        query += ` AND id != ?`;
        params.push(excludeId);
    }
    const result = await selectQuery(query, params);
    return result && result.length > 0;
}

async function isGroupIdentTaken(ident, excludeId = null) {
    let query = `SELECT id FROM group_user WHERE ident = ?`;
    const params = [ident];
    if (excludeId) {
        query += ` AND id != ?`;
        params.push(excludeId);
    }
    const result = await selectQuery(query, params);
    return result && result.length > 0;
}

async function findNextSeq(parentUserId, parentIdent) {
    const rows = await selectQuery(
        `SELECT ident FROM group_user WHERE user_id = ?`,
        [parentUserId]
    );
    const prefix = `${parentIdent}-`;
    const usedNums = new Set(
        (rows || [])
            .map(r => r.ident)
            .filter(id => id && id.startsWith(prefix))
            .map(id => parseInt(id.slice(prefix.length), 10))
            .filter(n => Number.isFinite(n) && n > 0)
    );
    let seq = 1;
    while (usedNums.has(seq)) seq++;
    return seq;
}

async function previewNewGroupUser(parentUserId) {
    const parentPin = await (require('./users').getUserPinById)(parentUserId);
    const parentIdent = parentPin
        ? await (require('./users').getUserIdent)(parentPin)
        : String(parentUserId);

    const seq = await findNextSeq(parentUserId, parentIdent);
    return {
        ident: `${parentIdent}-${seq}`,
        pin:   `${parentPin || parentIdent}-${seq}`
    };
}

async function addGroupUser(data) {
    const {
        parentUserId,
        password,
        name = '',
        street = '',
        zip = '',
        city = '',
        phone = '',
        email = '',
        discountPercent = 0
    } = data;

    const hashedPassword = bcrypt.hashSync(password, 12);

    // Generuj ident: {parentIdent}-{n} np. TCN-1, TCN-2
    // Generuj pin:   {parentPin}-{n}  np. TCN123-1, TCN123-2
    const parentPin = await (require('./users').getUserPinById)(parentUserId);
    const parentIdent = parentPin
        ? await (require('./users').getUserIdent)(parentPin)
        : String(parentUserId);

    const seq = await findNextSeq(parentUserId, parentIdent);
    const ident = `${parentIdent}-${seq}`;
    const pin = `${parentPin || parentIdent}-${seq}`;

    const query = `
        INSERT INTO group_user
            (user_id, ident, pin, password, plain, name, street, zip, city, phone, email, tax_id, discount_percent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
    `;
    try {
        const result = await insertQuery(query, [
            parentUserId, ident, pin, hashedPassword, password,
            name, street, zip, city, phone, email, normalizeDiscountPercent(discountPercent)
        ]);
        return { success: true, id: result[0]?.insertId, ident, pin };
    } catch (err) {
        log('[group.js] addGroupUser error:', err.message);
        if (err.code === 'ER_DUP_ENTRY') {
            return { success: false, info: 'DUPLICATE' };
        }
        throw err;
    }
}

async function updateGroupUser(id, data) {
    const {
        name = '',
        street = '',
        zip = '',
        city = '',
        phone = '',
        email = ''
    } = data;

    // Rabat aktualizujemy TYLKO gdy wołający go podał — grupa typu `shop` nie
    // ma tego pola w formularzu i nie może przez zapis danych adresowych
    // wyczyścić rabatu ustawionego wcześniej (np. przez zmianę typu grupy).
    const hasDiscount = data.discountPercent !== undefined && data.discountPercent !== null;

    const query = hasDiscount
        ? `UPDATE group_user
           SET name = ?, street = ?, zip = ?, city = ?, phone = ?, email = ?, discount_percent = ?
           WHERE id = ?`
        : `UPDATE group_user
           SET name = ?, street = ?, zip = ?, city = ?, phone = ?, email = ?
           WHERE id = ?`;
    const params = hasDiscount
        ? [name, street, zip, city, phone, email, normalizeDiscountPercent(data.discountPercent), id]
        : [name, street, zip, city, phone, email, id];

    await updateQuery(query, params);
    return { success: true };
}

/**
 * Rabat klienta grupy: procent w zakresie 0–100, zaokrąglony do dwóch miejsc.
 * ⚠️ Zakres pilnujemy TUTAJ, a nie tylko w formularzu — pole edytuje grupa,
 * a `DECIMAL(5,2)` przyjąłby 999.99 i pozycja policzyłaby się na minus.
 */
function normalizeDiscountPercent(value) {
    const num = parseFloat(String(value ?? '').replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.min(100, Math.round(num * 100) / 100);
}

async function updateGroupUserPassword(id, password) {
    const hashedPassword = bcrypt.hashSync(password, 12);
    const query = `UPDATE group_user SET password = ? WHERE id = ?`;
    await updateQuery(query, [hashedPassword, id]);
    return { success: true };
}

async function deleteGroupUser(id) {
    const query = `DELETE FROM group_user WHERE id = ?`;
    await deleteQuery(query, [id]);
    return { success: true };
}

async function countGroupUsers(parentUserId) {
    const query = `SELECT COUNT(*) as cnt FROM group_user WHERE user_id = ?`;
    const result = await selectQuery(query, [parentUserId]);
    return result?.[0]?.cnt || 0;
}

async function getPendingOrdersByParentUserId(parentUserId) {
    const query = `
        SELECT o.id, o.order_idx, o.commision, o.created_date, o.total_price, o.comment, o.status,
               gu.id as shop_id, gu.ident as shop_ident, gu.name as shop_name, gu.id as shop_number
        FROM \`order\` o
        JOIN group_user gu ON gu.id = o.group_user_id
        WHERE gu.user_id = ? AND o.status = 'pending_approval'
        ORDER BY o.id DESC
    `;
    const result = await selectQuery(query, [parentUserId]);
    return result || [];
}

async function countPendingOrdersByParentUserId(parentUserId) {
    const query = `
        SELECT COUNT(*) as cnt FROM \`order\` o
        JOIN group_user gu ON gu.id = o.group_user_id
        WHERE gu.user_id = ? AND o.status = 'pending_approval'
    `;
    const result = await selectQuery(query, [parentUserId]);
    return result?.[0]?.cnt || 0;
}

async function getGroupUserByOrderId(orderId) {
    const query = `
        SELECT gu.* FROM group_user gu
        JOIN \`order\` o ON o.group_user_id = gu.id
        WHERE o.id = ?
    `;
    const result = await selectQuery(query, [orderId]);
    return result?.[0] || null;
}

async function getAllShopOrdersByParentUserId(parentUserId, limit = 20, offset = 0, sent = false, shopId = null) {
    const statuses = sent ? `('sent')` : `('active', 'pending_approval')`;
    const params = [parentUserId];
    let shopFilter = '';
    if (shopId) {
        shopFilter = ' AND gu.id = ?';
        params.push(shopId);
    }
    const query = `
        SELECT o.id, o.commision, o.created_date, o.sent_date, o.total_price, o.comment,
               o.status, o.order_idx, o.prod_status,
               gu.id as shop_id, gu.ident as shop_ident, gu.name as shop_name
        FROM \`order\` o
        JOIN group_user gu ON gu.id = o.group_user_id
        WHERE gu.user_id = ? AND o.status IN ${statuses}${shopFilter}
        ORDER BY o.id DESC
        LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    const result = await selectQuery(query, params);
    return result || [];
}

async function countAllShopOrdersByParentUserId(parentUserId, sent = false, shopId = null) {
    const statuses = sent ? `('sent')` : `('active', 'pending_approval')`;
    const params = [parentUserId];
    let shopFilter = '';
    if (shopId) {
        shopFilter = ' AND gu.id = ?';
        params.push(shopId);
    }
    const query = `
        SELECT COUNT(*) as cnt FROM \`order\` o
        JOIN group_user gu ON gu.id = o.group_user_id
        WHERE gu.user_id = ? AND o.status IN ${statuses}${shopFilter}
    `;
    const result = await selectQuery(query, params);
    return result?.[0]?.cnt || 0;
}

async function getOrderCountsByShop(parentUserId) {
    const query = `
        SELECT gu.id as shop_id,
               SUM(CASE WHEN o.status = 'pending_approval' THEN 1 ELSE 0 END) as pending_count,
               SUM(CASE WHEN o.status = 'sent' THEN 1 ELSE 0 END) as sent_count,
               SUM(CASE WHEN o.status IN ('pending_approval','sent') THEN 1 ELSE 0 END) as total_count
        FROM group_user gu
        LEFT JOIN \`order\` o ON o.group_user_id = gu.id
        WHERE gu.user_id = ?
        GROUP BY gu.id
    `;
    const rows = await selectQuery(query, [parentUserId]);
    const map = {};
    (rows || []).forEach(r => {
        map[r.shop_id] = {
            pending: Number(r.pending_count) || 0,
            sent: Number(r.sent_count) || 0,
            total: Number(r.total_count) || 0
        };
    });
    return map;
}

module.exports = {
    normalizeDiscountPercent,
    getGroupUsersByParentId,
    getGroupUserById,
    getGroupUserByLogin,
    isGroupLoginTaken,
    isGroupIdentTaken,
    previewNewGroupUser,
    addGroupUser,
    updateGroupUser,
    updateGroupUserPassword,
    deleteGroupUser,
    countGroupUsers,
    getPendingOrdersByParentUserId,
    countPendingOrdersByParentUserId,
    getGroupUserByOrderId,
    getAllShopOrdersByParentUserId,
    countAllShopOrdersByParentUserId,
    getOrderCountsByShop,
};
