const db = require("../db/db_helper.js");
const dateUtils = require('../utils/humanize_date.js')
const bcrypt = require("bcryptjs");
const { requireLogin, isOwner } = require('../middleware/loginMixture');
const logService = require('../services/logService.js');
const langManager = require('../services/setLanguage')
const langVer = require('../services/languageManager')
const { dataDir, localesDir } = require('../config');
const { log } = require('../utils/logging');
const { rejectIfBlockedForLogin } = require('./accessLockAuth');
const { syncUserCountry } = require('./dbUserSync');

async function handleAuthLogin(req, res, next, pin, password) {
    try {
        if (await rejectIfBlockedForLogin(req, res, pin)) {
            return;
        }
        const isValid = await checkPassword(pin, password);
        const isEmployeeLogin = await checkEmployeePassword(pin, password);
        if (isValid) {
            const isFirst = await checkFirstLogon(pin)
            let owner = await db.getOwner(pin);

            if (!owner) {
                return res.render("login.njk", { message: "login.incorrect_data" });
            }

            const userId = await db.getUserId(pin)
            req.session.user = { userId, pin, password, showPrices: false, organization: (owner.orgIdent).toUpperCase(), orgId: owner.orgId, ident: owner.userIdent };
            req.session.user.isOwner = await isOwner(owner);
            const role = await db.getUserRole(pin);
            req.session.user.isAdmin = role === "admin";
            req.session.user.isGroup = role === "group";

            await logService.logUserLogin(pin, await db.getUserIdent(pin));
            // Fire-and-forget: refreshes user.country from contractors.txt's "kraj"
            // column on every login, without adding file-read/parse latency to it.
            syncUserCountry(pin).catch((err) => log('syncUserCountry failed:', err.message));
            langVer.checkTranslateLegacy(localesDir)
            let lang;
            try {
                lang = await db.getLanguage(pin)
            }
            catch {
                lang = 'en'
            }
            if (!req.cookies.lang) {
                langManager.setLang(lang, res)
            }
            req.session.mustAcceptRODO = isFirst;

            if (req.session.user.isAdmin) {
                req.session.user.isOwner = true;
            }

            return res.redirect("/");

        } else if (isEmployeeLogin) {
            const employee = await db.getEmployeeByLogin(pin);
            const user = await db.getUserByEmployye(pin);

            if (!user) {
                return res.render("login.njk", { message: "login.incorrect_data" });
            }

            const organization = await db.getOwner(user.pin);

            if (!organization) {
                return res.render("login.njk", { message: "login.incorrect_data" });
            }
            req.session.user = { pin: user.pin, password: user.password, showPrices: false, organization: organization.orgId, userId: user.id };
            req.session.user.isOwner = false;
            req.session.user.isEmployee = true;
            req.session.employee = { name: employee.name, surname: employee.surname, id: employee.id, login: employee.login, phone: employee.phone };

            // Załadowanie uprawnień pracownika do sesji przy logowaniu
            const permissions = await db.getEmployeePermissionsByLogin(pin);
            req.session.employeePermissions = {
                can_send_orders: permissions ? permissions.can_send_orders === 1 : false,
                can_see_prices: permissions ? permissions.can_see_prices === 1 : false,
                can_see_all_orders: permissions ? permissions.can_see_all_orders === 1 : false,
                price_factor: permissions ? (parseFloat(permissions.price_factor) || 1.0) : 1.0
            };

            logEmployeeLogin = await db.logEmployeeLogin(employee.id);

            req.session.mustAcceptRODO = false;
            return res.redirect("/");
        } else {
            return res.render("login.njk", { message: "login.incorrect_data" });
        }
    } catch (err) {
        return next(err);
    }
}

async function checkPassword(pin, password) {
	const dbPassword = await db.getDbPassword(pin);
	if (dbPassword) {
		if (bcrypt.compareSync(password, dbPassword)) {
			log("Hasło poprawne");
			return true;
		}
		else if (password === dbPassword) {
			log("Hasło poprawne (bez haszowania)");
			return true;
		}

	} else {
		log("Nie ma takiego użytkownika");
		return false;
	}
}

async function checkFirstLogon(pin) {
	const firstLoginDate = await db.getFirstLogonInfo(pin)
	if (!firstLoginDate) {
		const data = await db.uodateFirstLogonInfo(pin)
		return true

	}
	else {
		const isPolicyAccepted = await db.getPolicyState(pin)
		log(isPolicyAccepted, 'is policy accepted')
		return isPolicyAccepted ? false : true
	}
}

async function checkEmployeePassword(login, password) {
	const employee = await db.getEmployeeByLogin(login);
	if (!employee) {
		log("Nie ma takiego pracownika");
		return { valid: false, employee: null };
	}


	if (password === employee.password) {
		log("Hasło pracownika poprawne (bez hashowania)");
		return { valid: true, employee };
	}


	if (bcrypt.compareSync(password, employee.password)) {
		log("Hasło pracownika poprawne (bcrypt)");
		return { valid: true, employee };
	}

	log("Hasło pracownika nieprawidłowe");
	return { valid: false, employee: null };
}


async function checkGroupShopPassword(login, password) {
    const shop = await db.getGroupUserByLogin(login);
    if (!shop) return null;

    if (bcrypt.compareSync(password, shop.password) || password === shop.password) {
        return shop;
    }
    return null;
}

async function handleGroupShopLogin(req, res, next, login, password) {
    try {
        if (await rejectIfBlockedForLogin(req, res, login)) {
            return null;
        }
        const shop = await checkGroupShopPassword(login, password);
        if (!shop) return null; // caller falls through to normal flow

        // Pobierz dane parent usera (TCN) żeby mieć organizację i pin
        const parentPin = await db.getUserPinById(shop.user_id);
        if (!parentPin) return null;

        const owner = await db.getOwner(parentPin);
        if (!owner) return null;

        req.session.user = {
            userId: shop.user_id,
            pin: parentPin,
            showPrices: false,
            organization: owner.orgIdent ? owner.orgIdent.toUpperCase() : '',
            orgId: owner.orgId,
            ident: shop.ident,
            isOwner: false,
            isAdmin: false,
            isGroup: false,
            isGroupShop: true,
            groupShopId: shop.id,
            shopNumber: shop.id,
            shopName: shop.name || shop.ident,
        };
        req.session.mustAcceptRODO = false;
        return true;
    } catch (err) {
        log('[authService] handleGroupShopLogin error:', err.message);
        return null;
    }
}

module.exports = { checkPassword, checkFirstLogon, checkEmployeePassword, handleAuthLogin, handleGroupShopLogin };
