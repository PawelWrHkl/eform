/**
 * Sends an imported order using the same production flow as the UI "Wyślij":
 *   - change status to `sent`
 *   - write JSON (+ FTP upload to /orders-out/ when PRODUCTION is set)
 *   - confirmation email with PDF (+ production PDF upload)
 */

const path = require('path');

const db = require('../../db/db_helper');
const orderService = require('../orderService');
const mailBot = require('../mailBot/mailBot');
const OrderSender = require('../sendOrderService');
const { generateOrderDocuments, generateProductionPdf, uploadProductionPdf } = require('../mailBot/pdfGenerator');
const { resolveOrderAbPolicy, resolveConfirmationRecipients, policyFromUserRow } = require('../confirmationPolicy');
const { formatClientLabel } = require('../../utils/formatClient');
const { getExtraAttachments } = require('../mailBot/extraAttachments');
const { log } = require('../../utils/logging');
const confLang = require('../mailBot/conf');
const { translateOrderItems } = require('../translationDict/itemTranslator');
const { buildItemProductionDays } = require('../productionDays');
const { getProductionSendSkipClient } = require('../../utils/productionSendGuard');

function parseJsonField(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeOrderItems(orderItems) {
  return (orderItems || []).map((item) => ({
    ...item,
    json_parameters: parseJsonField(item.json_parameters, {}),
    parameters_short: parseJsonField(item.parameters_short, {})
  }));
}

function buildImportRequestContext(user) {
  const orgIdent = user.org_ident ? String(user.org_ident).toUpperCase() : '';
  return {
    session: {
      user: {
        userId: user.id,
        pin: user.pin,
        ident: user.ident,
        organization: orgIdent,
        orgId: user.organization_id,
        clientName: user.client_name
      }
    },
    getLocale() {
      return user._importLang || 'en';
    }
  };
}

function formatSendTotals(sendData, lang, orgId, ordersDb) {
  const i18n = confLang(lang);
  const __ = (key) => i18n.__(key, { locale: lang });
  const showGoldPrices = orgId != null && Number(orgId) !== 3;

  return ordersDb.getTotal(sendData.orderid).then((totalPrice) => {
    if (totalPrice.visible && Number(totalPrice.visible) !== 0) {
      sendData.total = `${__('order.total')}: ${totalPrice.visible}€`;
    }
    if (showGoldPrices) {
      if (totalPrice.hidden && Number(totalPrice.hidden) !== 0) {
        sendData.total_hidden = `${__('order.total_hidden')}: ${totalPrice.hidden}€`;
      } else if (totalPrice.visible && Number(totalPrice.visible) !== 0) {
        sendData.total_hidden = `${__('order.total_hidden')}: ${totalPrice.visible}€`;
      }
    }
    return sendData;
  });
}

/**
 * @param {object} ctx
 * @param {number} ctx.orderId
 * @param {object} ctx.user      Row from userResolver (needs id, pin, ident, client_name, organization_id, org_ident)
 * @param {string} ctx.lang
 * @param {object} [ctx.deps]
 * @returns {Promise<{sent: boolean, skipped?: string, error?: string}>}
 */
async function sendImportedOrder({ orderId, user, lang, deps = {} }) {
  const ordersDb = deps.orders || db;
  const mailer = deps.mailer || mailBot;
  const logger = deps.log || log;
  const orderSvc = deps.orderService || orderService;
  const SenderClass = (deps.OrderSender || OrderSender).OrderSender;
  const extraAttachments = deps.getExtraAttachments || getExtraAttachments;
  // Zwraca { pdf, html } — testy mogą wstrzyknąć starsze `deps.generatePdf`
  // (samo Buffer z PDF-em), wtedy załącznik HTML po prostu nie powstaje.
  const docsGenerate = deps.generateOrderDocuments
    || (deps.generatePdf ? async (...args) => ({ pdf: await deps.generatePdf(...args), html: null }) : generateOrderDocuments);
  const itemProductionDays = deps.buildItemProductionDays || buildItemProductionDays;
  const itemTranslator = deps.translateOrderItems || translateOrderItems;
  const prodPdfGenerate = deps.generateProductionPdf || generateProductionPdf;
  const prodPdfUpload = deps.uploadProductionPdf || uploadProductionPdf;
  const productionSkipClient = deps.getProductionSendSkipClient || getProductionSendSkipClient;

  if (!orderId || !user) {
    return { sent: false, error: 'orderId and user are required' };
  }

  try {
    let { orderDetails, orderItems } = await ordersDb.getOrderDataToSend(orderId);
    orderItems = normalizeOrderItems(orderItems);

    if (!orderItems || orderItems.length === 0) {
      return { sent: false, error: 'empty order' };
    }

    const statusChanged = await ordersDb.changeOrderStatus(orderId, 'sent');
    if (!statusChanged) {
      return { sent: false, error: 'changeOrderStatus failed' };
    }

    ({ orderDetails, orderItems } = await ordersDb.getOrderDataToSend(orderId));
    orderItems = normalizeOrderItems(orderItems);

    const req = buildImportRequestContext({ ...user, _importLang: lang });
    const sender = new SenderClass(req, orderDetails, orderItems);
    const sendData = await sender.init();
    const ignoredProductionClient = productionSkipClient(orderDetails, []);
    const importSendOptions = { forceProductionSend: true };
    await sender.saveToFile(importSendOptions);

    if (ignoredProductionClient) {
      logger(`Import send: pominięto mail/FTP dla klienta z ignore_mail_list.json: ${ignoredProductionClient}`);
      return { sent: false, skipped: ignoredProductionClient };
    }

    const clientName = formatClientLabel(user.client_name, user.ident);
    const photoFile = await ordersDb.getUserLogo(user.pin);
    const logoPath = path.join(__dirname, '../../img/', photoFile);
    const { cleanOrderItems } = await orderSvc.jsonTextBackToMap(orderItems);
    const productionTimes = user.organization_id
      ? await ordersDb.getGroupDeliveryTimes(user.organization_id)
      : {};

    // Zasady potwierdzenia (`ab_type`, `ab_lang`, `client_ab`, `delivery_delay`)
    // z tego samego miejsca co panel — patrz `services/confirmationPolicy.js`.
    //
    // ⚠️ Źródło jest wybierane JAWNIE: jeśli przekazany wiersz `user` zawiera
    // te kolumny (tak robi `userResolver.js` i `SELECT *` w wysyłce na
    // produkcję) — czytamy z niego; jeśli nie, dopytujemy bazę po zamówieniu.
    // Wcześniej kod bezwarunkowo czytał z wiersza, a zapytanie importu tych
    // kolumn NIE wybierało, więc reguły dostawały `undefined` i po cichu nie
    // działały: PDF wychodził z cenami, a język i `client_ab` były ignorowane.
    const abPolicyResolver = deps.resolveOrderAbPolicy || resolveOrderAbPolicy;
    const wierszMaKolumny = !!user && ['ab_type', 'ab_lang', 'client_ab', 'delivery_delay'].some((k) => k in user);
    const abPolicy = wierszMaKolumny ? policyFromUserRow(user) : await abPolicyResolver(orderId);
    logger(`[ab] zamówienie ${orderId}: bez cen=${abPolicy.withoutPrices}, język=${abPolicy.abLang || 'domyślny'}, do klienta=${abPolicy.clientAb}, opóźnienie=${abPolicy.deliveryDelay} (źródło: ${wierszMaKolumny ? 'wiersz user' : 'zapytanie po zamówieniu'})`);

    const { maxProdDays } = itemProductionDays(cleanOrderItems, productionTimes, abPolicy.deliveryDelay);
    const attachments = await extraAttachments(sender.slopePaths);
    const mail = await ordersDb.getUserMail(user.pin);
    const orderIdx = await ordersDb.getUserOrderId(orderId);

    let confirmationEmail = mail.user_email;
    if (orderDetails?.contact_info_id) {
      const contactInfo = await ordersDb.getMailById(orderDetails.contact_info_id);
      confirmationEmail = contactInfo?.email || mail.user_email;
    }

    // JĘZYK POTWIERDZENIA: `user.ab_lang` wymusza język dokumentu (i etykiet
    // sum w jego stopce). `user` jest tu już wczytany, więc bez zapytania.
    const abLang = abPolicy.abLang;
    const docLang = abLang || lang;
    if (abLang) logger(`[ab_lang] zamówienie ${orderId}: potwierdzenie w języku ${abLang} (język klienta: ${lang})`);

    const formatTotals = deps.formatSendTotals
      || ((data) => formatSendTotals(data, docLang, user.organization_id, ordersDb));
    await formatTotals(sendData);

    // Klient z `ab_type = without_price` dostaje potwierdzenie BEZ cen
    const withoutPrices = abPolicy.withoutPrices;

    // Treść pozycji też musi być w języku dokumentu — inaczej nagłówki byłyby
    // w jednym języku, a wartości parametrów w drugim.
    const docItems = (abLang && abLang !== lang)
      ? await itemTranslator(orderItems, cleanOrderItems, abLang)
      : cleanOrderItems;

    const { pdf, html: confirmationHtml } = await docsGenerate(
      orderDetails,
      docItems,
      docLang,
      logoPath,
      sendData,
      orderIdx,
      true,
      maxProdDays,
      user.organization_id != 3,
      false,
      false,
      null,
      { withoutPrices }
    );

    const orgData = await ordersDb.getOrgInfo(user.organization_id);

    const extraMail = process.env.EXTRA_MAIL ? process.env.EXTRA_MAIL.split(',') : false;

    // Ta sama reguła co w panelu — `client_ab` kieruje potwierdzenie wprost
    // do klienta, dev/test poza tym przypadkiem trafia na skrzynkę deweloperską.
    const recipients = deps.resolveConfirmationRecipients || resolveConfirmationRecipients;
    const { mainRecipient, bcc } = recipients({
      clientAb: abPolicy.clientAb,
      confirmationEmail,
      organizationEmail: mail.organization_email,
      organizationEmail2: mail.organization_email2,
      extraMail
    });
    if (abPolicy.clientAb) logger(`[client_ab] zamówienie ${orderId}: potwierdzenie dla klienta (${mainRecipient})`);

    const sendMailAsync = deps.sendMailAsync || mailer.sendMailAsync;
    if (!sendMailAsync) {
      throw new Error('sendMailAsync is not available');
    }

    await sendMailAsync(
      mainRecipient,
      lang,
      pdf,
      attachments,
      {
        klient: clientName,
        orderNr: orderIdx,
        logoPath,
        orderDetails: sendData,
        organization: orgData,
        isImport: true
      },
      bcc,
      'mailTemplate.njk',
      'mail.subject',
      { htmlContent: confirmationHtml, abLang }
    );

    try {
      const plItems = await itemTranslator(orderItems, cleanOrderItems, 'pl');
      const prodPdf = await prodPdfGenerate(orderDetails, plItems, logoPath, orderIdx, clientName);
      await prodPdfUpload(prodPdf, sender.fileName, importSendOptions);
    } catch (err) {
      logger(`Import send: błąd PDF produkcyjnego dla order ${orderId}: ${err.message}`);
    }

    logger(`Import send OK for order ${orderId} (idx=${orderIdx})`);
    return { sent: true };
  } catch (err) {
    logger(`Import send failed for order ${orderId}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendImportedOrder,
  buildImportRequestContext,
  normalizeOrderItems,
  parseJsonField
};
