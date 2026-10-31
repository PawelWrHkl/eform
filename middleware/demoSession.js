const demoMode = require('../services/demoMode');
const { log } = require('../utils/logging');

/**
 * Sesja demo żyje najwyżej 8 h od założenia konta. Ciasteczko sesji samo tego
 * nie zapewni — każda zmiana sesji przesuwa jego ważność — dlatego termin
 * sprawdzamy przy każdym żądaniu, a po jego upływie usuwamy konto z danymi.
 */
async function demoSessionGuard(req, res, next) {
	const user = req.session?.user;
	res.locals.isDemo = !!user?.isDemo;
	if (!user?.isDemo) return next();

	const expiresAt = req.session.demoExpiresAt || 0;
	if (Date.now() < expiresAt) {
		res.locals.demoExpiresLabel = new Date(expiresAt).toLocaleTimeString(res.locals.locale || 'pl', {
			hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw'
		});
		return next();
	}

	try {
		await demoMode.purgeDemoUsers([user.userId]);
	} catch (err) {
		// Konto i tak usunie zamiatarka (services/demoMode.js startDemoSweeper).
		log('[demo] nie udało się usunąć wygasłego konta demo:', err.message);
	}
	req.session.destroy(() => res.redirect('/user/login'));
}

module.exports = { demoSessionGuard };
