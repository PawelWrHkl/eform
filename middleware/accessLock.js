const accessLock = require('../services/accessLock');

const PUBLIC_PREFIXES = [
  '/styles/',
  '/scripts/',
  '/img/',
  '/photos/',
  '/data/',
  '/change-language',
  '/translations',
  '/languages',
  '/env',
  // Film wysłany linkiem komuś spoza eForm działa także w czasie przerwy technicznej
  '/film/'
];

function isPublicWhenBlocked(req) {
  const url = req.originalUrl.split('?')[0];
  if (PUBLIC_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return true;
  }
  if (url === '/user/login' && req.method === 'GET') {
    return true;
  }
  if (url === '/user/auth/login') {
    return true;
  }
  return false;
}

function enforceAccessLock(req, res, next) {
  if (!accessLock.isBlocked()) {
    return next();
  }

  if (req.session?.user?.isAdmin) {
    return next();
  }

  const url = req.originalUrl.split('?')[0];

  if (url === '/user/login' && req.method === 'GET') {
    return next();
  }

  if (isPublicWhenBlocked(req)) {
    return next();
  }

  if (req.session?.user) {
    return req.session.destroy(() => {
      if (res.headersSent) return;
      res.redirect('/user/login?message=login.technical_break');
    });
  }

  if (req.xhr || req.headers.accept?.includes('application/json')) {
    if (res.headersSent) return;
    return res.status(503).json({
      success: false,
      message: 'login.technical_break'
    });
  }

  if (res.headersSent) return;
  return res.redirect('/user/login?message=login.technical_break');
}

module.exports = { enforceAccessLock };
