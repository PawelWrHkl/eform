const _ = require("n_");

// Rabat klienta grupy zapisany przed zmianą nazw kluczy — patrz niżej.
const LEGACY_CLIENT_DISCOUNT_KEYS = new Set(['RABAT_KLIENTA', 'WARTOSC_PO_RABACIE']);
const CLIENT_DISCOUNT_KEYS = new Set(['SUB___RABAT_KLIENTA', 'SUB___WARTOSC_PO_RABACIE']);

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

async function jsonTextBackToMap(orderItems) {
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
    let currentHeaderKeys1 = [];
    let currentDisplayHeaders1 = [];
    let currentHeaderKeys2 = [];
    let currentDisplayHeaders2 = [];

    for (const [key, param] of jsonParameters.entries()) {
      if (key.startsWith('SUB___')) continue; // handled separately in subParamValues
      if (isRabatParamName(key) && isZeroRabatDisplayValue(paramOptionValue(param))) continue;

      const display = param && param.param_description ? param.param_description : key;
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
      const display = param && param.param_description ? param.param_description : key;
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
          const legacyDisplay = param && param.param_description ? param.param_description : key;
          const legacyEntry = { key: `SUB___${key}`, display: legacyDisplay, value, locked: true };
          item.subParamValues.push(legacyEntry);
          item.clientDiscountValues.push(legacyEntry);
        }
        continue;
      }

      // SUB___ params: store in subParamValues, skip main table entirely
      if (key.startsWith('SUB___')) {
        if (isRabatParamName(key) && isZeroRabatDisplayValue(value)) {
          continue;
        }
        const isLocked = param && param.locked === true;
        if (value !== '-' && value !== null && value !== undefined) {
          const display = param && param.param_description ? param.param_description : key;
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
            if (!table.locked.includes(param.param_description)) {
              table.locked.push(param.param_description)
            }
            item.lockedParams.push(param.param_description)
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
  return { cleanOrderItems, total };
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

module.exports = { jsonTextBackToMap };
