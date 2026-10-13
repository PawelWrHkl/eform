'use strict';

/**
 * Strażnik pamięci chroni HOST przed robotem testującym.
 *
 * ⚠️ Incydent 2026-09-21: pełny przebieg położył całą maszynę (serwer eForm,
 * import, MySQL) — restart hosta o 14:12. Te testy pilnują, że przekroczenie
 * progu kończy się zabiciem PROCESU GRUPY i uczciwym zgłoszeniem, a nie
 * cichym „grupa czysta" ani dalszym duszeniem hosta.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForMemory, watchChild, hostAvailableMb } = require('../memoryGuard');

const LIMITS = {
  childHeapMb: 1280, childMaxRssMb: 1000, startMinAvailableMb: 1200,
  hostMinAvailableMb: 350, swapLowMb: 256, hostMinAvailableWhenSwapLowMb: 700,
  startWaitMs: 50, pollMs: 5
};

test('hostAvailableMb — na Linuksie czyta /proc/meminfo i daje sensowną liczbę', () => {
  const mb = hostAvailableMb();
  if (mb === null) return; // nie-Linux: brak /proc, strażnik nie blokuje
  assert.ok(mb > 0 && mb < 1024 * 1024, `MemAvailable ${mb} MB`);
});

test('waitForMemory — dość wolnego od razu: start bez czekania', async () => {
  const r = await waitForMemory({ limits: LIMITS, readAvailable: () => 2000, sleep: async () => {} });
  assert.deepEqual(r, { ok: true, availableMb: 2000 });
});

test('waitForMemory — pamięć zwalnia się w trakcie czekania: start', async () => {
  const odczyty = [800, 900, 1500];
  const r = await waitForMemory({
    limits: { ...LIMITS, startWaitMs: 10000 },
    readAvailable: () => odczyty.shift() ?? 1500,
    sleep: async () => {}
  });
  assert.equal(r.ok, true);
});

test('waitForMemory — pamięć się nie zwolniła: grupa ma zostać POMINIĘTA, nie odpalona', async () => {
  const r = await waitForMemory({ limits: LIMITS, readAvailable: () => 700, sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
  assert.deepEqual(r, { ok: false, availableMb: 700 });
});

test('waitForMemory — brak /proc nie blokuje (inne środowisko niż ten host)', async () => {
  const r = await waitForMemory({ limits: LIMITS, readAvailable: () => null, sleep: async () => {} });
  assert.equal(r.ok, true);
});

function obserwuj(rssSeq, availSeq, swapFree = 2000) {
  return new Promise((resolve) => {
    const rss = [...rssSeq];
    const avail = [...availSeq];
    let powod = null;
    const g = watchChild(1234, (r) => { powod = r; }, {
      limits: LIMITS,
      readRss: () => (rss.length ? rss.shift() : null),
      readAvailable: () => (avail.length ? avail.shift() : 5000),
      readSwapFree: () => swapFree
    });
    setTimeout(() => { g.stop(); resolve({ powod, szczyt: g.peakRssMb() }); }, 80);
  });
}

test('watchChild — RSS grupy ponad sufit: alarm z liczbami', async () => {
  const { powod, szczyt } = await obserwuj([400, 800, 1100], [5000, 5000, 5000]);
  assert.match(powod, /1100 MB RAM \(limit 1000 MB\)/);
  assert.equal(szczyt, 1100);
});

test('watchChild — host się dusi, choć grupa mieści się w sufit: alarm', async () => {
  // To jest scenariusz z 21.09: sama grupa nie przekracza limitu, ale razem
  // z resztą maszyny (VS Code, MySQL, import) host zostaje bez pamięci.
  const { powod } = await obserwuj([600, 700], [900, 300]);
  assert.match(powod, /zostało tylko 300 MB/);
});

test('watchChild — w normie: zero alarmów, szczyt zapamiętany', async () => {
  const { powod, szczyt } = await obserwuj([500, 900, 700], [3000, 2500, 2800]);
  assert.equal(powod, null);
  assert.equal(szczyt, 900);
});

test('watchChild — alarm tylko RAZ, nawet gdy przekroczenie trwa', async () => {
  let ile = 0;
  const rss = [1500, 1600, 1700, 1800];
  const g = watchChild(1, () => { ile += 1; }, {
    limits: LIMITS, readRss: () => rss.shift() ?? 1800, readAvailable: () => 5000
  });
  await new Promise((r) => setTimeout(r, 60));
  g.stop();
  assert.equal(ile, 1, 'jeden SIGKILL, jedno zgłoszenie');
});

test('watchChild — prawie pełny swap PODNOSI próg: 600 MB wolnego to już alarm', async () => {
  // Zmierzone 2026-10-12 w trakcie grupy 39: swap 96% zajęty, 147 MB wolnego.
  // Jądro nie ma wtedy dokąd wypychać pamięci, więc 600 MB wolnej RAM to za
  // mało, choć przy zdrowym swapie byłoby w porządku.
  const przyPelnymSwapie = await obserwuj([600, 650], [900, 600], 147);
  assert.match(przyPelnymSwapie.powod, /próg 700 MB, podniesiony — swap prawie pełny: 147 MB/);

  const przyZdrowymSwapie = await obserwuj([600, 650], [900, 600], 2000);
  assert.equal(przyZdrowymSwapie.powod, null, 'ten sam stan przy zdrowym swapie jest w normie');
});
