const { selectQuery, insertQuery, deleteQuery } = require('./core');
const dateUtils = require('../utils/humanize_date.js');

async function createRememberToken(token, pin, expiresAt) {
    const query = 'INSERT INTO remember_tokens (token, pin, created_at, expires_at) VALUES (?, ?, ?, ?)';
    return await insertQuery(query, [token, pin, dateUtils.getDbTimestamp(), expiresAt]);
}

async function getRememberToken(token) {
    const query = 'SELECT * FROM remember_tokens WHERE token = ? AND expires_at > NOW()';
    const result = await selectQuery(query, [token]);
    return result && result.length > 0 ? result[0] : null;
}

async function deleteRememberToken(token) {
    const query = 'DELETE FROM remember_tokens WHERE token = ?';
    return await deleteQuery(query, [token]);
}

module.exports = { createRememberToken, getRememberToken, deleteRememberToken };
