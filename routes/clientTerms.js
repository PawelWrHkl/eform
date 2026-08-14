/**
 * Nakładka warunków handlowych dla PRZEGLĄDARKI — `GET /client-terms/:groupNumber`.
 *
 * Po co osobny router, skoro moduł „Klienci organizacji" już ma swoje trasy:
 * z tej nakładki korzysta `public/scripts/formTools/getAvailableForms.js`
 * (`FormsManager`) przy KAŻDYM otwarciu formularza pozycji — także wtedy, gdy
 * zalogowany jest zwykły klient albo pracownik, którzy do panelu klientów nie
 * mają wstępu. Dlatego bramką jest tu samo `requireLogin`, a zakres danych jest
 * zawężony do klienta z bieżącej sesji/kontekstu: endpoint NIE przyjmuje
 * identyfikatora klienta z parametrów, więc nie da się nim odczytać cudzych
 * cenników.
 *
 * Zwraca dokładnie to, co potrzebne do scalenia z `prod.txt`:
 *   { scripts: { CENA: 'param-CENA-C.js', … }, collections: { KOLOR: 'paramdict-KOLOR-X.txt', … } }
 *
 * Puste mapy = brak nakładki, czyli obowiązuje wyłącznie konfiguracja plikowa
 * (tak działa każde konto założone w aplikacji zewnętrznej).
 */

'use strict';

const express = require('express');

const { requireLogin } = require('../middleware/loginMixture');
const ownerService = require('../services/owner');
const db = require('../db/db_helper');
const orgCustomersDb = require('../db/orgCustomers');
const { log } = require('../utils/logging');

const router = express.Router();

const EMPTY = { scripts: {}, collections: {} };

router.get('/:groupNumber', requireLogin, async (req, res) => {
	const groupNumber = String(req.params.groupNumber || '').trim();
	// Numery grup to katalogi `data/<nr>` — cokolwiek innego nie ma czego szukać.
	if (!/^\d{1,10}$/.test(groupNumber)) {
		return res.status(400).json({ success: false, error: 'invalid_group' });
	}

	try {
		// `getCurrentUser` honoruje przełączony kontekst klienta (owner pracujący
		// „jako" klient) — ta sama funkcja, z której korzysta `/user/owner/`,
		// czyli źródło `clientData` w przeglądarce. Bez niej owner dostawałby
		// nakładkę własnego konta, a nie obsługiwanego klienta.
		const currentUser = ownerService.getCurrentUser(req);
		const pin = currentUser && currentUser.pin;
		if (!pin) return res.json({ success: true, ...EMPTY });

		const userId = await db.getUserId(pin);
		if (!userId) return res.json({ success: true, ...EMPTY });

		const terms = await orgCustomersDb.getGroupTerms(userId, groupNumber);
		if (!terms || !terms.has_access) return res.json({ success: true, ...EMPTY });

		return res.json({
			success: true,
			scripts: terms.scripts || {},
			collections: terms.collections || {}
		});
	} catch (err) {
		// Awaria nakładki nie może wywrócić formularza — bez niej klient policzy
		// się z konfiguracji plikowej, czyli tak jak przed wprowadzeniem modułu.
		log('clientTerms error:', err.message);
		return res.json({ success: true, ...EMPTY });
	}
});

module.exports = router;
