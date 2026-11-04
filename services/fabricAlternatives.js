'use strict';

/**
 * Alternatywy dla niedostępnych tkanin — plik zbiorczy agentai
 * (`alternatives.json`, ok. 6 MB, przebudowywany co noc ok. 7:10).
 *
 * agentai jest tylko w sieci HKL, więc plik wędruje przez dysk:
 *   1. `scripts/syncFabricAlternatives.js` (cron wewnętrznego serwera) pobiera go
 *      kluczem z `.env.local` i podmienia `config.fabricAlternativesFile`
 *      (`<ROOT_DIR>/data/data/.fabric-alternatives.json`),
 *   2. `update.sh eorders_data` (rsync `/mnt/eform/data/*`) zanosi go na produkcję,
 *   3. każdy serwer E-Formu czyta tylko ten plik (`createAlternativesStore`).
 * Nazwa z kropką: `express.static` (`/photos`, `/data`) takich plików nie serwuje.
 *
 * Układ pliku: forms → formatka → lista → kod z listy klienta →
 * { hkl, pg, state, alternatives: [{ code, hkl, pg, delta_e, ... }] }.
 */

const fs = require('fs');
const path = require('path');

// Plik w pamięci; przeładowany, gdy zmieni się jego mtime (sync podmienia go rename'em).
function createAlternativesStore({ file, log }) {
  let forms = null;
  let loadedMtime = null;

  async function getForms() {
    const { mtimeMs } = await fs.promises.stat(file);
    if (mtimeMs !== loadedMtime) {
      try {
        forms = JSON.parse(await fs.promises.readFile(file, 'utf8')).forms || {};
      } catch (err) {
        if (!forms) throw err;
        log('Alternatywy tkanin: plik nieczytelny, zostaje poprzedni:', err);
      }
      loadedMtime = mtimeMs;
    }
    return forms;
  }

  // `items` w kolejności kafelków; wynik wyrównany indeksami, `null` = brak wpisu.
  async function lookup(form, items) {
    const all = await getForms();
    const lists = Object.hasOwn(all, form) ? all[form] : {};
    return items.map(({ code, list }) => {
      const entry = Object.hasOwn(lists, list) && Object.hasOwn(lists[list], code) ? lists[list][code] : null;
      if (!entry) return null;
      return {
        pg: entry.pg ?? null,
        alternatives: (entry.alternatives || []).map(({ code, pg, delta_e }) => ({ code, pg, delta_e }))
      };
    });
  }

  return { lookup };
}

// Pobiera plik z agentai i podmienia go atomowo. Zły albo pusty plik nie
// nadpisuje dobrego — produkcja zostaje przy poprzednim.
async function syncAlternativesFile({ url, key, file, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    headers: { 'X-Api-Key': key },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`agentai: HTTP ${response.status}`);
  const text = await response.text();
  const data = JSON.parse(text);
  const formCount = Object.keys(data?.forms || {}).length;
  if (!formCount) throw new Error('agentai: plik bez formatek (forms)');

  const current = await fs.promises.readFile(file, 'utf8').catch(() => null);
  const summary = { generatedAt: data.generated_at, stockSyncedAt: data.stock_synced_at, forms: formCount };
  if (current === text) return { ...summary, changed: false };

  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, text);
  await fs.promises.rename(tmp, file);
  return { ...summary, changed: true };
}

module.exports = { createAlternativesStore, syncAlternativesFile };
