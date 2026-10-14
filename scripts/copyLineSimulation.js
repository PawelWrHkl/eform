#!/usr/bin/env node
/**
 * Robot kopiowania pozycji w prawdziwej przeglądarce (Playwright) — ręczne
 * uruchomienie tego, co nocny przebieg robi z flagą `--kopiowanie`
 * (silnik: services/configuratorTester/copyLineRunner.js).
 *
 * Skąd: zgłoszenie Ryver 2026-10-12 (oferta 351 — STOFBREEDTE „-" w kopii;
 * wcześniej rzymskie). Klienci „kopiują" przyciskiem „wczytaj ostatnią
 * konfigurację" na stronie nowej pozycji (main.js, `localStorage.formData`),
 * rzadziej „duplikuj" (→ strona edycji). Opis błędów i poprawek:
 * PROJECT_OVERVIEW.md, Changelog 2026-10-13.
 *
 * Dwa rodzaje przypadków:
 *   scenariusze Ryver   kopia + kroki jak u klienta, pilnowane wskazane pola
 *   wygenerowane        prawdziwa pozycja z bazy jako wzorzec → kopie bez zmian
 *                       („ostatnia konfiguracja" łańcuchowo, „Duplikuj") →
 *                       porównanie pole po polu + walidacja pustego pola wymaganego
 *
 * Wykrywa (kod zgłoszenia KOPIA_<rodzaj>):
 *   BRAK_POLA / ZMIANA_WARTOSCI / NOWE_POLE   wartości pól wybieranych przez klienta
 *   ZMIANA_CENY / ZMIANA_POLA_LICZONEGO       ceny, dopłaty, sumy, pola liczone
 *   OPIS_BEZ_WARTOSCI    zapisany opis bez `option_value` (tabela zlecenia i PDF: „-")
 *   ZMIANA_OPISU / ZMIANA_WIDOCZNOSCI         opisy opcji, schowane/odsłonięte pola
 *   ROZJAZD_FORMULARZA   formularz pokazuje coś innego niż `values` (które idą do zapisu)
 *   ZAPIS_ZABLOKOWANY / ZAPIS_PRZESZEDL       walidacja zachowała się inaczej niż oczekiwano
 *
 * Usage:
 *   node scripts/copyLineSimulation.js                     # wszystkie scenariusze, bez wygenerowanych
 *   node scripts/copyLineSimulation.js vertical-ostatnia   # wybrane scenariusze
 *   node scripts/copyLineSimulation.js --generated=10      # dodatkowo 10 przypadków wygenerowanych
 *   node scripts/copyLineSimulation.js --only-generated=6 --groups=24,59
 *   node scripts/copyLineSimulation.js --list              # lista scenariuszy
 *   opcje: --repeat=N        ile kolejnych kopii (domyślnie 2; „ostatnia" kopiuje łańcuchowo)
 *          --base=<id>       pozycja bazowa scenariusza zamiast wyszukanej automatycznie
 *          --browsers=a,b    chromium (domyślnie), chrome, msedge, firefox, webkit
 *          --seed=<n>        ziarno losowania wzorców (domyślnie data)
 *          --budget=<min>    limit czasu (domyślnie 50)
 *          --slow=<ms>       opóźnienie sieci (CDP, tylko Chromium), żeby trafić w wyścigi
 *          --trap=<PARAM>    stos wywołań przy kasowaniu option_value / wartości PARAM
 *          --json=<plik>     zapisz wyniki jako JSON
 *          --keep            nie usuwaj utworzonych pozycji
 *          --headed          widoczna przeglądarka
 *
 * Env (.env): CONFIGTEST_SIM_PIN, CONFIGTEST_SIM_PASSWORD, CONFIGTEST_SIM_ORDER_ID,
 *   CONFIGTEST_APP_URL (domyślnie http://localhost:8000), DATABASE_* jak db/core.js.
 * Kod wyjścia: 0 — czysto, 1 — znaleziono problem, 2 — nie dało się uruchomić.
 *
 * ⚠️ Zapisuje (i usuwa) pozycje w zleceniu symulatora — tylko środowisko testowe.
 */
require('dotenv').config();

const fs = require('fs');
const { runCopyChecks, refuseReason, SCENARIOS } = require('../services/configuratorTester/copyLineRunner');

function parseArgs(argv) {
  const opts = {
    names: [], repeat: null, base: null, slow: 0, trap: null, json: null, keep: false, headed: false, list: false,
    generated: 0, onlyGenerated: false, browsers: null, seed: null, budget: null, groups: null
  };
  const num = (a, prefix) => Math.max(0, +a.slice(prefix.length) || 0);
  for (const a of argv) {
    if (!a.startsWith('--')) opts.names.push(a);
    else if (a === '--list') opts.list = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--headed') opts.headed = true;
    else if (a.startsWith('--repeat=')) opts.repeat = Math.max(1, num(a, '--repeat=') || 1);
    else if (a.startsWith('--base=')) opts.base = num(a, '--base=');
    else if (a.startsWith('--slow=')) opts.slow = num(a, '--slow=');
    else if (a.startsWith('--trap=')) opts.trap = a.slice(7);
    else if (a.startsWith('--json=')) opts.json = a.slice(7);
    else if (a.startsWith('--generated=')) opts.generated = num(a, '--generated=');
    else if (a.startsWith('--only-generated=')) { opts.generated = num(a, '--only-generated='); opts.onlyGenerated = true; }
    else if (a.startsWith('--browsers=')) opts.browsers = a.slice(11).split(',').filter(Boolean);
    else if (a.startsWith('--seed=')) opts.seed = num(a, '--seed=');
    else if (a.startsWith('--budget=')) opts.budget = num(a, '--budget=');
    else if (a.startsWith('--groups=')) opts.groups = a.slice(9).split(',').filter(Boolean);
    else throw new Error(`nieznana opcja ${a}`);
  }
  return opts;
}

(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.list) {
    for (const [key, s] of Object.entries(SCENARIOS)) console.log(`${key.padEnd(34)} ${s.opis}`);
    return;
  }
  const refused = refuseReason();
  if (refused) {
    console.error(`Odmowa: ${refused}`);
    process.exit(2);
  }
  const unknown = opts.names.filter((n) => !SCENARIOS[n]);
  if (unknown.length) {
    console.error(`Nieznane scenariusze: ${unknown.join(', ')} (lista: --list)`);
    process.exit(2);
  }

  const result = await runCopyChecks({
    print: console.log,
    scenarios: opts.onlyGenerated ? false : (opts.names.length ? opts.names : true),
    cases: opts.generated,
    browsers: opts.browsers || undefined,
    seed: opts.seed ?? undefined,
    budgetMin: opts.budget || undefined,
    groups: opts.groups,
    repeat: opts.repeat ?? undefined,
    base: opts.base || undefined,
    slow: opts.slow,
    trap: opts.trap,
    keep: opts.keep,
    headed: opts.headed
  });
  if (result.skipped) {
    console.error(`Pominięto: ${result.skipped}`);
    process.exit(2);
  }

  const failed = result.cases.filter((c) => c.status === 'bledy' || c.status === 'blad');
  const done = result.cases.filter((c) => c.status !== 'pominiety');
  console.log(`\nWynik: ${done.length - failed.length}/${done.length} przypadków bez problemów`
    + ` (${result.stats.copyChecks} kopii/kontroli, ${result.stats.copyFieldsCompared} porównań pól)`);
  for (const c of failed) {
    const n = c.checks.reduce((s, k) => s + k.problems.length, 0);
    console.log(`  ✖ [${c.browser}] ${c.key}${c.sourceId ? ` (wzorzec #${c.sourceId})` : ''}: ${c.status === 'blad' ? c.reason : `${n} problem(ów)`}`);
  }
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('BŁĄD', err);
  process.exit(2);
});
