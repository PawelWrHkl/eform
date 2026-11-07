'use strict';

/**
 * Raffrollo (grupa 24): szycie i system jako osobne składniki specyfikacji
 * (szef, 2026-11-06: „żeby klient wiedział dokładnie, za co płaci”).
 *
 * Konfiguracje cennika RR: S = sam system (`SystemLuxan`, `SystemEP`,
 * `SystemVario`, `SystemVarioKL`), N = samo szycie (`SamoSzycie`), S_N = komplet
 * (`RRLKV…`) z WŁASNĄ tabelą, której wartość w cennikach A i B to dokładnie
 * szycie + system przy tych samych wymiarach (A, 100×150 cm: 98 + 124 = 222).
 * Komplet rozbijamy na dwie linie tylko wtedy, gdy potwierdza to skrypt, którym
 * liczono pozycję: kwota z `CENA_S` = komplet z tabeli = szycie + system.
 * W innym wypadku zostaje jedna linia „szycie + system”, bo nie zgadujemy
 * rozbicia. Tak jest np. w wariancie `Cmul1.1`, gdzie tabele się nie sumują,
 * albo dla pozycji ze starszej wersji cennika.
 */

const fs = require('fs');
const { parseScript, lookupEntry, literalNumber } = require('../pricelists/scriptModel');
const { scriptPathFor } = require('./scriptLabels');

const RR_GROUP = '24';
const SEWING = 'SamoSzycie';
// shortcut: para komplet → system wpisana ręcznie (kody cennika RR); nowy system w cenniku = dopisać tu, do tego czasu jedna linia „szycie + system”.
const SYSTEM_OF = { RRLKV_VS2: 'SystemLuxan', RRLKV2: 'SystemLuxan', RRLKVEP: 'SystemEP', RRLKVVario: 'SystemVario', RRLKVVarioKL: 'SystemVarioKL' };
const SYSTEMS = new Set(Object.values(SYSTEM_OF));

const modelCache = new Map(); // ścieżka → { mtimeMs, model }; skrypt RR ma ~0,7 MB, parsowanie ~0,1 s

function modelOf(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_e) { return null; }
  const hit = modelCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.model;
  let model;
  try { model = parseScript(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
  // Linia spoza gramatyki = z tego skryptu nie liczymy kwot (jak services/pricelists).
  if (model.unknown.length) model = null;
  if (modelCache.size >= 4) modelCache.delete(modelCache.keys().next().value);
  modelCache.set(file, { mtimeMs: stat.mtimeMs, model });
  return model;
}

/** Oś tabeli w postaci `SZEROKOSC/10` (tak emituje Worker.bas); inna postać = NaN, czyli bez rozbicia. */
function axisValue(axis, values) {
  const m = axis && typeof axis.formula === 'string' && /^([A-Za-z_][A-Za-z0-9_]*)\/(\d+(?:\.\d+)?)$/.exec(axis.formula);
  return m ? Number(values[m[1]]) / Number(m[2]) : NaN;
}

function tableValue(model, name, x, y) {
  const section = model.sections.filter((s) => s.name === name).pop();
  const entry = section ? lookupEntry(section, x, y) : null;
  return entry && !entry.unknown ? literalNumber(entry.value) : null;
}

/** Kwota składnika w `_S` przed czynnikiem: `392` z `(392(RRLKV_VS2))*1.05884`. */
function rawAmount(expression, code) {
  const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\(${code}\\)`).exec(String(expression || ''));
  return m ? Number(m[1]) : NaN;
}

function splitKit(item, values, scriptPath, expression) {
  const systemCode = SYSTEM_OF[item.code];
  const model = systemCode && scriptPath ? modelOf(scriptPath) : null;
  const kit = model ? model.sections.filter((s) => s.name === item.code).pop() : null;
  if (!kit) return null;
  const x = axisValue(kit.axisX, values);
  const y = axisValue(kit.axisY, values);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const total = tableValue(model, item.code, x, y);
  const sewing = tableValue(model, SEWING, x, y);
  const system = tableValue(model, systemCode, x, y);
  if (![total, sewing, system].every((n) => Number.isFinite(n) && n > 0)) return null;
  if (Math.abs(rawAmount(expression, item.code) - total) > 0.005 || Math.abs(sewing + system - total) > 0.005) return null;
  // `item.amount` ma już czynnik `_S` (np. `*1.05884`) — dzielimy go w proporcji tabeli.
  return [
    { code: SEWING, amount: (item.amount * sewing) / total, rr: 'rr_sewing' },
    { code: systemCode, amount: (item.amount * system) / total, rr: 'rr_system' }
  ];
}

/**
 * Składniki ceny bazowej (`CENA_S` / `SUB___CENA_S`) pozycji RR z kluczem
 * etykiety `rr` (i18n). Inne grupy: bez zmian.
 *
 * @param {Array<{code: string, amount: number}>} items
 * @param {object} ctx  `{ groupNumber, values, paramName, scriptFile, dataDir }`; `values[paramName + '_S']` = wyrażenie
 */
function raffrolloItems(items, { groupNumber, values, paramName, scriptFile, dataDir }) {
  if (String(groupNumber) !== RR_GROUP) return items;
  let scriptPath;
  return items.flatMap((item) => {
    if (item.code === SEWING) return [{ ...item, rr: 'rr_sewing' }];
    if (SYSTEMS.has(item.code)) return [{ ...item, rr: 'rr_system' }];
    if (!/^RRLKV/.test(item.code)) return [item];
    if (scriptPath === undefined) scriptPath = scriptPathFor(groupNumber, paramName, { scriptFile, dataDir });
    return splitKit(item, values || {}, scriptPath, (values || {})[`${paramName}_S`]) || [{ ...item, rr: 'rr_sewing_system' }];
  });
}

module.exports = { raffrolloItems };
