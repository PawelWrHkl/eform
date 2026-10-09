/**
 * Import notification mailer.
 *
 * Sends a plain-HTML summary email after each import run.
 * Recipient: process.env.IMPORT_NOTIFY_EMAIL  (falls back to EXTRA_MAIL).
 *
 * Called from services/orderImport/index.js after runImport() completes.
 * Fire-and-forget — errors are logged but never propagate to the caller.
 */

'use strict';

const nodemailer = require('nodemailer');
const { log } = require('../../utils/logging');

const transporter = nodemailer.createTransport({
  host: 'serwer2560216.home.pl',
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAILBOT_USER,
    pass: process.env.MAILBOT_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});

/**
 * Build HTML body for the import run summary.
 * @param {Array<{file:string, ok:boolean, orderId:number|null, orderIdx:string|null, error:string|null}>} results
 */
function buildHtml(results) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const statusLine = failed.length === 0
    ? `<p style="color:#1a7a1a;font-weight:bold;">✅ Wszystkie pliki zaimportowane pomyślnie (${ok.length}/${results.length}).</p>`
    : `<p style="color:#c0392b;font-weight:bold;">❌ Błąd importu — ${failed.length} z ${results.length} plików nie powiodło się.</p>`;

  let okRows = '';
  for (const r of ok) {
    const sendStatus = r.sent
      ? '<span style="color:#1a7a1a;">✅ wysłane</span>'
      : (r.sendError
        ? `<span style="color:#c0392b;">⚠ ${escHtml(r.sendError)}</span>`
        : '<span style="color:#888;">—</span>');
    const warnings = Array.isArray(r.warnings) && r.warnings.length > 0
      ? `<span style="color:#c0392b;">⚠ ${r.warnings.map(escHtml).join('<br>')}</span>`
      : '—';
    okRows += `
      <tr>
        <td style="padding:4px 8px;border:1px solid #ccc;">${escHtml(r.file)}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;color:#1a7a1a;">✅ sukces</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">${r.orderId ?? '—'}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">${escHtml(r.orderIdx ?? '—')}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">${sendStatus}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">${warnings}</td>
      </tr>`;
  }

  let failRows = '';
  for (const r of failed) {
    failRows += `
      <tr>
        <td style="padding:4px 8px;border:1px solid #ccc;">${escHtml(r.file)}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;color:#c0392b;">❌ błąd</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">—</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">—</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">—</td>
        <td style="padding:4px 8px;border:1px solid #ccc;font-family:monospace;font-size:12px;white-space:pre-wrap;">${escHtml(r.error || 'nieznany błąd')}</td>
      </tr>`;
  }

  const allRows = okRows + failRows;

  return `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><title>Import zamówień</title></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:900px;margin:0 auto;padding:20px;">
  <h2 style="border-bottom:2px solid #444;padding-bottom:8px;">📦 Raport importu zamówień</h2>
  <p style="color:#555;">Data: <strong>${new Date().toLocaleString('pl-PL')}</strong></p>
  ${statusLine}
  <table style="width:100%;border-collapse:collapse;margin-top:16px;">
    <thead>
      <tr style="background:#f0f0f0;">
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Plik</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Status</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Order ID</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Nr zlecenia</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Wysyłka</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Błąd / Uwagi</th>
      </tr>
    </thead>
    <tbody>${allRows}</tbody>
  </table>
</body>
</html>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send import summary email. Never throws.
 * @param {Array<{file:string, ok:boolean, orderId:number|null, orderIdx:string|null, error:string|null}>} results
 */
async function sendImportSummary(results) {
  const to = process.env.IMPORT_NOTIFY_EMAIL || process.env.EXTRA_MAIL;
  if (!to) {
    log('ImportMailer: no recipient configured (IMPORT_NOTIFY_EMAIL / EXTRA_MAIL), skipping.');
    return;
  }
  if (!process.env.MAILBOT_USER || !process.env.MAILBOT_PASSWORD) {
    log('ImportMailer: MAILBOT credentials not configured, skipping.');
    return;
  }

  const failed = results.filter((r) => !r.ok).length;
  const subject = failed === 0
    ? `[Import] ✅ ${results.length}/${results.length} OK — ${new Date().toLocaleDateString('pl-PL')}`
    : `[Import] ❌ BŁĄD — ${failed} z ${results.length} plików — ${new Date().toLocaleDateString('pl-PL')}`;

  const html = buildHtml(results);

  try {
    await transporter.sendMail({
      from: `"${process.env.MAILBOT_ALIAS || 'e-orders import'}" <${process.env.MAILBOT_USER}>`,
      to,
      subject,
      html,
    });
    log(`ImportMailer: summary sent to ${to} (${results.length} files, ${failed} failed)`);
  } catch (err) {
    log(`ImportMailer: failed to send email: ${err.message}`);
  }
}

module.exports = { sendImportSummary };
