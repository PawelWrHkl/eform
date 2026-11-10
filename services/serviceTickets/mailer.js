/**
 * Maile modułu „Serwis”:
 *   sendClient(pkg)              — potwierdzenie dla klienta (jego język, numer, podsumowanie),
 *   sendHkl(pkg, { filesDir })   — zgłoszenie do serwisu HKL (po polsku, oryginał + tłumaczenie,
 *                                  link do panelu admina, zdjęcia zmniejszone sharp-em ≤ 1600 px,
 *                                  razem ≤ ~10 MB; wideo i większe pliki tylko jako lista nazw),
 *   sendStatus(pkg, { status, message }) — informacja dla klienta o zmianie statusu (admin).
 *
 * Adresat serwisu WYŁĄCZNIE z `.env`: `SERVICE_NOTIFY_EMAIL_<IDENT_ORG>` albo
 * `SERVICE_NOTIFY_EMAIL` (jak ASSISTANT_HANDOFF_EMAIL — bez fallbacku na organization.email).
 * Reply-To = e-mail klienta. `SERVICE_MAIL_REDIRECT` = tryb testowy maili do klienta.
 * Własne środowisko Nunjucks (nie nunjucks-setup, które importuje server.js).
 */

'use strict';

const path = require('path');
const nodemailer = require('nodemailer');
const nunjucks = require('nunjucks');
const config = require('../../config');
const labels = require('../assistant/labels');
const { log: defaultLog } = require('../../utils/logging');

const MAIL_IMAGE_MAX_PX = 1600;
const MAIL_ATTACHMENTS_MAX_BYTES = 10 * 1024 * 1024;
const TYPE_PL = { repair: 'Naprawa', complaint: 'Reklamacja techniczna', transport: 'Uszkodzenie w transporcie', delivery: 'Zapytanie o dostawę' };

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, 'mail')), { autoescape: true });

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

function addressList(raw) { return String(raw || '').split(',').map((a) => a.trim()).filter(Boolean); }

function resolveHklRecipients(orgIdent, e = process.env, fallback = config.service.notifyEmail) {
	const suffix = String(orgIdent || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
	const perOrg = suffix ? addressList(e[`SERVICE_NOTIFY_EMAIL_${suffix}`]) : [];
	return perOrg.length ? perOrg : addressList(fallback);
}

/** Tłumacz `service.*` w języku klienta z fallbackiem na polski; `{zmienne}` podstawiane. */
function makeT(lang, deps = {}) {
	const l = labels.normalizeLang(lang);
	const local = labels.loadLocale(l, deps);
	const pl = labels.loadLocale('pl', deps);
	return (key, vars) => {
		let text = labels.lookup(local, key) || labels.lookup(pl, key) || key;
		if (vars) text = text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
		return text;
	};
}

function from() { return `"${process.env.MAILBOT_ALIAS || 'eForm'}" <${process.env.MAILBOT_USER}>`; }
function baseUrl() { return config.publicBaseUrl || ''; }

function resolveDeps(deps = {}) {
	return {
		send: deps.send || ((opts) => getTransporter().sendMail(opts)),
		env: deps.env || process.env,
		log: deps.log || defaultLog,
		sharp: deps.sharp || (() => require('sharp')),
		fsp: deps.fsp || require('fs').promises,
		redirect: deps.redirect !== undefined ? deps.redirect : config.service.mailRedirect,
		notifyFallback: deps.notifyFallback !== undefined ? deps.notifyFallback : config.service.notifyEmail,
		localesDir: deps.localesDir
	};
}

/** Adresat maila do klienta: tryb testowy (`SERVICE_MAIL_REDIRECT`) zastępuje adres z konta. */
function clientRecipient(pkg, d) {
	const redirect = addressList(d.redirect);
	if (redirect.length) return { to: redirect, redirected: pkg.contact.email };
	return pkg.contact && pkg.contact.email ? { to: [pkg.contact.email], redirected: null } : { to: [], redirected: null };
}

function viewModel(pkg, t) {
	return {
		pkg,
		t,
		typeLabel: t(`service.type.${pkg.type}`),
		statusLabel: t(`service.status.${pkg.status}`),
		categoryLabel: pkg.category ? t(`service.category.${pkg.category}`) : null,
		items: (pkg.items || []).map((it) => ({ ...it, categoryLabel: t(`service.category.${it.category}`), departmentLabel: it.department ? (it.department[t.lang] || it.department.pl) : '' })),
		link: baseUrl() ? `${baseUrl()}/service/tickets/${pkg.id}` : null
	};
}

async function sendClient(pkg, deps) {
	const d = resolveDeps(deps);
	const lang = (pkg.client && pkg.client.lang) || 'en';
	const t = makeT(lang, d);
	t.lang = labels.normalizeLang(lang);
	const rcpt = clientRecipient(pkg, d);
	if (!rcpt.to.length) return { skipped: 'no_recipient' };
	const subject = `${rcpt.redirected ? `[TEST → ${rcpt.redirected}] ` : ''}${t('service.mail.subject_client', { number: pkg.number })}`;
	const html = env.render('client.njk', { ...viewModel(pkg, t), subject, mode: 'created' });
	await d.send({ from: from(), to: rcpt.to.join(', '), subject, html, text: `${t('service.mail.client_intro')} ${pkg.number}` });
	d.log(`[service] ${pkg.number}: mail do klienta → ${rcpt.to.join(', ')}${rcpt.redirected ? ` (przekierowany z ${rcpt.redirected})` : ''}`);
	return { to: rcpt.to.join(', ') };
}

async function sendStatus(pkg, { status, message }, deps) {
	const d = resolveDeps(deps);
	const lang = (pkg.client && pkg.client.lang) || 'en';
	const t = makeT(lang, d);
	t.lang = labels.normalizeLang(lang);
	const rcpt = clientRecipient(pkg, d);
	if (!rcpt.to.length) return { skipped: 'no_recipient' };
	const statusLabel = t(`service.status.${status}`);
	const subject = `${rcpt.redirected ? `[TEST → ${rcpt.redirected}] ` : ''}${t('service.mail.subject_status', { number: pkg.number, status: statusLabel })}`;
	const html = env.render('client.njk', { ...viewModel(pkg, t), subject, mode: 'status', newStatus: statusLabel, message: message || '' });
	await d.send({ from: from(), to: rcpt.to.join(', '), subject, html, text: `${pkg.number}: ${statusLabel}${message ? `\n\n${message}` : ''}` });
	d.log(`[service] ${pkg.number}: mail o statusie ${status} → ${rcpt.to.join(', ')}`);
	return { to: rcpt.to.join(', ') };
}

/** Zdjęcia zmniejszone do maila; reszta plików tylko z nazwy. */
async function buildAttachments(pkg, filesDir, eventId, d) {
	const files = (pkg.files || []).filter((f) => (eventId ? Number(f.event_id) === Number(eventId) : f.event_id === null || f.event_id === undefined));
	const attachments = [];
	const listed = [];
	let total = 0;
	for (const f of files) {
		if (!filesDir || !String(f.mime).startsWith('image/')) { listed.push(f); continue; }
		try {
			const buf = await d.sharp()(path.join(filesDir, f.name)).rotate().resize({ width: MAIL_IMAGE_MAX_PX, height: MAIL_IMAGE_MAX_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
			if (total + buf.length > MAIL_ATTACHMENTS_MAX_BYTES) { listed.push(f); continue; }
			total += buf.length;
			attachments.push({ filename: f.name.replace(/\.[^.]+$/, '.jpg'), content: buf, contentType: 'image/jpeg' });
		} catch (err) {
			d.log(`[service] ${pkg.number}: nie udało się zmniejszyć ${f.name} (${err && err.message}) — tylko w paczce FTP`);
			listed.push(f);
		}
	}
	return { attachments, listed };
}

async function sendHkl(pkg, { filesDir, eventId = null } = {}, deps) {
	const d = resolveDeps(deps);
	const to = resolveHklRecipients(pkg.client && pkg.client.organization_ident, d.env, d.notifyFallback);
	if (!to.length) {
		d.log(`[service] ⚠️ ${pkg.number}: brak adresata serwisu (SERVICE_NOTIFY_EMAIL / _${pkg.client && pkg.client.organization_ident}) — mail do HKL NIE wysłany`);
		return { skipped: 'no_recipient' };
	}
	const t = makeT('pl', d);
	t.lang = 'pl';
	const { attachments, listed } = await buildAttachments(pkg, filesDir, eventId, d);
	const message = eventId ? pkg.message : null;
	const subject = `${message ? 'Dopisek do zgłoszenia' : 'Zgłoszenie serwisowe'} ${pkg.number} — ${TYPE_PL[pkg.type] || pkg.type} — ${pkg.client.organization_ident || ''} ${pkg.client.ident || ''} — ${pkg.commission}`.replace(/\s+/g, ' ').trim();
	const html = env.render('hkl.njk', {
		...viewModel(pkg, t),
		typeLabel: TYPE_PL[pkg.type] || pkg.type,
		message,
		listed,
		attachedCount: attachments.length,
		adminLink: baseUrl() ? `${baseUrl()}/admin/service/${pkg.id}` : null
	});
	await d.send({ from: from(), to: to.join(', '), replyTo: pkg.contact && pkg.contact.email ? pkg.contact.email : undefined, subject, html, text: `${subject}\n\n${pkg.description_pl || pkg.description || ''}`, attachments });
	d.log(`[service] ${pkg.number}: mail do serwisu → ${to.join(', ')} (załączników ${attachments.length}, w paczce ${listed.length})`);
	return { to: to.join(', ') };
}

module.exports = { sendClient, sendHkl, sendStatus, resolveHklRecipients, clientRecipient, buildAttachments, makeT, MAIL_IMAGE_MAX_PX, MAIL_ATTACHMENTS_MAX_BYTES };
