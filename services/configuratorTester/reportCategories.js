/**
 * Podział zgłoszeń robota na trzy kategorie raportu i dane do ich opisania
 * po ludzku (nazwy działów, produktów, pól i wartości).
 *
 * ⚠️ Kolejność kategorii to decyzja właściciela (2026-10-12):
 *  1. **Ślepe zaułki** — NA GÓRZE, główna kategoria: miejsca, w których
 *     formularz nie puszcza klienta dalej. Każdy z pełną ścieżką: dział,
 *     produkt, model, wybrana konfiguracja i pole, na którym stanęło.
 *  2. **Błędy cen i ceny zerowe**.
 *  3. **Pozostałe** — na samym dole.
 * Od 2026-10-14 między cenami a pozostałymi stoi **Kopiowanie pozycji**
 * (kody `KOPIA_*`, robot copyLineRunner.js) — pozostałe zostają na dole.
 *
 * Nieznany kod (nowy typ zgłoszenia) trafia do „pozostałych" — lepiej, żeby
 * był widoczny na dole, niż żeby zniknął albo udawał ślepy zaułek.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../config');

const CATEGORY = Object.freeze({
  DEAD_END: 'zaulek',
  PRICE: 'ceny',
  // Robot kopiowania pozycji (od 2026-10-14) — w mailu między cenami
  // a „pozostałymi", które zostają na samym dole.
  COPY: 'kopiowanie',
  OTHER: 'pozostale'
});

/** Formularz nie puszcza dalej: nie da się wybrać, zapisać albo w ogóle skonfigurować. */
const DEAD_END_CODES = new Set([
  'KONFIGURATOR_NIE_PUSZCZA_DALEJ',
  'WALIDACJA_ODRZUCA_KONFIGURACJE',
  'BLOKADA_ZAPISU',
  'PRZEGLADARKA_FORMULARZ_SIE_NIE_ZBUDOWAL',
  'PRZEGLADARKA_PRZELICZANIE_NIE_KONCZY_SIE'
]);

/**
 * Wpisy o cenach, które same deklarują, że błędem NIE są — w kategorii cen
 * zaśmiecałyby listę (12.10: 22 z 49 wpisów „cenowych"), więc idą do
 * pozostałych. Zero przy NIEKOMPLETNEJ konfiguracji to skutek niewypełnionego
 * pola — robot sam oznacza to jako „nie dowód błędu wyceny".
 */
const NOT_A_PRICE_ERROR = new Set([
  'BRAK_CENY_PRZY_NIEKOMPLETNEJ_KONFIGURACJI',
  // Komunikat tego wpisu sam mówi „poza tabelą cennika ani cennik, ani
  // wdrożony skrypt nic nie naliczają — to zachowanie poprawne".
  'WYMIAR_POZA_CENNIKIEM_DO_SPRAWDZENIA',
  // Wzorzec z FORMUŁY w komórce arkusza: znane przesunięcie ~2.9% (dopłata
  // liczona od ceny przed czynnikiem per-uid) — robot z założenia nigdy nie
  // daje tu P1.
  'CENA_POCHODNA_DO_SPRAWDZENIA',
  // Rozjazd silnika bezgłowego robota z wdrożonym skryptem — problem narzędzia
  // testowego, nie ceny, którą widzi klient.
  'PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM'
]);

const PRICE_PREFIXES = ['BRAK_CENY', 'CENA_', 'WYMIAR_POZA_CENNIKIEM', 'SKRYPT_CENOWY'];
const PRICE_CODES = new Set(['PRZELICZENIE_NIEZGODNE_ZE_SKRYPTEM', 'KOSZYK_NIESPOJNY']);

function categorize(code) {
  const c = String(code || '');
  if (c.startsWith('KOPIA_')) return CATEGORY.COPY;
  if (DEAD_END_CODES.has(c)) return CATEGORY.DEAD_END;
  if (NOT_A_PRICE_ERROR.has(c)) return CATEGORY.OTHER;
  if (PRICE_CODES.has(c) || PRICE_PREFIXES.some((p) => c.startsWith(p))) return CATEGORY.PRICE;
  return CATEGORY.OTHER;
}

const PRIORITY_ORDER = { P1: 0, HIGH: 1, MEDIUM: 2 };

/** Najpierw najpoważniejsze, w ich obrębie po numerze grupy — żeby produkt był w jednym miejscu. */
function compareFindings(a, b) {
  const pa = PRIORITY_ORDER[a.priority] ?? 9;
  const pb = PRIORITY_ORDER[b.priority] ?? 9;
  if (pa !== pb) return pa - pb;
  return String(a.groupNumber ?? '').localeCompare(String(b.groupNumber ?? ''), 'pl', { numeric: true });
}

/** @returns {{zaulek: Array, ceny: Array, kopiowanie: Array, pozostale: Array}} */
function splitByCategory(findings) {
  const out = { [CATEGORY.DEAD_END]: [], [CATEGORY.PRICE]: [], [CATEGORY.COPY]: [], [CATEGORY.OTHER]: [] };
  for (const f of findings || []) out[categorize(f.code)].push(f);
  for (const list of Object.values(out)) list.sort(compareFindings);
  return out;
}

/**
 * Nazwy działów i produktów z bazy (`product_group` + `department`), po polsku.
 * Baza bywa niedostępna (testy, awaria) — wtedy raport zostaje z numerami,
 * zamiast nie wyjść wcale.
 *
 * @returns {Promise<Map<string, {product: string, department: string}>>}
 */
async function loadProductNames({ select } = {}) {
  const names = new Map();
  try {
    const query = select || require('../../db/core').selectQuery;
    const rows = await query(
      'SELECT g.group_number, g.name_pl AS product, d.name_pl AS department '
      + 'FROM product_group g LEFT JOIN department d ON d.id = g.department_id', []
    );
    for (const r of rows || []) {
      names.set(String(r.group_number), { product: r.product || '', department: r.department || '' });
    }
  } catch (_e) { /* bez nazw — zostają numery */ }
  return names;
}

/** Najnowsza wersja reguł grupy z kompletem plików (ta, którą widzi dziś klient). */
function newestRulesDir(groupNumber, lang) {
  try {
    const { listUsableVersions } = require('../rulesVersion');
    const v = listUsableVersions(groupNumber, lang)[0];
    return v ? path.join(dataDir, String(groupNumber), 'data', 'versions', v, lang) : null;
  } catch (_e) {
    return null;
  }
}

const labelCache = new Map();

/**
 * Opisy pól (`param.txt` DESCRIPTION) i wartości (`paramdict.txt`
 * `<POLE>_DESCRIPTION`) jednej grupy — żeby w ścieżce stało
 * „MODEL = FLEX (ZASŁONA FLEX)", a nie samo „FLEX".
 *
 * @returns {{field: (name:string)=>string, value: (name:string, v:string)=>string}}
 */
function loadLabels(groupNumber, lang = 'pl') {
  const key = `${groupNumber}|${lang}`;
  if (labelCache.has(key)) return labelCache.get(key);

  const fields = {};
  const values = {};
  const dir = newestRulesDir(groupNumber, lang);
  if (dir) {
    try {
      const rows = fs.readFileSync(path.join(dir, 'param.txt'), 'utf8').split('\n').map((l) => l.replace(/\r$/, '').split('\t'));
      const head = rows[0] || [];
      const iName = head.indexOf('NAME');
      const iDesc = head.indexOf('DESCRIPTION');
      for (const r of rows.slice(1)) {
        if (r[iName] && r[iDesc] && r[iDesc] !== '<NULL>') fields[r[iName]] = r[iDesc];
      }
    } catch (_e) { /* brak opisów pól */ }
    try {
      const rows = fs.readFileSync(path.join(dir, 'paramdict.txt'), 'utf8').split('\n').map((l) => l.replace(/\r$/, '').split('\t'));
      const head = rows[0] || [];
      head.forEach((col, i) => {
        const m = /^(.+)_VALUE$/.exec(col);
        if (!m) return;
        const iDesc = head.indexOf(`${m[1]}_DESCRIPTION`);
        if (iDesc === -1) return;
        const map = {};
        for (const r of rows.slice(1)) {
          if (r[i] && r[i] !== '<NULL>' && r[iDesc] && r[iDesc] !== '<NULL>') map[r[i]] = r[iDesc];
        }
        values[m[1]] = map;
      });
    } catch (_e) { /* brak opisów wartości */ }
  }

  const labels = {
    field: (name) => fields[name] || '',
    value: (name, v) => ((values[name] || {})[v]) || ''
  };
  labelCache.set(key, labels);
  return labels;
}

module.exports = { CATEGORY, categorize, splitByCategory, compareFindings, loadProductNames, loadLabels };
