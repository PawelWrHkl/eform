/**
 * Ustalenie wersji reguł (`param.txt` + `paramdict.txt`), którą da się
 * FAKTYCZNIE wczytać z udziału.
 *
 * ⚠️ PO CO TO ISTNIEJE: pozycja w bazie trzyma numer wersji z chwili zapisu
 * (`order_item.ver`), a stare wersje znikają z `config.dataDir`. Zmierzone
 * 2026-09-21: **221 z 1191** par (grupa, wersja) nie ma katalogu w `datatest`,
 * a **101 par nie ma go w ŻADNYM** środowisku — dotyczy to **522 zapisanych
 * pozycji**, najnowsze z lutego 2026.
 *
 * Skutek bez tego modułu: `formTools/dataLoader.js parseData()` zwraca `null`,
 * bo `fetch` na nieistniejący plik daje 404, a `form.js generateForm()` pada
 * na `data.dictValues`. Użytkownik otwierający taką pozycję do edycji dostaje
 * MARTWY ekran — nie komunikat, tylko wyjątek w konsoli. Ta sama ścieżka
 * przewracała też przeliczanie i testera konfiguratora.
 *
 * Zasada: wersja żądana, jeśli jest na dysku; w przeciwnym razie NAJNOWSZA,
 * która jest — i wołający MUSI dostać informację, że podmieniliśmy (`fallback`),
 * żeby dało się to pokazać człowiekowi. Nigdy nie podmieniamy po cichu: reguły
 * innej wersji mogą wycenić pozycję inaczej niż w dniu zamówienia.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./../config');

const RULE_FILES = ['param.txt', 'paramdict.txt'];

/** Katalog reguł jednej wersji i języka. */
function rulesDir(baseDir, groupNumber, version, lang) {
  return path.join(baseDir, String(groupNumber), 'data', 'versions', String(version), lang || 'pl');
}

/**
 * Czy OBA pliki reguł są na miejscu. Sam katalog nie wystarcza — zdarzają się
 * puste (np. przerwana synchronizacja), a `generateForm` pada tak samo.
 */
function hasRules(groupNumber, version, lang, baseDir = dataDir) {
  if (!groupNumber || !version) return false;
  const dir = rulesDir(baseDir, groupNumber, version, lang);
  try {
    return RULE_FILES.every((f) => fs.statSync(path.join(dir, f)).size > 0);
  } catch (_e) {
    return false;
  }
}

/**
 * Porównanie numerów wersji po CZŁONACH LICZBOWO, nie tekstowo.
 * Tekstowo „0.3.61" wypada po „0.3.600", więc sortowanie leksykograficzne
 * wskazywałoby złą „najnowszą" wersję.
 */
function compareVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    const va = Number.isNaN(na) ? -1 : na;
    const vb = Number.isNaN(nb) ? -1 : nb;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** Wersje grupy, które mają komplet reguł w danym języku — od najnowszej. */
function listUsableVersions(groupNumber, lang, baseDir = dataDir) {
  const dir = path.join(baseDir, String(groupNumber), 'data', 'versions');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_e) {
    return [];
  }
  return entries
    .filter((v) => hasRules(groupNumber, v, lang, baseDir))
    .sort(compareVersions)
    .reverse();
}

/**
 * @returns {{version:string|null, requested:string|null, fallback:boolean, reason:string|null}}
 *  `version === null` znaczy, że grupa nie ma na dysku ŻADNEJ wczytywalnej
 *  wersji — wtedy nie ma czym podmienić i wołający musi to pokazać jako błąd,
 *  a nie udawać, że da się otworzyć formularz.
 */
function resolveUsableVersion(groupNumber, requestedVersion, lang, baseDir = dataDir) {
  if (requestedVersion && hasRules(groupNumber, requestedVersion, lang, baseDir)) {
    return { version: String(requestedVersion), requested: String(requestedVersion), fallback: false, reason: null };
  }

  const dostepne = listUsableVersions(groupNumber, lang, baseDir);
  if (!dostepne.length) {
    return {
      version: null,
      requested: requestedVersion ? String(requestedVersion) : null,
      fallback: false,
      reason: `grupa ${groupNumber}: brak na dysku jakichkolwiek reguł w języku ${lang || 'pl'}`
    };
  }

  return {
    version: dostepne[0],
    requested: requestedVersion ? String(requestedVersion) : null,
    fallback: !!requestedVersion,
    reason: requestedVersion
      ? `brak reguł wersji ${requestedVersion} — użyto najnowszej dostępnej ${dostepne[0]}`
      : null
  };
}

module.exports = { hasRules, listUsableVersions, resolveUsableVersion, compareVersions };
