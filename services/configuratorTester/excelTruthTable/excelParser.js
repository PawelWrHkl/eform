/**
 * Parses one price sheet out of a group's authoring workbook in /mnt/eformconf
 * into a structure the truth-table lookup can query.
 *
 * Sheet layout (reverse-engineered and cross-checked against three workbooks +
 * real order data — see the plan file for the evidence trail):
 *
 *   row 1:  block-letter markers (A, B, C, … J, K) at each block's first column.
 *           A block = one CLIENT's price list variant (prod.txt PARAM_SCRIPTS →
 *           param-<PARAM>-<LETTER>.js), NOT a product attribute.
 *   row 2:  per-block width headers in CENTIMETRES (0, 10, 20 … 360), blocks
 *           separated by an empty column.
 *   col 1:  section labels + meta-row labels. A section starts at a label like
 *           `PG0`…`PG6`/`PGE` (optionally prefixed: `AO40PG2`, `TCNDPGE`, …),
 *           followed by meta rows `Kiedy-występuje` ×2 (the section's own
 *           applicability formulas), `Os-x` and `Os-y` (which literally spell
 *           out the axis transform: SZEROKOSC/10 and WYSOKOSC/10).
 *   data:   every row after the meta rows, until the next section label.
 *           Height in cm is the row's position within the section's data rows.
 *
 * ⚠️ Cells holding formulas are skipped entirely: Excel caches one formula
 * `.result` that exceljs surfaces on every cell of a shared/array formula,
 * which looks like plausible price data but is just the last state the sheet
 * was saved in.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const CONF_DIR = process.env.EFORMCONF_DIR || '/mnt/eformconf';
const META_ROW_LABELS = new Set(['kiedy-występuje', 'kiedy-wystepuje', 'os-x', 'os-y']);

/** Workbook for a group: `/mnt/eformconf/<name>#<groupNumber>#<...>.xlsm`, ignoring Excel lock files. */
function findWorkbookPath(groupNumber, confDir = CONF_DIR) {
  const wanted = `#${String(groupNumber)}#`;
  const files = fs.readdirSync(confDir)
    .filter((f) => !f.startsWith('~$'))
    .filter((f) => /\.xlsm$|\.xlsx$/i.test(f))
    .filter((f) => f.includes(wanted));
  if (files.length === 0) return null;
  return path.join(confDir, files[0]);
}

function cellNumber(cell) {
  // Formula cells carry a cached `.result` that exceljs repeats across a shared
  // formula's whole range — never real price data (see the header comment).
  if (cell.formula || (cell.value && typeof cell.value === 'object')) return null;
  const value = cell.value;
  if (typeof value === 'number') return value;

  // Some workbooks store the scale AND the prices as TEXT ("60", "98,59").
  // Group 75's CENA sheet does, which made every width scale come back empty,
  // every section look scalar and every price read as 0 — while the engine
  // happily priced from the same cells. Accept only strings that are cleanly
  // numeric (comma decimal separator included), never arbitrary text.
  if (typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
    return parseFloat(text);
  }
  return null;
}

/**
 * Formula text of a cell, if it has one. Section value cells are not always
 * literals: a surcharge can be defined as a formula over other params, e.g.
 * `ROUND(CENA*0.1,2)` (10% of the base price) — the generated scripts evaluate
 * exactly that string at runtime, so the truth table has to as well.
 */
function cellFormula(cell) {
  const direct = cell.formula;
  if (direct) return direct;
  if (cell.value && typeof cell.value === 'object' && cell.value.formula) return cell.value.formula;
  return null;
}

function cellText(cell) {
  const v = cell.value;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.richText === 'object') {
    return (v.richText || []).map((p) => p.text).join('');
  }
  return null;
}

/**
 * Block-letter markers in row 1 → column ranges.
 *
 * The block's FIRST column is its height axis (its cells hold the height in cm
 * for each data row), not a price column — the scale row shows a placeholder 0
 * there. Price columns therefore start one column later.
 */
function parseBlocks(sheet) {
  const row1 = sheet.getRow(1);

  const starts = [];
  for (let c = 1; c <= sheet.columnCount; c++) {
    const text = cellText(row1.getCell(c));
    if (text && /^[A-Z]{1,2}$/.test(text.trim())) starts.push({ letter: text.trim(), startCol: c });
  }

  return starts.map((start, i) => {
    const endCol = i + 1 < starts.length ? starts[i + 1].startCol - 1 : sheet.columnCount;
    return { letter: start.letter, axisCol: start.startCol, startCol: start.startCol, endCol };
  });
}

/**
 * Width scale for ONE section in ONE block, read from the section's own label
 * row across that block's columns.
 *
 * ⚠️ This is per-section, NOT sheet-wide. Verified against compiled scripts:
 * group 24's `RRLKV2` section in block K has the scale 80,100,120,140… on its
 * label row, and `param-CENA-K.js` buckets on exactly those values — while row
 * 2 of the same sheet carries an unrelated 0,10,20…400 scale. Reading row 2 for
 * every section made block K resolve to 0 and produced bogus "the price list
 * says 0, the engine charged 161.07" findings. Sheets whose sections all share
 * one scale (group 71) work either way, which is why this stayed hidden until a
 * full sweep hit a group that does not.
 */
function parseSectionWidths(sheet, block, headerRow) {
  const row = sheet.getRow(headerRow);
  const widths = [];
  for (let c = block.startCol + 1; c <= block.endCol; c++) {
    const w = cellNumber(row.getCell(c));
    if (w !== null) widths.push({ col: c, widthCm: w });
  }
  return widths;
}

/**
 * Two sheet shapes exist and both must be handled:
 *
 *  - `grid`   (CENA): row 2 carries a long ascending width scale (0,10,…,360)
 *             and each block's first column is the height axis.
 *  - `scalar` (DOPLATA): no dimension scale at all — each section is a single
 *             flat amount sitting on the section's own label row, in the
 *             block's column, e.g. `AB10 | 79` with the condition
 *             `zawiera(MODEL,"AB10")` underneath. The compiled
 *             param-DOPLATA-*.js confirms it: `v = 79; AB10 = v * n`.
 *
 * Detected by whether a block actually has an ascending run of width headers,
 * so a sheet whose row 2 happens to hold one stray number is not mistaken for
 * a price grid.
 */
/**
 * Shape of ONE section in ONE block. Sheets are MIXED: group 24's DOPLATA has
 * `MODELD` as a flat 12.4 on its label row right next to `XLEL`, a table
 * indexed by width alone (scale on the label row, the single data row directly
 * beneath it, axis value 0 because height is not part of that surcharge).
 * Classifying a whole sheet made XLEL read as 0 while the engine charged 46.33.
 *
 *  - `scalar`  : one value at (label row, axis column)
 *  - `grid1d`  : width scale, one data row, no height axis
 *  - `grid2d`  : width scale + per-row heights in the axis column
 */
function classifySection(sheet, block, section) {
  const widths = parseSectionWidths(sheet, block, section.headerRow);
  if (widths.length < 3) return { kind: 'scalar', widths: [] };

  const heightRows = [];
  let firstDataRow = null;
  for (let r = section.dataStartRow; r <= section.dataEndRow; r++) {
    const axis = cellNumber(sheet.getRow(r).getCell(block.axisCol));
    const hasData = widths.some((w) => cellNumber(sheet.getRow(r).getCell(w.col)) !== null);
    if (hasData && firstDataRow === null) firstDataRow = r;
    if (axis !== null && axis > 0) heightRows.push({ row: r, heightCm: axis });
  }

  if (heightRows.length >= 2) return { kind: 'grid2d', widths, heightRows };
  return { kind: 'grid1d', widths, dataRow: firstDataRow };
}

function detectSheetKind(sheet, blocks, sections) {
  let best = [];
  for (const section of sections.slice(0, 12)) {
    for (const block of blocks) {
      const widths = parseSectionWidths(sheet, block, section.headerRow);
      if (widths.length > best.length) best = widths;
    }
  }
  if (best.length < 3) return 'scalar';
  const ascending = best.every((w, i) => i === 0 || w.widthCm > best[i - 1].widthCm);
  return ascending ? 'grid' : 'scalar';
}

/** Section labels in column 1 → { label, conditions, dataStartRow, dataEndRow }. */
function parseSections(sheet) {
  const labelRows = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const text = cellText(sheet.getRow(r).getCell(1));
    if (!text) continue;
    const normalized = text.trim().toLowerCase();
    if (META_ROW_LABELS.has(normalized)) continue;
    labelRows.push({ label: text.trim(), row: r });
  }

  // The very first label is the sheet's own name (e.g. "CENA"); the section it
  // heads still holds data, so keep it — its label doubles as the first
  // section's identity in some workbooks (row 2 then carries the real label).
  const sections = [];
  for (let i = 0; i < labelRows.length; i++) {
    const { label, row } = labelRows[i];
    const nextRow = i + 1 < labelRows.length ? labelRows[i + 1].row : sheet.rowCount + 1;

    // The `Kiedy-występuje`/`Os-x`/`Os-y` labels in column A annotate rows that
    // ALSO carry real price data — only column B holds their formulas. So the
    // data range covers every row of the section; we just harvest the two
    // applicability formulas out of column B along the way.
    const conditions = [];
    for (let r = row + 1; r < nextRow; r++) {
      const metaLabel = cellText(sheet.getRow(r).getCell(1));
      if (!metaLabel || !metaLabel.trim().toLowerCase().startsWith('kiedy')) continue;
      const formulaCell = sheet.getRow(r).getCell(2);
      const formula = formulaCell.formula || (formulaCell.value && formulaCell.value.formula);
      if (formula) conditions.push(formula);
    }

    sections.push({ label, headerRow: row, conditions, dataStartRow: row + 1, dataEndRow: nextRow - 1 });
  }

  return sections;
}

/**
 * Compact snapshot of the sheet's cells, so the exceljs workbook can be
 * released immediately after parsing.
 *
 * ⚠️ Measured, not guessed: keeping `valueAt` as a closure over the live
 * worksheet held the entire workbook object graph alive and a single group's
 * run peaked at ~1975 MB RSS — right at Node's default heap limit, which is
 * what killed the first full sweep. One Float64Array per row (NaN = empty)
 * plus a small map for the handful of formula cells costs a few MB instead.
 */
function snapshotCells(sheet) {
  const rowCount = sheet.rowCount;
  const colCount = sheet.columnCount;
  const numbers = new Array(rowCount + 1);
  const formulas = new Map();

  for (let r = 1; r <= rowCount; r++) {
    const row = sheet.getRow(r);
    let rowNumbers = null;
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      const formula = cellFormula(cell);
      if (formula) {
        formulas.set(`${r}:${c}`, formula);
        continue;
      }
      const value = cellNumber(cell);
      if (value === null) continue;
      if (!rowNumbers) {
        rowNumbers = new Float64Array(colCount + 1).fill(NaN);
      }
      rowNumbers[c] = value;
    }
    if (rowNumbers) numbers[r] = rowNumbers;
  }

  return {
    valueAt: (row, col) => {
      const rowNumbers = numbers[row];
      if (!rowNumbers) return null;
      const value = rowNumbers[col];
      return Number.isNaN(value) ? null : value;
    },
    formulaAt: (row, col) => formulas.get(`${row}:${col}`) || null
  };
}

/**
 * @returns {Promise<{path, sheetName, blocks, sections, valueAt}>} `valueAt(row, col)`
 *   returns a literal numeric cell or null (formula cells always null).
 */
async function parsePriceSheet(groupNumber, paramName, { confDir = CONF_DIR } = {}) {
  const workbookPath = findWorkbookPath(groupNumber, confDir);
  if (!workbookPath) return { ok: false, reason: `brak pliku cennika dla grupy ${groupNumber} w ${confDir}` };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const sheet = workbook.worksheets.find((s) => s.name.trim().toUpperCase() === paramName.toUpperCase());
  if (!sheet) return { ok: false, reason: `arkusz ${paramName} nie istnieje w ${path.basename(workbookPath)}` };

  const blocks = parseBlocks(sheet);
  const sections = parseSections(sheet);
  const kind = detectSheetKind(sheet, blocks, sections);

  // Materialize each section's per-block shape while the worksheet is still
  // open, so the snapshot can stand alone afterwards.
  for (const section of sections) {
    section.shapeByBlock = {};
    for (const block of blocks) {
      section.shapeByBlock[block.letter] = classifySection(sheet, block, section);
    }
  }

  const cells = snapshotCells(sheet);
  return {
    ok: true,
    path: workbookPath,
    sheetName: sheet.name,
    kind,
    blocks,
    sections,
    valueAt: cells.valueAt,
    formulaAt: cells.formulaAt
  };
}

module.exports = { parsePriceSheet, findWorkbookPath, parseBlocks, parseSections, parseSectionWidths, detectSheetKind, cellFormula };
