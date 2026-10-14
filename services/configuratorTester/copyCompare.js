/**
 * Porównanie dwóch zapisanych pozycji pole po polu — wyrocznia robota
 * kopiowania (copyLineRunner.js).
 *
 * Zasada: kopia zapisana BEZ żadnej zmiany ma być identyczna z oryginałem —
 * wartości, opisy opcji (to, co widać w tabeli zlecenia i na PDF), widoczność
 * pól, pola liczone i ceny. Każda różnica jest błędem kopiowania albo zapisu.
 *
 * Rodzaje różnic (kod zgłoszenia = `KOPIA_<rodzaj>`):
 *  - BRAK_POLA            wartość była, w kopii jej nie ma (zgłoszenie Ryver)
 *  - ZMIANA_WARTOSCI      pole wybierane przez klienta ma inną wartość
 *  - NOWE_POLE            w kopii pojawiła się wartość, której oryginał nie miał
 *  - ZMIANA_CENY          cena / dopłata / suma albo kolumny cenowe wiersza
 *  - ZMIANA_POLA_LICZONEGO pole wyliczane formułą lub skryptem
 *  - OPIS_BEZ_WARTOSCI    wartość zapisana, a opis bez `option_value` — tabela
 *                         zlecenia i PDF pokazują „-" (błąd z 13.10)
 *  - ZMIANA_OPISU         inny opis opcji / alias
 *  - ZMIANA_WIDOCZNOSCI   pole schowane albo odsłonięte
 *  - ZMIANA_VAT_RABATU    pola VAT / rabatu klienta, które eForm dokłada poza
 *                         regułami grupy (createForm.js EXTRA_PRICE_FIELD_IDS) —
 *                         osobno i nisko, bo zależą od VAT_ENABLED (lokalnie
 *                         true, produkcja false): 14.10 strona edycji wpisywała
 *                         brutto od razu, nowa pozycja zapisana bez zmian — nie
 */

'use strict';

const parseJson = (j) => {
  for (let i = 0; i < 3 && typeof j === 'string'; i++) {
    try { j = JSON.parse(j); } catch { return null; }
  }
  return j;
};

const KIND = Object.freeze({
  MISSING: 'BRAK_POLA',
  CHANGED: 'ZMIANA_WARTOSCI',
  ADDED: 'NOWE_POLE',
  PRICE: 'ZMIANA_CENY',
  CALCULATED: 'ZMIANA_POLA_LICZONEGO',
  NO_OPTION_VALUE: 'OPIS_BEZ_WARTOSCI',
  DESCRIPTION: 'ZMIANA_OPISU',
  VISIBILITY: 'ZMIANA_WIDOCZNOSCI',
  VAT: 'ZMIANA_VAT_RABATU'
});

const KIND_PRIORITY = Object.freeze({
  [KIND.MISSING]: 'P1',
  [KIND.CHANGED]: 'P1',
  [KIND.PRICE]: 'P1',
  [KIND.NO_OPTION_VALUE]: 'P1',
  [KIND.ADDED]: 'HIGH',
  [KIND.CALCULATED]: 'HIGH',
  [KIND.DESCRIPTION]: 'HIGH',
  [KIND.VISIBILITY]: 'MEDIUM',
  [KIND.VAT]: 'MEDIUM'
});

const KIND_LABEL = Object.freeze({
  [KIND.MISSING]: 'zgubione pola',
  [KIND.CHANGED]: 'zmienione wartości',
  [KIND.ADDED]: 'wartości dopisane w kopii',
  [KIND.PRICE]: 'zmienione ceny',
  [KIND.CALCULATED]: 'zmienione pola liczone',
  [KIND.NO_OPTION_VALUE]: 'opis bez wartości (tabela i PDF pokażą „-")',
  [KIND.DESCRIPTION]: 'zmienione opisy opcji',
  [KIND.VISIBILITY]: 'zmieniona widoczność pól',
  [KIND.VAT]: 'pola VAT / rabatu klienta (zależne od VAT_ENABLED)'
});

/** Klucze techniczne — tytuły i flagi słownika zależą od reguł, nie od pozycji. */
const IGNORED_SUFFIXES = ['___TITLE', '___DICT'];
const IGNORED_KEYS = new Set(['uid', 'uid___VISIBLE', 'uid___DESCRIPTION', 'uid_ALIAS']);
/** Cena po nazwie — także wtedy, gdy definicje pól (`window.params`) jej nie oznaczają. */
const PRICE_NAME = /^(SUB___)?(CENA|DOPLATA|SUMA|WARTOSC)/;
const PRICE_COLUMNS = ['unit_price', 'total_price', 'total_price_sub'];
/** Kopia `EXTRA_PRICE_FIELD_IDS` z public/scripts/formTools/createForm.js. */
const VAT_FIELDS = new Set(['VAT', 'WARTOSC_VAT', 'WARTOSC_BRUTTO', 'RABAT_KLIENTA', 'WARTOSC_PO_RABACIE']);

const stripSub = (name) => name.replace(/^SUB___/, '');
const isEmpty = (v) => v === undefined || v === null || v === '';

/** Ta sama wartość: 910 i "910" tak, 43.53 i 43.5300001 tak, "" i brak tak. */
function sameValue(a, b) {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (isEmpty(a) !== isEmpty(b)) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa === sb) return true;
  const na = Number(sa.replace(',', '.'));
  const nb = Number(sb.replace(',', '.'));
  return sa !== '' && sb !== '' && Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.005;
}

/**
 * @param {string} name klucz z `json_parameters`
 * @param {{price?: Set<string>, calculated?: Set<string>}} meta z `window.params`
 * @returns {null|'visibility'|'description'|'price'|'calculated'|'input'}
 */
function classifyKey(name, meta = {}) {
  if (IGNORED_KEYS.has(name) || IGNORED_SUFFIXES.some((s) => name.endsWith(s))) return null;
  if (VAT_FIELDS.has(name.replace(/(___VISIBLE|___DESCRIPTION|_ALIAS)$/, ''))) return 'vat';
  if (name.endsWith('___VISIBLE')) return 'visibility';
  if (name.endsWith('___DESCRIPTION') || name.endsWith('_ALIAS')) return 'description';
  const base = stripSub(name);
  const isPrice = PRICE_NAME.test(name) || !!(meta.price && (meta.price.has(name) || meta.price.has(base)));
  if (isPrice) return 'price';
  if (name.startsWith('SUB___')) return 'calculated';
  if (meta.calculated && (meta.calculated.has(name) || meta.calculated.has(base))) return 'calculated';
  return 'input';
}

function readRow(row) {
  return {
    values: parseJson(row && row.json_parameters) || {},
    display: new Map(parseJson(row && row.json_parameters_desc) || [])
  };
}

/**
 * Pola zapisane z wartością, widoczne, a w opisie bez `option_value` —
 * podpis błędu z 13.10 (tabela zlecenia i PDF: „-").
 */
function missingDescriptions(row, calculated = []) {
  const { values, display } = readRow(row);
  const skip = calculated instanceof Set ? calculated : new Set(calculated);
  const out = [];
  for (const [name, value] of Object.entries(values)) {
    if (name.includes('___') || name.endsWith('_ALIAS') || name.startsWith('SUB___') || name === 'uid') continue;
    if (skip.has(name)) continue;
    if (isEmpty(value) || typeof value === 'object') continue;
    if (values[`${name}___VISIBLE`] !== true) continue;
    const entry = display.get(name);
    if (entry && typeof entry === 'object' && String(entry.row ?? '1') === '1' && !('option_value' in entry)) out.push(name);
  }
  return out;
}

/**
 * Oryginał kontra kopia — wiersze `order_item` (json_parameters,
 * json_parameters_desc, kolumny cen).
 *
 * @param {object} baseline wiersz oryginału
 * @param {object} copy wiersz kopii
 * @param {object} [opts]
 * @param {{price?: Set<string>, calculated?: Set<string>}} [opts.meta]
 * @param {boolean} [opts.compareComment] komentarz (przenosi go tylko „Duplikuj")
 * @returns {{differences: Array<{kind:string, field:string, before:*, after:*}>, compared: number}}
 */
function compareSavedPositions(baseline, copy, { meta = {}, compareComment = false } = {}) {
  const a = readRow(baseline);
  const b = readRow(copy);
  const differences = [];
  let compared = 0;
  const push = (kind, field, before, after) => differences.push({ kind, field, before, after });

  const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
  for (const name of [...keys].sort()) {
    const cls = classifyKey(name, meta);
    if (!cls) continue;
    compared += 1;
    const before = a.values[name];
    const after = b.values[name];
    if (sameValue(before, after)) continue;
    if (cls === 'vat') push(KIND.VAT, name, before, after);
    else if (cls === 'visibility') push(KIND.VISIBILITY, name.replace(/___VISIBLE$/, ''), before, after);
    else if (cls === 'description') {
      // Inny opis przy innej wartości to skutek zmiany wartości — zgłoszonej osobno.
      const owner = name.replace(/(___DESCRIPTION|_ALIAS)$/, '');
      if (sameValue(a.values[owner], b.values[owner])) push(KIND.DESCRIPTION, name, before, after);
    }
    else if (cls === 'price') push(KIND.PRICE, name, before, after);
    else if (cls === 'calculated') push(KIND.CALCULATED, name, before, after);
    else if (isEmpty(after)) push(KIND.MISSING, name, before, after);
    else if (isEmpty(before)) push(KIND.ADDED, name, before, after);
    else push(KIND.CHANGED, name, before, after);
  }

  // Opisy — to z nich składa się tabela zlecenia i PDF.
  const reported = new Set(differences.map((d) => `${d.kind}|${d.field}`));
  const names = new Set([...a.display.keys(), ...b.display.keys()]);
  for (const name of names) {
    const ea = a.display.get(name) || {};
    const eb = b.display.get(name) || {};
    const row = String(eb.row ?? ea.row ?? '1');
    if (row === '0') continue; // wiersze ukryte — nie trafiają ani do tabeli, ani do PDF
    compared += 1;
    if (!sameValue(ea.option_value, eb.option_value)) {
      const cls = classifyKey(name, meta);
      const kind = cls === 'vat' ? KIND.VAT : row === '2' || cls === 'price' ? KIND.PRICE : null;
      // Wartość wybieraną przez klienta zgłasza już porównanie `json_parameters`;
      // rozjazd samego opisu przy tej samej wartości to osobny błąd.
      if (kind && !reported.has(`${kind}|${name}`)) push(kind, `${name} (opis)`, ea.option_value, eb.option_value);
      else if (!kind && sameValue(a.values[name], b.values[name])) push(KIND.DESCRIPTION, `${name} (opis)`, ea.option_value, eb.option_value);
    }
    if (!sameValue(ea.option_description, eb.option_description)
      && sameValue(a.values[name], b.values[name])
      && !reported.has(`${KIND.DESCRIPTION}|${name}___DESCRIPTION`)) {
      push(KIND.DESCRIPTION, `${name} (opis opcji)`, ea.option_description, eb.option_description);
    }
  }

  const calculated = meta.calculated || new Set();
  const lostBefore = new Set(missingDescriptions(baseline, calculated));
  for (const name of missingDescriptions(copy, calculated)) {
    if (!lostBefore.has(name)) push(KIND.NO_OPTION_VALUE, name, a.values[name], b.values[name]);
  }

  for (const col of PRICE_COLUMNS) {
    compared += 1;
    if (!sameValue(baseline && baseline[col], copy && copy[col])) push(KIND.PRICE, `${col} (kolumna)`, baseline[col], copy[col]);
  }
  compared += 1;
  if (!sameValue(baseline && baseline.amount, copy && copy.amount)) push(KIND.CHANGED, 'amount (ilość)', baseline.amount, copy.amount);
  if (compareComment) {
    compared += 1;
    if (!sameValue(baseline && baseline.comment, copy && copy.comment)) push(KIND.CHANGED, 'comment (komentarz)', baseline.comment, copy.comment);
  }

  return { differences, compared };
}

const short = (v) => {
  if (v === undefined) return '(brak)';
  if (v === '' || v === null) return '(puste)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/** Jedna linijka na rodzaj różnicy — do raportu i na konsolę. */
function summarizeDifferences(differences) {
  const byKind = new Map();
  for (const d of differences) {
    if (!byKind.has(d.kind)) byKind.set(d.kind, []);
    byKind.get(d.kind).push(d);
  }
  return [...byKind.entries()].map(([kind, list]) => ({
    kind,
    priority: KIND_PRIORITY[kind] || 'MEDIUM',
    fields: list.map((d) => d.field),
    text: `${KIND_LABEL[kind] || kind}: ${list.map((d) => `${d.field} ${short(d.before)} → ${short(d.after)}`).join('; ')}`
  }));
}

module.exports = {
  KIND,
  KIND_PRIORITY,
  KIND_LABEL,
  parseJson,
  sameValue,
  classifyKey,
  missingDescriptions,
  compareSavedPositions,
  summarizeDifferences
};
