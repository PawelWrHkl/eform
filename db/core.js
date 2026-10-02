const mysql = require("mysql2/promise.js");
const dateUtils = require("../utils/humanize_date.js");
const e = require("express");
const bcrypt = require('bcryptjs');
const { log } = require('../utils/logging');

const pool = mysql.createPool({
    host: process.env.DATABASE_HOST || '192.168.0.8',
    port: process.env.DATABASE_PORT || '8001',
    user: process.env.DATABASE_USER || 'portal_eform',
    password: process.env.DATABASE_PASSWORD || 'A5q|:4Ny',
    database: process.env.DATABASE || 'eform',
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    connectTimeout: 25000,
});

// Returns a pool connection compatible with the legacy connetToDb() API.
// .connect() is a no-op (pool connections are already connected).
// .end()     releases the connection back to the pool instead of destroying it.
async function connetToDb() {
    const conn = await pool.getConnection();
    conn.connect = () => Promise.resolve();
    conn.end = () => { conn.release(); return Promise.resolve(); };
    return conn;
}

async function selectQuery(query, data = false) {
    try {
        let [rows] = data
            ? await pool.query(query, data)
            : await pool.query(query);
        return rows.length > 0 ? rows : false;
    } catch (err) {
        log('selectQuery error: ' + err);
        return false;
    }
}

async function insertQuery(query, data) {
    try {
        const response = await pool.query(query, data);
        return response;
    } catch (err) {
        log('insertQuery error: ' + err);
        return false;
    }
}

async function updateQuery(query, data) {
    try {
        const [response] = await pool.query(query, data);
        return response;
    } catch (err) {
        log('updateQuery error: ' + err);
        return false;
    }
}

async function deleteQuery(query, data) {
    try {
        const [response] = await pool.query(query, [data]);
        return response.affectedRows ? true : false;
    } catch (err) {
        log('deleteQuery error: ' + err);
        return false;
    }
}



// Dla skryptów jednorazowych (`scripts/prodStatusSync.js`): otwarta pula trzyma
// pętlę zdarzeń, więc bez zamknięcia proces nigdy się nie kończy, a `process.exit()`
// ucina asynchroniczne dopisywanie do pliku logu (`utils/logging`).
async function closePool() {
    await pool.end();
}

module.exports = {
    selectQuery, updateQuery, deleteQuery, insertQuery, connetToDb, closePool
}