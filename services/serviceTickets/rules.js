/**
 * Reguły modułu „Serwis” — rodzaje zgłoszeń, kategorie, wymagania i kwalifikacja
 * zlecenia (decyzje właściciela 8–10 z 7.11.2026).
 *
 * CZYSTY moduł: bez bazy, bez `config`, bez tłumaczeń. Tę samą definicję dostaje
 * przeglądarka (`window.serviceRules` w templates/service/wizard.njk — JSON z
 * `clientRules()`), więc walidacja w kreatorze i na serwerze nie może się rozjechać:
 * obie strony wołają `validate()` z tego pliku (serwer — Node, przeglądarka —
 * ten sam plik podany jako `/scripts/service/rules.js`, patrz koniec pliku).
 *
 * Kody błędów (`code`) → klucze tłumaczeń `service.err.<code>` w jezyki.xlsx.
 */

(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.serviceRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	/** Rodzaje zgłoszeń w kolejności z polecenia szefa. */
	const TYPES = ['repair', 'complaint', 'transport', 'delivery'];

	/** Stan zlecenia w oczach serwisu. `none` = zgłoszenie bez zlecenia z eForm. */
	const ORDER_STATE = Object.freeze({ DELIVERED: 'delivered', IN_PROGRESS: 'in_progress', NONE: 'none' });

	/** Kategorie problemu — jedna lista w jednym miejscu (tłumaczenia `service.category.<kod>`). */
	const CATEGORIES = Object.freeze({
		product: ['mechanism', 'fabric_defect', 'wrong_size', 'wrong_color_model', 'missing_part', 'motor_control', 'mounting', 'other'],
		transport: ['package_and_product_damaged', 'product_damaged_package_ok', 'parcel_missing', 'other'],
		delivery: ['when_delivery', 'parcel_not_arrived', 'other']
	});

	/**
	 * Wymagania per rodzaj (tabela z decyzji 8):
	 *   orderStates      — przy jakim stanie zlecenia rodzaj jest dostępny,
	 *   categories       — która lista kategorii,
	 *   categoryPerItem  — kategoria przy każdej pozycji (true) albo jedna na zgłoszenie (false),
	 *   itemsRequired    — min. 1 pozycja, gdy zgłoszenie dotyczy zlecenia,
	 *   descriptionRequired, minFiles, filesRecommended,
	 *   extra            — dodatkowe pola rodzaju (decyzje 9–10).
	 */
	const RULES = Object.freeze({
		repair: { orderStates: ['delivered', 'none'], categories: 'product', categoryPerItem: true, itemsRequired: true, descriptionRequired: true, minFiles: 0, filesRecommended: true, extra: ['quote_before_repair'] },
		complaint: { orderStates: ['delivered', 'none'], categories: 'product', categoryPerItem: true, itemsRequired: true, descriptionRequired: true, minFiles: 1, filesRecommended: true, extra: [] },
		transport: { orderStates: ['delivered', 'none'], categories: 'transport', categoryPerItem: true, itemsRequired: true, descriptionRequired: true, minFiles: 2, filesRecommended: true, extra: ['delivered_at', 'carrier_noted'], lateAfterDays: 7 },
		delivery: { orderStates: ['delivered', 'in_progress', 'none'], categories: 'delivery', categoryPerItem: false, itemsRequired: false, descriptionRequired: false, minFiles: 0, filesRecommended: false, extra: [] }
	});

	/** Limity (decyzja 13, wymaganie F). Te same wartości pilnuje multer na serwerze. */
	const LIMITS = Object.freeze({
		maxFiles: 10,
		maxFileBytes: 20 * 1024 * 1024,
		mimes: ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf', 'video/mp4', 'video/quicktime'],
		accept: '.jpg,.jpeg,.png,.heic,.heif,.webp,.pdf,.mp4,.mov,image/*,video/mp4,video/quicktime,application/pdf',
		maxDescription: 4000,
		maxNote: 500,
		maxCommission: 255,
		maxContact: 150,
		maxPhone: 50,
		maxEmail: 160,
		maxAddress: 500,
		maxOrderNoText: 100,
		maxPerDay: 20,
		duplicateWindowMs: 2 * 60 * 1000,
		eligibleMonths: 24
	});

	/** Statusy zgłoszenia (wymaganie A). Zamknięte = klient nie dopisuje. */
	const STATUSES = ['submitted', 'accepted', 'in_progress', 'waiting_for_client', 'resolved_accepted', 'resolved_rejected', 'closed'];
	const CLOSED_STATUSES = ['resolved_accepted', 'resolved_rejected', 'closed'];

	const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

	function str(v) { return typeof v === 'string' ? v.trim() : (v === null || v === undefined ? '' : String(v).trim()); }

	/**
	 * Stan zlecenia dla serwisu. Tylko zlecenia WYSŁANE i nieanulowane kwalifikują się:
	 *   `sent` + `!sent!` → delivered („100 %”), inne `sent` → in_progress,
	 *   wszystko inne (oferta, anulowane, korekta) → null = poza serwisem.
	 */
	function orderState(order) {
		if (!order) return ORDER_STATE.NONE;
		if (order.status !== 'sent') return null;
		return order.prod_status === '!sent!' ? ORDER_STATE.DELIVERED : ORDER_STATE.IN_PROGRESS;
	}

	/** Rodzaje dostępne dla stanu zlecenia (`orderState`). Pozostałe kreator pokazuje wyszarzone. */
	function eligibleTypes(state) {
		if (!state) return [];
		return TYPES.filter((t) => RULES[t].orderStates.includes(state));
	}

	function categoriesFor(type) {
		const r = RULES[type];
		return r ? CATEGORIES[r.categories] : [];
	}

	/**
	 * Walidacja zgłoszenia — jedna dla przeglądarki i serwera.
	 *
	 * @param {object} input
	 *   type, orderState ('delivered'|'in_progress'|'none'), commission, departmentId,
	 *   orderNoText, category (rodzaj delivery), description,
	 *   items: [{ key, qty, maxQty, category, note }], filesCount,
	 *   contactName, contactPhone, contactEmail, productAddress,
	 *   deliveredAt ('RRRR-MM-DD'), carrierNoted (bool|null), quoteBeforeRepair
	 * @returns {Array<{field: string, code: string, index?: number}>} pusta tablica = OK
	 */
	function validate(input) {
		const errors = [];
		const push = (field, code, index) => errors.push(index === undefined ? { field, code } : { field, code, index });
		const i = input || {};
		const rule = RULES[i.type];
		if (!rule) { push('type', 'type_unknown'); return errors; }

		const state = i.orderState || ORDER_STATE.NONE;
		if (!rule.orderStates.includes(state)) push('type', 'type_not_allowed_for_order');

		if (!str(i.commission)) push('commission', 'required');
		else if (str(i.commission).length > LIMITS.maxCommission) push('commission', 'too_long');

		const hasOrder = state !== ORDER_STATE.NONE;
		if (!hasOrder) {
			if (!(Number(i.departmentId) > 0)) push('departmentId', 'required');
			if (!str(i.description)) push('description', 'required');
			if (str(i.orderNoText).length > LIMITS.maxOrderNoText) push('orderNoText', 'too_long');
		}

		const items = Array.isArray(i.items) ? i.items : [];
		if (hasOrder && rule.itemsRequired && items.length === 0) push('items', 'min_one_item');
		items.forEach((it, idx) => {
			const qty = Number(it && it.qty);
			const max = Number(it && it.maxQty);
			if (!Number.isInteger(qty) || qty < 1) push('items.qty', 'qty_invalid', idx);
			else if (Number.isFinite(max) && max > 0 && qty > max) push('items.qty', 'qty_too_big', idx);
			if (rule.categoryPerItem && !categoriesFor(i.type).includes(str(it && it.category))) push('items.category', 'required', idx);
			if (str(it && it.note).length > LIMITS.maxNote) push('items.note', 'too_long', idx);
		});

		if (!rule.categoryPerItem && !categoriesFor(i.type).includes(str(i.category))) push('category', 'required');

		if (rule.descriptionRequired && !str(i.description)) push('description', 'required');
		if (str(i.description).length > LIMITS.maxDescription) push('description', 'too_long');

		const files = Number(i.filesCount) || 0;
		if (files < rule.minFiles) push('files', rule.minFiles === 1 ? 'min_one_file' : 'min_two_files');
		if (files > LIMITS.maxFiles) push('files', 'too_many_files');

		if (!str(i.contactName)) push('contactName', 'required');
		else if (str(i.contactName).length > LIMITS.maxContact) push('contactName', 'too_long');
		if (!str(i.contactPhone)) push('contactPhone', 'required');
		else if (str(i.contactPhone).length > LIMITS.maxPhone) push('contactPhone', 'too_long');
		if (!str(i.contactEmail)) push('contactEmail', 'required');
		else if (str(i.contactEmail).length > LIMITS.maxEmail || !EMAIL_RE.test(str(i.contactEmail))) push('contactEmail', 'email_invalid');
		if (str(i.productAddress).length > LIMITS.maxAddress) push('productAddress', 'too_long');

		if (rule.extra.includes('delivered_at') && str(i.deliveredAt) && !/^\d{4}-\d{2}-\d{2}$/.test(str(i.deliveredAt))) push('deliveredAt', 'date_invalid');

		return errors;
	}

	/**
	 * Ostrzeżenia, które NIE blokują wysyłki (decyzja 10): transport zgłoszony
	 * później niż 7 dni po dostawie.
	 * @returns {string[]} kody → `service.warn.<kod>`
	 */
	function warnings(input, now) {
		const i = input || {};
		const rule = RULES[i.type];
		const out = [];
		if (rule && rule.lateAfterDays && /^\d{4}-\d{2}-\d{2}$/.test(str(i.deliveredAt))) {
			const delivered = new Date(str(i.deliveredAt) + 'T00:00:00Z').getTime();
			const today = (now instanceof Date ? now : new Date(now || Date.now())).getTime();
			if (today - delivered > rule.lateAfterDays * 86400000) out.push('late_transport_report');
		}
		return out;
	}

	function isClosed(status) { return CLOSED_STATUSES.includes(status); }

	/** Definicja dla przeglądarki (bez funkcji) — wstrzykiwana do szablonu jako JSON. */
	function clientRules() {
		return { types: TYPES, rules: RULES, categories: CATEGORIES, limits: LIMITS, statuses: STATUSES, closed: CLOSED_STATUSES };
	}

	return { TYPES, ORDER_STATE, CATEGORIES, RULES, LIMITS, STATUSES, CLOSED_STATUSES, orderState, eligibleTypes, categoriesFor, validate, warnings, isClosed, clientRules };
}));
