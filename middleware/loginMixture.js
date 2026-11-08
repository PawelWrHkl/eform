const db = require("../db/db_helper.js");
const usersDb = require("../db/users.js");
const { customOrgSorting } = require('../utils/otherBossUtilities.js');
const { log } = require('../utils/logging');
const staffAccess = require('../services/staffAccess');
const staffAudit = require('../services/staffAudit');
const ownerService = require('../services/owner');
const { applySubPriceLocals } = require('../services/subPriceContext');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/user/login");
  }
  next();
}

function addOrganizationsForAdmin(req, res, next) {
  const originalRender = res.render.bind(res);

  res.render = function (view, options, callback) {
    let renderOptions = options;
    let renderCallback = callback;

    if (typeof renderOptions === 'function') {
      renderCallback = renderOptions;
      renderOptions = {};
    }

    if (!renderOptions || typeof renderOptions !== 'object') {
      renderOptions = {};
    }

    if (!req.session.user || !req.session.user.isAdmin) {
      if (res.headersSent) return;
      return originalRender(view, renderOptions, renderCallback);
    }

    usersDb.getAllOrganizations()
      .then((orgs) => {
        if (res.headersSent) return;
        const organizations = Array.isArray(orgs) ? orgs : [];
        renderOptions.organizations = customOrgSorting(organizations);
        renderOptions.admin = true;
        const selectedOrgId = req.session.user?.organization;
        if (selectedOrgId) {
          const selectedOrg = organizations.find(o => o.id === selectedOrgId || o.id === parseInt(selectedOrgId, 10));
          renderOptions.selectedOrgIdent = selectedOrg?.ident?.toUpperCase() || null;
        }
        originalRender(view, renderOptions, renderCallback);
      })
      .catch((error) => {
        if (res.headersSent) return;
        log('Error fetching organizations:', error);
        renderOptions.organizations = [];
        renderOptions.admin = true;
        originalRender(view, renderOptions, renderCallback);
      });
  };

  next();
}


function requirePermission(req, res, next) {
  if (req.session.user?.isOwner) {
    return next();
  }
  const sessionShow = req.session.user?.showPrices;
  const paramShow = req.session.user?.showPricesOnce ?? false;
  log('sessionShow', sessionShow, 'paramShow', paramShow, "REQUIRE PERMISSION");
  if (!sessionShow && !paramShow) {
    return res.redirect("/user/no-permission");
  }

  next();
}

/**
 * Konto biura: zlecenie musi należeć do klienta z jego listy (services/staffAccess.js).
 * Kontekst wyrównujemy do właściciela zlecenia — jak admin w GET /orders/order/:id —
 * żeby `getCurrentUser` na trasach zlecenia wskazywał klienta TEGO zlecenia
 * (adresy, mail potwierdzenia, cenniki), a nie ostatnio wybranego.
 */
async function staffOrderAccess(req, res, orderId) {
  const owner = await staffAccess.canAccessOrder(req.session.user.userId, orderId);
  if (!owner) return false;
  // Audyt „kto z biura ostatni zmieniał" — każda udana zmiana zlecenia lub pozycji.
  // Kopia („Zamów ponownie") nie zmienia źródła; nowe zlecenie dostaje autora w trasie.
  if (req.method !== 'GET' && res?.on && !String(req.originalUrl || '').startsWith('/orders/copy/')) {
    const staffUserId = req.session.user.userId;
    res.on('finish', () => {
      if (res.statusCode < 400) staffAudit.markUpdatedByStaff(orderId, staffUserId);
    });
  }
  if (req.session.context_user?.userId !== owner.userId) {
    const ctx = await ownerService.setContextUserByIdent(req, owner.ident);
    if (!ctx || ctx.userId !== owner.userId) {
      ownerService.clearContextUser(req);
      return false;
    }
    if (res?.locals) {
      // `applySubPriceLocals` i pasek kontekstu policzyły się wcześniej (server.js) ze starym kontekstem.
      applySubPriceLocals(req, res);
      res.locals.staffContext = { ident: ctx.ident, clientName: ctx.clientName, organization: ctx.organization };
    }
  }
  return true;
}

/**
 * Czy zalogowany może działać na zleceniu: owner/admin — każde, konto biura —
 * zlecenia dozwolonych klientów, sklep grupy — swoje (`group_user_id`),
 * reszta — własne (`order.user_id`). Wspólne dla `checkOrderOwnership`
 * i tras `/position/*`, które zlecenie biorą z treści żądania albo z pozycji.
 */
async function hasOrderAccess(req, res, orderId) {
  const user = req.session?.user;
  if (!user) return false;
  if (user.isOwner) return true;
  if (user.isStaff) return staffOrderAccess(req, res, orderId);
  if (user.isGroupShop) {
    if (!user.groupShopId) return false;
    return !!(await db.checkGroupShopOrderOwner(orderId, user.groupShopId));
  }
  if (!user.userId) return false;
  return !!(await db.checkOwner(orderId, user.userId));
}

async function checkOrderOwnership(req, res, next) {
  try {
    if (!(await hasOrderAccess(req, res, req.params.orderId))) {
      return res.redirect('/user/no-permission');
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function isOwner(owner) {
  try {
    if (!owner || !owner.orgIdent || !owner.userIdent) {
      log("Missing identifiers: ident or ownerIdent");
      return false;
    }
    log(JSON.stringify(owner), 'in isOwner function');
    return owner.orgIdent.toUpperCase() === owner.userIdent.toUpperCase();
  } catch (error) {
    log("Error in isOwner function:", error);
    return false;
  }
}

function requireOwner(req, res, next) {
  if (!req.session.user?.isOwner) {
    return res.status(403).json({
      success: false,
      message: "Access denied. Owner privileges required."
    });
  }
  next();
}

function requireGroup(req, res, next) {
  const isGroup = req.session.user?.isGroup || req.session.context_user?.isGroup || false;
  if (!isGroup) {
    return res.redirect('/user/no-permission');
  }
  next();
}

function requireGroupShop(req, res, next) {
  if (!req.session.user?.isGroupShop) {
    return res.redirect('/user/no-permission');
  }
  next();
}

module.exports = { requireLogin, requirePermission, checkOrderOwnership, hasOrderAccess, isOwner, requireOwner, requireGroup, requireGroupShop, addOrganizationsForAdmin };