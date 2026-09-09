/**
 * Sprawdzenie, czy wdrożone skrypty cenowe dają się w ogóle sparsować.
 *
 * DLACZEGO TO OSOBNY TEST, a nie szczegół wyceny:
 *
 * `formTools/scriptLoader.js` ładuje skrypt jako `<script src=…>`. Gdy plik nie
 * przejdzie parsowania, odpala się `script.onerror` / globalny handler błędu, a
 * `errorShield()` zwraca `{ CENA: t('order.according_to_price') }` — czyli
 * **„według cennika"**. Skutek: cena nie powstaje, `getTotal()` nie ma z czego
 * policzyć sumy i pozycja zapisuje się bez wartości. Aplikacja nie krzyczy, bo
 * `errorShield` jest właśnie osłoną przed krzykiem.
 *
 * Zmierzone na grupie 76: `param-CENA-A.js` ma `SyntaxError` w linii 138243, a
 * `param-DOPLATA-A.js` w linii 613 — cennik ma dla tej konfiguracji cenę 175,
 * ekran pokazuje „według cennika", a zapisana pozycja #3773 z tej grupy wygląda
 * tak samo. Jeden `node --check` odpowiadałby na to od razu.
 *
 * Parsujemy przez `new vm.Script(...)` — plik NIE jest wykonywany, więc test
 * jest szybki i nie ma skutków ubocznych.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { dataDir } = require('../../config');
const { resolveScriptFile } = require('./deployedScript');
const { parseProdTxt, parseScriptEntries } = require('../formEngine/clientScripts');

/**
 * @param {string} filePath
 * @returns {{ok:true}|{ok:false, error:string, line:number|null}}
 */
function parseCheck(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `nie udało się odczytać pliku: ${err.message}`, line: null };
  }

  try {
    // Sam parse, bez uruchomienia. `filename` trafia do komunikatu błędu.
    new vm.Script(source, { filename: path.basename(filePath) });
    return { ok: true };
  } catch (err) {
    const match = /:(\d+)\b/.exec(err.stack ? err.stack.split('\n')[0] : '');
    return { ok: false, error: err.message, line: match ? Number(match[1]) : null };
  }
}

/**
 * Wszystkie skrypty cenowe grupy, z informacją, czy któryś klient faktycznie
 * ich używa.
 *
 * Rozróżnienie ma znaczenie dla priorytetu: zepsuty plik przypisany klientowi
 * psuje mu wycenę TERAZ; zepsuty plik, którego nikt nie używa, to długi
 * techniczny.
 */
function listGroupScripts(groupNumber, lang = 'pl') {
  const dir = path.join(dataDir, String(groupNumber), 'data');
  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => /^param-.+\.js$/.test(name));
  } catch (_err) {
    return { dir, files: [], mapped: new Set() };
  }

  // Które pliki są KOMUKOLWIEK przypisane w prod.txt.
  //
  // ⚠️ Nie przez `getClientScripts()` — ta funkcja filtruje po konkretnym
  // kliencie, więc zapytana o `null` nie zwraca nic i wszystkie zepsute pliki
  // wyglądały na nieużywane. Grupa 76 pokazała, że to fałsz: jej
  // `param-CENA-A.js` jest przypisany HKL/TESTOWY i właśnie dlatego symulacja
  // zobaczyła „według cennika". Czytamy więc CAŁY wiersz PARAM_SCRIPTS.
  const mapped = new Set();
  try {
    const prodPath = path.join(dataDir, String(groupNumber), 'data', lang, 'prod.txt');
    const prod = parseProdTxt(fs.readFileSync(prodPath, 'utf8'));
    for (const entry of parseScriptEntries((prod && prod.param_scripts) || '')) {
      if (entry && entry.file) mapped.add(entry.file);
    }
  } catch (_err) { /* brak prod.txt → zostaje pusty zbiór */ }

  return { dir, files, mapped };
}

/**
 * @param {string[]} groupNumbers
 * @returns {{findings:Array, checked:number, broken:number}}
 */
function checkGroupScripts(groupNumbers, { lang = 'pl' } = {}) {
  const assertions = require('./assertions');
  const findings = [];
  let checked = 0;
  let broken = 0;

  for (const groupNumber of groupNumbers) {
    const { dir, files, mapped } = listGroupScripts(groupNumber, lang);
    const brokenFiles = [];

    for (const file of files) {
      checked += 1;
      const verdict = parseCheck(path.join(dir, file));
      if (verdict.ok) continue;
      broken += 1;
      brokenFiles.push({ file, error: verdict.error, line: verdict.line, inUse: mapped.has(file) });
    }

    findings.push(...assertions.checkPriceScriptSyntax({ groupNumber, brokenFiles, checked: files.length }));
  }

  return { findings, checked, broken };
}

module.exports = { checkGroupScripts, parseCheck, listGroupScripts, resolveScriptFile };
