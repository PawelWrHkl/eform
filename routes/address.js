const express = require('express');
const router = express.Router();
const { requireLogin, isOwner } = require('../middleware/loginMixture');
const authService = require('../services/authService')
const ownerService = require('../services/owner.js');
const logService = require('../services/logService.js');
const db = require("../db/db_helper.js");
const langManager = require('../services/setLanguage')
const langVer = require('../services/languageManager')
const { dataDir, localesDir } = require('../config');
const path = require("path");
const { updateClients } = require('../services/dbUserSync');
const hashUser = require('../utils/hashUser').hashUser;
const { log } = require('../utils/logging');
const { selectQuery } = require('../db/core');


/**
 * Adres dostawy / mail po id: tylko konta, do którego należy (bieżący użytkownik
 * albo klient z kontekstu — owner/admin/biuro). Owner i admin jak dotąd bez ograniczeń.
 * Nieznane id przepuszczamy — 404 zwraca trasa.
 */
function addressOwnerGuard(table) {
    return async (req, res, next) => {
        try {
            if (req.session.user?.isOwner) return next();
            const rows = await selectQuery(`SELECT user_id FROM ${table} WHERE id = ?`, [req.params.id]);
            if (!rows) return next();
            const current = ownerService.getCurrentUser(req);
            if (Number(rows[0].user_id) !== Number(current?.userId)) {
                return res.status(403).json({ success: false, message: res.__('access.address_denied') });
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

router.post("/add-delivery-address", requireLogin, async (req, res) => {
    try {
        const { name, phone, street, city, zip, country } = req.body;
        const currentUser = ownerService.getCurrentUser(req);
        const userId = await db.getUserId(currentUser.pin);
        const payload = {
            name: (name || '').trim(),
            phone: (phone || '').trim(),
            street: (street || '').trim(),
            city: (city || '').trim(),
            zip: (zip || '').trim(),
            country: (country || '').trim(),
            email: ''
        };

        if (!payload.name || !payload.phone || !payload.street || !payload.city || !payload.zip || !payload.country) {
            return res.status(400).json({
                success: false,
                message: 'Wszystkie pola adresu dostawy są wymagane'
            });
        }

        const insertResult = await db.insertDeliveryAddress(payload, userId);
        log('Insert Result:', insertResult);
        return res.status(200).json({
            success: true,
            message: 'Adres dostawy został zapisany',
            data: {
                id: insertResult || null,
                userId,
                ...payload
            }
        });
    } catch (error) {
        log('Error adding delivery address:', error);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas zapisu adresu dostawy'
        });
    }
});

router.get('/list', requireLogin, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const userId = await db.getUserId(currentUser.pin);
        const addresses = await db.getUserAddresses(userId);

        return res.status(200).json({
            success: true,
            addresses
        });
    } catch (error) {
        log('Error fetching user addresses:', error);
        return res.status(500).json({
            success: false,
            message: 'Blad podczas pobierania listy adresow'
        });
    }
});

router.get('/mail-list', requireLogin, async (req, res) => {
    try {
        const currentUser = ownerService.getCurrentUser(req);
        const userId = await db.getUserId(currentUser.pin);
        const emails = await db.getUserMails(userId);

        return res.status(200).json({
            success: true,
            emails
        });
    } catch (error) {
        log('Error fetching user mail addresses:', error);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas pobierania listy adresów email'
        });
    }
});


router.post("/add-mail-address", requireLogin, async (req, res) => {
    try {
        const { mail } = req.body;
        const currentUser = ownerService.getCurrentUser(req);
        const userId = await db.getUserId(currentUser.pin);


        const email = (mail || '').trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!email || !emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Podaj poprawny adres email'
            });
        }

        const insertResult = await db.insertMailAddress({ mail: email }, userId);

        return res.status(200).json({
            success: true,
            message: 'Adres email został zapisany',
            data: {
                id: insertResult || null,
                userId,
                mail: email
            }
        });

    } catch (error) {
        log('Error adding mail address:', error);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas zapisu adresu email'
        });
    }
});

router.get('/:id', requireLogin, addressOwnerGuard('delivery_address'), async (req, res) => {
    try {
        const address = await db.getAddressById(req.params.id);
        if (!address) {
            return res.status(404).json({
                success: false,
                message: 'Adres nie znaleziony'
            });
        }
        else {
            return res.status(200).json({
                success: true,
                addressData: address
            });
        }
    } catch (err) {
        log('Error fetching address:', err);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas pobierania adresu'
        });
    }
});

router.get('/mail/:id', requireLogin, addressOwnerGuard('contact_info'), async (req, res) => {
    try {
        const mail = await db.getMailById(req.params.id);
        if (!mail) {
            return res.status(404).json({
                success: false,
                message: 'Adres email nie znaleziony'
            });
        }
        else {
            return res.status(200).json({
                success: true,
                mail
            });
        }
    } catch (err) {
        log('Error fetching mail:', err);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas pobierania adresu email'
        });
    }
});

router.put('/:id', requireLogin, addressOwnerGuard('delivery_address'), async (req, res) => {
    try {
        const { name, phone, street, city, zip, country } = req.body;
        const payload = {
            name: (name || '').trim(),
            phone: (phone || '').trim(),
            street: (street || '').trim(),
            city: (city || '').trim(),
            zip: (zip || '').trim(),
            country: (country || '').trim()
        };

        if (!payload.name || !payload.phone || !payload.street || !payload.city || !payload.zip || !payload.country) {
            return res.status(400).json({
                success: false,
                message: 'Wszystkie pola adresu dostawy są wymagane'
            });
        }

        await db.updateAddress(req.params.id, payload);
        return res.status(200).json({
            success: true,
            message: 'Adres dostawy został zaktualizowany'
        });
    } catch (error) {
        log('Error updating delivery address:', error);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas aktualizacji adresu dostawy'
        });
    }
});

router.put('/mail/:id', requireLogin, addressOwnerGuard('contact_info'), async (req, res) => {
    try {
        const { mail } = req.body;
        const email = (mail || '').trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!email || !emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Podaj poprawny adres email'
            });
        }

        await db.updateMail(req.params.id, { mail: email });
        return res.status(200).json({
            success: true,
            message: 'Adres email został zaktualizowany'
        });
    } catch (error) {
        log('Error updating mail address:', error);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas aktualizacji adresu email'
        });
    }
});

router.delete('/:id', requireLogin, addressOwnerGuard('delivery_address'), async (req, res) => {
    try {
        await db.deleteAddress(req.params.id);
        return res.status(200).json({
            success: true,
            message: 'Adres dostawy został usunięty'
        });
    } catch (error) {
        log('Error deleting delivery address:', error);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas usuwania adresu dostawy'
        });
    }
});

router.delete('/mail/:id', requireLogin, addressOwnerGuard('contact_info'), async (req, res) => {
    try {
        await db.deleteMail(req.params.id);
        return res.status(200).json({
            success: true,
            message: 'Adres email został usunięty'
        });
    } catch (error) {
        log('Error deleting mail address:', error);
        return res.status(500).json({
            success: false,
            message: 'Błąd podczas usuwania adresu email'
        });
    }
});




module.exports = router;