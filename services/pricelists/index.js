'use strict';

/**
 * Cennik klienta liczony z WDROŻONYCH skryptów cenowych — dokładnie te kwoty,
 * które konfigurator policzy temu klientowi dziś.
 *
 * Każda komórka to pełny przebieg skryptu (interpreter `runModel`, dowiedziony
 * jako równoważny prawdziwemu skryptowi) dla konkretnej konfiguracji: model,
 * grupa cenowa tkaniny, wymiar. Nie zakładamy, że działa jedna sekcja: w grupie
 * 02 model LR50 dolicza przez błąd w arkuszu sekcję PG0 i konfigurator liczy
 * 521 zamiast 272 — cennik ma pokazać 521, a raport wskazać przyczynę.
 *
 * Warunki sekcji zależą tylko od opcji, więc liczymy je raz na (model, grupa)
 * i zapamiętujemy; wymiary wchodzą wyłącznie przez osie.
 */

const fs = require('fs');
const path = require('path');

const { dataDir } = require('../../config');
const { selectQuery } = require('../../db/core');
const { resolveGroupTerms } = require('../orgCustomers/groupTerms');
const { parseTabFile } = require('../formEngine/clientScripts');
const { createRealm } = require('../formEngine/scriptRunner');
const { hashUser } = require('../../utils/hashUser');
const sm = require('./scriptModel');
const { familyOf, clausesOf, satisfyingValue, parseCall } = require('./conditions');

const VERSION_COLUMN = { dev: 'version_dev', archive: 'version_archive', test: 'version_string', prod: 'version_string' };

/** Aktywna wersja formularza grupy — ta sama kolumna co `getAppVersion`, ale bez zapisów. */
async function activeVersion(groupNumber) {
  const column = VERSION_COLUMN[process.env.NODE_ENV] || 'version_string';
  const rows = await selectQuery(`SELECT ${column} AS v FROM app_version WHERE asort_group = ? LIMIT 1`, [String(groupNumber)]);
  return rows && rows[0] ? rows[0].v : null;
}

const NULL = '<NULL>';
const present = (v) => v !== undefined && v !== null && v !== '' && v !== NULL;

// ---------------------------------------------------------------------------
// Pliki grupy (param.txt, paramdict.txt) i modele skryptów — z cache po mtime.

const fileCache = new Map();

function cachedRead(filePath, parse) {
  const stat = fs.statSync(filePath);
  const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
  const hit = fileCache.get(filePath);
  if (hit && hit.key === key) return hit.value;
  const value = parse(fs.readFileSync(filePath, 'utf8'));
  fileCache.set(filePath, { key, value });
  return value;
}

/** param.txt → `{ NAZWA: wiersz }`. */
function readParams(groupNumber, version, lang) {
  const file = path.join(dataDir, String(groupNumber), 'data', 'versions', version, lang, 'param.txt');
  return cachedRead(file, (text) => Object.fromEntries(parseTabFile(text).filter((r) => present(r.NAME)).map((r) => [r.NAME, r])));
}

/** paramdict.txt → `{ PARAM: [{ VALUE, DESCRIPTION, ENABLE, PROC }] }` w kolejności pliku. */
function readOptions(groupNumber, version, lang) {
  const file = path.join(dataDir, String(groupNumber), 'data', 'versions', version, lang, 'paramdict.txt');
  return cachedRead(file, (text) => {
    const rows = parseTabFile(text);
    const params = rows.length ? Object.keys(rows[0]).filter((k) => k.endsWith('_VALUE')).map((k) => k.slice(0, -6)) : [];
    const out = {};
    for (const param of params) {
      out[param] = rows
        .filter((r) => present(r[`${param}_VALUE`]))
        .map((r) => ({
          VALUE: r[`${param}_VALUE`],
          DESCRIPTION: present(r[`${param}_DESCRIPTION`]) ? r[`${param}_DESCRIPTION`] : '',
          ENABLE: present(r[`${param}_ENABLE`]) ? r[`${param}_ENABLE`] : '',
          PROC: present(r[`${param}_PROC`]) ? r[`${param}_PROC`] : ''
        }));
    }
    return out;
  });
}

// Sparsowany 5-megabajtowy skrypt to dziesiątki MB obiektów — mała pamięć, żeby nie wypchnąć serwera z RAM.
const MAX_MODELS = 6;
const modelCache = new Map();

/** Model skryptu (parsowanie ~0,5 s dla 5 MB) — LRU po ścieżce, mtime i rozmiarze. */
function loadModel(groupNumber, file) {
  const filePath = path.join(dataDir, String(groupNumber), 'data', file);
  if (!fs.existsSync(filePath)) return { missing: true, file };
  const stat = fs.statSync(filePath);
  const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
  if (modelCache.has(key)) {
    const model = modelCache.get(key);
    modelCache.delete(key);
    modelCache.set(key, model);
    return model;
  }
  const model = sm.parseScript(fs.readFileSync(filePath, 'utf8'));
  model.file = file;
  model.mtimeMs = stat.mtimeMs;
  if (modelCache.size >= MAX_MODELS) modelCache.delete(modelCache.keys().next().value);
  modelCache.set(key, model);
  return model;
}

// ---------------------------------------------------------------------------
// Formuły: jeden realm konfiguratora na proces, z pamięcią wyników per kontekst.

let sharedRealm = null;
const realm = () => (sharedRealm = sharedRealm || createRealm());

const truthy = (value) => !!value;

/**
 * `evaluate` z pamięcią: wynik zależy od formuły i wartości, których ona używa.
 * Tekst formuły (bywa na setki znaków) jest kluczem raz, wartości — osobno.
 */
function memoEvaluate() {
  const memo = new Map();
  return (formula, obj) => {
    let byValues = memo.get(formula);
    if (!byValues) memo.set(formula, (byValues = new Map()));
    const key = identifiers(formula).map((id) => (obj[id] === undefined ? '\u0002' : String(obj[id]))).join('\u0001');
    if (!byValues.has(key)) byValues.set(key, realm().evaluate(formula, obj));
    return byValues.get(key);
  };
}

/** Zwalnia pamięć podręczną plików i modeli (np. między grupami w długim przebiegu). */
function clearCaches() {
  fileCache.clear();
  modelCache.clear();
}

const IDENT_CACHE = new Map();
const NOT_IDENT = new Set(['AND', 'OR', 'NOT', 'IF', 'WSROD', 'NIEWSROD', 'ZAWIERA', 'ROUND', 'TRUE', 'FALSE', 'ORAZ', 'ISNUMBER', 'MIN', 'MAX', 'CEILING', 'FLOOR', 'ZAOKR', 'LEFT', 'RIGHT', 'ABS', 'INT', 'HASLO', 'USTAW']);
function identifiers(formula) {
  if (IDENT_CACHE.has(formula)) return IDENT_CACHE.get(formula);
  const ids = [...new Set([...String(formula).replace(/"[^"]*"/g, '').matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)]
    .map((m) => m[1].toUpperCase())
    .filter((n) => !NOT_IDENT.has(n)))];
  IDENT_CACHE.set(formula, ids);
  return ids;
}

/** Opcje parametru spełniające klauzulę — liczone evaluatorem konfiguratora. */
function optionsMatching(clause, options, evaluate) {
  return options.filter((o) => truthy(evaluate(clause.text, { [clause.param]: o.VALUE })));
}

// ---------------------------------------------------------------------------
// Limity wymiarów z procedur opcji (USTAW … MIN/MAX), jak getProcedures.

/** Twardy zakres pola z walidatorów opcji: MIN2/MAX2, a bez nich MIN/MAX (validateFormInput). */
function hardRange(validators, field) {
  const rules = validators[field];
  if (!rules) return null;
  const strict = rules.MIN2 !== undefined || rules.MAX2 !== undefined;
  const min = Number(strict ? rules.MIN2 : rules.MIN);
  const max = Number(strict ? rules.MAX2 : rules.MAX);
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : Infinity };
}

/**
 * Walidatory opcji przy danej szerokości — z pamięcią, bo procedura bywa zależna
 * od szerokości (`USTAW("WYSOKOSC","MAX",IF(SZEROKOSC<=1200,2200,1500))`).
 */
function validatorsAt(memo, option, procParam, xField, x, subforms = {}) {
  const key = `${procParam}|${option.VALUE}|${xField}|${x}`;
  if (!memo.has(key)) {
    let validators = {};
    if (option.PROC) {
      validators = realm().procedure(option.PROC, { [procParam]: option.VALUE, [xField]: x }, procParam, option.VALUE);
      // Model wymusza typ podformularza (`USTAW("WYMIAROWANIE_SLOPOW.TYP","WAR","TYP8")`) — jego limity WYM_*.
      for (const [field, value] of Object.entries({ ...realm().sandbox.constValues })) {
        const [name, typeField] = field.split('.');
        if (typeField && subforms[name]) Object.assign(validators, subformValidators(subforms[name], typeField, value, { [xField]: x }));
      }
    }
    memo.set(key, validators);
  }
  return memo.get(key);
}

/**
 * Walidatory podformularza dla wymuszonego typu, jak `runSlopeProcedures`.
 * Pola spoza `dims` dostają swoje minimum (2 przebiegi), żeby limity wzajemne
 * (`WYM_H1` ≥ `WYM_H2` ≥ 300) liczyły się przy najluźniejszym wypełnieniu.
 */
function subformValidators(subform, typeField, typeValue, dims) {
  const option = (subform.options[typeField] || []).find((o) => o.VALUE === typeValue);
  if (!option || !option.PROC) return {};
  const free = Object.keys(subform.params).filter((f) => f !== typeField && !(f in dims));
  let values = { ...Object.fromEntries(free.map((f) => [f, 0])), ...dims, [typeField]: typeValue };
  let validators = {};
  for (let pass = 0; pass < 3; pass++) {
    validators = realm().procedure(option.PROC, values, typeField, typeValue);
    values = { ...values, ...Object.fromEntries(free.filter((f) => validators[f] && Number.isFinite(validators[f].MIN)).map((f) => [f, validators[f].MIN])) };
  }
  return validators;
}

/**
 * Czy opcja przyjmie jakikolwiek wymiar z komórki: x ∈ (x0, x1], y ∈ (y0, y1] w mm.
 * Procedurę sprawdzamy przy obu brzegach szerokości (max wysokości bywa warunkowy),
 * POW — jego własną formułą z param.txt, tylko gdy grupa ma taki parametr.
 */
function acceptsCell({ memo, option, procParam, xField, yField, cell, powFormula, subforms }) {
  // Bez osi (73: KARNISZ przy KAR) nie ma wymiaru do odrzucenia.
  if (!option.PROC || (!xField && !yField)) return true;
  if (!xField) {
    // Tabela tylko po wysokości: jej zakres nie zależy od szerokości.
    const ry = hardRange(validatorsAt(memo, option, procParam, yField, cell.y1, subforms), yField) || { min: 0, max: Infinity };
    return Math.max(cell.y0 + 1, ry.min) <= Math.min(cell.y1, ry.max);
  }
  for (const x of yField ? [cell.x0 + 1, cell.x1] : [cell.x1]) {
    const validators = validatorsAt(memo, option, procParam, xField, x, subforms);
    const rx = hardRange(validators, xField) || { min: 0, max: Infinity };
    const xLo = Math.max(cell.x0 + 1, rx.min);
    const xHi = Math.min(cell.x1, rx.max);
    if (xLo > xHi) continue;
    if (!yField) return true;
    const ry = hardRange(validators, yField) || { min: 0, max: Infinity };
    const yLo = Math.max(cell.y0 + 1, ry.min);
    const yHi = Math.min(cell.y1, ry.max);
    if (yLo > yHi) continue;
    const pow = hardRange(validators, 'POW');
    if (pow && powFormula && Number.isFinite(pow.max)) {
      const area = Number(realm().evaluate(powFormula, { [xField]: xLo, [yField]: yLo }));
      if (Number.isFinite(area) && area > pow.max) continue;
    }
    return true;
  }
  return false;
}

/**
 * `inList` z public/scripts/formula.js 1:1 (małe litery, przecinki dookoła, bez
 * przycinania spacji) — do szybkiego odrzucenia warunku `AND(WSROD(MODEL,…),…)`
 * bez wołania evaluatora. Tylko dla klauzul na najwyższym poziomie AND.
 */
function quickFalse(clauses, ctx) {
  for (const c of clauses) {
    if (c.kind !== 'filter' || c.fn !== 'WSROD' || !(c.param in ctx)) continue;
    const hit = `,${String(c.list).toLowerCase()},`.includes(`,${String(ctx[c.param] || '').toLowerCase()},`);
    if (hit === c.negated) return true;
  }
  return false;
}

/** Czy wartość wpisu może dać NaN mimo n=0 (tekst, wzór) — wtedy liczymy sekcję zawsze. */
function sectionIsRisky(section) {
  const v = section.value;
  const values = v.kind === 'none' ? [] : v.kind === 'const' ? [v.value] : v.kind === 'xy' ? v.columns.flatMap((c) => c.rows.map((r) => r.value)) : v.entries.map((e) => e.value);
  const refs = v.kind === 'xy' ? v.columns.some((c) => c.rows.some((r) => r.bound && r.bound.ref)) : (v.entries || []).some((e) => e.bound && e.bound.ref);
  return refs || values.some((x) => x.formula || ('str' in x && !(Number(x.str) === Number(x.str))));
}

/**
 * Parametry-formuły z param.txt liczone wyłącznie z wymiarów (np. POW =
 * SZEROKOSC*WYSOKOSC/1000000) — konfigurator ma je w `values`, zanim uruchomi
 * skrypt ceny, więc warunek sekcji może z nich korzystać. Zaokrąglenie jak
 * `calculateFromFormula`: wynik ujemny/false → 0, inaczej toFixed(2).
 */
function derivedDims(params, dims) {
  const fields = Object.keys(dims);
  const out = {};
  for (const [name, p] of Object.entries(params)) {
    if (!present(p.FORMULA) || fields.includes(name)) continue;
    const ids = identifiers(p.FORMULA);
    if (!ids.length || !ids.every((id) => fields.includes(id))) continue;
    const result = realm().evaluate(p.FORMULA, dims);
    out[name] = result === false || result === null || result < 0 ? 0 : parseFloat(parseFloat(result).toFixed(2));
  }
  return out;
}

/**
 * Szybki odpowiednik `runModel` dla stałych opcji i zmiennych wymiarów: liczba
 * trafień `n` sekcji liczona raz na konfigurację, a per komórka tylko dla sekcji,
 * których warunek zależy od wymiaru (np. `SZEROKOSC<=1300`). Osie i `x`/`y`
 * przechodzą między sekcjami jak w skrypcie; sekcja z `n=0` daje 0, chyba że
 * jest „ryzykowna” (tekst, wzór, próg-zmienna — `NaN*0` to NaN) — wtedy liczona.
 */
function cellRunner(model, ctx, evaluate, increase, { params = {}, dimFields = [] } = {}) {
  if (!model.meta) {
    model.meta = {
      clauses: model.sections.map((s) => s.conditions.map((c) => (c.formula ? clausesOf(c.formula) : []))),
      risky: model.sections.map(sectionIsRisky),
      declared: new Set(model.sections.map((s) => s.name))
    };
  }
  const meta = model.meta;
  const derivedNames = new Set(Object.entries(params).filter(([, p]) => present(p.FORMULA)).map(([name]) => name));
  const dependsOnDims = model.sections.map((s) => s.conditions.some((c) => c.formula && identifiers(c.formula).some((id) => dimFields.includes(id) || derivedNames.has(id))));
  const nOf = (i, obj) => model.sections[i].conditions.reduce((acc, c, k) => {
    if (!c.formula) return acc + (sm.literalNumber(c) ? 1 : 0);
    if (quickFalse(meta.clauses[i][k], obj)) return acc;
    return acc + (truthy(evaluate(c.formula, obj)) ? 1 : 0);
  }, model.sections[i].nInit);
  const n = model.sections.map((s, i) => (dependsOnDims[i] ? null : nOf(i, ctx)));

  const derivedMemo = new Map();
  const derivedFor = (dims) => {
    const key = JSON.stringify(dims);
    if (!derivedMemo.has(key)) derivedMemo.set(key, derivedDims(params, dims));
    return derivedMemo.get(key);
  };
  const run = (dims) => {
    // Prototyp zamiast kopii ~1000 kluczy pustego formularza na każdą komórkę (for…in w formula.js widzi oba).
    const obj = Object.assign(Object.create(ctx), dims, derivedFor(dims));
    const scope = Object.create(null);
    let x = null;
    let y = null;
    const resolveRef = (name) => {
      if (name === 'x') return { value: x };
      if (name === 'y') return { value: y };
      if (name in scope) return { value: scope[name] };
      if (meta.declared.has(name)) return { value: undefined };
      return { unknown: name };
    };
    const axis = (a) => {
      const field = simpleAxis(a);
      if (field && typeof obj[field] === 'number') return obj[field] / 10;
      return a.formula ? evaluate(a.formula, obj) : 'num' in a ? a.num : a.str;
    };
    for (let i = 0; i < model.sections.length; i++) {
      const s = model.sections[i];
      const count = n[i] === null ? nOf(i, obj) : n[i];
      if (s.axisX) x = axis(s.axisX);
      if (s.axisY) y = axis(s.axisY);
      if (!count && !meta.risky[i]) {
        scope[s.name] = 0;
        continue;
      }
      const entry = sm.lookupEntry(s, x, y, resolveRef);
      if (entry && entry.unknown) return { error: `próg zależny od zmiennej ${entry.unknown}` };
      let v = 0;
      if (entry) v = entry.value.formula ? evaluate(entry.value.formula, obj) : 'num' in entry.value ? entry.value.num : entry.value.str;
      scope[s.name] = v * count;
    }
    let total;
    model.sum.forEach((name, k) => {
      total = k === 0 ? scope[name] : total + scope[name];
    });
    return { amount: sm.finalAmount(model, total, increase), sections: scope, obj };
  };
  return { n: n.map((v, i) => (v === null ? `d${i}` : v)), run };
}

// ---------------------------------------------------------------------------
// Tabele cen (sekcje z osiami wymiarów).

/** Oś `PARAM/10` → nazwa pola. */
function simpleAxis(axis) {
  if (!axis || !axis.formula) return null;
  const m = /^([A-Z0-9_]+)\/10$/.exec(axis.formula.trim());
  return m ? m[1] : null;
}

/**
 * Pole wymiaru osi tabeli:
 * - `PARAM/10` → `{ field, scale: 10 }`;
 * - `PARAM` z opcjami-liczbami (46: TORY 2–5) → `{ field, scale: 1, count }` — wiersze to opcje;
 * - stała (`""` w gr. 80) → `{ literal }` — skrypt bierze zawsze pierwszy próg;
 * - wzór: wybory ustalone przez warunki sekcji (`choiceCtx`) podstawione, a pole
 *   wyszukane próbkowaniem (46: `IF(KONFIGURACJA="N",SZER_PANELU,…)/10` przy N → SZER_PANELU).
 *   Jeden wybór wolny (14: WYS_RODZ) → tabela dla wariantu, w którym oś to samo pole
 *   (PASEK), pozostałe jako przesunięcie do przypisu (VERTI: +38 mm).
 * Inne wzory → null (sekcja nie jest tabelą).
 */
function resolveAxis(axis, options, choiceCtx = {}) {
  if (!axis) return null;
  const simple = simpleAxis(axis);
  if (simple) return { field: simple, scale: 10, fixed: {}, variants: [] };
  if (!axis.formula) return { literal: true, fixed: {}, variants: [] };
  const ids = identifiers(axis.formula);
  const formula = axis.formula.trim();
  if (ids.length === 1 && formula.toUpperCase() === ids[0] && (options[ids[0]] || []).length && options[ids[0]].every((o) => Number.isFinite(Number(o.VALUE)))) {
    return { field: ids[0], scale: 1, count: true, fixed: {}, variants: [] };
  }
  const choices = ids.filter((id) => (options[id] || []).length);
  const fields = ids.filter((id) => !choices.includes(id));
  const fixed = Object.fromEntries(choices.filter((c) => choiceCtx[c] !== undefined).map((c) => [c, choiceCtx[c]]));
  const free = choices.filter((c) => !(c in fixed));
  if (!fields.length || free.length > 1) return null;

  // Pole F, dla którego oś·10 = F − przesunięcie, niezależnie od pozostałych pól.
  const solve = (ctx) => {
    const at = (vals) => Number(realm().evaluate(axis.formula, { ...ctx, ...vals })) * 10;
    const probe = Object.fromEntries(fields.map((f, i) => [f, 1000 + 37 * i]));
    for (const f of fields) {
      const shift = probe[f] - at(probe);
      const others = Object.fromEntries(fields.filter((g) => g !== f).map((g) => [g, probe[g] + 11]));
      const ok = [1500, 2600].every((mm) => Math.abs(at({ ...probe, [f]: mm }) - (mm - shift)) < 1e-9) &&
        Math.abs(at({ ...probe, ...others }) - at(probe)) < 1e-9;
      if (ok) return { field: f, shiftMm: Math.round(shift * 1000) / 1000 };
    }
    return null;
  };
  if (!free.length) {
    const v = solve(fixed);
    return v && v.shiftMm === 0 ? { field: v.field, scale: 10, fixed: {}, variants: [] } : null;
  }
  const [choice] = free;
  const variants = [];
  for (const o of options[choice]) {
    const v = solve({ ...fixed, [choice]: o.VALUE });
    if (!v) return null;
    variants.push({ param: choice, value: o.VALUE, description: o.DESCRIPTION, field: v.field, shiftMm: v.shiftMm });
  }
  const identity = variants.find((v) => v.shiftMm === 0);
  if (!identity || variants.some((v) => v.field !== identity.field)) return null;
  // Wybór, który osi nie zmienia (46: ILOSC_PANELI przy N), niczego nie ustala ani nie trafia do przypisu.
  if (variants.every((v) => v.shiftMm === 0)) return { field: identity.field, scale: 10, fixed: {}, variants: [] };
  return { field: identity.field, scale: 10, fixed: { [choice]: identity.value }, base: identity, variants: variants.filter((v) => v.shiftMm !== 0) };
}

function isTableSection(section, axisOf) {
  const kind = section.value.kind;
  if (!['xy', 'x', 'y'].includes(kind)) return false;
  const x = kind === 'x' || kind === 'xy' ? axisOf(section.axisX, section) : null;
  const y = kind === 'y' || kind === 'xy' ? axisOf(section.axisY, section) : null;
  if ((kind !== 'y' && !x) || (kind !== 'x' && !y)) return false;
  // Stała oś ma sens tylko obok osi-pola (tabela po samej wysokości).
  return !!((x && x.field) || (y && y.field));
}

/** Wartość, którą konfigurator wstawia za wyłączony parametr (`neutralValueFor`): liczony → 0, wpisywany → ''. */
function neutralValue(param) {
  return param && (present(param.FORMULA) || present(param.SCRIPTS)) ? 0 : '';
}

/** Progi osi zebrane z tabel wszystkich sekcji rodziny (rosnąco, tylko liczby). */
function axisBounds(sections, axis) {
  const bounds = new Set();
  for (const s of sections) {
    const v = s.value;
    if (axis === 'x' && v.kind === 'x') v.entries.forEach((e) => typeof e.bound === 'number' && bounds.add(e.bound));
    if (axis === 'y' && v.kind === 'y') v.entries.forEach((e) => typeof e.bound === 'number' && bounds.add(e.bound));
    if (v.kind === 'xy') {
      if (axis === 'x') v.columns.forEach((c) => typeof c.bound === 'number' && bounds.add(c.bound));
      else v.columns.forEach((c) => c.rows.forEach((r) => typeof r.bound === 'number' && bounds.add(r.bound)));
    }
  }
  return [...bounds].sort((a, b) => a - b);
}

/** Wartość „pusta” dla parametrów, których klient nie wybrał (jak puste pole w formularzu). */
function baseContext(uid, params) {
  // Pusty formularz jak `generateForm` w form.js: parametr = DEFAULT albo '', opisy i aliasy ''.
  // Brak zmiennej to dla parsera błąd (`NOT(WSROD(X,…))` → fałsz), a '' — zwykła wartość.
  const ctx = {};
  for (const [name, p] of Object.entries(params)) {
    ctx[name] = present(p.DEFAULT) ? p.DEFAULT : '';
    ctx[`${name}___DESCRIPTION`] = '';
    ctx[`${name}_ALIAS`] = '';
    ctx[`${name}_ALIAS___DESCRIPTION`] = '';
  }
  ctx.uid = uid;
  return ctx;
}

/**
 * Dopisuje do `ctx` wybory, bez których ENABLE jest fałszywe: dla klauzul
 * WSROD/NIEWSROD najwyższego poziomu (i pierwszej pasującej gałęzi `OR(…)`) na
 * parametrach jeszcze pustych bierze pierwszą opcję spełniającą klauzulę i swój
 * ENABLE (73: KOLOR wymaga STOFF=K, TYP_ZAS — KONFIGURACJA CFO/COM, oś WAVE —
 * FALA W60). Parametrów już wybranych nie zmienia. Zwraca dopisane.
 */
function completeEnable(formula, ctx, options, evaluate) {
  const added = {};
  if (!present(formula) || truthy(evaluate(formula, ctx))) return added;
  const pick = (clause) => {
    if (clause.kind !== 'filter' || ctx[clause.param] !== '' || truthy(evaluate(clause.text, ctx))) return false;
    const matching = optionsMatching(clause, options[clause.param] || [], evaluate)
      .filter((o) => !present(o.ENABLE) || truthy(evaluate(o.ENABLE, ctx)));
    if (!matching.length) return false;
    ctx[clause.param] = added[clause.param] = matching[0].VALUE;
    return true;
  };
  for (const clause of clausesOf(String(formula).replace(/^=/, ''))) {
    const call = clause.kind === 'raw' ? parseCall(clause.text) : null;
    if (call && call.name === 'OR') {
      if (!truthy(evaluate(clause.text, ctx))) call.args.some((arg) => clausesOf(arg).some(pick));
    } else {
      pick(clause);
    }
  }
  return added;
}

/**
 * Kontekst konfiguracji dla rodziny: model, grupa tkaniny, pozostałe filtry
 * (pierwsza opcja, która je spełnia) i druga tkanina, gdy model ją włącza.
 * `familyOverrides` — tylko to, co różni się od pustego formularza.
 */
function familyContext(opts) {
  return { ...opts.base, ...familyOverrides(opts) };
}

function familyOverrides({ family, domainParam, option, token, others, secondFabric }) {
  const ctx = {};
  if (domainParam) ctx[domainParam] = option.VALUE;
  for (const [param, value] of Object.entries(others)) ctx[param] = value;
  const [first, second] = family.fabricParams;
  if (first) {
    ctx[`${first}___DESCRIPTION`] = token === null ? '' : `#${token}`;
    ctx[`${first}_ALIAS___DESCRIPTION`] = '';
  }
  if (second) {
    ctx[`${second}___DESCRIPTION`] = secondFabric && token !== null ? `#${token}` : '';
    ctx[`${second}_ALIAS___DESCRIPTION`] = '';
  }
  return ctx;
}

function buildTables({ model, sections, params, options, base, increase, evaluate, notes, subforms = {}, axisOf, gridStep = null }) {
  const families = new Map();
  for (const section of sections) {
    const fam = familyOf(section);
    if (!families.has(fam.key)) families.set(fam.key, { ...fam, sections: [], tokens: [] });
    const entry = families.get(fam.key);
    entry.sections.push(section);
    if (!entry.tokens.includes(fam.priceGroup)) entry.tokens.push(fam.priceGroup);
  }

  const tables = [];
  for (const family of families.values()) {
    const clauses = family.conditions[0].filter((c) => c.kind === 'filter');
    const first = family.sections[0];
    const ax = first.axisX ? axisOf(first.axisX, first) : null;
    const ay = first.axisY ? axisOf(first.axisY, first) : null;
    const sx = (ax && ax.scale) || 10;
    const sy = (ay && ay.scale) || 10;
    const xField = (ax && ax.field) || null;
    const yField = (ay && ay.field) || null;

    // Domena = parametr z limitami osi tabeli (MODEL, a w 24/46 SYSTEM/TYP) albo wymuszający typ podformularza (skosy).
    const axisFields = [xField, yField].filter(Boolean);
    const setsLimits = (proc) => axisFields.some((f) => new RegExp(`USTAW\\("${f}","(MIN|MAX)2?"`, 'i').test(proc)) || /USTAW\("[A-Z0-9_]+\.[A-Z0-9_]+","WAR"/i.test(proc);
    const limitParams = clauses.filter((c) => !c.negated && options[c.param] && options[c.param].some((o) => setsLimits(o.PROC)));
    const domainClause = limitParams.find((c) => c.param === 'MODEL') || limitParams[0] || clauses.find((c) => c.param === 'MODEL') || null;
    const domainParam = domainClause ? domainClause.param : null;
    const domain = domainClause ? optionsMatching(domainClause, options[domainParam] || [], evaluate) : [{ VALUE: null, DESCRIPTION: '', PROC: '' }];
    if (!domain.length) {
      notes.push({ kind: 'family-without-options', section: first.name, clause: domainClause && domainClause.text });
      continue;
    }

    const others = {};
    const otherFilters = [];
    for (const clause of clauses) {
      if (clause === domainClause || clause.param === domainParam) continue;
      const opts = options[clause.param] || [];
      const matching = optionsMatching(clause, opts, evaluate);
      // Wykluczenie (`NOT(WSROD(TASMA,…))`) spełnia już pusty wybór — tak jak w formularzu, gdzie pole bywa wyłączone.
      const emptyOk = clause.negated && truthy(evaluate(clause.text, base));
      if (matching.length && !emptyOk) others[clause.param] = matching[0].VALUE;
      otherFilters.push({ param: clause.param, options: matching.map((o) => o.VALUE), text: clause.text });
    }
    // Wariant osi-wzoru, w którym oś to samo pole (14: WYS_RODZ=PASEK).
    Object.assign(others, ax && ax.fixed, ay && ay.fixed);
    // Parametry rodziny (domena, filtry, tkanina, osie) muszą być włączone: ich ENABLE dopisuje
    // brakujące wybory, łańcuchowo (KOLOR → STOFF → KONFIGURACJA).
    const probe = familyContext({ base, family, domainParam, option: domain[0], token: family.tokens[0], others, secondFabric: false });
    const required = [domainParam, ...Object.keys(others), family.fabricParams[0], xField, yField].filter(Boolean);
    for (let i = 0; i < required.length && i < 50; i++) {
      const row = params[required[i]];
      if (!row) continue;
      const added = completeEnable(row.ENABLE, probe, options, evaluate);
      for (const [param, value] of Object.entries(added)) {
        others[param] = value;
        required.push(param);
      }
    }
    // Limity z parametru spoza warunków (24/46: SYSTEM przy samym szyciu), włączonego w tej
    // konfiguracji: komórka musi przejść przez któryś z jego włączonych wyborów.
    const implicit = [];
    if (!limitParams.length) {
      for (const [param, opts] of Object.entries(options)) {
        if (param === domainParam || param in others || !opts.some((o) => setsLimits(o.PROC))) continue;
        if (params[param] && present(params[param].ENABLE) && !truthy(evaluate(params[param].ENABLE, probe))) continue;
        const enabled = opts.filter((o) => !present(o.ENABLE) || truthy(evaluate(o.ENABLE, probe)));
        if (enabled.length) implicit.push({ param, options: enabled });
      }
    }

    // Druga tkanina: włączona przez ENABLE jej parametru w param.txt dla danego modelu.
    const secondParam = family.fabricParams[1];
    const secondEnable = secondParam && params[secondParam] && present(params[secondParam].ENABLE) ? params[secondParam].ENABLE : null;
    const isDouble = (option) => !!(secondEnable && domainParam && truthy(evaluate(secondEnable, { [domainParam]: option.VALUE })));

    // Sygnatura = które sekcje skryptu działają dla (model, grupa); równe sygnatury dzielą tabelę.
    const groups = new Map();
    for (const option of domain) {
      const double = isDouble(option);
      const runners = family.tokens.map((token) => cellRunner(model, familyContext({ base, family, domainParam, option, token, others, secondFabric: double }), evaluate, increase, { params, dimFields: [xField, yField].filter(Boolean) }));
      const key = `${double}|${runners.map((r) => r.n.join(',')).join('|')}`;
      if (!groups.has(key)) groups.set(key, { double, options: [], runners });
      groups.get(key).options.push(option);
    }
    if (groups.size > 1) {
      notes.push({ kind: 'family-split', section: first.name, groups: [...groups.values()].map((g) => g.options.map((o) => o.VALUE)) });
    }

    // 73: siatka co `gridStep` cm (decyzja właściciela 07.11) — progi skryptu będące jej wielokrotnością.
    const thin = (bounds) => {
      if (!gridStep) return bounds;
      const kept = bounds.filter((b) => b % gridStep === 0);
      return kept.length ? kept : bounds;
    };
    const powFormula = params.POW && present(params.POW.FORMULA) ? params.POW.FORMULA : null;
    const validatorMemo = new Map();

    for (const group of groups.values()) {
      // Pole osi wyłączone w tej konfiguracji (73: SZEROKOSC_POTRZEBNA przy KAR) → konfigurator podaje
      // wartość neutralną i skrypt bierze pierwszy próg: oś znika z tabeli, a raport to zgłasza.
      const groupCtx = familyContext({ base, family, domainParam, option: group.options[0], token: family.tokens[0], others, secondFabric: group.double });
      const fixedDims = {};
      for (const field of [xField, yField]) {
        const p = field && params[field];
        if (p && present(p.ENABLE) && !truthy(evaluate(p.ENABLE, groupCtx))) {
          fixedDims[field] = neutralValue(p);
          notes.push({ kind: 'axis-disabled', section: first.name, field, options: group.options.map((o) => o.VALUE) });
        }
      }
      const tx = xField && !(xField in fixedDims) ? xField : null;
      const ty = yField && !(yField in fixedDims) ? yField : null;
      const widths = tx ? thin(axisBounds(family.sections, 'x')) : [null];
      const heights = ty ? thin(axisBounds(family.sections, 'y')) : [null];
      // Komórka istnieje, gdy choć jedna opcja tabeli przyjmie wymiar z jej przedziału:
      // zakres = najniższe min i najwyższe max opcji, w środku kreska, gdy żadna nie pasuje.
      const allowed = new Map();
      widths.forEach((w, wi) => heights.forEach((h, hi) => {
        // Przy siatce rzadszej niż progi skryptu komórka to punkt siatki: sprawdzamy jej własny próg.
        const cell = {
          x0: tx ? (gridStep ? w * sx - 1 : wi ? widths[wi - 1] * sx : 0) : 0,
          x1: tx ? w * sx : 0,
          y0: ty ? (gridStep ? h * sy - 1 : hi ? heights[hi - 1] * sy : 0) : 0,
          y1: ty ? h * sy : 0
        };
        const accepts = (option, procParam) => acceptsCell({ memo: validatorMemo, option, procParam, xField: tx, yField: ty, cell, powFormula, subforms });
        allowed.set(`${w}|${h}`, (!domainParam || group.options.some((o) => accepts(o, domainParam))) &&
          implicit.every((lim) => lim.options.some((o) => accepts(o, lim.param))));
      }));

      const cells = {};
      const usedW = new Set();
      const usedH = new Set();
      family.tokens.forEach((token, t) => {
        cells[token] = {};
        for (const w of widths) {
          for (const h of heights) {
            if (!allowed.get(`${w}|${h}`)) continue;
            const dims = { ...fixedDims };
            if (tx) dims[tx] = w * sx;
            if (ty) dims[ty] = h * sy;
            const result = group.runners[t].run(dims);
            if (result.error) {
              notes.push({ kind: 'cell-error', section: first.name, error: result.error });
              continue;
            }
            const amount = Number(result.amount);
            if (!Number.isFinite(amount) || amount === 0) continue;
            cells[token][`${w}|${h}`] = amount;
            usedW.add(w);
            usedH.add(h);
          }
        }
      });
      if (!usedW.size && !usedH.size) continue;
      tables.push({
        param: model.param,
        sections: family.sections.map((s) => s.name),
        domainParam,
        limitParams: implicit.map((lim) => lim.param),
        options: group.options.map((o) => ({ value: o.VALUE, description: o.DESCRIPTION })),
        otherFilters,
        doubleFabric: group.double,
        fabricParam: family.fabricParams[0] || null,
        priceGroups: family.tokens,
        xField: tx,
        yField: ty,
        // Oś-licznik (TORY): wartości to opcje, nie centymetry.
        xCount: !!(tx && ax && ax.count),
        yCount: !!(ty && ay && ay.count),
        fixedDims,
        gridStep,
        // Oś-wzór: wariant w tabeli i przesunięcia pozostałych (do przypisu).
        axisVariants: [ax, ay].filter((a) => a && a.base && [tx, ty].includes(a.field)).map((a) => ({ field: a.field, base: a.base, others: a.variants })),
        widths: widths.filter((w) => usedW.has(w)),
        heights: heights.filter((h) => usedH.has(h)),
        cells,
        // Konfiguracja, z której policzono komórki (różnice względem pustego formularza) —
        // test porównawczy uruchamia na niej prawdziwy skrypt (`cellObject`).
        contexts: Object.fromEntries(family.tokens.map((token) => [token, familyOverrides({ family, domainParam, option: group.options[0], token, others, secondFabric: group.double })]))
      });
    }
  }
  return tables;
}

// Siatka rzadsza niż progi skryptu (decyzja właściciela 07.11: 73 co 50 cm, resztę liczy konfigurator).
const GRID_STEP_CM = { 73: 50 };

/**
 * Przewodnik do tabel po szerokości tkaniny (73): per model marszczenie każdej
 * taśmy/fali (wzór MARSZCZPROC przy opcjach włączonych dla modelu), taśmy z
 * szerokością na płasko (MARSZCZENIE) i model bez marszczenia ze swoim wzorem
 * (WAVE: TKBW). Dodatek = SZEROKOSC_POTRZEBNA przy zerowej szerokości (+120 mm).
 * null, gdy grupa nie ma MARSZCZPROC i SZEROKOSC_POTRZEBNA.
 */
function fabricWidthGuide(params, options, evaluate, base) {
  const fullness = params.MARSZCZPROC;
  const needed = params.SZEROKOSC_POTRZEBNA;
  if (!fullness || !present(fullness.FORMULA) || !needed || !present(needed.FORMULA)) return null;
  const parts = identifiers(needed.FORMULA).filter((id) => params[id] && present(params[id].FORMULA) && !(options[id] || []).length);
  const addMm = Number(evaluate(needed.FORMULA, { ...base, ...Object.fromEntries(parts.map((id) => [id, 0])) }));
  // Włączone w jakiejkolwiek konfiguracji z tym modelem (puste wybory uzupełnia completeEnable).
  const enabled = (row, ctx) => {
    if (!row || !present(row.ENABLE)) return true;
    const c = { ...ctx };
    completeEnable(row.ENABLE, c, options, evaluate);
    return truthy(evaluate(row.ENABLE, c));
  };
  const choices = identifiers(fullness.FORMULA).filter((id) => (options[id] || []).length);
  const models = [];
  for (const model of options.MODEL || []) {
    const ctx = { ...base, MODEL: model.VALUE };
    const rows = [];
    const flat = [];
    for (const param of choices.filter((c) => enabled(params[c], ctx))) {
      for (const o of options[param].filter((x) => enabled(x, ctx))) {
        const c = { ...ctx, [param]: o.VALUE };
        if (enabled(fullness, c)) rows.push({ param, value: o.VALUE, percent: Number(evaluate(fullness.FORMULA, c)) });
        else if (params.MARSZCZENIE && enabled(params.MARSZCZENIE, c)) flat.push(o.VALUE);
      }
    }
    const own = rows.length || flat.length ? null : parts.find((id) => enabled(params[id], ctx));
    // Kody i wzory; opisy w języku konta składa widok PDF.
    models.push({ value: model.VALUE, rows, flat, formulaParam: own || null });
  }
  return { addCm: addMm / 10, flatParam: 'MARSZCZENIE', models: models.filter((m) => m.rows.length || m.flat.length || m.formulaParam) };
}

// ---------------------------------------------------------------------------
// Pozycje (dopłaty, dopłaty EL, sekcje bez wymiarów w cenie).

function buildItems({ model, sections, params, options, base, increase, evaluate, notes }) {
  const items = [];
  for (const section of sections) {
    const clauses = section.conditions.flatMap((c) => (c.formula ? clausesOf(c.formula) : []));
    const ctx = { ...base };
    const filters = [];
    for (const clause of clauses) {
      if (clause.kind === 'priceGroup') {
        ctx[`${clause.param}___DESCRIPTION`] = `#${clause.token}`;
        ctx[`${clause.param}_ALIAS___DESCRIPTION`] = '';
        continue;
      }
      if (clause.kind === 'compare') {
        // Dopłata zależna od wymiaru (`SZEROKOSC<=1300`): konfiguracja z pasującym wymiarem.
        if (ctx[clause.param] === undefined) ctx[clause.param] = satisfyingValue(clause);
        filters.push({ compare: true, param: clause.param, op: clause.op, value: clause.value, text: clause.text });
        continue;
      }
      if (clause.kind !== 'filter') {
        filters.push({ raw: clause.text });
        continue;
      }
      const matching = optionsMatching(clause, options[clause.param] || [], evaluate);
      filters.push({ param: clause.param, options: matching.map((o) => o.VALUE), negated: clause.negated, text: clause.text });
      if (!clause.negated && matching.length && ctx[clause.param] === undefined) ctx[clause.param] = matching[0].VALUE;
    }

    // Parametry liczone z wymiarów (POW) — jak w `values` konfiguratora.
    const dims = Object.fromEntries(['SZEROKOSC', 'WYSOKOSC'].filter((f) => typeof ctx[f] === 'number').map((f) => [f, ctx[f]]));
    if (Object.keys(dims).length) Object.assign(ctx, derivedDims(params, dims));
    const valueFormula = section.value.kind === 'const' && section.value.value.formula ? section.value.value.formula : null;
    const item = { param: model.param, name: section.name, filters };
    // Kwota SAMEJ pozycji: jej sekcja z mnożnikiem, podwyżką i zaokrągleniem — tyle
    // konfigurator doliczy za nią. Suma konfiguracji zawierałaby też inne dopłaty
    // tej samej konfiguracji (np. „M” dla modeli _M obok „Klemmtrager”).
    const ownAmount = (run) => (run.error ? null : Number(sm.finalAmount(model, run.sections[section.name], increase)));

    if (section.value.kind !== 'const') {
      item.kind = 'dimensional';
      notes.push({ kind: 'dimensional-item', section: section.name, param: model.param });
    } else if (!valueFormula) {
      const run = sm.runModel(model, ctx, evaluate, increase);
      item.kind = 'amount';
      item.amount = ownAmount(run);
      item.raw = run.error ? null : run.sections[section.name];
      item.context = ctx;
      // Inne sekcje, które ta sama minimalna konfiguracja uruchamia (np. dopłata za model).
      item.alsoFired = run.error ? [] : Object.entries(run.sections).filter(([n, v]) => n !== section.name && v).map(([n]) => n);
    } else {
      const ids = identifiers(valueFormula);
      if (ids.every((id) => id === 'MODEL')) {
        // Kwota zależna od modelu: licz dla każdego modelu, któremu dopłata przysługuje.
        const modelFilter = filters.find((f) => f.param === 'MODEL' && !f.negated);
        const models = modelFilter ? modelFilter.options : (options.MODEL || []).map((o) => o.VALUE);
        const byAmount = new Map();
        for (const value of models) {
          const run = sm.runModel(model, { ...ctx, MODEL: value }, evaluate, increase);
          const amount = ownAmount(run);
          if (!byAmount.has(amount)) byAmount.set(amount, { raw: run.error ? null : run.sections[section.name], options: [] });
          byAmount.get(amount).options.push(value);
        }
        item.kind = 'byOption';
        item.context = ctx;
        item.byOption = [...byAmount.entries()].map(([amount, { raw, options: values }]) => ({ amount, raw, options: values }));
      } else if (ids.length === 1 && /CENA/.test(ids[0])) {
        // Procent ceny bazowej: kwota dla ceny 100 = efektywny procent (już z mnożnikiem i podwyżką).
        const run = sm.runModel(model, { ...ctx, [ids[0]]: 100 }, evaluate, increase);
        item.kind = 'percentOf';
        item.ofParam = ids[0];
        item.percent = ownAmount(run);
      } else if (ids.length === 1 && ['SZEROKOSC', 'WYSOKOSC'].includes(ids[0])) {
        const at = (mm) => ownAmount(sm.runModel(model, { ...ctx, [ids[0]]: mm }, evaluate, increase));
        const perMeter = at(1000);
        item.kind = Math.abs(at(2000) - 2 * perMeter) <= 0.011 ? 'perMeter' : 'formula';
        item.ofParam = ids[0];
        item.perMeter = perMeter;
      } else {
        item.kind = 'formula';
        notes.push({ kind: 'unsupported-formula', section: section.name, param: model.param, formula: valueFormula });
      }
    }
    // Pozycja, którą konfigurator zawsze liczy na 0 (np. warunek `1=2`), nie trafia
    // do cennika — tylko do raportu.
    const amounts = item.kind === 'amount' ? [item.amount] : item.kind === 'byOption' ? item.byOption.map((b) => b.amount) : null;
    if (amounts && amounts.every((a) => !a)) {
      item.zero = true;
      notes.push({ kind: 'item-always-zero', section: section.name, param: model.param, filters: filters.map((f) => f.raw || f.text) });
    }
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Rabaty: wzór CENA_KONCOWA / SUB___CENA_KONCOWA grupy, składnik po składniku.

/**
 * Kwota po rabacie dla jednego składnika: wzór końcowy grupy z zerami w innych
 * składnikach (wzór jest liniowy), zaokrąglony jak parametr-formuła
 * w konfiguratorze (`parseFloat(toFixed(2))`, wynik ujemny → 0).
 */
function discountedAmount({ formula, component, amount, components, rebates }) {
  const values = { ...rebates };
  for (const c of components) values[c] = c === component ? amount : 0;
  const result = realm().evaluate(formula, values);
  if (result === false || result === null || result < 0) return 0;
  const number = parseFloat(result);
  return Number.isFinite(number) ? parseFloat(number.toFixed(2)) : null;
}

// ---------------------------------------------------------------------------

/**
 * Cennik jednego klienta w jednej grupie.
 *
 * @param {object} opts
 * @param {string} opts.groupNumber
 * @param {{ id:number, ident:string }} opts.user        konto, którego ceny liczy konfigurator (jego uid)
 * @param {string} opts.orgIdent
 * @param {'CENA'|'SUB'} opts.priceSet                    CENA = ceny zwykłe, SUB = SUB___
 * @param {string} [opts.lang]                            opisy opcji
 * @param {Date}   [opts.date]                            dzień, na który liczymy podwyżki
 */
async function buildPricelist({ groupNumber, user, orgIdent, priceSet, lang = 'pl', date = new Date(), version: forcedVersion }) {
  const version = forcedVersion || (await activeVersion(groupNumber));
  if (!version) return { ok: false, reason: 'brak wersji grupy' };
  const terms = await resolveGroupTerms({ userId: user.id, groupNumber, orgIdent, userIdent: user.ident, lang: 'pl' });
  if (!terms.hasAccess) return { ok: false, reason: 'klient nie ma dostępu do grupy' };

  const params = readParams(groupNumber, version, 'pl');
  const options = readOptions(groupNumber, version, lang);
  const optionsPl = lang === 'pl' ? options : readOptions(groupNumber, version, 'pl');
  const prefix = priceSet === 'SUB' ? 'SUB___' : '';
  const sumParam = params[`${prefix}CENA_SUMA`];
  // Składniki = parametry ceny, nie wybory (14: `IF(WSROD(KONFIGURACJA,"L"),CENAPASEK+…,CENA+…)`).
  const components = sumParam && present(sumParam.FORMULA)
    ? identifiers(sumParam.FORMULA).filter((id) => params[id] && !(optionsPl[id] || []).length)
    : [`${prefix}CENA`, `${prefix}DOPLATA`, `${prefix}DOPLATA_EL`].filter((id) => params[id]);

  const uid = hashUser(user.ident);
  const base = baseContext(uid, params);
  const dateKey = sm.dateKeyOf(date);
  const evaluate = memoEvaluate();
  const notes = [];
  const parts = [];

  // Oś w kontekście wyborów sekcji: pierwsza opcja spełniająca każdą klauzulę-filtr (jak `others` w buildTables).
  const axisMemo = new Map();
  const axisOf = (axis, section) => {
    const choiceCtx = {};
    for (const c of section.conditions.flatMap((cond) => (cond.formula ? clausesOf(cond.formula) : []))) {
      if (c.kind !== 'filter' || c.negated || c.param in choiceCtx) continue;
      const m = optionsMatching(c, optionsPl[c.param] || [], evaluate);
      if (m.length) choiceCtx[c.param] = m[0].VALUE;
    }
    const key = JSON.stringify([axis, choiceCtx]);
    if (!axisMemo.has(key)) axisMemo.set(key, resolveAxis(axis, optionsPl, choiceCtx));
    return axisMemo.get(key);
  };

  // Podformularze, których typ wymusza procedura opcji (`USTAW("WYMIAROWANIE_SLOPOW.TYP","WAR",…)`) — limity ich pól.
  const subforms = {};
  const subNames = new Set(Object.values(optionsPl).flatMap((opts) => opts.flatMap((o) => [...o.PROC.matchAll(/USTAW\("([A-Z0-9_]+)\.[A-Z0-9_]+","WAR"/gi)].map((m) => m[1].toUpperCase()))));
  for (const name of subNames) {
    const subVersion = await activeVersion(name);
    try {
      subforms[name] = { params: readParams(name, subVersion, 'pl'), options: readOptions(name, subVersion, 'pl') };
    } catch (err) {
      notes.push({ kind: 'subform-missing', subform: name, version: subVersion, error: err.message });
    }
  }

  for (const component of components) {
    const file = terms.scripts[component];
    if (!file) {
      notes.push({ kind: 'no-script', param: component });
      parts.push({ param: component, missing: true });
      continue;
    }
    const model = loadModel(groupNumber, file);
    if (model.missing) {
      notes.push({ kind: 'missing-file', param: component, file });
      parts.push({ param: component, missing: true, file });
      continue;
    }
    if (model.unknown.length) {
      notes.push({ kind: 'unparsed-script', param: component, file, problem: model.unknown[0] });
      parts.push({ param: component, unparsed: true, file });
      continue;
    }
    const increase = sm.increaseFor(model, uid, dateKey);
    if (increase.rule && increase.rule.defect) notes.push({ kind: 'increase-defect', param: component, file, defect: increase.rule.defect });
    const tableSections = model.sections.filter((s) => isTableSection(s, axisOf));
    const itemSections = model.sections.filter((s) => !isTableSection(s, axisOf) && s.value.kind !== 'none');
    parts.push({
      param: component,
      file,
      increase: { f: increase.f, fr: increase.fr, branch: increase.branch },
      tables: buildTables({ model, sections: tableSections, params, options: optionsPl, base, increase, evaluate, notes, subforms, axisOf, gridStep: GRID_STEP_CM[String(groupNumber)] || null }),
      items: buildItems({ model, sections: itemSections, params, options: optionsPl, base, increase, evaluate, notes })
    });
  }

  // Rabaty klienta: wartości ze skryptów `*_RABAT` (jak values[...] w konfiguratorze).
  const finalParam = params[`${prefix}CENA_KONCOWA`];
  const rebates = {};
  let discount = null;
  if (finalParam && present(finalParam.FORMULA)) {
    for (const id of identifiers(finalParam.FORMULA).filter((x) => /RABAT/.test(x))) {
      const file = terms.scripts[id];
      const model = file ? loadModel(groupNumber, file) : null;
      if (!model || model.missing || model.unknown.length) {
        notes.push({ kind: 'no-rebate-script', param: id, file: file || null });
        rebates[id] = 0;
        continue;
      }
      rebates[id] = Number(sm.runModel(model, { uid }, evaluate).amount) || 0;
    }
    discount = { formula: finalParam.FORMULA, rebates, components };
  }

  const guide = GRID_STEP_CM[String(groupNumber)] ? fabricWidthGuide(params, optionsPl, evaluate, base) : null;
  return { ok: true, groupNumber: String(groupNumber), version, priceSet, lang, dateKey, uid, terms: { source: terms.source }, parts, discount, guide, notes };
}

/** Kwoty po rabacie dla całego cennika (osobny PDF „z rabatem”). */
function applyDiscount(pricelist) {
  const d = pricelist.discount;
  if (!d) return null;
  const apply = (component, amount) => (amount === null || amount === undefined ? amount : discountedAmount({ formula: d.formula, component, amount, components: d.components, rebates: d.rebates }));
  return {
    ...pricelist,
    discounted: true,
    parts: pricelist.parts.map((part) => (!part.tables ? part : {
      ...part,
      tables: part.tables.map((t) => ({
        ...t,
        cells: Object.fromEntries(Object.entries(t.cells).map(([token, row]) => [token, Object.fromEntries(Object.entries(row).map(([k, a]) => [k, apply(part.param, a)]))]))
      })),
      items: part.items.map((it) => ({
        ...it,
        ...(it.amount !== undefined ? { amount: apply(part.param, it.amount) } : {}),
        ...(it.byOption ? { byOption: it.byOption.map((b) => ({ ...b, amount: apply(part.param, b.amount) })) } : {}),
        ...(it.perMeter !== undefined ? { perMeter: apply(part.param, it.perMeter) } : {})
      }))
    }))
  };
}

/**
 * Dokładna konfiguracja komórki tabeli (kontekst + wymiary + parametry z wymiarów),
 * na której test porównawczy uruchamia prawdziwy skrypt.
 */
function cellObject(pricelist, table, token, w, h) {
  const dims = { ...(table.fixedDims || {}) };
  if (table.xField) dims[table.xField] = Number(w) * (table.xCount ? 1 : 10);
  if (table.yField) dims[table.yField] = Number(h) * (table.yCount ? 1 : 10);
  const params = readParams(pricelist.groupNumber, pricelist.version, 'pl');
  return { ...baseContext(pricelist.uid, params), ...table.contexts[token], ...dims, ...derivedDims(params, dims) };
}

module.exports = { buildPricelist, applyDiscount, activeVersion, readParams, readOptions, loadModel, discountedAmount, clearCaches, cellObject, resolveAxis, completeEnable, baseContext };
