'use strict';

/**
 * Dobór alternatyw dla niedostępnej tkaniny po stronie E-Formu
 * (`public/scripts/formTools/fabricAlternatives.js`): API agentai zna stan
 * z ostatniej synchronizacji PCB i nie rozpoznaje kuponowych — to odsiewamy tu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => {
  mod = await import('../../public/scripts/formTools/fabricAlternatives.js');
});

test('kod i lista do API: ALIAS z listą z nazwy pliku, bez ALIAS kod HKL i lista HKL', () => {
  const aliased = { VALUE: '3003-P20~2', ALIAS: '20401-P20' };
  assert.deepEqual(mod.alternativesQuery(aliased, 'paramdict-KOLOR-LUXAN2024.txt'), { code: '20401-P20', list: 'LUXAN2024' });
  assert.deepEqual(mod.alternativesQuery(aliased, 'paramdict-KOLOR_DODATKOWY-COZY.txt'), { code: '20401-P20', list: 'COZY' });
  assert.deepEqual(mod.alternativesQuery({ VALUE: '3003-P20' }, undefined), { code: '3003-P20', list: 'HKL' });
  // zaślepka z prod.txt grupy 75 (`HKL/TESTOWY/KOLOR=paramdict-KOLOR--.txt`) — aliasów brak
  assert.deepEqual(mod.alternativesQuery({ VALUE: '2276' }, 'paramdict-KOLOR--.txt'), { code: '2276', list: 'HKL' });
});

test('alternatywy przechodzą przez stan E-Formu, kupony i listę wyboru klienta', () => {
  const options = [
    { VALUE: '3321-P20', ALIAS: '20501-P20', STAN: 'SAFE' },
    { VALUE: '3469-P20', ALIAS: '20201-P20', STAN: 'ZERO' },            // E-Form świeżo na zero
    { VALUE: '3317-P20', ALIAS: '10202-P20', STAN: 'SAFE', OBSOLETE: true },
    { VALUE: '3319-P20', ALIAS: '10201-P20', STAN: 'COUPON' },
    { VALUE: '3461-P20', ALIAS: '10101-P20', STAN: 'LOW', ATTR_DESC: 'KUPON 12m' },
    { VALUE: '3500-P20~2', ALIAS: '10301-P20' },                         // brak danych o stanie = ufamy API
  ];
  const alternatives = ['20501-P20', '20201-P20', '10202-P20', '10201-P20', '10101-P20', '99999-P20', '10301-P20']
    .map(code => ({ code }));

  const picked = mod.pickAvailableAlternatives(alternatives, options);
  assert.deepEqual(picked.map(p => p.option.VALUE), ['3321-P20', '3500-P20~2']);
  assert.equal(picked[0].alternative.code, '20501-P20');
});

test('lista HKL dopasowuje po VALUE, limit przycina wynik', () => {
  const options = ['A', 'B', 'C'].map(VALUE => ({ VALUE, STAN: 'SAFE' }));
  const picked = mod.pickAvailableAlternatives(['A', 'B', 'C'].map(code => ({ code })), options, 2);
  assert.deepEqual(picked.map(p => p.option.VALUE), ['A', 'B']);
  assert.deepEqual(mod.pickAvailableAlternatives(undefined, options), []);
});

test('kupon: STAN COUPON albo „KUPON” w INFO pliku stanów (format z !storage!)', () => {
  assert.equal(mod.isCoupon({ STAN: 'ZERO', ATTR_DESC: '!delivery!: KUPON - 2/3 Tygodnie' }), true);
  assert.equal(mod.isCoupon({ STAN: 'COUPON' }), true);
  assert.equal(mod.isCoupon({ STAN: 'ZERO', ATTR_DESC: '!delivery!: 2026-11-06' }), false);
  assert.equal(mod.isCoupon({ VALUE: '3003-P20' }), false);
});

test('progi odcienia z opisu API', () => {
  assert.equal(mod.shadeKey(0.1), 'form.alternatives_shade_same');
  assert.equal(mod.shadeKey(2), 'form.alternatives_shade_close');
  assert.equal(mod.shadeKey(7.5), 'form.alternatives_shade_similar');
  assert.equal(mod.shadeKey(12), null);
  assert.equal(mod.shadeKey(null), null);
});

// ── Serwer: plik agentai na dysku (services/fabricAlternatives.js) ──
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAlternativesStore, syncAlternativesFile } = require('../fabricAlternatives');

const FILE = {
  generated_at: '2026-11-03T12:17:04Z',
  stock_synced_at: '2026-11-03 10:10',
  forms: {
    71: {
      LUXAN2021: {
        '1709-W25': { hkl: '1709-W25', pg: '4', state: 'obsolete', alternatives: [{ code: '1702-W25', hkl: '958-W25', pg: '1', delta_e: 4.4, colour: 'white' }] },
        '1718-W25': { hkl: '1718-W25', pg: '4', state: 'obsolete', alternatives: [] },
      },
    },
  },
};

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eform-alt-')), 'data', '.fabric-alternatives.json');
function writeFile(file, data, mtimeSec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  if (mtimeSec) fs.utimesSync(file, mtimeSec, mtimeSec);
}

test('lookup: wynik wyrównany do zapytań, tylko potrzebne pola, brak wpisu = null', async () => {
  const file = tmpFile();
  writeFile(file, FILE);
  const store = createAlternativesStore({ file, log() {} });
  const res = await store.lookup('71', [
    { code: '1709-W25', list: 'LUXAN2021' },
    { code: '1718-W25', list: 'LUXAN2021' },
    { code: '1709-W25', list: 'COZY' },
    { code: 'constructor', list: 'LUXAN2021' },
  ]);
  assert.deepEqual(res, [
    { pg: '4', alternatives: [{ code: '1702-W25', pg: '1', delta_e: 4.4 }] },
    { pg: '4', alternatives: [] },
    null,
    null,
  ]);
  assert.deepEqual(await store.lookup('99', [{ code: '1709-W25', list: 'LUXAN2021' }]), [null]);
});

test('nowy plik (inny mtime) podmienia stary; zepsuty plik zostawia poprzedni', async () => {
  const file = tmpFile();
  const logged = [];
  const q = [{ code: '1709-W25', list: 'LUXAN2021' }];
  writeFile(file, FILE, 1000);
  const store = createAlternativesStore({ file, log: (...a) => logged.push(a) });
  assert.ok((await store.lookup('71', q))[0]);
  writeFile(file, '{"forms": {', 2000);
  assert.ok((await store.lookup('71', q))[0], 'zepsuty plik — zostaje poprzedni');
  assert.equal(logged.length, 1);
  writeFile(file, { forms: {} }, 3000);
  assert.deepEqual(await store.lookup('71', q), [null], 'nowy plik podmienia stary');
});

test('bez pliku lookup rzuca (trasa odpowiada 502)', async () => {
  const store = createAlternativesStore({ file: tmpFile(), log() {} });
  await assert.rejects(store.lookup('71', []), /ENOENT/);
});

function fakeFetch(status, text) {
  const calls = [];
  return { calls, impl: async (url, init) => { calls.push({ url, key: init.headers['X-Api-Key'] }); return { ok: status === 200, status, text: async () => text }; } };
}

test('sync: zapisuje plik (z katalogiem), drugi raz bez zmian nie rusza pliku', async () => {
  const file = tmpFile();
  const body = JSON.stringify(FILE);
  const f = fakeFetch(200, body);
  const r1 = await syncAlternativesFile({ url: 'http://agentai/alternatives.json', key: 'k', file, fetchImpl: f.impl });
  assert.equal(r1.changed, true);
  assert.equal(r1.forms, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), body);
  assert.equal(f.calls[0].key, 'k');
  fs.utimesSync(file, 1000, 1000);
  const r2 = await syncAlternativesFile({ url: 'u', key: 'k', file, fetchImpl: f.impl });
  assert.equal(r2.changed, false);
  assert.equal(fs.statSync(file).mtimeMs, 1000 * 1000, 'plik bez zmian nietknięty — rsync go nie przenosi');
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('sync: błąd HTTP, zepsuty JSON albo plik bez formatek nie nadpisują dobrego pliku', async () => {
  const file = tmpFile();
  const good = JSON.stringify(FILE);
  writeFile(file, good);
  for (const [status, text, re] of [[500, '', /HTTP 500/], [200, '<html>', /JSON/], [200, '{"forms":{}}', /bez formatek/], [401, '{}', /HTTP 401/]]) {
    await assert.rejects(syncAlternativesFile({ url: 'u', key: 'k', file, fetchImpl: fakeFetch(status, text).impl }), re);
    assert.equal(fs.readFileSync(file, 'utf8'), good);
  }
});
