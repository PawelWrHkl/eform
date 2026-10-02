const express = require('express');
const router = express.Router();
const { requireLogin, requireGroup } = require('../middleware/loginMixture');
const ownerService = require('../services/owner.js');
const db = require('../db/db_helper.js');
const OrderSender = require('../services/sendOrderService');
const { notifyFirstOrderIfApplicable } = require('../services/firstOrderMailer');
const mailBot = require('../services/mailBot/mailBot');
const orderService = require('../services/orderService.js');
const { generatePdf, generateOrderDocuments } = require('../services/mailBot/pdfGenerator');
const { resolveOrderAbPolicy, resolveConfirmationRecipients } = require('../services/confirmationPolicy');
const { translateOrderItems } = require('../services/translationDict/itemTranslator');
const { getExtraAttachments } = require('../services/mailBot/extraAttachments');
const { buildItemProductionDays, recalcAndSaveMaxProdDays } = require('../services/productionDays');
const path = require('path');
const { log } = require('../utils/logging');
const { formatClientLabel } = require('../utils/formatClient');
const { getProductionSendSkipClient, shouldForceProductionSend } = require('../utils/productionSendGuard');
const { groupLabelKey } = require('../services/groupType');
const { setGroupShopContext, clearGroupShopContext, getGroupShopContext } = require('../services/groupContext');
const { isClientGroupType } = require('../services/groupType');
const groupPriceMode = require('../services/groupPriceMode');
const { orderHasSubPrices } = require('../services/subPrices');

// ── Middleware: wszystkie trasy wymagają zalogowania i roli 'group' ──────────

router.use(requireLogin, requireGroup);

router.use((req, res, next) => {
    res.locals.isGroup = req.session?.user?.isGroup || req.session?.context_user?.isGroup || false;
    res.locals.isGroupShop = req.session?.user?.isGroupShop || false;
    next();
});

/**
 * Przełącznik „Samodzielna wysyłka zamówień" z formularza konta
 * (`group_user.send_order_policy`). Formularz zawsze wysyła ukryte `0`, a
 * włączony przełącznik dokłada `1` — odznaczony checkbox nie wysyła nic, więc
 * bez ukrytego pola nie dałoby się odróżnić wyłączenia od braku pola.
 * `undefined` = pola nie było w żądaniu (ustawienia nie ruszamy).
 */
function parseSendOrderPolicy(body) {
    const raw = body?.send_order_policy;
    if (raw === undefined) return undefined;
    return (Array.isArray(raw) ? raw : [raw]).some(v => String(v) === '1');
}

/**
 * Czy klienci TEJ grupy są rozliczani narzutem (`user.group_price_mode = 'markup'`,
 * ustawia admin w /admin/users) — wtedy formularz i panel pokazują „Narzut"
 * zamiast „Rabat". Tryb czytamy z bazy, nie z sesji: zmiana przez admina ma
 * działać od razu, bez ponownego logowania grupy.
 */
async function isMarkupPricing(currentUser) {
    if (!isClientGroupType(currentUser?.groupType)) return false;
    return groupPriceMode.isMarkupMode(await groupPriceMode.getGroupPriceMode(currentUser.userId));
}

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
        const markupPricing = await isMarkupPricing(currentUser);
        return res.render('group/shop_form.njk', { shop: null, mode: 'new', sendOrderPolicy: false, isMarkupPricing: markupPricing, ...preview });
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
        const sendOrderPolicy = parseSendOrderPolicy(req.body) === true;
        const markupPricing = await isMarkupPricing(currentUser);

        if (!password || password.length < 5) {
            return res.render('group/shop_form.njk', {
                shop: req.body,
                mode: 'new',
                ...preview,
                sendOrderPolicy,
                isMarkupPricing: markupPricing,
                error: req.__('group.form_error_password_required')
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (email && !emailRegex.test(email.trim())) {
            return res.render('group/shop_form.njk', {
                shop: req.body,
                mode: 'new',
                ...preview,
                sendOrderPolicy,
                isMarkupPricing: markupPricing,
                error: req.__('group.form_error_email_invalid')
            });
        }

        // Rabat przyjmujemy WYŁĄCZNIE od grupy typu `client` — dla klasycznej
        // grupy ze sklepami pola nie ma w formularzu i nie może wjechać z
        // podrobionego POST-a (patrz services/groupDiscount.js).
        // W trybie narzutu rabatu nie przyjmujemy wcale — pola nie ma w formularzu.
        const acceptsDiscount = isClientGroupType(currentUser.groupType) && !markupPricing;

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
                sendOrderPolicy,
                isMarkupPricing: markupPricing,
                error: req.__(groupLabelKey('form_error_add_shop', currentUser.groupType))
            });
        }

        // Zapisujemy też wyłączenie — domyślna wartość kolumny nie jest
        // gwarantowana przez kod, a nowe konto ma mieć dokładnie to, co wybrano.
        if (result.id) {
            await db.setGroupUserSendOrderPolicy(result.id, sendOrderPolicy);
            // Narzut osobnym zapisem (services/groupPriceMode.js) — tak jak
            // send_order_policy: przed migracją nie może wywrócić zakładania konta.
            if (markupPricing) {
                await groupPriceMode.setGroupUserMarkup(result.id, req.body.markupPercent);
            }
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

        const sendOrderPolicy = await db.getGroupUserSendOrderPolicy(shop.id);
        const markupPricing = await isMarkupPricing(currentUser);
        if (markupPricing) shop.markup_percent = await groupPriceMode.getGroupUserMarkup(shop.id);
        return res.render('group/shop_form.njk', { shop, mode: 'edit', sendOrderPolicy, isMarkupPricing: markupPricing });
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
        // nie ma tego pola) — patrz db/group.js updateGroupUser. W trybie
        // narzutu też go nie ruszamy: rabat ma wrócić nietknięty, gdy admin
        // przełączy grupę z powrotem na rabat.
        const markupPricing = await isMarkupPricing(currentUser);
        const acceptsDiscount = isClientGroupType(currentUser.groupType) && !markupPricing;

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

        const sendOrderPolicy = parseSendOrderPolicy(req.body);
        if (sendOrderPolicy !== undefined) {
            await db.setGroupUserSendOrderPolicy(id, sendOrderPolicy);
        }

        if (markupPricing && req.body.markupPercent !== undefined) {
            await groupPriceMode.setGroupUserMarkup(id, req.body.markupPercent);
        }

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

// ── POST /group/shops/:id/markup ─ szybka zmiana narzutu z panelu ────────────
// Odpowiednik trasy `/discount` dla grupy rozliczanej narzutem — ta sama
// zasada: zwykły formularz HTML i zapis WYŁĄCZNIE narzutu, bez danych adresowych.

router.post('/shops/:id/markup', async (req, res, next) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const id = parseInt(req.params.id, 10);
        const shop = await db.getGroupUserById(id);

        if (!shop || shop.user_id !== currentUser.userId) {
            return res.redirect('/group/panel?tab=shops&error=notfound');
        }
        if (!(await isMarkupPricing(currentUser))) {
            return res.redirect('/group/panel?tab=shops&error=notfound');
        }

        await groupPriceMode.setGroupUserMarkup(id, req.body.markupPercent ?? 0);

        return res.redirect('/group/panel?tab=shops&success=updated');
    } catch (err) {
        log('[group/shops/:id/markup POST] Error:', err);
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

        // Grupa rozliczana narzutem: kolumna „Narzut" zamiast „Rabat".
        const markupPricing = await isMarkupPricing(currentUser);
        if (markupPricing && shops) {
            const markups = await groupPriceMode.getGroupUserMarkupsByParentId(currentUser.userId);
            for (const shop of shops) shop.markup_percent = markups[shop.id] ?? 0;
        }

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
            isMarkupPricing: markupPricing,
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

        // Anulowanego zlecenia nie wysyła żaden tor — produkcja ma już dla
        // niego znacznik `.cancel` (services/orderCancellation.js).
        if (await db.getOrderStatus(orderId) === 'canceled') {
            return res.status(409).json({ success: false, message: req.__('cancel_order.error_order_canceled') });
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

        // Klient wlasnie wyslal swoje PIERWSZE zamowienie — powiadamiamy handel.
        // Idzie dla kazdego klienta, nie tylko objetego rabatem (decyzja z 22.09).
        // Serwis sam pilnuje jednorazowosci (liczy wyslane zamowienia klienta)
        // i nigdy nie rzuca, wiec nie moze przewrocic wysylki zamowienia.
        await notifyFirstOrderIfApplicable(orderId);
        // Termin produkcji per pozycja musi być świeży w chwili wysyłki: JSON na
        // FTP bierze go wprost z `order_item.prod_days`. Przeliczenie odtwarza tę
        // kolumnę także dla zamówień sprzed migracji, gdzie jest jeszcze NULL.
        await recalcAndSaveMaxProdDays(orderId);
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

        // Cofnięcie do `active` odblokowałoby edycję i ponowną wysyłkę
        // anulowanego zlecenia — anulowanie jest nieodwracalne.
        if (await db.getOrderStatus(orderId) === 'canceled') {
            return res.status(409).json({ success: false, message: req.__('cancel_order.error_order_canceled') });
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
