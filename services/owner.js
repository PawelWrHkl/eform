const { getUserByIdent } = require('../db/owner');
const { saveRecentClient } = require('../db/users');
const { log } = require('../utils/logging');
const { normalizeGroupType } = require('./groupType');


async function setContextUserByIdent(req, userIdent) {
    try {
        if (!req || !req.session) {
            throw new Error('Brak obiektu sesji w request');
        }

        if (!userIdent) {
            throw new Error('Brak userIdent');
        }
        const userData = await getUserByIdent(userIdent);

        if (!userData) {
            log(`[OwnerService] Nie znaleziono użytkownika o ident: ${userIdent}`);
            return null;
        }

        const contextUser = {
            userId: userData.id,
            pin: userData.pin,
            password: userData.password,
            showPrices: false,
            organization: userData.org_ident ? userData.org_ident.toUpperCase() : '',
            orgId: userData.organization_id,
            clientName: userData.client_name,
            ident: userData.ident,
            isGroup: userData.role === 'group',
            groupType: userData.role === 'group' ? normalizeGroupType(userData.group_type) : null,
            setAt: new Date().toISOString()
        };

        req.session.context_user = contextUser;

        // Save to recent clients list
        const loggedInUserId = req.session.user?.userId;
        if (loggedInUserId) {
            saveRecentClient(loggedInUserId, userData.ident, userData.client_name)
                .catch(err => log('[OwnerService] Error saving recent client:', err.message));
        }

        return contextUser;

    } catch (error) {
        log(`[OwnerService] Błąd podczas ustawiania kontekstu użytkownika dla ident ${userIdent}:`, error.message);
        return null;
    }
}

function getContextUser(req) {
    try {
        if (!req || !req.session) {
            return null;
        }
        return req.session.context_user || null;
    } catch (error) {
        log(`[OwnerService] Błąd podczas pobierania kontekstu użytkownika:`, error.message);
        return null;
    }
}

function clearContextUser(req) {
    try {
        if (!req || !req.session) {
            return false;
        }
        const previousContext = req.session.context_user;
        delete req.session.context_user;

        return true;
    } catch (error) {
        log(`[OwnerService] Błąd podczas czyszczenia kontekstu użytkownika:`, error.message);
        return false;
    }
}

function getCurrentUser(req) {
    try {
        if (!req || !req.session) {
            return null;
        }

        if ((req.session.user?.isOwner || req.session.user?.isAdmin) && req.session.context_user) {
            return req.session.context_user;
        }

        return req.session.user || null;
    } catch (error) {
        // log(`[OwnerService] Błąd podczas pobierania aktualnego użytkownika:`, error.message);
        return req.session.user || null;
    }
}



module.exports = {
    setContextUserByIdent,
    getContextUser,
    clearContextUser,
    getCurrentUser
};
