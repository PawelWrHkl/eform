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
const { familyOf, clausesOf } = require('./conditions');

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

const MAX_MODELS = 24;
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

/** `evaluate` z pamięcią: wynik zależy od formuły i wartości, których ona używa. */
function memoEvaluate() {
  const memo = new Map();
  return (formula, obj) => {
    const ids = identifiers(formula);
    const key = `${formula}\u0000${ids.map((id) => `${id}=${obj[id]}`).join('\u0001')}`;
    if (!memo.has(key)) memo.set(key, realm().evaluate(formula, obj));
    return memo.get(key);
  };
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
function validatorsAt(memo, option, procParam, xField, x) {
  const key = `${option.VALUE}|${xField}|${x}`;
  if (!memo.has(key)) memo.set(key, option.PROC ? realm().procedure(option.PROC, { [procParam]: option.VALUE, [xField]: x }, procParam, option.VALUE) : {});
  return memo.get(key);
}

/**
 * Czy opcja przyjmie jakikolwiek wymiar z komórki: x ∈ (x0, x1], y ∈ (y0, y1] w mm.
 * Procedurę sprawdzamy przy obu brzegach szerokości (max wysokości bywa warunkowy),
 * POW — jego własną formułą z param.txt, tylko gdy grupa ma taki parametr.
 */
function acceptsCell({ memo, option, procParam, xField, yField, cell, powFormula }) {
  if (!option.PROC) return true;
  if (!xField) {
    // Tabela tylko po wysokości: jej zakres nie zależy od szerokości.
    const ry = hardRange(validatorsAt(memo, option, procParam, yField, cell.y1), yField) || { min: 0, max: Infinity };
    return Math.max(cell.y0 + 1, ry.min) <= Math.min(cell.y1, ry.max);
  }
  for (const x of yField ? [cell.x0 + 1, cell.x1] : [cell.x1]) {
    const validators = validatorsAt(memo, option, procParam, xField, x);
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
 * Szybki odpowiednik `runModel` dla stałych opcji i zmiennych wymiarów: liczba
 * trafień `n` każdej sekcji liczona raz, wymiary wchodzą przez osie. Sekcje
 * z `n=0` dają 0 (v*0), chyba że są „ryzykowne” — wtedy liczymy je jak skrypt.
 * Model z progami-zmiennymi idzie zawsze pełną ścieżką `runModel`.
 */
function cellRunner(model, ctx, evaluate, increase) {
  if (!model.meta) {
    model.meta = {
      clauses: model.sections.map((s) => s.conditions.map((c) => (c.formula ? clausesOf(c.formula) : []))),
      risky: model.sections.map(sectionIsRisky)
    };
    model.meta.anyRefs = model.meta.risky.some(Boolean);
  }
  const n = model.sections.map((s, i) => s.conditions.reduce((acc, c, k) => {
    if (!c.formula) return acc + (sm.literalNumber(c) ? 1 : 0);
    if (quickFalse(model.meta.clauses[i][k], ctx)) return acc;
    return acc + (truthy(evaluate(c.formula, ctx)) ? 1 : 0);
  }, s.nInit));

  const run = (dims) => {
    if (model.meta.anyRefs) return sm.runModel(model, { ...ctx, ...dims }, evaluate, increase);
    const obj = { ...ctx, ...dims };
    const scope = Object.create(null);
    model.sections.forEach((s, i) => {
      if (!n[i]) {
        scope[s.name] = 0;
        return;
      }
      const axis = (a) => {
        if (!a) return null;
        const field = simpleAxis(a);
        if (field && typeof obj[field] === 'number') return obj[field] / 10;
        return a.formula ? evaluate(a.formula, obj) : 'num' in a ? a.num : a.str;
      };
      const entry = sm.lookupEntry(s, axis(s.axisX), axis(s.axisY));
      let v = 0;
      if (entry) v = entry.value.formula ? evaluate(entry.value.formula, obj) : 'num' in entry.value ? entry.value.num : entry.value.str;
      scope[s.name] = v * n[i];
    });
    let total;
    model.sum.forEach((name, k) => {
      total = k === 0 ? scope[name] : total + scope[name];
    });
    return { amount: sm.finalAmount(model, total, increase), sections: scope };
  };
  return { n, run };
}

// ---------------------------------------------------------------------------
// Tabele cen (sekcje z osiami wymiarów).

/** Oś `PARAM/10` → nazwa pola; inne formuły osi to przypadki specjalne (etap 4). */
function simpleAxis(axis) {
  if (!axis || !axis.formula) return null;
  const m = /^([A-Z0-9_]+)\/10$/.exec(axis.formula.trim());
  return m ? m[1] : null;
}

function isTableSection(section) {
  if (!['xy', 'x', 'y'].includes(section.value.kind)) return false;
  if (section.value.kind === 'x' || section.value.kind === 'xy') if (!simpleAxis(section.axisX)) return false;
  if (section.value.kind === 'y' || section.value.kind === 'xy') if (!simpleAxis(section.axisY)) return false;
  return true;
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
function baseContext(uid) {
  return { uid };
}

/**
 * Kontekst konfiguracji dla rodziny: model, grupa tkaniny, pozostałe filtry
 * (pierwsza opcja, która je spełnia) i druga tkanina, gdy model ją włącza.
 */
function familyContext({ uid, family, domainParam, option, token, others, secondFabric }) {
  const ctx = baseContext(uid);
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

function buildTables({ model, sections, params, options, uid, increase, evaluate, notes }) {
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
    const xField = simpleAxis(first.axisX);
    const yField = simpleAxis(first.axisY);

    // Domena = parametr z limitami wymiarów (MODEL, a w 24/46 SYSTEM/TYP), spośród klauzul rodziny.
    const limitParams = clauses.filter((c) => !c.negated && options[c.param] && options[c.param].some((o) => /USTAW\("(SZEROKOSC|WYSOKOSC)","(MIN|MAX)2?"/i.test(o.PROC)));
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
      if (matching.length) others[clause.param] = matching[0].VALUE;
      otherFilters.push({ param: clause.param, options: matching.map((o) => o.VALUE), text: clause.text });
    }

    // Druga tkanina: włączona przez ENABLE jej parametru w param.txt dla danego modelu.
    const secondParam = family.fabricParams[1];
    const secondEnable = secondParam && params[secondParam] && present(params[secondParam].ENABLE) ? params[secondParam].ENABLE : null;
    const isDouble = (option) => !!(secondEnable && domainParam && truthy(evaluate(secondEnable, { [domainParam]: option.VALUE })));

    // Sygnatura = które sekcje skryptu działają dla (model, grupa); równe sygnatury dzielą tabelę.
    const groups = new Map();
    for (const option of domain) {
      const double = isDouble(option);
      const runners = family.tokens.map((token) => cellRunner(model, familyContext({ uid, family, domainParam, option, token, others, secondFabric: double }), evaluate, increase));
      const key = `${double}|${runners.map((r) => r.n.join(',')).join('|')}`;
      if (!groups.has(key)) groups.set(key, { double, options: [], runners });
      groups.get(key).options.push(option);
    }
    if (groups.size > 1) {
      notes.push({ kind: 'family-split', section: first.name, groups: [...groups.values()].map((g) => g.options.map((o) => o.VALUE)) });
    }

    const widths = xField ? axisBounds(family.sections, 'x') : [null];
    const heights = yField ? axisBounds(family.sections, 'y') : [null];
    const powFormula = params.POW && present(params.POW.FORMULA) ? params.POW.FORMULA : null;
    const validatorMemo = new Map();

    for (const group of groups.values()) {
      // Komórka istnieje, gdy choć jedna opcja tabeli przyjmie wymiar z jej przedziału:
      // zakres = najniższe min i najwyższe max opcji, w środku kreska, gdy żadna nie pasuje.
      const allowed = new Map();
      widths.forEach((w, wi) => heights.forEach((h, hi) => {
        const cell = {
          x0: xField && wi ? widths[wi - 1] * 10 : 0,
          x1: xField ? w * 10 : 0,
          y0: yField && hi ? heights[hi - 1] * 10 : 0,
          y1: yField ? h * 10 : 0
        };
        allowed.set(`${w}|${h}`, !domainParam || group.options.some((option) => acceptsCell({ memo: validatorMemo, option, procParam: domainParam, xField, yField, cell, powFormula })));
      }));

      const cells = {};
      const usedW = new Set();
      const usedH = new Set();
      family.tokens.forEach((token, t) => {
        cells[token] = {};
        for (const w of widths) {
          for (const h of heights) {
            if (!allowed.get(`${w}|${h}`)) continue;
            const dims = {};
            if (xField) dims[xField] = w * 10;
            if (yField) dims[yField] = h * 10;
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
        options: group.options.map((o) => ({ value: o.VALUE, description: o.DESCRIPTION })),
        otherFilters,
        doubleFabric: group.double,
        fabricParam: family.fabricParams[0] || null,
        priceGroups: family.tokens,
        xField,
        yField,
        widths: widths.filter((w) => usedW.has(w)),
        heights: heights.filter((h) => usedH.has(h)),
        cells,
        // Konfiguracja, z której policzono komórki — test porównawczy uruchamia na niej prawdziwy skrypt.
        contexts: Object.fromEntries(family.tokens.map((token) => [token, familyContext({ uid, family, domainParam, option: group.options[0], token, others, secondFabric: group.double })]))
      });
    }
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Pozycje (dopłaty, dopłaty EL, sekcje bez wymiarów w cenie).

function buildItems({ model, sections, options, uid, increase, evaluate, notes }) {
  const items = [];
  for (const section of sections) {
    const clauses = section.conditions.flatMap((c) => (c.formula ? clausesOf(c.formula) : []));
    const ctx = baseContext(uid);
    const filters = [];
    for (const clause of clauses) {
      if (clause.kind === 'priceGroup') {
        ctx[`${clause.param}___DESCRIPTION`] = `#${clause.token}`;
        ctx[`${clause.param}_ALIAS___DESCRIPTION`] = '';
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

    const valueFormula = section.value.kind === 'const' && section.value.value.formula ? section.value.value.formula : null;
    const item = { param: model.param, name: section.name, filters };

    if (section.value.kind !== 'const') {
      item.kind = 'dimensional';
      notes.push({ kind: 'dimensional-item', section: section.name, param: model.param });
    } else if (!valueFormula) {
      const run = sm.runModel(model, ctx, evaluate, increase);
      item.kind = 'amount';
      item.amount = run.error ? null : Number(run.amount);
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
          const amount = run.error ? null : Number(run.amount);
          if (!byAmount.has(amount)) byAmount.set(amount, []);
          byAmount.get(amount).push(value);
        }
        item.kind = 'byOption';
        item.context = ctx;
        item.byOption = [...byAmount.entries()].map(([amount, values]) => ({ amount, options: values }));
      } else if (ids.length === 1 && /CENA/.test(ids[0])) {
        // Procent ceny bazowej: kwota dla ceny 100 = efektywny procent (już z mnożnikiem i podwyżką).
        const run = sm.runModel(model, { ...ctx, [ids[0]]: 100 }, evaluate, increase);
        item.kind = 'percentOf';
        item.ofParam = ids[0];
        item.percent = run.error ? null : Number(run.amount);
      } else if (ids.length === 1 && ['SZEROKOSC', 'WYSOKOSC'].includes(ids[0])) {
        const at = (mm) => Number(sm.runModel(model, { ...ctx, [ids[0]]: mm }, evaluate, increase).amount);
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
  const components = sumParam && present(sumParam.FORMULA)
    ? identifiers(sumParam.FORMULA).filter((id) => params[id])
    : [`${prefix}CENA`, `${prefix}DOPLATA`, `${prefix}DOPLATA_EL`].filter((id) => params[id]);

  const uid = hashUser(user.ident);
  const dateKey = sm.dateKeyOf(date);
  const evaluate = memoEvaluate();
  const notes = [];
  const parts = [];

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
    const tableSections = model.sections.filter(isTableSection);
    const itemSections = model.sections.filter((s) => !isTableSection(s) && s.value.kind !== 'none');
    parts.push({
      param: component,
      file,
      increase: { f: increase.f, fr: increase.fr, branch: increase.branch },
      tables: buildTables({ model, sections: tableSections, params, options: optionsPl, uid, increase, evaluate, notes }),
      items: buildItems({ model, sections: itemSections, options: optionsPl, uid, increase, evaluate, notes })
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

  return { ok: true, groupNumber: String(groupNumber), version, priceSet, lang, dateKey, uid, terms: { source: terms.source }, parts, discount, notes };
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

module.exports = { buildPricelist, applyDiscount, activeVersion, readParams, readOptions, loadModel, discountedAmount };
