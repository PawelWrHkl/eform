'use strict';

/**
 * Model skryptu cenowego `param-<PARAM>-<wariant>.js` odczytany z TEKSTU skryptu,
 * czyli z tego samego pliku, który wykonuje konfigurator. Cennik klienta liczy
 * kwoty z tego modelu, nie ze skoroszytu: skrypt jest wzorcem prawdy, a na
 * produkcji skoroszytów (/mnt/eformconf) nie ma.
 *
 * Gramatyka = emiter /mnt/eformconf/Worker.bas (ok. l. 2060–2225) plus starszy
 * wariant bloku podwyżek bez `fr` (np. grupa 01):
 *
 *   var SEKCJA=0;                  (brak, gdy poprzedni blok ma ten sam identyfikator)
 *   v=0;
 *   n=1;   albo   n=0; if(<warunek>)n=n+1; …
 *   x=<oś>; y=<oś>;                (opcjonalnie)
 *   v=<wartość>;                                        bez osi
 *   if(x<=B)v=<w>; else if(x<=B)v=<w>; …               tylko X (także x=="tekst")
 *   if(y<=B)v=<w>; …                                    tylko Y
 *   if(x<=B){ if(y<=H)v=<w>; … } else if(x<=B){ … }    X × Y
 *   SEKCJA=v*n;   if(SEKCJA!=0){…etykieta…}
 *   PARAM=S1+S2+…;  [PARAM=PARAM<op><liczba>;]  [blok podwyżek per uid]  return …
 *
 * Linia spoza tej gramatyki trafia do `unknown`. Wtedy z tego skryptu nie
 * liczymy kwot (raport admina), zamiast zgadywać.
 */

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Wartość komórki tak, jak ją zapisał emiter: liczba, `evaluateFormula('…',obj)` albo tekst. */
function parseValue(text) {
  const t = String(text).trim();
  let m;
  if ((m = /^evaluateFormula\('(.*)',obj\)$/.exec(t))) return { formula: m[1] };
  if (NUMBER.test(t)) return { num: Number(t) };
  if ((m = /^"(.*)"$/.exec(t))) return { str: m[1] };
  return null;
}

/**
 * Próg łańcucha: liczba, tekst albo — przez pomyłkę w arkuszu — nazwa zmiennej
 * (`else if(y<=x)` w grupie 59, gdzie w kolumnie wysokości został komentarz).
 * Taki próg porównuje się z bieżącą wartością osi, dokładnie jak w JS.
 */
function parseBound(text) {
  const t = String(text).trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return { ref: t };
  const value = parseValue(t);
  if (value && 'num' in value) return value.num;
  if (value && 'str' in value) return value.str;
  return undefined;
}

/**
 * @param {string} src treść pliku `param-*.js`
 * @returns {{param:string|null, sections:object[], sum:string[]|null,
 *   factor:{op:string,value:number}|null, increase:object|null, unknown:object[]}}
 */
function parseScript(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const model = { param: null, sections: [], sum: null, factor: null, increase: null, unknown: [] };
  let i = 0;
  const line = () => (i < lines.length ? lines[i].trim() : null);
  const fail = (msg) => {
    model.unknown.push({ line: i + 1, text: lines[i], msg });
    return model;
  };

  // Nagłówek: wszystko do `const obj`, potem deklaracje. Stare skrypty rabatów
  // (grupa 01) nie deklarują parametru ani etykiety — nazwę daje `var P=VALUE;`.
  while (i < lines.length && line() !== 'const obj = JSON.parse(arg);') i++;
  if (i >= lines.length) return fail('brak nagłówka funkcji f()');
  i++;
  let m = /^var ([A-Za-z0-9_]+)=0;$/.exec(line());
  if (m && lines[i + 1] && lines[i + 1].trim() === `var ${m[1]}_S="";`) {
    model.param = m[1];
    i += 2;
  }
  while (['var n=0;', 'var v=0;', 'var x=null;', 'var y=null;', ''].includes(line())) i++;

  const isSumLine = () => {
    const t = line();
    if (t === null) return false;
    if (model.param) return t.startsWith(`${model.param}=`);
    return /^var [A-Za-z0-9_]+=[A-Za-z_][A-Za-z0-9_+]*;$/.test(t);
  };

  while (i < lines.length && !isSumLine()) {
    const section = { name: null, conditions: [], nInit: 0, axisX: null, axisY: null, value: null };
    // Pusta linia zamiast `var X=0;` = ten sam identyfikator co poprzedni blok
    // (emiter pomija deklarację). W JS ostatni blok NADPISUJE wartość sekcji.
    if (line() === '') {
      i++;
    } else if ((m = /^var ([A-Za-z0-9_]+)=0;$/.exec(line()))) {
      section.declared = m[1];
      i++;
    }
    if (line() !== 'v=0;') return fail('oczekiwano v=0;');
    i++;
    if (line() === 'n=1;') {
      section.nInit = 1;
      i++;
    } else if (line() === 'n=0;') {
      i++;
      while ((m = /^if\((.*)\)n=n\+1;$/.exec(line()))) {
        const cond = parseValue(m[1]);
        if (!cond) return fail('nieznany warunek');
        section.conditions.push(cond);
        i++;
      }
    } else {
      return fail('oczekiwano n=…;');
    }
    for (const axis of ['x', 'y']) {
      if ((m = new RegExp(`^${axis}=(.*);$`).exec(line()))) {
        const value = parseValue(m[1]);
        if (!value) return fail(`nieznana oś ${axis}`);
        section[axis === 'x' ? 'axisX' : 'axisY'] = value;
        i++;
      }
    }

    if ((m = /^v=(.*);$/.exec(line()))) {
      const value = parseValue(m[1]);
      if (!value) return fail('nieznana wartość');
      section.value = { kind: 'const', value };
      i++;
    } else if (/^if\([xy](<=|==)/.test(line()) && !line().endsWith('{')) {
      const axis = line()[3];
      const entries = [];
      while ((m = new RegExp(`^(else )?if\\(${axis}(<=|==)(.+?)\\)v=(.*);$`).exec(line()))) {
        if ((m[1] ? 1 : 0) !== (entries.length ? 1 : 0)) return fail('zły łańcuch if/else');
        const bound = parseBound(m[3]);
        const value = parseValue(m[4]);
        if (bound === undefined || !value) return fail('nieznany próg albo wartość');
        entries.push({ op: m[2], bound, value });
        i++;
      }
      section.value = { kind: axis, entries };
    } else if (/^if\(x<=.+\)\{$/.test(line())) {
      const columns = [];
      while ((m = /^(else )?if\(x<=(.+)\)\{$/.exec(line()))) {
        if ((m[1] ? 1 : 0) !== (columns.length ? 1 : 0)) return fail('zły łańcuch kolumn');
        const bound = parseBound(m[2]);
        if (bound === undefined) return fail('nieznany próg kolumny');
        i++;
        const rows = [];
        let r;
        while ((r = /^(else )?if\(y(<=|==)(.+?)\)v=(.*);$/.exec(line()))) {
          if ((r[1] ? 1 : 0) !== (rows.length ? 1 : 0)) return fail('zły łańcuch wierszy');
          const rowBound = parseBound(r[3]);
          const value = parseValue(r[4]);
          if (rowBound === undefined || !value) return fail('nieznany próg albo wartość wiersza');
          rows.push({ op: r[2], bound: rowBound, value });
          i++;
        }
        if (line() !== '}') return fail('oczekiwano } zamykającego kolumnę');
        i++;
        columns.push({ bound, rows });
      }
      section.value = { kind: 'xy', columns };
    } else if (/^[A-Za-z0-9_]+=v\*n;$/.test(line())) {
      // Sekcja bez nagłówków tabeli: emiter nie wypisał żadnego `v=`, v zostaje 0.
      section.value = { kind: 'none' };
    } else {
      return fail('nieznana postać wartości sekcji');
    }

    if (!(m = /^([A-Za-z0-9_]+)=v\*n;$/.exec(line()))) return fail('oczekiwano SEKCJA=v*n;');
    section.name = m[1];
    if (section.declared && section.declared !== section.name) return fail('deklaracja i przypisanie sekcji się różnią');
    i++;
    // Etykieta `_S` — stary format (skrypty rabatów, grupa 01) jej nie ma.
    if (new RegExp(`^if\\(${section.name}!=0\\)\\{.*\\}$`).test(line())) i++;
    model.sections.push(section);
  }

  if (!isSumLine()) return fail('brak sumy sekcji');
  if (!model.param) {
    m = /^var ([A-Za-z0-9_]+)=([A-Za-z0-9_+]+);$/.exec(line());
    model.param = m[1];
    model.sum = m[2].split('+');
  } else {
    m = new RegExp(`^${model.param}=([A-Za-z0-9_+]+);$`).exec(line());
    if (!m) return fail('nieznana suma sekcji');
    model.sum = m[1].split('+');
  }
  i++;

  if ((m = new RegExp(`^${model.param}=${model.param}([-+*/])(.+);$`).exec(line()))) {
    if (!NUMBER.test(m[2])) return fail('mnożnik wariantu nie jest pojedynczą liczbą');
    model.factor = { op: m[1], value: Number(m[2]) };
    i++;
  }

  if (line() === 'var uid = obj.uid;') {
    const block = parseIncrease(lines, i, model.param);
    if (block.error) {
      i = block.at;
      return fail(block.error);
    }
    model.increase = block.increase;
    i = block.at;
  }

  if (!/^return \{.*\};$/.test(line())) return fail('oczekiwano return');
  i++;
  if (line() !== '}') return fail('oczekiwano } kończącego f()');
  i++;
  while (i < lines.length && line() === '') i++;
  if (i < lines.length) return fail('treść po funkcji f()');
  return model;
}

/** Blok podwyżek per uid: wariant nowy (`fr`, `toFixed`) i stary (`var f = 1;` bez zaokrągleń). */
function parseIncrease(lines, start, param) {
  const preamble = [
    'var uid = obj.uid;',
    'var date = new Date();',
    'var day = String(date.getDate()).padStart(2, "0");',
    'var month = String(date.getMonth() + 1).padStart(2, "0");',
    'var year = date.getFullYear();',
    'var dateKey = parseInt(`${year}${month}${day}`);'
  ];
  let i = start;
  const line = () => (i < lines.length ? lines[i].trim() : null);
  for (const expected of preamble) {
    if (line() !== expected) return { error: 'nieznany nagłówek bloku podwyżek', at: i };
    i++;
  }
  let rounding;
  if (line() === 'var f=1; fr=-1;') rounding = true;
  else if (line() === 'var f = 1;') rounding = false;
  else return { error: 'nieznana inicjalizacja f', at: i };
  i++;

  const branches = [];
  let m;
  while ((m = /^(\}else )?if\(dateKey>=(\d+)\)\{$/.exec(line()))) {
    if ((m[1] ? 1 : 0) !== (branches.length ? 1 : 0)) return { error: 'zły łańcuch gałęzi dat', at: i };
    const branch = { from: Number(m[2]), rules: [] };
    i++;
    const ruleRe = rounding
      ? /^(else )?if\(uid=="([0-9a-f]{32})"\)\{f=f\+(.+?); fr=(.+?);\}$/
      : /^(else )?if\(uid=="([0-9a-f]{32})"\)f=f\+(.+?);$/;
    let r;
    while ((r = ruleRe.exec(line()))) {
      if ((r[1] ? 1 : 0) !== (branch.rules.length ? 1 : 0)) return { error: 'zły łańcuch reguł uid', at: i };
      if (rounding && !/^-?\d+$/.test(r[4])) return { error: 'nieznane zaokrąglenie', at: i };
      const rule = { uid: r[2], add: null, fr: rounding ? Number(r[4]) : -1 };
      let c;
      if (NUMBER.test(r[3])) {
        rule.add = Number(r[3]);
      } else if ((c = /^([+-]?\d+(\.\d+)?),\d+$/.exec(r[3]))) {
        // `f=f+0,028` w JS to operator przecinka: przypisanie bierze tylko `0`.
        // Podwyżka z przecinkiem dziesiętnym w PRODUKT po cichu nie działa.
        rule.add = Number(c[1]);
        rule.defect = `przecinek w podwyżce: ${r[3]}`;
      } else {
        return { error: 'nieznana podwyżka', at: i };
      }
      branch.rules.push(rule);
      i++;
    }
    branches.push(branch);
  }
  if (line() !== '}') return { error: 'oczekiwano } kończącego gałęzie dat', at: i };
  // Bez kolumn dat w PRODUKT emiter i tak wypisuje `}` — to zamyka f(), a `return`
  // ląduje poza funkcją: SyntaxError, konfigurator nie policzy niczego (grupa 76).
  if (!branches.length) return { error: 'skrypt uszkodzony: } bez gałęzi dat zamyka f() (błąd składni JS)', at: i };
  i++;
  if (line() !== `${param}=${param}*f;`) return { error: 'oczekiwano PARAM=PARAM*f;', at: i };
  i++;
  if (rounding) {
    if (line() !== `if(fr!=-1)${param}=${param}.toFixed(fr);`) return { error: 'oczekiwano toFixed(fr)', at: i };
    i++;
  }
  if (line().startsWith('if(f!=1)')) i++;
  return { increase: { rounding, branches }, at: i };
}

/** `dateKey` liczony jak w skrypcie: RRRRMMDD z lokalnej daty. */
function dateKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

/**
 * Podwyżka klienta na dany dzień: pierwsza gałąź z `dateKey >= próg` (nowsza
 * kolumna zastępuje starszą), w niej PIERWSZA reguła z tym uid — dokładnie jak
 * łańcuch if/else w skrypcie, także przy zdublowanych uid.
 */
function increaseFor(model, uid, dateKey) {
  const none = { f: 1, fr: -1, branch: null, rule: null };
  if (!model.increase) return none;
  const branch = model.increase.branches.find((b) => dateKey >= b.from);
  if (!branch) return none;
  const rule = branch.rules.find((r) => r.uid === uid);
  if (!rule) return { ...none, branch: branch.from };
  let f = 1;
  f = f + rule.add;
  return { f, fr: rule.fr, branch: branch.from, rule };
}

function applyOp(total, op, value) {
  switch (op) {
    case '*': return total * value;
    case '/': return total / value;
    case '+': return total + value;
    case '-': return total - value;
    default: return NaN;
  }
}

/** `scriptLoader.roundPrices` z przeglądarki: kwoty do groszy, rabaty do 4 miejsc. */
function configuratorRound(value, paramName) {
  if (isNaN(value) || value === null || value === '') return value;
  const factor = String(paramName).includes('RABAT') ? 10000 : 100;
  return Math.round(parseFloat(value) * factor) / factor;
}

/**
 * Kwota, którą konfigurator pokaże dla konfiguracji, w której suma sekcji
 * wynosi `sectionSum` (np. jedna sekcja z v, n=1): mnożnik wariantu, podwyżka
 * klienta, `toFixed(fr)` skryptu, a na końcu zaokrąglenie przeglądarki.
 */
function finalAmount(model, sectionSum, increase = { f: 1, fr: -1 }) {
  let total = sectionSum;
  if (model.factor) total = applyOp(total, model.factor.op, model.factor.value);
  if (model.increase) {
    total = total * increase.f;
    if (model.increase.rounding && increase.fr !== -1) total = total.toFixed(increase.fr);
  }
  return configuratorRound(total, model.param);
}

/** Numeryczna wartość wpisu tabeli tak, jak policzy ją `v*n` (formuły liczy wołający). */
function literalNumber(value) {
  if ('num' in value) return value.num;
  if ('str' in value) return value.str * 1;
  return null;
}

/**
 * Łańcuch `if(axis<=B)… else if…`: pierwszy pasujący wpis albo null (v zostaje 0).
 * Próg-zmienna (np. `y<=PG3`) zależy od stanu skryptu w chwili wykonania: bez
 * `resolveRef` zwracamy `{ unknown }`, żeby wołający nie pokazał zmyślonej kwoty.
 */
function pickEntry(entries, axisValue, resolveRef) {
  for (const entry of entries) {
    let bound = entry.bound;
    if (bound && bound.ref) {
      const resolved = resolveRef(bound.ref);
      if (resolved && resolved.unknown) return resolved;
      bound = resolved.value;
    }
    // eslint-disable-next-line eqeqeq
    if (entry.op === '<=' ? axisValue <= bound : axisValue == bound) return entry;
  }
  return null;
}

/** Wpis tabeli sekcji dla współrzędnych (x, y) — semantyka łańcuchów skryptu. */
function lookupEntry(section, x, y, resolveRef) {
  const value = section.value;
  const refs = resolveRef || ((name) => (name === 'x' ? { value: x } : name === 'y' ? { value: y } : { unknown: name }));
  if (value.kind === 'none') return null;
  if (value.kind === 'const') return { value: value.value };
  if (value.kind === 'x') return pickEntry(value.entries, x, refs);
  if (value.kind === 'y') return pickEntry(value.entries, y, refs);
  for (const column of value.columns) {
    if (x <= column.bound) return pickEntry(column.rows, y, refs);
  }
  return null;
}

/**
 * Interpreter modelu: liczy jedną konfigurację tak, jak zrobiłby to skrypt.
 * Warunki i wzory idą przez `evaluate` (FormulaHandler konfiguratora), `x`/`y`
 * przechodzą między sekcjami jak zmienne funkcji, powtórzona sekcja nadpisuje
 * poprzednią, zmienna przed swoją deklaracją ma wartość `undefined` (hoisting
 * `var`), suma idzie od lewej. Służy do dowodu „model ≡ skrypt” i do kwot,
 * które zależą od konfiguracji (dopłaty liczone wzorem).
 *
 * @returns {{ total:any, amount:any, sections:Object<string,number> }|{ error:string }}
 */
function runModel(model, obj, evaluate, increase = { f: 1, fr: -1 }) {
  const declared = new Set(model.sections.map((s) => s.name));
  const scope = Object.create(null);
  let x = null;
  let y = null;
  const valueOf = (value) => {
    if ('formula' in value) return evaluate(value.formula, obj);
    return 'num' in value ? value.num : value.str;
  };
  const resolveRef = (name) => {
    if (name === 'x') return { value: x };
    if (name === 'y') return { value: y };
    if (name in scope) return { value: scope[name] };
    if (declared.has(name)) return { value: undefined };
    return { unknown: name };
  };

  for (const section of model.sections) {
    let n = section.nInit;
    for (const condition of section.conditions) if (valueOf(condition)) n = n + 1;
    if (section.axisX) x = valueOf(section.axisX);
    if (section.axisY) y = valueOf(section.axisY);
    let v = 0;
    const entry = lookupEntry(section, x, y, resolveRef);
    if (entry && entry.unknown) return { error: `próg zależny od zmiennej ${entry.unknown}` };
    if (entry) v = valueOf(entry.value);
    scope[section.name] = v * n;
  }

  let total;
  for (const [k, name] of model.sum.entries()) {
    if (!(name in scope) && !declared.has(name)) return { error: `suma odwołuje się do ${name}` };
    total = k === 0 ? scope[name] : total + scope[name];
  }
  return { total, amount: finalAmount(model, total, increase), sections: scope };
}

module.exports = {
  parseScript,
  parseValue,
  dateKeyOf,
  increaseFor,
  finalAmount,
  configuratorRound,
  literalNumber,
  lookupEntry,
  runModel
};
