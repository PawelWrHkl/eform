'use strict';

/**
 * Raport rozjazdów cenników dla admina (`/admin/pricelists`). Liczony w OSOBNYM
 * procesie (`scripts/pricelistsReport.js`), bo przegląd wszystkich wdrożonych
 * skryptów to minuty, a żywy serwer ma zostać lekki. Wynik: `report.json`.
 *
 * Cennik zawsze pokazuje to, co liczy konfigurator — także gdy dane są wadliwe.
 * Ten raport mówi, GDZIE konfigurator (a więc i cennik) liczy inaczej, niż
 * zamierzono w arkuszach, żeby dało się to poprawić u źródła.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const iconv = require('iconv-lite');

const config = require('../../config');
const { selectQuery } = require('../../db/core');
const { listGroups } = require('../orgCustomers/groupTerms');
const { parseProdTxt, parseScriptEntries } = require('../formEngine/clientScripts');
const { hashUser } = require('../../utils/hashUser');
const sm = require('./scriptModel');
const pricelists = require('./index');

// Uwagi `buildPricelist` warte raportu (reszta to szczegóły techniczne budowy tabel).
const BUILD_NOTE_KINDS = ['axis-disabled', 'family-without-options', 'dimensional-item', 'unsupported-formula', 'cell-error', 'subform-missing'];

const REPORT_DIR = path.join(config.rootDir, 'pricelists');
const REPORT_FILE = path.join(REPORT_DIR, 'report.json');
const LOCK_FILE = path.join(REPORT_DIR, 'report.running');
const CONF_DIR = process.env.EFORMCONF_DIR || '/mnt/eformconf';

/** Klienci grupy z `PARAM_SCRIPTS` (klucz ORG/KLIENT, jak normalizuje generator) i parametry, których grupa używa. */
function readProdClients(groupNumber) {
  const file = path.join(config.dataDir, String(groupNumber), 'data', 'pl', 'prod.txt');
  if (!fs.existsSync(file)) return null;
  const prod = parseProdTxt(fs.readFileSync(file, 'utf8'));
  const clients = new Map();
  const used = new Set();
  for (const e of parseScriptEntries(prod.param_scripts || '')) {
    used.add(e.param);
    const key = `${e.organization.trim().toUpperCase()}/${e.client.trim().toUpperCase()}`;
    if (!clients.has(key)) clients.set(key, { org: e.organization.trim(), client: e.client.trim(), scripts: {} });
    clients.get(key).scripts[e.param] = e.file;
  }
  return { clients, used, users: (prod.users || '').split(',').map((u) => u.trim()).filter(Boolean) };
}

/** Wszystko, co da się powiedzieć o jednym skrypcie bez uruchamiania go. */
function analyzeScript(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const out = { syntaxError: null, unknown: null, defects: [], repeated: [], increase: null };
  try {
    // eslint-disable-next-line no-new
    new vm.Script(src, { filename: path.basename(filePath) });
  } catch (err) {
    out.syntaxError = err.message;
  }
  const model = sm.parseScript(src);
  if (model.unknown.length) out.unknown = { line: model.unknown[0].line, msg: model.unknown[0].msg, text: String(model.unknown[0].text).slice(0, 120) };

  const seen = new Map();
  for (const s of model.sections) {
    seen.set(s.name, (seen.get(s.name) || 0) + 1);
    const v = s.value;
    const entries = v.kind === 'xy' ? v.columns.flatMap((c) => c.rows) : v.kind === 'x' || v.kind === 'y' ? v.entries : [];
    const texts = entries.filter((e) => 'str' in e.value && Number(e.value.str) !== Number(e.value.str));
    if (texts.length) out.defects.push({ section: s.name, kind: 'text', sample: texts[0].value.str.slice(0, 60), count: texts.length });
    const refs = entries.filter((e) => e.bound && e.bound.ref);
    if (refs.length) out.defects.push({ section: s.name, kind: 'ref', sample: refs[0].bound.ref, count: refs.length });
  }
  out.repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);

  if (model.increase) {
    const branches = model.increase.branches;
    const collisions = [];
    const commas = [];
    for (const b of branches) {
      const byUid = new Map();
      for (const r of b.rules) {
        if (r.defect) commas.push({ from: b.from, uid: r.uid, defect: r.defect });
        if (!byUid.has(r.uid)) byUid.set(r.uid, []);
        byUid.get(r.uid).push(`${r.add}|${r.fr}`);
      }
      for (const [uid, values] of byUid) if (new Set(values).size > 1) collisions.push({ from: b.from, uid, values });
    }
    const expired = branches.length > 1 && !branches[0].rules.length && branches[1].rules.some((r) => r.add !== 0)
      ? { since: branches[0].from, previous: branches[1].from, rules: branches[1].rules.filter((r) => r.add !== 0).length }
      : null;
    out.increase = { uids: [...new Set(branches.flatMap((b) => b.rules.map((r) => r.uid)))], collisions, commas, expired };
  }
  return out;
}

/** uid tak, jak liczy go generator VBA: MD5(UCase(ident)) z bajtów cp1250, bez Trim. */
function vbaUid(ident) {
  const upper = [...String(ident)].map((ch) => (ch === 'ß' ? ch : ch.toUpperCase())).join('');
  return crypto.createHash('md5').update(iconv.encode(upper, 'win1250')).digest('hex');
}

/** Nazwa pliku skryptu z komórki `<PARAM>-WERSJA` tak, jak buduje ją Worker.bas (`C*1,2` → `Cmul1.2`). */
function expectedScriptFile(param, cell) {
  const candidate = String(cell).trim().toUpperCase().replace(/,/g, '.');
  const at = candidate.search(/[+\-*/]/);
  const name = at > 0
    ? candidate.slice(0, at) + candidate.slice(at).replace(/\+/g, 'add').replace(/-/g, 'sub').replace(/\*/g, 'mul').replace(/\//g, 'div').replace(/ /g, '')
    : candidate;
  return `param-${param}-${name}.js`;
}

/** Arkusz PRODUKT skoroszytu grupy (strumieniowo, z kopii w katalogu tymczasowym). */
async function readProdukt(groupNumber) {
  const ExcelJS = require('exceljs');
  if (!fs.existsSync(CONF_DIR)) return null;
  const wanted = `#${groupNumber}#`;
  const name = fs.readdirSync(CONF_DIR).find((f) => !f.startsWith('~$') && /\.xls[mx]$/i.test(f) && f.includes(wanted));
  if (!name) return null;
  const tmp = path.join(os.tmpdir(), `produkt-${process.pid}-${groupNumber}.xlsm`);
  fs.copyFileSync(path.join(CONF_DIR, name), tmp);
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(tmp, { worksheets: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore' });
    let header = null;
    const rows = [];
    for await (const ws of reader) {
      if (ws.name !== 'PRODUKT') continue;
      for await (const row of ws) {
        const cells = [];
        row.eachCell({ includeEmpty: false }, (cell, col) => {
          const v = cell.value;
          cells[col - 1] = v && typeof v === 'object' ? (v.result !== undefined ? v.result : v.text !== undefined ? v.text : null) : v;
        });
        if (!header) header = cells.map((c) => (c === undefined || c === null ? '' : String(c)));
        else rows.push(cells);
      }
    }
    return header ? { workbook: name, header, rows } : null;
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** PRODUKT ↔ prod.txt dla jednej grupy. */
function compareProdukt(produkt, prod) {
  const col = (name) => produkt.header.indexOf(name);
  const ownerCol = col('Właściciel');
  const userCol = col('Użytkownik');
  const versionCols = produkt.header.map((h, i) => [h, i]).filter(([h]) => /-WERSJA$/.test(h) || /RABAT$/.test(h));
  const diffs = { onlyInProdukt: [], onlyInProdTxt: [], differentScript: [], oddNames: [] };
  const seen = new Set();
  for (const row of produkt.rows) {
    const owner = row[ownerCol];
    const user = row[userCol];
    if (owner === undefined || owner === null || user === undefined || user === null || String(user).trim() === '') continue;
    const rawUser = String(user);
    if (/[ ]/.test(rawUser) || rawUser !== rawUser.trim() || /[ ]/.test(String(owner))) {
      diffs.oddNames.push({ owner: String(owner), user: rawUser.replace(/ /g, '⍽') });
    }
    // Generator: Trim + UCase (VBA Trim nie usuwa twardej spacji).
    const key = `${String(owner).trim().toUpperCase()}/${rawUser.trim().toUpperCase()}`;
    seen.add(key);
    const entry = prod.clients.get(key);
    if (!entry) {
      diffs.onlyInProdukt.push({ owner: String(owner).trim(), user: rawUser.trim() });
      continue;
    }
    for (const [header, i] of versionCols) {
      const param = header.replace(/-WERSJA$/, '');
      if (!prod.used.has(param)) continue;
      const cell = row[i];
      if (cell === undefined || cell === null || String(cell).trim() === '') continue;
      const expected = /-WERSJA$/.test(header) ? expectedScriptFile(param, cell) : `param-${param}-${String(cell).replace(',', '.')}.js`;
      const actual = entry.scripts[param] || null;
      if (actual !== expected) diffs.differentScript.push({ owner: entry.org, user: entry.client, param, produkt: expected, prodTxt: actual });
    }
  }
  for (const [key, entry] of prod.clients) if (!seen.has(key)) diffs.onlyInProdTxt.push({ owner: entry.org, user: entry.client });
  return diffs;
}

/**
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.progress]
 * @returns {Promise<object>} raport
 */
async function buildReport({ progress = () => {} } = {}) {
  const started = Date.now();
  const users = await selectQuery('SELECT u.id, u.ident, o.ident AS org FROM user u JOIN organization o ON o.id = u.organization_id');
  const identsByUid = new Map();
  for (const u of users) {
    const uid = hashUser(u.ident);
    if (!identsByUid.has(uid)) identsByUid.set(uid, []);
    identsByUid.get(uid).push(`${u.org}/${u.ident}`);
  }
  const overlays = await selectQuery(
    `SELECT t.group_number, t.scripts, t.has_access, u.ident, o.ident AS org
       FROM customer_group_terms t JOIN user u ON u.id = t.user_id JOIN organization o ON o.id = u.organization_id`
  );

  const report = {
    generatedAt: new Date().toISOString(),
    dataDir: config.dataDir,
    workbooks: fs.existsSync(CONF_DIR),
    brokenScripts: [],
    unsupportedScripts: [],
    tableDefects: [],
    repeatedSections: [],
    increaseCommas: [],
    uidCollisions: [],
    expiredIncreases: [],
    missingScripts: [],
    missingFiles: [],
    hashMismatch: [],
    buildNotes: [],
    produkt: [],
    groups: []
  };
  const allRuleUids = new Map();

  for (const group of listGroups('pl')) {
    const g = group.groupNumber;
    const prod = readProdClients(g);
    if (!prod) continue;
    progress(`grupa ${g}: ${prod.clients.size} klientów`);
    const dir = path.join(config.dataDir, g, 'data');
    const refs = new Map();
    for (const c of prod.clients.values()) for (const f of Object.values(c.scripts)) refs.set(f, (refs.get(f) || 0) + 1);

    // Klient bez skryptu dla parametru grupy albo ze skryptem, którego nie ma na dysku.
    for (const c of prod.clients.values()) {
      const missing = [...prod.used].filter((p) => !c.scripts[p] && !/^OPIS_/.test(p));
      if (missing.length) report.missingScripts.push({ group: g, source: 'prod.txt', client: `${c.org}/${c.client}`, params: missing });
      for (const [p, f] of Object.entries(c.scripts)) if (!fs.existsSync(path.join(dir, f))) report.missingFiles.push({ group: g, source: 'prod.txt', client: `${c.org}/${c.client}`, param: p, file: f });
    }
    for (const o of overlays.filter((x) => String(x.group_number) === g)) {
      let scripts = {};
      try {
        scripts = typeof o.scripts === 'string' ? JSON.parse(o.scripts || '{}') : o.scripts || {};
      } catch {
        scripts = {};
      }
      const missing = [...prod.used].filter((p) => !scripts[p] && !/^OPIS_/.test(p));
      if (missing.length) report.missingScripts.push({ group: g, source: 'nakładka DB', client: `${o.org}/${o.ident}`, params: missing });
      for (const [p, f] of Object.entries(scripts)) {
        refs.set(f, (refs.get(f) || 0) + 1);
        if (!fs.existsSync(path.join(dir, f))) report.missingFiles.push({ group: g, source: 'nakładka DB', client: `${o.org}/${o.ident}`, param: p, file: f });
      }
    }

    // Skrypty, których ktoś używa — każdy raz.
    let analyzed = 0;
    for (const [file, clients] of refs) {
      if (/^param-OPIS_/.test(file)) continue;
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) continue;
      const a = analyzeScript(p);
      analyzed++;
      const base = { group: g, file, clients };
      if (a.syntaxError) report.brokenScripts.push({ ...base, error: a.syntaxError });
      else if (a.unknown) report.unsupportedScripts.push({ ...base, ...a.unknown });
      for (const d of a.defects) report.tableDefects.push({ ...base, ...d });
      if (a.repeated.length) report.repeatedSections.push({ ...base, sections: a.repeated });
      if (a.increase) {
        for (const uid of a.increase.uids) {
          if (!allRuleUids.has(uid)) allRuleUids.set(uid, new Set());
          allRuleUids.get(uid).add(g);
        }
        for (const c of a.increase.commas) report.increaseCommas.push({ ...base, ...c, accounts: identsByUid.get(c.uid) || [] });
        for (const c of a.increase.collisions) report.uidCollisions.push({ ...base, ...c, accounts: identsByUid.get(c.uid) || [] });
        if (a.increase.expired) report.expiredIncreases.push({ ...base, ...a.increase.expired });
      }
    }

    let produkt = null;
    if (report.workbooks) {
      try {
        produkt = await readProdukt(g);
      } catch (err) {
        report.produkt.push({ group: g, error: err.message });
      }
      if (produkt) report.produkt.push({ group: g, workbook: produkt.workbook, ...compareProdukt(produkt, prod) });
    }
    // Cennik wzorcowego klienta grupy: miejsca, gdzie konfigurator pomija wymiar albo cena nie mieści się w tabeli.
    const sample = prod.clients.values().next().value;
    if (sample) {
      try {
        const account = users.find((u) => u.ident.toUpperCase() === sample.client.toUpperCase() && u.org.toUpperCase() === sample.org.toUpperCase());
        const list = await pricelists.buildPricelist({ groupNumber: g, user: { id: account ? account.id : 0, ident: sample.client }, orgIdent: sample.org, priceSet: 'CENA', lang: 'pl' });
        const seen = new Set();
        for (const n of (list.notes || []).filter((x) => BUILD_NOTE_KINDS.includes(x.kind))) {
          const detail = n.kind === 'axis-disabled' ? `${n.field} (${(n.options || []).filter(Boolean).join(', ') || '—'})`
            : n.kind === 'family-without-options' ? n.clause
              : n.kind === 'unsupported-formula' ? `${n.param}: ${n.formula}`
                : n.error || n.param || n.subform || '';
          const key = `${n.kind}|${n.section}|${detail}`;
          if (seen.has(key)) continue;
          seen.add(key);
          report.buildNotes.push({ group: g, client: `${sample.org}/${sample.client}`, kind: n.kind, section: n.section || '', detail });
        }
      } catch (err) {
        report.buildNotes.push({ group: g, client: `${sample.org}/${sample.client}`, kind: 'build-error', section: '', detail: err.message });
      }
      pricelists.clearCaches();
    }
    report.groups.push({ group: g, description: group.description, clients: prod.clients.size, scripts: analyzed });
  }

  // Konta, którym podwyżka nie zadziała: reguła istnieje pod hashem cp1250 (VBA), a eForm wysyła UTF-8.
  for (const u of users) {
    if (/^[\x20-\x7e]*$/.test(u.ident)) continue;
    const vba = vbaUid(u.ident);
    if (vba === hashUser(u.ident) || !allRuleUids.has(vba)) continue;
    report.hashMismatch.push({ account: `${u.org}/${u.ident}`, groups: [...allRuleUids.get(vba)].sort() });
  }

  report.durationSec = Math.round((Date.now() - started) / 1000);
  return report;
}

function readReport() {
  try {
    return JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeReport(report) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const tmp = `${REPORT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report));
  fs.renameSync(tmp, REPORT_FILE);
}

/** Czy liczenie trwa (plik blokady z żywym PID-em). */
function runningInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

module.exports = { buildReport, readReport, writeReport, runningInfo, analyzeScript, vbaUid, expectedScriptFile, compareProdukt, REPORT_DIR, REPORT_FILE, LOCK_FILE };
