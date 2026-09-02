const crypto = require('crypto');
const db = require('../db/db_helper.js');
const authService = require('../services/authService');
const { log } = require('../utils/logging');

const COOKIE_NAME = 'remember_token';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90; // 90 dni

// express-session (MemoryStore) nie przetrwa restartu procesu (`node --watch`
// restartuje go przy każdej zmianie plików). Ten token żyje w MySQL, więc
// pozwala odtworzyć sesję po restarcie bez ponownego logowania - dotyczy
// tylko urządzeń, na których użytkownik zaznaczył "zapamiętaj mnie".
async function restoreFromRememberCookie(req, res, next) {
    try {
        if (req.session.user) return next();

        const token = req.cookies[COOKIE_NAME];
        if (!token) return next();

        const record = await db.getRememberToken(token);
        if (!record) {
            res.clearCookie(COOKIE_NAME);
            return next();
        }

        const password = await db.getDbPassword(record.pin);
        const built = await authService.buildOwnerSession(req, record.pin, password);
        if (built) {
            req.session.mustAcceptRODO = false;
        }
    } catch (err) {
        log('[rememberMe] restore failed:', err.message);
    }
    return next();
}

async function issueRememberCookie(req, res, pin) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + MAX_AGE_MS);
    await db.createRememberToken(token, pin, expiresAt);
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: MAX_AGE_MS,
    });
}

async function clearRememberCookie(req, res) {
    const token = req.cookies[COOKIE_NAME];
    if (token) {
        await db.deleteRememberToken(token);
    }
    res.clearCookie(COOKIE_NAME);
}

module.exports = { restoreFromRememberCookie, issueRememberCookie, clearRememberCookie, COOKIE_NAME };
