'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assistant = require('../assistantService');
const strings = require('../strings');

/** Katalog tłumaczeń-atrapa: kilka etykiet po polsku i niemiecku. */
const localesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-locales-'));
fs.writeFileSync(path.join(localesDir, 'pl.json'), JSON.stringify({
	base: { orders_history: 'Wysłane zlecenia', your_orders: 'Twoje oferty' },
	orders: { copy_offer: 'Kopiuj ofertę' }
}));
fs.writeFileSync(path.join(localesDir, 'de.json'), JSON.stringify({
	base: { orders_history: 'gesendete Bestellungen', your_orders: 'Ihre Angebote' },
	orders: { copy_offer: 'Angebot kopieren' }
}));

const CFG = { model: 'test-model', reasoningEffort: 'low', maxQuestionsPerHour: 100, apiKey: 'x', apiUrl: 'http://x', timeoutMs: 1000 };

/** Odpowiedź Responses API z podanym JSON-em modelu. */
function reply(obj, extra = {}) {
	return {
		status: 'completed',
		output: [{ type: 'message', content: [{ type: 'output_text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }],
		usage: { input_tokens: 10, output_tokens: 5 },
		...extra
	};
}

function deps(overrides = {}) {
	const calls = [];
	const logged = [];
	return {
		config: CFG,
		localesDir,
		getKnowledgeText: (lang) => `BAZA[${lang}]: kopiowanie przez przycisk w historii.`,
		getContactText: async () => null,
		logEntry: (e) => logged.push(e),
		log: () => {},
		takeQuota: () => true,
		createResponse: async (body) => { calls.push(body); return reply({ status: 'answered', answer: 'OK', highlight: null }); },
		calls,
		logged,
		...overrides
	};
}

const baseInput = {
	question: 'Wie kopiere ich eine Bestellung?',
	lang: 'de',
	account: { type: 'client' },
	orgIdent: 'LUXANGMBH',
	userKey: 'LUXANGMBH:K1',
	page: { path: '/orders/history', title: 'eForm', elements: ['nav_history', 'copy_order', 'nieistniejacy'] }
};

test('poprawna odpowiedź: zwraca status, tekst i dozwolony highlight, zapisuje rozmowę w sesji', async () => {
	const d = deps({
		createResponse: async (body) => { d.calls.push(body); return reply({ status: 'answered', answer: 'Klicken Sie auf „Angebot kopieren".', highlight: 'copy_order' }); }
	});
	const session = {};
	const r = await assistant.ask(session, baseInput, d);

	assert.deepEqual(r, { status: 'answered', answer: 'Klicken Sie auf „Angebot kopieren".', highlight: 'copy_order' });
	assert.equal(session.assistant.messages.length, 2);
	assert.equal(session.assistant.messages[0].role, 'user');
	assert.equal(session.assistant.messages[1].highlight, 'copy_order');
	assert.equal(d.logged.length, 1);
	assert.equal(d.logged[0].status, 'answered');
});

test('żądanie: store=false, model z configu, kontekst jako developer, enum highlight tylko z elementów katalogu', async () => {
	const d = deps();
	await assistant.ask({}, baseInput, d);
	const body = d.calls[0];

	assert.equal(body.model, 'test-model');
	assert.equal(body.store, false);
	assert.equal(body.reasoning.effort, 'low');
	assert.match(body.instructions, /BAZA WIEDZY/);
	assert.match(body.instructions, /BAZA\[de\]: kopiowanie/, 'baza wiedzy w języku interfejsu klienta');
	assert.match(body.safety_identifier, /^[0-9a-f]{32}$/);
	assert.ok(!JSON.stringify(body).includes('LUXANGMBH:K1'), 'identyfikator klienta nie idzie do OpenAI wprost');

	const roles = body.input.map((m) => m.role);
	assert.deepEqual(roles, ['developer', 'user']);
	const ctx = body.input[0].content;
	assert.match(ctx, /Język interfejsu użytkownika: de/);
	assert.match(ctx, /copy_order — .*"Angebot kopieren"/);

	const hl = body.text.format.schema.properties.highlight;
	assert.deepEqual(hl.anyOf[0].enum, ['nav_history', 'copy_order']);
	assert.equal(body.text.format.strict, true);
});

test('historia rozmowy idzie do modelu przed kontekstem i pytaniem', async () => {
	const d = deps();
	const session = {};
	await assistant.ask(session, { ...baseInput, question: 'Pierwsze' }, d);
	await assistant.ask(session, { ...baseInput, question: 'Drugie' }, d);
	const roles = d.calls[1].input.map((m) => m.role);
	assert.deepEqual(roles, ['user', 'assistant', 'developer', 'user']);
	assert.equal(d.calls[1].input[0].content, 'Pierwsze');
	assert.equal(d.calls[1].input[3].content, 'Drugie');
});

test('highlight spoza elementów na ekranie jest odrzucany', async () => {
	const d = deps({ createResponse: async () => reply({ status: 'answered', answer: 'x', highlight: 'send_order' }) });
	const r = await assistant.ask({}, baseInput, d);
	assert.equal(r.highlight, null);
});

test('błąd API → handoff z komunikatem w języku klienta i powodem do maila', async () => {
	const err = Object.assign(new Error('boom'), { code: 'timeout' });
	const d = deps({ createResponse: async () => { throw err; } });
	const session = {};
	const r = await assistant.ask(session, baseInput, d);
	assert.equal(r.status, 'handoff');
	assert.equal(r.answer, strings.forLang('de').unavailable);
	assert.equal(r.reason, 'api:timeout');
	assert.equal(session.assistant.lastHandoffReason, 'api:timeout');
});

test('brak klucza API (prawdziwy klient) → handoff, nie wyjątek', async () => {
	const d = deps({ config: { ...CFG, apiKey: '' } });
	delete d.createResponse;
	const r = await assistant.ask({}, baseInput, d);
	assert.equal(r.status, 'handoff');
	assert.equal(r.reason, 'api:no_api_key');
});

test('odmowa modelu, odpowiedź niepełna i zły JSON → handoff', async () => {
	const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] };
	for (const [payload, reason] of [
		[refusal, 'refusal'],
		[reply('{"status":"answered"', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'incomplete:max_output_tokens'],
		[reply('to nie jest json'), 'bad_reply'],
		[reply({ status: 'cos_innego', answer: 'x', highlight: null }), 'bad_reply'],
		[reply({ status: 'answered', answer: '   ', highlight: null }), 'bad_reply']
	]) {
		const r = await assistant.ask({}, baseInput, deps({ createResponse: async () => payload }));
		assert.equal(r.status, 'handoff', reason);
		assert.equal(r.reason, reason);
	}
});

test('handoff od modelu zostaje handoffem i zapisuje powód model_handoff', async () => {
	const d = deps({ createResponse: async () => reply({ status: 'handoff', answer: 'Das weiß ich nicht.', highlight: null }) });
	const session = {};
	const r = await assistant.ask(session, baseInput, d);
	assert.equal(r.status, 'handoff');
	assert.equal(r.answer, 'Das weiß ich nicht.');
	assert.equal(session.assistant.lastHandoffReason, 'model_handoff');
});

test('limit pytań → handoff bez wywołania modelu', async () => {
	const d = deps({ takeQuota: () => false });
	const r = await assistant.ask({}, baseInput, d);
	assert.equal(r.status, 'handoff');
	assert.equal(r.reason, 'rate_limited');
	assert.equal(d.calls.length, 0);
});

test('puste i za długie pytanie → 400 bez wywołania modelu', async () => {
	const d = deps();
	const empty = await assistant.ask({}, { ...baseInput, question: '   ' }, d);
	const long = await assistant.ask({}, { ...baseInput, question: 'x'.repeat(assistant.MAX_QUESTION_CHARS + 1) }, d);
	assert.equal(empty.httpStatus, 400);
	assert.equal(long.httpStatus, 400);
	assert.equal(d.calls.length, 0);
});

test('takeQuota liczy okno godzinne per użytkownik', () => {
	const t0 = 1_000_000;
	assert.equal(assistant.takeQuota('q-test', 2, t0), true);
	assert.equal(assistant.takeQuota('q-test', 2, t0 + 1), true);
	assert.equal(assistant.takeQuota('q-test', 2, t0 + 2), false);
	assert.equal(assistant.takeQuota('q-inny', 2, t0 + 2), true);
	assert.equal(assistant.takeQuota('q-test', 2, t0 + 60 * 60 * 1000 + 5), true);
});

test('sesja trzyma najwyżej 40 wypowiedzi', async () => {
	const d = deps();
	const session = {};
	for (let i = 0; i < 25; i++) await assistant.ask(session, { ...baseInput, question: `p${i}` }, d);
	assert.equal(session.assistant.messages.length, 40);
	assert.equal(session.assistant.messages[39].role, 'assistant');
});
