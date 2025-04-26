const _ = require("n_");

async function jsonTextBackToMap(orderItems) {
  const clearOrderItems = {}
  let tables = [];
  let prevHeaders = new Set();   
  let idx = 1;

  let table = {
    headers: new Set(),
    rows: []
  };

  for (let item of orderItems) {
    let row = [];

    let parsed = item.json_parameters_desc;
    try {
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (!Array.isArray(parsed)) throw new Error("JSON not in array format");
    } catch (err) {
      console.warn(`⚠️ Invalid JSON for item:`, item.id || "[no id]");
      parsed = [];
    }

    const jsonParameters = new Map(parsed);
    let currentHeaders = new Set();

    for (const header of jsonParameters.keys()) {
      currentHeaders.add(header);
    }

    if (!areSetsEqual(prevHeaders, currentHeaders)) {
      if (table.rows.length > 0) {
        tables.push(removeEmptyColumns({
          headers: Array.from(table.headers),
          rows: table.rows
        }));
      }
      

      table = {
        headers: new Set(),
        rows: []
      };
    }
    for (const header of currentHeaders) {
      const param = jsonParameters.get(header);

      if (!param) {
        row.push("-");
        continue;
      }

      if (param.param_description) {
        table.headers.add(param.param_description);
      } else {
        table.headers.add(header);
      }

      if (!('option_value' in param)) {
        row.push("-");
      } else if ('option_description' in param) {
        row.push(`${param.option_value} - ${param.option_description}`);
      } else {
        row.push(param.option_value);
      }
    }

    table.rows.push({item,
                    row:row});
    prevHeaders = currentHeaders;
    idx++;

  }

  if (table.rows.length > 0) {
    tables.push(
      removeEmptyColumns({
        headers: Array.from(table.headers),
        rows: table.rows
      })
    );
  }

  return tables;
}

function areSetsEqual(setA, setB) {
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

function removeEmptyColumns(table) {
  const { headers, rows } = table;
  const columnCount = headers.length;

  const columnsToRemove = [];

  for (let colIndex = 0; colIndex < columnCount; colIndex++) {
    let allEmpty = true;

    for (const rowObj of rows) {
      if (rowObj.row[colIndex] !== "-") {
        allEmpty = false;
        break;
      }
    }

    if (allEmpty) {
      columnsToRemove.push(colIndex);
    }
  }

  if (columnsToRemove.length === 0) return table;

  const newHeaders = headers.filter((_, index) => !columnsToRemove.includes(index));
  const newRows = rows.map(rowObj => ({
    item: rowObj.item,
    row: rowObj.row.filter((_, index) => !columnsToRemove.includes(index))
  }));

  return {
    headers: newHeaders,
    rows: newRows
  };
}



module.exports = { jsonTextBackToMap };
