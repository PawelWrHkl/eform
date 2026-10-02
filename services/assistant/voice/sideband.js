/**
 * Sideband — równoległe połączenie SERWERA z rozmową głosową klienta
 * (`wss://api.openai.com/v1/realtime?call_id=…`). Serwer dostaje te same
 * zdarzenia co przeglądarka, więc:
 *   • transkrypt do maila dla konsultanta i dziennika pochodzi od OpenAI,
 *     a nie z przeglądarki,
 *   • widać próbę podmiany instrukcji (`session.updated`) — voiceService
 *     wtedy rozłącza rozmowę,
 *   • serwer może sam dopisać polecenie do rozmowy (np. „klient przeszedł
 *     na nowy ekran") bez nadpisywania instrukcji sesji.
 *
 * Klient `ws` (jest w node_modules jako zależność jsdom/puppeteer): Node 18
 * z obrazu Dockera nie ma globalnego WebSocketu, a standardowy WebSocket
 * nie pozwala ustawić nagłówka Authorization.
 */

'use strict';

/**
 * @param {object} p
 * @param {string} p.url        pełny adres z `?call_id=`
 * @param {string} p.apiKey
 * @param {(event:object)=>void} p.onEvent
 * @param {(info:{code:number, reason:string})=>void} [p.onClose]
 * @param {number} [p.openTimeoutMs]
 * @param {object} [deps]       { WebSocket } — atrapa w testach
 * @returns {{ready:Promise<void>, send:(obj:object)=>boolean, close:()=>void}}
 */
function connectSideband(p, deps = {}) {
	const WS = deps.WebSocket || require('ws');
	const ws = new WS(p.url, { headers: { Authorization: `Bearer ${p.apiKey}` } });
	let opened = false;

	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('sideband: przekroczony czas połączenia'));
			try { ws.terminate ? ws.terminate() : ws.close(); } catch (_) { /* już zamknięty */ }
		}, p.openTimeoutMs || 8000);
		ws.on('open', () => { opened = true; clearTimeout(timer); resolve(); });
		ws.on('error', (err) => { if (!opened) { clearTimeout(timer); reject(err); } });
	});
	// Odrzucenie `ready` obsługuje wywołujący; tu tylko nie zostawiamy go „nieobsłużonego".
	ready.catch(() => {});

	ws.on('message', (data) => {
		let event;
		try {
			event = JSON.parse(String(data));
		} catch (_) {
			return;
		}
		if (event && typeof event.type === 'string') p.onEvent(event);
	});
	ws.on('close', (code, reason) => {
		if (p.onClose) p.onClose({ code, reason: String(reason || '') });
	});
	ws.on('error', () => { /* błąd po otwarciu kończy się zdarzeniem close */ });

	return {
		ready,
		send(obj) {
			if (ws.readyState !== 1) return false;
			ws.send(JSON.stringify(obj));
			return true;
		},
		close() {
			try { ws.close(); } catch (_) { /* już zamknięty */ }
		}
	};
}

module.exports = { connectSideband };
