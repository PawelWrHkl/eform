const { selectQuery, insertQuery, updateQuery, deleteQuery } = require('./core')
const dateUtils = require("../utils/humanize_date.js");
const bcrypt = require('bcryptjs');
const { result } = require('lodash');
const { log } = require('../utils/logging');

/**
 * Parse a textual total_price (e.g. "Razem: 2027.70€", "Gesamtbetrag: 315.00€")
 * or a plain numeric string into a float. Returns null when unparseable.
 */
function parseTotalPrice(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const str = String(raw);
    // If it already looks numeric, return directly
    const direct = parseFloat(str);
    if (!isNaN(direct) && /^[\d\s.,]+$/.test(str.trim())) return direct;
    // Extract the part after the last ':'
    const afterColon = str.includes(':') ? str.split(':').pop() : str;
    // Strip currency symbols and whitespace
    const cleaned = afterColon.replace(/[€$£¥]/g, '').replace(/\s/g, '').replace(',', '.');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? null : parsed;
}

async function buildGroupShopOrderIdx(groupUserId) {
    const shopRows = await selectQuery(
        `SELECT ident FROM group_user WHERE id = ?`,
        [groupUserId]
    );
    const shopIdent = shopRows?.[0]?.ident || String(groupUserId);
    const match = String(shopIdent).match(/-?(\d+)$/);
    const shopSeq = match ? match[1] : String(shopIdent);
    const prefix = `${shopSeq}-`;
    const escapedShopSeq = String(shopSeq).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const orderRows = await selectQuery(
        `SELECT order_idx FROM \`order\` WHERE group_user_id = ? AND order_idx REGEXP ?`,
        [groupUserId, `^${escapedShopSeq}-[0-9]+$`]
    );
    const maxOrderSeq = (orderRows || [])
        .map(row => parseInt(String(row.order_idx).slice(prefix.length), 10))
        .filter(num => Number.isFinite(num) && num > 0)
        .reduce((max, num) => Math.max(max, num), 0);

    return `${prefix}${maxOrderSeq + 1}`;
}


async function getOrderWithItems(orderId) {

    const orderItemsQuery = 'SELECT * FROM order_item WHERE order_id = ?';
    const orderItems = await selectQuery(orderItemsQuery, orderId);

    const orderDetailsQuery = 'SELECT * FROM \`order\` WHERE id = ?';
    let orderDetails = await selectQuery(orderDetailsQuery, orderId);
    orderDetails = dateUtils.humanizeData(orderDetails);

    return { orderDetails, orderItems }
}

async function checkOwner(orderId, userId) {

    const query = 'SELECT id FROM \`order\` WHERE id = ? AND user_id = ?';
    const order = await selectQuery(query, [orderId, userId]);

    return order.length > 0;
}

async function checkGroupShopOrderOwner(orderId, groupShopId) {
    const query = 'SELECT id FROM \`order\` WHERE id = ? AND group_user_id = ?';
    const order = await selectQuery(query, [orderId, groupShopId]);
    return order.length > 0;
}

async function getOrderStatus(orderId) {
    const query = 'SELECT status FROM \`order\` WHERE id = ?';
    const rows = await selectQuery(query, orderId);
    return rows[0]?.status || null;
}

async function getOrderOwnerIdent(orderId) {
    const query = `SELECT u.ident FROM \`order\` o JOIN \`user\` u ON u.id = o.user_id WHERE o.id = ?`;
    const rows = await selectQuery(query, orderId);
    return rows[0]?.ident || null;
}

async function getOrderDetails(orderId) {
    const orderDetailsQuery = `SELECT 
    \`order\`.id,
    \`order\`.commision,
    \`order\`.created_date,
    \`order\`.status,
    \`order\`.comment,
    \`order\`.delivery_address_id,
    \`order\`.contact_info_id,
    -- Potrzebne w edycji zamówienia: end_client_id podstawia odbiorcę końcowego
    -- w formularzu, user_id wyznacza zakres jego kartoteki (admin i owner
    -- edytują cudze zamówienia) — patrz routes/orders.js.
    -- UWAGA: bez backticków — to wnętrze template literal w JS.
    \`order\`.user_id,
    \`order\`.end_client_id,
    da.id as address_id,
    da.street,
    da.phone_number as phone,
    da.city,
    da.zip,
    da.name,
    da.country,
    ci.email,
    send_address.id as send_address_id,
    send_address.name as send_name,
    send_address.street as send_street,
    send_address.phone as send_phone,
    send_address.email as send_email,
    send_address.city as send_city,
    send_address.zip as send_zip,
    send_address.country as send_country
    FROM \`order\`
    LEFT JOIN delivery_address da ON \`order\`.delivery_address_id = da.id
    LEFT JOIN contact_info ci ON \`order\`.contact_info_id = ci.id
    LEFT JOIN send_address ON \`order\`.send_address_id = send_address.id
    WHERE \`order\`.id = ?`;

    let orderDetails = await selectQuery(orderDetailsQuery, orderId);

    orderDetails = dateUtils.humanizeData(orderDetails);
    return orderDetails[0];
}


async function updateOrderDetails(orderId, comment, commission, deliveryAddressId, contactInfoId, sendAddress) {
    let values;
    let query = `UPDATE \`order\` SET commision = ?, comment = ?, delivery_address_id = ?, contact_info_id = ? WHERE id = ?`;

    const res = await updateQuery(query, [commission, comment, deliveryAddressId || null, contactInfoId || null, orderId]);


    if (sendAddress) {
        const sendAddressId = await getSendAddressId(orderId);
        if (!sendAddressId) {
            const newSendAddrId = await insertSendAddress(sendAddress);
            query = `UPDATE \`order\` SET send_address_id = ? WHERE id = ?`;
            await updateQuery(query, [newSendAddrId, orderId]);
        } else {
            query = `
                UPDATE \`order\`
                JOIN send_address ON \`order\`.send_address_id = send_address.id
                SET 
                    send_address.name = ?,
                    send_address.street = ?,
                    send_address.phone = ?,
                    send_address.email = ?,
                    send_address.city = ?,
                    send_address.zip = ?,
                    send_address.country = ?
                WHERE \`order\`.id = ?
            `;
            values = [
                sendAddress.name,
                sendAddress.street,
                sendAddress.phone,
                sendAddress.email,
                sendAddress.city,
                sendAddress.zip,
                sendAddress.country,
                orderId
            ];
            await updateQuery(query, values);
        }
    }

    return res;
}


async function getSendAddressId(orderId) {
    const sendAddQuery = 'SELECT send_address_id from \`order\` where id = ?';
    const sendAddId = await selectQuery(sendAddQuery, orderId);
    if (!sendAddId[0]?.send_address_id) {
        return false;
    }
    return sendAddId[0].send_address_id;
}
async function getOrderNo(orderId) {
    const query = 'SELECT order_idx from \`order\` where id = ?';
    const orderNo = await selectQuery(query, orderId);
    if (!orderNo[0]?.order_idx) {
        return false;
    };
    return orderNo[0]?.order_idx;
}
async function getDeliveryAddressId(orderId) {
    const query = 'SELECT delivery_address_id from \`order\` where id = ?';
    const result = await selectQuery(query, orderId);
    if (!result[0]?.delivery_address_id) {
        return false;
    }
    return result[0].delivery_address_id;
}

async function getOrderDataToSend(orderId) {
    const orderItemsQuery = 'SELECT * FROM order_item WHERE order_id = ?';
    const orderItems = await selectQuery(orderItemsQuery, orderId);
    const orderFlagsQuery = 'SELECT send_address_id, delivery_address_id, contact_info_id FROM `order` WHERE id = ?';
    const orderFlags = await selectQuery(orderFlagsQuery, orderId);
    const hasSendAddress = !!orderFlags[0]?.send_address_id;
    const hasDeliveryAddress = !!orderFlags[0]?.delivery_address_id;
    let orderDetailsQuery = '';

    if (hasSendAddress) {
        orderDetailsQuery = `SELECT o.id, o.commision, o.created_date, o.sent_date, o.comment, o.order_idx, o.total_price, o.total_price_hidden, o.contact_info_id, u.client_name, u.tax_id, u.ident as user_ident, u.street as user_street, u.zip as user_zip, u.city as user_city, u.country as user_country, u.phone as user_phone, org.ident as org_ident, s.name, s.street, s.zip, s.city, s.country, s.phone, COALESCE(ci.email, s.email, u.email) as email
FROM \`order\` o
join \`user\` u on u.id = o.user_id
join send_address s on s.id = o.send_address_id
left join contact_info ci on ci.id = o.contact_info_id
join organization org on org.id = o.organization_id
where o.id = ?`;
    } else if (hasDeliveryAddress) {
        orderDetailsQuery = `SELECT o.id, o.commision, o.created_date, o.sent_date, o.order_idx, o.comment, o.total_price, o.total_price_hidden, o.contact_info_id, u.client_name, u.tax_id, u.ident as user_ident, u.street as user_street, u.zip as user_zip, u.city as user_city, u.country as user_country, u.phone as user_phone, org.ident as org_ident, da.name, da.street, da.zip, da.city, da.country, da.phone_number as phone, COALESCE(ci.email, u.email) as email
FROM \`order\` o
join \`user\` u on u.id = o.user_id
join delivery_address da on da.id = o.delivery_address_id
left join contact_info ci on ci.id = o.contact_info_id
join organization org on org.id = o.organization_id
where o.id = ?`;
    } else {
        // No explicit send/delivery address selected.
        // For group shop orders use group_user data (address + email);
        // fallback to parent user data otherwise.
        orderDetailsQuery = `SELECT o.id, o.commision, o.created_date, o.sent_date, o.order_idx, o.comment, o.total_price, o.total_price_hidden, o.contact_info_id,
            u.client_name, u.tax_id, u.ident as user_ident, org.ident as org_ident,
            u.street as user_street, u.zip as user_zip, u.city as user_city, u.country as user_country, u.phone as user_phone,
            CASE WHEN o.group_user_id IS NOT NULL
                 THEN COALESCE(NULLIF(gu.name, ''), gu.ident)
                 ELSE u.client_name
            END as name,
            COALESCE(NULLIF(gu.street, ''), u.street) as street,
            COALESCE(NULLIF(gu.zip, ''), u.zip) as zip,
            COALESCE(NULLIF(gu.city, ''), u.city) as city,
            u.country as country,
            COALESCE(NULLIF(gu.phone, ''), u.phone) as phone,
            COALESCE(ci.email, NULLIF(gu.email, ''), u.email) as email
FROM \`order\` o
join \`user\` u on u.id = o.user_id
left join group_user gu on gu.id = o.group_user_id
left join contact_info ci on ci.id = o.contact_info_id
join organization org on org.id = o.organization_id
where o.id = ?`;
    }

    let orderDetails = await selectQuery(orderDetailsQuery, orderId);
    orderDetails = dateUtils.humanizeData(orderDetails)[0];

    return { orderDetails, orderItems }
}


async function deleteOrder(orderId) {
    const query = "DELETE FROM \`order\` WHERE id = ?";
    const response = await deleteQuery(query, orderId);
    return response;
}


async function getUserOrders(userId, limit = 10, offset = 0, sent = false, organization = false, employeeId = null) {
    let query = ''



    if (organization) {
        // Pobierz zlecenia wszystkich userów powiązanych z daną organizacją (centrala)
        if (!sent) {
            query = `
                SELECT o.id, o.user_id, o.delivery_address_id, o.commision, o.total_price, o.created_date, o.sent_date, o.organization_id, o.comment, o.status, o.send_address_id, o.order_idx, o.prod_status, o.delivery_date, o.spedition_numbers, o.max_prod_days, u.ident as user_ident, u.client_name as user_name, u.email as user_email
                FROM \`order\` o
                JOIN \`user\` u ON o.user_id = u.id
                WHERE u.organization_id = ? AND o.status LIKE 'active'
                ORDER BY o.id DESC
                LIMIT ? OFFSET ?
            `;
        } else {
            query = `
                SELECT o.id, o.user_id, o.delivery_address_id, o.commision, o.total_price, o.created_date, o.sent_date, o.organization_id, o.comment, o.status, o.send_address_id, o.order_idx, o.prod_status, o.delivery_date, o.spedition_numbers, o.max_prod_days, u.ident as user_ident, u.client_name as user_name, u.email as user_email
                FROM \`order\` o
                JOIN \`user\` u ON o.user_id = u.id
                WHERE u.organization_id = ? AND o.status LIKE 'sent'
                ORDER BY o.sent_date DESC
                LIMIT ? OFFSET ?
            `;
        }

        try {
            const rows = await selectQuery(query, [organization, limit, offset]);
            const result = dateUtils.humanizeData(rows);

            if (result.length == 0) { return false }
            return result;

        }
        catch (err) {
            log(err);
            return false;
        }
    }

    const sqlInput = employeeId !== null ? [' AND employee_id = ? '] : '';

    if (!sent) {
        query = `
        SELECT o.id, o.user_id, o.delivery_address_id, o.commision, o.total_price, o.created_date, o.sent_date, o.organization_id, o.comment, o.status, o.send_address_id, o.order_idx, o.value, o.total_price_hidden, o.employee_id, o.prod_status, o.delivery_date, o.spedition_numbers, o.max_prod_days
,e.id as emp_id, e.name, e.surname FROM \`order\` o 
        left join employee e on e.id = o.employee_id
        WHERE  o.user_id = ? ${sqlInput} and o.status like 'active'
        ORDER BY o.id DESC 
        LIMIT ? OFFSET ?
    `;
    }
    else {
        query = `
        SELECT o.id, o.user_id, o.delivery_address_id, o.commision, o.total_price, o.created_date, o.sent_date, o.organization_id, o.comment, o.status, o.send_address_id, o.order_idx, o.value, o.total_price_hidden, o.employee_id, o.prod_status, o.delivery_date, o.spedition_numbers, o.max_prod_days
,e.id as emp_id, e.name, e.surname FROM \`order\` o 
        left join employee e on e.id = o.employee_id
        WHERE o.user_id = ? ${sqlInput} and o.status like 'sent'
        ORDER BY o.sent_date DESC 
        LIMIT ? OFFSET ?
    `;
    }

    try {
        console.log('Executing organization orders query with params:', organization, limit, offset);

        let rows;
        if (employeeId !== null) {
            rows = await selectQuery(query, [userId, employeeId, limit, offset]);
        } else {
            rows = await selectQuery(query, [userId, limit, offset]);
        }

        const result = dateUtils.humanizeData(rows);
        if (result.length == 0) { return false }

        return result;
    }
    catch (err) {
        log(err);
        return false;
    }
}


async function getUserOrderId(orderId) {
    const query = `SELECT order_idx FROM \`order\` WHERE id = ?`;
    const result = await selectQuery(query, orderId);
    return result[0]?.order_idx || false;
}

async function countUserOrders(userId, sent = false, organization = false, employeeId = null) {
    let sql;
    try {
        let count
        if (organization) {

            if (!sent) {
                count = await selectQuery(
                    "SELECT COUNT(*) as count FROM `order` o JOIN `user` u ON o.user_id = u.id WHERE u.organization_id = ? AND o.status LIKE 'active'", organization
                );
            }
            else {
                count = await selectQuery(
                    "SELECT COUNT(*) as count FROM `order` o JOIN `user` u ON o.user_id = u.id WHERE u.organization_id = ? AND o.status LIKE 'sent'", organization
                );
            }
        } else {

            const sqlInput = employeeId !== null ? ' AND employee_id = ? ' : '';
            if (!sent) {
                sql = `
                    SELECT COUNT(*) as count FROM \`order\` WHERE user_id = ? ${sqlInput} and status like 'active'`
            }
            else {
                sql =
                    `SELECT COUNT(*) as count FROM \`order\` WHERE user_id = ? ${sqlInput} and status like 'sent'`
            }
            if (employeeId !== null) {
                count = await selectQuery(sql, [userId, employeeId]);
            } else {
                count = await selectQuery(sql, [userId]);
            }
        }

        if (!count || count.length === 0) {
            return 0;
        }
        return count[0].count;
    } catch (err) {
        log(err);
        return 0;
    }
}

async function insertSendAddress(address) {
    const query = `INSERT INTO send_address(name,street,city,zip,country,phone,email) values (?,?,?,?,?,?,?)`
    try {
        const response = await insertQuery(query,
            [
                address['name'],
                address['street'],
                address['city'],
                address['zip'],
                address['country'],
                address['phone'],
                address['email']])

        return response[0]?.insertId;

    }

    catch (err) {
        log(err);
        return false;
    }
}

async function insertNewOrder(commision, addressId, userId, comment, sendAddressId = null, totalPrice = 0, employeeId = null, mailId = null, groupUserId = null) {
    addressId = addressId || null;
    mailId = mailId || null;
    sendAddressId = sendAddressId || null;
    employeeId = employeeId || null;
    groupUserId = groupUserId || null;

    const groupShopOrderIdx = groupUserId ? await buildGroupShopOrderIdx(groupUserId) : null;

    if (groupShopOrderIdx) {
        const query = `INSERT INTO \`order\` 
        (user_id,
        delivery_address_id,
        commision,
        total_price,
        organization_id,
        comment,
        status,
        created_date,
        send_address_id,
        contact_info_id,
        employee_id,
        order_idx,
        group_user_id)
        values (?,?,?,
        ?,
        (select u.organization_id from eform.\`user\` u  where u.id =?) 
        ,?,'active',?,?,?,?,?,?)`
        try {
            const response = await insertQuery(query,
                [userId,
                    addressId,
                    commision,
                    totalPrice,
                    userId,
                    comment,
                    dateUtils.getDbTimestamp(),
                    sendAddressId,
                    mailId,
                    employeeId,
                    groupShopOrderIdx,
                    groupUserId
                ]
            )

            return response[0].insertId;
        }

        catch (err) {
            log(err);
            return false;
        }
    }

    const query = `INSERT INTO \`order\` 
    (user_id,
    delivery_address_id,
    commision,
    total_price,
    organization_id,
    comment,
    status,
    created_date,
    send_address_id,
    contact_info_id,
    employee_id,
    group_user_id)
    values (?,?,?,?,
    (select u.organization_id from eform.\`user\` u  where u.id =?) 
    ,?,'active',?,?,?,?,?)`
    try {
        const response = await insertQuery(query,
            [userId,
                addressId,
                commision,
                totalPrice,
                userId,
                comment,
                dateUtils.getDbTimestamp(),
                sendAddressId,
                mailId,
                employeeId,
                groupUserId
            ]
        )

        return response[0].insertId;
    }

    catch (err) {
        log(err);
        return false;
    }
}

async function submitOrderForApproval(orderId) {
    if (!(await orderHasItems(orderId))) {
        return false;
    }

    const query = `UPDATE \`order\` SET status = 'pending_approval' WHERE id = ?`;
    try {
        const response = await updateQuery(query, [orderId]);
        return response;
    } catch (err) {
        log(err);
        return false;
    }
}

async function orderHasItems(orderId) {
    const query = `SELECT COUNT(*) as cnt FROM order_item WHERE order_id = ?`;
    const result = await selectQuery(query, [orderId]);
    return Number(result?.[0]?.cnt) > 0;
}

async function getGroupShopOrders(groupUserId, limit = 10, offset = 0, sent = false) {
    const statuses = sent
        ? `('sent')`
        : `('active', 'pending_approval')`;
    const query = `
        SELECT o.id, o.user_id, o.commision, o.total_price, o.created_date, o.sent_date,
               o.comment, o.status, o.order_idx, o.prod_status, o.spedition_numbers, o.max_prod_days
        FROM \`order\` o
        WHERE o.group_user_id = ? AND o.status IN ${statuses}
        ORDER BY o.id DESC
        LIMIT ? OFFSET ?
    `;
    try {
        const rows = await selectQuery(query, [groupUserId, limit, offset]);
        return dateUtils.humanizeData(rows || []);
    } catch (err) {
        log(err);
        return [];
    }
}

async function countGroupShopOrders(groupUserId, sent = false) {
    const statuses = sent ? `('sent')` : `('active', 'pending_approval')`;
    const query = `SELECT COUNT(*) as cnt FROM \`order\` WHERE group_user_id = ? AND status IN ${statuses}`;
    try {
        const result = await selectQuery(query, [groupUserId]);
        return result?.[0]?.cnt || 0;
    } catch (err) {
        log(err);
        return 0;
    }
}

async function updateOrderComment(orderId, comment) {
    const query = `UPDATE \`order\` SET comment = ? where id = ?`
    try {
        const response = await updateQuery(query, [comment, orderId])
        return response;
    }

    catch (err) {
        return false;
    }
}

async function changeOrderStatus(orderId, status) {
    if (status === 'sent' && !(await orderHasItems(orderId))) {
        return false;
    }

    const sentDate = dateUtils.getDbTimestamp();
    const query = `UPDATE \`order\` SET status = ?, sent_date = ?  where id = ?`
    try {
        const response = await updateQuery(query, [status, sentDate, orderId])
        return response;
    }

    catch (err) {
        log(err);
        return false;
    }
}
async function updateOrderPriceOnSend(orderId, prices) {
    const hidden = prices?.hiddenPrices[0] ?? null;
    const visible = prices?.visiblePrices[0] ?? null;
    const totalFloat = parseTotalPrice(visible);
    const totalFloatHidden = parseTotalPrice(hidden);

    const query = `UPDATE \`order\` SET total_price = ?, total_price_hidden = ?, total_float = ?, total_float_hidden = ? where id = ?`
    try {
        const response = await updateQuery(query, [visible, hidden, totalFloat, totalFloatHidden, orderId])
        return response;
    }
    catch (err) {
        log(err);
        return false;
    }
}
async function getTotal(orderId) {
    const query = `select SUM(total_price) as total_price_hidden, SUM(unit_price) as total_price, SUM(total_price_sub) as total_price_sub from order_item where order_id = ?`;
    const result = await selectQuery(query, orderId);
    return {
        visible: result[0]?.total_price || 0,
        hidden: result[0]?.total_price_hidden || 0,
        sub: result[0]?.total_price_sub || 0
    };
}

async function syncTotalPriceIfMissing(orderId, computedTotal, totalLabel, totalHiddenLabel) {
    const visibleNum = parseFloat(computedTotal?.visible) || 0;
    const hiddenNum = parseFloat(computedTotal?.hidden) || 0;
    if (visibleNum === 0 && hiddenNum === 0) return;

    const checkQuery = `SELECT total_price, total_price_hidden FROM \`order\` WHERE id = ?`;
    const current = await selectQuery(checkQuery, orderId);
    if (!current || current.length === 0) return;

    const dbVisible = current[0]?.total_price;
    const dbHidden = current[0]?.total_price_hidden;
    const isEmpty = (val) => val === null || val === undefined || val === '' || val === '0' || val === '0.00';

    const needUpdateVisible = isEmpty(dbVisible) && visibleNum !== 0;
    const needUpdateHidden = isEmpty(dbHidden) && hiddenNum !== 0;

    if (needUpdateVisible || needUpdateHidden) {
        const newVisible = needUpdateVisible ? `${totalLabel}: ${computedTotal.visible}€` : dbVisible;
        const newHidden = needUpdateHidden ? `${totalHiddenLabel}: ${computedTotal.hidden}€` : dbHidden;
        const updateQ = `UPDATE \`order\` SET total_price = ?, total_price_hidden = ? WHERE id = ?`;
        try {
            await updateQuery(updateQ, [newVisible, newHidden, orderId]);
            log(`Synced total_price for order ${orderId}: visible=${newVisible}, hidden=${newHidden}`);
        } catch (err) {
            log('Error syncing total_price:', err);
        }
    }
}

async function saveDiscount(orderId, discountPercentage, discountValue) {
    const query = `UPDATE \`order\` SET client_discount_percentage = ?, client_discount_value = ? WHERE id = ?`;
    try {
        const response = await updateQuery(query, [discountPercentage, discountValue, orderId]);

        return {
            discountPercentage: response[0]?.client_discount_percentage,
            discountValue: response[0]?.client_discount_value
        };
    } catch (err) {
        log(err);
        return false;
    }
}

async function getDiscount(orderId) {
    const query = `SELECT client_discount_percentage, client_discount_value FROM \`order\` WHERE id = ?`;
    const result = await selectQuery(query, orderId);
    if (result.length === 0) {
        return null;
    }

    return result[0]
}

async function getOrderWithItems(orderId) {
    const orderItemsQuery = 'SELECT * FROM order_item WHERE order_id = ?';
    const orderItems = await selectQuery(orderItemsQuery, orderId);

    const orderDetailsQuery = 'SELECT * FROM `order` WHERE id = ?';
    let orderDetails = await selectQuery(orderDetailsQuery, orderId);
    orderDetails = dateUtils.humanizeData(orderDetails);

    return { orderDetails: orderDetails[0], orderItems }
}

async function searchUserOrders(userId, phrase, limit = 40, offset = 0, sent = false, employeeId = null, organization = false, filters = {}) {
    const safephrase = phrase.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const like = phrase ? `%${safephrase}%` : '%';
    const statusFilter = sent ? 'sent' : 'active';

    // Build optional extra WHERE clauses
    const extraClauses = [];
    const extraParams = [];
    if (filters.dateFrom) { extraClauses.push('DATE(o.created_date) >= ?'); extraParams.push(filters.dateFrom); }
    if (filters.dateTo)   { extraClauses.push('DATE(o.created_date) <= ?'); extraParams.push(filters.dateTo); }
    if (filters.prodStatus === '__received__') { extraClauses.push('(o.prod_status IS NULL OR o.prod_status = \'\')'); } else if (filters.prodStatus) { extraClauses.push('o.prod_status = ?'); extraParams.push(filters.prodStatus); }
    if (filters.sentDateFrom) { extraClauses.push('DATE(o.sent_date) >= ?'); extraParams.push(filters.sentDateFrom); }
    if (filters.sentDateTo)   { extraClauses.push('DATE(o.sent_date) <= ?'); extraParams.push(filters.sentDateTo); }
    const extraWhere = extraClauses.length ? ' AND ' + extraClauses.join(' AND ') : '';

    if (organization) {
        const query = `
            SELECT o.id, o.user_id, o.delivery_address_id, o.commision, o.total_price,
                   o.created_date, o.sent_date, o.organization_id, o.comment, o.status,
                   o.send_address_id, o.order_idx, o.prod_status, o.delivery_date,
                   o.spedition_numbers, o.max_prod_days,
                   u.ident as user_ident, u.client_name as user_name, u.email as user_email
            FROM \`order\` o
            JOIN \`user\` u ON o.user_id = u.id
            WHERE u.organization_id = ?
              AND o.status = ?
              AND (o.commision LIKE ? OR o.order_idx LIKE ? OR u.client_name LIKE ? OR u.ident LIKE ?)
              ${extraWhere}
            ORDER BY ${sent ? 'o.sent_date' : 'o.id'} DESC
            LIMIT ? OFFSET ?
        `;
        try {
            const rows = await selectQuery(query, [organization, statusFilter, like, like, like, like, ...extraParams, limit, offset]);
            if (!rows) return [];
            return dateUtils.humanizeData(rows);
        } catch (err) {
            log(err);
            return [];
        }
    }

    const employeeClause = employeeId !== null ? 'AND o.employee_id = ?' : '';
    const query = `
        SELECT o.id, o.user_id, o.delivery_address_id, o.commision, o.total_price,
               o.created_date, o.sent_date, o.organization_id, o.comment, o.status,
               o.send_address_id, o.order_idx, o.value, o.total_price_hidden,
               o.employee_id, o.prod_status, o.delivery_date, o.spedition_numbers, o.max_prod_days,
               e.name, e.surname
        FROM \`order\` o
        LEFT JOIN employee e ON e.id = o.employee_id
        WHERE o.user_id = ? ${employeeClause}
          AND o.status = ?
          AND (o.commision LIKE ? OR o.order_idx LIKE ?)
          ${extraWhere}
        ORDER BY o.id DESC
        LIMIT ? OFFSET ?
    `;
    const baseParams = employeeId !== null
        ? [userId, employeeId, statusFilter, like, like]
        : [userId, statusFilter, like, like];
    const params = [...baseParams, ...extraParams, limit, offset];
    try {
        const rows = await selectQuery(query, params);
        if (!rows) return [];
        return dateUtils.humanizeData(rows);
    } catch (err) {
        log(err);
        return [];
    }
}

async function countSearchUserOrders(userId, phrase, sent = false, employeeId = null, organization = false, filters = {}) {
    const safephrase = phrase.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const like = phrase ? `%${safephrase}%` : '%';
    const statusFilter = sent ? 'sent' : 'active';

    const extraClauses = [];
    const extraParams = [];
    if (filters.dateFrom) { extraClauses.push('DATE(o.created_date) >= ?'); extraParams.push(filters.dateFrom); }
    if (filters.dateTo)   { extraClauses.push('DATE(o.created_date) <= ?'); extraParams.push(filters.dateTo); }
    if (filters.prodStatus === '__received__') { extraClauses.push('(o.prod_status IS NULL OR o.prod_status = \'\')'); } else if (filters.prodStatus) { extraClauses.push('o.prod_status = ?'); extraParams.push(filters.prodStatus); }
    if (filters.sentDateFrom) { extraClauses.push('DATE(o.sent_date) >= ?'); extraParams.push(filters.sentDateFrom); }
    if (filters.sentDateTo)   { extraClauses.push('DATE(o.sent_date) <= ?'); extraParams.push(filters.sentDateTo); }
    const extraWhere = extraClauses.length ? ' AND ' + extraClauses.join(' AND ') : '';

    if (organization) {
        const sql = `SELECT COUNT(*) as count FROM \`order\` o
            JOIN \`user\` u ON o.user_id = u.id
            WHERE u.organization_id = ? AND o.status = ? AND (o.commision LIKE ? OR o.order_idx LIKE ? OR u.client_name LIKE ? OR u.ident LIKE ?)
            ${extraWhere}`;
        try {
            const result = await selectQuery(sql, [organization, statusFilter, like, like, like, like, ...extraParams]);
            return result ? result[0].count : 0;
        } catch (err) {
            log(err);
            return 0;
        }
    }

    const employeeClause = employeeId !== null ? 'AND o.employee_id = ?' : '';
    const sql = `SELECT COUNT(*) as count FROM \`order\` o
        LEFT JOIN employee e ON e.id = o.employee_id
        WHERE o.user_id = ? ${employeeClause} AND o.status = ? AND (o.commision LIKE ? OR o.order_idx LIKE ?)
        ${extraWhere}`;
    const baseParams = employeeId !== null
        ? [userId, employeeId, statusFilter, like, like]
        : [userId, statusFilter, like, like];
    const params = [...baseParams, ...extraParams];
    try {
        const result = await selectQuery(sql, params);
        return result ? result[0].count : 0;
    } catch (err) {
        log(err);
        return 0;
    }
}

async function updateMaxProdDays(orderId, maxProdDays) {
    const query = `UPDATE \`order\` SET max_prod_days = ? WHERE id = ?`;
    try {
        const response = await updateQuery(query, [maxProdDays, orderId]);
        return response;
    } catch (err) {
        log(err);
        return false;
    }
}

module.exports = {
    getOrderWithItems,
    getOrderDetails,
    getOrderStatus,
    getOrderOwnerIdent,
    updateOrderDetails,
    getOrderDataToSend,
    deleteOrder,
    getUserOrders,
    countUserOrders,
    searchUserOrders,
    countSearchUserOrders,
    getDeliveryAddressId,
    insertNewOrder,
    updateOrderComment,
    changeOrderStatus,
    insertSendAddress,
    getUserOrderId,
    checkOwner,
    checkGroupShopOrderOwner,
    updateOrderPriceOnSend,
    getTotal,
    syncTotalPriceIfMissing,
    saveDiscount,
    getDiscount,
    getOrderNo,
    updateMaxProdDays,
    submitOrderForApproval,
    orderHasItems,
    getGroupShopOrders,
    countGroupShopOrders,
}

