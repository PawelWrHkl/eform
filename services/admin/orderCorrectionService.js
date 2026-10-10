const path = require('path');
const db = require('../../db/db_helper.js');
const correctionsDb = require('../../db/admin/orderCorrections.js');
const ownerService = require('../owner.js');
const orderService = require('../orderService.js');
const mailBot = require('../mailBot/mailBot');
const { OrderSender } = require('../sendOrderService');
const { generateOrderDocuments } = require('../mailBot/pdfGenerator');
const { resolveOrderAbPolicy, resolveConfirmationRecipients } = require('../confirmationPolicy');
const { formatClientLabel } = require('../../utils/formatClient');
const { getExtraAttachments } = require('../mailBot/extraAttachments');
const { buildItemProductionDays, recalcAndSaveMaxProdDays } = require('../productionDays');
const { getProductionSendSkipClient, shouldForceProductionSend } = require('../../utils/productionSendGuard');
const {
    orderHasSubPrices,
    resolveSubPricePdfView,
    buildPdfSendDataTotals
} = require('../subPrices');
const { log } = require('../../utils/logging');
const { currencyLocalsForOrder } = require('../currency');

const CORRECTION_FILE_SUFFIX = '-update';

async function ensureCorrectionContext(req, orderId) {
    const meta = await correctionsDb.getCorrectionOrderMeta(orderId);
    if (!meta || meta.status !== 'correction') {
        return { ok: false, status: 404, message: 'Zamówienie nie jest otwarte do korekty.' };
    }
    await ownerService.setContextUserByIdent(req, meta.user_ident);
    return { ok: true, meta };
}

function normalizePrices(prices) {
    return {
        hiddenPrices: Array.isArray(prices?.hiddenPrices) ? prices.hiddenPrices : [],
        visiblePrices: Array.isArray(prices?.visiblePrices) ? prices.visiblePrices : []
    };
}

function clearCorrectionContext(req) {
    if (req?.session?.context_user) {
        delete req.session.context_user;
    }
}

async function submitCorrection(req, orderId, prices) {
    const access = await ensureCorrectionContext(req, orderId);
    if (!access.ok) {
        return { success: false, status: access.status, message: access.message };
    }

    let { orderDetails, orderItems } = await db.getOrderDataToSend(orderId);
    if (!orderItems || orderItems.length === 0) {
        return { success: false, status: 400, message: 'Nie można wysłać korekty pustego zamówienia.' };
    }

    // 1. Najpierw atomowo zamknij korektę (guard: status='correction').
    //    Dopiero potem nadpisz ceny — inaczej w razie konfliktu zostawimy
    //    zamówienie w statusie 'correction' z już nadpisaną ceną.
    const finalized = await correctionsDb.finalizeOrderCorrection(orderId);
    if (!finalized) {
        return {
            success: false,
            status: 409,
            message: 'Korekta została już zakończona lub status zamówienia zmienił się w międzyczasie. Odśwież listę.'
        };
    }

    try {
        await db.updateOrderPriceOnSend(orderId, normalizePrices(prices));
    } catch (err) {
        log(`Korekta ${orderId}: status ustawiony na 'sent', ale nie udało się zapisać cen:`, err);
    }

    // Termin produkcji per pozycja musi być świeży w chwili wysyłki: JSON na
    // FTP bierze go wprost z `order_item.prod_days`. Przeliczenie odtwarza tę
    // kolumnę także dla zamówień sprzed migracji, gdzie jest jeszcze NULL.
    await recalcAndSaveMaxProdDays(orderId);
    ({ orderDetails, orderItems } = await db.getOrderDataToSend(orderId));

    const sender = new OrderSender(req, orderDetails, orderItems, {
        orgIdent: orderDetails.org_ident,
        userIdent: orderDetails.user_ident,
        fileNameSuffix: CORRECTION_FILE_SUFFIX
    });
    const sendData = await sender.init();
    const forceProductionSend = shouldForceProductionSend(req.body?.productionOrder);
    const ignoredProductionClient = getProductionSendSkipClient(orderDetails, [], { forceProductionSend });
    await sender.saveToFile({ forceProductionSend });

    if (ignoredProductionClient) {
        log(`Pominięto wysyłkę korekty (FTP/mail) dla klienta z ignore_mail_list.json: ${ignoredProductionClient}`);
        return {
            success: true,
            message: 'Korekta zapisana. Wysyłka FTP/mail pominięta (lista ignore).',
            redirect: '/admin/order-corrections'
        };
    }

    const currentUser = ownerService.getCurrentUser(req);
    const user = await db.getUserData(currentUser?.pin);
    const clientName = formatClientLabel(user.client_name, user.ident);
    const photoFile = await db.getUserLogo(currentUser?.pin);
    const logoPath = path.join(__dirname, '../../img/', photoFile);
    // Waluta klienta zamówienia — opisy kwot w tabeli i sumy w PDF-ie/mailu
    // korekty (services/currency.js).
    const { priceCurrency, currencySymbol } = await currencyLocalsForOrder(orderId);
    let { cleanOrderItems } = await orderService.jsonTextBackToMap(orderItems, { currency: priceCurrency });
    const productionTimes = currentUser?.orgId ? await db.getGroupDeliveryTimes(currentUser.orgId) : {};
    // Zasady potwierdzenia wspólne z panelem, importem i zatwierdzaniem sklepu
    const abPolicy = await resolveOrderAbPolicy(orderDetails.id);
    const { maxProdDays } = buildItemProductionDays(cleanOrderItems, productionTimes, abPolicy.deliveryDelay);
    const attachments = await getExtraAttachments(sender.slopePaths);
    const lang = req.getLocale();
    const mail = await db.getUserMail(currentUser?.pin);
    const orderIdx = await db.getUserOrderId(orderId);

    let confirmationEmail;
    if (orderDetails?.contact_info_id) {
        const contactInfo = await db.getMailById(orderDetails.contact_info_id);
        confirmationEmail = contactInfo?.email || mail.user_email;
    } else {
        confirmationEmail = mail.user_email;
    }

    const totalPrice = await db.getTotal(orderId);
    const confLang = require('../mailBot/conf');
    const i18n = confLang(lang);
    const __ = (key) => i18n.__(key, { locale: lang });
    const showGoldPrices = currentUser?.orgId != 3;
    const hasSubPricesMail = orderHasSubPrices(cleanOrderItems);
    const { isClientView: isClientForPdf, showBoth: showBothForMail } = resolveSubPricePdfView(req, hasSubPricesMail);

    Object.assign(sendData, buildPdfSendDataTotals({
        isClientView: isClientForPdf,
        showBoth: showBothForMail,
        orderItems,
        totalPrice,
        translate: __,
        showGoldPrices,
        currency: priceCurrency,
        withSubTotal: true
    }));

    // Potwierdzenie korekty w dwóch formatach z jednego renderu: PDF + ten sam dokument HTML
    // Klient z `ab_type = without_price` dostaje korektę również BEZ cen
    const withoutPrices = abPolicy.withoutPrices;
    // …a `ab_lang` wymusza język dokumentu również dla korekty
    const abLang = abPolicy.abLang;
    const docLang = abLang || lang;

    const { pdf, html: confirmationHtml } = await generateOrderDocuments(
        orderDetails,
        cleanOrderItems,
        docLang,
        logoPath,
        sendData,
        orderIdx,
        true,
        maxProdDays,
        showGoldPrices,
        isClientForPdf,
        showBothForMail,
        null,
        { withoutPrices, hasSubPrices: hasSubPricesMail, currencySymbol }
    );
    const orgData = await db.getOrgInfo(req.session.user.organization);

    const extraMail = process.env.EXTRA_MAIL ? process.env.EXTRA_MAIL.split(',') : false;
    const { mainRecipient, bcc } = resolveConfirmationRecipients({
        clientAb: abPolicy.clientAb,
        confirmationEmail,
        organizationEmail: mail.organization_email,
        organizationEmail2: mail.organization_email2,
        extraMail,
        extraAbMail: abPolicy.extraAbMail
    });

    mailBot.sendCorrectionMail(
        mainRecipient,
        lang,
        pdf,
        attachments,
        {
            klient: clientName,
            orderNr: orderIdx,
            logoPath,
            orderDetails: sendData,
            organization: orgData
        },
        bcc,
        { htmlContent: confirmationHtml, abLang }
    );

    log(`Admin correction submitted for order ${orderId} (${orderIdx}) by ${req.session.user?.pin || '?'}`);
    clearCorrectionContext(req);

    return {
        success: true,
        message: 'Korekta wysłana. JSON na FTP (-update) i mail do klienta.',
        redirect: '/admin/order-corrections'
    };
}

async function cancelCorrection(req, orderId) {
    const meta = await correctionsDb.getCorrectionOrderMeta(orderId);
    if (!meta) {
        return { success: false, status: 404, message: 'Nie znaleziono zamówienia.' };
    }
    if (meta.status !== 'correction') {
        return { success: false, status: 400, message: 'Zamówienie nie jest w trakcie korekty.' };
    }

    const cancelled = await correctionsDb.cancelOrderCorrection(orderId);
    if (!cancelled) {
        return { success: false, status: 409, message: 'Nie udało się anulować korekty — status zmienił się w międzyczasie.' };
    }

    log(`Korekta zamówienia ${orderId} anulowana przez admin ${req.session.user?.pin || '?'}`);
    clearCorrectionContext(req);

    return {
        success: true,
        message: 'Korekta anulowana. Zamówienie wróciło do statusu „wysłane".',
        redirect: '/admin/order-corrections'
    };
}

module.exports = {
    CORRECTION_FILE_SUFFIX,
    ensureCorrectionContext,
    submitCorrection,
    cancelCorrection
};
