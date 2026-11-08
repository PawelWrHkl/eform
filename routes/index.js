const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/loginMixture');
const db = require("../db/db_helper.js");
const adminDb = require("../db/admin/db_helper.js");
const usersDb = require("../db/users.js");
const ownerService = require('../services/owner.js');
const staffAccess = require('../services/staffAccess');
const path = require('path')
const { customOrgSorting } = require('../utils/otherBossUtilities.js');
const fs = require('fs');
const langManager = require('../services/setLanguage')
const verManager = require('../services/versionManager.js')
const { dataDir, localesDir, availabeLanguages } = require('../config');
const { readWord } = require('../utils/readWord.js');
const e = require('express');
const { log } = require('../utils/logging');


router.use(async (req, res, next) => {
  // log('siema z index.js');

  // log('isOwner:', req.session?.user?.isOwner);
  res.locals.owner = req.session?.user?.isOwner || false;
  res.locals.admin = req.session?.user?.isAdmin || false;
  res.locals.isEmployee = req.session?.user?.isEmployee || false;
  res.locals.isGroup = req.session?.user?.isGroup || req.session?.context_user?.isGroup || false;
  res.locals.isGroupShop = req.session?.user?.isGroupShop || false;
  res.locals.employeePermissions = req.session?.employeePermissions || null;
  res.locals.priceFactor = req.session?.employeePermissions?.price_factor || 1.0;
  if (req.session?.user?.isOwner) {
    try {
      // log('Ładowanie użytkowników dla właściciela...');
      res.locals.users = await db.getUsersByOwner(req);
      // log('Użytkownicy załadowani:', res.locals.users);
    } catch (error) {
      log('Error loading users for owner:', error);
      res.locals.users = [];
    }
  }
  next();
});


router.get('/translations', (req, res) => {
  const lang = req.getLocale();
  process.env.userLang = lang;
  const filePath = path.join(localesDir, `${lang}.json`);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'Translation file not found' });
    }
    try {
      const translations = JSON.parse(data);
      res.json(translations);
    } catch (parseError) {
      log('Błąd parsowania JSON:', parseError);
      res.status(500).json({ error: 'Invalid translation JSON' });
    }
  });
});


router.get('/env', (req, res) => {
  const versionsHuman = {
    dev: 'Deweloperska',
    test: "Testowa",
    archive: "Archiwalna"
    ,prod: "Produkcyjna"
  }
  let ver = process.env?.NODE_ENV ?? false
  let versionString = false
  if (ver) {
    versionString = versionsHuman[ver]
  }

  return res.json({ status: "success", body: { version: versionString } });
});


router.get('/languages', (req, res) => {
  const lang = req.getLocale();

  return res.json({ status: "success", body: { lang: lang, availableLanguages: availabeLanguages } });
});


router.get('/change-language', (req, res) => {
  const lang = req.query.lang;
  langManager.setLang(lang, res)
  const redirectPath = req.get('Referrer') || '/';
  process.env.userLang = lang;
  res.redirect(redirectPath);
});


router.get("/", requireLogin, async (req, res) => {
  const mustAcceptRODO = req.session.mustAcceptRODO || false;
  // Konto biura ma własną stronę startową (routes/staff.js) — po akceptacji RODO.
  if (req.session.user?.isStaff && !mustAcceptRODO) {
    return res.redirect('/staff');
  }
  const currentUser = ownerService.getCurrentUser(req);
  console.log(currentUser, 'current user in index.js');
  let user, orders, ordersSent;

  if (req.session.user?.isGroupShop) {
    const groupShopId = req.session.user.groupShopId;
    const shop = await db.getGroupUserById(groupShopId);
    user = {
      client_name: shop.name || shop.ident,
      tax_id: shop.tax_id || '',
      street: shop.street || '',
      zip: shop.zip || '',
      city: shop.city || '',
      country: '',
      email: shop.email || '',
    };
    orders = await db.getGroupShopOrders(groupShopId, 4, 0) || [];
    ordersSent = await db.getGroupShopOrders(groupShopId, 4, 0, true) || [];
  } else {
    user = await db.getUserData(currentUser.pin);
    const employeeId = req.session.user?.isEmployee && !req.session.employeePermissions?.can_see_all_orders
      ? (req.session.employee?.id ?? null)
      : null;
    orders = await db.getUserOrders(user.id, 4, 0, false, false, employeeId);
    ordersSent = await db.getUserOrders(user.id, 4, 0, true, false, employeeId);
  }

  let organizations = [];
  if (req.session.user.isAdmin) {
    organizations = await db.getAllOrganizations();
    organizations = customOrgSorting(organizations);
  }

  return res.render("home.njk", {
    user: user,
    orders: orders,
    ordersSent: ordersSent,
    limit: 4,
    mustAcceptRODO: mustAcceptRODO,
    owner: req.session.user.isOwner,
    admin: req.session.user.isAdmin,
    organizations: organizations
  });
});


router.get("/delivery-time", requireLogin, async (req, res) => {
  const currentUser = ownerService.getCurrentUser(req);
  const deliveryTimes = await db.getDeliveryTimes(currentUser.pin)
  res.render("delivery.njk", { deliveryTimes: deliveryTimes });
});


router.get("/contact", requireLogin, async (req, res) => {
  try {
    const currentUser = ownerService.getCurrentUser(req);
    let owner = await db.getOwner(currentUser.pin);
    const orgIdent = owner?.orgIdent.toUpperCase() ?? "HKL"
    const html = await readWord('rodo', `${orgIdent}_contact_${process.env.userLang || 'pl'}`);

    res.render("contact.njk", { contentHtml: html });
  } catch (err) {
    const html = await readWord('rodo', `LUXANGMBH_contact_${process.env.userLang || 'pl'}`);
    res.render("contact.njk", { contentHtml: html });
  }

});


router.get("/terms", requireLogin, async (req, res) => {
  try {
    const currentUser = ownerService.getCurrentUser(req);
    let owner = await db.getOwner(currentUser.pin);
    const orgIdent = owner?.orgIdent.toUpperCase() ?? "HKL"
    const html = await readWord('rodo', `${orgIdent ?? "HKL"}_regulations_${process.env.userLang || 'pl'}`);
    res.render("terms.njk", { contentHtml: html });
  } catch (err) {
    log(err);

    const html = await readWord('rodo', `HKL_regulations_${process.env.userLang || 'pl'}`);
    res.render("terms.njk", { contentHtml: html });
  }
});


router.get("/privacy", requireLogin, async (req, res) => {
  try {
    const currentUser = ownerService.getCurrentUser(req);
    let owner = await db.getOwner(currentUser.pin);
    const orgIdent = owner?.orgIdent.toUpperCase() ?? "HKL"
    const html = await readWord('rodo', `${orgIdent.toUpperCase() ?? "HKL"}_privacy_${process.env.userLang || 'pl'}`);
    res.render("privacy.njk", { contentHtml: html });
  } catch (err) {
    log(err);
    const html = await readWord('rodo', `HKL_privacy_${process.env.userLang || 'pl'}`);
    res.render("privacy.njk", { contentHtml: html });
  }
});


router.get('/config-num', requireLogin, async (req, res) => {
  const num = await verManager.getConfigNum()
  if (num) {
    return res.status(200).json({
      success: true,
      name: num
    });
  }
  else {
    return res.status(400).json({
      success: false,
      message: `Nie znaleziono konfiguracji`
    })
  }
});


router.get('/context-user', requireLogin, async (req, res) => {
  try {
    const contextUser = ownerService.getContextUser(req);
    // log('Context user:', contextUser);
    if (!contextUser) {
      return res.status(200).json({
        success: false,
        contextUser: false
      });
    }

    return res.status(200).json({
      success: true,
      contextUser: true,
      userName: contextUser.clientName,
      ident: contextUser.ident
    });
  } catch (error) {
    log('Error checking context user:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});


router.get('/recent-clients', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user?.userId;
    if (!userId) {
      return res.status(200).json([]);
    }
    const recent = await usersDb.getRecentClients(userId);
    // Konto biura: tylko klienci, do których nadal ma dostęp (admin mógł go odebrać).
    if (req.session.user?.isStaff) {
      const allowed = await staffAccess.filterAllowedIdents(userId, (recent || []).map((r) => r.ident));
      const byIdent = new Map(allowed.map((a) => [String(a.ident).toUpperCase(), a]));
      return res.status(200).json((recent || [])
        .filter((r) => byIdent.has(String(r.ident).toUpperCase()))
        .map((r) => {
          const a = byIdent.get(String(r.ident).toUpperCase());
          return { ident: a.ident, name: a.client_name, organization: a.org_ident };
        }));
    }
    return res.status(200).json(recent);
  } catch (error) {
    log('Error fetching recent clients:', error);
    return res.status(500).json([]);
  }
});


router.post('/recent-clients', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user?.userId;
    const { ident, name } = req.body;
    if (!userId || !ident || !name) {
      return res.status(400).json({ success: false });
    }
    // Konto biura zapisuje ostatnich klientów samo, przy wyborze klienta (routes/staff.js).
    if (req.session.user?.isStaff) {
      return res.status(403).json({ success: false });
    }
    await usersDb.saveRecentClient(userId, ident, name);
    return res.status(200).json({ success: true });
  } catch (error) {
    log('Error saving recent client:', error);
    return res.status(500).json({ success: false });
  }
});


router.get('/set-organization/:id', requireLogin, async (req, res) => {
  try {
    const { id } = req.params;
    req.session.user.organization = id;
    delete req.session.context_user;

    const redirectPath = '/';
    res.redirect(redirectPath);
  } catch (error) {
    log('Error setting organization:', error);
    res.status(500).redirect('/');
  }
});


router.post('/set-last-user', requireLogin, async (req, res) => {
  try {
    const { orgIdent, userPath } = req.body;

    if (!orgIdent || !userPath) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters'
      });
    }

    const organizationId = parseInt(orgIdent, 10);

    if (isNaN(organizationId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid organization ID'
      });
    }

    req.session.user.organization = organizationId;

    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    return res.json({
      success: true,
      redirectUrl: userPath
    });
  } catch (error) {
    log('Error setting last user:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});




router.get('/get-org-ident', requireLogin, async (req, res) => {
  try {
    const organization = req.session.user.organization || null;
    res.json({
      success: true,
      organization: organization
    });
  } catch (error) {
    log('Error getting organization ident:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});


router.get('/employee-status', requireLogin, async (req, res) => {
  try {
    let isEmp = req.session.user.isEmployee || false;
    let panelPath
    let empName = false;
    if (!isEmp) {
      panelPath = '/user/employee-panel'

    }
    else {
      panelPath = '/'
      empName = req.session.employee.name + ' ' + req.session.employee.surname;
    }
    res.json({
      success: true, isEmployee: req.session.user.isEmployee || false,
      path: panelPath,
      name: empName

    });
  } catch (error) {
    log('Error getting employee status:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;