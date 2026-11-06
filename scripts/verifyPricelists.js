#!/usr/bin/env node
/**
 * Test porównawczy cennika klienta z konfiguratorem.
 *
 * Każda wylosowana komórka tabeli i każda pozycja cennika musi być RÓWNA
 * wynikowi wdrożonego skryptu `param-*.js` uruchomionego z tą samą
 * konfiguracją, uid klienta i datą — tolerancja 0, po zaokrągleniu takim jak
 * w przeglądarce (`scriptLoader.roundPrices`).
 *
 * Usage:
 *   node scripts/verifyPricelists.js                    # domyślne kategorie klientów × grupy
 *   node scripts/verifyPricelists.js --cells=60         # komórek na tabelę (domyślnie 25)
 *   node scripts/verifyPricelists.js --date=2026-08-31  # podwyżki na inny dzień niż dziś
 *   node scripts/verifyPricelists.js --groups=43,02
 *   node scripts/verifyPricelists.js --crossover        # ten sam klient przed i po progu podwyżki
 *
 * Tylko odczyt: pliki grup, prod.txt, SELECT-y (app_version, user, nakładka DB).
 */
require('dotenv').config();

const path = require('path');
const { dataDir } = require('../config');
const { selectQuery, closePool } = require('../db/core');
const { hashUser } = require('../utils/hashUser');
const { loadScriptRunner } = require('../services/formEngine/scriptRunner');
const sm = require('../services/pricelists/scriptModel');
const pricelists = require('../services/pricelists');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const CELLS = Number(args.cells || 25);
const DATE = args.date ? new Date(`${args.date}T12:00:00`) : new Date();
const GROUPS = args.groups ? String(args.groups).split(',') : ['43', '04', '59', '71', '75', '02'];

let seed = 20261106;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** Konta z kategorii Fazy 0 (identy z bazy; uid liczy się z identu konta). */
const CASES = [
  { label: 'HKL bez mnożnika', ident: 'BIURO', priceSets: ['CENA'] },
  { label: 'HKL z mnożnikiem', ident: 'BD-Line', priceSets: ['CENA', 'SUB'] },
  { label: 'LUXANGMBH (podwyżka +3% od 01.01)', ident: 'LuxanGmbH', priceSets: ['CENA', 'SUB'] },
  { label: 'COZY (0.05|0 na SUB___DOPLATA)', ident: 'Mevr_J_Bijleveld', priceSets: ['SUB', 'CENA'] },
  { label: 'nakładka DB', ident: 'ABZ', priceSets: ['CENA'], groups: ['01', '02'] }
];

async function userByIdent(ident) {
  const rows = await selectQuery(
    'SELECT u.id, u.ident, o.ident AS org FROM user u JOIN organization o ON o.id = u.organization_id WHERE u.ident = ? LIMIT 1',
    [ident]
  );
  return rows && rows[0];
}

/** Wynik skryptu tak, jak go zobaczy formularz. */
function scriptAmount(groupNumber, file, param, obj) {
  const runner = loadScriptRunner(path.join(dataDir, String(groupNumber), 'data', file));
  const result = runner.run(obj, { now: DATE.toISOString() });
  return sm.configuratorRound(result[param], param);
}

function sample(list, count) {
  if (list.length <= count) return list;
  const out = new Set([list[0], list[list.length - 1]]);
  while (out.size < count) out.add(list[Math.floor(random() * list.length)]);
  return [...out];
}

async function verifyOne({ label, user, groupNumber, priceSet, stats, failures }) {
  const list = await pricelists.buildPricelist({ groupNumber, user, orgIdent: user.org, priceSet, date: DATE });
  if (!list.ok) {
    console.log(`  ${groupNumber} ${priceSet}: pominięte — ${list.reason}`);
    return;
  }
  let cells = 0;
  let items = 0;
  for (const part of list.parts) {
    if (!part.file || part.missing || part.unparsed) continue;
    for (const table of part.tables) {
      const keys = Object.entries(table.cells).flatMap(([token, row]) => Object.keys(row).map((k) => [token, k]));
      for (const [token, key] of sample(keys, CELLS)) {
        const [w, h] = key.split('|');
        const obj = { ...table.contexts[token] };
        if (table.xField) obj[table.xField] = Number(w) * 10;
        if (table.yField) obj[table.yField] = Number(h) * 10;
        const expected = table.cells[token][key];
        const actual = scriptAmount(groupNumber, part.file, part.param, obj);
        cells++;
        if (String(actual) !== String(expected)) {
          failures.push(`${label} ${groupNumber}/${part.file} ${table.sections[0]} PG ${token} ${w}×${h} cm: cennik=${expected} skrypt=${actual}`);
        }
      }
    }
    for (const item of part.items) {
      const checks = item.kind === 'amount' ? [[item.context, item.amount]]
        : item.kind === 'byOption' ? item.byOption.map((b) => [{ ...item.context, MODEL: b.options[0] }, b.amount])
          : [];
      for (const [ctx, expected] of checks) {
        if (!ctx) continue;
        const actual = scriptAmount(groupNumber, part.file, part.param, ctx);
        items++;
        if (String(actual) !== String(expected)) {
          failures.push(`${label} ${groupNumber}/${part.file} pozycja ${item.name}: cennik=${expected} skrypt=${actual}`);
        }
      }
    }
  }
  stats.cells += cells;
  stats.items += items;
  const incr = list.parts.filter((p) => p.increase && p.increase.f !== 1).map((p) => `${p.param} f=${p.increase.f}${p.increase.fr !== -1 ? ` fr=${p.increase.fr}` : ''}`);
  console.log(`  ${groupNumber} ${priceSet}: ${cells} komórek, ${items} pozycji${incr.length ? `, podwyżka: ${incr.join(', ')}` : ''}`);
}

/** Klient, któremu skrypt grupy NA DZIŚ nalicza podwyżkę (żeby kategoria „z podwyżką” coś sprawdzała). */
async function clientWithActiveIncrease(groupNumber, orgIdent, priceSet) {
  const users = await selectQuery(
    'SELECT u.id, u.ident, o.ident AS org FROM user u JOIN organization o ON o.id = u.organization_id WHERE o.ident = ? AND u.ident NOT REGEXP ? ORDER BY u.id',
    [orgIdent, '[^ -~]']
  );
  const byUid = new Map(users.map((u) => [hashUser(u.ident), u]));
  const { resolveGroupTerms } = require('../services/orgCustomers/groupTerms');
  const param = priceSet === 'SUB' ? 'SUB___CENA' : 'CENA';
  for (const u of users.slice(0, 400)) {
    const terms = await resolveGroupTerms({ userId: u.id, groupNumber, orgIdent: u.org, userIdent: u.ident });
    if (!terms.hasAccess || !terms.scripts[param]) continue;
    const model = pricelists.loadModel(groupNumber, terms.scripts[param]);
    if (model.missing || model.unknown.length) continue;
    const inc = sm.increaseFor(model, hashUser(u.ident), sm.dateKeyOf(DATE));
    if (inc.f !== 1 && byUid.has(hashUser(u.ident))) return u;
  }
  return null;
}

async function crossover() {
  // Ten sam klient i ta sama komórka przed i po progu: cennik = skrypt na obu datach.
  const user = await userByIdent('NaOkniePL');
  const checks = [['43', 'CENA', '2025-12-31', '2026-01-01'], ['43', 'CENA', '2026-08-31', '2026-09-01']];
  let bad = 0;
  for (const [groupNumber, priceSet, before, after] of checks) {
    const amounts = [];
    for (const day of [before, after]) {
      const date = new Date(`${day}T12:00:00`);
      const list = await pricelists.buildPricelist({ groupNumber, user, orgIdent: user.org, priceSet, date });
      const part = list.parts.find((p) => p.param === 'CENA');
      const table = part.tables[0];
      const token = table.priceGroups[1] || table.priceGroups[0];
      const key = Object.keys(table.cells[token])[5];
      const [w, h] = key.split('|');
      const obj = { ...table.contexts[token], [table.xField]: Number(w) * 10, [table.yField]: Number(h) * 10 };
      const runner = loadScriptRunner(path.join(dataDir, groupNumber, 'data', part.file));
      const script = sm.configuratorRound(runner.run(obj, { now: date.toISOString() })[part.param], part.param);
      const cennik = table.cells[token][key];
      amounts.push(cennik);
      if (String(script) !== String(cennik)) bad++;
      console.log(`  ${groupNumber} ${user.ident} ${day} ${w}×${h} PG ${token}: cennik=${cennik} skrypt=${script} (f=${part.increase.f})`);
    }
    console.log(`    → przed ${amounts[0]}, po ${amounts[1]}: ${amounts[0] === amounts[1] ? 'BEZ ZMIANY' : 'zmiana na progu'}`);
  }
  return bad;
}

(async () => {
  const failures = [];
  const stats = { cells: 0, items: 0 };
  try {
    if (args.crossover) {
      const bad = await crossover();
      console.log(bad ? `ROZJAZDY: ${bad}` : 'Przełom daty: cennik = skrypt na każdej dacie.');
      process.exitCode = bad ? 1 : 0;
      return;
    }
    console.log(`Data: ${DATE.toISOString().slice(0, 10)}, komórek na tabelę: ${CELLS}`);
    for (const c of CASES) {
      const user = await userByIdent(c.ident);
      if (!user) {
        console.log(`${c.label}: brak konta ${c.ident}`);
        continue;
      }
      console.log(`${c.label}: ${user.org}/${user.ident} (uid ${hashUser(user.ident).slice(0, 8)}…)`);
      for (const groupNumber of c.groups || GROUPS) {
        for (const priceSet of c.priceSets) await verifyOne({ label: c.label, user, groupNumber, priceSet, stats, failures });
      }
    }
    // Kategoria „podwyżka aktywna dziś” — wyszukana w skryptach, nie zgadywana.
    for (const groupNumber of GROUPS) {
      const user = await clientWithActiveIncrease(groupNumber, 'LUXANGMBH', 'SUB');
      if (!user) continue;
      console.log(`Podwyżka aktywna dziś (gr. ${groupNumber}): ${user.org}/${user.ident}`);
      for (const priceSet of ['SUB', 'CENA']) await verifyOne({ label: 'aktywna podwyżka', user, groupNumber, priceSet, stats, failures });
    }
  } finally {
    console.log(`\nSprawdzono: ${stats.cells} komórek, ${stats.items} pozycji. Rozjazdy: ${failures.length}`);
    failures.slice(0, 40).forEach((f) => console.log('  ' + f));
    if (failures.length) process.exitCode = 1;
    await closePool().catch(() => {});
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
