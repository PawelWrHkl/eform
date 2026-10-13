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

/**
 * Silnik bezgłowy robota nie ma tłumaczeń (`t()` oddaje klucz), więc w jego
 * zgłoszeniach siedzi `order.according_to_price` tam, gdzie klient widzi
 * „według cennika". W raporcie pokazujemy to drugie.
 */
function humanize(str) {
  return String(str ?? '').replace(/order\.according_to_price/g, 'według cennika');
}

function escHtml(str) {
  return humanize(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const { CATEGORY, splitByCategory, loadLabels, loadProductNames } = require('./reportCategories');

const PRIORITY_COLOR = { P1: '#c0392b', HIGH: '#d35400', MEDIUM: '#7f8c8d' };
const PRIORITY_LABEL = { P1: 'KRYTYCZNE', HIGH: 'WYSOKIE', MEDIUM: 'DO SPRAWDZENIA' };

function badge(priority) {
  const c = PRIORITY_COLOR[priority] || '#7f8c8d';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${c};color:#fff;font-size:11px;font-weight:bold;">${escHtml(PRIORITY_LABEL[priority] || priority)}</span>`;
}

/** „ROLETY › 76 · NOWY STYL" — nazwa z interfejsu (symulacja) albo z bazy. */
function productTitle(f, names) {
  const fromDb = names.get(String(f.groupNumber)) || {};
  const department = (f.path && f.path.departmentName) || fromDb.department || '';
  const product = (f.path && f.path.groupName) || fromDb.product || '';
  const group = f.groupNumber != null ? `grupa ${escHtml(f.groupNumber)}` : '';
  return [department && escHtml(department), [group, product && escHtml(product)].filter(Boolean).join(' · ')]
    .filter(Boolean).join(' &rsaquo; ');
}

const NO_LABELS = { field: () => '', value: () => '' };
const labelsFor = (groupNumber) => (groupNumber != null ? loadLabels(groupNumber) : NO_LABELS);

/** „FALA (Rodzaj fali)" — kod pola zostaje, bo po nim się szuka w regułach. */
function fieldText(groupNumber, field) {
  const label = labelsFor(groupNumber).field(field);
  return `<strong>${escHtml(field)}</strong>${label && label !== field ? ` <span style="color:#888;">(${escHtml(label)})</span>` : ''}`;
}

/** „FLEX — ZASŁONA FLEX". */
function valueText(groupNumber, field, value) {
  const label = labelsFor(groupNumber).value(field, value);
  return `<code style="background:#f4f4f4;padding:1px 4px;">${escHtml(value)}</code>`
    + `${label && label !== value ? ` <span style="color:#555;">${escHtml(label)}</span>` : ''}`;
}

const stepText = (groupNumber, field, value) => `${fieldText(groupNumber, field)} = ${valueText(groupNumber, field, value)}`;

/**
 * Karta ślepego zaułka: produkt, model, konfiguracja krok po kroku i pole,
 * na którym formularz stanął — tak, żeby dało się to odtworzyć ręcznie bez
 * zaglądania do załącznika.
 */
function deadEndCard(f, names) {
  const p = f.path || {};
  const steps = p.steps || [];
  const stops = p.blockedAt || [];
  const model = steps.find((st) => st.field === 'MODEL');
  const source = f.source === 'simulation'
    ? 'symulacja składania nowej pozycji (robot sam przechodzi konfigurator jak klient)'
    : (f.positionId != null ? `zapisana pozycja #${escHtml(f.positionId)}, otwarta w przeglądarce` : 'test w przeglądarce');

  const stepsHtml = steps.length
    ? `<ol style="margin:6px 0 0 0;padding-left:22px;">${steps.map((st) => `<li style="margin:2px 0;">${stepText(f.groupNumber, st.field, st.value)}</li>`).join('')}</ol>`
    : '<p style="margin:6px 0;color:#888;">(formularz stanął przed pierwszym wyborem)</p>';

  const stopsHtml = stops.length
    ? stops.map((st) => `<div style="margin-top:8px;padding:8px 10px;background:#fdecea;border-left:4px solid #c0392b;">⛔ <strong>Tu formularz staje:</strong> ${fieldText(f.groupNumber, st.field)} — ${escHtml(st.reason || '')}</div>`).join('')
    : `<div style="margin-top:8px;padding:8px 10px;background:#fdecea;border-left:4px solid #c0392b;">⛔ ${escHtml(f.message)}</div>`;

  return `
  <div style="border:1px solid #e3c4c0;border-radius:6px;padding:12px 14px;margin:12px 0;background:#fffafa;">
    <table style="width:100%;border-collapse:collapse;"><tr>
      <!-- Tabela, nie flex: klienty pocztowe (Outlook i spółka) flexa nie znają
           i znaczek wagi spadał pod tytuł (zrzut właściciela 12.10). -->
      <td style="font-size:15px;font-weight:bold;padding:0;">${productTitle(f, names)}</td>
      <td style="text-align:right;white-space:nowrap;padding:0;">${badge(f.priority)}</td>
    </tr></table>
    ${model
      ? `<div style="margin-top:6px;font-size:14px;">Model: ${valueText(f.groupNumber, 'MODEL', model.value)}</div>`
      // Produkt ma pole MODEL, ale formularz stanął, zanim dało się go wybrać —
      // to też jest informacja (12.10, grupa 73: FALA próbowana przy pustym MODEL).
      : (labelsFor(f.groupNumber).field('MODEL')
        ? '<div style="margin-top:6px;font-size:14px;">Model: <em style="color:#c0392b;">jeszcze nie wybrany — formularz stanął wcześniej</em></div>'
        : '')}
    <div style="margin-top:8px;color:#555;font-size:13px;">Konfiguracja wybrana do miejsca blokady:</div>
    ${stepsHtml}
    ${stopsHtml}
    <div style="margin-top:6px;color:#999;font-size:11px;">Źródło: ${source}</div>
  </div>`;
}

const TD = 'padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;';

/** Kwota albo krótki stan („według cennika"); długie opisy są w kolumnie „Problem". */
function amount(v, { textAllowed = true } = {}) {
  if (typeof v === 'number' && Number.isFinite(v)) return `${v.toFixed(2)} €`;
  if (textAllowed && typeof v === 'string' && v.trim() && v.length <= 24) return escHtml(v);
  return '—';
}

function priceRow(f) {
  return `
    <tr>
      <td style="${TD}">${badge(f.priority)}</td>
      <td style="${TD}white-space:nowrap;">${f.positionId != null ? `poz. #${escHtml(f.positionId)}` : 'konfiguracja robota'}</td>
      <td style="${TD}font-size:13px;">${escHtml(f.message)}</td>
      <td style="${TD}text-align:right;white-space:nowrap;">${amount(f.expected, { textAllowed: false })}</td>
      <td style="${TD}text-align:right;white-space:nowrap;"><strong>${amount(f.actual)}</strong></td>
    </tr>`;
}

/**
 * Wiersze pogrupowane po produkcie — jedna usterka widziana z kilku stron
 * (grupa 76 dała 12.10 dziesięć wpisów) ma być jednym blokiem, a nie
 * dziesięcioma rozsianymi po tabeli.
 */
function groupedRows(list, names, rowFn, colspan) {
  const order = [];
  const byGroup = new Map();
  for (const f of list) {
    const key = String(f.groupNumber ?? '—');
    if (!byGroup.has(key)) { byGroup.set(key, []); order.push(key); }
    byGroup.get(key).push(f);
  }
  return order.map((key) => {
    const items = byGroup.get(key);
    return `<tr><td colspan="${colspan}" style="padding:10px 8px 4px 8px;background:#fafafa;border-bottom:1px solid #ddd;font-weight:bold;">`
      + `${productTitle(items[0], names) || escHtml(key)} <span style="color:#888;font-weight:normal;">(${items.length})</span></td></tr>`
      + items.map((f) => rowFn(f, names)).join('');
  }).join('');
}

function otherRow(f) {
  return `
    <tr>
      <td style="${TD}">${badge(f.priority)}</td>
      <td style="${TD}font-size:12px;color:#555;">${escHtml(f.message)}</td>
    </tr>`;
}

function sectionHeader(no, icon, title, count, subtitle) {
  return `
  <h2 style="margin:28px 0 4px 0;font-size:18px;border-bottom:2px solid #333;padding-bottom:6px;">
    ${no}. ${icon} ${escHtml(title)} <span style="color:#888;font-weight:normal;">(${count})</span>
  </h2>
  <div style="color:#777;font-size:12px;margin-bottom:6px;">${escHtml(subtitle)}</div>`;
}

function buildHtml(report, reportFilePath, names = new Map(), { note = null } = {}) {
  const { groupsChecked, groupsSkipped = [], findings = [] } = report;
  const cat = splitByCategory(findings);
  const deadEnds = cat[CATEGORY.DEAD_END];
  const prices = cat[CATEGORY.PRICE];
  const others = cat[CATEGORY.OTHER];
  const t = report.totals || {};

  const tile = (icon, label, n, color) => `
    <td style="padding:10px 14px;border:1px solid #ddd;border-radius:6px;text-align:center;background:${n ? '#fff' : '#f6fbf6'};">
      <div style="font-size:24px;font-weight:bold;color:${n ? color : '#1a7a1a'};">${n}</div>
      <div style="font-size:12px;color:#555;">${icon} ${escHtml(label)}</div>
    </td>`;

  const section1 = sectionHeader(1, '🚧', 'Ślepe zaułki', deadEnds.length,
    'Miejsca, w których formularz nie puszcza klienta dalej — z pełną ścieżką: dział, produkt, model, wybrana konfiguracja i pole, na którym staje.')
    + (deadEnds.length
      ? deadEnds.map((f) => deadEndCard(f, names)).join('')
      : `<p style="color:#1a7a1a;">✅ Brak. W każdej sprawdzonej grupie robot przeszedł konfigurator do końca${t.simulated ? ` (symulacja: ${t.simulationPassed}/${t.simulated} grup)` : ''}.</p>`);

  const section2 = sectionHeader(2, '💶', 'Błędy cen i ceny zero', prices.length,
    'Cena niezgodna z cennikiem źródłowym, brak ceny / cena 0, uszkodzone skrypty cenowe.')
    + (prices.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f4f4f4;text-align:left;">
            <th style="${TD}">Waga</th><th style="${TD}">Gdzie</th>
            <th style="${TD}">Problem</th><th style="${TD}text-align:right;">Cennik</th><th style="${TD}text-align:right;">System</th>
          </tr></thead>
          <tbody>${groupedRows(prices, names, priceRow, 5)}</tbody>
        </table>`
      : '<p style="color:#1a7a1a;">✅ Brak.</p>');

  const section3 = sectionHeader(3, '⚙️', 'Pozostałe', others.length,
    'Sygnały do ręcznego sprawdzenia, ograniczenia samego robota, grupy pominięte z braku pamięci serwera.')
    + (others.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="background:#f4f4f4;text-align:left;">
            <th style="${TD}">Waga</th><th style="${TD}">Opis</th>
          </tr></thead>
          <tbody>${groupedRows(others, names, otherRow, 2)}</tbody>
        </table>`
      : '<p style="color:#1a7a1a;">✅ Brak.</p>');

  const scope = [
    t.positionsChecked ? `${t.positionsChecked} z ${t.positionsTotal} zapisanych pozycji przeliczonych` : null,
    t.comparedToPriceList ? `${t.comparedToPriceList} porównań z cennikiem źródłowym` : null,
    t.rangeCases ? `${t.rangeCases} konfiguracji wygenerowanych przez robota (${t.rangeInRange} w zakresie cennika, ${t.rangeOutOfRange} poza nim, ${t.rangeOptionCases || 0} po opcjach)` : null,
    t.scriptsParsed ? `${t.scriptsParsed} skryptów cenowych (${t.scriptsBroken} uszkodzonych)` : null,
    t.simulated ? `symulacja składania pozycji: ${t.simulationPassed}/${t.simulated} grup zdanych` : null,
    t.missingRules ? `${t.missingRules} pozycji archiwalnych pominiętych (brak ich wersji reguł na dysku)` : null
  ].filter(Boolean);

  const groupRows = (report.groups || []).map((g) => {
    const status = g.skipped
      ? '<span style="color:#888;">pominięta</span>'
      : (g.findings === 0 ? '<span style="color:#1a7a1a;">✅</span>' : `${g.findings} zgł.`);
    const nm = names.get(String(g.groupNumber));
    return `<tr><td style="${TD}">${escHtml(g.groupNumber)}${nm && nm.product ? ` · ${escHtml(nm.product)}` : ''}</td><td style="${TD}">${status}</td><td style="${TD}color:#888;">${escHtml(g.reason || '')}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><title>Raport robota testującego konfigurator</title></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:1100px;margin:0 auto;padding:20px;">
  ${note ? `<div style="background:#fff4d6;border:1px solid #e0b84c;padding:10px 14px;margin-bottom:14px;font-size:13px;">${escHtml(note)}</div>` : ''}
  <h1 style="font-size:20px;margin:0 0 4px 0;">🤖 Robot testujący konfigurator eForm</h1>
  <div style="color:#777;">Przebieg z ${escHtml(new Date(report.finishedAt).toLocaleString('pl-PL'))} · sprawdzonych grup: ${escHtml(groupsChecked)}</div>

  <table style="border-collapse:separate;border-spacing:8px;margin:14px -8px 0 -8px;"><tr>
    ${tile('🚧', 'ślepe zaułki', deadEnds.length, '#c0392b')}
    ${tile('💶', 'błędy cen i ceny zero', prices.length, '#d35400')}
    ${tile('⚙️', 'pozostałe', others.length, '#7f8c8d')}
  </tr></table>

  ${section1}
  ${section2}
  ${section3}

  <h3 style="margin-top:32px;font-size:14px;color:#555;">Zakres przebiegu</h3>
  <ul style="color:#555;font-size:12px;margin-top:4px;">${scope.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>
  ${groupsSkipped.length ? `<p style="color:#888;font-size:12px;">Pominięte grupy: ${groupsSkipped.map((g) => escHtml(g.groupNumber)).join(', ')}.</p>` : ''}
  ${groupRows ? `<table style="border-collapse:collapse;font-size:12px;margin-top:6px;"><tbody>${groupRows}</tbody></table>` : ''}
  <p style="color:#aaa;font-size:11px;margin-top:20px;">Pełny raport JSON w załączniku (kopia na serwerze: ${escHtml(reportFilePath)}).</p>
</body>
</html>`;
}

/**
 * @param {object} report - from reportBuilder.buildRunReport()
 * @param {string} reportFilePath - path returned by outputStore.saveRunReport()
 */
async function sendTestReport(report, reportFilePath, { note = null } = {}) {
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

  const { totalFindings } = report;
  const kat = splitByCategory(report.findings || []);
  const nDead = kat[CATEGORY.DEAD_END].length;
  const nPrice = kat[CATEGORY.PRICE].length;
  const nOther = kat[CATEGORY.OTHER].length;
  const day = new Date().toLocaleDateString('pl-PL');
  // Temat w kolejności kategorii raportu — ślepe zaułki pierwsze.
  const subject = totalFindings === 0
    ? `[Tester konfiguratora] ✅ bez zgłoszeń — ${day}`
    : `[Tester konfiguratora] 🚧 ${nDead} ślepe zaułki · 💶 ${nPrice} błędy cen · ⚙️ ${nOther} pozostałe — ${day}`;
  const names = await loadProductNames();

  // Attach the report itself: the recipients do not have shell access to the
  // host, so a path under /mnt/eform is of no use to them on its own.
  const attachments = [];
  try {
    if (reportFilePath && fs.existsSync(reportFilePath)) {
      attachments.push({ filename: path.basename(reportFilePath), path: reportFilePath, contentType: 'application/json' });
    }
  } catch (_err) { /* brak załącznika nie może blokować wysyłki */ }

  try {
    const info = await transporter.sendMail({
      from: `"${process.env.MAILBOT_ALIAS || 'Tester konfiguratora Efora'}" <${process.env.MAILBOT_USER}>`,
      to,
      subject,
      html: buildHtml(report, reportFilePath, names, { note }),
      attachments
    });
    // ⚠️ Sama linia „report sent" nie dowodziła, że mail dotarł — mówiła tylko,
    // że `sendMail` nie rzucił. Logujemy odpowiedź serwera SMTP: kto został
    // przyjęty, kto odrzucony i identyfikator wiadomości, po którym da się ją
    // znaleźć w logach serwera pocztowego (właściciel 2026-10-12: „powinienem
    // codziennie maile dostawać, a nie dostaję").
    const accepted = (info && info.accepted) || [];
    const rejected = (info && info.rejected) || [];
    log(`ConfiguratorTester mailer: report sent to ${to} (${totalFindings} findings) — SMTP przyjął: ${accepted.join(',') || 'nikogo'}`
      + `${rejected.length ? `, ODRZUCIŁ: ${rejected.join(',')}` : ''} | ${info && info.response ? info.response : 'brak odpowiedzi'} | id ${info && info.messageId}`);
  } catch (err) {
    log(`ConfiguratorTester mailer: failed to send email: ${err.message}`);
  }
}

module.exports = { sendTestReport, buildHtml };
