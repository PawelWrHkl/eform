/**
 * Znacznik „oferta” — `order.offer_at` (migrations/add_order_offer_at.sql).
 *
 * Każde niewysłane zlecenie ma status 'active', więc sam status nie odróżnia
 * oferty dla klienta od porzuconego koszyka. `offer_at` = chwila PIERWSZEGO
 * zdarzenia, po którym zlecenie wyszło z eForma jako oferta:
 *  - import FTP na koncie z `user.autoimport = 0` (services/orderImport/index.js),
 *  - PDF aktywnego zlecenia (`/orders/orderpdf/…`) i PDF specyfikacji ceny
 *    (`/orders/order/:id/price-spec.pdf`) — nie liczy się PDF robiony przez admina.
 * Wysyłka go nie czyści — z tego liczy się konwersja oferta → zlecenie
 * (raport ofert w /org/reports, services/orgReports.js).
 *
 * Produkcja bez migracji: brak kolumny = nic się nie dzieje (bez błędów w logu),
 * a raport nie pokazuje sekcji ofert. Wykrywanie kolumny jak w services/currency.js.
 */

'use strict';

// `db/core` leniwie — testy jednostkowe ładują moduł bez MySQL-a.
const selectQuery = (...args) => require('../db/core').selectQuery(...args);
const updateQuery = (...args) => require('../db/core').updateQuery(...args);
const { getDbTimestamp } = require('../utils/humanize_date');
const { log } = require('../utils/logging');

const COLUMN_TTL_MS = 5 * 60 * 1000;
let columnCache = null;

/** Czy kolumna `order.offer_at` już jest. Pamiętane 5 min — po migracji działa bez restartu. */
async function hasOfferColumn(deps = {}) {
	const now = Date.now();
	if (!deps.select && columnCache && now - columnCache.at < COLUMN_TTL_MS) return columnCache.value;
	const rows = await (deps.select || selectQuery)(
		`SELECT 1 FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order' AND COLUMN_NAME = 'offer_at'`
	);
	const value = Array.isArray(rows) && rows.length > 0;
	if (!deps.select) columnCache = { at: now, value };
	return value;
}

/**
 * Oznacz aktywne zlecenie jako ofertę (tylko pierwsze zdarzenie; czas jak `created_date`).
 * Nigdy nie rzuca — PDF ani import nie mogą przez znacznik paść.
 * @returns {Promise<boolean>} true = znacznik ustawiony teraz
 */
async function markOffer(orderId, deps = {}) {
	try {
		if (!(await hasOfferColumn(deps))) return false;
		const r = await (deps.update || updateQuery)(
			"UPDATE `order` SET offer_at = ? WHERE id = ? AND status = 'active' AND offer_at IS NULL",
			[getDbTimestamp(), Number(orderId)]
		);
		return !!(r && r.affectedRows);
	} catch (err) {
		log(`[offer] nie oznaczono zlecenia ${orderId} jako oferty: ${err.message}`);
		return false;
	}
}

module.exports = { hasOfferColumn, markOffer };
