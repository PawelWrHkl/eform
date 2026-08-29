const express = require('express');
const router = express.Router();
const { requireLogin, requireOwner } = require('../middleware/loginMixture');
const authService = require('../services/authService')
const ownerService = require('../services/owner.js');
const logService = require('../services/logService.js');
const db = require("../db/db_helper.js");
const langManager = require('../services/setLanguage')
const langVer = require('../services/languageManager')
const { dataDir, localesDir } = require('../config');
const path = require("path");
const { updateClients } = require('../services/dbUserSync');
const { get } = require('lodash');
const hashUser = require('../utils/hashUser').hashUser;
const { log } = require('../utils/logging');
const { getActiveGroupShopId } = require('../services/groupContext');
const { GROUP_TYPE_CLIENT } = require('../services/groupType');

let clientsUpdateRunning = false;

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


router.get("/login", (req, res) => {
    if (process.env.autolog === "true") {
        const loginPath = `${req.baseUrl}/auth/login?pin=admin&password=eforszef123`;
        return res.redirect(loginPath);
    }
    if (!clientsUpdateRunning) {
        clientsUpdateRunning = true;
        updateClients()
            .catch((err) => log('updateClients on login:', err.message))
            .finally(() => { clientsUpdateRunning = false; });
    }
    res.render("login.njk", { message: req.query.message || undefined });
});

router.get("/org-pwd", requireLogin, requireOwner, async (req, res, next) => {
    try {
        const orgId = req.session.user.orgId;
        const isAdmin = req.session.user.isAdmin || false;
        const users = await db.getUsersFromUsrtblpsswd(orgId, isAdmin);

        const orgInfo = await db.getOrgInfo(orgId);
        const orgIdent = orgInfo ? orgInfo.ident.toLowerCase() : 'default';

        const recentClients = await db.getRecentClients(req.session.user.userId);
        const recentIdents = recentClients.map(c => c.ident);

        res.render("owner/pwds.njk", { users, orgIdent, recentIdents });
    } catch (err) {
        log('Error loading passwords page:', err);
        next(err);
    }
});


router.post("/accept-rodo", async (req, res, next) => {
    try {
        const { accepted } = req.body;
        if (accepted) {
            const currentUser = ownerService.getCurrentUser(req);
            const pin = currentUser.pin;
            await db.setUserAcceptedRODO(pin, true);
            req.session.mustAcceptRODO = false;
            return res.status(200).json({ message: "RODO accepted" });
        } else {
            req.session.destroy((err) => {
                if (err) {
                    log("Error destroying session:", err);
                    return res.status(500).json({ message: "Error accepting RODO" });
                }
                return res.status(200).json({ message: "RODO not accepted" });
            });
            return res.status(400).json({ message: "RODO not accepted" });
        }
    } catch (err) {
        log(err);
        return next(err);
    }
});




router.get("/auth/login", async (req, res, next) => {
    const { pin, password } = req.query;

    if (!pin || !password) {
        return res.redirect(`${req.baseUrl}/login`);
    }

    // Sprawdź najpierw czy to sklep grupy (group_user)
    const shopLogin = await authService.handleGroupShopLogin(req, res, next, pin, password);
    if (shopLogin === true) {
        return res.redirect("/");
    }

    return authService.handleAuthLogin(req, res, next, pin, password);
});

router.post("/auth/login", async (req, res, next) => {
    const { pin, password } = req.body;

    const shopLogin = await authService.handleGroupShopLogin(req, res, next, pin, password);
    if (shopLogin === true) {
        return res.redirect("/");
    }

    return authService.handleAuthLogin(req, res, next, pin, password);
});

router.get('/edit-user', requireLogin, async (req, res) => {
    let currentUser = ownerService.getCurrentUser(req);
    let user = await db.getUserData(currentUser.pin);
    const success = req.query.success === '1';
    return res.render('edit_user.njk', { user, success });
});

router.post('/update-user', requireLogin, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const pin = currentUser.pin;

        const { tax_id, street, zip, city, email } = req.body;

        if (!tax_id || !street || !zip || !city || !email) {
            return res.status(400).render('edit_user.njk', {
                user: await db.getUserData(pin),
                error: 'Wszystkie pola są wymagane'
            });
        }

        const trimmedData = {
            tax_id: tax_id.trim(),
            street: street.trim(),
            zip: zip.trim(),
            city: city.trim(),
            email: email.trim()
        };

        if (!trimmedData.tax_id || !trimmedData.street || !trimmedData.zip || !trimmedData.city || !trimmedData.email) {
            return res.status(400).render('edit_user.njk', {
                user: await db.getUserData(pin),
                error: 'Żadne pole nie może być puste'
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedData.email)) {
            return res.status(400).render('edit_user.njk', {
                user: await db.getUserData(pin),
                error: 'Nieprawidłowy format adresu email'
            });
        }

        await db.updateUserData(pin, trimmedData);

        // Formularz w panelu użytkownika (`templates/panel/panel.njk`) chce
        // wrócić na swoją zakładkę zamiast na stronę główną — walidacja
        // ogranicza się do ścieżki wewnętrznej (`/coś`, nie `//host` ani
        // `http://...`), żeby to pole z formularza nie stało się open redirectem.
        const { redirectTo } = req.body;
        const isSafeInternalPath = typeof redirectTo === 'string'
            && redirectTo.startsWith('/')
            && !redirectTo.startsWith('//');
        return res.redirect(isSafeInternalPath ? redirectTo : '/');
    } catch (err) {
        log('Error updating user:', err);
        return res.status(500).render('edit_user.njk', {
            user: await db.getUserData(req.session.user.pin),
            error: 'Błąd podczas aktualizacji danych użytkownika'
        });
    }
});


router.get('/tutorial', requireLogin, async (req, res) => {
    return res.render('tutorial.njk');
});


router.get('/employee-info'), requireLogin, async (req, res) => {
    if (req.session.user.isEmployee) {
        return res.json({
            success: true,
            employee: req.session.employee
        });
    } else {
        return res.json({
            success: false,
            message: 'Użytkownik nie jest pracownikiem'
        });
    }
}


router.get('/logo', requireLogin, async (req, res) => {
    const currentUser = ownerService.getCurrentUser(req);
    const pin = currentUser.pin;

    let photoFilename;
    const role = await db.getUserRole(pin);

    if (role === 'group') {
        photoFilename = await db.getUserPhoto(pin);
    }

    if (!photoFilename) {
        if (req.session.user?.isAdmin) {
            photoFilename = await db.getLogo(req.session.user.organization);
        } else {
            photoFilename = await db.getUserLogo(pin);
        }
    }

    const photoPath = path.join(__dirname, '..', 'img', photoFilename);
    res.sendFile(photoPath);
})


router.post("/logout", requireLogin, (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.redirect("/");
        // ⚠️ Wcześniej dev/test/archive przekierowywały na SZTYWNY adres
        // `http://192.168.0.8` — czyli na PORT 80, gdzie odpowiada inna
        // instancja aplikacji. Sesja na :8000/:8081 była niszczona poprawnie,
        // ale przeglądarka lądowała pod innym adresem (często z własną, wciąż
        // ważną sesją), więc wylogowanie wyglądało na niedziałające.
        // Zostajemy na TYM SAMYM origin — użytkownik widzi ekran logowania
        // instancji, z której faktycznie się wylogował.
        res.redirect("/user/login");
    });
});


router.get('/no-permission', requireLogin, async (req, res) => {
    return res.render('no-permission.njk');
});

router.get('/session-check', (req, res) => {
    if (req.session && req.session.user) {
        return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ ok: false });
});


router.get('/rodo', requireLogin, async (req, res) => {
    const currentUser = ownerService.getCurrentUser(req);
    const pin = currentUser.pin;

    return res.render('rodo.njk');
});


router.get('/owner/', requireLogin, async (req, res) => {
    const currentUser = ownerService.getCurrentUser(req);
    const pin = currentUser.pin

    let response = await db.getOwner(pin);
    if (response) {
        return res.status(200).json({
            success: true,
            idents: response
        });
    }
    else {
        return res.status(400).json({
            success: false,
            message: `Nie znaleziono Pozycji`
        })
    }
})


router.get('/name', requireLogin, async (req, res) => {

    const pin = req.session.user.pin;
    const mailAdresses = await db.getUserMail(pin)
    let shopName = null;
    let email = mailAdresses?.user_email || '';

    // `isGroupShop` łapie tylko konto podrzędne zalogowane samo — grupa-matka
    // pracująca w kontekście wybranego konta (dropdown przy zakładaniu
    // zamówienia, `services/groupContext.js`) miała tu zawsze `shopName = null`,
    // więc navbar pokazywał starą treść mimo wybranego „zarejestrowanego klienta".
    const activeGroupShopId = req.session.user?.isGroupShop
        ? req.session.user.groupShopId
        : getActiveGroupShopId(req);
    if (activeGroupShopId) {
        const shop = await db.getGroupUserById(activeGroupShopId);
        shopName = shop?.name || shop?.ident || req.session.user.shopName || null;
        email = shop?.email || email;
    }


    let response = await db.getUserName(pin);

    if (response) {
        return res.status(200).json({
            success: true,
            name: response,
            pin: pin,
            email,
            shopName
        });
    }
    else {
        return res.status(400).json({
            success: false,
            message: `Nie znaleziono Nazwy`
        })
    }
});


/**
 * Sprawdzenie hasła KONTA Z BIEŻĄCEJ SESJI — bez zmiany czegokolwiek w sesji.
 *
 * ⚠️ Nie to samo co `/auth/check-password`: tamto odsłania ceny na stałe
 * (`showPrices`) i sprawdza hasło z `session.user.pin`, a dla konta podrzędnego
 * grupy `pin` należy do grupy-MATKI — klient końcowy nie zna tego hasła. Tutaj
 * dla `isGroupShop` weryfikujemy `group_user.password` (własne hasło logowania
 * klienta), a dla pozostałych `user.password`.
 *
 * Używane przez kłódkę rabatu klienta (`public/scripts/order.js`): odpowiedź to
 * wyłącznie `{ success }`, bez żadnych danych o koncie.
 */
router.post("/auth/check-login-password", requireLogin, async (req, res) => {
    try {
        const password = req.body?.password;
        if (!password) {
            return res.json({ success: false });
        }

        // Admin w kontekście grupy-matki typu `client` (np. wgląd w Lipkę) nie zna
        // hasła klienta — kłódka rabatu przyjmuje wtedy dowolne (niepuste) hasło,
        // żeby admin mógł podejrzeć widok bez znajomości hasła klienta. Dotyczy
        // TYLKO grupy-matki (nie konta podrzędnego — `getActiveGroupShopId`
        // wskazuje wtedy wybrany sklep i tam nadal wymagamy prawdziwego hasła).
        const contextUser = req.session.context_user;
        if (req.session.user?.isAdmin && contextUser?.isGroup
            && contextUser.groupType === GROUP_TYPE_CLIENT
            && !getActiveGroupShopId(req)) {
            return res.json({ success: true });
        }

        if (req.session.user?.isGroupShop) {
            const shop = await db.getGroupUserById(req.session.user.groupShopId);
            if (!shop) return res.json({ success: false });
            const valid = await authService.checkGroupShopPassword(shop.pin, password);
            return res.json({ success: !!valid });
        }

        const valid = await authService.checkPassword(req.session.user?.pin, password);
        return res.json({ success: !!valid });
    } catch (err) {
        log('[users/auth/check-login-password] Error:', err.message);
        return res.status(500).json({ success: false });
    }
});

router.post("/auth/check-password", async (req, res, next) => {
    try {
        const { password, remember, orderId } = req.body;
        const currentUser = req.session.user
        const pin = currentUser.pin;
        const role = await db.getUserRole(pin);
        let isValid = await authService.checkPassword(pin, password);
        if (role === 'admin') {
            isValid = true;
        }
        let redirectUrl;

        if (isValid) {
            if (remember) {
                req.session.user.showPrices = true;
            } else {
                req.session.user.showPrices = false;
                req.session.user.showPricesOnce = true;

            }
            return res.status(200).json({
                success: true
            });
        } else {
            return res.status(200).json({
                success: false
            })
        }
    } catch (err) {
        return next(err);
    }
});
router.get('/isOwner', requireLogin, async (req, res) => {
    return res.status(200).json({
        success: true,
        name: response
    });
});


router.get('/employee-panel', requireLogin, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const userId = currentUser.userId;

        const employees = await db.getEmployeesByUserId(userId);

        return res.render("user/user_panel.njk", { employees });
    } catch (err) {
        log('Error loading employee panel:', err);
        return res.status(500).render('error.njk', { message: 'Błąd podczas ładowania panelu pracowników' });
    }
});


router.get('/employees', requireLogin, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const userId = currentUser.userId;

        const employees = await db.getEmployeesByUserId(userId);

        return res.status(200).json({
            success: true,
            employees
        });
    } catch (err) {
        log('Error fetching employees:', err);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas pobierania pracowników'
        });
    }
});


router.get('/employee/add', requireLogin, async (req, res) => {
    return res.render("user/add_employee.njk");
});


router.post('/employee/add', requireLogin, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const userId = currentUser.userId;

        const { name, surname, login, password, phone, can_send_orders, can_see_prices, can_see_all_orders } = req.body;

        if (!name || !surname || !login || !password) {
            return res.status(400).json({
                success: false,
                message: 'Wszystkie pola są wymagane'
            });
        }

        const employeeData = {
            name,
            surname,
            login,
            password,
            phone: phone || '',
            userId,
            can_send_orders: parseInt(can_send_orders) || 0,
            can_see_prices: parseInt(can_see_prices) || 0,
            can_see_all_orders: parseInt(can_see_all_orders) || 0
        };
        const employeeId = await db.addEmployee(employeeData);
        if (employeeId.success == false) {
            if (employeeId.info == 'USER_EXISTS') {
                return res.status(400).json({
                    success: false,
                    message: 'Użytkownik o podanym loginie już istnieje'
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Pracownik został dodany',
            employeeId,
            redirect: '/user/employee-panel'
        });
    } catch (err) {
        log('Error adding employee:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Błąd podczas dodawania pracownika'
        });
    }
});


router.get('/employee/edit/:id', requireLogin, async (req, res) => {
    const empDetails = await db.getEmployeeById(req.params.id);
    const permissions = await db.getEmployeePermissions(req.params.id);
    return res.render("user/edit_employee.njk", { employee: empDetails, permissions });
});


router.post('/employee/edit/:id', requireLogin, async (req, res) => {
    try {
        const employeeId = req.params.id;
        const currentUser = ownerService.getCurrentUser(req);
        const userId = currentUser.userId;
        const employee = await db.getEmployeeById(employeeId);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Pracownik nie znaleziony'
            });
        }

        if (employee.user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Brak uprawnień'
            });
        }

        const { name, surname, login, password, phone, can_send_orders, can_see_prices, can_see_all_orders } = req.body;

        // Aktualizacja danych osobowych — tylko gdy przesłano name (pełna edycja z formularza)
        if (name) {
            const updatedData = {
                name,
                surname,
                login,
                phone: phone || ''
            };

            if (password && password.trim() !== '') {
                updatedData.password = password;
            }

            await db.updateEmployee(employeeId, updatedData);
        }

        // Aktualizacja uprawnień pracownika
        const permissions = {
            can_send_orders: parseInt(can_send_orders) === 1 ? 1 : 0,
            can_see_prices: parseInt(can_see_prices) === 1 ? 1 : 0,
            can_see_all_orders: parseInt(can_see_all_orders) === 1 ? 1 : 0
        };
        await db.updateEmployeePermissions(employeeId, permissions);

        return res.status(200).json({
            success: true,
            message: 'Pracownik został zaktualizowany'
        });
    } catch (err) {
        log('Error updating employee:', err);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas aktualizacji pracownika'
        });
    }
});


router.post('/employee/:id/price-factor', requireLogin, async (req, res) => {
    try {
        const employeeId = req.params.id;
        const currentUser = ownerService.getCurrentUser(req);
        const userId = currentUser.userId;
        const employee = await db.getEmployeeById(employeeId);

        if (!employee) {
            return res.status(404).json({ success: false, message: 'Pracownik nie znaleziony' });
        }
        if (employee.user_id !== userId) {
            return res.status(403).json({ success: false, message: 'Brak uprawnień' });
        }

        const { price_factor } = req.body;
        await db.updateEmployeePriceFactor(employeeId, price_factor);

        return res.status(200).json({ success: true, message: 'Faktor cen zapisany' });
    } catch (err) {
        log('Error updating price factor:', err);
        return res.status(500).json({ success: false, message: err.message || 'Błąd zapisu' });
    }
});


router.delete('/employee/:id', requireLogin, async (req, res) => {
    try {
        const employeeId = req.params.id;
        const currentUser = ownerService.getCurrentUser(req);
        const userId = currentUser.userId;
        const employee = await db.getEmployeeById(employeeId);

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Pracownik nie znaleziony'
            });
        }

        if (employee.user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Brak uprawnień'
            });
        }
        await db.deleteEmployee(employeeId);
        return res.status(200).json({
            success: true,
            message: 'Pracownik został usunięty'
        });
    } catch (err) {
        log('Error deleting employee:', err);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas usuwania pracownika'
        });
    }
});

router.get('/employee/:id/orders', requireLogin, async (req, res) => {
    try {
        const employeeId = req.params.id;
        const currentUser = ownerService.getCurrentUser(req);
        const userId = currentUser.userId;

        const employee = await db.getEmployeeById(employeeId);

        if (!employee) {
            return res.status(404).render('error.njk', { message: 'Pracownik nie znaleziony' });
        }

        if (employee.user_id !== userId) {
            return res.status(403).render('error.njk', { message: 'Brak uprawnień' });
        }

        const orders = await db.getEmployeeOrders(employeeId);
        const ordersCount = await db.countEmployeeOrders(employeeId);

        return res.render("user/employee_orders.njk", {
            employee,
            orders,
            ordersCount
        });
    } catch (err) {
        log('Error loading employee orders:', err);
        return res.status(500).render('error.njk', { message: 'Błąd podczas ładowania zamówień' });
    }
});

router.get('/employee-panel', requireLogin, async (req, res) => {
    return res.render("user/user_panel.njk");
});


router.get('/uid', requireLogin, async (req, res) => {
    try {
        const contextUser = ownerService.getCurrentUser(req);
        console.log('🔍 [/uid] contextUser:', contextUser);

        if (!contextUser || !contextUser.pin) {
            console.error('❌ [/uid] No contextUser or pin');
            return res.json({ success: false, message: 'Użytkownik nie zalogowany' });
        }

        const ident = await db.getUserIdent(contextUser.pin);
        console.log('🔍 [/uid] ident:', ident);

        if (!ident) {
            console.error('❌ [/uid] ident is empty for pin:', contextUser.pin);
            return res.json({ success: false, message: 'Nie znaleziono identyfikatora użytkownika' });
        }

        const uid = hashUser(ident);
        console.log('✅ [/uid] uid generated:', uid);
        return res.json({ success: true, uid: uid });
    } catch (error) {
        console.error('❌ [/uid] Error:', error);
        return res.json({ success: false, message: error.message });
    }
});

router.post('/set-intro-done', requireLogin, async (req, res) => {
    try {
        const pin = req.session.user.pin;
        await db.setIntroNeeded(pin);
        req.session.user.introNeeded = false;
        return res.json({ status: 'success' });
    } catch (err) {
        log('Error setting intro done:', err);
        return res.status(500).json({ status: 'error' });
    }
});

router.post('/enable-intro', requireLogin, async (req, res) => {
    try {
        const pin = req.session.user.pin;
        await db.enableIntroNeeded(pin);
        req.session.user.introNeeded = true;
        return res.json({ status: 'success' });
    } catch (err) {
        log('Error enabling intro:', err);
        return res.status(500).json({ status: 'error' });
    }
});

module.exports = router;