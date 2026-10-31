const express = require('express');
const router = express.Router();
const demoMode = require('../services/demoMode');
const { buildOwnerSession } = require('../services/authService');
const { log } = require('../utils/logging');

// Formularz demo to druga odsłona strony logowania (`templates/login.njk`).
function renderForm(req, res, status = 200, values = {}, errors = []) {
	return res.status(status).render('login.njk', {
		demoForm: true,
		values,
		errors,
		countries: demoMode.countryOptions(req.getLocale())
	});
}

const COUNTRY_BY_LOCALE = { pl: 'PL', de: 'DE', nl: 'NL', fr: 'FR' };

router.get('/', (req, res) => renderForm(req, res, 200, { country: COUNTRY_BY_LOCALE[req.getLocale()] }));

router.post('/', async (req, res, next) => {
	try {
		const { values, errors } = demoMode.validateDemoForm(req.body);
		if (errors.length) return renderForm(req, res, 400, values, errors);

		// `req.ip`, nie getClientIp: ten ufa X-Forwarded-For od klienta, a limit
		// ma być nie do obejścia nagłówkiem (za proxy działa `trust proxy`).
		const ip = req.ip;
		if (!demoMode.takeIpSlot(ip)) return renderForm(req, res, 429, values, ['demo.error_limit']);

		// Drugie demo z tej samej przeglądarki — poprzednie konto od razu do kosza.
		if (req.session.user?.isDemo) await demoMode.purgeDemoUsers([req.session.user.userId]);

		const account = await demoMode.createDemoAccount(values);
		if (!account) return renderForm(req, res, 503, values, ['demo.error_limit']);

		await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
		if (!(await buildOwnerSession(req, account.pin, account.password))) {
			throw new Error(`[demo] nie udało się zbudować sesji dla ${account.ident}`);
		}
		// Ceny widoczne od razu — klient demo nie zna hasła do kłódki.
		Object.assign(req.session.user, { isDemo: true, showPrices: true });
		req.session.demoExpiresAt = Date.now() + demoMode.DEMO_SESSION_MS;
		req.session.mustAcceptRODO = false;

		log(`[demo] nowe konto ${account.ident} (${values.country}) z IP ${ip}`);
		return res.redirect('/');
	} catch (err) {
		return next(err);
	}
});

module.exports = router;
