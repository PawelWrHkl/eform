const express = require('express');
const router = express.Router();
const { requireLogin, checkOrderOwnership, requireOwner, isOwner } = require('../middleware/loginMixture');
const { loadEmployeePermissions, requireSendPermission, filterPriceData, filterOrdersByPermission } = require('../middleware/employeePermissions');
const db = require("../db/db_helper.js");
const fs = require('fs');
const adminDb = require("../db/admin/db_helper.js");
const orderService = require('../services/orderService.js');
const ownerService = require('../services/owner.js');
const mailBot = require('../services/mailBot/mailBot');
const path = require('path');
const OrderSender = require("../services/sendOrderService");
const { generatePdf, generateProductionPdf, uploadProductionPdf } = require('../services/mailBot/pdfGenerator');
const { formatClientLabel } = require('../utils/formatClient');
const { buildOrderItemStructure } = require('../services/itemBuilder.js');
const { getPriceAfterDiscount } = require('../services/getDiscount.js');
const { SyncProdStatus, setParcelHref, parseSpeditionNumbers } = require('../services/prodStatus.js');
const { getExtraAttachments } = require('../services/mailBot/extraAttachments');
const { applySubPriceLocals } = require('../services/subPriceContext');
const { log } = require('../utils/logging');
const { availabeLanguages } = require('../config');
const { translateOrderItems } = require('../services/translationDict/itemTranslator');
const { buildItemProductionDays, recalcAndSaveMaxProdDays } = require('../services/productionDays');
const { getProductionSendSkipClient, shouldForceProductionSend } = require('../utils/productionSendGuard');
const { getOrderMutationBlock, shouldRedirectFromActiveOrderView } = require('../utils/orderStatusGuard');
const { resolveVatLocals, vatFeatureEnabled } = require('../services/vatCalculator');

function sentOrderPath(orderId) {
    return `/orders/history/order/${orderId}`;
}

async function isSentOrder(orderId) {
    return (await db.getOrderStatus(orderId)) === 'sent';
}

async function redirectSentOrder(req, res, orderId = req.params.orderId) {
    const redirectInfo = await shouldRedirectFromActiveOrderView(orderId, req.session.user);
    if (redirectInfo?.redirect) {
        res.redirect(redirectInfo.redirect);
        return true;
    }
    return false;
}

async function rejectSentOrderMutation(res, orderId, req) {
    const block = await getOrderMutationBlock(orderId, req?.session?.user);
    if (block) {
        return res.status(403).json(block);
    }
    return null;
}


const {
    orderHasSubPrices,
    calcSubTotals,
    resolveSubPricePdfView,
    buildPdfSendDataTotals
} = require('../services/subPrices');


router.use(async (req, res, next) => {
    res.locals.owner = req.session?.user?.isOwner || false;
    res.locals.admin = req.session?.user?.isAdmin || false;
    res.locals.isEmployee = req.session?.user?.isEmployee || false;
    res.locals.isGroup = req.session?.user?.isGroup || req.session?.context_user?.isGroup || false;
    res.locals.isGroupShop = req.session?.user?.isGroupShop || false;
    res.locals.employeePermissions = req.session?.employeePermissions || null;
    res.locals.priceFactor = req.session?.employeePermissions?.price_factor || 1.0;
    if (req.session?.user?.isOwner) {
        try {
            res.locals.users = await db.getUsersByOwner(req);
        } catch (error) {
            log('Error loading users for owner:', error);
            res.locals.users = [];
        }
    }
    next();
});


router.get('/search', requireLogin, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const page = parseInt(req.query.page) || 1;
        const sent = req.query.sent === 'true';
        const limit = 40;
        const offset = (page - 1) * limit;
        const currentUser = ownerService.getCurrentUser(req);
        const employeeId = req.session.user?.isEmployee ? (req.session.employee?.id ?? null) : null;
        const organization = req.query.organization === 'true'
            ? (req.session.user?.isAdmin ? req.session.user?.organization : req.session.user?.orgId)
            : false;

        const filters = {
            dateFrom:     req.query.dateFrom     || null,
            dateTo:       req.query.dateTo       || null,
            prodStatus:   req.query.prodStatus   || null,
            sentDateFrom: req.query.sentDateFrom || null,
            sentDateTo:   req.query.sentDateTo   || null,
        };

        const [orders, totalOrders] = await Promise.all([
            db.searchUserOrders(currentUser.userId, q, limit, offset, sent, employeeId, organization, filters),
            db.countSearchUserOrders(currentUser.userId, q, sent, employeeId, organization, filters)
        ]);

        // Parse spedition numbers for each order
        if (orders && orders.length > 0) {
            orders.forEach(order => {
                if (order.spedition_numbers) {
                    order.parsedSpeditionNumbers = parseSpeditionNumbers(order.spedition_numbers);
                }
            });
        }

        return res.json({
            orders: orders || [],
            totalOrders: totalOrders || 0,
            totalPages: Math.ceil((totalOrders || 0) / limit),
            page
        });
    } catch (err) {
        log('Search error:', err);
        return res.status(500).json({ orders: [], totalOrders: 0, totalPages: 0, page: 1 });
    }
});

router.get('/edit/:orderId', requireLogin, async (req, res) => {
    if (await redirectSentOrder(req, res)) {
        return;
    }

    const currentUser = ownerService.getCurrentUser(req);
    const orderData = await db.getOrderDetails(req.params.orderId);
    let addr, emails;

    if (req.session.user?.isGroupShop) {
        const shop = await db.getGroupUserById(req.session.user.groupShopId);
        addr = shop ? [{ id: null, name: shop.name || shop.ident, phone: shop.phone || '', street: shop.street || '', city: shop.city || '', zip: shop.zip || '', country: '' }] : [];
        emails = (shop && shop.email) ? [{ id: null, email: shop.email }] : [];
    } else {
        addr = await db.getUserAddresses(currentUser.userId);
        emails = await db.getUserMails(currentUser.userId);
    }

    log('siemanko@@@@ ', orderData)
    res.render('edit_order.njk', {
        orderData: orderData,
        addr: addr,
        emails: emails,
        selectedAddrId: orderData?.delivery_address_id || null,
        selectedMailId: orderData?.contact_info_id || null
    })
})


router.get("/userOrders", requireLogin, requireOwner, async (req, res) => {
    try {
        const { userIdent } = req.query;

        if (!userIdent) {
            delete req.session.context_user;
            return res.redirect('/orders');
        }

        await ownerService.setContextUserByIdent(req, userIdent);

        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const offset = (page - 1) * limit;
        const userId = await db.getUserIdByIdent(userIdent);
        const [orders, totalOrders] = await Promise.all([
            db.getUserOrders(userId, limit, offset),
            db.countUserOrders(userId)
        ]);

        const totalPages = Math.ceil(totalOrders / limit);
        const selectedUser = await db.getUserData(userIdent);

        res.render("orders_owner.njk", {
            orders,
            page,
            limit,
            totalOrders,
            totalPages,
            admin: req.session.user.isAdmin,
            owner: req.session.user.isOwner,
            selectedUser: selectedUser,
            selectedUserIdent: userIdent
        });
    } catch (error) {
        log('Error fetching user orders:', error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
});

router.get("/", requireLogin, loadEmployeePermissions, filterPriceData, filterOrdersByPermission, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    let orders, totalOrders;
    const currentUser = ownerService.getCurrentUser(req);

    if (req.session.user?.isGroupShop) {
        const groupShopId = req.session.user.groupShopId;
        [orders, totalOrders] = await Promise.all([
            db.getGroupShopOrders(groupShopId, limit, offset),
            db.countGroupShopOrders(groupShopId)
        ]);
        const totalPages = Math.ceil(totalOrders / limit);
        return res.render('orders.njk', {
            orders,
            page,
            limit,
            totalOrders,
            totalPages,
            admin: false,
            owner: false,
            isEmployee: false,
            hidePrices: req.hidePrices
        });
    }

    // Filtrowanie zamówień na podstawie uprawnień pracownika (req.orderFilter)
    if (req.orderFilter === null) {
        // Właściciel — widzi wszystkie zamówienia
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset),
            db.countUserOrders(currentUser.userId)
        ]);
    } else if (req.orderFilter.type === 'all') {
        // Pracownik z uprawnieniem can_see_all_orders — widzi wszystkie zamówienia klienta
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset),
            db.countUserOrders(currentUser.userId)
        ]);
    } else if (req.orderFilter.type === 'own') {
        // Pracownik bez uprawnienia — widzi tylko swoje zamówienia
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset, false, false, req.orderFilter.employeeId),
            db.countUserOrders(currentUser.userId, false, false, req.orderFilter.employeeId)
        ]);
    }
    const totalPages = Math.ceil(totalOrders / limit);
    if (req.session.user?.isOwner) {
        res.render("orders_owner.njk", {
            orders,
            page,
            limit,
            totalOrders,
            admin: req.session.user.isAdmin,
            owner: req.session.user.isOwner,
            totalPages,
            hidePrices: req.hidePrices
        });
    }
    else {
        res.render("orders.njk", {
            orders,
            page,
            limit,
            totalOrders,
            totalPages,
            admin: req.session.user.isAdmin,
            owner: req.session.user.isOwner,
            isEmployee: req.session.user?.isEmployee || false,
            hidePrices: req.hidePrices
        });
    }
});


router.get('/organization-orders?:history', requireLogin, requireOwner, async (req, res) => {
    ownerService.clearContextUser(req);
    const page = 1;
    const limit = 10000;
    const offset = 0;
    const history = req.query.history === 'true';
    const userIdent = req.query.userIdent;

    const currentUser = req.session.user;
    const orgId = currentUser.isAdmin ? currentUser.organization : currentUser.orgId;
    let [orders, totalOrders] = [];
    if (history) {
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset, history, orgId),
            db.countUserOrders(currentUser.userId, history, orgId)
        ]);
    } else {
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset, false, orgId),
            db.countUserOrders(currentUser.userId, false, orgId)
        ]);
    }

    // Filter by userIdent if provided
    if (userIdent && orders) {
        orders = orders.filter(o => o.user_ident === userIdent);
        totalOrders = orders.length;
    }
    const totalPages = Math.ceil(totalOrders / limit);

    // Parse spedition numbers for each order
    if (orders && orders.length > 0) {
        orders.forEach(order => {
            if (order.spedition_numbers) {
                order.parsedSpeditionNumbers = parseSpeditionNumbers(order.spedition_numbers);
            }
        });
    }

    if (req.session.user?.isOwner) {
        if (history) {
            // Backfill max_prod_days for orders that don't have it yet
            const ordersToBackfill = (orders || []).filter(o => o.max_prod_days == null && !o.prod_status);
            for (const order of ordersToBackfill) {
                order.max_prod_days = await recalcAndSaveMaxProdDays(order.id);
            }
            res.render('owner/organization_orders_history.njk', {
                orders,
                page,
                limit,
                totalOrders,
                totalPages,
                selectedUserIdent: userIdent || null
            });
            return;
        }
        else {
            res.render('owner/organization_orders.njk', {
                orders,
                page,
                limit,
                totalOrders,
                totalPages
            });
            return;
        }
    }
});


router.get("/history", requireLogin, loadEmployeePermissions, filterPriceData, filterOrdersByPermission, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const currentUser = ownerService.getCurrentUser(req);
    let orders, totalOrders;
    const user = await db.getOwner(currentUser.pin);
    let status = new SyncProdStatus();
    const files = await status.init(user.orgIdent, user.userIdent);

    if (req.session.user?.isGroupShop) {
        const groupShopId = req.session.user.groupShopId;
        [orders, totalOrders] = await Promise.all([
            db.getGroupShopOrders(groupShopId, limit, offset, true),
            db.countGroupShopOrders(groupShopId, true)
        ]);
    }
    // Filtrowanie zamówień na podstawie uprawnień pracownika (req.orderFilter)
    else if (req.orderFilter === null) {
        // Właściciel — widzi wszystkie zamówienia
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset, true),
            db.countUserOrders(currentUser.userId, true)
        ]);
    } else if (req.orderFilter.type === 'all') {
        // Pracownik z uprawnieniem can_see_all_orders — widzi wszystkie zamówienia klienta
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset, true),
            db.countUserOrders(currentUser.userId, true)
        ]);
    } else if (req.orderFilter.type === 'own') {
        // Pracownik bez uprawnienia — widzi tylko swoje zamówienia
        [orders, totalOrders] = await Promise.all([
            db.getUserOrders(currentUser.userId, limit, offset, true, false, req.orderFilter.employeeId),
            db.countUserOrders(currentUser.userId, true, false, req.orderFilter.employeeId)
        ]);
    }

    const totalPages = Math.ceil(totalOrders / limit);
    
    // Parse spedition numbers for each order
    if (orders && orders.length > 0) {
        orders.forEach(order => {
            if (order.spedition_numbers) {
                order.parsedSpeditionNumbers = parseSpeditionNumbers(order.spedition_numbers);
            }
        });

        // Backfill max_prod_days for orders that don't have it yet
        const ordersToBackfill = orders.filter(o => o.max_prod_days == null && !o.prod_status);
        await Promise.all(ordersToBackfill.map(async (order) => {
            order.max_prod_days = await recalcAndSaveMaxProdDays(order.id);
        }));
    }
    
    if (req.session.user?.isOwner) {
        res.render("orders_history_owner.njk", {
            orders,
            page,
            limit,
            totalOrders,
            owner: req.session.user.isOwner,
            isAdmin: req.session.user?.isAdmin || false,
            totalPages,
            hidePrices: req.hidePrices
        });
    }
    else {
        res.render("orders_history.njk", {
            orders,
            page,
            limit,
            totalOrders,
            totalPages,
            owner: req.session.user.isOwner,
            isAdmin: req.session.user?.isAdmin || false,
            isEmployee: req.session.user?.isEmployee || false,
            hidePrices: req.hidePrices
        });
    }

});


router.get('/history/order/:orderId', requireLogin, checkOrderOwnership, loadEmployeePermissions, filterPriceData, async (req, res) => {

    const { orderDetails, orderItems } = await db.getOrderWithItems(req.params.orderId);

    if (orderDetails?.status === 'correction' && !req.session.user?.isAdmin) {
        return res.status(503).render('error.njk', {
            message: 'Zamówienie jest tymczasowo niedostępne — trwa korekta administracyjna.'
        });
    }

    // Sprawdzenie dostępu pracownika do szczegółów zamówienia
    if (req.session.user?.isEmployee &&
        !req.session.employeePermissions?.can_see_all_orders &&
        orderDetails?.employee_id !== req.session.employee?.id) {
        return res.status(403).json({ error: "Brak uprawnień do tego zamówienia" });
    }

    const currentUser = ownerService.getCurrentUser(req);
    let statuses = await db.getUserStatuses(currentUser.ident, orderDetails.order_idx);
    statuses = setParcelHref(statuses);
    const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};

    if (orderItems) {
        const heads = Object.keys(orderItems[0].json_parameters);
        let { cleanOrderItems, total } = await orderService.jsonTextBackToMap(orderItems);
        const totalPrice = await db.getTotal(orderDetails.id)
        await db.syncTotalPriceIfMissing(orderDetails.id, totalPrice, req.__('order.total'), req.__('order.total_hidden'));
        const { itemProductionDays, maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes);
        const hasSubPrices = orderHasSubPrices(cleanOrderItems);
        const subTotals = calcSubTotals(orderItems);
        totalPrice.subVisible = subTotals.subVisible;
        totalPrice.subLocked = subTotals.subLocked;

        if (req.session.user?.showPrices || req.session.user?.showPricesOnce) {
            res.render("order_sent_prices.njk",
                {
                    orderDetails: orderDetails, orderItems: orderItems, heads: heads, cleanOrderItems: cleanOrderItems, total: total, prices: true, totalPrice: totalPrice, statuses: statuses, admin: req.session.user?.isAdmin || false, availableLanguages: availabeLanguages, itemProductionDays, maxProdDays, hidePrices: req.hidePrices, hasSubPrices
                }
            );
            req.session.user.showPricesOnce = false;
            return;
        } else {
            return res.render("order_sent.njk",
                {
                    orderDetails: orderDetails, orderItems: orderItems, heads: heads, cleanOrderItems: cleanOrderItems, total: total, totalPrice: totalPrice, owner: req.session.user.isOwner, statuses: statuses, admin: req.session.user?.isAdmin || false, availableLanguages: availabeLanguages, itemProductionDays, maxProdDays, hidePrices: req.hidePrices, hasSubPrices
                }
            );
        }
    }
    else {
        return res.render('order.njk', { orderDetails: orderDetails[0], hidePrices: req.hidePrices });
    }
});


router.get("/add-order", requireLogin, async (req, res) => {
    const currentUser = ownerService.getCurrentUser(req);

    if (req.session.user?.isGroupShop) {
        const shop = await db.getGroupUserById(req.session.user.groupShopId);
        const shopAddr = shop ? [{
            id: null,
            name: shop.name || shop.ident,
            phone: shop.phone || '',
            street: shop.street || '',
            city: shop.city || '',
            zip: shop.zip || '',
            country: ''
        }] : [];
        const shopEmails = (shop && shop.email) ? [{ id: null, email: shop.email }] : [];
        return res.render("new-order.njk", { addr: shopAddr, emails: shopEmails });
    }

    const addr = await db.getUserAddresses(currentUser.userId);
    const emails = await db.getUserMails(currentUser.userId);
    log(addr, 'USER ADDRESSES IN ADD ORDER VIEW');

    res.render("new-order.njk", { addr: addr, emails: emails });
});


router.get('/order/:orderId/:prices(true|false)?', requireLogin, checkOrderOwnership, loadEmployeePermissions, filterPriceData, async (req, res) => {
    // Admin opening an order directly (not via "Zamówienia klienta" first) has
    // no session.context_user set, so isGroup/canViewSubPrices/viewAsOrganization
    // (services/subPriceContext.js, consumed by templates/order.njk's SUB-total
    // gate `{% if isGroup or canViewSubPrices or viewAsOrganization %}`) all stay
    // false regardless of the order's real owner — the SUB total block is
    // silently skipped even though order.total_price_sub is correctly computed.
    // Auto-resolve context to this order's actual owner (mirrors the admin-redit
    // fix in routes/positions.js) so opening any order shows correct SUB
    // visibility without a separate "switch client" step. applySubPriceLocals
    // ran as global middleware in server.js BEFORE this handler using the old
    // context, so it must be re-run here to refresh res.locals with the
    // corrected one.
    if (req.session.user?.isAdmin) {
        const ownerIdent = await db.getOrderOwnerIdent(req.params.orderId);
        if (ownerIdent && req.session.context_user?.ident !== ownerIdent) {
            await ownerService.setContextUserByIdent(req, ownerIdent);
            applySubPriceLocals(req, res);
        }
    }

    if (await redirectSentOrder(req, res)) {
        return;
    }

    const { orderDetails, orderItems } = await db.getOrderWithItems(req.params.orderId);

    // Sprawdzenie dostępu pracownika do szczegółów zamówienia
    if (req.session.user?.isEmployee &&
        !req.session.employeePermissions?.can_see_all_orders &&
        orderDetails?.employee_id !== req.session.employee?.id) {
        return res.status(403).json({ error: "Brak uprawnień do tego zamówienia" });
    }

    const clientDiscount = await getPriceAfterDiscount(req.params.orderId);
    const currentUser = ownerService.getCurrentUser(req);
    const groupOrderShop = orderDetails?.group_user_id ? await db.getGroupUserById(orderDetails.group_user_id) : null;
    const productionOrderOverrideClient = getProductionSendSkipClient(currentUser, [groupOrderShop, orderDetails]);
    const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};
    if (orderItems) {
        const heads = Object.keys(orderItems[0].json_parameters);
        let { cleanOrderItems, total } = await orderService.jsonTextBackToMap(orderItems);
        const totalPrice = await db.getTotal(orderDetails.id)
        await db.syncTotalPriceIfMissing(orderDetails.id, totalPrice, req.__('order.total'), req.__('order.total_hidden'));
        const { itemProductionDays, maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes);
        const hasSubPrices = orderHasSubPrices(cleanOrderItems);
        const subTotals = calcSubTotals(orderItems);
        totalPrice.subVisible = subTotals.subVisible;
        totalPrice.subLocked = subTotals.subLocked;
        const { isClientView, showBoth: showBothInPdf } = resolveSubPricePdfView(req, hasSubPrices);

        if (req.session.user?.showPrices || req.session.user?.showPricesOnce) {
            res.render('order_prices.njk', {
                orderDetails,
                orderItems,
                heads,
                cleanOrderItems,
                total,
                prices: true,
                isEmployee: req.session.user?.isEmployee || false,
                totalPrice: totalPrice,
                availableLanguages: availabeLanguages,
                admin: req.session.user?.isAdmin || false,
                itemProductionDays,
                maxProdDays,
                showProductionOrderOverride: !!productionOrderOverrideClient,
                productionOrderOverrideClient,
                hidePrices: req.hidePrices,
                hasSubPrices,
                clientView: isClientView,
                showBoth: showBothInPdf
            });
            req.session.user.showPricesOnce = false;
            return;
        } else {
            console.log(cleanOrderItems, 'CLEAN ORDER ITEMS IN ORDER VIEW');
            res.render('order.njk', {
                orderDetails,
                orderItems,
                heads,
                cleanOrderItems,
                discount: clientDiscount,
                total,
                isEmployee: req.session.user?.isEmployee || false,
                isGroup: req.session?.user?.isGroup || req.session?.context_user?.isGroup || false,
                isGroupShop: req.session.user?.isGroupShop || false,
                showSub: req.session.user?.showSubParams || false,
                totalPrice: totalPrice,
                availableLanguages: availabeLanguages,
                admin: req.session.user?.isAdmin || false,
                itemProductionDays,
                maxProdDays,
                showProductionOrderOverride: !!productionOrderOverrideClient,
                productionOrderOverrideClient,
                hidePrices: req.hidePrices,
                hasSubPrices,
                prices: false,
                clientView: isClientView,
                showBoth: showBothInPdf
            });
            return;
        }
    } else {
        res.render('order.njk', { orderDetails, hidePrices: req.hidePrices });
    }
});


router.get('/order/:orderId/discount-info', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        const discountInfo = await getPriceAfterDiscount(req.params.orderId);
        return res.json({
            success: true,
            data: discountInfo
        });
    } catch (error) {
        log('Error fetching discount info:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching discount info'
        });
    }
});


router.get('/order-details/:orderId', requireLogin, checkOrderOwnership, loadEmployeePermissions, filterPriceData, async (req, res) => {
    try {
        const order = await db.getOrderDataToSend(req.params.orderId);
        const { orderDetails, orderItems } = await db.getOrderWithItems(req.params.orderId);
        let { cleanOrderItems, total } = await orderService.jsonTextBackToMap(orderItems);
        const sender = new OrderSender.OrderSender(req, order.orderDetails, order.orderItems);
        await sender.init();
        const sendData = sender.getData();
        const totalPrice = await db.getTotal(order.orderDetails.id);
        await db.syncTotalPriceIfMissing(order.orderDetails.id, totalPrice, req.__('order.total'), req.__('order.total_hidden'));
        const currentUser = ownerService.getCurrentUser(req);
        const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};
        const { maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes);

        // Ukryj dane cenowe gdy pracownik nie ma uprawnienia can_see_prices
        if (req.hidePrices) {
            res.json({ success: true, data: { sendData, totalPrice: null, cleanOrderItems, total: null, maxProdDays } });
        } else {
            res.json({ success: true, data: { sendData, totalPrice, cleanOrderItems, total, maxProdDays } });
        }
    } catch (error) {
        log('Error fetching order details:', error);
        res.status(500).json({ success: false, message: 'Error fetching order details' });
    }
});


router.post('/order/:orderId/set-discount', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        const { discountPercentage, discountValue } = req.body;
        const orderId = req.params.orderId;
        const result = await db.saveDiscount(orderId, discountPercentage, discountValue);
        if (result) {
            return res.json({
                success: true,
                message: 'Rabat został zapisany pomyślnie',
                data: result
            });
        } else {
            return res.status(500).json({
                success: false,
                message: 'Błąd podczas zapisywania rabatu'
            });
        }
    } catch (error) {
        log('Error saving discount:', error);
        return res.status(500).json({
            success: false,
            message: 'Wewnętrzny błąd serwera podczas zapisywania rabatu'
        });
    }
});


router.get('/orderpdf/:orderId/:showPrices?/:short?', requireLogin, checkOrderOwnership, loadEmployeePermissions, filterPriceData, async (req, res) => {
    try {
        const { orderDetails, orderItems } = await db.getOrderWithItems(req.params.orderId);
        const order = await db.getOrderDataToSend(req.params.orderId);

        if (!orderItems || orderItems.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Nie można wygenerować PDF dla pustego zamówienia"
            });
        }

        const heads = Object.keys(orderItems[0].json_parameters);
        let { cleanOrderItems, total } = await orderService.jsonTextBackToMap(orderItems);
        const sender = new OrderSender.OrderSender(req, order.orderDetails, order.orderItems);
        await sender.init();
        const sendData = sender.getData();
        const totalPrice = await db.getTotal(order.orderDetails.id);
        await db.syncTotalPriceIfMissing(order.orderDetails.id, totalPrice, req.__('order.total'), req.__('order.total_hidden'));
        // Employee permission override: if req.hidePrices is set by filterPriceData middleware,
        // prices are hidden regardless of the URL parameter
        const shouldShowPrices = req.hidePrices ? false : req.params.showPrices === 'true';

        // Admin language override for translated PDF
        const isAdmin = req.session.user?.isAdmin;
        const targetLang = (isAdmin && req.query.lang && availabeLanguages.includes(req.query.lang))
            ? req.query.lang
            : null;
        const lang = targetLang || req.getLocale();

        // Translate order items if admin requested a different language
        if (targetLang) {
            cleanOrderItems = await translateOrderItems(orderItems, cleanOrderItems, targetLang);
        }

        // Uzupełnij sendData o sformatowane totale z etykietami językowymi
        const confLang = require('../services/mailBot/conf');
        const i18n = confLang(lang);
        const __ = (key) => i18n.__(key, { locale: lang });

        // Tryb cen PDF — dopasowany do tego, co widzi użytkownik na stronie
        const hasSubPrices = orderHasSubPrices(cleanOrderItems);
        const { isClientView, showBoth: showBothInPdf } = resolveSubPricePdfView(req, hasSubPrices);
        const subTotals = calcSubTotals(orderItems);
        totalPrice.subVisible = subTotals.subVisible;
        totalPrice.subLocked = subTotals.subLocked;

        if (shouldShowPrices) {
            Object.assign(sendData, buildPdfSendDataTotals({
                isClientView,
                showBoth: showBothInPdf,
                orderItems,
                totalPrice,
                translate: __
            }));
        } else {
            // Visible total mirrors page behaviour — always shown; hidden/gold prices excluded
            sendData.total_hidden = null;
            if (isClientView) {
                sendData.total = totalPrice.subVisible && totalPrice.subVisible !== 0
                    ? `${__('order.total')}: ${totalPrice.subVisible}€` : null;
            } else if (totalPrice?.visible && Number(totalPrice.visible) !== 0) {
                sendData.total = `${__('order.total')}: ${totalPrice.visible}€`;
            } else {
                sendData.total = null;
            }
        }

        const currentUser = ownerService.getCurrentUser(req);
        const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};
        const { maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes);
        const photoFile = await db.getUserLogo(currentUser?.pin);
        const logoPath = path.join(__dirname, '../img/', photoFile);
        const isShort = req.params.short === 'true';
        const discountInfo = !shouldShowPrices ? await getPriceAfterDiscount(req.params.orderId) : null;

        let pdfBuffer;

        if (!isShort) {
            // Ujednolicona logika PDF — ten sam template (order-pdf.njk) co w sendMail
            const orderIdx = await db.getUserOrderId(req.params.orderId);
            pdfBuffer = await generatePdf(order.orderDetails, cleanOrderItems, lang, logoPath, sendData, orderIdx, shouldShowPrices, maxProdDays, true, isClientView, showBothInPdf, discountInfo);
        } else {
            // Short PDF — osobny template order_to_print_short.njk
            let logoDataUri = null;
            try {
                if (fs.existsSync(logoPath)) {
                    const logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });
                    logoDataUri = `data:image/png;base64,${logoBase64}`;
                }
            } catch (error) {
                log('Błąd przy odczycie logo:', error);
            }

            const nunjucks = require('nunjucks');

            const env = nunjucks.configure('templates', {
                autoescape: true,
                trimBlocks: true,
                lstripBlocks: true
            });
            env.addGlobal('__', __);
            const { pdfValueParts } = require('../utils/pdfValueParts');
            env.addFilter('pdfValueParts', pdfValueParts);

            const html = env.render('order_to_print_short.njk', {
                orderDetails,
                orderItems,
                heads,
                cleanOrderItems,
                total,
                photoFile,
                logoPath: logoDataUri,
                prices: shouldShowPrices,
                sendData: sendData,
                totalPrice: totalPrice,
                maxProdDays,
                clientView: isClientView,
                showBoth: showBothInPdf,
                hasSubPrices,
                discountInfo,
            });

            const { chromium } = require('playwright');
            const browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage']
            });

            const context = await browser.newContext();
            const page = await context.newPage();

            // Suppress non-critical console messages during PDF generation
            page.on('console', (msg) => {
              // Only log critical errors, not warnings or info about missing resources
              if (msg.type() !== 'error' || !msg.text().includes('net::ERR_NAME_NOT_RESOLVED')) {
                return;
              }
            });

            await page.setContent(html, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            pdfBuffer = await page.pdf({
                format: 'A3',
                landscape: true,
                printBackground: true,
                margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
            });

            await browser.close();
        }

        const fileName = `zamowienie_${orderDetails.id}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);

    } catch (error) {
        log('Błąd generowania PDF:', error);
        res.status(500).json({
            success: false,
            message: "Błąd podczas generowania PDF: " + error.message
        });
    }
});


router.get("/order/:orderId/new-position/", requireLogin, loadEmployeePermissions, filterPriceData, async (req, res) => {
    if (await redirectSentOrder(req, res)) {
        return;
    }

    // VAT rule: domestic sale (organization country == logged-in user's
    // country) uses that country's own rate; cross-border sale is VAT-exempt
    // (0%) — vatReason distinguishes intra-EU reverse-charge from export, for
    // invoice wording. See services/vatCalculator.js.
    // Skipped entirely while the feature is off (config.js `features.vat`) —
    // no locals, so form.njk renders no VAT markup at all.
    const vatLocals = vatFeatureEnabled ? await resolveVatLocals(req) : {};

    res.render("form.njk", { orderId: req.params.orderId, hidePrices: req.hidePrices, ...vatLocals });
});


/**
 * Endpoint dla funkcjonalności "Przelicz wszystkie pozycje".
 * Zwraca pełne dane pozycji potrzebne do rekonstrukcji formularza po stronie klienta.
 * Dostęp: tylko owner/admin, tylko aktywne zamówienia (status != 'sent').
 */
router.get('/order/:orderId/positions-data', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        const isOwnerOrAdmin = req.session.user?.isOwner || req.session.user?.isAdmin;
        if (!isOwnerOrAdmin) {
            return res.status(403).json({ success: false, message: 'Brak uprawnień' });
        }

        if (await isSentOrder(req.params.orderId)) {
            return res.status(400).json({ success: false, message: 'Nie można przeliczać wysłanego zamówienia' });
        }

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

        return res.json({ success: true, positions });
    } catch (err) {
        log('Error fetching positions for recalculate:', err);
        return res.status(500).json({ success: false, message: 'Błąd serwera' });
    }
});


/**
 * Endpoint zapisujący przeliczone pozycje atomowo.
 * Przyjmuje listę pozycji z nowymi wartościami; zapis w transakcji — wszystko albo nic.
 * Dostęp: tylko owner/admin, tylko aktywne zamówienia.
 */
router.post('/order/:orderId/recalculate', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        const isOwnerOrAdmin = req.session.user?.isOwner || req.session.user?.isAdmin;
        if (!isOwnerOrAdmin) {
            return res.status(403).json({ success: false, message: 'Brak uprawnień' });
        }

        if (await isSentOrder(req.params.orderId)) {
            return res.status(400).json({ success: false, message: 'Nie można przeliczać wysłanego zamówienia' });
        }

        const { positions } = req.body;
        if (!Array.isArray(positions) || positions.length === 0) {
            return res.status(400).json({ success: false, message: 'Brak pozycji do zapisu' });
        }

        // Zapis sekwencyjny — atomowo całe zamówienie. Jeśli któraś pozycja zawiedzie,
        // przerywamy i zwracamy błąd. Nie używamy transakcji DB-poziomu (warstwa db_helper
        // nie wspiera transakcji), ale walidacja pre-zapisu minimalizuje ryzyko częściowego stanu.
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
        log('Error recalculating order:', err);
        return res.status(500).json({
            success: false,
            message: 'Błąd serwera podczas zapisu przeliczonych pozycji'
        });
    }
});


router.post('/send/:orderId', requireLogin, checkOrderOwnership, loadEmployeePermissions, requireSendPermission, async (req, res) => {
    // Sklep grupy nie może samodzielnie wysłać — musi zatwierdzić centrala
    if (req.session.user?.isGroupShop) {
        return res.status(403).json({
            success: false,
            message: 'Zamówienie sklepu musi zostać zatwierdzone przez centralę. Użyj opcji „Wyślij do zatwierdzenia".'
        });
    }

    try {
        let extraMail = process.env.EXTRA_MAIL ? process.env.EXTRA_MAIL.split(',') : false;
        const id = req.params.orderId;
        let { orderDetails, orderItems } = await db.getOrderDataToSend(req.params.orderId);

        if (!orderItems || orderItems.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Nie możesz wysłać pustego zamówienia"
            });
        }

        await db.updateOrderPriceOnSend(id, req.body.prices);
        const statusChanged = await db.changeOrderStatus(id, 'sent');
        if (!statusChanged) {
            return res.status(400).json({
                success: false,
                message: "Nie możesz wysłać pustego zamówienia"
            });
        }

        ({ orderDetails, orderItems } = await db.getOrderDataToSend(id));

        const sender = new OrderSender.OrderSender(req, orderDetails, orderItems);
        const sendData = await sender.init()
        const forceProductionSend = shouldForceProductionSend(req.body?.productionOrder);
        const ignoredProductionClient = getProductionSendSkipClient(orderDetails, [], { forceProductionSend });
        await sender.saveToFile({ forceProductionSend });

        if (ignoredProductionClient) {
            log(`Pominięto wysyłkę maila dla klienta z ignore_mail_list.json: ${ignoredProductionClient}`);
            return res.json({ status: "success", message: "Dane zapisane poprawnie", redirect: "/orders/history" });
        }

        const currentUser = ownerService.getCurrentUser(req);
        const user = await db.getUserData(currentUser?.pin)
        const clientName = formatClientLabel(user.client_name, user.ident)
        const photoFile = await db.getUserLogo(currentUser?.pin)
        const logoPath = path.join(__dirname, '../img/', photoFile)
        const heads = Object.keys(orderItems[0].json_parameters);
        let { cleanOrderItems, total } = await orderService.jsonTextBackToMap(orderItems);
        const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};
        const { maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes);
        const attachments = await getExtraAttachments(sender.slopePaths);
        const lang = req.getLocale();
        const mail = await db.getUserMail(currentUser?.pin)
        const orderIdx = await db.getUserOrderId(req.params.orderId)
        let confirmationEmail;
        log(orderDetails?.contact_info_id, 'ORDER DETAILS CONTACT INFO ID @@@@@@@@@@@@@@@@@')
        if (orderDetails?.contact_info_id) {
            const contactInfo = await db.getMailById(orderDetails.contact_info_id);
        // confirmationEmail = contactInfo?.email || mail.user_email;
            confirmationEmail = mail.user_email;
        } else {
            confirmationEmail = mail.user_email;
        }

        const totalPrice = await db.getTotal(id);
        const confLang = require('../services/mailBot/conf');
        const i18n = confLang(lang);
        const __ = (key) => i18n.__(key, { locale: lang });
        const showGoldPrices = currentUser?.orgId != 3;
        // Tryb cen PDF przy wysyłce maila — taki sam jak widok użytkownika
        const hasSubPricesMail = orderHasSubPrices(cleanOrderItems);
        const { isClientView: isClientForPdf, showBoth: showBothForMail } = resolveSubPricePdfView(req, hasSubPricesMail);

        Object.assign(sendData, buildPdfSendDataTotals({
            isClientView: isClientForPdf,
            showBoth: showBothForMail,
            orderItems,
            totalPrice,
            translate: __,
            showGoldPrices
        }));

        const pdf = await generatePdf(orderDetails, cleanOrderItems, lang, logoPath, sendData, orderIdx, true, maxProdDays, showGoldPrices, isClientForPdf, showBothForMail)
        const orgData = await db.getOrgInfo(req.session.user.organization)

        // Główny odbiorca i BCC zależne od środowiska
        let mainRecipient, bccList;
        if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'dev') {
            mainRecipient = 'pawel.woroniecki@hkl.eu';
            bccList = ['krzysztof.krawczyk@hkl.eu'];
        } else {
            mainRecipient = mail.organization_email;
            bccList = [confirmationEmail, mail.organization_email2, extraMail, 'pawel.woroniecki@hkl.eu'].filter(Boolean).flat();
        }

        mailBot.sendMail(
            mainRecipient,
            lang,
            pdf,
            attachments,
            {
                klient: clientName,
                orderNr: orderIdx,
                logoPath: logoPath,
                orderDetails: sendData,
                organization: orgData
            },
            bccList.join(', ')
        );

        // Generuj i wyślij PDF produkcyjny po polsku (fire-and-forget, nie blokuje odpowiedzi)
        translateOrderItems(orderItems, cleanOrderItems, 'pl')
            .then(plItems => generateProductionPdf(orderDetails, plItems, logoPath, orderIdx, clientName))
            .then(prodPdf => uploadProductionPdf(prodPdf, sender.fileName))
            .catch(err => log('Błąd generowania/wysyłki PDF produkcyjnego:', err));

        return res.json({ status: "success", message: "Dane zapisane poprawnie", redirect: "/orders/history" });
    }
    catch (err) {
        log(err);
    }
});


router.post('/copy/:orderId', checkOrderOwnership, requireLogin, async (req, res) => {
    let sendAddress = null;

    const orderId = req.params.orderId;
    const { orderDetails, orderItems } = await db.getOrderWithItems(orderId);
    if (!orderDetails || !orderItems) {
        return res.status(404).json({ status: "error", message: "Nie znaleziono zamówienia" });
    }

    if (orderDetails?.send_address_id) {
        sendAddress = await db.duplicateSendAddress(orderDetails.send_address_id);
    }

    const groupUserId = req.session.user?.isGroupShop ? req.session.user.groupShopId : null;
    const newOrderId = await db.insertNewOrder(orderDetails.commision, orderDetails.delivery_address_id || null, orderDetails.user_id, orderDetails.comment, sendAddress, 0, null, orderDetails.contact_info_id || null, groupUserId);
    if (!newOrderId) {
        return res.status(500).json({ status: "error", message: "Nie udało się skopiować zamówienia" });
    }
    for (const item of orderItems) {
        let body = buildOrderItemStructure(
            newOrderId,
            item.list_price,
            item.dicsount_percentage,
            item.discount,
            item.unit_price,
            item.total_price,
            item.total_price_sub,
            item.name,
            item.commision,
            item.json_parameters,
            item.json_parameters_desc,
            item.amount,
            item.comment,
            item.ver,
            item.asortment_group_number,
            item.lang,
            item.department,
            item.group_name,
            item.parameters_short
        );
        const newItem = await db.insertNewForm(body);
    }
    return res.json({ status: "success", message: "Zamówienie skopiowane poprawnie", redirect: `/orders/order/${newOrderId}` });
});


router.post('/lock', requireLogin, async (req, res) => {
    try {
        let { status } = req.body;
        if (req.session) req.session.user.showPrices = status;
        return res.json({ status: 'success', refresh: true })
    }
    catch (err) {
        log(err);
    }
});

router.post('/toggle-sub', requireLogin, async (req, res) => {
    try {
        if (req.session) req.session.user.showSubParams = !req.session.user?.showSubParams;
        return res.json({ status: 'success', refresh: true });
    } catch (err) {
        log(err);
    }
});


router.post('/save-order', requireLogin, async (req, res) => {
    try {
        let { commission, comment, addrId, mailId, orderSendAddress } = req.body;

        let response
        let sendAddrId = null;

        if (orderSendAddress) {
            response = await db.insertSendAddress(orderSendAddress);
            sendAddrId = response
        }

        const currentUser = ownerService.getCurrentUser(req);
        const groupUserId = req.session.user?.isGroupShop ? req.session.user.groupShopId : null;
        let id = 0;
        if (req.session.user.isEmployee) {
            id = await db.insertNewOrder(commission, addrId, currentUser.userId, comment, sendAddrId, 0, req.session?.employee.id ?? null, mailId, groupUserId);
        }
        else {
            id = await db.insertNewOrder(commission, addrId, currentUser.userId, comment, sendAddrId, 0, null, mailId, groupUserId);
        }
        if (!id) {
            return res.status(500).json({ status: "error", message: "Nie udało się utworzyć zamówienia. Skontaktuj się z administratorem." });
        }
        return res.json({ status: "success", message: "Dane zapisane poprawnie", redirect: `/orders/order/${id}` });
    }
    catch (err) {
        log(err);
    }
});

router.post('/submit-for-approval/:orderId', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        if (!req.session.user?.isGroupShop) {
            return res.status(403).json({ success: false, message: 'Tylko sklep może wysłać zamówienie do zatwierdzenia.' });
        }
        if (!(await db.orderHasItems(req.params.orderId))) {
            return res.status(400).json({ success: false, message: 'Nie możesz wysłać pustego zamówienia.' });
        }
        const submitted = await db.submitOrderForApproval(req.params.orderId);
        if (!submitted) {
            return res.status(400).json({ success: false, message: 'Nie możesz wysłać pustego zamówienia.' });
        }
        return res.json({ success: true, message: 'Zamówienie wysłane do zatwierdzenia przez centralę.', redirect: '/orders' });
    } catch (err) {
        log(err);
        return res.status(500).json({ success: false, message: 'Błąd serwera.' });
    }
});


router.put('/update-order/:orderId', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        const { commission, addrId, mailId, orderSendAddress, comment } = req.body;
        const { orderId } = req.params;
        const sentOrderResponse = await rejectSentOrderMutation(res, orderId, req);
        if (sentOrderResponse) {
            return sentOrderResponse;
        }

        const existingOrder = await db.getOrderDetails(orderId);
        let response = false;
        if (existingOrder) {
            response = await db.updateOrderDetails(orderId, comment, commission, addrId || null, mailId || null, orderSendAddress);
        }
        else {
            return res.status(404).json({ status: "error", message: "Nie znaleziono zamówienia" });
        }

        return res.json({ response: response, redirect: `/orders/order/${orderId}` });
    }
    catch (err) {
        log(err);
    }
})


router.delete('/order/:orderId/delete/', requireLogin, checkOrderOwnership, async (req, res) => {
    const sentOrderResponse = await rejectSentOrderMutation(res, req.params.orderId, req);
    if (sentOrderResponse) {
        return sentOrderResponse;
    }

    let response = await db.deleteOrder(req.params.orderId);
    if (response) {
        return res.status(200).json({
            success: true,
            message: `order.remove_message`
        });
    }
    else {
        return res.status(400).json({
            success: false,
            message: `Nie znaleziono zamówienia`
        })
    }
})


router.patch('/:orderId/comment/update', requireLogin, async (req, res) => {
    const { orderId } = req.params;
    const { comment } = req.body;
    try {
        const orderRows = await db.getOrderDetails(orderId);
        if (!orderRows || orderRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Zamówienie nie istnieje.' });
        }
        await db.updateOrderComment(orderId, comment);

        return res.json({
            success: true,
            data: { orderId: +orderId, comment }
        });
    } catch (err) {
        log('Błąd przy aktualizacji komentarza:', err);
        return res.status(500).json({ success: false, error: 'Wewnętrzny błąd serwera.' });
    }
});


router.get('/clear-context', requireLogin, requireOwner, async (req, res) => {
    try {
        ownerService.clearContextUser(req);
        res.redirect('/orders');
    } catch (err) {
        log('Error clearing context user:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});


// ─── Import Log (user view — own imports only) ───────────────────────────────

const { selectQuery } = require('../db/core');
const { formatLoginTime } = require('../utils/humanize_date.js');

router.get('/import-log', requireLogin, async (req, res) => {
    try {
        const userIdent = req.session.user?.ident || req.session.user?.userIdent || '';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 30;
        const offset = (page - 1) * limit;

        const filters = {
            status: req.query.status || '',
            dateFrom: req.query.dateFrom || '',
            dateTo: req.query.dateTo || '',
            sort: req.query.sort || 'newest'
        };

        let where = 'user_ident = ?';
        const params = [userIdent];

        if (filters.status) {
            where += ' AND status = ?';
            params.push(filters.status);
        }
        if (filters.dateFrom) {
            where += ' AND created_at >= ?';
            params.push(filters.dateFrom);
        }
        if (filters.dateTo) {
            where += ' AND created_at <= ?';
            params.push(filters.dateTo + ' 23:59:59');
        }

        let orderBy = 'created_at DESC';
        if (filters.sort === 'oldest') orderBy = 'created_at ASC';
        else if (filters.sort === 'status') orderBy = 'status ASC, created_at DESC';

        const countRows = await selectQuery(
            `SELECT COUNT(*) as total FROM import_log WHERE ${where}`, params
        );
        const total = countRows ? countRows[0].total : 0;
        const totalPages = Math.ceil(total / limit);

        const logs = await selectQuery(
            `SELECT * FROM import_log WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        ) || [];

        for (const row of logs) {
            row.created_at_formatted = formatLoginTime(row.created_at);
        }

        const pages = [];
        const start = Math.max(1, page - 3);
        const end = Math.min(totalPages, page + 3);
        for (let i = start; i <= end; i++) pages.push(i);

        res.render('user/import_log.njk', { logs, filters, currentPage: page, totalPages, pages });
    } catch (error) {
        log('Error loading user import log:', error);
        res.status(500).render('error.njk', { message: 'Błąd ładowania logów importu' });
    }
});

router.patch('/order/:orderId/link-positions', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        const { positionIds, unlink = false } = req.body;
        if (!Array.isArray(positionIds) || positionIds.length < 2) {
            return res.status(400).json({ success: false, message: 'Zaznacz co najmniej 2 pozycje' });
        }
        const ids = positionIds.map(id => parseInt(id)).filter(id => !isNaN(id));
        if (ids.length < 2) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowe ID pozycji' });
        }
        if (await rejectSentOrderMutation(res, req.params.orderId, req)) return;
        if (unlink) {
            await db.clearLinkGroup(ids);
        } else {
            const { randomUUID } = require('crypto');
            await db.setLinkGroup(ids, randomUUID());
        }
        return res.json({ success: true });
    } catch (err) {
        log('Error linking positions:', err);
        return res.status(500).json({ success: false, message: 'Błąd serwera' });
    }
});

router.put('/order/:orderId/link-groups', requireLogin, checkOrderOwnership, async (req, res) => {
    try {
        const { allIds, groups } = req.body;
        if (!Array.isArray(allIds) || !Array.isArray(groups)) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowe dane' });
        }
        if (await rejectSentOrderMutation(res, req.params.orderId, req)) return;

        const cleanAll = allIds.map(id => parseInt(id)).filter(id => !isNaN(id));
        // reset every position first so removed links are cleared
        if (cleanAll.length) await db.clearLinkGroup(cleanAll);

        const { randomUUID } = require('crypto');
        for (const group of groups) {
            if (!Array.isArray(group)) continue;
            const ids = group.map(id => parseInt(id)).filter(id => !isNaN(id));
            if (ids.length < 2) continue;
            await db.setLinkGroup(ids, randomUUID());
        }
        return res.json({ success: true });
    } catch (err) {
        log('Error saving link groups:', err);
        return res.status(500).json({ success: false, message: 'Błąd serwera' });
    }
});

router.patch('/order/:orderId/toggle-status', requireLogin, async (req, res) => {
    if (!req.session.user?.isAdmin) {
        return res.status(403).json({ success: false, message: 'Brak uprawnień' });
    }
    try {
        const orderId = req.params.orderId;
        const current = await db.getOrderStatus(orderId);
        if (!current) {
            return res.status(404).json({ success: false, message: 'Zamówienie nie istnieje' });
        }
        const newStatus = current === 'sent' ? 'active' : 'sent';
        await db.changeOrderStatus(orderId, newStatus);
        return res.json({ success: true, status: newStatus });
    } catch (error) {
        log('Error toggling order status:', error);
        return res.status(500).json({ success: false, message: 'Błąd serwera' });
    }
});


router.post('/order/:orderId/send-to-production', requireLogin, async (req, res) => {
    if (!req.session.user?.isAdmin) {
        return res.status(403).json({ success: false, message: 'Brak uprawnień' });
    }
    try {
        const orderId = req.params.orderId;
        const ownerIdent = await db.getOrderOwnerIdent(orderId);
        if (!ownerIdent) {
            return res.status(404).json({ success: false, message: 'Nie znaleziono właściciela zamówienia' });
        }
        const user = await db.getUserByIdent(ownerIdent);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Nie znaleziono danych klienta' });
        }
        const lang = await db.getLanguage(user.pin);
        const { sendImportedOrder } = require('../services/orderImport/sendAfterImport');
        const result = await sendImportedOrder({ orderId, user, lang });
        if (result.sent) {
            return res.json({ success: true, message: 'Zamówienie wysłane na produkcję', redirect: `/orders/history/order/${orderId}` });
        }
        if (result.skipped) {
            return res.json({ success: false, message: `Pominięto wysyłkę: ${result.skipped}` });
        }
        return res.status(500).json({ success: false, message: result.error || 'Nie udało się wysłać zamówienia na produkcję' });
    } catch (error) {
        log('Error sending order to production:', error);
        return res.status(500).json({ success: false, message: 'Błąd serwera' });
    }
});


module.exports = router;
