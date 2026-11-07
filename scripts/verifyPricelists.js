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
// Maglev (kompilator V8) po ~200 uruchomieniach optymalizuje gigantyczną f() skryptu
// cenowego i RSS rośnie o gigabajty poza stertą (zmierzone na gr. 75: 135 MB → 1,5 GB),
// aż system zabija proces. Test liczy więc zawsze bez optymalizacji.
if (!process.execArgv.includes('--no-maglev')) {
  const { spawnSync } = require('child_process');
  const child = spawnSync(process.execPath, ['--no-maglev', '--no-opt', ...process.execArgv, __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status === null ? 1 : child.status);
}

require('dotenv').config();

const path = require('path');
const { dataDir } = require('../config');
const { selectQuery, closePool } = require('../db/core');
const { hashUser } = require('../utils/hashUser');
const { loadScriptRunner, clearScriptCache } = require('../services/formEngine/scriptRunner');
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

/** Czy dzisiejsza gałąź skryptu nalicza temu uid podwyżkę (opcjonalnie: z zaokrągleniem `fr`). */
function activeRule(groupNumber, file, uid, withRounding) {
  if (!file) return false;
  const model = pricelists.loadModel(groupNumber, file);
  if (model.missing || model.unknown.length) return false;
  const inc = sm.increaseFor(model, uid, sm.dateKeyOf(DATE));
  return withRounding ? inc.fr !== -1 : inc.f !== 1;
}

/**
 * Kategorie klientów z Fazy 0. `ident` = konto wzorcowe; gdy w danej grupie nie
 * ma dostępu, test dobiera klienta tej samej kategorii z `PARAM_SCRIPTS`.
 */
const CASES = [
  { label: 'HKL bez mnożnika', ident: 'BIURO', priceSets: ['CENA'], pick: (c) => c.org === 'HKL' && c.scripts.CENA && !/mul/.test(c.scripts.CENA) },
  { label: 'HKL z mnożnikiem', ident: 'BD-Line', priceSets: ['CENA', 'SUB'], pick: (c) => c.org === 'HKL' && /mul/.test(c.scripts.CENA || '') },
  {
    label: 'LUXANGMBH z podwyżką aktywną dziś', ident: 'LuxanGmbH', priceSets: ['CENA', 'SUB'],
    pick: (c, g) => c.org === 'LUXANGMBH' && (activeRule(g, c.scripts.CENA, hashUser(c.client)) || activeRule(g, c.scripts.SUB___CENA, hashUser(c.client)))
  },
  {
    label: 'COZY z podwyżką i zaokrągleniem (x|0)', ident: 'Mevr_J_Bijleveld', priceSets: ['SUB', 'CENA'],
    pick: (c, g) => c.org === 'COZY' && ['SUB___CENA', 'SUB___DOPLATA', 'SUB___DOPLATA_EL'].some((p) => activeRule(g, c.scripts[p], hashUser(c.client), true))
  },
  { label: 'nakładka DB', ident: 'ABZ', priceSets: ['CENA'], groups: ['01', '02'] }
];

async function userByIdent(ident) {
  const rows = await selectQuery(
    'SELECT u.id, u.ident, o.ident AS org FROM user u JOIN organization o ON o.id = u.organization_id WHERE u.ident = ? LIMIT 1',
    [ident]
  );
  return rows && rows[0];
}

/** Klienci z `PARAM_SCRIPTS` grupy: `[{ org, client, scripts: {PARAM: plik} }]`. */
function prodClients(groupNumber) {
  const fs = require('fs');
  const { parseProdTxt, parseScriptEntries } = require('../services/formEngine/clientScripts');
  const prod = parseProdTxt(fs.readFileSync(path.join(dataDir, String(groupNumber), 'data', 'pl', 'prod.txt'), 'utf8'));
  const byClient = new Map();
  for (const e of parseScriptEntries(prod.param_scripts || '')) {
    const key = `${e.organization.trim().toUpperCase()}/${e.client.trim().toUpperCase()}`;
    if (!byClient.has(key)) byClient.set(key, { org: e.organization.trim().toUpperCase(), client: e.client.trim(), scripts: {} });
    byClient.get(key).scripts[e.param] = e.file;
  }
  return [...byClient.values()];
}

/** Konto wzorcowe, a gdy nie ma dostępu do grupy — pierwszy klient kategorii, który jest w bazie. */
async function clientFor(c, groupNumber) {
  const template = await userByIdent(c.ident);
  if (template) {
    const { resolveGroupTerms } = require('../services/orgCustomers/groupTerms');
    const terms = await resolveGroupTerms({ userId: template.id, groupNumber, orgIdent: template.org, userIdent: template.ident });
    if (terms.hasAccess || !c.pick) return template;
  }
  if (!c.pick) return null;
  for (const entry of prodClients(groupNumber)) {
    if (!c.pick(entry, groupNumber)) continue;
    const user = await userByIdent(entry.client);
    if (user && user.org.toUpperCase() === entry.org) return user;
  }
  return null;
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
        const obj = pricelists.cellObject(list, table, token, w, h);
        const expected = table.cells[token][key];
        const actual = scriptAmount(groupNumber, part.file, part.param, obj);
        cells++;
        if (String(actual) !== String(expected)) {
          const failure = `${label} ${groupNumber}/${part.file} ${table.sections[0]} PG ${token} ${w}×${h} cm: cennik=${expected} skrypt=${actual}`;
          failures.push(failure);
          console.log(`    ROZJAZD ${failure}`);
        }
      }
    }
    for (const item of part.items) {
      // Kwota pozycji = jej własna sekcja. Porównujemy surową wartość sekcji z tą,
      // którą skrypt sam wypisuje w etykiecie `<PARAM>_S` („12.2(M)+35(Klemmtrager)”).
      const checks = item.kind === 'amount' ? [[item.context, item.raw]]
        : item.kind === 'byOption' ? item.byOption.map((b) => [{ ...item.context, MODEL: b.options[0] }, b.raw])
          : [];
      for (const [ctx, expectedRaw] of checks) {
        if (!ctx) continue;
        const runner = loadScriptRunner(path.join(dataDir, String(groupNumber), 'data', part.file));
        const result = runner.run(ctx, { now: DATE.toISOString() });
        const stamp = String(result[`${part.param}_S`] || '');
        const m = new RegExp(`(?:^|[+(])(-?[0-9.eE+-]+)\\(${item.name}\\)`).exec(stamp);
        let actualRaw = m ? Number(m[1]) : 0;
        // Sekcja o powtórzonej nazwie (gr. 01): etykieta zapisuje wartość PIERWSZEGO
        // bloku, a kolejny ją nadpisuje — wiarygodna jest wtedy tylko suma skryptu.
        const model = pricelists.loadModel(groupNumber, part.file);
        if (model.sections.filter((sec) => sec.name === item.name).length > 1) {
          if (item.alsoFired && item.alsoFired.length) continue;
          actualRaw = Number(sm.configuratorRound(result[part.param], part.param));
          if (Number(item.amount) !== actualRaw) {
            const failure = `${label} ${groupNumber}/${part.file} pozycja ${item.name} (sekcja powtórzona): cennik=${item.amount} skrypt=${actualRaw}`;
            failures.push(failure);
            console.log(`    ROZJAZD ${failure}`);
          }
          items++;
          continue;
        }
        items++;
        if (Number(expectedRaw) !== actualRaw) {
          const failure = `${label} ${groupNumber}/${part.file} pozycja ${item.name}: cennik(surowa)=${expectedRaw} skrypt(etykieta)=${actualRaw}`;
          failures.push(failure);
          console.log(`    ROZJAZD ${failure}`);
        }
      }
    }
  }
  stats.cells += cells;
  stats.items += items;
  const incr = list.parts.filter((p) => p.increase && p.increase.f !== 1).map((p) => `${p.param} f=${p.increase.f}${p.increase.fr !== -1 ? ` fr=${p.increase.fr}` : ''}`);
  const mem = process.memoryUsage();
  console.log(`  ${groupNumber} ${priceSet}: ${cells} komórek, ${items} pozycji${incr.length ? `, podwyżka: ${incr.join(', ')}` : ''} [RSS ${Math.round(mem.rss / 1048576)} MB, sterta ${Math.round(mem.heapUsed / 1048576)} MB]`);
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
      const obj = pricelists.cellObject(list, table, token, w, h);
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
      console.log(c.label);
      for (const groupNumber of c.groups || GROUPS) {
        // Każda grupa to inne 5-megabajtowe skrypty — nie trzymamy poprzednich w pamięci.
        pricelists.clearCaches();
        clearScriptCache();
        const user = await clientFor(c, groupNumber);
        if (!user) {
          console.log(`  ${groupNumber}: brak klienta tej kategorii z dostępem do grupy`);
          continue;
        }
        console.log(`  ${groupNumber}: ${user.org}/${user.ident} (uid ${hashUser(user.ident).slice(0, 8)}…)`);
        for (const priceSet of c.priceSets) {
          await verifyOne({ label: c.label, user, groupNumber, priceSet, stats, failures });
          // Duże grupy (75) trzymają po kilkaset MB modeli i skompilowanych skryptów.
          pricelists.clearCaches();
          clearScriptCache();
        }
      }
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
