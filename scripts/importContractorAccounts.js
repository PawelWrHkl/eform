'use strict';

/**
 * Konta HKL do wpłat per kontrahent: kartoteka z księgowości (xlsx) → `services/invoices/data/hkl-contractor-accounts.json`
 * (czyta `core/contractorAccounts.js`). Paweł 19.11.2026: „dla klientów HKL w fakturach brać stąd numery kont — obowiązek”.
 * Po nowym pliku z księgowości: uruchom ponownie i wgraj JSON (bez restartu nie zadziała — plik czyta się raz na proces).
 *
 *   node scripts/importContractorAccounts.js "kontrahenci - nr kont bankowych.xlsx"
 *
 * Kolumny (nagłówek w 1. wierszu): Identyfikator, Nip, Nazwa, Kraj - kod, FA-BANK - Cecha, FA-IBAN - Cecha,
 * FA-SWIFT - Cecha, Nip - bez formatu. Wiersz bez NIP-u albo z błędnym IBAN-em → przerwanie (lepiej nic niż złe konto).
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { normalizeTaxId, isValidIban, formatIban } = require('../services/invoices/core/contractorAccounts');

const OUT = path.join(__dirname, '..', 'services', 'invoices', 'data', 'hkl-contractor-accounts.json');

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('podaj plik xlsx z księgowości');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const header = ws.getRow(1).values.map((v) => String(v ?? '').trim());
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 1) throw new Error(`w pliku brak kolumny „${name}”`);
    return i;
  };
  const c = { ident: col('Identyfikator'), nip: col('Nip'), nipPlain: col('Nip - bez formatu'), name: col('Nazwa'),
    country: col('Kraj - kod'), bank: col('FA-BANK - Cecha'), iban: col('FA-IBAN - Cecha'), swift: col('FA-SWIFT - Cecha') };

  const accounts = {};
  const problems = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = (i) => String(row.getCell(i).text ?? '').replace(/\s+/g, ' ').trim();
    if (!v(c.ident) && !v(c.nip) && !v(c.iban)) return; // puste wiersze na końcu arkusza
    const key = normalizeTaxId(v(c.nipPlain) || v(c.nip));
    if (!key) problems.push(`wiersz ${n} (${v(c.ident)}): brak NIP-u`);
    else if (!isValidIban(v(c.iban))) problems.push(`wiersz ${n} (${v(c.ident)}): błędny IBAN „${v(c.iban)}”`);
    else if (accounts[key]) problems.push(`wiersz ${n} (${v(c.ident)}): NIP ${key} już jest (${accounts[key].ident})`);
    else {
      accounts[key] = { ident: v(c.ident), name: v(c.name), country: v(c.country),
        bankName: v(c.bank), iban: formatIban(v(c.iban)), swift: v(c.swift).replace(/\s+/g, '') };
    }
  });
  if (problems.length) throw new Error(`plik niezapisany:\n  ${problems.join('\n  ')}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ source: path.basename(file), imported: new Date().toISOString().slice(0, 10), accounts }, null, 2)}\n`);
  const byIban = Object.values(accounts).reduce((m, a) => m.set(a.iban, (m.get(a.iban) || 0) + 1), new Map());
  console.log(`zapisano ${Object.keys(accounts).length} kontrahentów → ${path.relative(process.cwd(), OUT)}`);
  for (const [iban, count] of byIban) console.log(`  ${count} × ${iban}`);
})().catch((err) => { console.error(`BŁĄD: ${err.message}`); process.exit(1); });
