'use strict';

/**
 * Odporność na pozycje ARCHIWALNE — takie, których wersji reguł nie ma już na
 * dysku.
 *
 * ⚠️ Dlaczego to ma własny test: zmierzone **221 z 1191** par (grupa, wersja)
 * w bazie nie ma katalogu reguł (stare wersje znikają z udziału). Dla takiej
 * pozycji `generateForm` dostawał `null` z `DataLoader.parseData()` i wywalał
 * się na `data.dictValues`. Grupa chodzi we własnym procesie, więc ginęła CAŁA
 * grupa — raport pokazywał jedno bezużyteczne P1 „proces zakończył się kodem
 * 1" (tak padła grupa 43 na jednej pozycji z wersją 0.3.61), a pozostałe
 * kilkadziesiąt pozycji nie było sprawdzonych wcale.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dataDir } = require('../../../config');
const engineRunner = require('../engineRunner');

test('hasRulesOnDisk — wymaga OBU plików reguł, nie samego katalogu', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'configtest-rules-'));
  try {
    const dir = path.join(tmp, '99', 'data', 'versions', '9.9.9', 'pl');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(engineRunner.hasRulesOnDisk('99', '9.9.9', 'pl', tmp), false, 'sam katalog to za mało');

    fs.writeFileSync(path.join(dir, 'param.txt'), 'NAME\n');
    assert.equal(engineRunner.hasRulesOnDisk('99', '9.9.9', 'pl', tmp), false, 'bez paramdict.txt silnik i tak padnie');

    fs.writeFileSync(path.join(dir, 'paramdict.txt'), 'NAME\n');
    assert.equal(engineRunner.hasRulesOnDisk('99', '9.9.9', 'pl', tmp), true);

    // Ten sam katalog, inny język — reguły są per język.
    assert.equal(engineRunner.hasRulesOnDisk('99', '9.9.9', 'de', tmp), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hasRulesOnDisk — nieistniejąca wersja daje false, istniejąca true', () => {
  assert.equal(engineRunner.hasRulesOnDisk('43', '0.0.0-nie-ma', 'pl'), false);
  assert.equal(engineRunner.hasRulesOnDisk(null, '0.3.1', 'pl'), false);
  assert.equal(engineRunner.hasRulesOnDisk('43', null, 'pl'), false);

  // Jedna realna wersja z udziału — test pilnuje, że helper nie zwraca
  // `false` zawsze (taki „fix" pomijałby WSZYSTKIE pozycje po cichu).
  const grupy = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
  let znaleziona = null;
  for (const g of grupy) {
    const versionsDir = path.join(dataDir, g, 'data', 'versions');
    if (!fs.existsSync(versionsDir)) continue;
    for (const v of fs.readdirSync(versionsDir)) {
      if (fs.existsSync(path.join(versionsDir, v, 'pl', 'param.txt'))) {
        znaleziona = { g, v };
        break;
      }
    }
    if (znaleziona) break;
  }
  if (znaleziona) {
    assert.equal(engineRunner.hasRulesOnDisk(znaleziona.g, znaleziona.v, 'pl'), true,
      `${znaleziona.g}/${znaleziona.v} ma param.txt na dysku`);
  }
});

test('recomputeFromPositionRow — pozycja archiwalna wraca jako pominięta, nie jako wyjątek', async () => {
  const wynik = await engineRunner.recomputeFromPositionRow({
    id: 123456,
    asortment_group_number: '43',
    ver: '0.0.0-nie-ma',
    lang: 'pl',
    json_parameters: '{}',
    json_parameters_desc: '{}'
  });

  assert.equal(wynik.ok, false);
  assert.equal(wynik.missingRules, true, 'flaga, po której wołający liczy pominięcie zamiast zgłaszać brak ceny');
  assert.equal(wynik.positionId, 123456);
  assert.match(wynik.error, /brak reguł wersji/);
});

test('recomputeFromPositionRow — brak numeru grupy albo wersji to osobny przypadek', async () => {
  const bezGrupy = await engineRunner.recomputeFromPositionRow({ id: 1, ver: '0.3.1', json_parameters: '{}' });
  assert.equal(bezGrupy.ok, false);
  assert.ok(!bezGrupy.missingRules, 'to nie jest pozycja archiwalna, tylko niekompletny wiersz');
});
