#!/usr/bin/env node
'use strict';

/**
 * „Równoległe faktury” z danych produkcyjnych — kontrakt e-faktur v1.4, pkt 8 (życzenie KK).
 *
 * Dla wysłanych (`!sent!`) zamówień wystawcy (domyślnie Luxan GmbH, poziom 2) z okresu
 * dostawy buduje treść faktury DOKŁADNIE jak `createFromOrder` (te same ceny, VAT, nazwy),
 * ale bez zapisu do bazy i bez VIES, nadaje numer `SHADOW-<order_id>` i `invoice_id = -order_id`
 * (Wiktoria 19.11.2026: liczba wymagana, ujemna nie zderzy się z prawdziwą fakturą) i — dopiero z `--send` —
 * wysyła ją kluczem shadow do usługi Wiktorii, która porównuje ją z fakturami PROD.
 *
 * TYLKO ODCZYT: repozytorium faktur jest owinięte strażnikiem, który przepuszcza wyłącznie
 * funkcje czytające (`get…`, `find…`, `list…`); każda inna kończy skrypt błędem.
 *
 *   node scripts/einvoiceShadowBatch.js --from 2026-11-01 --to 2026-11-17 --env prod
 *        podgląd: treści w plikach JSON (--out), bez sieci
 *   node scripts/einvoiceShadowBatch.js --from 2026-11-01 --to 2026-11-17 --env prod --send
 *        wysyłka kluczem EINVOICE_BATCH_API_KEY (.env.local)
 *
 * Opcje: --org LUXANGMBH  --limit 500  --out <katalog>  --expect-host <@@hostname bazy>
 *
 * Baza: z DATABASE_* (jak cały E-Form). Dla produkcji przez tunel ustaw jawnie WSZYSTKIE
 * DATABASE_HOST/PORT/USER/PASSWORD/DATABASE i podaj --expect-host (skrypt sprawdza, czy
 * łączy się z tą bazą, zanim cokolwiek wyśle). `--env prod` tylko dla danych produkcji —
 * usługa porównuje z PROD wyłącznie dokumenty z `efor_env = prod`.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '..', '.env')] });

const { selectQuery } = require('../db/core');
const repository = require('../services/invoices/db/repository');
const { InvoiceService } = require('../services/invoices/main');
const { buildPayload, ENVS } = require('../services/invoices/einvoice/payload');
const { EinvoiceClient, EinvoiceTransportError } = require('../services/invoices/einvoice/client');
const { classifyResponse, eventPayload, describeOutcome } = require('../services/invoices/einvoice');

const READ_ONLY = /^(get|find|list|search|count|load|peek|has|supports)/;

/** Repozytorium, które pozwala tylko czytać — zapis z tego skryptu = błąd programisty. */
function readOnlyRepository(repo) {
  return new Proxy(repo, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function' || READ_ONLY.test(String(prop))) return value;
      return () => { throw new Error(`einvoiceShadowBatch: zapis zablokowany (repository.${String(prop)}) — skrypt jest tylko do odczytu`); };
    }
  });
}

const VALUE_OPTIONS = { '--from': 'from', '--to': 'to', '--org': 'org', '--env': 'env', '--out': 'out', '--expect-host': 'expectHost', '--limit': 'limit' };

function parseArgs(argv) {
  const args = { org: 'LUXANGMBH', limit: 500, send: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') args.send = true;
    else if (VALUE_OPTIONS[a]) args[VALUE_OPTIONS[a]] = argv[++i];
    else throw new Error(`nieznana opcja ${a}`);
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(args.from || '') || !day.test(args.to || '')) throw new Error('--from i --to: daty RRRR-MM-DD (okres dostawy zamówień)');
  if (!ENVS.includes(args.env)) throw new Error(`--env: ${ENVS.join(' | ')} — prod tylko dla danych produkcji`);
  args.limit = Number(args.limit);
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit: liczba dodatnia');
  args.out = args.out || path.join(os.tmpdir(), `einvoice-batch-${args.org}-${args.from}_${args.to}`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // `selectQuery` połyka błędy bazy (zwraca undefined) — tu brak wyniku = koniec
  const hostRows = await selectQuery('SELECT @@hostname AS host');
  if (!Array.isArray(hostRows) || !hostRows[0]) throw new Error('brak połączenia z bazą (DATABASE_*)');
  const { host } = hostRows[0];
  if (args.expectHost && host !== args.expectHost) throw new Error(`baza ${host}, a oczekiwana ${args.expectHost} — przerywam`);

  const key = process.env.EINVOICE_BATCH_API_KEY || '';
  if (args.send && !key) throw new Error('--send wymaga EINVOICE_BATCH_API_KEY w .env.local');

  const orders = await selectQuery(
    `SELECT o.id, o.order_idx, u.ident AS user_ident
       FROM \`order\` o
       JOIN \`user\` u ON u.id = o.user_id
       JOIN organization org ON org.id = o.organization_id
      WHERE org.ident = ? AND o.status = 'sent' AND o.prod_status = '!sent!'
        AND o.delivery_date BETWEEN ? AND ?
      ORDER BY o.delivery_date, o.id
      LIMIT ?`,
    [args.org, args.from, args.to, args.limit]
  );
  if (!Array.isArray(orders)) throw new Error('zapytanie o zamówienia nie powiodło się (log aplikacji)');
  fs.mkdirSync(args.out, { recursive: true });
  console.log(`[batch] baza ${host}, ${args.org}, dostawy ${args.from}…${args.to}: ${orders.length} zamówień → ${args.out}${args.send ? ' (WYSYŁKA)' : ' (podgląd)'}`);

  const repo = readOnlyRepository(repository);
  const service = new InvoiceService({ repository: repo, log: () => {} });
  const client = args.send ? new EinvoiceClient({ baseUrl: process.env.EINVOICE_URL || 'http://192.168.0.21:5031', log: (m) => console.log(m) }) : null;
  const summary = { built: 0, skipped: 0, outcomes: {} };

  for (const order of orders) {
    const label = `${order.user_ident}/${order.order_idx} (id ${order.id})`;
    let payload;
    try {
      const { invoice } = await service.createFromOrder({ orderId: order.id, level: 2, documentType: 'invoice', issue: false, dryRun: true, skipVies: true });
      payload = buildPayload({ invoice: { ...invoice, id: -order.id }, env: args.env, sources: await repo.getEinvoiceSources(invoice), number: `SHADOW-${order.id}` });
    } catch (err) {
      summary.skipped++;
      console.log(`[batch] ${label}: pominięte — ${err.message}`);
      continue;
    }
    summary.built++;
    fs.writeFileSync(path.join(args.out, `SHADOW-${order.id}.json`), JSON.stringify(payload, null, 1));
    if (!client) {
      console.log(`[batch] ${label}: ${payload.items.length} poz., ${payload.totals.net} EUR netto`);
      continue;
    }
    let res;
    try {
      res = await client.submit(payload, key);
    } catch (err) {
      if (err instanceof EinvoiceTransportError) throw new Error(`usługa niedostępna: ${err.message}`);
      throw err;
    }
    const outcome = classifyResponse(res);
    if (outcome.abort) throw new Error(`${outcome.reason} — klucz albo adres IP`);
    const key2 = outcome.event || 'w_toku';
    summary.outcomes[key2] = (summary.outcomes[key2] || 0) + 1;
    console.log(`[batch] ${label}: ${outcome.event ? describeOutcome(outcome.event, eventPayload(res, null)) : outcome.reason}`);
  }
  console.log(`[batch] gotowe: zbudowane ${summary.built}, pominięte ${summary.skipped}${args.send ? `, wyniki ${JSON.stringify(summary.outcomes)}` : ''}`);
}

if (require.main === module) {
  main()
    .then(() => { process.exitCode = 0; })
    .catch((err) => { console.error(`[batch] BŁĄD: ${err.message}`); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(), 500).unref());
}

module.exports = { readOnlyRepository, parseArgs };
