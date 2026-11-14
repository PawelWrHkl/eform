/**
 * Korekta wysłanego zlecenia przez KLIENTA i BIURO (staff) — `/orders/correction`.
 * Admin ma dodatkowo moduł `/admin/order-corrections` (routes/admin/orderCorrections.js);
 * obie ścieżki zapisują i wysyłają korektę tym samym serwisem
 * (services/admin/orderCorrectionService.js: plik `_correction` + mail).
 *
 * Kto (decyzja Pawła 13.11.2026, services/orderCancellation.js `canCorrect`):
 *  • admin i biuro — zawsze,
 *  • klient, owner, grupa, pracownik z `can_send_orders` — tylko gdy produkcja
 *    zlecenia jest poniżej 20% (STATUSPROD ze status.txt, services/prodProgress.js),
 *  • konto podrzędne grupy — nie (nie wysyła samo, więc i nie koryguje).
 *
 * Otwarcie zmienia status `sent` → `correction`; zlecenie edytuje się w zwykłym
 * widoku `/orders/order/:id` (utils/orderStatusGuard.js `canEditCorrection`),
 * a zamiast „Wyślij” są „Wyślij korektę” / „Anuluj korektę” (templates/order.njk).
 */

const express = require('express');
const router = express.Router();
const { requireLogin, checkOrderOwnership } = require('../middleware/loginMixture');
const { loadEmployeePermissions } = require('../middleware/employeePermissions');
const db = require('../db/db_helper.js');
const orderCorrectionService = require('../services/admin/orderCorrectionService.js');
const { canCorrect, isActorBlocked } = require('../services/orderCancellation');
const { clientMayChange } = require('../services/prodProgress');
const { log } = require('../utils/logging');

function actorCtx(req) {
    return {
        sessionUser: req.session?.user,
        sessionEmployee: req.session?.employee,
        employeePermissions: req.session?.employeePermissions
    };
}

/** Rola + postęp produkcji; `req.correctionState` = stan zlecenia z bazy. */
async function requireCorrectionAccess(req, res, next) {
    try {
        const state = await db.getOrderCancellationState(req.params.orderId);
        if (!state) return res.status(404).json({ success: false, message: req.__('order_correction.error_server') });
        const ctx = actorCtx(req);
        if (isActorBlocked(state, ctx) || !canCorrect(ctx, await clientMayChange(state))) {
            return res.status(403).json({ success: false, message: req.__('order_correction.error_locked') });
        }
        req.correctionState = state;
        next();
    } catch (err) {
        log('[orderCorrection] sprawdzenie dostępu:', err);
        res.status(500).json({ success: false, message: req.__('order_correction.error_server') });
    }
}

router.use(requireLogin);

router.post('/:orderId/open', checkOrderOwnership, loadEmployeePermissions, requireCorrectionAccess, async (req, res) => {
    const orderId = req.params.orderId;
    if (req.correctionState.status === 'correction') {
        return res.json({ success: true, redirect: `/orders/order/${orderId}` });
    }
    if (req.correctionState.status !== 'sent' || !(await orderCorrectionService.openCorrection(orderId))) {
        return res.status(409).json({ success: false, message: req.__('order_correction.error_not_sent') });
    }
    log(`[orderCorrection] zlecenie ${orderId} otwarte do korekty przez ${req.session.user?.ident || req.session.user?.pin || '?'}`);
    return res.json({ success: true, redirect: `/orders/order/${orderId}` });
});

router.post('/:orderId/submit', checkOrderOwnership, loadEmployeePermissions, requireCorrectionAccess, async (req, res) => {
    try {
        const result = await orderCorrectionService.submitCorrection(req, req.params.orderId, req.body?.prices);
        if (!result.success) return res.status(result.status || 500).json(result);
        return res.json({ success: true, message: req.__('order_correction.submitted'), redirect: `/orders/history/order/${req.params.orderId}` });
    } catch (err) {
        log('[orderCorrection] wysyłka korekty:', err);
        return res.status(500).json({ success: false, message: req.__('order_correction.error_server') });
    }
});

// Wycofanie korekty bez sprawdzania postępu: klient, który ją otworzył, musi móc
// ją zamknąć także wtedy, gdy produkcja w międzyczasie przekroczyła 20%.
router.post('/:orderId/cancel', checkOrderOwnership, loadEmployeePermissions, async (req, res) => {
    try {
        const result = await orderCorrectionService.cancelCorrection(req, req.params.orderId);
        if (!result.success) return res.status(result.status || 500).json(result);
        return res.json({ success: true, message: req.__('order_correction.aborted'), redirect: `/orders/history/order/${req.params.orderId}` });
    } catch (err) {
        log('[orderCorrection] anulowanie korekty:', err);
        return res.status(500).json({ success: false, message: req.__('order_correction.error_server') });
    }
});

module.exports = router;
