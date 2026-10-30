const _ = require("n_");
const { features } = require('../config');
const { withCurrencyLabel, isMonetaryParamName } = require('./currency');
const { HKL_ORG_ID } = require('./subPrices');

/** VAT ceny klienta zapisany przy pozycji (pricesCalculator.js) — nie pokazujemy go per pozycja. */
const SUB_VAT_KEYS = new Set(['SUB___VAT', 'SUB___WARTOSC_VAT', 'SUB___WARTOSC_BRUTTO']);

/**
 * VAT cen ZWYKŁYCH zapisany przy pozycji klienta HKL (pricesCalculator.js
 * `applyVatToGrossValue`, tor `SUMA_BRUTTO`). Też nie per pozycja — VAT jest
 * tylko w sumie zlecenia (właściciel 2026-10-27: „ma być ukryte jak w reszcie,
 * tylko w total widoczne”). Żaden `param.txt` nie ma parametrów o tych nazwach
 * (sprawdzone na datatest) — dopisuje je wyłącznie kalkulator VAT.
 */
const REGULAR_VAT_KEYS = new Set(['VAT', 'WARTOSC_VAT', 'WARTOSC_BRUTTO']);

/** Wszystkie klucze VAT pozycji — także dla strony wysłanej pozycji (routes/positions.js). */
const POSITION_VAT_KEYS = new Set([...SUB_VAT_KEYS, ...REGULAR_VAT_KEYS]);

// Rabat klienta grupy zapisany przed zmianą nazw kluczy — patrz niżej.
const LEGACY_CLIENT_DISCOUNT_KEYS = new Set(['RABAT_KLIENTA', 'WARTOSC_PO_RABACIE']);
const CLIENT_DISCOUNT_KEYS = new Set(['SUB___RABAT_KLIENTA', 'SUB___WARTOSC_PO_RABACIE']);

/**
 * Parametr WYŁĄCZONY w tej konfiguracji (warunek ENABLE z param.txt niespełniony):
 * w `json_parameters` ma pustą wartość, a do opisu pozycji i tak trafia jego
 * DEFAULT „0”. Np. `SZEROKOSC_DACH`/`WYSOKOSC_DACH` żaluzji 16/25 (tylko modele
 * dachowe U16DF/U25DF, LISTROW 2) wychodziły przy każdej innej żaluzji w wierszu
 * cen zwykłych jako „SZEROKOSC [MM]: 0 / WYSOKOSC [MM]: 0” (zgłoszenie właściciela
 * 2026-10-27: „niepotrzebne”). Tylko parametry niekwotowe (wymiary, ilości,
 * powierzchnie) — kwoty i rabaty mają własne reguły pokazywania. Zapis pozycji
 * bez zmian; to filtr wyświetlania, więc działa też na pozycjach zapisanych wcześniej.
 * W tabeli zlecenia komórka dostaje „-” (klucz zostaje — inaczej pozycje z modelem
 * dachowym i bez niego trafiałyby do osobnych tabel), a kolumna pusta we wszystkich
 * wierszach znika w `removeEmptyColumns`.
 *
 * @param {string} key
 * @param {object} param  wiersz `json_parameters_desc`
 * @param {object|string} values  `json_parameters` pozycji
 */
function isDisabledDefaultRow(key, param, values) {
  if (!param || typeof param !== 'object' || String(param.option_value) !== '0') return false;
  if (String(key).startsWith('SUB___') || isMonetaryParamName(key) || isRabatParamName(key)) return false;
  const engine = parseValues(values);
  return !!engine && engine[key] === '';
}

/** `json_parameters` bywa podwójnie zakodowanym JSON-em (jak opis pozycji). */
function parseValues(values) {
  let v = values;
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch (_e) { return null; }
  }
  return v && typeof v === 'object' ? v : null;
}

function isRabatParamName(key) {
  return !!key && String(key).includes('RABAT');
}

function isZeroRabatDisplayValue(value) {
  if (value === undefined || value === null || value === '-' || value === '') return true;
  const str = String(value).trim();
  const mainPart = str.split('-')[0].trim();
  if (mainPart.includes('%')) {
    const n = parseFloat(mainPart.replace('%', '').replace(',', '.'));
    return Number.isFinite(n) && Math.abs(n) < 0.000001;
  }
  const cleaned = mainPart.replace(/[^\d.,-]/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-') return true;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && Math.abs(n) < 0.000001;
}

function paramOptionValue(param) {
  if (param == null) return null;
  if (typeof param === 'object' && 'option_value' in param) return param.option_value;
  if (typeof param === 'string' || typeof param === 'number') return String(param);
  return null;
}

/**
 * Wiersz specyfikacji ceny (`CENA_S`, `SUB___DOPLATA_S`, … — opis „<cena>-spec")
 * to `<PARAM>_S` stojący obok swojej ceny `<PARAM>` w tej samej pozycji.
 * Wymóg rodzica chroni ewentualny zwykły parametr z końcówką `_S`.
 */
function isPriceSpecRow(key, rows) {
  return typeof key === 'string' && key.endsWith('_S') && rows.has(key.slice(0, -2));
}

/**
 * Przy wyłączonym `PRICE_SPEC_ENABLED` (config.js `features.priceSpec`) wiersze
 * `-spec` znikają też z pozycji zapisanych, zanim flaga została wyłączona —
 * inaczej nadal pokazywałyby się pod kłódką w podglądzie, druku, PDF-ie i mailu.
 */
function dropPriceSpecRows(rows) {
  for (const key of [...rows.keys()]) {
    if (isPriceSpecRow(key, rows)) rows.delete(key);
  }
  return rows;
}

/**
 * @param {object} [options]
 * @param {string} [options.currency] Waluta klienta ZAMÓWIENIA (services/currency.js).
 *   Podana → opisy parametrów kwotowych dostają ją na końcu („LISTENPREIS [€]”
 *   z pozycji zapisanej przed 2026-10-08 → „LISTENPREIS [PLN]”), tak jak sumy
 *   pod tabelą. Tylko wyświetlanie — w bazie nic się nie zmienia. Ta sama
 *   etykieta idzie do nagłówków, kluczy wierszy i list zablokowanych kolumn,
 *   inaczej kłódki przestałyby pasować do nagłówków.
 */
async function jsonTextBackToMap(orderItems, options = {}) {
  const currency = options.currency || null;
  const labelOf = (key, param) => {
    const description = param && param.param_description ? param.param_description : key;
    return currency && isMonetaryParamName(key) ? withCurrencyLabel(description, currency) : description;
  };
  let total = {}
  let cleanOrderItems = [];
  let prevHeaderKeys = [];
  let table = {
    headerKeys1: [],
    headerKeys2: [],
    displayHeaders1: [],
    displayHeaders2: [],
    rows: [],
    locked: [],
    sub: []
  };

  for (let item of orderItems) {
    let parsed = item.json_parameters_desc;
    try {
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (!Array.isArray(parsed)) throw new Error("JSON not in array format");
    } catch (err) {
      parsed = [];
    }

    const jsonParameters = new Map(parsed);
    if (!features.priceSpec) dropPriceSpecRows(jsonParameters);
    const engineValues = parseValues(item.json_parameters);
    let currentHeaderKeys1 = [];
    let currentDisplayHeaders1 = [];
    let currentHeaderKeys2 = [];
    let currentDisplayHeaders2 = [];

    for (const [key, param] of jsonParameters.entries()) {
      if (key.startsWith('SUB___')) continue; // handled separately in subParamValues
      if (isRabatParamName(key) && isZeroRabatDisplayValue(paramOptionValue(param))) continue;

      const display = labelOf(key, param);
      const headerKey = display + "||" + key;
      const rowStr = (param && param.row !== undefined) ? String(param.row) : '1';
      if (rowStr === '0') {
        continue;
      }
      const isRow2 = rowStr === '2';

      if (isRow2) {
        currentHeaderKeys2.push(headerKey);
        currentDisplayHeaders2.push(display);
      } else {
        currentHeaderKeys1.push(headerKey);
        currentDisplayHeaders1.push(display);
      }
    }

    const currentHeaderKeys = currentHeaderKeys1.concat(currentHeaderKeys2);

    if (!areArraysEqual(prevHeaderKeys, currentHeaderKeys)) {
      if (table.rows.length > 0) {
        cleanOrderItems.push(removeEmptyColumns({
          headers1: table.displayHeaders1,
          headers2: table.displayHeaders2,
          headerKeys1: table.headerKeys1,
          headerKeys2: table.headerKeys2,
          rows: table.rows,
          locked: table.locked,
          sub: table.sub
        }));
      }
      table = {
        headerKeys1: currentHeaderKeys1,
        headerKeys2: currentHeaderKeys2,
        displayHeaders1: currentDisplayHeaders1,
        displayHeaders2: currentDisplayHeaders2,
        rows: [],
        locked: table.locked,
        sub: table.sub
      };
    }
    item.lockedParams = []
    item.subParams = []
    item.subParamValues = []
    // Wiersze rabatu klienta grupy trzymamy DODATKOWO osobno, żeby widok pokazał
    // je we WŁASNYM wierszu pod spodem (templates/order.njk), a nie wmieszane
    // między pozostałe ceny SUB. W `subParamValues` zostają, bo z tej listy
    // korzystają jeszcze widok cen (`order_prices.njk`) i `services/subPrices.js`.
    item.clientDiscountValues = []
    item.posId = item.id || 0
    let rowObj = {};
    for (const [key, param] of jsonParameters.entries()) {
      const display = labelOf(key, param);
      const headerKey = display + "||" + key;
      const rowStr = (param && param.row !== undefined) ? String(param.row) : '1';

      let value = "-";
      if (param && typeof param === 'object') {

        if ("row" in param) {
        }
        if ('listsum' in param) {
        }
        if (!('option_value' in param)) {
          value = "-";
        } else if ('option_description' in param && (param['option_description'] != '')) {
          value = `${param.option_value} - ${param.option_description}`;
        } else {
          value = param.option_value;
        }
      } else if (typeof param === 'string' || typeof param === 'number') {
        // Legacy rows where the value was stored as a plain scalar instead of
        // a full {param_description, option_value, …} object. Treat the
        // scalar itself as the option value to avoid `in`-operator crashes.
        value = String(param);
      }
      if (engineValues && isDisabledDefaultRow(key, param, engineValues)) value = '-';

      // ⚠️ Rabat klienta grupy (`LEGACY_CLIENT_DISCOUNT_KEYS`/`SUB___` poniżej)
      // MUSI być sprawdzony PRZED `rowStr === '0'` — te pola nie idą do żadnej
      // tabeli parametrów (own logic: `isZeroRabatDisplayValue`/`value !== '-'`),
      // więc ich `row` bywa `'0'` (spoza layoutu formularza) i ogólny skip niżej
      // wycinałby je po cichu z `clientDiscountValues`, mimo że
      // `services/subPrices.js calcClientDiscountTotal` (czyta ten sam
      // `json_parameters_desc` bez względu na `row`) sumę i tak by policzył —
      // suma w stopce zgadzałaby się, a wiersz przy pozycji by zniknął.

      // Pozycje zapisane PRZED zmianą nazw kluczy (2026-08-21) mają rabat pod
      // `RABAT_KLIENTA`/`WARTOSC_PO_RABACIE`, bez prefiksu `SUB___` — bez tego
      // mapowania wyświetlałyby się w tabeli cen katalogowych i kłódka rabatu
      // nie miałaby czego odsłonić. Wersja bez migracji danych: te dwa klucze
      // wpuszczamy tą samą ścieżką co wiersze `SUB___`, zawsze jako `locked`.
      if (LEGACY_CLIENT_DISCOUNT_KEYS.has(key)) {
        if (isRabatParamName(key) && isZeroRabatDisplayValue(value)) {
          continue;
        }
        if (value !== '-' && value !== null && value !== undefined) {
          const legacyDisplay = labelOf(key, param);
          const legacyEntry = { key: `SUB___${key}`, display: legacyDisplay, value, locked: true };
          item.subParamValues.push(legacyEntry);
          item.clientDiscountValues.push(legacyEntry);
        }
        continue;
      }

      // VAT cen zwykłych pozycji (klient HKL) — ani w tabeli parametrów, ani w
      // wierszu cen; na zleceniu zostaje tylko suma VAT w stopce.
      if (REGULAR_VAT_KEYS.has(key)) continue;

      // SUB___ params: store in subParamValues, skip main table entirely
      if (key.startsWith('SUB___')) {
        // VAT per pozycja NIE idzie do widoku ani do dokumentów (decyzja
        // właściciela 2026-10-27): na zleceniu zostaje tylko suma VAT w stopce
        // (`partials/order_vat_totals.njk`). Wartości zostają w `json_parameters_desc`
        // — formularz pozycji nadal je czyta.
        if (SUB_VAT_KEYS.has(key)) continue;
        if (isRabatParamName(key) && isZeroRabatDisplayValue(value)) {
          continue;
        }
        const isLocked = param && param.locked === true;
        if (value !== '-' && value !== null && value !== undefined) {
          const display = labelOf(key, param);
          // `key` idzie do widoku, bo szablon musi rozpoznać wiersze rabatu
          // klienta (`SUB___RABAT_KLIENTA`/`SUB___WARTOSC_PO_RABACIE`) — one
          // jedne, choć `locked`, mają być dostępne klientowi końcowemu po
          // odsłonięciu kłódką (templates/order.njk).
          const subEntry = { key, display, value, locked: isLocked };
          item.subParamValues.push(subEntry);
          if (CLIENT_DISCOUNT_KEYS.has(key)) {
            item.clientDiscountValues.push(subEntry);
          }
        }
        continue;
      }

      if (rowStr === '0') {
        continue;
      }

      if (isRabatParamName(key) && isZeroRabatDisplayValue(value)) {
        continue;
      }

      if (param && typeof param === 'object') {
        if ('locked' in param && 'param_description' in param) {
          if (param.locked) {
            // Ta sama etykieta co nagłówek (`display`, z walutą klienta); pusty
            // opis zostaje pusty — jak przed walutami.
            const lockedLabel = param.param_description ? display : param.param_description;
            if (!table.locked.includes(lockedLabel)) {
              table.locked.push(lockedLabel)
            }
            item.lockedParams.push(lockedLabel)
          }
        }
      }

      if (!rowObj[headerKey]) {
        rowObj[headerKey] = { row1: null, row2: null };
      }
      const targetRow = (rowStr === '2') ? 'row2' : 'row1';
      const rowToDelete = (rowStr === '2') ? 'row1' : 'row2';
      rowObj[headerKey][targetRow] = value;
      delete rowObj[headerKey][rowToDelete];
    }

    table.rows.push({ item, row: rowObj });

    prevHeaderKeys = currentHeaderKeys;
  }

  if (table.rows.length > 0) {
    cleanOrderItems.push(removeEmptyColumns({
      headers1: table.displayHeaders1,
      headers2: table.displayHeaders2,
      headerKeys1: table.headerKeys1,
      headerKeys2: table.headerKeys2,
      rows: table.rows,
      locked: table.locked,
      sub: table.sub
    }));
  }
  // Check if any price is not numeric
  let anyNonNumeric = false;
  for (const table of cleanOrderItems) {
    for (const rowObj of table.rows) {
      const row2 = rowObj.row.row2 || {};
      for (const priceKey in row2) {
        const priceVal = row2[priceKey];
        // Accept numbers or numeric strings
        if (typeof priceVal === 'number') continue;
        if (typeof priceVal === 'string') {
          // Remove currency, spaces, etc.
          const cleaned = priceVal.replace(/[^0-9.,-]/g, '').replace(',', '.');
          if (cleaned === '' || isNaN(Number(cleaned))) {
            anyNonNumeric = true;
            break;
          }
        } else {
          anyNonNumeric = true;
          break;
        }
      }
      if (anyNonNumeric) break;
    }
    if (anyNonNumeric) break;
  }
  if (anyNonNumeric) {
    total.visible = 'according_to_price';
  }
  dropZeroOnlySubPrices(cleanOrderItems, await hklOrderIdsWithZeroSub(cleanOrderItems));
  return { cleanOrderItems, total };
}

/** Pozycja ma wpisy SUB___, ale żadnej ceny — same zera albo puste wartości. */
function hasOnlyZeroSubPrices(item) {
  const entries = item && item.subParamValues;
  return Array.isArray(entries) && entries.length > 0 && entries.every((e) => {
    const value = String(e.value ?? '').trim();
    return value === '' || parseFloat(value.split(' - ')[0].replace(',', '.')) === 0;
  });
}

/**
 * Klienci organizacji HKL nie mają cen SUB___, a ich pozycje (np. z importu)
 * bywają zapisane z samymi zerami — taka pozycja „nie ma cen SUB” i żaden widok,
 * stopka, PDF ani specyfikacja ich nie pokazuje. Tylko zlecenia HKL: u klienta
 * innej organizacji „ma ceny SUB” chowa ceny zakupu HKL, więc zero tam zostaje.
 *
 * @param {Array} cleanOrderItems  wynik pętli `jsonTextBackToMap` (mutowany)
 * @param {Set<number>} hklOrderIds  zlecenia organizacji HKL
 */
function dropZeroOnlySubPrices(cleanOrderItems, hklOrderIds) {
  for (const table of cleanOrderItems) {
    for (const { item } of table.rows) {
      if (hklOrderIds.has(Number(item.order_id)) && hasOnlyZeroSubPrices(item)) {
        item.subParamValues = [];
        item.clientDiscountValues = [];
      }
    }
  }
}

/** Baza tylko gdy jest co sprawdzać; błąd zapytania = zera zostają (jak dotąd). */
async function hklOrderIdsWithZeroSub(cleanOrderItems) {
  const ids = new Set();
  for (const table of cleanOrderItems) {
    for (const { item } of table.rows) {
      if (item.order_id != null && hasOnlyZeroSubPrices(item)) ids.add(Number(item.order_id));
    }
  }
  if (!ids.size) return ids;
  const { selectQuery } = require('../db/core');
  const rows = await selectQuery('SELECT id FROM `order` WHERE organization_id = ? AND id IN (?)', [HKL_ORG_ID, [...ids]]);
  return new Set((rows || []).map((r) => Number(r.id)));
}

function areArraysEqual(arrA, arrB) {
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (arrA[i] !== arrB[i]) return false;
  }
  return true;
}


function removeEmptyColumns(table) {
  const { headers1 = [], headers2 = [], headerKeys1 = [], headerKeys2 = [], rows } = table;
  const combinedHeaderKeys = headerKeys1.concat(headerKeys2);

  const columnsToRemove = [];

  for (let idx = 0; idx < combinedHeaderKeys.length; idx++) {
    let allEmpty = true;
    const headerKey = combinedHeaderKeys[idx];
    for (const rowObj of rows) {
      const cell = rowObj.row[headerKey];
      const v1 = cell?.row1;
      const v2 = cell?.row2;
      if ((v1 !== "-" && v1 !== undefined && v1 !== null) || (v2 !== "-" && v2 !== undefined && v2 !== null)) {
        allEmpty = false;
        break;
      }
    }
    if (allEmpty) {
      columnsToRemove.push(idx);
    }
  }

  if (columnsToRemove.length === 0) {
    const mappedRows = rows.map(r => {
      const row1 = {};
      const row2 = {};

      const sortedHeaderKeys1 = headerKeys1.slice().sort((a, b) => {
        const cellA = r.row[a] || { row1: "-" };
        const cellB = r.row[b] || { row1: "-" };
        const valA = cellA.row1;
        const valB = cellB.row1;
        const isFormulaA = typeof valA === 'string' && valA.includes('(');
        const isFormulaB = typeof valB === 'string' && valB.includes('(');
        return isFormulaA === isFormulaB ? 0 : (isFormulaA ? 1 : -1);
      });

      const sortedHeaderKeys2 = headerKeys2.slice().sort((a, b) => {
        const cellA = r.row[a] || { row2: "-" };
        const cellB = r.row[b] || { row2: "-" };
        const valA = cellA.row2;
        const valB = cellB.row2;
        const isFormulaA = typeof valA === 'string' && valA.includes('(');
        const isFormulaB = typeof valB === 'string' && valB.includes('(');
        return isFormulaA === isFormulaB ? 0 : (isFormulaA ? 1 : -1);
      });


      for (let i = 0; i < sortedHeaderKeys1.length; i++) {
        const headerKey = sortedHeaderKeys1[i];
        const headerIdx = headerKeys1.indexOf(headerKey);
        const display = headers1[headerIdx];
        const cell = r.row[headerKey] || { row1: "-" };
        const value = cell.row1;

        if (row1[display] !== undefined && typeof value === 'string' && value.includes('(')) {
          continue;
        }
        row1[display] = value;
      }

      for (let i = 0; i < sortedHeaderKeys2.length; i++) {
        const headerKey = sortedHeaderKeys2[i];
        const headerIdx = headerKeys2.indexOf(headerKey);
        const display = headers2[headerIdx];
        const cell = r.row[headerKey] || { row2: "-" };
        const value = cell.row2;

        if (row2[display] !== undefined && typeof value === 'string' && value.includes('(')) {
          continue;
        }
        row2[display] = value;
      }
      return { item: r.item, row: { row1, row2 } };
    });

    return {
      headers1,
      headers2,
      headerKeys1,
      headerKeys2,
      rows: mappedRows,
      locked: table.locked,
      sub: table.sub || []
    };
  }

  const newHeaderKeys1 = headerKeys1.filter((_, idx) => !columnsToRemove.includes(idx));
  const newHeaders1 = headers1.filter((_, idx) => !columnsToRemove.includes(idx));

  const offset = headerKeys1.length;
  const newHeaderKeys2 = headerKeys2.filter((_, idx) => !columnsToRemove.includes(offset + idx));
  const newHeaders2 = headers2.filter((_, idx) => !columnsToRemove.includes(offset + idx));

  const newRows = rows.map(rowObj => {
    const filteredRow = { row1: {}, row2: {} };

    const sortedNewHeaderKeys1 = newHeaderKeys1.slice().sort((a, b) => {
      const cellA = rowObj.row[a] || { row1: "-" };
      const cellB = rowObj.row[b] || { row1: "-" };
      const valA = cellA.row1;
      const valB = cellB.row1;
      const isFormulaA = typeof valA === 'string' && valA.includes('(');
      const isFormulaB = typeof valB === 'string' && valB.includes('(');
      return isFormulaA === isFormulaB ? 0 : (isFormulaA ? 1 : -1);
    });

    const sortedNewHeaderKeys2 = newHeaderKeys2.slice().sort((a, b) => {
      const cellA = rowObj.row[a] || { row2: "-" };
      const cellB = rowObj.row[b] || { row2: "-" };
      const valA = cellA.row2;
      const valB = cellB.row2;
      const isFormulaA = typeof valA === 'string' && valA.includes('(');
      const isFormulaB = typeof valB === 'string' && valB.includes('(');
      return isFormulaA === isFormulaB ? 0 : (isFormulaA ? 1 : -1);
    });

    for (let i = 0; i < sortedNewHeaderKeys1.length; i++) {
      const headerKey = sortedNewHeaderKeys1[i];
      const headerIdx = newHeaderKeys1.indexOf(headerKey);
      const display = newHeaders1[headerIdx];
      const cell = rowObj.row[headerKey] || { row1: "-" };
      const value = cell.row1;

      if (filteredRow.row1[display] !== undefined && typeof value === 'string' && value.includes('(')) {
        continue;
      }
      filteredRow.row1[display] = value;
    }

    for (let i = 0; i < sortedNewHeaderKeys2.length; i++) {
      const headerKey = sortedNewHeaderKeys2[i];
      const headerIdx = newHeaderKeys2.indexOf(headerKey);
      const display = newHeaders2[headerIdx];
      const cell = rowObj.row[headerKey] || { row2: "-" };
      const value = cell.row2;

      if (filteredRow.row2[display] !== undefined && typeof value === 'string' && value.includes('(')) {
        continue;
      }
      filteredRow.row2[display] = value;
    }
    return { item: rowObj.item, row: filteredRow };
  });

  return {
    headers1: newHeaders1,
    headers2: newHeaders2,
    headerKeys1: newHeaderKeys1,
    headerKeys2: newHeaderKeys2,
    rows: newRows,
    locked: table.locked,
    sub: table.sub || []
  };
}

module.exports = { jsonTextBackToMap, dropPriceSpecRows, isDisabledDefaultRow, POSITION_VAT_KEYS, dropZeroOnlySubPrices };
