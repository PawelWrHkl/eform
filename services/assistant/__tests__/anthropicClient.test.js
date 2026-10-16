'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const claude = require('../anthropicClient');
const assistant = require('../assistantService');

const CFG = { apiKey: 'k', model: 'claude-opus-5-5', effort: 'low', timeoutMs: 1000 };
const FORMAT = { type: 'json_schema', name: 'eform_assistant_reply', strict: true, schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } };
const TOOL = { type: 'function', name: 'find_orders', description: 'Szuka zleceń', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, strict: true };

/** Odpowiedź Messages API z JSON-em modelu. */
function message(obj, extra = {}) {
	return {
		stop_reason: 'end_turn',
		content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }],
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
		...extra
	};
}

function params(overrides = {}) {
	const calls = [];
	return {
		cfg: CFG,
		instructions: 'REGUŁY + BAZA',
		context: 'KONTEKST: ekran /orders',
		history: [],
		question: 'Gdzie jest moje zlecenie?',
		tools: [],
		format: FORMAT,
		userId: 'abc',
		runTool: async () => ({}),
		maxRounds: 3,
		usage: { in: 0, out: 0 },
		createMessage: async (body) => { calls.push(structuredClone(body)); return message({ status: 'answered' }); },
		calls,
		...overrides
	};
}

test('żądanie: reguły w cache, kontekst za punktem cache, schemat odpowiedzi, effort, zapasowy model', async () => {
	const p = params();
	const out = await claude.runChat(p);
	assert.equal(out.text, '{"status":"answered"}');
	assert.equal(out.status, 'completed');

	const body = p.calls[0];
	assert.equal(body.model, 'claude-opus-5-5');
	assert.deepEqual(body.system, [
		{ type: 'text', text: 'REGUŁY + BAZA', cache_control: { type: 'ephemeral' } },
		{ type: 'text', text: 'KONTEKST: ekran /orders' }
	]);
	assert.deepEqual(body.output_config, { effort: 'low', format: { type: 'json_schema', schema: FORMAT.schema } }, 'bez pól OpenAI (name/strict)');
	assert.deepEqual(body.messages, [{ role: 'user', content: 'Gdzie jest moje zlecenie?' }]);
	assert.deepEqual(body.metadata, { user_id: 'abc' });
	assert.equal(body.fallbacks, 'default');
	assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01']);
	assert.equal(body.tools, undefined, 'bez narzędzi nie wysyła tools/tool_choice');
	assert.deepEqual(p.usage, { in: 110, out: 5, cached: 100 });
});

test('Haiku nie dostaje fallbacks (nie ma modelu zapasowego)', async () => {
	const p = params({ cfg: { ...CFG, model: 'claude-haiku-5-5' } });
	await claude.runChat(p);
	assert.equal(p.calls[0].fallbacks, undefined);
	assert.equal(p.calls[0].betas, undefined);
});

test('pętla narzędzi: wynik wraca jako tool_result, treść asystenta bez zmian, w ostatniej rundzie tool_choice none', async () => {
	const ran = [];
	const toolTurn = { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu_1', name: 'find_orders', input: { query: '123' } }], usage: { input_tokens: 1, output_tokens: 1 } };
	const queue = [toolTurn, toolTurn, message({ status: 'answered' })];
	const p = params({
		tools: [TOOL],
		maxRounds: 2,
		runTool: async (name, args) => { ran.push([name, args]); return { orders: ['x'.repeat(20000)] }; }
	});
	p.createMessage = async (body) => { p.calls.push(structuredClone(body)); return queue.shift(); };

	const out = await claude.runChat(p);
	assert.equal(out.text, '{"status":"answered"}');
	assert.deepEqual(ran, [['find_orders', { query: '123' }], ['find_orders', { query: '123' }]]);
	assert.equal(p.calls.length, 3);
	assert.deepEqual(p.calls[0].tools, [{ name: 'find_orders', description: 'Szuka zleceń', input_schema: TOOL.parameters, strict: true }]);
	assert.deepEqual(p.calls.map((b) => b.tool_choice.type), ['auto', 'auto', 'none']);

	const msgs = p.calls[1].messages;
	assert.deepEqual(msgs[1], { role: 'assistant', content: toolTurn.content });
	assert.equal(msgs[2].role, 'user');
	assert.equal(msgs[2].content[0].type, 'tool_result');
	assert.equal(msgs[2].content[0].tool_use_id, 'tu_1');
	assert.equal(msgs[2].content[0].content.length, 12000, 'wynik narzędzia przycięty');
});

test('historia: notatki asystenta na początku i puste wypowiedzi odpadają', () => {
	assert.deepEqual(claude.historyMessages([
		{ role: 'assistant', text: 'Przekazano konsultantowi.' },
		{ role: 'user', text: '' },
		{ role: 'user', text: 'Pytanie 1' },
		{ role: 'assistant', text: 'Odpowiedź 1' }
	]), [{ role: 'user', content: 'Pytanie 1' }, { role: 'assistant', content: 'Odpowiedź 1' }]);
});

test('extractOutput: odmowa z kategorią, ucięcie, sklejanie tekstu', () => {
	assert.deepEqual(claude.extractOutput({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
		{ text: null, refusal: 'cyber', status: 'completed', reason: null });
	assert.deepEqual(claude.extractOutput({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"sta' }] }),
		{ text: '{"sta', refusal: null, status: 'incomplete', reason: 'max_tokens' });
	assert.equal(claude.extractOutput({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }, { type: 'fallback' }, { type: 'text', text: 'b' }] }).text, 'ab');
});

test('błędy SDK → AssistantApiError z kodem do dziennika', async () => {
	assert.equal(claude._toApiError(new Anthropic.APIConnectionTimeoutError()).code, 'timeout');
	const auth = claude._toApiError(Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, new Headers()));
	assert.equal(auth.code, 'authentication_error');
	assert.equal(auth.status, 401);
	await assert.rejects(claude.createMessage({}, { ...CFG, apiKey: '' }), (err) => err.code === 'no_api_key');
});

test('assistantService.ask z ASSISTANT_PROVIDER=anthropic idzie przez Claude, nie OpenAI', async () => {
	const localesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-claude-'));
	fs.writeFileSync(path.join(localesDir, 'pl.json'), JSON.stringify({ base: {} }));
	const bodies = [];
	const logged = [];
	const r = await assistant.ask({}, {
		question: 'Jak skopiować zlecenie?',
		lang: 'pl',
		account: { type: 'client' },
		userKey: 'ORG:K1',
		page: { path: '/orders', elements: [] }
	}, {
		config: { provider: 'anthropic', anthropic: CFG, timeoutMs: 1000, maxQuestionsPerHour: 100 },
		localesDir,
		getKnowledgeText: () => 'BAZA',
		getContactText: async () => null,
		logEntry: (e) => logged.push(e),
		log: () => {},
		takeQuota: () => true,
		createResponse: async () => { throw new Error('OpenAI nie powinno być wołane'); },
		createMessage: async (body) => { bodies.push(body); return message({ status: 'answered', answer: 'Proszę kliknąć „Kopiuj”.', highlight: null }); }
	});
	assert.equal(r.status, 'answered');
	assert.equal(r.answer, 'Proszę kliknąć „Kopiuj”.');
	assert.equal(bodies.length, 1);
	assert.match(bodies[0].system[1].text, /\S/, 'kontekst ekranu w drugim bloku system');
	assert.deepEqual(logged[0].usage, { in: 110, out: 5, cached: 100 });
});
