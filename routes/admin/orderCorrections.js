const express = require('express');
const router = express.Router();
const { requireLogin } = require('../../middleware/loginMixture');
const { loadEmployeePermissions, filterPriceData } = require('../../middleware/employeePermissions');
const correctionsDb = require('../../db/admin/orderCorrections.js');
const db = require('../../db/db_helper.js');
const ownerService = require('../../services/owner.js');
const orderService = require('../../services/orderService.js');
const orderCorrectionService = require('../../services/admin/orderCorrectionService.js');
const { recalcAndSaveMaxProdDays, buildItemProductionDays, getOrderDeliveryDelay } = require('../../services/productionDays');
const { getPriceAfterDiscount } = require('../../services/getDiscount.js');
const { getProductionSendSkipClient } = require('../../utils/productionSendGuard');
const { orderHasSubPrices, calcSubTotals, resolveSubPricePdfView } = require('../../services/subPrices');
const { availabeLanguages } = require('../../config');
const { log } = require('../../utils/logging');
const { currencyLocalsForOrder } = require('../../services/currency');

function isJsonRequest(req) {
    if (req.method !== 'GET') return true;
    if (req.xhr) return true;
    const accept = req.headers.accept || '';
    return accept.includes('application/json');
}

function respondForbidden(req, res, message = 'Brak uprawnień.') {
    if (isJsonRequest(req)) {
        return res.status(403).json({ success: false, message });
    }
    return res.status(403).render('no-permission.njk');
}

function respondNotFound(req, res, message) {
    if (isJsonRequest(req)) {
        return res.status(404).json({ success: false, message });
    }
    return res.status(404).render('error.njk', { message });
}

function respondServerError(req, res, message = 'Błąd serwera') {
    if (isJsonRequest(req)) {
        return res.status(500).json({ success: false, message });
    }
    return res.status(500).render('error.njk', { message });
}

function requireAdmin(req, res, next) {
    if (!req.session.user?.isAdmin) {
        return respondForbidden(req, res);
    }
    next();
}

async function requireCorrectionOrder(req, res, next) {
    try {
        const meta = await correctionsDb.getCorrectionOrderMeta(req.params.orderId);
        if (!meta || meta.status !== 'correction') {
            return respondNotFound(req, res, 'Zamówienie nie jest otwarte do korekty.');
        }
        req.correctionMeta = meta;
        next();
    } catch (err) {
        log('requireCorrectionOrder error:', err);
        return respondServerError(req, res);
    }
}

router.use(requireLogin, requireAdmin);

router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
        const [sentResult, inCorrection] = await Promise.all([
            correctionsDb.searchSentOrders({ query: q, page, limit: 25 }),
            correctionsDb.listOrdersInCorrection({ page: 1, limit: 10 })
        ]);

        res.render('admin/order_corrections/index.njk', {
            orders: sentResult.orders,
            inCorrection: inCorrection.orders,
            q,
            page: sentResult.page,
            totalPages: sentResult.totalPages,
            total: sentResult.total
        });
    } catch (error) {
        log('Error loading order corrections list:', error);
        res.status(500).render('error.njk', { message: 'Błąd ładowania modułu korekt' });
    }
});

router.post('/:orderId/open', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const meta = await correctionsDb.getCorrectionOrderMeta(orderId);
        if (!meta) {
            return res.status(404).json({ success: false, message: 'Nie znaleziono zamówienia.' });
        }
        if (meta.status === 'correction') {
            return res.json({ success: true, redirect: `/admin/order-corrections/${orderId}` });
        }
        if (meta.status !== 'sent') {
            return res.status(400).json({ success: false, message: 'Korekta możliwa tylko dla wysłanych zamówień.' });
        }

        const opened = await correctionsDb.openOrderForCorrection(orderId);
        if (!opened) {
            return res.status(400).json({ success: false, message: 'Nie udało się otworzyć zamówienia do korekty.' });
        }

        await ownerService.setContextUserByIdent(req, meta.user_ident);
        log(`Order ${orderId} opened for correction by admin ${req.session.user?.pin || '?'}`);

        return res.json({ success: true, redirect: `/admin/order-corrections/${orderId}` });
    } catch (error) {
        log('Error opening order for correction:', error);
        return res.status(500).json({ success: false, message: 'Błąd serwera' });
    }
});

router.get('/:orderId', requireCorrectionOrder, loadEmployeePermissions, filterPriceData, async (req, res) => {
    try {
        const orderId = req.params.orderId;
        await ownerService.setContextUserByIdent(req, req.correctionMeta.user_ident);

        const { orderDetails, orderItems } = await db.getOrderWithItems(orderId);
        const clientDiscount = await getPriceAfterDiscount(orderId);
        const currentUser = ownerService.getCurrentUser(req);
        const groupOrderShop = orderDetails?.group_user_id ? await db.getGroupUserById(orderDetails.group_user_id) : null;
        const productionOrderOverrideClient = getProductionSendSkipClient(currentUser, [groupOrderShop, orderDetails]);
        const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};

        if (!orderItems || orderItems.length === 0) {
            return res.render('admin/order_corrections/workspace.njk', {
                orderDetails,
                cleanOrderItems: [],
                correctionMode: true,
                admin: true
            });
        }

        const heads = Object.keys(orderItems[0].json_parameters);
        let { cleanOrderItems, total } = await orderService.jsonTextBackToMap(orderItems);
        const totalPrice = await db.getTotal(orderDetails.id);
        await db.syncTotalPriceIfMissing(orderDetails.id, totalPrice, req.__('order.total'), req.__('order.total_hidden'));
        const { itemProductionDays, maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes, await getOrderDeliveryDelay(req.params.orderId));
        const hasSubPrices = orderHasSubPrices(cleanOrderItems);
        const subTotals = calcSubTotals(orderItems);
        totalPrice.subVisible = subTotals.subVisible;
        totalPrice.subLocked = subTotals.subLocked;
        const { isClientView, showBoth: showBothInPdf } = resolveSubPricePdfView(req, hasSubPrices);

        res.render('admin/order_corrections/workspace.njk', {
            orderDetails,
            orderItems,
            heads,
            cleanOrderItems,
            discount: clientDiscount,
            total,
            totalPrice,
            availableLanguages: availabeLanguages,
            admin: true,
            correctionMode: true,
            itemProductionDays,
            maxProdDays,
            showProductionOrderOverride: !!productionOrderOverrideClient,
            productionOrderOverrideClient,
            hidePrices: false,
            hasSubPrices,
            prices: req.session.user?.showPrices || false,
            clientView: isClientView,
            showBoth: showBothInPdf,
            isEmployee: false,
            isGroup: false,
            isGroupShop: false,
            showSub: false
        });
    } catch (error) {
        log('Error loading correction workspace:', error);
        res.status(500).render('error.njk', { message: 'Błąd ładowania widoku korekty' });
    }
});

router.get('/:orderId/positions-data', requireCorrectionOrder, async (req, res) => {
    try {
        const { orderItems } = await db.getOrderWithItems(req.params.orderId);
        if (!orderItems || orderItems.length === 0) {
            return res.json({ success: true, positions: [] });
        }

        const positions = orderItems.map(item => ({
            id: item.id,
            order_id: item.order_id,
            ver: item.ver,
            asortment_group_number: item.asortment_group_number,
            json_parameters: item.json_parameters,
            json_parameters_desc: item.json_parameters_desc,
            comment: item.comment || '',
            commision: item.commision || '',
            lang: item.lang || 'pl'
        }));

        // Waluta klienta zamówienia — jak w routes/orders.js (positions-data);
        // recalculateOrder.js ustawia z niej `window.priceCurrency`.
        const { priceCurrency } = await currencyLocalsForOrder(req.params.orderId);

        return res.json({ success: true, positions, priceCurrency });
    } catch (err) {
        log('Error fetching correction positions:', err);
        return res.status(500).json({ success: false, message: 'Błąd serwera' });
    }
});

router.post('/:orderId/recalculate', requireCorrectionOrder, async (req, res) => {
    try {
        const { positions } = req.body;
        if (!Array.isArray(positions) || positions.length === 0) {
            return res.status(400).json({ success: false, message: 'Brak pozycji do zapisu' });
        }

        for (const pos of positions) {
            if (!pos.id || !pos.jsonValues || !pos.jsonValuesToDisplay || !pos.total) {
                return res.status(400).json({
                    success: false,
                    message: `Niepełne dane pozycji ${pos.id || '(brak id)'}`
                });
            }
        }

        const saved = [];
        for (const pos of positions) {
            const positionData = {
                id: pos.id,
                commission: pos.commission || '',
                jsonValues: pos.jsonValues,
                jsonValuesToDisplay: pos.jsonValuesToDisplay,
                comment: pos.comment || '',
                jsonShort: pos.jsonShort || {}
            };
            await db.updatePosition(positionData, pos.total);
            saved.push(pos.id);
        }

        await recalcAndSaveMaxProdDays(req.params.orderId);

        return res.json({
            success: true,
            message: `Przeliczono ${saved.length} pozycji`,
            recalculatedIds: saved
        });
    } catch (err) {
        log('Error recalculating correction order:', err);
        return res.status(500).json({ success: false, message: 'Błąd serwera podczas zapisu przeliczonych pozycji' });
    }
});

router.post('/:orderId/submit', requireCorrectionOrder, async (req, res) => {
    try {
        const result = await orderCorrectionService.submitCorrection(req, req.params.orderId, req.body.prices);
        return res.status(result.success ? 200 : (result.status || 500)).json(result);
    } catch (err) {
        log('Error submitting order correction:', err);
        return res.status(500).json({ success: false, message: 'Błąd serwera podczas wysyłki korekty' });
    }
});

router.post('/:orderId/cancel', async (req, res) => {
    try {
        const result = await orderCorrectionService.cancelCorrection(req, req.params.orderId);
        return res.status(result.success ? 200 : (result.status || 500)).json(result);
    } catch (err) {
        log('Error cancelling order correction:', err);
        return res.status(500).json({ success: false, message: 'Błąd serwera podczas anulowania korekty' });
    }
});

module.exports = router;
