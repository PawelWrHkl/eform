/**
 * Strażnik pamięci dla procesów grup testera — chroni HOST, nie tester.
 *
 * ⚠️ DLACZEGO TO ISTNIEJE — incydent 2026-09-21: pełny przebieg padł w trakcie
 * grupy 39 i pociągnął za sobą CAŁĄ maszynę (serwer eForm, demon importu,
 * MySQL); host zrestartował się o 14:12, bez wpisu o OOM. Zmierzone tego dnia:
 * 7.9 GB RAM, z czego dostępne ~1.8 GB i 2.7 GB już w swapie (VS Code server,
 * sesje Claude Code, MySQL, demon importu), a jedna grupa testera potrzebuje
 * ~1.5 GB (JSDOM + sparsowany arkusz cennika). Proces grupy dostawał przy tym
 * `--max-old-space-size=2048` — więcej, niż maszyna w ogóle miała wolne, więc
 * V8 nie miał powodu sprzątać, zanim jądro zaczęło dusić się swapem.
 *
 * Zasada: lepiej NIE sprawdzić jednej grupy (i uczciwie to zgłosić), niż
 * położyć serwer, na którym pracują ludzie. Dlatego:
 *  1. przed startem grupy czekamy, aż na hoście będzie dość wolnej pamięci;
 *     jak się nie doczekamy — grupa jest pomijana ze zgłoszeniem;
 *  2. w trakcie co 2 s patrzymy na RSS dziecka i na `MemAvailable` hosta —
 *     przekroczenie któregokolwiek progu zabija DZIECKO (SIGKILL) i zostawia
 *     ślad w raporcie.
 *
 * Bez roota i bez systemd: czytamy wyłącznie `/proc`, więc działa tak samo
 * z crona, z demona i z ręcznego `npm run configtest:run`.
 */

'use strict';

const fs = require('fs');

const mb = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Domyślne progi dobrane do zmierzonego hosta (patrz wyżej); każdy da się
// nadpisać w .env bez zmiany kodu.
const LIMITS = {
  /** Sterta V8 procesu grupy. Poniżej zmierzonego szczytu ~1.5 GB RSS. */
  childHeapMb: mb('CONFIGTEST_CHILD_HEAP_MB', 1280),
  /** Twardy sufit RSS procesu grupy — powyżej zabijamy dziecko. */
  childMaxRssMb: mb('CONFIGTEST_CHILD_MAX_RSS_MB', 1700),
  /** Ile musi być wolne na hoście, żeby w ogóle zacząć grupę. */
  startMinAvailableMb: mb('CONFIGTEST_START_MIN_AVAILABLE_MB', 1200),
  /** Poniżej tego w trakcie grupy — zabijamy dziecko, zanim host zacznie się dusić. */
  hostMinAvailableMb: mb('CONFIGTEST_HOST_MIN_AVAILABLE_MB', 350),
  /**
   * Gdy swap jest prawie pełny, jądro nie ma już dokąd wypychać pamięci i
   * `MemAvailable` spada gwałtownie — wtedy próg zabicia grupy podnosimy.
   * Zmierzone 2026-10-12 w trakcie grupy 39: swap 3948/4095 MB (96%),
   * na starcie przebiegu było 2715 MB.
   */
  swapLowMb: mb('CONFIGTEST_SWAP_LOW_MB', 256),
  hostMinAvailableWhenSwapLowMb: mb('CONFIGTEST_HOST_MIN_AVAILABLE_SWAPLOW_MB', 700),
  /** Jak długo czekać na wolną pamięć przed startem grupy. */
  startWaitMs: mb('CONFIGTEST_START_WAIT_SEC', 300) * 1000,
  pollMs: 2000
};

/** `MemAvailable` hosta w MB, albo `null`, gdy /proc jest niedostępne (nie-Linux). */
function hostAvailableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (_e) {
    return null;
  }
}

/** Wolny swap w MB (`null` bez /proc albo bez swapu). */
function hostSwapFreeMb() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = /^SwapTotal:\s+(\d+)\s+kB/m.exec(txt);
    const free = /^SwapFree:\s+(\d+)\s+kB/m.exec(txt);
    if (!total || !free || Number(total[1]) === 0) return null;
    return Math.round(Number(free[1]) / 1024);
  } catch (_e) {
    return null;
  }
}

/** RSS procesu w MB, albo `null`, gdy proces już nie istnieje. */
function processRssMb(pid) {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Czeka, aż host będzie miał `startMinAvailableMb` wolnego.
 * @returns {Promise<{ok:boolean, availableMb:number|null}>}
 */
async function waitForMemory({ limits = LIMITS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), readAvailable = hostAvailableMb } = {}) {
  const deadline = Date.now() + limits.startWaitMs;
  let available = readAvailable();
  // Brak /proc → nie ma czym mierzyć; nie blokujemy (środowisko inne niż ten host).
  if (available === null) return { ok: true, availableMb: null };
  while (available < limits.startMinAvailableMb && Date.now() < deadline) {
    await sleep(Math.min(10000, limits.startWaitMs));
    available = readAvailable();
  }
  return { ok: available >= limits.startMinAvailableMb, availableMb: available };
}

/**
 * Pilnuje działającego dziecka. Woła `onBreach(powód)` RAZ, przy pierwszym
 * przekroczeniu progu — wołający zabija proces i zapisuje zgłoszenie.
 * @returns {{stop: Function, peakRssMb: () => number}}
 */
function watchChild(pid, onBreach, { limits = LIMITS, readRss = processRssMb, readAvailable = hostAvailableMb, readSwapFree = hostSwapFreeMb } = {}) {
  let peak = 0;
  let fired = false;
  const timer = setInterval(() => {
    const rss = readRss(pid);
    if (rss === null) return; // proces już się skończył
    peak = Math.max(peak, rss);
    if (fired) return;

    const available = readAvailable();
    const swapFree = readSwapFree();
    const swapLow = swapFree !== null && swapFree < limits.swapLowMb;
    // Pełny swap = jądro nie ma dokąd wypychać pamięci — wyższy próg.
    const floor = swapLow ? limits.hostMinAvailableWhenSwapLowMb : limits.hostMinAvailableMb;
    let reason = null;
    if (rss > limits.childMaxRssMb) {
      reason = `proces grupy zajął ${rss} MB RAM (limit ${limits.childMaxRssMb} MB)`;
    } else if (available !== null && available < floor) {
      reason = `na hoście zostało tylko ${available} MB wolnej pamięci (próg ${floor} MB${swapLow ? `, podniesiony — swap prawie pełny: ${swapFree} MB wolnego` : ''}) przy ${rss} MB zajętych przez grupę`;
    }
    if (reason) {
      fired = true;
      onBreach(reason);
    }
  }, limits.pollMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer), peakRssMb: () => peak };
}

module.exports = { LIMITS, hostAvailableMb, hostSwapFreeMb, processRssMb, waitForMemory, watchChild };
