'use strict';

/**
 * Czytelne nazwy składników specyfikacji ceny.
 *
 * Kody w `<PARAM>_S` (`TruFit`, `M17`, `U25PG4`, …) to nazwy zmiennych ze
 * skryptu cennika — dla klienta nic nie znaczą. Każdy składnik ma jednak
 * w skrypcie swój warunek, np.
 *
 *   var TruFit=0; … if(evaluateFormula('WSROD(MONTAZ,"TF1858")',obj))n=n+1; …
 *   if(TruFit!=0){ … DOPLATA_S+=""+TruFit+"(TruFit)"; }
 *
 * czyli wiadomo, KTÓRA wybrana opcja go wywołała. Nazwa składnika = opis tej
 * opcji z pozycji („INSTALLATIETYPE: TF1858 – TRUFIT ZWART") — w języku pozycji,
 * dokładnie tak, jak klient widzi ją w zleceniu.
 *
 * ⚠️ Warunki zbieramy ze WSZYSTKICH wariantów skryptu parametru
 * (`param-DOPLATA-A.js`, `-Cmul1.1.js`, …): wariant konkretnego klienta zależy
 * od `prod.txt` i nakładki z bazy, a warianty bywają różne (w jednym
 * `WSROD(MONTAZ,"TF")`, w innym lista konkretnych modeli). Do nazwy trafiają
 * WYŁĄCZNIE warunki spełnione przez wartości pozycji, więc nadmiarowe warunki
 * z innych wariantów niczego nie psują.
 *
 * Ocena warunku wiernie odwzorowuje public/scripts/formula.js: `WSROD` =
 * dokładne dopasowanie `,wartość,` w `,lista,` (bez wielkości liter),
 * `ZAWIERA` = zawieranie tekstu.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../config');

/** Wywołanie warunku w formule skryptu: `WSROD(PARAM,"A,B")`, `ZAWIERA(PARAM,"X")`. */
const CONDITION_RE = /\b(WSROD|ZAWIERA)\(\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*"([^"]*)"\s*\)/g;
/** Linia warunku składnika — tylko ona dolicza `n`, linie z `x=`/`y=` to wymiary. */
const CONDITION_LINE_RE = /if\(evaluateFormula\('((?:[^'\\]|\\.)*)'\s*,\s*obj\)\)\s*n\s*=\s*n\s*\+\s*1/g;
/** Dopisanie składnika do `_S`: `DOPLATA_S+=""+KOD+"(KOD)"`. */
const PUSH_RE = /""\s*\+\s*([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*"\(([A-Za-z0-9_]+)\)"/g;

const scriptCache = new Map(); // ścieżka → { mtimeMs, codes: Map<kod, warunki[]> }

/**
 * @param {string} text  treść skryptu cennika
 * @returns {Map<string, Array<{fn: string, param: string, arg: string}>>}
 */
function extractCodeConditions(text) {
  const codes = new Map();
  PUSH_RE.lastIndex = 0;
  let m;
  while ((m = PUSH_RE.exec(text))) {
    const [, variable, code] = m;
    // Początek bloku składnika: ostatnie `var KOD=0;` przed dopisaniem
    // (skrypty są generowane, zapis jest zawsze bez spacji — wariant ze spacją
    // na wszelki wypadek).
    const start = Math.max(
      text.lastIndexOf(`var ${variable}=`, m.index),
      text.lastIndexOf(`var ${variable} =`, m.index)
    );
    if (start < 0) continue;
    const block = text.slice(start, m.index);
    const found = codes.get(code) || [];
    CONDITION_LINE_RE.lastIndex = 0;
    let line;
    while ((line = CONDITION_LINE_RE.exec(block))) {
      const formula = line[1].replace(/\\'/g, "'");
      CONDITION_RE.lastIndex = 0;
      let c;
      while ((c = CONDITION_RE.exec(formula))) {
        const cond = { fn: c[1], param: c[2], arg: c[3] };
        if (!found.some((f) => f.fn === cond.fn && f.param === cond.param && f.arg === cond.arg)) found.push(cond);
      }
    }
    codes.set(code, found);
  }
  return codes;
}

function readScriptConditions(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_e) { return null; }
  const cached = scriptCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.codes;
  let codes;
  try { codes = extractCodeConditions(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
  scriptCache.set(file, { mtimeMs: stat.mtimeMs, codes });
  return codes;
}

/**
 * Warunki składników parametru — ze skryptu, którym liczono cenę klienta.
 *
 * ⚠️ NIE ze wszystkich wariantów: jedna grupa ma ich dziesiątki (grupa 39:
 * 56 plików, 125 MB na udziale sieciowym — czytanie wszystkich to kilkanaście
 * sekund). Bierzemy skrypt klienta (`scriptFile`, z `prod.txt` + nakładki z
 * bazy — patrz `index.js resolveClientScriptFiles`), a gdy go nie ma — jeden,
 * pierwszy alfabetycznie wariant. Warianty różnią się głównie kwotami; gdyby
 * różniły się warunkiem, nazwa po prostu się nie dopasuje i zostanie kod.
 * Z pliku w pamięci zostają same warunki (kilka kB), z kontrolą `mtime`.
 *
 * @param {string|number} groupNumber
 * @param {string} paramName   np. `DOPLATA`, `SUB___CENA`
 * @param {object} [opts]
 * @param {string} [opts.scriptFile]  nazwa pliku skryptu klienta (`param-CENA-Cmul1.1.js`)
 * @param {string} [opts.dataDir]
 * @returns {Map<string, Array<{fn, param, arg}>>}
 */
function conditionsForParam(groupNumber, paramName, opts = {}) {
  const root = opts.dataDir || dataDir;
  const dir = path.join(root, String(groupNumber), 'data');
  if (opts.scriptFile) {
    const codes = readScriptConditions(path.join(dir, path.basename(opts.scriptFile)));
    if (codes) return codes;
  }
  let files;
  try { files = fs.readdirSync(dir); } catch (_e) { return new Map(); }
  const prefix = `param-${paramName}-`;
  const first = files.filter((f) => f.endsWith('.js') && (f.startsWith(prefix) || f === `param-${paramName}.js`)).sort()[0];
  return (first && readScriptConditions(path.join(dir, first))) || new Map();
}

/** Tak jak public/scripts/formula.js. */
function conditionHolds(cond, values) {
  const raw = values ? values[cond.param] : undefined;
  if (raw === undefined || raw === null || raw === '') return false;
  const value = String(raw).toLowerCase();
  const arg = String(cond.arg).toLowerCase();
  if (cond.fn === 'WSROD') return `,${arg},`.includes(`,${value},`);
  if (cond.fn === 'ZAWIERA') return arg !== '' && value.includes(arg);
  return false;
}

/** `KOLOR___DESCRIPTION`, `KOLOR_ALIAS___DESCRIPTION` → `KOLOR`. */
function baseParam(param) {
  return param.replace(/(_ALIAS)?___DESCRIPTION$/, '');
}

const CURRENCY_TAG_RE = /\s*\[[^\]]*\]\s*/g;

function cleanTitle(text) {
  return String(text || '').replace(CURRENCY_TAG_RE, ' ').replace(/\s+/g, ' ').replace(/[\s:]+$/, '').trim();
}

/** „TF1858 – TRUFIT ZWART" z wiersza opisu pozycji. */
function optionText(row) {
  if (!row) return '';
  const value = String(row.option_value ?? '').trim();
  const description = String(row.option_description ?? '').trim();
  if (value && description && description !== value) return `${value} – ${description}`;
  return value || description;
}

/**
 * @param {string} code
 * @param {object} ctx
 * @param {Map} ctx.conditions  wynik `conditionsForParam`
 * @param {object} ctx.values   `json_parameters` pozycji
 * @param {Map} ctx.descRows    `json_parameters_desc` pozycji (klucz → wiersz)
 * @returns {string|null} np. „INSTALLATIETYPE: TF1858 – TRUFIT ZWART"; `null`,
 *   gdy żaden warunek nie wskazuje wybranej opcji.
 */
function labelForCode(code, ctx) {
  const parts = [];
  const seen = new Set();
  const push = (param) => {
    const base = baseParam(param);
    if (seen.has(base)) return;
    const row = ctx.descRows.get(base);
    const text = optionText(row);
    if (!row || !text) return;
    seen.add(base);
    parts.push(`${cleanTitle(row.param_description) || base}: ${text}`);
  };

  for (const cond of ctx.conditions.get(code) || []) {
    if (conditionHolds(cond, ctx.values)) push(cond.param);
  }
  // Kod równy wybranej opcji (np. `BO20` przy `MODEL=BO20`), gdy skrypt
  // nie ma czytelnego warunku.
  if (!parts.length) {
    const wanted = code.toLowerCase();
    for (const [param, raw] of Object.entries(ctx.values || {})) {
      if (/___|_ALIAS$|_S$/.test(param) || typeof raw !== 'string') continue;
      if (raw.split(/[,;]/).some((v) => v.trim().toLowerCase() === wanted)) push(param);
    }
  }
  return parts.length ? parts.slice(0, 2).join(' · ') : null;
}

function clearCache() {
  scriptCache.clear();
}

module.exports = {
  extractCodeConditions,
  conditionsForParam,
  conditionHolds,
  labelForCode,
  cleanTitle,
  optionText,
  clearCache
};
