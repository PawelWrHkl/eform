/**
 * Czat asystenta eForm na Claude (Anthropic Messages API) — włączany przez
 * `ASSISTANT_PROVIDER=anthropic`. Domyślny dostawca to nadal OpenAI
 * (openaiClient.js); rozmowa głosowa zostaje na OpenAI Realtime niezależnie od
 * tej flagi, bo Anthropic nie ma odpowiednika.
 *
 * Ten sam kontrakt co ścieżka OpenAI w assistantService.ask: model dostaje
 * reguły + bazę wiedzy, kontekst ekranu, historię i narzędzia z danymi konta,
 * a odpowiada JSON-em wg prompt.buildResponseFormat. `runChat` zwraca
 * `{text, refusal, status, reason}` jak openaiClient.extractOutput.
 *
 * Oficjalne SDK (`@anthropic-ai/sdk`) — ponawia 429/5xx samo (2 razy, domyślnie).
 * ⚠️ Klucz API żyje tylko tutaj, po stronie serwera (`.env.local`).
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;
const { AssistantApiError } = require('./openaiClient');

/** Limit wyjścia z myśleniem; odpowiedź i tak ucina MAX_ANSWER_CHARS w assistantService. */
const MAX_TOKENS = 16000;
/** Ile znaków wyniku narzędzia trafia do modelu (jak w ścieżce OpenAI). */
const MAX_TOOL_OUTPUT_CHARS = 12000;
/** Odmowa klasyfikatora → serwer ponawia na modelu zapasowym (Opus/Sonnet/Fable; Haiku nie ma zapasu). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let cached = null; // { key, client }

function clientFor(cfg) {
	const key = [cfg.apiKey, cfg.workspaceId, cfg.timeoutMs].join('|');
	if (!cached || cached.key !== key) {
		cached = {
			key,
			client: new Anthropic({
				apiKey: cfg.apiKey,
				timeout: cfg.timeoutMs,
				// Klucz konta użytkownika (nieprzypisany do workspace'u) bez tego nagłówka dostaje HTTP 400.
				defaultHeaders: cfg.workspaceId ? { 'anthropic-workspace-id': cfg.workspaceId } : undefined
			})
		};
	}
	return cached.client;
}

/** Błąd SDK → AssistantApiError z kodem, z którego assistantService robi `reason` w dzienniku. */
function toApiError(err) {
	if (err instanceof AssistantApiError) return err;
	if (err instanceof Anthropic.APIConnectionTimeoutError) return new AssistantApiError(`Claude: ${err.message}`, { code: 'timeout' });
	if (err instanceof Anthropic.APIConnectionError) return new AssistantApiError(`Claude: ${err.message}`, { code: 'network' });
	if (err instanceof Anthropic.APIError) {
		const type = err.error && err.error.error && err.error.error.type;
		return new AssistantApiError(`Claude HTTP ${err.status}: ${err.message}`, { status: err.status || null, code: type || 'http_error' });
	}
	return err;
}

/**
 * @param {object} body treść żądania Messages API (z `betas`)
 * @param {{apiKey:string, workspaceId?:string, timeoutMs:number}} cfg
 * @returns {Promise<object>} odpowiedź (Message)
 */
async function createMessage(body, cfg) {
	if (!cfg.apiKey) throw new AssistantApiError('Brak ANTHROPIC_API_KEY', { code: 'no_api_key' });
	try {
		return await clientFor(cfg).beta.messages.create(body);
	} catch (err) {
		throw toApiError(err);
	}
}

/**
 * Tekst odpowiedzi z `content[]`. Odmowa (`stop_reason: refusal`) i odpowiedź
 * ucięta (`max_tokens` itp.) nie są odpowiedzią — wywołujący traktuje je jak „nie wiem".
 *
 * @returns {{text:string|null, refusal:string|null, status:string, reason:string|null}}
 */
function extractOutput(msg) {
	const out = { text: null, refusal: null, status: 'completed', reason: null };
	const stop = msg && msg.stop_reason;
	if (stop === 'refusal') out.refusal = (msg.stop_details && msg.stop_details.category) || 'refusal';
	else if (stop !== 'end_turn' && stop !== 'stop_sequence') {
		out.status = 'incomplete';
		out.reason = stop || null;
	}
	const parts = (Array.isArray(msg && msg.content) ? msg.content : [])
		.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text);
	if (parts.length) out.text = parts.join('');
	return out;
}

/** Definicje z tools.responsesTools → format Messages API (`input_schema`). */
function toTools(defs) {
	return (defs || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true }));
}

/** Historia z sesji → messages. Pierwsza musi być od użytkownika (notatki systemowe na początku odpadają). */
function historyMessages(history) {
	const msgs = (history || [])
		.filter((m) => m && m.text)
		.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
	while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
	return msgs;
}

function addUsage(acc, usage) {
	if (!acc || !usage) return;
	const cachedIn = (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
	acc.in += (Number(usage.input_tokens) || 0) + cachedIn;
	acc.out += Number(usage.output_tokens) || 0;
	if (usage.cache_read_input_tokens) acc.cached = (acc.cached || 0) + Number(usage.cache_read_input_tokens);
}

/**
 * Jedna runda pytanie → odpowiedź z pętlą narzędzi (find_orders → get_order…);
 * w ostatniej rundzie narzędzia są wyłączone, więc model musi odpowiedzieć.
 *
 * @param {object} p
 * @param {object} p.cfg            config.assistant.anthropic + timeoutMs
 * @param {string} p.instructions   reguły + baza wiedzy (prompt.buildInstructions)
 * @param {string} p.context        prompt.buildContextMessage
 * @param {Array}  p.history        wypowiedzi z sesji (bez bieżącego pytania)
 * @param {string} p.question
 * @param {Array}  p.tools          tools.responsesTools(scope)
 * @param {object} p.format         prompt.buildResponseFormat(...)
 * @param {string} p.userId         assistantService.safetyId — bez danych osobowych
 * @param {Function} p.runTool      (name, args) → wynik narzędzia
 * @param {number} p.maxRounds
 * @param {{in:number,out:number}} [p.usage]  licznik tokenów (uzupełniany)
 * @param {Function} [p.createMessage] wstrzyknięcie do testów
 */
async function runChat(p) {
	const cfg = p.cfg;
	const call = p.createMessage || ((b) => createMessage(b, cfg));
	const tools = toTools(p.tools);
	const messages = [...historyMessages(p.history), { role: 'user', content: p.question }];

	for (let round = 0; ; round++) {
		const last = round >= p.maxRounds;
		const body = {
			model: cfg.model,
			max_tokens: MAX_TOKENS,
			// Reguły + baza wiedzy są identyczne dla wszystkich klientów w danym języku,
			// więc idą do cache; kontekst (ekran, konto) zmienia się per pytanie — za punktem cache.
			system: [
				{ type: 'text', text: p.instructions, cache_control: { type: 'ephemeral' } },
				{ type: 'text', text: p.context }
			],
			messages,
			output_config: { effort: cfg.effort, format: { type: 'json_schema', schema: p.format.schema } },
			metadata: { user_id: p.userId }
		};
		if (!/haiku/i.test(cfg.model)) {
			body.betas = [FALLBACK_BETA];
			body.fallbacks = 'default';
		}
		if (tools.length) {
			body.tools = tools;
			body.tool_choice = { type: last ? 'none' : 'auto' };
		}
		const msg = await call(body);
		addUsage(p.usage, msg && msg.usage);

		const calls = (Array.isArray(msg && msg.content) ? msg.content : []).filter((b) => b && b.type === 'tool_use');
		if (calls.length && !last && msg.stop_reason === 'tool_use') {
			// Cała treść (z blokami myślenia) wraca bez zmian — wymóg API przy kolejnej rundzie.
			messages.push({ role: 'assistant', content: msg.content });
			const results = [];
			for (const c of calls) {
				const res = await p.runTool(c.name, c.input || {});
				results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(res).slice(0, MAX_TOOL_OUTPUT_CHARS) });
			}
			messages.push({ role: 'user', content: results });
			continue;
		}
		return extractOutput(msg);
	}
}

module.exports = { runChat, createMessage, extractOutput, toTools, historyMessages, _toApiError: toApiError };
