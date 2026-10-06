#!/usr/bin/env node
/**
 * Luki w bazie wiedzy asystenta — pytania, na które bot NIE odpowiedział.
 *
 *   node scripts/assistantGaps.js           — ostatnie 7 dni
 *   node scripts/assistantGaps.js 30        — ostatnie 30 dni
 *
 * Czyta dziennik `logsDir/assistant/assistant-YYYY-MM-DD.jsonl` (zapisuje go
 * services/assistant/assistantService.js) i wypisuje pytania zakończone
 * przekazaniem do konsultanta (`handoff`) i odmową (`off_topic`), z liczbą
 * powtórzeń. Pytania `handoff` z powodu „asystent nie znał odpowiedzi"
 * (bez `reason` technicznego) to kandydaci do dopisania w
 * services/assistant/knowledge/*.md. Awarie API (`reason: api:*`) są liczone
 * osobno — to nie luki w wiedzy. Na końcu: odpowiedzi ocenione przez klientów 👎
 * (wpisy `type: feedback`) — treść pytania i odpowiedzi, do poprawy w bazie wiedzy.
 *
 * Tylko odczyt plików, bez bazy i bez sieci.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { logsDir } = require('../config');

const days = Math.max(1, Number(process.argv[2]) || 7);
const dir = path.join(logsDir, 'assistant');

function normalize(q) {
	return String(q || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const groups = { handoff: new Map(), off_topic: new Map() };
let technical = 0;
let answered = 0;
let total = 0;
const disliked = [];
let liked = 0;

for (let i = 0; i < days; i++) {
	const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
	const file = path.join(dir, `assistant-${day}.jsonl`);
	if (!fs.existsSync(file)) continue;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		let e;
		try { e = JSON.parse(line); } catch (_) { continue; }
		if (e.type === 'feedback') {
			if (e.value === 'up') liked++;
			else if (e.value === 'down') disliked.push(e);
			continue;
		}
		if (e.type || !e.question) continue; // wpisy rozmów głosowych mają `type`
		total++;
		if (e.status === 'answered') { answered++; continue; }
		if (e.reason && /^(api:|incomplete:|refusal|bad_reply|rate_limited)/.test(e.reason)) { technical++; continue; }
		const g = groups[e.status];
		if (!g) continue;
		const key = normalize(e.question);
		const item = g.get(key) || { question: e.question, count: 0, langs: new Set(), paths: new Set(), last: '' };
		item.count++;
		item.langs.add(e.lang);
		if (e.path) item.paths.add(e.path);
		item.last = e.at > item.last ? e.at : item.last;
		g.set(key, item);
	}
}

console.log(`Asystent eForm — ostatnie ${days} dni (${dir})`);
console.log(`pytań: ${total}, odpowiedzianych: ${answered}, awarie techniczne: ${technical}\n`);
for (const [status, title] of [['handoff', 'PRZEKAZANE KONSULTANTOWI (kandydaci do bazy wiedzy)'], ['off_topic', 'ODMOWY — POZA TEMATEM (sprawdź, czy słusznie)']]) {
	const items = [...groups[status].values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
	console.log(`── ${title}: ${items.length}`);
	for (const it of items.slice(0, 50)) {
		console.log(`${String(it.count).padStart(3)}×  ${it.question.replace(/\s+/g, ' ').slice(0, 140)}`);
		console.log(`      [${[...it.langs].join(',')}] ${[...it.paths].slice(0, 3).join(' ')}`);
	}
	console.log('');
}

console.log(`── OCENY KLIENTÓW: 👍 ${liked}, 👎 ${disliked.length}`);
for (const e of disliked.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50)) {
	console.log(`👎 [${e.lang || '-'}] ${String(e.question || '').replace(/\s+/g, ' ').slice(0, 140)}`);
	console.log(`      → ${String(e.answer || '').replace(/\s+/g, ' ').slice(0, 200)}`);
}
