/**
 * Error-report mailer for the configurator tester — same transporter/config
 * pattern as services/mailBot/importMailer.js, separate recipient env var.
 * Fire-and-forget: errors are logged but never thrown.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { log } = require('./logger');

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

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findingRow(f) {
  return `
    <tr>
      <td style="padding:4px 8px;border:1px solid #ccc;color:${f.priority === 'P1' ? '#c0392b' : '#b8860b'};font-weight:bold;">${escHtml(f.priority)}</td>
      <td style="padding:4px 8px;border:1px solid #ccc;">${escHtml(f.code)}</td>
      <td style="padding:4px 8px;border:1px solid #ccc;">${escHtml(f.groupNumber)}</td>
      <td style="padding:4px 8px;border:1px solid #ccc;">${f.positionId != null ? `#${escHtml(f.positionId)}` : '—'}</td>
      <td style="padding:4px 8px;border:1px solid #ccc;">${f.expected != null ? escHtml(JSON.stringify(f.expected)) : '—'}</td>
      <td style="padding:4px 8px;border:1px solid #ccc;">${f.actual != null ? escHtml(JSON.stringify(f.actual)) : '—'}</td>
      <td style="padding:4px 8px;border:1px solid #ccc;">${f.priceDiff != null ? escHtml(f.priceDiff) : '—'}</td>
      <td style="padding:4px 8px;border:1px solid #ccc;font-size:12px;">${escHtml(f.message)}</td>
    </tr>`;
}

function buildHtml(report, reportFilePath) {
  const { totalFindings, byPriority, groupsChecked, groupsSkipped, findings } = report;

  const t = report.totals || {};
  const coverage = t.positionsChecked
    ? `<p style="color:#333;">Zakres sprawdzenia: <strong>${t.positionsChecked}</strong> pozycji z ${t.positionsTotal},
       <strong>${t.comparedToPriceList}</strong> porównań z cennikiem źródłowym,
       ${t.comparedToStored} z ceną zapisaną w zamówieniu, ${t.cartChecked} kontroli powtarzalności${t.failed ? `, ${t.failed} nie dało się przeliczyć` : ''}.</p>`
    : '';

  // Symulacja i parsowanie skryptów nie liczą „pozycji", więc bez własnych
  // zdań ich praca nie byłaby w mailu widoczna wcale.
  const simulationLine = t.simulated
    ? `<p style="color:#333;">Symulacja tworzenia pozycji: <strong>${t.simulationPassed}/${t.simulated}</strong> grup zdanych.</p>`
    : '';
  const scriptsLine = t.scriptsParsed
    ? `<p style="color:#333;">Wdrożone skrypty cenowe: sprawdzono <strong>${t.scriptsParsed}</strong>, niesparsowalnych <strong>${t.scriptsBroken}</strong>.</p>`
    : '';

  const statusLine = totalFindings === 0
    ? `<p style="color:#1a7a1a;font-weight:bold;">✅ Brak błędów — sprawdzono ${groupsChecked} grup.</p>`
    : `<p style="color:#c0392b;font-weight:bold;">❌ Wykryto ${totalFindings} błędów (P1: ${byPriority.P1 || 0}, HIGH: ${byPriority.HIGH || 0}, MEDIUM: ${byPriority.MEDIUM || 0}) na ${groupsChecked} sprawdzonych grup.</p>`;

  const skippedNote = groupsSkipped.length
    ? `<p style="color:#888;">Pominięto ${groupsSkipped.length} grup (brak zapisanych pozycji jako punkt startowy — patrz Faza 1 w dokumentacji): ${groupsSkipped.map((g) => escHtml(g.groupNumber)).join(', ')}.</p>`
    : '';

  const rows = findings.map(findingRow).join('');

  // Which groups were actually covered. "sprawdzono 15 grup" on its own does
  // not tell a reader whether THEIR product line was tested.
  const groupRows = (report.groups || []).map((g) => {
    const status = g.skipped
      ? '<span style="color:#888;">pominięta</span>'
      : (g.findings === 0
        ? '<span style="color:#1a7a1a;">✅ czysto</span>'
        : `<span style="color:#c0392b;">${g.findings} zgł. (P1: ${g.byPriority.P1 || 0})</span>`);
    return `
      <tr>
        <td style="padding:4px 8px;border:1px solid #ccc;">${escHtml(g.groupNumber)}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">${status}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;">${g.positionsChecked != null ? escHtml(g.positionsChecked) : '—'}</td>
        <td style="padding:4px 8px;border:1px solid #ccc;font-size:12px;color:#666;">${escHtml(g.reason || '')}</td>
      </tr>`;
  }).join('');

  const groupsTable = groupRows ? `
  <h3 style="margin-top:24px;font-size:15px;">Sprawdzone grupy asortymentowe</h3>
  <table style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="background:#f0f0f0;">
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Grupa</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Wynik</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Sprawdzonych pozycji</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Uwagi</th>
      </tr>
    </thead>
    <tbody>${groupRows}</tbody>
  </table>` : '';

  return `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><title>Raport testera konfiguratora</title></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:1100px;margin:0 auto;padding:20px;">
  <h2 style="border-bottom:2px solid #444;padding-bottom:8px;">🤖 Raport automatycznego testera konfiguratora Efora</h2>
  <p style="color:#555;">Data: <strong>${new Date(report.finishedAt).toLocaleString('pl-PL')}</strong></p>
  ${statusLine}
  ${coverage}
  ${simulationLine}
  ${scriptsLine}
  ${skippedNote}
  <p style="color:#888;font-size:12px;">
    Ceny są porównywane z niezależnym cennikiem źródłowym z /mnt/eformconf (arkusz per grupa,
    wariant cennika wg klienta z prod.txt). Wpisy <strong>BRAK_DANYCH_REFERENCYJNYCH</strong> oznaczają,
    że dla danej konfiguracji nie dało się ustalić ceny wzorcowej — nie są błędem wyceny.
    Wpisy <strong>WALIDACJA_WYMIARU_DO_SPRAWDZENIA</strong> to sygnał orientacyjny wymagający ręcznego
    potwierdzenia w przeglądarce. Pełny raport JSON jest <strong>załączony do tej wiadomości</strong>
    (kopia na serwerze: ${escHtml(reportFilePath)}).
  </p>
  ${groupsTable}
  ${findings.length ? `<table style="width:100%;border-collapse:collapse;margin-top:16px;">
    <thead>
      <tr style="background:#f0f0f0;">
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Priorytet</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Kod</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Grupa</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Pozycja</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Oczekiwano</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Otrzymano</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Różnica ceny</th>
        <th style="padding:6px 8px;border:1px solid #ccc;text-align:left;">Komunikat</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>` : ''}
</body>
</html>`;
}

/**
 * @param {object} report - from reportBuilder.buildRunReport()
 * @param {string} reportFilePath - path returned by outputStore.saveRunReport()
 */
async function sendTestReport(report, reportFilePath) {
  // Deliberately NOT falling back to EXTRA_MAIL (unlike importMailer.js) — that
  // address is the operational import-notification recipient; silently
  // reusing it would send this module's test reports to an inbox that never
  // opted into them. Require an explicit, dedicated recipient instead.
  // Wyłącznik na czas pracy nad testerem: każdy przebieg wysyła raport do
  // czterech osób, więc kilka przejazdów weryfikacyjnych pod rząd to kilka
  // maili do kolegów o niczym. `CONFIGTEST_NO_MAIL=true` zostawia raport na
  // dysku i tylko odnotowuje pominięcie — nigdy nie wycisza po cichu.
  if (process.env.CONFIGTEST_NO_MAIL === 'true') {
    log('ConfiguratorTester mailer: wysyłka pominięta (CONFIGTEST_NO_MAIL=true) — raport jest na dysku.');
    return;
  }

  const to = process.env.CONFIGTEST_NOTIFY_EMAIL;
  if (!to) {
    log('ConfiguratorTester mailer: no recipient configured (CONFIGTEST_NOTIFY_EMAIL), skipping.');
    return;
  }
  if (!process.env.MAILBOT_USER || !process.env.MAILBOT_PASSWORD) {
    log('ConfiguratorTester mailer: MAILBOT credentials not configured, skipping.');
    return;
  }

  const { totalFindings, byPriority } = report;
  const groupCount = (report.groups || []).length;
  const subject = totalFindings === 0
    ? `[Tester konfiguratora] ✅ 0 błędów, ${groupCount} grup — ${new Date().toLocaleDateString('pl-PL')}`
    : `[Tester konfiguratora] ❌ ${totalFindings} zgłoszeń (P1: ${byPriority.P1 || 0}) z ${groupCount} grup — ${new Date().toLocaleDateString('pl-PL')}`;

  // Attach the report itself: the recipients do not have shell access to the
  // host, so a path under /mnt/eform is of no use to them on its own.
  const attachments = [];
  try {
    if (reportFilePath && fs.existsSync(reportFilePath)) {
      attachments.push({ filename: path.basename(reportFilePath), path: reportFilePath, contentType: 'application/json' });
    }
  } catch (_err) { /* brak załącznika nie może blokować wysyłki */ }

  try {
    await transporter.sendMail({
      from: `"${process.env.MAILBOT_ALIAS || 'Tester konfiguratora Efora'}" <${process.env.MAILBOT_USER}>`,
      to,
      subject,
      html: buildHtml(report, reportFilePath),
      attachments
    });
    log(`ConfiguratorTester mailer: report sent to ${to} (${totalFindings} findings)`);
  } catch (err) {
    log(`ConfiguratorTester mailer: failed to send email: ${err.message}`);
  }
}

module.exports = { sendTestReport };
