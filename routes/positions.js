const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireLogin } = require('../middleware/loginMixture');
const { loadEmployeePermissions, filterPriceData } = require('../middleware/employeePermissions');
const db = require("../db/db_helper.js");
const { getOrderMutationBlock, getClientGroupOrderBlock } = require('../utils/orderStatusGuard');
const { resolveClientDiscountForOrder } = require('../services/groupDiscount');
const { resolveCombinedDiscountForOrder } = require('../services/portalUsageDiscount');
const { resolveClientPricingForOrder } = require('../services/groupPriceMode');
const adminDb = require("../db/admin/db_helper.js");
const ownerService = require('../services/owner.js');
const fs = require('fs');
const path = require('path');
const itemBuilder = require('../services/itemBuilder')
const versionManager = require("../services/versionManager")
const { photoPath, dataDir } = require('../config');
const { group } = require('console');
const { fileExists } = require('../utils/fileManager');
const { ensureGroupInfoFilesDir } = require('../utils/ensureInfoFilesDir');
const { ordersManager } = require('../utils/saveOrdersOutput.js');
const { file } = require('pdfkit');
const { log } = require('../utils/logging');
const { resolveUsableVersion } = require('../services/rulesVersion');
const { recalcAndSaveMaxProdDays } = require('../services/productionDays');
// Same VAT locals as the new-position form (routes/orders.js), so position
// edit (regular + admin-redit) shows/computes exactly the same VAT block —
// and hides it just as completely while the feature is off.
const { resolveVatLocals } = require('../services/vatCalculator');

// Zlecenie tylko do odczytu po wysyłce — także po anulowaniu (`canceled`):
// jego pozycje oglądamy w podglądzie wysłanego zlecenia, bez formularza edycji.
async function isOrderSent(orderId) {
  const status = await db.getOrderStatus(orderId);
  return status === 'sent' || status === 'canceled';
}

function sentOrderPath(orderId) {
  return `/orders/history/order/${orderId}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

function sentOrderPath(orderId) {
  return `/orders/history/order/${orderId}`;
}

async function rejectSentOrderMutation(res, orderId, req) {
  const block = await getOrderMutationBlock(orderId, req?.session?.user);
  if (block) {
    return res.status(403).json(block);
  }
  return null;
}


function normalizeFilename(filename) {
  if (filename) {
    return filename
      .split('.')[0]                       
      .replace(/~\d+$/, '')                
      .replace(/\s+/g, '')                  
      .replace(/_+/g, '')               
      .toLowerCase();                    
  }
  return '';
}


router.use(async (req, res, next) => {
  res.locals.owner = req.session?.user?.isOwner || false;
  res.locals.admin = req.session?.user?.isAdmin || false;
  res.locals.isEmployee = req.session?.user?.isEmployee || false;
  res.locals.isGroup = req.session?.user?.isGroup || req.session?.context_user?.isGroup || false;
  res.locals.isGroupShop = req.session?.user?.isGroupShop || false;
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


router.post('/save', requireLogin, upload.any(), async (req, res) => {
  try {
    const formData = JSON.parse(req.body.data);
    const sentOrderResponse = await rejectSentOrderMutation(res, formData.order, req);
    if (sentOrderResponse) {
      return sentOrderResponse;
    }

    const total = formData.total;
    const files = req.files || [];
    const result = await db.insertNewForm(formData);
    await db.reindexOrderPositions(formData.order);
    await recalcAndSaveMaxProdDays(formData.order);

    if (files.length > 0) {
      const orderpos = await db.getOrderpos(result[0].insertId);
      const saver = new ordersManager();
      const orderNo = await db.getOrderNo(formData.order);
      saver.setOutputPath(req, formData.order, orderNo, orderpos);
      await saver.saveAttachments(files, result[0].insertId);

    }
    res.json({
      status: "success",
      message: "Dane zapisane poprawnie",
      filesProcessed: files.length
    });
  } catch (error) {
    log('Błąd przy zapisywaniu:', error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


router.patch('/edit/save', requireLogin, upload.any(), async (req, res) => {
  try {
    const formData = JSON.parse(req.body.data);
    const total = formData.total;
    const files = req.files || [];
    const existingPosition = await db.getPosition(formData.id);
    if (!existingPosition) {
      return res.status(404).json({ success: false, error: 'Pozycja nie istnieje' });
    }

    const sentOrderResponse = await rejectSentOrderMutation(res, existingPosition.order_id, req);
    if (sentOrderResponse) {
      return sentOrderResponse;
    }

    const result = await db.updatePosition(formData, total);

    const positionForRecalc = await db.getPosition(formData.id);
    if (positionForRecalc) {
      // updatePosition only writes this position's own unit_price/total_price/
      // total_price_sub — the `order` row's aggregate totals are a separate,
      // denormalized copy that must be explicitly recomputed from all its
      // order_item rows, or they go stale (e.g. stuck at whatever the initial
      // import computed, even after every position has since been resaved with
      // correct prices).
      await db.updateOrderPrice(positionForRecalc.order_id, null);
      await recalcAndSaveMaxProdDays(positionForRecalc.order_id);
    }

    if (files.length > 0) {
      const orderpos = await db.getOrderpos(formData.id);
      const saver = new ordersManager();
      const position = positionForRecalc;
      const orderNo = await db.getOrderNo(position.order_id);
      saver.setOutputPath(req, position.order_id, orderNo, orderpos);
      await saver.updateAttachments(files, formData.id);
    }

    res.json({ status: "success", message: "Dane zapisane poprawnie" });
  } catch (err) {
    log('Błąd podczas zapisu pozycji:', err);
    return res.status(400).json({ error: "Niepoprawne dane" });
  }
});


router.delete('/:positionId/delete', requireLogin, async (req, res) => {
  try {
    const position = await db.getPosition(req.params.positionId);
    if (!position) {
      return res.status(404).json({
        success: false,
        message: 'Nie znaleziono pozycji'
      });
    }

    const orderId = position.order_id;
    const sentOrderResponse = await rejectSentOrderMutation(res, orderId, req);
    if (sentOrderResponse) {
      return sentOrderResponse;
    }

    const response = await db.deletePosition(req.params.positionId);

    if (response) {
      await db.reindexOrderPositions(orderId);
      await recalcAndSaveMaxProdDays(orderId);
      return res.status(200).json({
        success: true,
        message: 'position.delete_msg'
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'Błąd podczas usuwania pozycji'
      });
    }
  } catch (error) {
    log('Error deleting position:', error);
    return res.status(500).json({
      success: false,
      message: 'Błąd serwera podczas usuwania pozycji'
    });
  }
});


router.get('/photo', requireLogin, async (req, res) => {
  try {
    const { photoName, groupNumber, folderName } = req.query;


    if (!photoName || !groupNumber || !folderName) {
      return res.status(400).json({ error: 'Brak wymaganych danych' });
    }

    const basePath = path.join(photoPath, groupNumber.toString(), folderName);
    let exists = false;
    let actualFileName = null;

    try {
      const files = fs.readdirSync(basePath);
      const normalizedTarget = normalizeFilename(photoName);

      for (const file of files) {
        if (normalizeFilename(file) === normalizedTarget) {
          exists = true;
          actualFileName = file;
          break;
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        exists = false;
      } else {
        throw err;
      }
    }

    return res.json({
      exists,
      photoName: actualFileName || photoName
    });
  } catch (err) {
    log("Błąd sprawdzania zdjęcia:", err);
    return res.status(500).json({ error: "Błąd serwera" });
  }
});


router.get('/:positionId/edit/', requireLogin, loadEmployeePermissions, filterPriceData, async (req, res) => {
  let result = await db.getPosition(req.params.positionId);
  if (result) {
    let orderId = result.order_id;
    if (await isOrderSent(orderId)) {
      return res.redirect(sentOrderPath(orderId));
    }
    // Pozycja zamówienia założonego przez klienta grupy: grupa-matka typu
    // `client` ma sam podgląd, więc formularz edycji nawet się nie otwiera
    // (zapis jest odcięty w getOrderMutationBlock).
    const clientGroupBlock = await getClientGroupOrderBlock(orderId, req.session?.user);
    if (clientGroupBlock) {
      return res.redirect(clientGroupBlock.redirect);
    }

    const vatLocals = await resolveVatLocals(req);
    // Ten sam rabat co przy zakładaniu pozycji — inaczej edycja pozycji
    // zapisałaby cenę bez rabatu (services/groupDiscount.js).
    const { total: clientDiscountPercent, portalBonus: portalUsageDiscountPercent } =
      await resolveCombinedDiscountForOrder(orderId);
    // I ten sam tryb wyceny (rabat / narzut) — services/groupPriceMode.js.
    const { mode: clientPriceMode, markupPercent: clientMarkupPercent } =
      await resolveClientPricingForOrder(orderId);
    return res.render('edit_position.njk', { position: result, orderId: orderId, hidePrices: req.hidePrices, clientDiscountPercent, portalUsageDiscountPercent, clientPriceMode, clientMarkupPercent, ...vatLocals })
  }
  else {
    return res.status(400).json({
      success: false,
    })
  }
})

router.get('/:positionId/admin-redit/', requireLogin, async (req, res) => {
  if (!req.session.user?.isAdmin) {
    return res.status(403).render('no-permission.njk');
  }
  let result = await db.getPosition(req.params.positionId);
  if (result) {
    let orderId = result.order_id;
    // Recalculation needs the order owner's client context (org/user ident)
    // to resolve the correct per-client price script/alias collection —
    // without it the browser falls back to the admin's own context and
    // picks the wrong pricing collection (e.g. PG3 instead of the client's PG4).
    const ownerIdent = await db.getOrderOwnerIdent(orderId);
    if (ownerIdent) {
      await ownerService.setContextUserByIdent(req, ownerIdent);
    }
    // Resolved AFTER setContextUserByIdent so it reflects the order owner
    // (client), not the admin's own org/country.
    const vatLocals = await resolveVatLocals(req);
    return res.render('admin_edit_position.njk', { position: result, orderId: orderId, hidePrices: false, ...vatLocals })
  }
  else {
    return res.status(400).json({ success: false })
  }
})


router.get('/:orderId/:positionId/attachments', requireLogin, async (req, res) => {
  try {
    const posId = req.params.positionId;
    const orderId = req.params.orderId;
    const orderNo = await db.getOrderNo(orderId);
    const orderpos = await db.getOrderpos(posId);
    const attachmentsManager = new ordersManager();
    attachmentsManager.setOutputPath(req, orderId, orderNo, orderpos);
    const attachments = await db.getAttachments(posId);
    return res.json({ attachments });
  }
  catch (error) {
    log('Error fetching attachments:', error);
    return res.status(500).json({ error: 'Failed to fetch attachments' });
  }
})

router.post('/:positionId/duplicate/', requireLogin, async (req, res) => {
  const position = await db.getPosition(req.params.positionId);
  if (!position) {
    return res.status(404).json({ success: false });
  }

  const orderId = position.order_id;
  const sentOrderResponse = await rejectSentOrderMutation(res, orderId, req);
  if (sentOrderResponse) {
    return sentOrderResponse;
  }

  const result = await db.insertNewForm(
    itemBuilder.buildOrderItemStructure(
      position.order_id,
      position.list_price,
      position.discount_percentage,
      position.discount,
      position.unit_price,
      position.total_price,
      position.total_price_sub,
      position.name,
      position.commision,
      position.json_parameters,
      position.json_parameters_desc,
      position.amount,
      position.comment,
      position.ver,
      position.asortment_group_number,
      position.lang,
      position.department,
      position.group_name,
      position.parameters_short
    )
  )

  if (result) {
    await db.reindexOrderPositions(orderId);
    await recalcAndSaveMaxProdDays(orderId);
    const newPositionId = result[0].insertId;
    return res.status(200).json({ redirect: `/position/${newPositionId}/edit` })
  }
  else {
    return res.status(400).json({
      success: false,
    })
  }
})


router.get('/:positionId/data', requireLogin, async (req, res) => {
  let result = await db.getPosition(req.params.positionId);

  if (result) {
    return res.status(200).json({ position: result })
  }
  else {
    return res.status(400).json({
      success: false,
    })
  }
})

router.post('/favorites/toggle', requireLogin, async (req, res) => {
  const currentUser = ownerService.getCurrentUser(req);
  const userId = currentUser.userId;
  const { productValue, groupNumber } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'Brak autoryzacji' });
  }
  try {
    const exists = await db.checkFavoriteExists(userId, productValue, groupNumber);

    if (exists) {
      await db.removeFavorite(userId, productValue, groupNumber);
      res.json({ isFavorite: false });
    } else {
      await db.addFavorite(userId, productValue, groupNumber);
      res.json({ isFavorite: true });
    }
  } catch (error) {
    log('Database error:', error);
    res.status(500).json({ error: 'Database operation failed' });
  }
});

router.get('/:positionId', requireLogin, async (req, res) => {
  let result = await db.getPosition(req.params.positionId);

  // `json_parameters_desc` is a MySQL JSON column, so mysql2 may hand it back
  // either as a JS string (the canonical DOUBLE-encoded shape written by
  // insertNewForm / updatePosition) or as an already-parsed array/object (the
  // shape imported orders end up with after displayValueRebuilder). Calling
  // JSON.parse() on the latter throws and used to blank the whole page, so we
  // only parse when we actually have a string and otherwise use the value as-is.
  let parametersDesc = [];
  if (result && result.json_parameters_desc != null) {
    try {
      let raw = result.json_parameters_desc;
      if (typeof raw === 'string') {
        raw = JSON.parse(raw);
        if (typeof raw === 'string') {
          raw = JSON.parse(raw);
        }
      }
      parametersDesc = raw;
      // Older imported rows may store a plain object {KEY: {...}} instead of
      // the canonical Map.entries array. Normalize so the template's
      // `for param in parameters` loop always sees [key, value] pairs.
      if (parametersDesc && !Array.isArray(parametersDesc) && typeof parametersDesc === 'object') {
        parametersDesc = Object.entries(parametersDesc);
      }
      if (!Array.isArray(parametersDesc)) {
        parametersDesc = [];
      }
    } catch (err) {
      log(`position ${req.params.positionId}: invalid json_parameters_desc - ${err.message}`);
      parametersDesc = [];
    }
  }
  const values = result.json_parameters
  const parameters_short = result.parameters_short || {};

  if (result) {
    if (!req.session.user?.showPrices) {
      return res.render('position_sent.njk', { position: result, parameters: parametersDesc, values: values, parameters_short: parameters_short, isAdmin: req.session.user?.isAdmin })
    }
    else {
      return res.render('position_sent-prices.njk', { position: result, parameters: parametersDesc, values: values, parameters_short: parameters_short, isAdmin: req.session.user?.isAdmin, showUnlockedPrices: true })
    }
  }
  else {
    return res.status(400).json({
      success: false,
    })
  }
})


router.get('/favs/:groupNr', requireLogin, async (req, res) => {
  const groupNumber = req.params.groupNr;
  const currentUser = ownerService.getCurrentUser(req);
  const userId = currentUser.userId;
  const favs = await db.getFavs(userId, groupNumber);
  if (!favs || favs.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'Brak ulubionych produktów'
    });
  }
  else {
    const productValues = favs.map(fav => fav.product_value);
    return res.json({
      success: true,
      favorites: productValues
    });
  }
})


router.post('/check-images', requireLogin, async (req, res) => {
  try {
    const { options, groupNumber, folderName } = req.body;

    if (!Array.isArray(options) || !groupNumber || !folderName) {
      return res.status(400).json({ error: 'Brak wymaganych danych' });
    }

    const result = {};
    const basePath = path.join(photoPath, groupNumber.toString(), folderName);
    const files = fs.readdirSync(basePath);

    const normalizedFiles = {};
    for (const file of files) {
      const normalized = normalizeFilename(file);
      normalizedFiles[normalized] = file;
    }

    for (const opt of options) {
      const originalValue = opt.VALUE;
      const normalizedValue = normalizeFilename(originalValue);

      if (normalizedFiles[normalizedValue]) {

        const originalFileName = normalizedFiles[normalizedValue];

        result[originalValue] = originalFileName;
      } else {
        result[originalValue] = null;
      }
    }

    return res.json(result);
  } catch (err) {
    log("Błąd sprawdzania obrazów:", err);
    return res.status(500).json({ error: "Błąd serwera" });
  }
});


router.get('/version/:groupNr/', requireLogin, async (req, res) => {
  const lang = req.getLocale();

  // Jedyny punkt, w ktorym serwer dowiaduje sie o wyborze grupy PRZED zbudowaniem
  // formularza (main.js: getAppVersion → buildDynamicForm), wiec tutaj zakladamy
  // katalog zalacznikow INFO wartosci tej grupy: <photoPath>/<grupa>/files.
  // Leniwie, a nie przy starcie, bo nowe grupy pojawiaja sie bez restartu.
  // Nie blokuje odpowiedzi: helper nigdy nie rzuca (patrz utils/ensureInfoFilesDir.js).
  ensureGroupInfoFilesDir({ photoPath, groupNumber: req.params.groupNr, log });

  let version = await db.getAppVersion(req.params.groupNr, process.env.NODE_ENV || 'dev');

  return res.status(200).json({ version: version })
})


/**
 * Wersja reguł, którą DA SIĘ wczytać dla tej grupy — z podmianą, gdy wersja
 * zapisana w pozycji zniknęła z udziału.
 *
 * ⚠️ Pyta o to `formTools/dataLoader.js`, gdy `param.txt`/`paramdict.txt`
 * żądanej wersji zwróci 404. Bez tego `generateForm()` padał na
 * `data.dictValues` i użytkownik dostawał MARTWY ekran edycji — dotyczy 522
 * zapisanych pozycji (patrz services/rulesVersion.js). Przeglądarka nie umie
 * wylistować katalogu, więc rozstrzyga to serwer.
 */
router.get('/rules-version/:groupNr/', requireLogin, async (req, res) => {
  const lang = req.query.lang || req.getLocale();
  const requested = req.query.requested || null;
  const wynik = resolveUsableVersion(req.params.groupNr, requested, lang);
  if (wynik.fallback) {
    log(`Reguły: grupa ${req.params.groupNr} — ${wynik.reason} (język ${lang})`);
  }
  // 404 tylko wtedy, gdy NIE MA czym podmienić — inaczej klient nie odróżniłby
  // „podmieniono" od „nic nie ma".
  return res.status(wynik.version ? 200 : 404).json(wynik);
});


router.post('/versions/update/', requireLogin, async (req, res) => {
  try {
    const paths = req.body;

    if (!paths || !Array.isArray(paths)) {
      return res.status(400).json({ error: "Nieprawidłowy format ścieżek" });
    }
    const results = [];
    const manager = await versionManager.checkVersion(paths);

    res.json({
      success: true,
    });

  } catch (error) {
    log('Błąd aktualizacji wersji:', error);
    res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});


router.post('/:id/move-up', requireLogin, async (req, res) => {
  try {
    const positionId = req.params.id;
    const position = await db.getPosition(positionId);
    if (!position) {
      return res.status(404).json({ success: false, message: 'Position not found' });
    }

    const sentOrderResponse = await rejectSentOrderMutation(res, position.order_id, req);
    if (sentOrderResponse) {
      return sentOrderResponse;
    }

    const result = await db.movePositionUp(positionId);

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    log('Error moving position up:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


router.post('/:id/move-down', requireLogin, async (req, res) => {
  try {
    const positionId = req.params.id;
    const position = await db.getPosition(positionId);
    if (!position) {
      return res.status(404).json({ success: false, message: 'Position not found' });
    }

    const sentOrderResponse = await rejectSentOrderMutation(res, position.order_id, req);
    if (sentOrderResponse) {
      return sentOrderResponse;
    }

    const result = await db.movePositionDown(positionId);

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    log('Error moving position down:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


router.post('/:id/set-idx', requireLogin, async (req, res) => {
  try {
    const positionId = req.params.id;
    const { idx } = req.body;
    const position = await db.getPosition(positionId);
    if (!position) {
      return res.status(404).json({ success: false, message: 'Position not found' });
    }

    const sentOrderResponse = await rejectSentOrderMutation(res, position.order_id, req);
    if (sentOrderResponse) {
      return sentOrderResponse;
    }

    const result = await db.setPositionIdx(positionId, idx);

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    log('Error setting position index:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


router.post('/favs/clear/:groupNr', requireLogin, async (req, res) => {
  try {
    const groupNumber = req.params.groupNr;
    const favsToDelete = req.body.favList;
    const currentUser = ownerService.getCurrentUser(req);
    const userId = currentUser.userId;
    for (const fav of favsToDelete) {

      await db.removeFavorite(userId, fav, groupNumber);
    }
    return res.status(200).json({ success: true });

  } catch (error) {
    log('Database error:', error);
    return res.status(500).json({ error: 'Database operation failed' });
  }
});

module.exports = router;