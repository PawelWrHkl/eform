const e = require('express');
const { selectQuery, insertQuery, updateQuery, deleteQuery, connetToDb } = require('./core');
const { get } = require('lodash');
const { log } = require('../utils/logging');
const connection = connetToDb()


async function insertNewForm(formData) {
    const orderpos = await getPosCounter(formData.order) + 1;
    formData.orderpos = orderpos;
    log(orderpos, formData.orderpos, "ORDER POS IN INSERT NEW FORM @@@@@@@@@@@@")
    const insertFormQuery = 'INSERT INTO order_item(order_id, name, commision, json_parameters, json_parameters_desc, amount, list_price, discount_percentage, discount, unit_price, total_price, total_price_sub, comment,ver,asortment_group_number,lang,department,group_name,parameters_short,orderpos) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

    const fields = [
        formData.order,
        formData.name,
        formData.commission,
        JSON.stringify(formData.jsonValues),
        JSON.stringify(formData.jsonValuesToDisplay),
        formData.amount,
        JSON.stringify(formData.listPrice),
        formData.discountPercentage,
        formData.discount,
        formData.unitPrice,
        formData.totalPrice,
        formData.totalPriceSub || 0,
        formData.comment,
        formData.version,
        formData.groupNumber,
        formData.lang,
        formData.department,
        formData.group,
        JSON.stringify(formData.parameters_short),
        formData.orderpos
    ];

    const response = await insertQuery(insertFormQuery, fields);

    return response;

}

async function getAttachments(positionId) {
    const query = 'SELECT attachments FROM order_item WHERE id = ?';
    const response = await selectQuery(query, positionId);
    return response[0] ? response[0].attachments : null;
}


async function updateAttachments(positionId, attachments) {
    const query = 'UPDATE order_item SET attachments = ? WHERE id = ?';
    const response = await updateQuery(query, [JSON.stringify(attachments), positionId]);
    return response;
}


async function getPosCounter(orderId) {
    const query = 'SELECT COUNT(*) as count FROM order_item WHERE order_id = ?'
    const response = await selectQuery(query, orderId);
    return response[0].count;
}


async function updateOrderpos(orderId, orderPos) {
    const query = 'UPDATE order_item SET orderpos = ? WHERE order_id = ?';
    const response = await updateQuery(query, [orderPos, orderId]);
    return response;
}


async function reindexOrderPositions(orderId) {

    const query = 'SELECT id FROM order_item WHERE order_id = ? ORDER BY orderpos ASC, id ASC';
    const positions = await selectQuery(query, orderId);

    if (!positions || positions.length === 0) {
        return 0;
    }

    for (let i = 0; i < positions.length; i++) {
        const query = 'UPDATE order_item SET orderpos = ? WHERE id = ?';
        await updateQuery(query, [i + 1, positions[i].id]);
    }

    log(`✅ Przenumerowano ${positions.length} pozycji dla zamówienia ${orderId}`);
    return positions.length;
}


async function getOrderpos(posId) {
    const query = 'SELECT orderpos FROM order_item WHERE id = ?'
    const response = await selectQuery(query, posId);
    return response[0].orderpos;
}


async function updateOrderPrice(orderId, newPrice) {
    let total = 0;
    let total_hidden = 0;
    let total_sub = 0;
    const getItemPrices = `SELECT oi.unit_price , oi.total_price, oi.total_price_sub 
    FROM eform.order_item oi
    join eform.\`order\` o on oi.order_id = o.id where o.id =?;`;

    const currentPrices = await selectQuery(getItemPrices, orderId);
    log(currentPrices, "CURRENT PRICE @@@@@@@@@@@@")
    if (currentPrices.length == 0) {
        throw new Error(`Order with ID ${orderId} not found.`);
    }

    for (let price of Object.entries(currentPrices)) {
        price = price[1];
        log(price, price.unit_price, price.total_price, "PRICE ITEM @@@@@@@@@@@@")
        total += parseFloat(price.unit_price);
        total_hidden += parseFloat(price?.total_price ?? 0);
        total_sub += parseFloat(price?.total_price_sub ?? 0);
    }
    total = parseFloat(total.toFixed(2));
    total_hidden = parseFloat(total_hidden.toFixed(2));
    total_sub = parseFloat(total_sub.toFixed(2));
    newPrice = { total: total, total_hidden: total_hidden, total_sub: total_sub };

    const updateQueryStr = 'UPDATE `order` SET total_price = ?, total_price_hidden = ?, total_float = ?, total_float_hidden = ?, total_price_sub = ? WHERE id = ?';
    const response = await updateQuery(updateQueryStr, [total, total_hidden, total, total_hidden, total_sub, orderId]);
    return response;
}


async function getPosition(positionId) {
    const query = 'SELECT * FROM order_item WHERE id LIKE ?'
    let result = await selectQuery(query, positionId)
    return result[0];
}


async function getLastChoice(userId) {
    const query = 'SELECT * FROM department,asortment_group WHERE user_pin LIKE ?'
    let result = await selectQuery(query, userId)
    return result[0];
}


async function updatePosition(positionData, total) {
    const query = `
    UPDATE order_item
    SET 
        commision = ?,
        name = ?,
        json_parameters = ?,
        json_parameters_desc = ?,
        comment = ?,
        unit_price = ?,
        total_price = ?,
        total_price_sub = ?,
        parameters_short = ?
    WHERE id = ?
  `;
    const values = [
        positionData.commission,
        positionData.commission,
        JSON.stringify(positionData.jsonValues),
        JSON.stringify(positionData.jsonValuesToDisplay),
        positionData.comment,
        total.total,
        total.total_hidden,
        total.total_sub || 0,
        JSON.stringify(positionData.jsonShort),
        parseInt(positionData.id)
    ]
    const response = await updateQuery(query, values);
    log(response)
    return response
}


async function deletePosition(positionId) {
    const query = "DELETE FROM order_item WHERE id like ?";
    const response = await deleteQuery(query, positionId);
    return response;
}


async function getAppVersion(group, nodeVer) {
    log(nodeVer, "VERSION NODE @@@@@@@@@@@@@@@@")
    const nodes = {
        'dev': 'version_dev',
        'archive': 'version_archive',
        'test': 'version_string',
        'prod': 'version_string'
    }
    const connection = await connetToDb();
    await connection.connect();
    const table = nodes[nodeVer] || 'version_string';
    const query = `SELECT ${table} as version_string FROM app_version WHERE asort_group LIKE ?`;
    const [rows, fields] = await connection.query(query, group)
    log(rows, group)
    try {

        if (rows.length == 0) {
            const defaultVer = `SELECT ${table} as version_string from app_version where id = 1`
            const res = await connection.query(defaultVer)
            const insertQuery = `INSERT into app_version (asort_group,version_string,version_archive,version_dev) VALUES (?,?,?,?)`
            const response = await connection.query(insertQuery, [group, res[0][0].version_string, res[0][0].version_string, res[0][0].version_string])
            const getVer = `SELECT ${table} as version_string FROM app_version WHERE id LIKE ?`;
            const [ver, fields] = await connection.query(getVer, response[0].insertId)
            await connection.end();
            log(ver[0].version_string, "WERSJA")
            return ver[0].version_string;
        }
        await connection.end();
        return rows[0].version_string;
    }
    catch (err) {
        await connection.end();
        log(err);
        return false;
    }
}


async function updateAppVersion(version, groupNr, nodeVer) {
    log(nodeVer, "VERSION NODE @@@@@@@@@@@@@@@@")
    const nodes = {
        'dev': 'version_dev',
        'archive': 'version_archive',
        'test': 'version_string',
        'prod': 'version_string'
    }
    const table = nodes[nodeVer] || 'version_string';

    const connection = await connetToDb();
    await connection.connect();
    const query = `UPDATE app_version SET ${table}  = ? where asort_group = ?`
    try {
        const response = await connection.query(query, [version, groupNr])

        if (response[0].affectedRows == 0) {
            const insertQuery = `INSERT into app_version (asort_group,${table},version_archive,version_dev) VALUES (?,?,?,?)`
            const res = await connection.query(insertQuery, [groupNr, version, version, version])

        }

        await connection.end();
        return response;

    }
    catch (err) {
        await connection.end();
        log(err);
        return false;
    }
}


async function getFormVersion(groupNr) {
    const query = `select ver from order_item where asortment_group_number = ? order by id desc limit 1`

    let response = await selectQuery(query, groupNr);

    return response[0];
}


async function checkFavoriteExists(userId, productValue, groupNumber) {
    const sql = `
    SELECT 1
    FROM user_favorites 
    WHERE user_id = ${userId} 
      AND product_value = '${productValue}' 
      AND group_number = ${groupNumber}
  `;
    const result = await selectQuery(sql, [userId, productValue, groupNumber]);
    log(result)
    if (result) {
        log('Favorite exists');
        return true
    }
    else {
        log('Favorite does not exist');
        return false
    }

}


async function getFavs(userId, groupNumber) {
    const sql = `
    select * from user_favorites
    WHERE user_id = ${userId}
    and group_number = ${groupNumber}`;
    return selectQuery(sql);
}


async function addFavorite(userId, productValue, groupNumber) {
    const sql = `
    INSERT INTO user_favorites (user_id, product_value, group_number)
    VALUES (?, ?, ?)
  `;
    return insertQuery(sql, [userId, productValue, groupNumber]);
}


async function removeFavorite(userId, productValue, groupNumber) {
    const sql = `
    DELETE FROM user_favorites WHERE user_id = ${userId} AND product_value = '${productValue}' AND group_number = ${groupNumber}
  `;
    return deleteQuery(sql);
}


async function duplicateSendAddress(id) {
    const selectQueryStr = `
        SELECT * FROM send_address WHERE id = ?
    `;
    const response = await selectQuery(selectQueryStr, id);
    if (response.length > 0) {
        const { id, ...data } = response[0];
        log(data, 'DATA TO DUPLICATE')
        const newId = await insertQuery(`INSERT INTO send_address (
  street,
  city,
  zip,
  country,
  phone,
  email,
  user_id,
  name) values (?, ?, ?, ?, ?, ?, ?, ?);`,
            [
                data.street,
                data.city,
                data.zip,
                data.country,
                data.phone,
                data.email,
                data.user_id,
                data.name
            ])
        return newId[0].insertId;
    }
    return null;
}


async function movePositionUp(positionId) {
    try {
        const currentPosition = await selectQuery('SELECT order_id, id FROM order_item WHERE id = ?', [positionId]);
        if (!currentPosition.length) return { success: false, message: 'Position not found' };

        const { order_id } = currentPosition[0];

        const abovePosition = await selectQuery(
            'SELECT id FROM order_item WHERE order_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
            [order_id, positionId]
        );

        if (!abovePosition.length) return { success: false, message: 'Already at top' };

        const tempId = -Math.abs(positionId) - Math.abs(abovePosition[0].id);

        await updateQuery('UPDATE order_item SET id = ? WHERE id = ?', [tempId, positionId]);
        await updateQuery('UPDATE order_item SET id = ? WHERE id = ?', [positionId, abovePosition[0].id]);
        await updateQuery('UPDATE order_item SET id = ? WHERE id = ?', [abovePosition[0].id, tempId]);

        await reindexOrderPositions(order_id);

        return { success: true, message: 'Position moved up' };
    } catch (error) {
        log('Error moving position up:', error);
        return { success: false, message: 'Database error' };
    }
}


async function setPositionIdx(positionId, newIdx) {
    try {
        await updateQuery('UPDATE order_item SET orderpos = ? WHERE id = ?', [newIdx, positionId]);
        return { success: true, message: 'Position index updated' };
    } catch (error) {
        log('Error updating position index:', error);
        return { success: false, message: 'Database error' };
    }
}


async function movePositionDown(positionId) {
    try {
        const currentPosition = await selectQuery('SELECT order_id, id FROM order_item WHERE id = ?', [positionId]);
        if (!currentPosition.length) return { success: false, message: 'Position not found' };

        const { order_id } = currentPosition[0];

        const belowPosition = await selectQuery(
            'SELECT id FROM order_item WHERE order_id = ? AND id > ? ORDER BY id ASC LIMIT 1',
            [order_id, positionId]
        );

        if (!belowPosition.length) return { success: false, message: 'Already at bottom' };

        const tempId = -Math.abs(positionId) - Math.abs(belowPosition[0].id);

        await updateQuery('UPDATE order_item SET id = ? WHERE id = ?', [tempId, positionId]);
        await updateQuery('UPDATE order_item SET id = ? WHERE id = ?', [positionId, belowPosition[0].id]);
        await updateQuery('UPDATE order_item SET id = ? WHERE id = ?', [belowPosition[0].id, tempId]);
        await reindexOrderPositions(order_id);

        return { success: true, message: 'Position moved down' };
    } catch (error) {
        log('Error moving position down:', error);
        return { success: false, message: 'Database error' };
    }
}

async function setLinkGroup(positionIds, linkGroupId) {
    if (!positionIds || positionIds.length === 0) return;
    const placeholders = positionIds.map(() => '?').join(',');
    const query = `UPDATE order_item SET link_group = ? WHERE id IN (${placeholders})`;
    return await updateQuery(query, [linkGroupId, ...positionIds]);
}

async function clearLinkGroup(positionIds) {
    if (!positionIds || positionIds.length === 0) return;
    const placeholders = positionIds.map(() => '?').join(',');
    const query = `UPDATE order_item SET link_group = NULL WHERE id IN (${placeholders})`;
    return await updateQuery(query, positionIds);
}

/**
 * Zapisuje szacowany termin produkcji POZYCJI (`order_item.prod_days`).
 *
 * Liczy go `services/productionDays.js` razem z `order.max_prod_days` — ta sama
 * wartość, którą widać w wierszu „Termin produkcji" pod pozycją. Zapis idzie
 * jednym zapytaniem na pozycję, bo mapa jest mała (pozycje jednego zamówienia).
 * `null` jest poprawną wartością: znaczy „brak danych grupy asortymentowej",
 * i musi nadpisać poprzedni wynik, żeby po zmianie konfiguracji nie zostawał
 * nieaktualny termin.
 *
 * @param {Record<string|number, number|null>} daysByItemId
 * @returns {Promise<void>}
 */
async function updateItemsProdDays(daysByItemId) {
    const entries = Object.entries(daysByItemId || {});
    if (entries.length === 0) return;
    const query = 'UPDATE order_item SET prod_days = ? WHERE id = ?';
    for (const [itemId, days] of entries) {
        try {
            await updateQuery(query, [days == null ? null : days, itemId]);
        } catch (err) {
            log(err);
        }
    }
}

module.exports = {
    insertNewForm,
    updateItemsProdDays,
    getPosition,
    getLastChoice,
    updatePosition,
    deletePosition,
    getAppVersion,
    updateAppVersion,
    getFormVersion,
    checkFavoriteExists,
    addFavorite,
    getFavs,
    duplicateSendAddress,
    removeFavorite,
    movePositionUp,
    movePositionDown,
    updateOrderPrice,
    updateOrderpos,
    getPosCounter,
    getOrderpos,
    reindexOrderPositions,
    updateAttachments,
    setPositionIdx,
    getAttachments,
    setLinkGroup,
    clearLinkGroup
}