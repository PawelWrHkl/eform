'use strict';

/**
 * Podmiana wersji reguł, gdy tej z pozycji nie ma już na udziale.
 *
 * ⚠️ Kontekst zmierzony 2026-09-21: **522 zapisane pozycje** wskazują na wersje
 * reguł, których nie ma w ŻADNYM środowisku (najnowsze z lutego 2026).
 * Otwarcie takiej pozycji do edycji kończyło się wyjątkiem
 * `Cannot read properties of null (reading 'dictValues')` i MARTWYM ekranem.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hasRules, listUsableVersions, resolveUsableVersion, compareVersions } = require('../rulesVersion');

/** Minimalny udział z regułami: `<grupa>/data/versions/<wersja>/<język>/`. */
function makeShare(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  for (const [grupa, wersje] of Object.entries(spec)) {
    for (const [wersja, jezyki] of Object.entries(wersje)) {
      for (const [jezyk, pliki] of Object.entries(jezyki)) {
        const dir = path.join(root, grupa, 'data', 'versions', wersja, jezyk);
        fs.mkdirSync(dir, { recursive: true });
        for (const [nazwa, tresc] of Object.entries(pliki)) {
          fs.writeFileSync(path.join(dir, nazwa), tresc);
        }
      }
    }
  }
  return root;
}

const PELNE = { 'param.txt': 'NAME\n', 'paramdict.txt': 'NAME\n' };

test('compareVersions — człony porównywane LICZBOWO, nie tekstowo', () => {
  // Tekstowo „0.3.61" wypada po „0.3.600" i podmiana wskazałaby złą wersję.
  assert.deepEqual(['0.3.61', '0.3.600', '0.3.9', '0.3.730'].sort(compareVersions),
    ['0.3.9', '0.3.61', '0.3.600', '0.3.730']);
  assert.ok(compareVersions('0.3.730', '0.3.61') > 0);
  assert.equal(compareVersions('0.3.7', '0.3.7'), 0);
});

test('hasRules — pusty plik to brak reguł, nie reguły', () => {
  // Przerwana synchronizacja zostawia plik o zerowej długości, a
  // `generateForm` pada na nim tak samo jak na braku pliku.
  const root = makeShare({ 71: { '0.3.1': { pl: { 'param.txt': '', 'paramdict.txt': 'NAME\n' } } } });
  try {
    assert.equal(hasRules('71', '0.3.1', 'pl', root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hasRules — wymaga OBU plików i właściwego języka', () => {
  const root = makeShare({ 71: { '0.3.1': { pl: PELNE, de: { 'param.txt': 'NAME\n' } } } });
  try {
    assert.equal(hasRules('71', '0.3.1', 'pl', root), true);
    assert.equal(hasRules('71', '0.3.1', 'de', root), false, 'brak paramdict.txt');
    assert.equal(hasRules('71', '0.3.1', 'nl', root), false, 'brak katalogu języka');
    assert.equal(hasRules('71', '9.9.9', 'pl', root), false);
    assert.equal(hasRules(null, '0.3.1', 'pl', root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUsableVersion — istniejąca wersja przechodzi BEZ podmiany', () => {
  const root = makeShare({ 71: { '0.3.1': { pl: PELNE }, '0.3.2': { pl: PELNE } } });
  try {
    const w = resolveUsableVersion('71', '0.3.1', 'pl', root);
    assert.deepEqual(w, { version: '0.3.1', requested: '0.3.1', fallback: false, reason: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUsableVersion — brakująca wersja dostaje NAJNOWSZĄ dostępną i flagę podmiany', () => {
  const root = makeShare({ 71: { '0.3.9': { pl: PELNE }, '0.3.61': { pl: PELNE }, '0.3.600': { pl: PELNE } } });
  try {
    const w = resolveUsableVersion('71', '0.3.1', 'pl', root);
    assert.equal(w.version, '0.3.600', 'najnowsza liczbowo, nie tekstowo');
    assert.equal(w.requested, '0.3.1');
    assert.equal(w.fallback, true, 'wołający MUSI móc pokazać, że podmieniliśmy');
    assert.match(w.reason, /brak reguł wersji 0\.3\.1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUsableVersion — wersje bez kompletu reguł nie są kandydatem na podmianę', () => {
  const root = makeShare({
    71: { '0.3.5': { pl: PELNE }, '0.3.9': { pl: { 'param.txt': 'NAME\n' } } }
  });
  try {
    assert.deepEqual(listUsableVersions('71', 'pl', root), ['0.3.5']);
    assert.equal(resolveUsableVersion('71', '0.3.1', 'pl', root).version, '0.3.5',
      '0.3.9 jest nowsza, ale nie da się jej wczytać');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUsableVersion — grupa bez ŻADNYCH reguł zwraca null, nie zgaduje', () => {
  const root = makeShare({ 71: { '0.3.1': { de: PELNE } } });
  try {
    const w = resolveUsableVersion('71', '0.3.1', 'pl', root);
    assert.equal(w.version, null, 'nie ma czym podmienić — wołający ma to pokazać jako błąd');
    assert.equal(w.fallback, false);
    assert.match(w.reason, /brak na dysku jakichkolwiek reguł/);

    const brakGrupy = resolveUsableVersion('99', '0.3.1', 'pl', root);
    assert.equal(brakGrupy.version, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUsableVersion — bez podanej wersji zwraca najnowszą i NIE zgłasza podmiany', () => {
  // Ścieżka „nowa pozycja": nie ma czego podmieniać, więc `fallback` musi być
  // false, inaczej użytkownik dostawałby ostrzeżenie przy każdym otwarciu.
  const root = makeShare({ 71: { '0.3.5': { pl: PELNE }, '0.3.12': { pl: PELNE } } });
  try {
    const w = resolveUsableVersion('71', null, 'pl', root);
    assert.equal(w.version, '0.3.12');
    assert.equal(w.fallback, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
