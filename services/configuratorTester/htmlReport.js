/**
 * Standalone, browsable HTML report saved next to the JSON one.
 *
 * Adapted from the scaffold the project owner supplied
 * (`Efora_automatyczny_tester_kod`, `src/runner.js:htmlReport`): the idea of a
 * self-contained file anyone can open — no server, no shell — is worth
 * keeping, and it satisfies the brief's "czytelny raport błędów". Screenshots
 * are linked relatively so the report and its `screenshots/` folder can be
 * copied or zipped together.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const PRIORITY_STYLE = {
  P1: 'background:#fce8e6;color:#a01b0b;font-weight:bold;',
  HIGH: 'background:#fff4e5;color:#8a4b00;font-weight:bold;',
  MEDIUM: 'background:#f3f4f6;color:#444;'
};

function findingRows(findings) {
  if (!findings.length) {
    return '<tr><td colspan="7" style="padding:12px;background:#e9f5ec;color:#1a7a1a;">Brak zgłoszeń — wszystkie sprawdzone konfiguracje przeszły.</td></tr>';
  }
  return findings.map((f) => `
    <tr>
      <td style="${PRIORITY_STYLE[f.priority] || ''}">${esc(f.priority)}</td>
      <td>${esc(f.code)}</td>
      <td>${esc(f.groupNumber)}</td>
      <td>${f.positionId != null ? '#' + esc(f.positionId) : '—'}</td>
      <td>${f.expected != null ? esc(typeof f.expected === 'object' ? JSON.stringify(f.expected) : f.expected) : '—'}</td>
      <td>${f.actual != null ? esc(typeof f.actual === 'object' ? JSON.stringify(f.actual) : f.actual) : '—'}</td>
      <td>${f.screenshot ? `<a href="${esc(f.screenshot)}">zrzut ekranu</a>` : '—'}</td>
    </tr>
    <tr><td colspan="7" style="font-size:13px;color:#555;border-top:0;">${esc(f.message)}</td></tr>`).join('');
}

function groupRows(groups) {
  return (groups || []).map((g) => {
    const status = g.skipped
      ? '<span style="color:#888;">pominięta</span>'
      : (g.findings === 0
        ? '<span style="color:#1a7a1a;">czysto</span>'
        : `<span style="color:#c0392b;">${g.findings} zgł. (P1: ${(g.byPriority && g.byPriority.P1) || 0})</span>`);
    return `
      <tr>
        <td>${esc(g.groupNumber)}</td>
        <td>${status}</td>
        <td>${g.positionsChecked != null ? esc(g.positionsChecked) + (g.positionsTotal ? ' / ' + esc(g.positionsTotal) : '') : '—'}</td>
        <td style="font-size:13px;color:#666;">${esc(g.reason || '')}</td>
      </tr>`;
  }).join('');
}

function buildHtml(report) {
  const { totalFindings, byPriority = {}, groupsChecked, findings = [], groups = [] } = report;
  const t = report.totals || {};
  const generated = t.rangeCases
    ? `<p>Konfiguracje wygenerowane przez tester: <strong>${t.rangeCases}</strong> — ${t.rangeInRange} w zakresie wymiarów cenników, ${t.rangeOutOfRange} poza zakresem, ${t.rangeOptionCases || 0} po opcjach (tkaniny, kolory, modele).</p>`
    : '';
  const coverage = t.positionsChecked
    ? `<p>Zakres sprawdzenia: <strong>${t.positionsChecked}</strong> pozycji z ${t.positionsTotal}${t.positionsInDb ? ` (baza ma ${t.positionsInDb} pozycji w tych grupach)` : ''}${t.duplicates ? `, ${t.duplicates} pominiętych jako identyczne konfiguracje` : ''}, <strong>${t.comparedToPriceList}</strong> porównań z cennikiem źródłowym, ${t.scriptsRun || 0} z wdrożonym skryptem cenowym, ${t.comparedToStored} z ceną zapisaną, ${t.cartChecked} kontroli powtarzalności${t.failed ? `, ${t.failed} nie dało się przeliczyć` : ''}.</p>`
    : '';

  const headline = totalFindings === 0
    ? `<p style="color:#1a7a1a;font-size:17px;font-weight:bold;">✅ Brak zgłoszeń — sprawdzono ${groupsChecked} grup.</p>`
    : `<p style="color:#c0392b;font-size:17px;font-weight:bold;">❌ ${totalFindings} zgłoszeń — P1: ${byPriority.P1 || 0}, HIGH: ${byPriority.HIGH || 0}, MEDIUM: ${byPriority.MEDIUM || 0} (na ${groupsChecked} grup).</p>`;

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raport testera konfiguratora Efora</title>
<style>
  body { font: 15px/1.5 Arial, sans-serif; margin: 24px; color: #172a3a; }
  h1 { font-size: 22px; border-bottom: 2px solid #172a3a; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #bcc8ce; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #172a3a; color: #fff; }
  .meta { color: #555; font-size: 13px; }
  .note { background: #f7f9fa; border-left: 4px solid #bcc8ce; padding: 10px 14px; font-size: 13px; color: #555; }
</style>
</head>
<body>
  <h1>Raport automatycznego testera konfiguratora Efora</h1>
  <p class="meta">Start: ${esc(report.startedAt)} &nbsp;|&nbsp; Koniec: ${esc(report.finishedAt)}</p>
  ${headline}
  ${coverage}
  ${generated}
  <div class="note">
    Ceny porównywane są z niezależnym cennikiem źródłowym z <code>/mnt/eformconf</code> (arkusz per grupa,
    wariant cennika wg klienta z <code>prod.txt</code>) — po stronie portalu brany jest wynik
    <strong>wdrożonego skryptu</strong> <code>param-&lt;PARAMETR&gt;-&lt;wariant&gt;.js</code>, czyli tego, co serwuje
    aplikacja. <strong>BRAK_DANYCH_REFERENCYJNYCH</strong> oznacza, że dla danej
    konfiguracji nie dało się ustalić ceny wzorcowej — to nie błąd wyceny.
    <strong>PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM</strong> dotyczy samego testera (bezgłowe przeliczenie rozjechało się
    z wdrożonym skryptem), nie ceny widzianej przez klienta.
    <strong>WALIDACJA_WYMIARU_DO_SPRAWDZENIA</strong> i <strong>CENA_POCHODNA_DO_SPRAWDZENIA</strong> to sygnały orientacyjne
    wymagające ręcznego potwierdzenia.
  </div>

  <h2>Sprawdzone grupy asortymentowe</h2>
  <table>
    <thead><tr><th>Grupa</th><th>Wynik</th><th>Sprawdzonych pozycji</th><th>Uwagi</th></tr></thead>
    <tbody>${groupRows(groups)}</tbody>
  </table>

  <h2>Zgłoszenia</h2>
  <table>
    <thead><tr><th>Priorytet</th><th>Kod</th><th>Grupa</th><th>Pozycja</th><th>Oczekiwano</th><th>Otrzymano</th><th>Dowód</th></tr></thead>
    <tbody>${findingRows(findings)}</tbody>
  </table>
</body>
</html>`;
}

/** Writes `report.html` alongside the JSON report; returns its path. */
function saveHtmlReport(report, jsonReportPath) {
  const filePath = jsonReportPath.replace(/\.json$/, '.html');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildHtml(report));
  return filePath;
}

module.exports = { saveHtmlReport, buildHtml };
