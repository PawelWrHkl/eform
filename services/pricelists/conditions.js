'use strict';

/**
 * Warunek sekcji („Kiedy-występuje”) rozłożony na klauzule, żeby cennik mógł
 * złożyć sekcje w tabele (rodzina modeli × grupa cenowa) i opisać je słowami.
 *
 * Tu jest tylko struktura. Czy dana opcja spełnia klauzulę, liczy prawdziwy
 * evaluator konfiguratora na tekście klauzuli (`text`): WSROD nie przycina
 * spacji, więc " F3SF" na liście nie pasuje do niczego — odtwarzanie tego
 * ręcznie byłoby drugą implementacją z własnymi błędami.
 */

/** Argumenty wywołania na najwyższym poziomie, z poszanowaniem nawiasów i cudzysłowów. */
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    else if (!quoted && depth === 0 && ch === ',') {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

/** `NAZWA(argumenty)` obejmujące CAŁY tekst albo null. */
function parseCall(text) {
  const m = /^([A-Za-z0-9_]+)\(([\s\S]*)\)$/.exec(String(text).trim());
  if (!m) return null;
  // Nawias zamykający musi domykać ten otwarty zaraz po nazwie.
  let depth = 0;
  let quoted = false;
  const body = m[2];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')' && --depth < 0) return null;
  }
  return { name: m[1].toUpperCase(), args: splitArgs(body) };
}

const unquote = (s) => {
  const m = /^"([\s\S]*)"$/.exec(String(s).trim());
  return m ? m[1] : null;
};

/** `X___DESCRIPTION` / `X_ALIAS___DESCRIPTION` → `X`. */
const descriptionParam = (name) => {
  const m = /^([A-Za-z0-9_]+?)(_ALIAS)?___DESCRIPTION$/.exec(name || '');
  return m ? m[1] : null;
};

/**
 * @returns {Array<{kind:'filter',fn:string,param:string,list:string,negated:boolean,text:string}
 *   |{kind:'priceGroup',param:string,token:string,text:string}
 *   |{kind:'raw',text:string}>}
 */
function clausesOf(formula) {
  const text = String(formula || '').trim().replace(/^=/, '');
  const call = parseCall(text);
  if (!call) return [{ kind: 'raw', text }];

  if (call.name === 'AND' || call.name === 'ORAZ') return call.args.flatMap(clausesOf);

  if (call.name === 'NOT' && call.args.length === 1) {
    const inner = clausesOf(call.args[0]);
    if (inner.length === 1 && inner[0].kind === 'filter') return [{ ...inner[0], negated: !inner[0].negated, text }];
    return [{ kind: 'raw', text }];
  }

  if (['WSROD', 'NIEWSROD', 'ZAWIERA'].includes(call.name) && call.args.length === 2) {
    const list = unquote(call.args[1]);
    const param = /^[A-Za-z0-9_]+$/.test(call.args[0]) ? call.args[0] : null;
    if (param && list !== null) {
      const group = call.name === 'ZAWIERA' ? descriptionParam(param) : null;
      if (group && list.startsWith('#')) return [{ kind: 'priceGroup', param: group, token: list.slice(1), text }];
      return [{ kind: 'filter', fn: call.name === 'NIEWSROD' ? 'WSROD' : call.name, param, list, negated: call.name === 'NIEWSROD', text }];
    }
  }

  // IF(X_ALIAS___DESCRIPTION<>"",ZAWIERA(X_ALIAS___DESCRIPTION,"#T"),ZAWIERA(X___DESCRIPTION,"#T"))
  if (call.name === 'IF' && call.args.length === 3) {
    const a = clausesOf(call.args[1]);
    const b = clausesOf(call.args[2]);
    if (a.length === 1 && b.length === 1 && a[0].kind === 'priceGroup' && b[0].kind === 'priceGroup' &&
      a[0].param === b[0].param && a[0].token === b[0].token) {
      return [{ kind: 'priceGroup', param: a[0].param, token: a[0].token, text }];
    }
  }

  return [{ kind: 'raw', text }];
}

/**
 * Klucz rodziny: warunki sekcji bez tokenu grupy cenowej + osie. Sekcje PGE…PG6
 * jednego modelu różnią się wyłącznie `#E`…`#6`, więc lądują w jednej tabeli.
 */
function familyOf(section) {
  const conditions = section.conditions.map((c) => (c.formula ? clausesOf(c.formula) : [{ kind: 'raw', text: JSON.stringify(c) }]));
  const groups = conditions.map((clauses) => clauses.find((c) => c.kind === 'priceGroup') || null);
  const key = JSON.stringify([
    conditions.map((clauses) => clauses.map((c) => (c.kind === 'priceGroup' ? `PG:${c.param}` : c.text))),
    section.axisX,
    section.axisY
  ]);
  return {
    key,
    conditions,
    // Grupa cenowa = token pierwszej tkaniny; druga (np. KOLOR_DODATKOWY) liczy
    // tę samą sekcję drugi raz, gdy jest z tej samej grupy.
    priceGroup: groups[0] ? groups[0].token : null,
    fabricParams: groups.filter(Boolean).map((g) => g.param)
  };
}

module.exports = { clausesOf, familyOf, splitArgs, parseCall, descriptionParam };
