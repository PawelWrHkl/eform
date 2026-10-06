'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tour = require('../tour');
const uiCatalog = require('../uiCatalog');
const prompt = require('../prompt');

const CLIENT = { userId: 1, isEmployee: false, isGroup: false, isGroupShop: false, isOwner: false, invoices: false };
const EMPLOYEE = { ...CLIENT, isEmployee: true };

test('sanitizeTour: zostają tylko znane elementy/strony dostępne dla konta, z tekstem', () => {
	const steps = tour.sanitizeTour([
		{ element: 'user_panel_btn', page: null, text: 'Kliknij panel.', click: true },
		{ element: 'nieistnieje', page: null, text: 'x', click: false },
		{ element: null, page: 'password', text: '  Zakładka   hasła ', click: false },
		{ element: null, page: null, text: 'pusty krok', click: false },
		{ element: 'current_password', page: null, text: '', click: false },
		'śmieci'
	], CLIENT);
	assert.deepEqual(steps, [
		{ element: 'user_panel_btn', page: null, text: 'Kliknij panel.', click: true },
		{ element: null, page: 'password', text: 'Zakładka hasła', click: false }
	]);
});

test('sanitizeTour: Eforek nigdy nie klika zapisu, wysyłki ani usunięcia — click zawsze false', () => {
	const steps = tour.sanitizeTour(['send_order', 'save_position', 'delete_order', 'change_password_btn', 'permission_toggle', 'copy_order'].map((element) => ({ element, page: null, text: 'krok', click: true })), CLIENT);
	assert.equal(steps.length, 6);
	assert.ok(steps.every((s) => s.click === false));
});

test('sanitizeTour: pracownik nie dostaje kroków z panelu pracowników ani panelu użytkownika; maks. 8 kroków', () => {
	const steps = tour.sanitizeTour([
		{ element: 'nav_employee_panel', page: null, text: 'a', click: true },
		{ element: 'add_employee_btn', page: null, text: 'b', click: true },
		{ element: 'user_panel_btn', page: null, text: 'c', click: true },
		{ element: null, page: 'password', text: 'd', click: false },
		{ element: 'nav_history', page: null, text: 'e', click: true }
	], EMPLOYEE);
	assert.deepEqual(steps.map((s) => s.element || s.page), ['nav_history']);
	const many = tour.sanitizeTour(Array.from({ length: 12 }, () => ({ element: 'nav_offers', page: null, text: 't', click: true })), CLIENT);
	assert.equal(many.length, tour.MAX_STEPS);
});

test('stepSchema i schemat odpowiedzi: enum elementów wg konta, pole tour wymagane', () => {
	const s = tour.stepSchema(EMPLOYEE);
	const keys = s.properties.element.anyOf[0].enum;
	assert.ok(keys.includes('nav_history') && !keys.includes('add_employee_btn'));
	assert.deepEqual(s.required, ['element', 'page', 'text', 'click']);
	const format = prompt.buildResponseFormat(['nav_history'], s);
	assert.deepEqual(format.schema.required, ['status', 'answer', 'highlight', 'tour']);
	assert.equal(format.schema.properties.tour.type, 'array');
});

test('clientTourMeta: ekrany i klikalność dla przeglądarki, strony docelowe menu', () => {
	const meta = uiCatalog.clientTourMeta(CLIENT);
	assert.deepEqual(meta.elements.nav_history, { s: ['any'], c: true, n: '/orders/history' });
	assert.deepEqual(meta.elements.panel_tab_password.n, '/panel?tab=password');
	assert.equal(meta.elements.send_order.c, false);
	assert.deepEqual(meta.screens.password, { p: '^/panel/?$', q: 'tab=password', h: '/panel?tab=password' });
	assert.equal(meta.screens.order_view.h, null, 'widok oferty osiągalny tylko krokami');
	const emp = uiCatalog.clientTourMeta(EMPLOYEE);
	assert.ok(!emp.elements.add_employee_btn && !emp.screens.employees);
});

test('reguły czatu opisują pokaz i zakaz klikania zapisu', () => {
	assert.match(prompt.RULES, /POKAZ KROK PO KROKU/);
	assert.match(prompt.RULES, /click=true wolno tylko dla elementów oznaczonych w katalogu \[klik\]/);
	assert.match(prompt.RULES, /niczego nie zapisujesz, nie wysyłasz, nie usuwasz/);
	assert.match(prompt.VOICE_RULES, /start_tour/);
});
