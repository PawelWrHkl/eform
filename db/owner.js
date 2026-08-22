const { selectQuery, insertQuery, updateQuery, deleteQuery } = require('./core')
const bcrypt = require('bcryptjs');
const dateUtils = require("../utils/humanize_date.js");
const { log } = require('../utils/logging');

async function getUsersByOwner(req) {
    if (!req.session.user?.isOwner) {
        throw new Error("User is not an owner or session is invalid.");
    }
    // log(req.session.user, 'session user in getUsersByOwner');
    let organizationId ;
    if (req.session.user.isAdmin) {
        organizationId = req.session.user.organization;
    }
    else{
        organizationId = req.session.user.orgId;
    }
    console
    const query = `
        SELECT u.client_name, u.ident, u.pin, u.id 
        FROM user u
        INNER JOIN organization o ON u.organization_id = o.id
        WHERE o.id = ?;
    `;
    try {
        const users = await selectQuery(query, [organizationId]);
        return users;
    } catch (error) {
        log("Error fetching users by owner:", error);
        throw error;
    }
}


async function getUserIdByIdent(ident) {
    const query = `
        SELECT u.id 
        FROM user u
        WHERE u.ident = ?;
    `;
    try {
        const user = await selectQuery(query, [ident]);
        return user[0]?.id;
    } catch (error) {
        log("Error fetching users by owner:", error);
        throw error;
    }
}


async function getUserByIdent(ident) {
    const query = `
        SELECT u.id, u.client_name, u.ident, u.pin, u.password, u.organization_id, u.role, u.group_type, o.ident AS org_ident
        FROM user u
        INNER JOIN organization o ON u.organization_id = o.id
        WHERE u.ident = ?;
    `;
    try {
        const user = await selectQuery(query, [ident]);
        log(user, 'user by ident query result');
        return user[0] || null;
    } catch (error) {
        log("Error fetching user by ident:", error);
        throw error;
    }
}


module.exports = {
    selectQuery,
    insertQuery,
    updateQuery,
    deleteQuery,
    getUserIdByIdent,
    getUsersByOwner,
    getUserByIdent
};





