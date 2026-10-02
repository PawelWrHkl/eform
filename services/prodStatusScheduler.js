'use strict';

/**
 * Cykliczne uruchamianie `scripts/prodStatusSync.js` z procesu serwera.
 *
 * Każdy cykl to OSOBNY PROCES (`spawn`), nie funkcja w procesie serwera:
 *  - awaria albo wyciek pamięci w synchronizacji nie dotyka obsługi żądań,
 *  - długi przebieg (VIES, NBP, wiele faktur) nie blokuje pętli zdarzeń serwera,
 *  - ten sam skrypt odpala ręcznie `npm run prodstatus:run` albo cron —
 *    jedna ścieżka kodu niezależnie od tego, kto go woła.
 * Uruchamianie z serwera to „sztuczka" na kontenery: `npm start` w obrazie
 * Dockera startuje tylko `server.js`, więc dzięki temu cykl chodzi wszędzie,
 * gdzie chodzi aplikacja, bez dodatkowego crona czy usługi systemd.
 *
 * ⚠️ `spawn`, nie `fork`: `fork` przekazuje dziecku `process.execArgv`, czyli
 * na hoście `--watch` — dziecko stałoby się drugim obserwatorem plików.
 *
 * Konfiguracja (`.env`):
 *   PROD_STATUS_SYNC_MODE=child|external|off  domyślnie `child` (ten moduł);
 *                                             `external` = uruchamia cron/systemd
 *   PROD_STATUS_SYNC_INTERVAL_MIN=60          co ile minut (minimum 5)
 *
 * Kilka instancji na jednej bazie (host + kontenery) jest bezpieczne — cykl bierze
 * blokadę w MySQL (`services/prodStatusCycle.js`), a pozostałe go pomijają.
 */

const path = require('path');
const { spawn } = require('child_process');
const { log: defaultLog } = require('../utils/logging');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'prodStatusSync.js');
const MODES = ['child', 'external', 'off'];
const DEFAULT_INTERVAL_MIN = 60;
const MIN_INTERVAL_MIN = 5;
/** Pierwszy cykl chwilę po starcie — serwer ma najpierw wstać i obsługiwać ruch. */
const START_DELAY_MS = 60 * 1000;
/** Cykl dłuższy niż to uznajemy za zawieszony (np. wiszące połączenie z bazą). */
const CYCLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ mode: string, intervalMin: number, warnings: string[] }}
 */
function readSchedulerConfig(env = process.env) {
    const warnings = [];
    const rawMode = String(env.PROD_STATUS_SYNC_MODE || '').trim().toLowerCase();
    let mode = rawMode || 'child';
    if (!MODES.includes(mode)) {
        warnings.push(`nieznany PROD_STATUS_SYNC_MODE=„${rawMode}" — używam „child" (dozwolone: ${MODES.join(', ')})`);
        mode = 'child';
    }

    const rawInterval = env.PROD_STATUS_SYNC_INTERVAL_MIN;
    let intervalMin = Number(rawInterval);
    if (rawInterval === undefined || String(rawInterval).trim() === '') {
        intervalMin = DEFAULT_INTERVAL_MIN;
    } else if (!Number.isFinite(intervalMin) || intervalMin < MIN_INTERVAL_MIN) {
        warnings.push(`PROD_STATUS_SYNC_INTERVAL_MIN=„${rawInterval}" poza zakresem — używam ${DEFAULT_INTERVAL_MIN} min (minimum ${MIN_INTERVAL_MIN})`);
        intervalMin = DEFAULT_INTERVAL_MIN;
    }
    return { mode, intervalMin, warnings };
}

/**
 * @param {Object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Function} [opts.spawnFn]  podmiana `child_process.spawn` w testach
 * @param {Function} [opts.log]
 * @param {number} [opts.startDelayMs]
 * @returns {{ runNow: () => boolean, stop: () => void, config: object }|null} `null`, gdy cykl jest poza serwerem
 */
function startProdStatusScheduler({ env = process.env, spawnFn = spawn, log = defaultLog, startDelayMs = START_DELAY_MS } = {}) {
    const config = readSchedulerConfig(env);
    config.warnings.forEach((w) => log(`[prodStatus] ${w}`));

    if (config.mode !== 'child') {
        log(`[prodStatus] PROD_STATUS_SYNC_MODE=${config.mode} — serwer nie uruchamia synchronizacji statusów`
            + (config.mode === 'external' ? ' (oczekiwany cron/systemd: scripts/prodStatusSync.js)' : ''));
        return null;
    }

    let running = null;
    // Dzień ostatniego udanego cyklu `--full`. Zwykły cykl przelicza nagłówki
    // tylko tych zamówień, których pozycje się zmieniły — zamówienie, któremu
    // zapis nagłówka się nie udał, czekałoby na kolejną zmianę statusu. Pełne
    // przeliczenie kosztuje ~2 s, więc pierwszy cykl każdego dnia (i pierwszy
    // po starcie) robi je dla wszystkich zamówień z pliku.
    let lastFullDay = null;

    /** @returns {boolean} czy cykl wystartował */
    const runNow = () => {
        if (running) {
            log('[prodStatus] poprzedni cykl jeszcze trwa — pomijam ten termin');
            return false;
        }
        const today = new Date().toISOString().slice(0, 10);
        const full = lastFullDay !== today;
        const child = spawnFn(process.execPath, full ? [SCRIPT, '--full'] : [SCRIPT], {
            cwd: path.join(__dirname, '..'),
            env,
            stdio: 'inherit'
        });
        running = child;

        const killer = setTimeout(() => {
            log(`[prodStatus] cykl przekroczył ${CYCLE_TIMEOUT_MS / 60000} min — przerywam (pid ${child.pid})`);
            child.kill('SIGTERM');
        }, CYCLE_TIMEOUT_MS);
        killer.unref();

        const finish = () => {
            clearTimeout(killer);
            if (running === child) running = null;
        };
        child.on('exit', (code, signal) => {
            finish();
            if (full && code === 0) lastFullDay = today;
            if (code) log(`[prodStatus] cykl zakończony kodem ${code}${code === 1 ? ' (część zapisów się nie udała — szczegóły wyżej)' : ''}`);
            if (signal) log(`[prodStatus] cykl przerwany sygnałem ${signal}`);
        });
        child.on('error', (err) => {
            finish();
            log(`[prodStatus] nie udało się uruchomić cyklu: ${err.message}`);
        });
        return true;
    };

    // `unref`: harmonogram nie może trzymać przy życiu procesu, który i tak się kończy
    const first = setTimeout(runNow, startDelayMs);
    first.unref();
    const timer = setInterval(runNow, config.intervalMin * 60 * 1000);
    timer.unref();

    log(`[prodStatus] synchronizacja statusów i automat faktur co ${config.intervalMin} min (pierwszy cykl za ${Math.round(startDelayMs / 1000)} s)`);

    return {
        runNow,
        stop: () => {
            clearTimeout(first);
            clearInterval(timer);
        },
        config
    };
}

module.exports = { SCRIPT, readSchedulerConfig, startProdStatusScheduler };
