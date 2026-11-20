#!/usr/bin/env node
'use strict';

/**
 * Ponowienia zapytań o koszty transportu między godzinnymi przebiegami faktur
 * (services/invoices/transport.js): dni z nieudanym zapytaniem, których termin kolejnej
 * próby minął (1, 2, 5, 10, potem co 15 min; 500 co 5 min; 4xx co godzinę). Nic nie
 * wystawia: faktury powstaną w najbliższym przebiegu automatu (scripts/prodStatusSync.js).
 *
 *   * * * * * flock -n /tmp/eform-transport-retry.lock node scripts/transportQuoteRetry.js
 *
 * Bez dni do ponowienia kończy się bez łączenia z bazą.
 */

require('dotenv').config({ path: ['.env.local', '.env'].map((f) => require('path').join(__dirname, '..', f)) });
const { readTransportConfig, createTransportSession } = require('../services/invoices/transport');

(async () => {
  const config = readTransportConfig(process.env);
  if (!config.enabled || config.problems.length) process.exit(0);
  let session = createTransportSession({ config, repository: {} });
  const due = session.dueDays();
  if (!due.length) process.exit(0);
  session = createTransportSession({ config, repository: require('../services/invoices/db/repository') });
  for (const day of due) {
    const r = await session.ensureDay(day);
    console.log(`${new Date().toISOString()} transport ${day}: ${r.ok ? 'wycena OK' : r.reason}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error(`${new Date().toISOString()} transport: ${err.message}`);
  process.exit(1);
});
