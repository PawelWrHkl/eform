const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireLogin } = require('../middleware/loginMixture');
const ownerService = require('../services/owner.js');
const authService = require('../services/authService');
const db = require('../db/db_helper.js');
const { log } = require('../utils/logging');
const { listCatalogFiles, resolveCatalogFile } = require('../services/catalogFiles');
const { resolveAudience } = require('../services/pricelists/audience');
const pricelistPdf = require('../services/pricelists/pdf');
const { resolveRegularVatRateForUser } = require('../services/vatCalculator');

/** Cenniki konta z sesji (`resolveAudience`) do zakładki Katalogi; błąd nie psuje panelu. */
async function pricelistsForPanel(req, lang) {
    const audience = resolveAudience(req.session);
    if (!audience) return [];
    try {
        const account = await pricelistPdf.loadAccount(audience.userId);
        return account ? await pricelistPdf.listForAccount(account, audience.priceSet, lang) : [];
    } catch (err) {
        log('[panel] Lista cenników:', err.message);
        return [];
    }
}

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
        let pricelists = [];
        if (tab === 'catalogs') {
            const owner = await db.getOwner(currentUser.pin);
            catalogs = listCatalogFiles(owner?.orgIdent);
            pricelists = await pricelistsForPanel(req, res.locals.locale || 'pl');
        }
        // Licznik na kafelku „Zlecenia anulowane" (routes/orders.js GET /canceled).
        // Awaria licznika nie może zabrać panelu — kafelek pokaże się bez liczby.
        let canceledCount = null;
        try {
            canceledCount = await db.countCanceledOrders({ userId: currentUser.userId });
        } catch (err) {
            log('[panel] Nie udało się policzyć anulowanych zleceń:', err);
        }
        return res.render('panel/panel.njk', {
            tab,
            user,
            catalogs,
            pricelists,
            canceledCount,
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

/**
 * PDF cennika grupy dla konta Z SESJI (klient, a w podglądzie — klient z kontekstu
 * właściciela/admina). W adresie wyłącznie numer grupy i rodzaj: nie da się nim
 * wskazać cudzego konta. Wersja z rabatem — tylko po odblokowaniu kłódki cen.
 */
router.get('/pricelists/:group/:kind', async (req, res) => {
    const { group, kind } = req.params;
    if (!/^\d{1,4}$/.test(group) || !['base', 'rabat'].includes(kind)) return res.status(404).send(res.__('panel.pricelist_not_found'));
    if (kind === 'rabat' && !res.locals.discountPricesUnlocked) return res.status(403).send(res.__('panel.pricelist_discount_locked'));
    const audience = resolveAudience(req.session);
    if (!audience) return res.status(403).send(res.__('panel.pricelist_not_found'));
    try {
        const account = await pricelistPdf.loadAccount(audience.userId);
        if (!account) return res.status(404).send(res.__('panel.pricelist_not_found'));
        const result = await pricelistPdf.getPricelistPdf({
            account,
            priceSet: audience.priceSet,
            groupNumber: group,
            discounted: kind === 'rabat',
            lang: res.locals.locale || 'pl',
            renderHtml: (view) => new Promise((resolve, reject) => {
                res.render('pricelists/pdf.njk', view, (err, html) => (err ? reject(err) : resolve(html)));
            }),
            resolveVat: (acc) => resolveRegularVatRateForUser(acc.id, acc.orgId)
        });
        if (!result.ok) {
            log(`[panel/pricelists] ${account.ident} gr. ${group} ${kind}: ${result.reason}`);
            return res.status(result.status).send(res.__('panel.pricelist_not_found'));
        }
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="${result.fileName}"`);
        return res.send(result.pdf);
    } catch (err) {
        log('[panel/pricelists] Error:', err);
        return res.status(500).send(res.__('panel.pricelist_error'));
    }
});

module.exports = router;
