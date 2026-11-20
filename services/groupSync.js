const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { connetToDb } = require('../db/core');
const { log } = require('../utils/logging');
const { groupNameFor } = require('./priceSpec/scriptLabels');

const GRUPY_FILE = '/mnt/eformconf/grupy.xlsx';
const CONFIG_DIR = '/mnt/eformconf';

/**
 * Reads grupy.xlsx and returns department data:
 * [{ id, groups: string[], names: { pl, en, de, nl, fr } }]
 */
async function readDepartmentsFromExcel() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(GRUPY_FILE);
    const ws = wb.worksheets[0];

    const row1 = ws.getRow(1).values; // Numer, 1, 2, ...
    const row2 = ws.getRow(2).values; // Produkty, "71,43,20", ...
    const row3 = ws.getRow(3).values; // Opis (PL)
    const row4 = ws.getRow(4).values; // Opis-EN
    const row5 = ws.getRow(5).values; // Opis-DE
    const row6 = ws.getRow(6).values; // Opis-NL
    const row7 = ws.getRow(7).values; // Opis-FR

    const departments = [];
    for (let col = 2; col < row1.length; col++) {
        const deptId = parseInt(row1[col]);
        if (isNaN(deptId)) continue;

        const groupsRaw = String(row2[col] || '');
        const groups = groupsRaw.split(/[,.]/).map(g => g.trim()).filter(Boolean);

        departments.push({
            id: deptId,
            groups: groups,
            names: {
                pl: String(row3[col] || ''),
                en: String(row4[col] || ''),
                de: String(row5[col] || ''),
                nl: String(row6[col] || ''),
                fr: String(row7[col] || ''),
            }
        });
    }
    return departments;
}

/**
 * Reads group name translations from the group .xlsm config file.
 * Spawns a subprocess to avoid OOM from opening large .xlsm files
 * in the main process. Returns { pl, en, de, nl, fr } or null.
 */
function readGroupNamesFromExcel(groupNumber) {
    const allFiles = fs.readdirSync(CONFIG_DIR);
    const pattern = new RegExp('#' + groupNumber + '#');
    const file = allFiles.find(f => pattern.test(f) && f.endsWith('.xlsm') && !f.startsWith('~'));

    if (!file) return null;

    const filePath = path.join(CONFIG_DIR, file);
    const script = `
        const ExcelJS = require('exceljs');
        (async () => {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(${JSON.stringify(filePath)});
            const ws = wb.getWorksheet('PRODUKT');
            if (!ws) { console.log('null'); process.exit(0); }
            console.log(JSON.stringify({
                pl: String(ws.getRow(3).values[2] || ''),
                en: String(ws.getRow(4).values[2] || ''),
                de: String(ws.getRow(5).values[2] || ''),
                nl: String(ws.getRow(6).values[2] || ''),
                fr: String(ws.getRow(7).values[2] || ''),
            }));
        })();
    `;

    try {
        const result = execSync(`node -e ${JSON.stringify(script)}`, {
            cwd: path.join(__dirname, '..'),
            timeout: 60000,
            encoding: 'utf8',
            env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') }
        }).trim();
        if (result === 'null') return null;
        return JSON.parse(result);
    } catch (e) {
        log('[GroupSync] Error reading group ' + groupNumber + ' from ' + file + ': ' + e.message);
        return null;
    }
}

/**
 * Synchronise departments and product_groups from grupy.xlsx and group
 * Excel config files into the database. Uses UPSERT to be idempotent.
 * Group-to-product_code mappings are NOT changed here (managed separately).
 */
async function syncGroupsFromExcel() {
    const conn = await connetToDb();
    try {
        const departments = await readDepartmentsFromExcel();

        for (const dept of departments) {
            await conn.query(
                `INSERT INTO department (id, name_pl, name_en, name_de, name_nl, name_fr)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   name_pl=VALUES(name_pl), name_en=VALUES(name_en), name_de=VALUES(name_de),
                   name_nl=VALUES(name_nl), name_fr=VALUES(name_fr)`,
                [dept.id, dept.names.pl, dept.names.en, dept.names.de, dept.names.nl, dept.names.fr]
            );

            for (const groupNum of dept.groups) {
                let names;
                try {
                    // Nazwy jak w formularzu (DESCRIPTION z prod.txt) — arkusz PRODUKT .xlsm bywa
                    // nieprzetłumaczony (gr. 11: „MOSKITIERY” w DE/EN/NL/FR); arkusz tylko gdy grupa nie ma prod.txt.
                    const fromProd = Object.fromEntries(['pl', 'en', 'de', 'nl', 'fr'].map((l) => [l, groupNameFor(groupNum, l) || '']));
                    names = fromProd.pl ? fromProd : readGroupNamesFromExcel(groupNum);
                } catch (e) {
                    log('[GroupSync] Error reading Excel for group ' + groupNum + ': ' + e.message);
                }

                if (names) {
                    await conn.query(
                        `INSERT INTO product_group (group_number, department_id, name_pl, name_en, name_de, name_nl, name_fr)
                         VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                           department_id=VALUES(department_id),
                           name_pl=VALUES(name_pl), name_en=VALUES(name_en), name_de=VALUES(name_de),
                           name_nl=VALUES(name_nl), name_fr=VALUES(name_fr)`,
                        [groupNum, dept.id, names.pl, names.en, names.de, names.nl, names.fr]
                    );
                } else {
                    // Ensure the group row exists even without translations
                    await conn.query(
                        `INSERT IGNORE INTO product_group (group_number, department_id)
                         VALUES (?, ?)`,
                        [groupNum, dept.id]
                    );
                }
            }
        }

        log('[GroupSync] Synced ' + departments.length + ' departments from grupy.xlsx');
    } finally {
        await conn.end();
    }
}

module.exports = { syncGroupsFromExcel };
