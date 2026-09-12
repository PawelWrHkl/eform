const express = require('express');
const router = express.Router();
const { requireLogin, requireGroup } = require('../middleware/loginMixture');
const ownerService = require('../services/owner.js');
const db = require('../db/db_helper.js');
const OrderSender = require('../services/sendOrderService');
const { notifyFirstOrderIfApplicable } = require('../services/portalUsageDiscountMailer');
const mailBot = require('../services/mailBot/mailBot');
const orderService = require('../services/orderService.js');
const { generatePdf, generateOrderDocuments } = require('../services/mailBot/pdfGenerator');
const { resolveOrderAbPolicy, resolveConfirmationRecipients } = require('../services/confirmationPolicy');
const { translateOrderItems } = require('../services/translationDict/itemTranslator');
const { getExtraAttachments } = require('../services/mailBot/extraAttachments');
const { buildItemProductionDays } = require('../services/productionDays');
const path = require('path');
const { log } = require('../utils/logging');
const { formatClientLabel } = require('../utils/formatClient');
const { getProductionSendSkipClient, shouldForceProductionSend } = require('../utils/productionSendGuard');
const { groupLabelKey } = require('../services/groupType');
const { setGroupShopContext, clearGroupShopContext, getGroupShopContext } = require('../services/groupContext');
const { isClientGroupType } = require('../services/groupType');
const { orderHasSubPrices } = require('../services/subPrices');

// ── Middleware: wszystkie trasy wymagają zalogowania i roli 'group' ──────────

router.use(requireLogin, requireGroup);

router.use((req, res, next) => {
    res.locals.isGroup = req.session?.user?.isGroup || req.session?.context_user?.isGroup || false;
    res.locals.isGroupShop = req.session?.user?.isGroupShop || false;
    next();
});

// ── GET /group/shops ─ lista sklepów ────────────────────────────────────────

router.get('/shops', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const shops = await db.getGroupUsersByParentId(currentUser.userId);
        return res.render('group/shops.njk', {
            shops,
            success: req.query.success,
            error: req.query.error
        });
    } catch (err) {
        log('[group/shops] Error:', err);
        return next(err);
    }
});

// ── GET /group/shops/new ─ formularz dodania sklepu ─────────────────────────

router.get('/shops/new', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const preview = await db.previewNewGroupUser(currentUser.userId);
        return res.render('group/shop_form.njk', { shop: null, mode: 'new', ...preview });
    } catch (err) {
        return next(err);
    }
});

// ── POST /group/shops ─ zapisz nowy sklep ────────────────────────────────────

router.post('/shops', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const { password, street, zip, city, phone, email, tax_id } = req.body;

        const preview = await db.previewNewGroupUser(currentUser.userId);

        if (!password || password.length < 5) {
            return res.render('group/shop_form.njk', {
                shop: req.body,
                mode: 'new',
                ...preview,
                error: req.__('group.form_error_password_required')
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (email && !emailRegex.test(email.trim())) {
            return res.render('group/shop_form.njk', {
                shop: req.body,
                mode: 'new',
                ...preview,
                error: req.__('group.form_error_email_invalid')
            });
        }

        // Rabat przyjmujemy WYŁĄCZNIE od grupy typu `client` — dla klasycznej
        // grupy ze sklepami pola nie ma w formularzu i nie może wjechać z
        // podrobionego POST-a (patrz services/groupDiscount.js).
        const acceptsDiscount = isClientGroupType(currentUser.groupType);

        const result = await db.addGroupUser({
            parentUserId: currentUser.userId,
            password,
            name: (req.body.name || '').trim(),
            street: (street || '').trim(),
            zip: (zip || '').trim(),
            city: (city || '').trim(),
            phone: (phone || '').trim(),
            email: (email || '').trim(),
            taxId: (tax_id || '').trim(),
            discountPercent: acceptsDiscount ? req.body.discountPercent : 0
        });

        if (!result.success) {
            return res.render('group/shop_form.njk', {
                shop: req.body,
                mode: 'new',
                error: req.__(groupLabelKey('form_error_add_shop', currentUser.groupType))
            });
        }

        return res.redirect('/group/panel?tab=shops&success=added');
    } catch (err) {
        log('[group/shops POST] Error:', err);
        return next(err);
    }
});

// ── GET /group/shops/:id/edit ─ formularz edycji ─────────────────────────────

router.get('/shops/:id/edit', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const shop = await db.getGroupUserById(req.params.id);

        if (!shop || shop.user_id !== currentUser.userId) {
            return res.redirect('/group/panel?tab=shops&error=notfound');
        }

        return res.render('group/shop_form.njk', { shop, mode: 'edit' });
    } catch (err) {
        log('[group/shops/:id/edit] Error:', err);
        return next(err);
    }
});

// ── POST /group/shops/:id ─ zapisz edycję ────────────────────────────────────

router.post('/shops/:id', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const id = parseInt(req.params.id, 10);
        const shop = await db.getGroupUserById(id);

        if (!shop || shop.user_id !== currentUser.userId) {
            return res.redirect('/group/panel?tab=shops&error=notfound');
        }

        const { password, street, zip, city, phone, email, tax_id } = req.body;

        // `discountPercent: undefined` = nie ruszaj rabatu (grupa typu `shop`
        // nie ma tego pola) — patrz db/group.js updateGroupUser.
        const acceptsDiscount = isClientGroupType(currentUser.groupType);

        await db.updateGroupUser(id, {
            name: (req.body.name || '').trim(),
            street: (street || '').trim(),
            zip: (zip || '').trim(),
            city: (city || '').trim(),
            phone: (phone || '').trim(),
            email: (email || '').trim(),
            taxId: (tax_id || '').trim(),
            discountPercent: acceptsDiscount ? (req.body.discountPercent ?? 0) : undefined
        });

        if (password && password.trim()) {
            await db.updateGroupUserPassword(id, password.trim());
        }

        return res.redirect('/group/panel?tab=shops&success=updated');
    } catch (err) {
        log('[group/shops/:id POST] Error:', err);
        return next(err);
    }
});

// ── POST /group/shops/:id/discount ─ szybka zmiana rabatu z panelu ───────────
// Osobna, wąska trasa (a nie pełny zapis konta), żeby zmiana rabatu z tabeli
// nie wymagała wchodzenia w formularz i nie przepisywała danych adresowych.
// ⚠️ Zwykły formularz HTML, bez JS-u: panel grupy ma działać także wtedy, gdy
// skrypt się nie wykona (ta sama zasada co przy wylogowaniu w base.njk).

router.post('/shops/:id/discount', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const id = parseInt(req.params.id, 10);
        const shop = await db.getGroupUserById(id);

        if (!shop || shop.user_id !== currentUser.userId) {
            return res.redirect('/group/panel?tab=shops&error=notfound');
        }
        // Rabat należy do modułu grupy typu `client` — grupa ze sklepami nie ma
        // tego pola nawet w widoku, więc trasa też go dla niej nie przyjmuje.
        if (!isClientGroupType(currentUser.groupType)) {
            return res.redirect('/group/panel?tab=shops&error=notfound');
        }

        await db.updateGroupUser(id, {
            name: shop.name || '',
            street: shop.street || '',
            zip: shop.zip || '',
            city: shop.city || '',
            phone: shop.phone || '',
            email: shop.email || '',
            taxId: shop.tax_id || '',
            discountPercent: req.body.discountPercent ?? 0
        });

        return res.redirect('/group/panel?tab=shops&success=updated');
    } catch (err) {
        log('[group/shops/:id/discount POST] Error:', err);
        return next(err);
    }
});

// ── DELETE /group/shops/:id ─ usuń sklep (AJAX) ──────────────────────────────

router.delete('/shops/:id', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const id = parseInt(req.params.id, 10);
        const shop = await db.getGroupUserById(id);

        if (!shop || shop.user_id !== currentUser.userId) {
            return res.status(403).json({ success: false, message: req.__('group.error_forbidden') });
        }

        await db.deleteGroupUser(id);
        return res.status(200).json({ success: true });
    } catch (err) {
        log('[group/shops DELETE] Error:', err);
        return res.status(500).json({ success: false, message: req.__('group.error_server') });
    }
});

// ── Kontekst konta podrzędnego ───────────────────────────────────────────────
// Odpowiednik kontekstu klienta u admina: grupa „wchodzi" w swój sklep/klienta
// i od tej pory widzi jego zamówienia, zakłada je na niego i wysyła jako on.
// ⚠️ `/clear` MUSI stać przed `/:shopId`, inaczej Express dopasuje „clear" jako
// identyfikator i kontekst nigdy by się nie wyłączył.

router.get('/context/clear', async (req, res) => {
    clearGroupShopContext(req);
    return res.redirect(req.query.redirect || '/orders');
});

router.get('/context/:shopId', async (req, res, next) => {
    try {
        const context = await setGroupShopContext(req, req.params.shopId);
        if (!context) {
            return res.redirect('/group/panel?tab=shops&error=notfound');
        }
        return res.redirect(req.query.redirect || '/orders');
    } catch (err) {
        log('[group/context GET] Error:', err);
        return next(err);
    }
});

// ── GET /group/panel ─ unified group management panel ────────────────────────

router.get('/panel', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const tab = req.query.tab || 'shops';
        const sent = req.query.sent === 'true';
        const shopFilterRaw = req.query.shop ? parseInt(req.query.shop, 10) : null;
        const shopFilter = (shopFilterRaw && !Number.isNaN(shopFilterRaw)) ? shopFilterRaw : null;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 20;
        const offset = (page - 1) * limit;

        const [shops, pendingOrders, orders, ordersTotal, shopCounts] = await Promise.all([
            db.getGroupUsersByParentId(currentUser.userId),
            db.getPendingOrdersByParentUserId(currentUser.userId),
            db.getAllShopOrdersByParentUserId(currentUser.userId, limit, offset, sent, shopFilter),
            db.countAllShopOrdersByParentUserId(currentUser.userId, sent, shopFilter),
            db.getOrderCountsByShop(currentUser.userId),
        ]);

        const pendingCount = pendingOrders ? pendingOrders.length : 0;
        const totalPages = Math.ceil(ordersTotal / limit);

        // Find shop ident for filter chip
        let shopFilterIdent = null;
        let shopFilterName = null;
        if (shopFilter && shops) {
            const found = shops.find(s => s.id === shopFilter);
            shopFilterIdent = found ? found.ident : null;
            shopFilterName = found ? (found.name || '') : null;
        }

        return res.render('group/panel.njk', {
            tab,
            shops: shops || [],
            shopCounts: shopCounts || {},
            pendingOrders: pendingOrders || [],
            pendingCount,
            orders: orders || [],
            ordersTotal,
            totalPages,
            page,
            sent,
            shopFilter,
            shopFilterIdent,
            shopFilterName,
            success: req.query.success,
            error: req.query.error,
        });
    } catch (err) {
        log('[group/panel GET] Error:', err);
        return next(err);
    }
});

// ── GET /group/pending-orders ─ oczekujące zamówienia sklepów ─────────────────

router.get('/pending-orders', requireLogin, requireGroup, async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const orders = await db.getPendingOrdersByParentUserId(currentUser.userId);
        return res.render('group/pending_orders.njk', {
            title: req.__('group.pending_page_title'),
            orders,
        });
    } catch (err) {
        log('[group/pending-orders GET] Error:', err);
        return next(err);
    }
});

// ── POST /group/approve-order/:orderId ─ zatwierdź i wyślij ──────────────────

router.post('/approve-order/:orderId', requireLogin, requireGroup, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const orderId = parseInt(req.params.orderId, 10);

        // Weryfikacja: zamówienie należy do jednego ze sklepów tej grupy
        const shop = await db.getGroupUserByOrderId(orderId);
        if (!shop || shop.user_id !== currentUser.userId) {
            return res.status(403).json({ success: false, message: req.__('group.error_forbidden') });
        }

        let extraMail = process.env.EXTRA_MAIL ? process.env.EXTRA_MAIL.split(',') : false;

        let { orderDetails, orderItems } = await db.getOrderDataToSend(orderId);
        if (!orderItems || orderItems.length === 0) {
            return res.status(400).json({ success: false, message: req.__('group.error_empty_order') });
        }

        const statusChanged = await db.changeOrderStatus(orderId, 'sent');
        if (!statusChanged) {
            return res.status(400).json({ success: false, message: req.__('group.error_empty_order') });
        }

        // Nowy klient LUXANGMBH wlasnie wyslal PIERWSZE zamowienie i dostal 1 punkt
        // procentowy rabatu za korzystanie z serwisu — powiadamiamy handel. Serwis sam
        // pilnuje jednorazowosci (liczy wyslane zamowienia klienta) i nigdy nie rzuca,
        // wiec nie moze przewrocic wysylki zamowienia.
        await notifyFirstOrderIfApplicable(orderId);
        ({ orderDetails, orderItems } = await db.getOrderDataToSend(orderId));

        const sender = new OrderSender.OrderSender(req, orderDetails, orderItems);
        const sendData = await sender.init();
        const forceProductionSend = shouldForceProductionSend(req.body?.productionOrder);
        const ignoredProductionClient = getProductionSendSkipClient(orderDetails, shop?.ident, { forceProductionSend });
        await sender.saveToFile({ forceProductionSend });

        if (ignoredProductionClient) {
            log(`Pominięto wysyłkę maila dla klienta z ignore_mail_list.json: ${ignoredProductionClient}`);
            return res.json({ success: true, message: req.__('group.approve_sent_success'), redirect: '/group/panel?tab=pending' });
        }

        const user = await db.getUserData(currentUser.pin);
        const shopLabel = `${shop.name || shop.ident} (id: ${shop.id})`;
        const clientBase = formatClientLabel(user.client_name, user.ident);
        const clientName = `${clientBase} / ${shopLabel}`;
        const photoFile = await db.getUserLogo(currentUser.pin);
        const logoPath = path.join(__dirname, '../img/', photoFile);
        const { cleanOrderItems, total } = await orderService.jsonTextBackToMap(orderItems);
        const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};
        // Zasady potwierdzenia wspólne z panelem i importem — w tym
        // `delivery_delay`, którego ten tor wcześniej NIE uwzględniał.
        const abPolicy = await resolveOrderAbPolicy(orderDetails.id);
        const { maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes, abPolicy.deliveryDelay);
        const attachments = await getExtraAttachments(sender.slopePaths);
        const lang = req.getLocale();
        const mail = await db.getUserMail(currentUser.pin);
        const orderIdx = await db.getUserOrderId(orderId);

        let confirmationEmail;
        if (orderDetails?.contact_info_id) {
            const contactInfo = await db.getMailById(orderDetails.contact_info_id);
            confirmationEmail = contactInfo?.email || shop.email || mail.user_email;
        } else {
            // Brak wybranego kontaktu z listy → preferuj email sklepu group_user
            confirmationEmail = shop.email || mail.user_email;
        }

        // Potwierdzenie w dwóch formatach z jednego renderu: PDF + ten sam dokument HTML
        const withoutPrices = abPolicy.withoutPrices;
        const abLang = abPolicy.abLang;
        const docLang = abLang || lang;
        let docItems = cleanOrderItems;
        if (abLang && abLang !== lang) {
            docItems = await translateOrderItems(orderItems, cleanOrderItems, abLang);
        }
        const { pdf, html: confirmationHtml } = await generateOrderDocuments(orderDetails, docItems, docLang, logoPath, sendData, orderIdx, true, maxProdDays, true, false, false, null, { withoutPrices, hasSubPrices: orderHasSubPrices(docItems) });
        const orgData = await db.getOrgInfo(req.session.user.organization);

        // ⚠️ Wcześniej ten tor na dev/test wysyłał na PRAWDZIWY adres organizacji
        // (zmieniał tylko BCC) — teraz obowiązuje ta sama reguła co w panelu:
        // lokalnie mail idzie na skrzynkę deweloperską, a `client_ab` kieruje
        // potwierdzenie wprost do klienta (tu: adres sklepu grupy).
        const { mainRecipient, bcc } = resolveConfirmationRecipients({
            clientAb: abPolicy.clientAb,
            confirmationEmail,
            organizationEmail: mail.organization_email,
            organizationEmail2: mail.organization_email2,
            extraMail,
            extraAbMail: abPolicy.extraAbMail
        });

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
            bcc,
            { htmlContent: confirmationHtml, abLang }
        );

        return res.json({ success: true, message: req.__('group.approve_sent_success'), redirect: '/group/panel?tab=pending' });
    } catch (err) {
        log('[group/approve-order POST] Error:', err);
        return res.status(500).json({ success: false, message: req.__('group.error_server') });
    }
});

// ── POST /group/reject-order/:orderId ─ odrzuć (cofnij do active) ────────────

router.post('/reject-order/:orderId', requireLogin, requireGroup, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const orderId = parseInt(req.params.orderId, 10);

        const shop = await db.getGroupUserByOrderId(orderId);
        if (!shop || shop.user_id !== currentUser.userId) {
            return res.status(403).json({ success: false, message: req.__('group.error_forbidden') });
        }

        await db.changeOrderStatus(orderId, 'active');
        return res.json({ success: true, message: req.__('group.reject_success'), redirect: '/group/panel?tab=pending' });
    } catch (err) {
        log('[group/reject-order POST] Error:', err);
        return res.status(500).json({ success: false, message: req.__('group.error_server') });
    }
});

// ── GET /group/shop-orders ─ wszystkie zamówienia ze sklepów (dla grupy-matki) ──

router.get('/shop-orders', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const sent = req.query.sent === 'true';
        const limit = 20;
        const offset = (page - 1) * limit;

        const orders = await db.getAllShopOrdersByParentUserId(currentUser.userId, limit, offset, sent);
        const total = await db.countAllShopOrdersByParentUserId(currentUser.userId, sent);
        const totalPages = Math.ceil(total / limit);

        return res.render('group/shop_orders.njk', {
            orders,
            page,
            totalPages,
            total,
            sent
        });
    } catch (err) {
        log('[group/shop-orders GET] Error:', err);
        return next(err);
    }
});

module.exports = router;
