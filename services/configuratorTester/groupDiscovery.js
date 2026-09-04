/**
 * Lists the asortment groups the tester should cover, by reading the same
 * `group.txt` the frontend's FormsManager.getAvailableForms() reads
 * (public/scripts/formTools/getAvailableForms.js) — a tab-separated,
 * transposed file: row 1 = field name, columns 2..N = one department each.
 * The `PRODUCTS` row holds a comma-separated list of group numbers per
 * department. We flatten all departments' PRODUCTS into one deduplicated
 * list — that's the full universe of "active" groups (a department only
 * lists a group here once it's wired up for production use).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../config');

function parseTransposedTsv(text) {
  const rows = text.split('\n').map((line) => line.replace(/\r$/, '').split('\t'));
  const fieldNames = rows.map((row) => (row[0] || '').trim().toLowerCase());
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0) - 1;

  const objects = [];
  for (let col = 1; col <= columnCount; col++) {
    const obj = {};
    let hasValue = false;
    rows.forEach((row, rowIdx) => {
      const raw = (row[col] || '').trim();
      if (raw !== '') hasValue = true;
      obj[fieldNames[rowIdx]] = raw;
    });
    if (hasValue) objects.push(obj);
  }
  return objects;
}

/**
 * @param {string} [lang]
 * @returns {{ groupNumber: string, department: string, description: string }[]}
 */
function listActiveGroups(lang = 'pl') {
  const groupFilePath = path.join(dataDir, 'data', lang, 'group.txt');
  const text = fs.readFileSync(groupFilePath, 'utf8');
  const departments = parseTransposedTsv(text);

  const seen = new Set();
  const groups = [];
  for (const dept of departments) {
    const products = (dept.products || '').split(',').map((p) => p.trim()).filter(Boolean);
    for (const groupNumber of products) {
      if (seen.has(groupNumber)) continue;
      seen.add(groupNumber);
      groups.push({ groupNumber, department: dept.num || '', description: dept.description || '' });
    }
  }
  return groups;
}

module.exports = { listActiveGroups, parseTransposedTsv };
