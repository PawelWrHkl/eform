const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/loginMixture');
const logService = require('../services/logService.js');
const { formatLoginTime } = require('../utils/humanize_date.js');
const db = require("../db/db_helper.js");
const reportsDb = require("../db/admin/reports.js");
const { log } = require('../utils/logging');
const sessionService = require('../services/sessionService');
const accessLock = require('../services/accessLock');
const portalDiscountSwitch = require('../services/portalUsageDiscountSwitch');
const orderCorrectionsRoutes = require('./admin/orderCorrections');
const userAdminDb = require('../db/admin/userAdmin');
const userAdminService = require('../services/admin/userAdminService');

/** Sposób fakturowania klienta (`user.invoice_schedule`) — puste = standard. */
const INVOICE_SCHEDULE_OPTIONS = [
    { value: '', label: 'Standardowe', hint: 'Osobna faktura za każde zlecenie zaraz po wysyłce (!sent!).' },
    { value: 'weekly', label: 'Tygodniowe', hint: 'Jedna faktura zbiorcza ze wszystkich zleceń wysłanych w tygodniu (pon–nd), wystawiana we wtorek.' },
    { value: 'monthly', label: 'Miesięczne', hint: 'Jedna faktura zbiorcza ze wszystkich zleceń wysłanych w miesiącu, wystawiana 2. dnia następnego miesiąca.' }
];
const groupPriceMode = require('../services/groupPriceMode');
const { availabeLanguages } = require('../config');

router.use(async (req, res, next) => {
    if (req.session.user?.isOwner) {
        try {
            res.locals.users = await db.getUsersByOwner(req);
        } catch (error) {
            log('Error loading users for owner:', error);
            res.locals.users = [];
        }
    }
    next();
});


function requireAdmin(req, res, next) {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).render('no-permission.njk');
    }
    next();
}

function requireReportsApiAccess(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: 'Sesja wygasła. Zaloguj się ponownie.' });
    }

    if (!req.session.user.isAdmin) {
        return res.status(403).json({ success: false, message: 'Brak uprawnień do raportów.' });
    }

    next();
}

router.use('/order-corrections', orderCorrectionsRoutes);

router.get('/', requireLogin, requireAdmin, async (req, res) => {
    res.render('admin/admin_panel.njk', {
        accessBlocked: accessLock.isBlocked(),
        portalDiscountEnabled: portalDiscountSwitch.isEnabled()
    });
});

/**
 * Przełącznik rabatu 1% za korzystanie z serwisu
 * (`services/portalUsageDiscount.js`). Stan trzyma plik w `dataDir`, czytany
 * przy każdym wyliczeniu rabatu — zmiana działa od następnego przeliczenia
 * formularza, bez restartu.
 *
 * ⚠️ Wyłączenie NIE rusza zamówień już wysłanych: mają rabat policzony
 * i zapisany w swoich pozycjach. Dotyczy tego, co liczy się od teraz.
 */
router.get('/portal-discount', requireLogin, requireAdmin, (req, res) => {
    res.json({ success: true, ...portalDiscountSwitch.getState() });
});

router.post('/portal-discount', requireLogin, requireAdmin, (req, res) => {
    try {
        const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
        const state = portalDiscountSwitch.setEnabled(enabled);
        log(`Rabat 1% za korzystanie z serwisu ${state.enabled ? 'WŁĄCZONY' : 'WYŁĄCZONY'} przez admina ${req.session.user?.pin || '?'}`);
        res.json({ success: true, enabled: state.enabled, updatedAt: state.updatedAt });
    } catch (error) {
        log('Błąd przełączania rabatu za korzystanie z serwisu:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/access-lock', requireLogin, requireAdmin, (req, res) => {
    res.json({ success: true, blocked: accessLock.isBlocked() });
});

router.post('/access-lock', requireLogin, requireAdmin, async (req, res) => {
    try {
        const blocked = req.body?.blocked === true || req.body?.blocked === 'true';
        const state = accessLock.setBlocked(blocked);
        let loggedOut = 0;
        if (state.blocked) {
            loggedOut = await sessionService.destroyNonAdminSessions();
        }
        log(`Access lock ${state.blocked ? 'ENABLED' : 'DISABLED'} by admin ${req.session.user?.pin || '?'}${state.blocked ? `, logged out ${loggedOut} session(s)` : ''}`);
        res.json({ success: true, blocked: state.blocked, updatedAt: state.updatedAt, loggedOut });
    } catch (error) {
        log('Error toggling access lock:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/login-history', requireLogin, requireAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const loginHistory = await logService.getRecentLogins(limit);

        let formattedLoginHistory = [];
        if (loginHistory && loginHistory.length > 0) {
            formattedLoginHistory = loginHistory.map(login => ({
                ...login,
                login_time_formatted: formatLoginTime(login.login_time)
            }));
        }

        const totalLogins = loginHistory ? loginHistory.length : 0;

        res.render('admin/login_history.njk', {
            loginHistory: formattedLoginHistory,
            currentPage: page,
            limit: limit,
            totalLogins: totalLogins,
            hasNextPage: totalLogins === limit, 
            hasPrevPage: page > 1
        });
    } catch (error) {
        log('Error fetching login history:', error);
        res.status(500).render('error.njk', {
            message: 'Błąd podczas pobierania historii logowań'
        });
    }
});

router.get('/api/login-history', requireLogin, requireAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const userPin = req.query.user_pin || null;
        const userIdent = req.query.user_ident || null;

        let loginHistory;
        if (userPin) {
            loginHistory = await logService.getUserLoginHistory(userPin, limit);
        } else if (userIdent) {
            loginHistory = await logService.getUserLoginHistoryByIdent(userIdent, limit);
        } else {
            loginHistory = await logService.getRecentLogins(limit);
        }


        if (loginHistory && loginHistory.length > 0) {
            loginHistory = loginHistory.map(login => ({
                ...login,
                login_time_formatted: formatLoginTime(login.login_time),
                login_time: login.login_time 
            }));
        }

        res.json({
            success: true,
            data: loginHistory || [],
            count: loginHistory ? loginHistory.length : 0
        });
    } catch (error) {
        log('Error fetching login history API:', error);
        res.status(500).json({
            success: false,
            message: 'Błąd podczas pobierania historii logowań'
        });
    }
});

/* ------------------------------------------------------------------ */
/* Administracja użytkownikami — ustawienia konta z tabeli `user`      */
/* ------------------------------------------------------------------ */

router.get('/users', requireLogin, requireAdmin, (req, res) => {
    res.render('admin/user_admin.njk', {
        roleOptions: userAdminService.ROLE_OPTIONS,
        abTypeOptions: userAdminService.AB_TYPE_OPTIONS,
        abLangOptions: availabeLanguages,
        minPasswordLength: userAdminService.MIN_PASSWORD_LENGTH,
        maxDeliveryDelay: userAdminService.MAX_DELIVERY_DELAY,
        priceModeOptions: groupPriceMode.PRICE_MODE_OPTIONS,
        invoiceScheduleOptions: INVOICE_SCHEDULE_OPTIONS
    });
});

router.get('/api/users/search', requireLogin, requireAdmin, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        // Bez frazy nie zwracamy niczego: wysypanie 1900 kont do podpowiedzi
        // niczego nie ułatwia, a obciąża bazę przy każdym otwarciu strony.
        if (q.length < 2) return res.json({ success: true, users: [] });
        const users = await userAdminDb.searchUsers(q);
        return res.json({ success: true, users });
    } catch (err) {
        log('[admin/users] błąd wyszukiwania:', err.message);
        return res.status(500).json({ success: false, message: 'Błąd wyszukiwania użytkowników' });
    }
});

router.get('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
    try {
        const user = await userAdminDb.getUserForAdmin(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Nie znaleziono użytkownika' });
        return res.json({ success: true, user });
    } catch (err) {
        log('[admin/users] błąd pobierania użytkownika:', err.message);
        return res.status(500).json({ success: false, message: 'Błąd pobierania danych użytkownika' });
    }
});

router.post('/api/users/:id/settings', requireLogin, requireAdmin, async (req, res) => {
    try {
        const user = await userAdminDb.getUserForAdmin(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Nie znaleziono użytkownika' });

        const { values, errors } = userAdminService.normalizeUserSettings(req.body);
        if (errors.length) return res.status(400).json({ success: false, message: errors.join(' ') });

        // Zapora na odcięcie sobie panelu: rolę admina odbiera komuś innemu,
        // nie sam sobie — po takim zapisie nie byłoby drogi powrotu z aplikacji.
        if (userAdminService.wouldDropOwnAdminRole(req.session.user, user.id, values.role)) {
            return res.status(400).json({
                success: false,
                message: 'Nie możesz odebrać roli administratora własnemu kontu — poproś o to innego admina.'
            });
        }

        const result = await userAdminDb.updateUserSettings(user.id, values);
        if (!result) return res.status(500).json({ success: false, message: 'Zapis nie powiódł się' });

        log(`[admin/users] ${req.session.user?.ident || req.session.user?.pin} zmienił ustawienia konta ${user.ident} (id ${user.id}): ${JSON.stringify(values)}`);
        return res.json({ success: true, user: await userAdminDb.getUserForAdmin(user.id) });
    } catch (err) {
        log('[admin/users] błąd zapisu ustawień:', err.message);
        return res.status(500).json({ success: false, message: 'Błąd zapisu ustawień' });
    }
});

/*
 * Tryb wyceny klientów grupy (`user.group_price_mode`): rabat od cen `SUB___`
 * albo narzut na ceny zwykłe — services/groupPriceMode.js. Osobna trasa, a nie
 * kolejne pole w `/settings`: kolumna dochodzi migracją, a dopisana do białej
 * listy `POLA` przed migracją wywracałaby zapis WSZYSTKICH ustawień konta.
 */
router.post('/api/users/:id/group-price-mode', requireLogin, requireAdmin, async (req, res) => {
    try {
        const user = await userAdminDb.getUserForAdmin(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Nie znaleziono użytkownika' });
        if (user.role !== 'group') {
            return res.status(400).json({ success: false, message: 'Tryb wyceny dotyczy wyłącznie kont z rolą „Grupa".' });
        }

        const raw = String(req.body?.mode ?? '').trim().toLowerCase();
        // Ścisła walidacja — `normalizePriceMode` zamienia śmieci w `discount`,
        // a tu literówka ma być błędem, nie cichym powrotem do rabatu.
        if (raw !== groupPriceMode.PRICE_MODE_DISCOUNT && raw !== groupPriceMode.PRICE_MODE_MARKUP) {
            return res.status(400).json({ success: false, message: `Nieznany tryb wyceny: ${req.body?.mode}` });
        }

        const saved = await groupPriceMode.setGroupPriceMode(user.id, raw);
        if (!saved) {
            return res.status(500).json({
                success: false,
                message: 'Zapis nie powiódł się — czy wykonano migrację migrations/add_group_price_mode.sql?'
            });
        }

        log(`[admin/users] ${req.session.user?.ident || req.session.user?.pin} zmienił tryb wyceny klientów grupy ${user.ident} (id ${user.id}): ${user.group_price_mode} → ${raw}`);
        return res.json({ success: true, user: await userAdminDb.getUserForAdmin(user.id) });
    } catch (err) {
        log('[admin/users] błąd zapisu trybu wyceny:', err.message);
        return res.status(500).json({ success: false, message: 'Błąd zapisu trybu wyceny' });
    }
});

/*
 * Fakturowanie niestandardowe (`user.invoice_schedule`): faktura ZBIORCZA za
 * tydzień albo miesiąc zamiast faktury za każde zlecenie — wystawia ją automat
 * (services/invoices/autoInvoicing.js, core/collective.js). Osobna trasa z tego
 * samego powodu co tryb wyceny: kolumna dochodzi migracją.
 */
router.post('/api/users/:id/invoice-schedule', requireLogin, requireAdmin, async (req, res) => {
    try {
        const user = await userAdminDb.getUserForAdmin(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Nie znaleziono użytkownika' });

        const raw = String(req.body?.schedule ?? '').trim().toLowerCase();
        // Ścisła walidacja: literówka ma być błędem, a nie cichym powrotem do standardu
        if (raw !== '' && !INVOICE_SCHEDULE_OPTIONS.some((o) => o.value === raw)) {
            return res.status(400).json({ success: false, message: `Nieznany sposób fakturowania: ${req.body?.schedule}` });
        }

        const invoices = require('../services/invoices/db/repository');
        if (!(await invoices.supportsInvoiceSchedule())) {
            return res.status(500).json({
                success: false,
                message: 'Brak kolumny user.invoice_schedule — wykonaj migrację migrations/add_user_invoice_schedule.sql'
            });
        }
        await invoices.setUserInvoiceSchedule(user.id, raw || null);

        log(`[admin/users] ${req.session.user?.ident || req.session.user?.pin} zmienił fakturowanie konta ${user.ident} (id ${user.id}): ${user.invoice_schedule || 'standard'} → ${raw || 'standard'}`);
        return res.json({ success: true, user: await userAdminDb.getUserForAdmin(user.id) });
    } catch (err) {
        log('[admin/users] błąd zapisu sposobu fakturowania:', err.message);
        return res.status(500).json({ success: false, message: 'Błąd zapisu sposobu fakturowania' });
    }
});

router.post('/api/users/:id/password', requireLogin, requireAdmin, async (req, res) => {
    try {
        const user = await userAdminDb.getUserForAdmin(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Nie znaleziono użytkownika' });

        const { password, errors } = userAdminService.validateNewPassword(req.body?.password, req.body?.password2);
        if (errors.length) return res.status(400).json({ success: false, message: errors.join(' ') });

        const result = await userAdminDb.setUserPassword(user.id, password);
        if (!result) return res.status(500).json({ success: false, message: 'Zmiana hasła nie powiodła się' });

        // Świadomie logujemy tylko FAKT zmiany — nigdy hasła ani hasha.
        log(`[admin/users] ${req.session.user?.ident || req.session.user?.pin} zmienił hasło konta ${user.ident} (id ${user.id})`);
        return res.json({ success: true, message: `Hasło konta ${user.ident} zostało zmienione` });
    } catch (err) {
        log('[admin/users] błąd zmiany hasła:', err.message);
        return res.status(500).json({ success: false, message: 'Błąd zmiany hasła' });
    }
});

router.get('/organizations', requireLogin, requireAdmin, (req, res) => {
    res.render('admin/placeholder.njk', {
        title: 'Zarządzanie Organizacjami',
        message: 'Ta funkcja zostanie wkrótce dodana.'
    });
});

router.get('/settings', requireLogin, requireAdmin, (req, res) => {
    res.render('admin/placeholder.njk', {
        title: 'Ustawienia Systemowe',
        message: 'Ta funkcja zostanie wkrótce dodana.'
    });
});

router.get('/logs', requireLogin, requireAdmin, (req, res) => {
    res.render('admin/placeholder.njk', {
        title: 'Logi Systemowe',
        message: 'Ta funkcja zostanie wkrótce dodana.'
    });
});

router.get('/active-sessions', requireLogin, requireAdmin, async (req, res) => {
    try {
        const sessions = await sessionService.getActiveSessions();
        res.json({ success: true, count: sessions.length, users: sessions });
    } catch (error) {
        log('Error fetching active sessions:', error);
        res.status(500).json({ success: false, message: 'Błąd podczas pobierania sesji' });
    }
});

// --- Translation Dictionary & Group Sync ---
const translationDict = require('../services/translationDict');
const { syncGroupsFromExcel } = require('../services/groupSync');
const clientAliasesSync = require('../services/clientAliasesSync');
const paramdictConfigSync = require('../services/paramdictConfigSync');

router.post('/translations/sync', requireLogin, requireAdmin, async (req, res) => {
    try {
        const [translationResult, groupSyncResult, aliasesResult, configResult] = await Promise.allSettled([
            translationDict.syncAll(),
            syncGroupsFromExcel(),
            clientAliasesSync.syncAll(),
            paramdictConfigSync.syncAll()
        ]);

        const result = translationResult.status === 'fulfilled' ? translationResult.value : {};
        const groupSync = groupSyncResult.status === 'fulfilled'
            ? { groupSyncSuccess: true }
            : { groupSyncSuccess: false, groupSyncError: groupSyncResult.reason?.message };

        const aliases = aliasesResult.status === 'fulfilled'
            ? { aliasesSyncSuccess: true, aliasesTotal: aliasesResult.value.totalEntries }
            : { aliasesSyncSuccess: false, aliasesSyncError: aliasesResult.reason?.message };

        const config = configResult.status === 'fulfilled'
            ? { configSyncSuccess: true, configTotal: configResult.value.totalEntries }
            : { configSyncSuccess: false, configSyncError: configResult.reason?.message };

        if (translationResult.status === 'rejected') {
            throw translationResult.reason;
        }

        res.json({ success: true, ...result, ...groupSync, ...aliases, ...config });
    } catch (error) {
        log('Error syncing translation dictionary:', error);
        res.status(500).json({ success: false, message: 'Błąd synchronizacji słownika tłumaczeń' });
    }
});

router.post('/translations/sync/:groupNumber', requireLogin, requireAdmin, async (req, res) => {
    try {
        const result = await translationDict.syncGroup(req.params.groupNumber);
        res.json({ success: true, ...result });
    } catch (error) {
        log('Error syncing translation group:', error);
        res.status(500).json({ success: false, message: 'Błąd synchronizacji grupy' });
    }
});

router.get('/translations/status', requireLogin, requireAdmin, async (req, res) => {
    try {
        const status = await translationDict.getSyncStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        log('Error fetching translation status:', error);
        res.status(500).json({ success: false, message: 'Błąd pobierania statusu tłumaczeń' });
    }
});

router.get('/translations/:groupNumber/:lang', requireLogin, requireAdmin, async (req, res) => {
    try {
        const data = await translationDict.getGroupTranslations(req.params.groupNumber, req.params.lang);
        res.json({ success: true, data });
    } catch (error) {
        log('Error fetching translations:', error);
        res.status(500).json({ success: false, message: 'Błąd pobierania tłumaczeń' });
    }
});

// ─── Reports module ──────────────────────────────────────────────────────────

router.get('/reports', requireLogin, requireAdmin, async (req, res) => {
    try {
        const clients = await reportsDb.getReportClients();
        const savedConfigs = await reportsDb.getReportConfigs(req.session.user.userId);
        res.render('admin/reports.njk', { clients, savedConfigs });
    } catch (error) {
        log('Error loading reports page:', error);
        res.status(500).render('error.njk', { message: 'Błąd ładowania raportów' });
    }
});

router.post('/api/reports/stats', requireReportsApiAccess, async (req, res) => {
    try {
        const { userIds, dateFrom, dateTo } = req.body;
        const ids = Array.isArray(userIds) ? userIds : (userIds ? JSON.parse(userIds) : null);
        const from = dateFrom || null;
        const to   = dateTo   || null;
        const [stats, trend, groups, deptClients, clients] = await Promise.all([
            reportsDb.getOrderStats(ids, from, to),
            reportsDb.getMonthlyTrend(ids, from, to),
            reportsDb.getGroupStats(ids, from, to),
            reportsDb.getDeptClientStats(ids, from, to),
            // Sidebar counters must follow the same range as the report itself.
            reportsDb.getReportClients(from, to),
        ]);
        const clientCounts = (clients || []).map(c => ({ id: c.id, order_count: c.order_count }));
        res.json({ success: true, stats, trend, groups, deptClients, clientCounts });
    } catch (error) {
        log('Error fetching report stats:', error);
        res.status(500).json({ success: false, message: 'Błąd pobierania danych' });
    }
});

router.post('/api/reports/configs', requireReportsApiAccess, async (req, res) => {
    try {
        const { name, userIds, dateFrom, dateTo, dateToToday } = req.body;
        if (!name || typeof name !== 'string' || name.length > 100) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowa nazwa konfiguracji' });
        }
        const configs = await reportsDb.saveReportConfig(req.session.user.userId, { name, userIds: userIds || [], dateFrom: dateFrom || null, dateTo: dateTo || null, dateToToday: !!dateToToday });
        res.json({ success: true, configs });
    } catch (error) {
        log('Error saving report config:', error);
        res.status(500).json({ success: false, message: 'Błąd zapisu konfiguracji' });
    }
});

router.delete('/api/reports/configs/:name', requireReportsApiAccess, async (req, res) => {
    try {
        const configs = await reportsDb.deleteReportConfig(req.session.user.userId, decodeURIComponent(req.params.name));
        res.json({ success: true, configs });
    } catch (error) {
        log('Error deleting report config:', error);
        res.status(500).json({ success: false, message: 'Błąd usuwania konfiguracji' });
    }
});

// ─── Import Log (admin view — all imports) ───────────────────────────────────

const { selectQuery } = require('../db/core');

router.get('/import-log', requireLogin, requireAdmin, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 30;
        const offset = (page - 1) * limit;

        const filters = {
            status: req.query.status || '',
            user: req.query.user || '',
            dateFrom: req.query.dateFrom || '',
            dateTo: req.query.dateTo || '',
            sort: req.query.sort || 'newest'
        };

        let where = '1=1';
        const params = [];

        if (filters.status) {
            where += ' AND status = ?';
            params.push(filters.status);
        }
        if (filters.user) {
            where += ' AND user_ident LIKE ?';
            params.push(`%${filters.user}%`);
        }
        if (filters.dateFrom) {
            where += ' AND created_at >= ?';
            params.push(filters.dateFrom);
        }
        if (filters.dateTo) {
            where += ' AND created_at <= ?';
            params.push(filters.dateTo + ' 23:59:59');
        }

        let orderBy = 'created_at DESC';
        if (filters.sort === 'oldest') orderBy = 'created_at ASC';
        else if (filters.sort === 'status') orderBy = 'status ASC, created_at DESC';
        else if (filters.sort === 'user') orderBy = 'user_ident ASC, created_at DESC';

        const countRows = await selectQuery(
            `SELECT COUNT(*) as total FROM import_log WHERE ${where}`, params
        );
        const total = countRows ? countRows[0].total : 0;
        const totalPages = Math.ceil(total / limit);

        const logs = await selectQuery(
            `SELECT * FROM import_log WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        ) || [];

        for (const row of logs) {
            row.created_at_formatted = formatLoginTime(row.created_at);
        }

        const pages = [];
        const start = Math.max(1, page - 3);
        const end = Math.min(totalPages, page + 3);
        for (let i = start; i <= end; i++) pages.push(i);

        res.render('admin/import_log.njk', { logs, filters, currentPage: page, totalPages, pages });
    } catch (error) {
        log('Error loading import log:', error);
        res.status(500).render('error.njk', { message: 'Błąd ładowania logów importu' });
    }
});

module.exports = router;