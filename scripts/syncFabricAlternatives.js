#!/usr/bin/env node
'use strict';

/**
 * Pobiera alternatywy tkanin z agentai do `config.fabricAlternativesFile`
 * (services/fabricAlternatives.js opisuje całą drogę pliku na produkcję).
 * Cron wewnętrznego serwera, co godzinę — plik bez zmian nie jest ruszany,
 * więc rsync na produkcję nie przenosi go niepotrzebnie.
 *
 *   node scripts/syncFabricAlternatives.js
 *
 * Kod wyjścia 1 = nie pobrano (stary plik zostaje); powód na stderr.
 */

require('dotenv').config({ path: ['.env.local', '.env'].map((f) => require('path').join(__dirname, '..', f)) });
const { fabricAlternativesFile } = require('../config');
const { syncAlternativesFile } = require('../services/fabricAlternatives');

(async () => {
  const url = process.env.FABRIC_ALTERNATIVES_URL;
  const key = process.env.FABRIC_ALTERNATIVES_KEY;
  if (!url || !key) {
    console.error(`${new Date().toISOString()} Brak FABRIC_ALTERNATIVES_URL/_KEY w .env.local — przerwano.`);
    process.exit(1);
  }
  try {
    const r = await syncAlternativesFile({ url, key, file: fabricAlternativesFile });
    console.log(`${new Date().toISOString()} ${r.changed ? 'zapisano' : 'bez zmian'}: ${fabricAlternativesFile} (generated_at ${r.generatedAt}, stany PCB ${r.stockSyncedAt}, formatek ${r.forms})`);
  } catch (err) {
    console.error(`${new Date().toISOString()} Alternatywy tkanin: ${err.message} — zostaje poprzedni plik.`);
    process.exit(1);
  }
})();
