const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireLogin } = require('../middleware/loginMixture');
const ownerService = require('../services/owner.js');
const authService = require('../services/authService');
const db = require('../db/db_helper.js');
const { log } = require('../utils/logging');
const { listCatalogFiles, resolveCatalogFile } = require('../services/catalogFiles');

router.use(requireLogin);

// v1: tylko zwykły user i konto grupy (macierzyste) — oba mają wiersz w
// tabeli `user`, więc `db.getUserData`/`updateUserPasswordByPin` działają
// bez zmian. Sklepy/klienci grupy (`group_user`) i pracownicy mają inne
// tabele i inny zestaw danych — dochodzą jako rozszerzenie tego modułu.
router.use((req, res, next) => {
    if (req.session.user?.isGroupShop || req.session.user?.isEmployee) {
        return res.redirect('/');
    }
    next();
});

router.get('/', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const tab = ['data', 'password', 'catalogs', 'personalization'].includes(req.query.tab)
            ? req.query.tab
            : 'data';
        const user = await db.getUserData(currentUser.pin);
        let catalogs = [];
        if (tab === 'catalogs') {
            const owner = await db.getOwner(currentUser.pin);
            catalogs = listCatalogFiles(owner?.orgIdent);
        }
        return res.render('panel/panel.njk', {
            tab,
            user,
            catalogs,
            success: req.query.success,
            error: req.query.error
        });
    } catch (err) {
        log('[panel] Error:', err);
        return next(err);
    }
});

router.post('/password', async (req, res) => {
    const redirectWith = (params) => res.redirect(`/panel?tab=password&${new URLSearchParams(params)}`);
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!currentPassword || !newPassword || !confirmPassword) {
            return redirectWith({ error: 'missing' });
        }
        if (newPassword.length < 5) {
            return redirectWith({ error: 'too_short' });
        }
        if (newPassword !== confirmPassword) {
            return redirectWith({ error: 'mismatch' });
        }

        const valid = await authService.checkPassword(currentUser.pin, currentPassword);
        if (!valid) {
            return redirectWith({ error: 'wrong_current' });
        }

        const hash = bcrypt.hashSync(newPassword, 12);
        await db.updateUserPasswordByPin(currentUser.pin, hash);

        return redirectWith({ success: '1' });
    } catch (err) {
        log('[panel/password] Error:', err);
        return redirectWith({ error: 'server' });
    }
});

router.get('/catalogs/download/:file', async (req, res) => {
    const currentUser = ownerService.getCurrentUser(req);
    const owner = await db.getOwner(currentUser.pin);
    const full = resolveCatalogFile(owner?.orgIdent, req.params.file);
    if (!full) return res.status(404).send('Nie znaleziono pliku');
    return res.download(full);
});

module.exports = router;
