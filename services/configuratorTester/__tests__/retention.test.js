'use strict';

/**
 * Retencja raportów nie może zjadać historii po przerwie w działaniu.
 *
 * ⚠️ 2026-10-12: pierwszy przebieg po trzech tygodniach przestoju usunął
 * jedyne raporty z 21.09 (sam próg „starsze niż 14 dni") — akurat gdy szef
 * zapytał o wyniki robota od uruchomienia.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneOutput } = require('../retention');

function katalog(dni) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configtest-ret-'));
  for (const d of dni) fs.mkdirSync(path.join(root, d));
  fs.mkdirSync(path.join(root, 'cos-innego'));
  return root;
}

test('po długiej przerwie NAJNOWSZE dni zostają, choć są starsze niż próg', () => {
  const root = katalog(['2026-08-01', '2026-08-02', '2026-09-07', '2026-09-21']);
  try {
    pruneOutput(root, 14, 2, { logFn: () => {} });
    const zostalo = fs.readdirSync(root).sort();
    assert.deepEqual(zostalo, ['2026-09-07', '2026-09-21', 'cos-innego']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nigdy nie dotyka katalogów spoza schematu RRRR-MM-DD', () => {
  const root = katalog(['2020-01-01']);
  try {
    pruneOutput(root, 14, 0, { logFn: () => {} });
    assert.ok(fs.existsSync(path.join(root, 'cos-innego')));
    assert.ok(!fs.existsSync(path.join(root, '2020-01-01')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('świeże dni zostają zawsze', () => {
  const dzis = new Date().toISOString().slice(0, 10);
  const root = katalog([dzis]);
  try {
    pruneOutput(root, 14, 0, { logFn: () => {} });
    assert.ok(fs.existsSync(path.join(root, dzis)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
