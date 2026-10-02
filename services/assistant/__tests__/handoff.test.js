'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sendHandoff, resolveRecipients, isEmail, HANDOFF_COOLDOWN_MS } = require('../handoff');

function fakeMailer() {
	const sent = [];
	const sendMail = async (m) => { sent.push(m); return { messageId: 't' }; };
	sendMail.sent = sent;
	return sendMail;
}

function conversation() {
	return {
		id: 'conv-1',
		messages: [
			{ role: 'user', text: 'Jak zmienić tkaninę w wysłanym zleceniu?', at: '2026-10-01T08:00:00.000Z' },
			{ role: 'assistant', text: 'Tego nie wiem — mogę przekazać rozmowę konsultantowi.', status: 'handoff', at: '2026-10-01T08:00:05.000Z' }
		],
		handoff: null
	};
}

const base = {
	profile: { ident: 'K100', client_name: 'Rollo GmbH', email: 'k@example.com', org_ident: 'LUXANGMBH', org_name: 'Luxan GmbH' },
	account: { type: 'employee', label: 'pracownik klienta (subkonto)' },
	extra: { employee: 'Anna Nowak (login anna)' },
	contactEmail: 'anna@example.com',
	contactPhone: '+49 1',
	note: 'Proszę o telefon',
	lang: 'de',
	pagePath: '/orders/history',
	reason: 'model_handoff'
};

test('mail idzie na adres marki, z Reply-To klienta, transkryptem i kontekstem', async () => {
	const sendMail = fakeMailer();
	const state = conversation();
	const r = await sendHandoff({ ...base, state }, {
		sendMail,
		log: () => {},
		env: { ASSISTANT_HANDOFF_EMAIL_LUXANGMBH: 'de@luxan.example, de2@luxan.example', MAILBOT_USER: 'bot@x' },
		fallback: 'ogolny@hkl.example'
	});

	assert.deepEqual(r, { sent: true });
	const m = sendMail.sent[0];
	assert.equal(m.to, 'de@luxan.example,de2@luxan.example');
	assert.equal(m.replyTo, 'anna@example.com');
	assert.equal(m.from, 'bot@x');
	assert.match(m.subject, /prośba o kontakt: Rollo GmbH \(K100\)/);
	assert.match(m.text, /Organizacja: Luxan GmbH \[LUXANGMBH\]/);
	assert.match(m.text, /Pisze pracownik klienta: Anna Nowak/);
	assert.match(m.text, /Powód przekazania: asystent nie znał odpowiedzi/);
	assert.match(m.text, /Kontakt zwrotny — telefon: \+49 1/);
	assert.match(m.text, /Wiadomość od klienta:\nProszę o telefon/);
	assert.match(m.text, /Klient:\nJak zmienić tkaninę/);
	assert.match(m.text, /Asystent \[handoff\]:\nTego nie wiem/);
	assert.ok(state.handoff && state.handoff.to);
});

test('bez adresu marki — adres ogólny; bez żadnego — no_recipient i brak wysyłki', async () => {
	assert.deepEqual(resolveRecipients('HKL', {}, 'a@x.pl,b@x.pl'), ['a@x.pl', 'b@x.pl']);
	assert.deepEqual(resolveRecipients('LUXAN_EWA_KRAWCZYK', { ASSISTANT_HANDOFF_EMAIL_LUXAN_EWA_KRAWCZYK: 'pl@x.pl' }, 'a@x.pl'), ['pl@x.pl']);

	const sendMail = fakeMailer();
	const r = await sendHandoff({ ...base, state: conversation() }, { sendMail, log: () => {}, env: {}, fallback: '' });
	assert.deepEqual(r, { sent: false, error: 'no_recipient' });
	assert.equal(sendMail.sent.length, 0);
});

test('zły e-mail klienta → invalid_email', async () => {
	const r = await sendHandoff({ ...base, contactEmail: 'nie-mail', state: conversation() }, { sendMail: fakeMailer(), log: () => {}, env: {}, fallback: 'a@x.pl' });
	assert.equal(r.error, 'invalid_email');
	assert.equal(isEmail('a@b.pl'), true);
	assert.equal(isEmail('a@b'), false);
	assert.equal(isEmail('a b@c.pl'), false);
});

test('druga próba przekazania w ciągu 5 minut → too_soon; po odstępie przechodzi', async () => {
	const sendMail = fakeMailer();
	const state = conversation();
	const t0 = Date.parse('2026-10-01T08:01:00.000Z');
	const d = { sendMail, log: () => {}, env: {}, fallback: 'a@x.pl' };

	assert.equal((await sendHandoff({ ...base, state }, { ...d, now: () => t0 })).sent, true);
	assert.equal((await sendHandoff({ ...base, state }, { ...d, now: () => t0 + 60_000 })).error, 'too_soon');
	assert.equal((await sendHandoff({ ...base, state }, { ...d, now: () => t0 + HANDOFF_COOLDOWN_MS + 1 })).sent, true);
	assert.equal(sendMail.sent.length, 2);
});

test('awaria SMTP → send_failed, rozmowa nie jest oznaczona jako przekazana', async () => {
	const state = conversation();
	const r = await sendHandoff({ ...base, state }, {
		sendMail: async () => { throw new Error('smtp down'); },
		log: () => {}, env: {}, fallback: 'a@x.pl'
	});
	assert.equal(r.error, 'send_failed');
	assert.equal(state.handoff, null);
});

test('powód „api:timeout" opisany po ludzku', async () => {
	const sendMail = fakeMailer();
	await sendHandoff({ ...base, reason: 'api:timeout', state: conversation() }, { sendMail, log: () => {}, env: {}, fallback: 'a@x.pl' });
	assert.match(sendMail.sent[0].text, /asystent był niedostępny \(api:timeout\)/);
});
