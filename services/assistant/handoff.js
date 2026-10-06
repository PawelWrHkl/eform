/**
 * Przekazanie rozmowy z asystentem do konsultanta — mail z transkryptem.
 *
 * Adresat: `ASSISTANT_HANDOFF_EMAIL_<IDENT_ORGANIZACJI>` (np. `_LUXANGMBH`)
 * albo ogólny `ASSISTANT_HANDOFF_EMAIL`; oba mogą być listą po przecinku.
 * ⚠️ Celowo bez fallbacku na adresy z bazy — patrz komentarz w config.js.
 *
 * `Reply-To` = adres podany przez klienta, więc konsultant odpowiada zwykłym
 * „Odpowiedz", bez przepisywania adresu z treści.
 */

'use strict';

const nodemailer = require('nodemailer');
const config = require('../../config');
const { selectQuery } = require('../../db/core');
const { log } = require('../../utils/logging');

/** Minimalny odstęp między przekazaniami tej samej rozmowy. */
const HANDOFF_COOLDOWN_MS = 5 * 60 * 1000;

const REASONS = {
	user_request: 'klient sam poprosił o konsultanta',
	model_handoff: 'asystent nie znał odpowiedzi',
	rate_limited: 'klient wyczerpał limit pytań do asystenta',
	refusal: 'model odmówił odpowiedzi',
	bad_reply: 'błąd asystenta (odpowiedź niezgodna z formatem)'
};

let transporter = null;
function getTransporter() {
	if (!transporter) {
		transporter = nodemailer.createTransport({
			host: 'serwer2560216.home.pl',
			port: 587,
			secure: false,
			auth: { user: process.env.MAILBOT_USER, pass: process.env.MAILBOT_PASSWORD },
			tls: { rejectUnauthorized: false }
		});
	}
	return transporter;
}

function reasonLabel(reason) {
	const r = String(reason || '');
	if (REASONS[r]) return REASONS[r];
	if (r.startsWith('api:') || r.startsWith('incomplete:')) return `asystent był niedostępny (${r})`;
	return r.slice(0, 60) || '-';
}

function addressList(raw) {
	return String(raw || '').split(',').map((a) => a.trim()).filter(Boolean);
}

function resolveRecipients(orgIdent, env = process.env, fallback = config.assistant.handoffEmail) {
	const suffix = String(orgIdent || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
	const perOrg = suffix ? addressList(env[`ASSISTANT_HANDOFF_EMAIL_${suffix}`]) : [];
	return perOrg.length ? perOrg : addressList(fallback);
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
function isEmail(value) {
	return typeof value === 'string' && value.length <= 200 && EMAIL_RE.test(value);
}

/** Profil klienta do maila — z bazy, po pinie bieżącego użytkownika (z kontekstem ownera). */
async function loadClientProfile(pin, deps = {}) {
	const select = deps.select || selectQuery;
	if (!pin) return null;
	const rows = await select(
		`SELECT u.ident, u.client_name, u.email, u.phone, u.country,
		        o.ident AS org_ident, o.name AS org_name
		   FROM \`user\` u
		   LEFT JOIN organization o ON o.id = u.organization_id
		  WHERE u.pin = ?
		  LIMIT 1`,
		[pin]
	);
	return (rows && rows[0]) || null;
}

function clean(value, max = 500) {
	return String(value || '').replace(/\r/g, '').trim().slice(0, max);
}

function formatTranscript(messages) {
	return messages.map((m) => {
		const time = m.at ? new Date(m.at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' }) : '';
		const who = m.role === 'assistant' ? `Asystent${m.status && m.status !== 'answered' ? ` [${m.status}]` : ''}` : 'Klient';
		return `[${time}] ${who}:\n${m.text}`;
	}).join('\n\n');
}

/**
 * @param {object} p
 * @param {object} p.state        req.session.assistant
 * @param {object} p.profile      wynik loadClientProfile (może być null)
 * @param {object} p.account      { type, label }  opis konta z sesji
 * @param {object} [p.extra]      { employee, shopName } — kto faktycznie pisze
 * @param {string} p.contactEmail
 * @param {string} [p.contactPhone]
 * @param {string} [p.note]
 * @param {string} p.lang
 * @param {string} [p.pagePath]
 * @param {string} p.reason       klucz z REASONS
 * @param {object} [deps]         { sendMail, env, log, now }
 * @returns {Promise<{sent:boolean, error?:string}>}
 */
async function sendHandoff(p, deps = {}) {
	const env = deps.env || process.env;
	const zapisz = deps.log || log;
	const now = deps.now ? deps.now() : Date.now();
	const state = p.state;

	if (!state || !Array.isArray(state.messages)) return { sent: false, error: 'no_conversation' };
	if (state.handoff && now - new Date(state.handoff.at).getTime() < HANDOFF_COOLDOWN_MS) {
		return { sent: false, error: 'too_soon' };
	}
	if (!isEmail(p.contactEmail)) return { sent: false, error: 'invalid_email' };

	const profile = p.profile || {};
	const orgIdent = profile.org_ident || p.orgIdent || '';
	const to = resolveRecipients(orgIdent, env, deps.fallback !== undefined ? deps.fallback : config.assistant.handoffEmail);
	if (!to.length) {
		zapisz(`[assistant] ⚠️ brak adresata przekazań (ASSISTANT_HANDOFF_EMAIL / _${orgIdent}) — rozmowa NIE została przekazana`);
		return { sent: false, error: 'no_recipient' };
	}

	const clientName = clean(profile.client_name, 120);
	const ident = clean(profile.ident, 60);
	const client = clientName && ident && clientName !== ident ? `${clientName} (${ident})` : (clientName || ident || 'nieznany klient');

	const lines = [
		'Klient poprosił o kontakt przez Eforka (asystenta eForm).',
		'',
		`Klient: ${client}`,
		`Organizacja: ${clean(profile.org_name, 160) || '-'}${orgIdent ? ` [${orgIdent}]` : ''}`,
		`Typ konta: ${clean(p.account && p.account.label, 200) || '-'}`
	];
	if (p.extra && p.extra.employee) lines.push(`Pisze pracownik klienta: ${clean(p.extra.employee, 160)}`);
	if (p.extra && p.extra.shopName) lines.push(`Konto podrzędne grupy: ${clean(p.extra.shopName, 160)}`);
	lines.push(
		`Język klienta: ${p.lang}`,
		`Ekran: ${clean(p.pagePath, 200) || '-'}`,
		`Powód przekazania: ${reasonLabel(p.reason)}`,
		'',
		`Kontakt zwrotny — e-mail: ${p.contactEmail}`,
		`Kontakt zwrotny — telefon: ${clean(p.contactPhone, 50) || '-'}`
	);
	const note = clean(p.note, 2000);
	if (note) lines.push('', 'Wiadomość od klienta:', note);
	lines.push('', '──────── Rozmowa z asystentem ────────', '', formatTranscript(state.messages) || '(brak wiadomości)');

	const sendMail = deps.sendMail || ((m) => getTransporter().sendMail(m));
	try {
		await sendMail({
			from: env.MAILBOT_USER,
			to: to.join(','),
			replyTo: p.contactEmail,
			subject: `eForm – prośba o kontakt: ${client}`,
			text: lines.join('\n')
		});
	} catch (err) {
		zapisz('[assistant] wysyłka przekazania nie powiodła się:', err && err.message);
		return { sent: false, error: 'send_failed' };
	}

	state.handoff = { at: new Date(now).toISOString(), to: to.join(','), reason: p.reason };
	zapisz(`[assistant] rozmowa ${state.id} klienta ${client} przekazana do ${to.join(',')} (${p.reason})`);
	return { sent: true };
}

module.exports = {
	sendHandoff,
	loadClientProfile,
	resolveRecipients,
	isEmail,
	formatTranscript,
	reasonLabel,
	HANDOFF_COOLDOWN_MS,
	REASONS
};
