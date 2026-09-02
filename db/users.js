const { selectQuery, insertQuery, updateQuery, deleteQuery } = require('./core')
const dateUtils = require("../utils/humanize_date.js");
const e = require("express");
const bcrypt = require('bcryptjs');
const { log } = require('../utils/logging');


async function getLanguage(pin) {
    const query = 'SELECT country FROM \`user\` WHERE pin = ?'
    let result = await selectQuery(query, pin)
    if (result[0]) {
        log(result[0])
        return result[0].country.toLowerCase();
    }
    else {
        return 'en'
    }
}


async function getFirstLogonInfo(pin) {
    const query = 'SELECT first_login_at from `user` where pin like ?'
    let result = await selectQuery(query, pin)
    return result[0].first_login_at
}


async function getUserByEmployye(pin) {
    const query = `select u.* from user u join employee e on u.id = e.user_id where e.login = ?`;
    let result = await selectQuery(query, [pin])
    return result && result.length > 0 ? result[0] : null;
}


async function uodateFirstLogonInfo(pin) {
    const query = 'UPDATE `user` SET first_login_at = ? WHERE pin LIKE ?'
    const now = dateUtils.getDbTimestamp()
    let result = await updateQuery(query, [now, pin])
    log(result, 'first logon update result')
    return result
}


async function setUserAcceptedRODO(pin) {
    const query = 'UPDATE `user` SET privacy_policy_accepted_at = ? WHERE pin LIKE ?'
    const now = dateUtils.getDbTimestamp()
    log(now, pin, 'now')
    let result = await updateQuery(query, [now, pin])
    log(result)
    return result
}


async function getPolicyState(pin) {
    const query = 'SELECT privacy_policy_accepted_at from `user` where pin like ?'
    let result = await selectQuery(query, pin)
    return result[0].privacy_policy_accepted_at
}


async function insertUserIntousrtble(ident, pin, password) {
    const query = `INSERT INTO eform.usrtblpsswd (ident, pin, password) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE pin = VALUES(pin), password = VALUES(password)`;
    let result = await insertQuery(query, [ident, pin, password]);
    return result;
}

async function getUsersFromUsrtblpsswd(orgId, isAdmin = false) {
    if (isAdmin) {
        const query = `SELECT up.ident, u.pin, up.password,u.email
            FROM eform.usrtblpsswd up
            JOIN eform.\`user\` u ON u.ident = up.ident
            ORDER BY up.ident`;
        return await selectQuery(query);
    }
    const query = `SELECT up.ident, u.pin, up.password, u.email
        FROM eform.usrtblpsswd up
        JOIN eform.\`user\` u ON u.ident = up.ident
        WHERE u.organization_id = ?
        ORDER BY up.ident`;
    return await selectQuery(query, [orgId]);
}

// Strona wyników przeglądania A-Z, z opcjonalnym wyszukiwaniem po ident -
// używana przez /user/org-pwd, gdzie tabela haseł liczy tysiące rekordów i
// renderowanie wszystkich naraz zabija wydajność strony (patrz routes/users.js).
async function getUsersFromUsrtblpsswdPage(orgId, isAdmin, search, limit, offset) {
    const orgFilter = isAdmin ? '' : 'WHERE u.organization_id = ?';
    const searchFilter = search ? `${orgFilter ? 'AND' : 'WHERE'} up.ident LIKE ?` : '';
    const params = [];
    if (!isAdmin) params.push(orgId);
    if (search) params.push(`%${search}%`);

    const countQuery = `SELECT COUNT(*) as total
        FROM eform.usrtblpsswd up
        JOIN eform.\`user\` u ON u.ident = up.ident
        ${orgFilter} ${searchFilter}`;
    const countResult = await selectQuery(countQuery, params);
    const total = countResult && countResult[0] ? countResult[0].total : 0;

    const rowsQuery = `SELECT up.ident, u.pin, up.password, u.email
        FROM eform.usrtblpsswd up
        JOIN eform.\`user\` u ON u.ident = up.ident
        ${orgFilter} ${searchFilter}
        ORDER BY up.ident
        LIMIT ? OFFSET ?`;
    const rows = await selectQuery(rowsQuery, [...params, limit, offset]);
    return { rows: rows || [], total };
}

// Zbiór ograniczony do konkretnych identów (ostatnio używani klienci) -
// z założenia mały (patrz db.getRecentClients), więc bez paginacji.
async function getUsersFromUsrtblpsswdByIdents(orgId, isAdmin, idents, search) {
    if (!idents || idents.length === 0) return [];
    const orgFilter = isAdmin ? '' : 'AND u.organization_id = ?';
    const searchFilter = search ? 'AND up.ident LIKE ?' : '';
    const placeholders = idents.map(() => '?').join(',');
    const params = [...idents];
    if (!isAdmin) params.push(orgId);
    if (search) params.push(`%${search}%`);

    const query = `SELECT up.ident, u.pin, up.password, u.email
        FROM eform.usrtblpsswd up
        JOIN eform.\`user\` u ON u.ident = up.ident
        WHERE up.ident IN (${placeholders}) ${orgFilter} ${searchFilter}
        ORDER BY up.ident`;
    const rows = await selectQuery(query, params);
    return rows || [];
}

async function updatePasswordInUsrtblpsswd(ident, password) {
    const query = `INSERT INTO eform.usrtblpsswd (ident, password) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE password = VALUES(password)`;
    let result = await insertQuery(query, [ident, password]);
    return result;
}


async function getAllOrganizations() {
    const query = 'SELECT * FROM organization'
    let result = await selectQuery(query)
    return result;
}


async function getEmployyeInfo(login) {
    const query = 'select * from employee where login = ?'
    let result = await selectQuery(query, [login])
    return result[0];
}


async function getUserLogo(pin) {
    const query = `select o.photo_path from user u join organization o on u.organization_id = o.id
    where u.pin = ?`;
    let result = await selectQuery(query, pin)
    return result && result.length > 0 ? result[0].photo_path : 'hkl.png';
}

async function getUserPhoto(pin) {
    const query = `SELECT photo FROM \`user\` WHERE pin = ?`;
    const result = await selectQuery(query, [pin]);
    return result && result.length > 0 ? result[0].photo : null;
}


async function getLogo(id) {
    const query = `select photo_path from organization where id = ?`;
    let result = await selectQuery(query, [id])
    return result && result.length > 0 ? result[0].photo_path : 'hkl.png';
}


async function getUserMail(pin) {
    const query = 'select o.email as organization_email,o.email2 as organization_email2,u.email as user_email from `user` u join organization o on u.organization_id = o.id where u.pin = ?';
    let result = await selectQuery(query, pin)
    return result[0];
}


async function logEmployeeLogin(employeeId) {
    const sql = `update employee set last_login = ? where id = ?`;
    const now = dateUtils.getDbTimestamp();
    const result = await updateQuery(sql, [now, employeeId]);
    return result;
}


async function getOwner(pin) {
    const query = `select o.ident as orgIdent, o.id as orgId, u.ident as userIdent from user u join organization o on u.organization_id = o.id
    where u.pin = ?`;
    let result = await selectQuery(query, pin)
    return result[0];
}


async function getOwnerByUserId(userId) {
    const query = `select o.ident as orgIdent, o.id as orgId, u.ident as userIdent from user u join organization o on u.organization_id = o.id
    where u.id = ?`;
    let result = await selectQuery(query, [userId])
    return result && result.length > 0 ? result[0] : null;
}


async function updateUserPasswordByPin(pin, hash) {
    const sql = 'UPDATE eform.`user` SET password = ? WHERE pin = ?';
    const response = await updateQuery(sql, [hash, pin]);
    return response
}


async function getDbPassword(pin) {
    const query = `SELECT password FROM user WHERE pin LIKE ?`;

    try {
        const rows = await selectQuery(query, [pin]);

        if (rows.length > 0) {

            return rows[0].password;
        } else {

            return false;
        }
    } catch (err) {
        await connection.end();
        log(err);
        return false;
    }
}


async function getUserId(pin) {
    const query = `SELECT id FROM user WHERE pin LIKE ?`;
    const result = await selectQuery(query, [pin])

    return result[0].id;
}

async function getUserPinById(id) {
    const query = `SELECT pin FROM \`user\` WHERE id = ?`;
    const result = await selectQuery(query, [id]);
    return result?.[0]?.pin || null;
}


async function getUserIdent(pin) {
    const query = `SELECT ident FROM user WHERE pin LIKE ?`;
    const result = await selectQuery(query, [pin])

    return result[0].ident;
}


async function getUserData(pin) {
    const query = `SELECT * FROM \`user\` WHERE pin LIKE ?`;

    try {
        const rows = await selectQuery(query, [pin])
        return rows[0];
    }
    catch (err) {
        await connection.end();
        log(err);
        return false;
    }
}


async function getUsers() {
    const sql = `
        SELECT
            ident,
            client_name AS name,
            street AS address,
            city,
            zip,
            tax_id AS taxid,
            pin,
            password,
            phone,
            country AS kraj
        FROM eform.\`user\`
    `;
    const result = await selectQuery(sql);

    return result;
}


async function deleteUserByPin(pin) {
    const sql = `DELETE FROM eform.\`user\` WHERE pin = ?`;
    const result = await deleteQuery(sql, [pin]);
    return result;
}


async function getUserName(pin) {
    const query = `SELECT client_name FROM \`user\` WHERE pin LIKE ?`;
    const result = await selectQuery(query, [pin]);
    return result[0].client_name;
}

async function getUserRole(pin) {
    const query = `SELECT role FROM \`user\` WHERE pin LIKE ?`;
    const result = await selectQuery(query, [pin]);
    return result && result.length > 0 ? result[0].role : null;
}

// Odmiana modułu grupowego (kolumna `user.group_type`): `shop` — klasyczna
// grupa ze sklepami/filiami, `client` — grupa zarządzająca własnymi klientami.
// Pusta wartość znaczy „jak dotąd", czyli `shop` — istniejące konta grupowe
// nie mogą zmienić wyglądu panelu tylko dlatego, że kolumna jest NULL.
async function getUserGroupType(pin) {
    const query = `SELECT group_type FROM \`user\` WHERE pin LIKE ?`;
    const result = await selectQuery(query, [pin]);
    return result && result.length > 0 ? result[0].group_type : null;
}



async function addUser(userData) {
    const {
        ident,
        name,
        address,
        city = '',
        zip = '',
        taxid,
        pin,
        country = 'en',
        password,
        phone = '',
        email = '',
        organization_id
    } = userData;

    const escapeApostrophe = (str) => (str || '').replace(/'/g, "''");

    const client_name = escapeApostrophe(name);
    const street = escapeApostrophe(address);
    const tax_id = escapeApostrophe(taxid);
    const escapedIdent = escapeApostrophe(ident);
    const escapedCity = escapeApostrophe(city);
    const escapedZip = escapeApostrophe(zip);
    const escapedCountry = escapeApostrophe(country);

    const hashedPassword = bcrypt.hashSync(password, 12);

    const sql = `
        INSERT INTO eform.\`user\`
        (ident, client_name, street, city, zip, tax_id, pin, password, country, organization_id,phone, email)
        VALUES (
            '${escapedIdent}',
            '${client_name}',
            '${street}',
            '${escapedCity}',
            '${escapedZip}',
            '${tax_id}',
            '${pin}',
            '${hashedPassword}',
            '${escapedCountry}',
            '${organization_id}',
            '${phone}',
            '${email}'
        )
    `;

    try {
        const result = await insertQuery(sql, []);
        return result.insertId;
    } catch (err) {
        throw new Error('Błąd przy dodawaniu użytkownika: ' + err.message);
    }
}


async function updateUser(userPin, email = '', phone = '') {
    const sql = `UPDATE eform.\`user\` set phone = ?, email = ? where pin like ?`;
    const result = await updateQuery(sql, [phone, email, userPin]);
    return result;
}


async function updatePlain(userId, plainPassword) {

    const sql = `UPDATE eform.\`user\` set plain = ? where ident = ?`;
    const result = await updateQuery(sql, [plainPassword, userId]);
    return result;
}

async function getUserAddresses(userId) {

    const query = 'SELECT id, name, phone_number AS phone, street, city, zip, country FROM delivery_address WHERE user_id = ?';
    const addresses = await selectQuery(query, userId);

    return { addresses }
}


async function getEmployeesByUserId(userId) {
    const query = `
        SELECT id, name, surname, last_login, user_id, password, phone, login,
               can_send_orders, can_see_prices, can_see_all_orders, price_factor
        FROM employee 
        WHERE user_id = ?
        ORDER BY surname, name
    `;
    const result = await selectQuery(query, [userId]);
    return result || [];
}


async function getEmployeeById(employeeId) {
    const query = `SELECT * FROM employee WHERE id = ?`;
    const result = await selectQuery(query, [employeeId]);
    return result && result.length > 0 ? result[0] : null;
}


async function getEmployeePermissions(employeeId) {
    const query = `SELECT can_send_orders, can_see_prices, can_see_all_orders, price_factor FROM employee WHERE id = ?`;
    const result = await selectQuery(query, [employeeId]);
    if (result && result.length > 0) {
        return {
            can_send_orders: result[0].can_send_orders,
            can_see_prices: result[0].can_see_prices,
            can_see_all_orders: result[0].can_see_all_orders,
            price_factor: parseFloat(result[0].price_factor) || 1.0
        };
    }
    return null;
}


async function getEmployeeByLogin(login) {
    const query = `SELECT * FROM employee WHERE login = ?`;
    const result = await selectQuery(query, [login]);
    return result && result.length > 0 ? result[0] : null;
}


async function getEmployeePermissionsByLogin(login) {
    const query = `SELECT can_send_orders, can_see_prices, can_see_all_orders, price_factor FROM employee WHERE login = ?`;
    const result = await selectQuery(query, [login]);
    return result && result.length > 0 ? result[0] : null;
}


async function addEmployee(employeeData) {
    const { name, surname, login, password, phone, userId, can_send_orders, can_see_prices, can_see_all_orders } = employeeData;
    log('jestem w addEmployee', employeeData)

    const checkEmployeeQuery = `SELECT id FROM employee WHERE login = ?`;
    const checkUserQuery = `SELECT id FROM eform.\`user\` WHERE pin = ?`;
    const existingEmployee = await selectQuery(checkEmployeeQuery, [login]);
    const existingUser = await selectQuery(checkUserQuery, [login]);
    log('existingEmployee:', existingEmployee);
    log('existingUser:', existingUser);
    if (existingEmployee.length > 0 || existingUser.length > 0) {
        log('Employee already exists or user does not exist');
        return { success: false, info: 'USER_EXISTS' };

    }

    const hashedPassword = bcrypt.hashSync(password, 12);

    const permSendOrders = parseInt(can_send_orders) || 0;
    const permSeePrices = parseInt(can_see_prices) || 0;
    const permSeeAllOrders = parseInt(can_see_all_orders) || 0;

    const sql = `
        INSERT INTO employee (name, surname, login, password, phone, user_id, can_send_orders, can_see_prices, can_see_all_orders)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
        const result = await insertQuery(sql, [name, surname, login, hashedPassword, phone, userId, permSendOrders, permSeePrices, permSeeAllOrders]);
        return { insertId: result.insertId, success: true };
    } catch (err) {
        throw new Error('Błąd przy dodawaniu pracownika: ' + err.message);
    }
}


async function deleteEmployee(employeeId) {
    try {

        const updateSql = `UPDATE \`order\` SET employee_id = NULL WHERE employee_id = ?`;
        await updateQuery(updateSql, [employeeId]);


        const deleteSql = `DELETE FROM employee WHERE id = ?`;
        return await deleteQuery(deleteSql, [employeeId]);
    } catch (error) {
        log('Błąd przy usuwaniu pracownika:', error);
        throw error;
    }
}


async function getEmployeeOrders(employeeId, limit = 50, offset = 0) {
    const query = `
        SELECT 
            o.id,
            o.commision,
            o.created_date,
            o.sent_date,
            o.status,
            o.total_float,
            COUNT(oi.id) as items_count
        FROM \`order\` o
        LEFT JOIN order_item oi ON o.id = oi.order_id
        WHERE o.employee_id = ?
        GROUP BY o.id
        ORDER BY o.created_date DESC
        LIMIT ? OFFSET ?
    `;
    const result = await selectQuery(query, [employeeId, limit, offset]);
    const resultWithHumanizedDates = dateUtils.humanizeData(result);
    return resultWithHumanizedDates || [];
}


async function countEmployeeOrders(employeeId) {
    const query = `SELECT COUNT(*) as total FROM \`order\` WHERE employee_id = ?`;
    const result = await selectQuery(query, [employeeId]);
    return result && result.length > 0 ? result[0].total : 0;
}


async function updateEmployeeLastLogin(employeeId) {
    const sql = `UPDATE employee SET last_login = ? WHERE id = ?`;
    const now = dateUtils.getDbTimestamp();
    const result = await updateQuery(sql, [now, employeeId]);
    return result;
}


async function updateEmployee(employeeId, updatedData) {
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updatedData)) {
        fields.push(`${key} = ?`);
        values.push(value);
    }
    values.push(employeeId);

    const sql = `UPDATE employee SET ${fields.join(', ')} WHERE id = ?`;

    try {
        const result = await updateQuery(sql, values);
        return result;
    } catch (err) {
        throw new Error('Błąd przy aktualizacji pracownika: ' + err.message);
    }
}


async function updateEmployeePermissions(employeeId, permissions) {
    const { can_send_orders, can_see_prices, can_see_all_orders } = permissions;
    const sql = `UPDATE employee SET can_send_orders = ?, can_see_prices = ?, can_see_all_orders = ? WHERE id = ?`;

    try {
        const result = await updateQuery(sql, [can_send_orders, can_see_prices, can_see_all_orders, employeeId]);
        return result;
    } catch (err) {
        log('Błąd podczas zapisywania uprawnień:', err);
        throw new Error('Błąd podczas zapisywania uprawnień');
    }
}


async function updateEmployeePriceFactor(employeeId, priceFactor) {
    const factor = parseFloat(priceFactor);
    if (isNaN(factor) || factor < 0 || factor > 99.99) {
        throw new Error('Nieprawidłowa wartość faktora cen');
    }
    const sql = `UPDATE employee SET price_factor = ? WHERE id = ?`;
    try {
        const result = await updateQuery(sql, [factor, employeeId]);
        return result;
    } catch (err) {
        log('Błąd podczas zapisywania faktora cen:', err);
        throw new Error('Błąd podczas zapisywania faktora cen');
    }
}


async function getOrgInfo(id) {
    const query = 'SELECT * FROM organization where id like ?'
    let result = await selectQuery(query, id)
    return result[0]
}


async function updateUserData(pin, updatedData) {
    const query = 'UPDATE eform.`user` set tax_id = ?, street = ?, zip = ?, city = ?, email = ? WHERE pin = ?';
    let result = await selectQuery(query, [updatedData.tax_id, updatedData.street, updatedData.zip, updatedData.city, updatedData.email, pin]);

}

module.exports = {
    getLanguage,
    getFirstLogonInfo,
    getPolicyState,
    getUserLogo,
    getUserPhoto,
    getOwner,
    updateUserData,
    getOwnerByUserId,
    updateUserPasswordByPin,
    getDbPassword,
    getUserData,
    getUsers,
    addUser,
    getUserId,
    getUserMail,
    updateUser,
    getUserAddresses,
    getUserName,
    setUserAcceptedRODO,
    uodateFirstLogonInfo,
    getUserIdent,
    updateEmployee,
    updateEmployeePermissions,
    updateEmployeePriceFactor,
    getEmployeesByUserId,
    getEmployeeById,
    getEmployeePermissions,
    getEmployeeByLogin,
    getEmployeePermissionsByLogin,
    addEmployee,
    deleteEmployee,
    getEmployeeOrders,
    countEmployeeOrders,
    updateEmployeeLastLogin,
    updatePlain,
    getUserByEmployye,
    getEmployyeInfo,
    getAllOrganizations,
    getLogo,
    deleteUserByPin,
    logEmployeeLogin,
    getOrgInfo,
    insertUserIntousrtble,
    updatePasswordInUsrtblpsswd,
    getUserRole,
    getUserGroupType,
    getUsersFromUsrtblpsswd,
    getUsersFromUsrtblpsswdPage,
    getUsersFromUsrtblpsswdByIdents,
    getIntroNeeded,
    setIntroNeeded,
    enableIntroNeeded,
    getRecentClients,
    saveRecentClient,
    getUserPinById,
}

async function getIntroNeeded(pin) {
    const query = 'SELECT intro_needed FROM `user` WHERE pin = ?';
    const result = await selectQuery(query, [pin]);
    return result && result[0] ? !!result[0].intro_needed : false;
}

async function setIntroNeeded(pin) {
    const query = 'UPDATE `user` SET intro_needed = 0 WHERE pin = ?';
    return await updateQuery(query, [pin]);
}

async function enableIntroNeeded(pin) {
    const query = 'UPDATE `user` SET intro_needed = 1 WHERE pin = ?';
    return await updateQuery(query, [pin]);
}

const RECENT_CLIENTS_MAX = 10;

async function getRecentClients(userId) {
    const query = 'SELECT recent_clients FROM `user` WHERE id = ?';
    const result = await selectQuery(query, [userId]);
    if (!result || !result[0] || !result[0].recent_clients) return [];
    try {
        const parsed = typeof result[0].recent_clients === 'string'
            ? JSON.parse(result[0].recent_clients)
            : result[0].recent_clients;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function saveRecentClient(userId, ident, name) {
    let recent = await getRecentClients(userId);
    recent = recent.filter(u => u.ident !== ident);
    recent.unshift({ ident, name });
    if (recent.length > RECENT_CLIENTS_MAX) recent.length = RECENT_CLIENTS_MAX;
    const query = 'UPDATE `user` SET recent_clients = ? WHERE id = ?';
    return await updateQuery(query, [JSON.stringify(recent), userId]);
}